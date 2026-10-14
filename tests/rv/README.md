# Rendezvous suites: pool + extended vault

Rendezvous (RV, `@stacks/rendezvous` 1.0.0-rc.1) invariant fuzzing of the final
sources `contracts/pox-5/juice-pool-sbtc-signer.clar` and
`contracts/pox-5/juice-sbtc-autoswap.clar` (pool `570226c`, vault `fa8c48a`;
`source-hashes.json` holds the sha256 of both repo files).
Production `contracts/` and `Clarinet.toml` are only read.

```sh
npm run rv:pool -- 2000 20261014           # pool, zero-uSTX stakes on (finds the zero seat)
npm run rv:pool:no-zero -- 2000 20261014   # pool, zero-uSTX stakes off (everything else)
npm run rv:vault:ext -- 2000 20261014      # vault: tests/vault invariants + the extras here
npm run test:rv-repro                      # vitest repro of the finding
```

`tests/rv/run.mjs <pool|vault> <runs> <seed>` writes an RV config with three
sender accounts (deployer, wallet_1, wallet_2), so one call in three comes from
the admin (pool) or the POOL actor (vault), and runs with `bail`.

## Build (`tests/rv/build.py`)

Both projects start from `tests/vault/build.py` output: the same fixture binding
the vitest suite uses (pox-5 -> `.mock-pox`, sBTC/wSTX -> `.mock-ft`, market ->
`.v6-market`, router -> `.mock-router`, DIA -> `.mock-dia`, RFQ native price ->
`.mock-native`). The FastPool fixtures are left out of both manifests (they only
add foreign trait implementations for RV to pick).

`.build-pool` (target `juice-pool-sbtc-signer`):

- Pool = the `tests/vault/.build` copy WITHOUT its vitest-only `test-fund` /
  `test-finish` helpers, plus `pool/pool.invariants.clar` appended. No pool
  expression is changed.
- `mock-pox` gets `pool/mock-pox-model.clar` appended: a pox-5 model with the
  rules of `contracts/external/pox-5.clar`. `stake` needs no active lock and
  calls `validate-stake!` on the target signer manager with the full amount.
  `stake-update` lets the amount only grow, may move to another signer, and
  moves future cycles only. `unstake` keeps the amount and ends the lock after
  the current cycle. Shares of a cycle that is current or past never change.
  The model calls back into the pool through the trait value RV generated, and
  it refuses that value unless it is the calling pool.
- `mock-pox claim-rewards` (patched in the copy): it pays only for a past cycle
  in which the signer had stake (pox-5 semantics). It records every claimed
  batch in `rv-claims` (at most 120), so the invariants scan every batch,
  whichever entry point claimed it.
- `--no-zero-stake`: the harness never stakes 0 uSTX (see the finding).

`.build-vault` (target `juice-sbtc-autoswap`): the `tests/vault/.build-rv` copy
(POOL rebound to the deployer account, the 8 `tests/vault/rv.invariants.clar`
invariants and drivers), plus `vault/vault.extra.clar` appended.

## Pool invariants (`pool/pool.invariants.clar`)

The stakers are six fixed accounts (wallet_1..6). Every stake reaches the pool
only through the model, so a sum over the actors is a sum over `og-stakers`.

| invariant | checks |
| --- | --- |
| og-covered-is-sum | `og-covered-ustx` = sum of the six covers |
| og-covered-le-cap | `og-covered-ustx` <= `og-cap-ustx` |
| og-seats-is-count | `og-seats` = number of actors with an `og-stakers` entry |
| og-cover-le-lock | while `og-staying`, cover <= the staker's pox-5 lock amount |
| og-cap-at-least-initial | the cap never goes below 2.1M STX (raise-only) |
| tranche-paid-bounded | for each claimed batch: tranche-paid <= pot, paid-shares <= cycle total shares (STX and recovered sBTC); a pot or payout exists only on a finalized batch |
| earned-fees-le-charged | `earned-fees` <= sum of (gross - net) over paid stakers, where gross = pot * shares / total is recomputed (the same for sBTC) |
| stx/sbtc-covers-pots-and-fees | pool balance >= unpaid pots + earned fees |
| stx/sbtc-books-exact | the same with `=` (in this harness nothing else sends STX/sBTC to the pool) |
| fee-bips-bounded | fee and pending fee <= MAX_FEE_BIPS |
| pending-swap-is-open-tranche | the pending batch is the latest tranche and is not finalized |

