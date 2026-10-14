# Review: bounty mv7dfb43df5505479788 (10,000 sats, open until 2026-10-20)

Pre-deploy audit of the Juice sBTC pool, the autostake safe, the Jing
router/market/dispatch, and the three swap vaults. Pinned at juicestx `1e9a2fb`,
pillar-wallets `c910c1b`, jing-contracts-v3 `ada49d8`, fastpool-pox-5 `bfe3591`,
citycoins-protocol `8bb69aa`. Submissions are reviewed one at a time below.

| # | Submission | Who | Claim | Verdict | Status |
|---|---|---|---|---|---|
| 1 | Patient Reed | Patient Reed | OG seat without stake | Holds, Medium | Fixed (uncommitted): seat lasts while the staker stays, `evict-og` |
| 2 | Rare Io I1 | Rare Io | `pay-one` writes tranche totals per staker | Holds, gas | Adopted `e425a4c`: totals summed in the fold, written once per batch. Fork proof NEW vs `e8ad9b1` side by side 166/166 https://stxer.xyz/simulations/mainnet/3b073415ed6f7c5ff0814ceef0cdbb44, accounting 126/126 https://stxer.xyz/simulations/mainnet/fec1c71d4e374f8b7b74d23a072d5214 |

## 1. Patient Reed: OG seat without stake

**Holds, Medium.** `validate-stake!` gave the seat at stake time from the
amount pox-5 passes, and the cover never shrank. pox-5 `stake-update` can
move a stake to another signer with no new STX and no extension. So a staker
already locked at another signer could move into the pool, take the seat, and
move back out in the same cycle. The STX never left their lock and kept
earning at the other signer; the cost was two transaction fees.

One actor could take the whole 2.1M STX cap this way and keep it, and refill
any room `raise-og-cap` opened. Real first stakers would then pay 4.5%. No
funds are at risk; it is a free grief of the offer, or a free 0% seat held for
a later return. It also breaks the design note in
[README-apeir-audit.md](README-apeir-audit.md), which said this costs at
least one cycle of locked STX.

**Fix: a seat lasts while the staker stays.** We did not take the proposed
fix (grant cover only from shares in the running cycle), because a new staker
would then need a second call a cycle later to get their seat. Instead:

- Seats are still taken at stake time, exactly as before.
- `og-staying(staker)` (read-only): true while pox-5 `get-staker-info` names
  this pool as the staker's signer. False once they move to another signer
  (pox-5 names the new one at once) or their lock has ended (pox-5 returns
  none). An unstaker stays in until the lock ends.
- `evict-og(staker)` (permissionless): when `og-staying` is false, deletes the
  seat and returns its cover to the cap. `ERR_OG_NOT_SEATED (u128)` if there
  is no seat, `ERR_OG_STILL_STAKED (u129)` if the staker is still in.
- An evicted staker can take a seat again by staking while the cap has room.

The hop still takes the seat for a moment, but anyone (our keeper runs it) can
evict it as soon as the staker leaves, so the cap cannot be held for free.
Seats now rotate: leave, and your seat opens for someone else.

Trade-off: "cover never shrinks" is gone. An OG who unstakes keeps 0% through
their last locked cycle; eviction is possible only after the lock ends. Payout
reads the cover when it runs, so evict after that cycle's payout, or the last
tranche pays the standard fee.

Accepted by design: a bond roll-over. If an OG rolls their STX stake into a
bond at another signer, pox-5 `register-for-bond` deletes their `staker-info`
(pox-5 L830-831), so `og-staying` is false at once and the seat can be
evicted. Their old STX shares still earn with this pool until the original
term ends, and those last cycles pay the standard fee. We charge the exit.
A lock can never shrink while the staker stays: `stake-update` only adds
(pox-5 L1126), and `unstake` keeps the amount until the lock ends.

Tests: 6 cases in tests/juice-pool-og.test.ts ("og-staying / evict-og").
They cover the bounty hop (in and out in one cycle, then evict), still staked
(u129), no seat (u128), unstake (staying until the lock ends, then evict),
re-seat after eviction, and eviction by a non-admin. The vault build mock
(tests/vault/build.py) adds a pox-5 style get-staker-info to mock-pox.
Result: npm test 125/125 pass (5 files).
stxer mainnet fork (real pox-5, exact pool source; real stakers hop in from fastpool and xverse-3, unstake, prepare phase, re-seat): simulations/pool-og-evict-stxer.mjs 69/69 https://stxer.xyz/simulations/mainnet/b04f2ff1e6049a80e8905e72abeaf96d; reruns og-seats 49/49 https://stxer.xyz/simulations/mainnet/1b41a8ff94bae0b303fc9f2fe91e079c, og-cap 47/47 https://stxer.xyz/simulations/mainnet/dc6a007eabe3b1a2b960f1248d04a898, accounting 126/126 https://stxer.xyz/simulations/mainnet/757a16db8f7f786b38ea0bcc2787c6c3, autostake-e2e 63/63 https://stxer.xyz/simulations/mainnet/8b4b717193658142e01775293061a496.
