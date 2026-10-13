# Answers to apeir's audit (2026-10-10)

Audit of `juice-sbtc-autoswap` and `juice-pool-sbtc-signer` at `f1615d0`, sent privately by apeir (https://apeir.dk/online/). Each finding below gets a verdict and what changed.

| ID | Verdict | Status |
|---|---|---|
| M-1 | Holds | Fixed |
| L-1 | Holds as described, accepted by design | No change |
| L-2 | Holds for the fee, OG part gone | Accepted, no change |
| I-1 | Does not hold as described | No change |
| I-2 | Holds | Accepted, no change |
| I-3 | Holds | Accepted, no change |

## M-1: bond stakers can join the pool and lose their bond yield

**Holds.** `validate-stake!` ignored `is-bond`, so an allow-listed bond staker could name the pool through `register-for-bond` or `update-bond-registration`, and their bond rewards would be paid to STX-only stakers.

**Fixed.** `validate-stake!` now refuses bonds:

```clarity
(define-constant ERR_BOND_NOT_SUPPORTED (err u122))
(asserts! (not is-bond) ERR_BOND_NOT_SUPPORTED)
```

The second guard apeir proposed, an empty `bond-periods` list in `pox-claim-rewards`, is not added. pox-5 only adds a bond member to a signer through `register-for-bond` and `update-bond-registration`, and both call `validate-stake!` first. So the pool never holds bond shares and a bond period has nothing to claim for it.

The live `juice-pool-stx-signer` has the same hook and cannot be changed. It holds no bond shares (cycles 145 and 146, bonds 1 to 3, checked on chain), so nothing is lost.

## L-1: the caller of `router-swap` picks the print age, so the vault can pay up to 69 bp instead of 20 bp

**Holds as described. Accepted by design, no change.**

`router-swap` is permissionless on purpose: once the patience window has elapsed, anyone must be able to sell a chunk atomically, so the liquidation never depends on our keeper being online or fast.

- **We do not control latency.** The age of a price update at inclusion depends on the Pyth Lazer feed, the mempool and the miner. Refusing any update older than 30 s (rebate above 20 bp) would make honest calls fail whenever a block is slow, and the sale would stall exactly when it should complete.
- **We do not control arbitrage either.** Whoever rests bids on the book is a market participant. The rebate they earn is the market's taker price for that print age; it is how the market pays makers for quoting against a stale price.
- **The loss is bounded.** The worst case is the market's maximum rebate (69 bp at 79 s) plus price drift, and the vault's floor under the caller's mid still holds. The DIA band also bounds the mid.
- **The keeper still has priority paths.** `jing-take` and `router-swap-split` are POOL-gated, so the keeper chooses the update there.

Atomic, permissionless completion is worth more to stakers than the up-to-49 bp the rebate can cost on a book-leg chunk.

## L-2: the fee is read at payout, not at claim; OG revocation was instant

**The OG part no longer applies.** There is no `set-og` any more. A seat is taken only by staking, it never shrinks, and no function removes it.

**The fee part holds. Accepted, no change.** `pay-stx-stakers` reads `fee-bips` at payout, so a fee change confirmed between a claim and its payout applies to that tranche. The guarantees stakers get are enough without a per-tranche snapshot:

- The first 2.1M STX staked pay 0% for life, so a fee change never touches their covered stake.
- Everyone else pays 4.5% at launch, and `MAX_FEE_BIPS` (5%) is a constant, so the most a change can add is 0.5 points.
- Every change is public on chain for `FEE_COOLDOWN` (144 burn blocks, about a day) before it can be confirmed.

## I-1: a 3 to 8 sat donation stalls the permissionless exits

**Does not hold as described. No change.**

Every sale ends with `close-if-empty` (`juice-sbtc-autoswap.clar` L366, L410, L462, L514), so the sale that empties the vault closes the batch in the same transaction.

- **A donation after the sell-out** lands in a vault whose batch is already closed. It blocks nothing and rides into the next batch.
- **A donation before the last sale** is sold with it: permissionless `router-swap` sells `chunk-amount`, which is the whole balance once it fits in a chunk.

The one real gap is not a donation: if the last sale itself leaves 3 to 8 sats unsold (a partial fill), the vault is not empty (`DUST_SATS` is 2) and cannot sell (`ROUTER_SLACK_SATS` is 8). The admin sweeps it with one `router-swap-split` or `jing-take`, and `emergency-recover` opens after 432 blocks. Setting `DUST_SATS` to 8 would close it; we keep the admin sweep.

## I-2: DIA timestamps from the future pass

**Holds. Accepted, no change.** The DIA check is a 10% fat-finger guard around the Pyth Lazer mid (`dia-band-bps`, default 1000), not a price source. It rejects stale DIA values but not future-dated ones; a future timestamp would need DIA itself to publish a bad value, which this guard cannot defend against anyway. If DIA ever becomes unreliable, the admin turns the guard off with `set-vault-dia-band-bps u0` (the check only runs when the band is above 0).

## I-3: recovered amounts are taken from the vault's return value

**Holds. Accepted, no change.** `emergency-recover` books the amounts the active vault reports, without a before/after balance diff. Adding the diff would only add a way for the emergency path to fail, and the path exists to get funds home when something is already wrong.

The vault is trusted by construction: only the pinned active vault can be called, and the admin cannot switch it without a two-step change and a 4,032-block cooldown (about a month), with both vaults idle and no pending swap. That notice is the window for anyone to check the new vault's code before it can report anything.

## Design note: OG cover is a lifetime high-water mark

Found while writing the Clarinet suite, accepted. An OG's cover never shrinks, even after a full unstake. A whale could fill the whole 2.1M cap once, leave, and keep the 0% right for a later return, or a rival could fill it to end the promo. Either costs at least one cycle of locked STX, and the admin can reopen room at any time with `raise-og-cap` (raise-only).