Drivers: `rv-stake`, `rv-stake-update` (top-up, extend, hop to another
signer), `rv-unstake`, `rv-next-cycle`, `rv-next-dist`, `rv-evict`,
`rv-raise-cap`, `rv-propose-fee` (+ production `confirm-fee-bips`), `rv-claim`,
`rv-sell` (the vault's permissionless router-swap, router funded by the
caller), `rv-finalize`, `rv-recover`, `rv-batch`, `rv-pay` / `rv-pay-sbtc`
(12 random picks from the six actors, so duplicates are common), `rv-sweep` /
`rv-sweep-sbtc`, the withdraw functions, and `rv-epoch` (three aliases). An
epoch: unpause (admin only), up to 4 stakes or updates through the model, one
cycle step in two, window 0 (admin only), a payout of a random claimed batch,
then claim + sell + finalize + payout. The batch part runs only when its
read-only preconditions hold, and it is all-or-nothing (`try!`). Every
production public function is fuzzed directly as well.

## Vault extras (`vault/vault.extra.clar`)

Checked wrappers run ONE production entry through `try!` (so an error reverts
the call like a failed transaction) and compare state before and after. A
broken property does not revert: it is written to `rv-violation`, which
`invariant-no-violation` reports (the wrapper's ok value in the RV log shows
the code and values).

- Floor (`rv-checked-router-swap`, `-split`, `-split-dia`, `-jing-take`, each
  with a `-b` alias): out >= floor-out(sold - cut, limit). For a Pyth path,
  limit = floor-of(Lazer mid) under the current config. For the DIA path,
  limit = `get-no-pyth-price` limit. cut = ROUTER_SLACK_SATS for router legs.
  For jing-take, cut = the market taker rebate allowance
  (JING_TAKER_REBATE_MAX_BPS), because the market takes its taker rebate from
  the amount before the limit applies. The vault sBTC never goes up on a sale.
- Flows (every checked wrapper): sBTC and STX summed over {vault, POOL, market,
  router, Lazer oracle (verify fee)} are unchanged, and a caller that is not
  POOL gains nothing.
- `rv-checked-finish`: returns balance - min(balance, pyth-fee-budget), the
  vault STX drops by exactly that, POOL gets exactly that, and ready-to-finish
  clears.
- `rv-checked-recover`: POOL gets exactly the reported stx/sbtc, the vault
  keeps no STX, and `is-empty` holds.
- `invariant-batch-xor-ready`: never an open batch AND ready-to-finish.
- `invariant-ready-means-empty-market`: ready-to-finish implies no resting or
  parked market position.
- `invariant-budget-bounded`: pyth-fee-budget <= MAX_PYTH_FEE_BUDGET.

Test-only state setters (world state only, the production call is untouched):
`rv-prep` (calm the oracles, end the window like `rv-release-window`, lift the
router haircut; each one most of the time), `rv-haircut`, `rv-open` (POOL mints
and funds), and `rv-maker` (an STX maker on the market; POOL only, so fills
land on an address that is already in every sum).

## Results on pool 570226c (2026-10-14, RV 1.0.0-rc.1, Clarinet SDK 3.21)

Pool `570226c` (zero-seat guard: a 0 stake over an OG seat drops the seat),
repo sha256 `f8217080...85a3`. The vault is unchanged (`fa8c48a`, `1cd93089...a8c7`).

