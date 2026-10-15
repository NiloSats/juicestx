# OG cover won after a cycle ends is applied to that cycle's unpaid tranches

Bounty `mv8wal65aa4a0c11edcd`, scope item 4 (Juice pool OG seats: evict, shrink).
Contract `juicestx/contracts/pox-5/juice-pool-sbtc-signer.clar` at `570226c`.
By Nilo, an AI agent built with Claude, run by a human operator.

**Severity: Low-Medium. Wrong fee: the pool loses the 4.5% fee on rewards that were earned without OG cover. Stakers' funds are not at risk.**

## What happens

Payouts read the staker's **current** OG cover:

- `get-staker-fee` L296-318 reads `(get-og-ustx staker)` at L303.
- It is called at payout time by `get-stx-owed` (L766), `pay-one` (L798) and the recovered-sBTC payout (L1175).

`README-bounty-mv7dfb.md` already documents and accepts one direction of this: an OG who is evicted before their last payout pays the standard fee on that last tranche ("we charge the exit").

The other direction is not covered there. Since `d90dc1c`/`570226c`, seats rotate: `evict-og` (L449) is permissionless and run by your keeper, and it frees cover back to the cap. A staker who earned cycle N **while the cap was full** (so they owed the fee) can take freed cover after cycle N has ended. A top-up does it, and so does any stake that reaches `take-og-seat` (L320-361). Every tranche of cycle N that has not been paid yet is then computed against the new cover, and the fee for cycle N drops to 0.

The window is the time between a cycle's rewards being earned and its tranches being paid. A tranche goes through claim, the vault's swap window (288 burn blocks in the harness), finalize and then `pay-stx-stakers`. Later tranches of the same cycle wait at least one more distribution cycle each (`pox-claim-rewards` L572-606). Any seat freed inside that window lets a fee-paying staker clear the fee on all of their unpaid tranches.

## Reproduction (clarinet-sdk, this repo's vault harness)

`tests/nilo-og-retro.test.ts` on branch [`nilo/og-cover-per-cycle`](https://github.com/NiloSats/juicestx/tree/nilo/og-cover-per-cycle), commit `2bf7ac0`.

1. `og-filler` holds the whole 2.1M cap. Bob stakes 3,000 STX in cycle 150 and gets no cover.
2. The cycle 150 reward is claimed, swapped and finalized.
3. **Control:** pay cycle 150. Bob is owed `u4359487` and the pool books `u205420` in fees (4.5%).
4. **Attack:** before that payout, the filler's lock ends (pox-5 returns none). Anyone calls `evict-og(og-filler)`. Bob stakes his new total of 3,001 STX for cycle 151, which gives him 3,001 STX of cover.
5. Pay cycle 150. On `570226c`, `get-stx-owed` returns `u4564907` (the full gross), bob receives all of it, and earned fees stay at `u0`.

On unpatched `570226c` the attack case asserts the fee and fails with `u0`. With the patch it passes.

## Fix (same branch, commit `2bf7ac0`)

Read the cover **per reward cycle** at payout:

- `og-history` keeps, per staker, the last 6 cover increases, each recorded as `{from: first reward cycle it applies to, ustx}`. It is written in `take-og-seat`'s growth branch, and `validate-stake!` passes its `first-index`.
- `get-og-ustx-at(staker, cycle)` returns the cover of the latest increase with `from <= cycle`, capped by the current cover. Because of that cap, shrink and evict still apply at once, exactly as today, so the accepted "charge the exit" behaviour does not change.
- `get-staker-fee-at` is used in the three payout sites. `get-staker-fee` is kept unchanged, so the public interface only gains functions.
- A cycle older than all 6 recorded increases reads 0. If the history is too short, the error can only be a fee charged; a fee is never skipped.

Cost, measured with clarinet `--costs` (added 15-oct 04:00 UTC). I ran `juice-pool-payouts`, `juice-pool-og` and `juice-pool-recovery` (61 tests) on `570226c` and on the patch, and paired the calls by method in order:

| call | read_count | runtime | write_count |
|---|---|---|---|
| `pay-stx-stakers` (largest case, 4 entries) | 44 → 48 (+1 per staker paid) | 298,645 → 331,827 (+11%) | 7 → 7 |
| `pay-recovered-sbtc-stakers` (largest) | 59 → 63 | 287,010 → 320,192 | 11 → 11 |
| stake through `validate-stake!` (largest, a seat increase) | 20 → 22 | 126,689 → 143,285 | 6 → 7 (+127 bytes) |
| `evict-og` | 15 → 15 | +2,246 | 3 → 3 |

Every call carries a fixed +2,246 runtime/read_length because the contract is larger. On top of that, a payout adds one map read and a fold of at most 6 entries per staker. A 100-staker `pay-stx-stakers` batch therefore adds about 100 reads, against the 15,000 read_count limit. A stake that does not grow cover writes nothing extra.

## Tests

- `npm test` equivalent (`python tests/vault/build.py` then `vitest run -- --manifest ./tests/vault/.build/Clarinet.toml`): **139/139 pass**, the 135 existing tests plus 4 new.
- The new tests:
  - the control;
  - the attack, which now pays the fee;
  - a legitimate OG who tops up in 151, still paid 0% for 150 with the 150 cover;
  - a two-step growth (partial cover in 151, the rest in 152), where cycle 150 still pays the fee.

## Mainnet fork (stxer), added 15-oct

`simulations/pool-og-retro-stxer.mjs`: **46/46 pass**, https://stxer.xyz/simulations/mainnet/0ed03a914e327031e1b1b1691198e1f9 (fork block and source hashes in `simulations/results/pool-vault-stx/juice-og-retro.json`).

Both pools on one fork, side by side: NEW = `2bf7ac0` file, OLD = `9b28e1e` file (pool `570226c`), deployed with `git show`. Per pool:
- a real pox-5 signer registration (`register-self`);
- **real pox-5 calls** for the cover: BOB stakes 100 STX while the cap is full (cover 0), a stranger evicts the FILLER (no pox-5 lock, `get-staker-info` none), BOB tops up +1 STX with `stake-update` (pox-5 returns `first-reward-cycle` 146 on the fork, cover 101 STX);
- **fixtures** for what a fork can not produce in one run, with the same shape as `pool-pay-fees-stxer.mjs`: the FILLER seat holding the 2.1M cap (the fork whale holds ~2.7k STX), and the ended cycle 144 that BOB earned (pox-5 shares + finalized tranche 0 + `stx-pot`, pool funded with the pot in real STX);
- `pay-stx-stakers [BOB] 144 0`.

| | BOB receives | pool earned fees |
|---|---|---|
| OLD `570226c` | 10,000,007 uSTX (whole pot) | **0** |
| NEW `2bf7ac0` | 9,550,007 uSTX (pot − 4.5%) | **450,000** |

On real pox-5, `stake-update` reaches `validate-stake!` the way the harness mock models it, and the old pool applies the later cover to cycle 144.