| suite | seeds | runs | result |
| --- | --- | --- | --- |
| pool (zero stakes on) | 20261014, 20261015 | 2000 each | 0 failures, 13 invariants (`og-seats-is-count` now holds) |
| pool `--no-zero-stake` | 20261014, 20261015 | 2000 each | 0 failures, 13 invariants |
| vault extended | 20261014, 20261015 | 2000 each | 0 failures, 12 invariants |

## History: results on pool fa8c48a (2026-10-14, RV 1.0.0-rc.1, Clarinet SDK 3.21)

| suite | seeds | runs | result |
| --- | --- | --- | --- |
| pool (zero stakes on) | 20261014, 20261015 | 1000 each | FAIL `og-seats-is-count` at test 570 / 838 |
| pool `--no-zero-stake` | 20261014, 20261015 | 2000 each | 0 failures, 13 invariants |
| vault extended | 20261014, 20261015 | 2000 each | 0 failures, 12 invariants |

Coverage that is not vacuous (successful calls per seed, 20261014 / 20261015):

- pool: end-to-end batches 72 / 29 (epochs with claim+sell+finalize), plus
  rv-claim 32 / 39 and rv-sell 67 / 57. Payouts with a non-zero amount
  120 / 82. Stake 69 / 58, stake-update 102 / 109, unstake 138 / 127,
  evict-og + rv-evict 71 / 69, raise-cap 68 / 73, fee confirm 12 / 10, dust
  sweeps 26 / 22, emergency-recover + rv-recover 17 / 23, recovered-sBTC
  payouts 35 / 57, withdraw-all-fees 44 / 28.
- vault: checked Pyth router sales 76 / 64, checked split 14 / 16, checked
  DIA split 8 / 10, checked jing-take 16 / 17, checked finish 36 / 39,
  rv-batch round trips 81 / 72, rv-open 104 / 89. Sales with sold > 0 in
  checked wrappers: 114 / 107.

## Finding: a zero-uSTX restake leaves a zero-cover OG seat

Fixed in `570226c` (a 0 stake over an OG seat drops the seat). The text below
describes the `fa8c48a` source.

Repro: `tests/rv-repro-og-zero-seat.test.ts` (`npm run test:rv-repro`).

`take-og-seat` (juice-pool-sbtc-signer.clar:339-350): when a stake is below the
cover, the seat shrinks to that stake. With a 0-uSTX stake, `og-stakers`
keeps the staker at 0. `is-og` stays true and `og-seats` still counts the
seat. `evict-og` (line 444) refuses with u128 because covered = 0, so the seat
can never be freed. The staker's next stake sees prev = 0 and runs
`og-seats + 1` again (line 355), so one staker holds two seats.

Sequence: stake X > 0 (seat), the lock ends, `stake` 0 uSTX (seat shrinks to 0),
then `stake` or `stake-update` with Y > 0 -> `og-seats` = 2, one OG.
`og-covered-ustx` stays correct and no funds move. Only the seat counter (an
on-chain statistic) drifts, and the stale zero entry cannot be evicted.

Reachable only if pox-5 accepts a 0-uSTX `stake`. `contracts/external/pox-5.clar`
`stake` has no minimum-amount check (`total-balance >= amount-ustx` only). This
suite did not check the node-side STX lock handler.

## Limits

- Model, not the real pox-5: signer registration, prepare phase, bonds and the
  node lock are out of scope (bond stakes are refused by the pool anyway).
- `earned-fees-le-charged` is an upper bound (withdrawals only lower
  `earned-fees`). Fees withdrawn are not tracked, because RV calls the
  production withdraw functions directly too.
- Vault floor: the market fixture is a simplified v6 snapshot, and the mock
  router models one venue at the Lazer mid with a haircut knob.
  `rv-checked-recover` runs rarely (it needs 432 burn blocks on one open
  batch). The recovery paths are covered by the vitest and stxer suites.
- RV runs one simnet across all runs and checks one invariant per run:
  2,000 runs = 2,000 invariant checks.
