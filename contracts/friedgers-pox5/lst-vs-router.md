# LST (global pool) vs per-vault/signer router — tradeoffs

For the pox-5 sBTC pool: should it be a fungible **LST over a global pool** (StackingDAO
style) or keep the current **per-vault/signer router** (hard `user-vault` binding, per-vault
custody, global ratio)? Mechanics below were checked against the contracts.

Context that drives everything:
- bonds are staggered **6-cycle** terms (≤6 active at once);
- **STX is pox-locked** for the term; **sBTC is freely unstakable** (`unstake-sbtc`, partial,
  no term gate);
- **sBTC can't be re-added to a bond mid-term** (`update-bond-registration` only moves signer
  with the same amount; no top-up) — so removing sBTC permanently cuts that bond's remaining
  yield;
- **every bond is dual-leg**: it needs both sBTC and STX in a ratio (~100 sBTC : 5 STX via
  `min-ustx-ratio`), and today's router makes each depositor bring both (`deposit(sbtc, ustx)`
  pulls both from one `tx-sender`).

## Benefits of the LST

- **Single-sided exposure via asset tranching — the headline.** Pooling lets you match a
  BTC-only depositor with a STX-only depositor to satisfy the mandatory dual-stake jointly,
  and issue separate liquid claims: **jBTC** (pure sBTC exposure: BTC price + the sBTC reward
  stream) and **jSTX** (pure STX exposure: supply just the STX leg across the pool's
  bonds/tranches → STX exposure + a fee for providing the scarce leg). Impossible in the
  router, where a position is one indivisible dual-leg bond. Bonus: the scarce STX leg comes
  from STX-only providers instead of being demanded from every BTC depositor.
- **Shorter STX exit.** Router-style, STX is locked until *your* bond's term ends (~6 periods).
  Pooled, exits are served from whichever staggered bond expires soonest → wait drops to the
  **nearest expiry (~1 period), not your own term**.
- **Liquidity not hostage to one vault.** Router-style, `withdraw` pays only from *your*
  bound vault (`vault.payout`, asserts your `user-vault`), so your exit depends entirely on
  that one vault's state. Example: you're in vault-A (unlocks in 5 months); vault-B is full
  and unlocks next month — but you can't touch B's liquidity, so you wait ~5 months on a
  "thin" vault even though the system is flush. There's also an operator dependency
  (`withdraw` needs the cohort unwound first via `unstake-cohort`). A pooled LST feeds every
  bond's expiry + idle buffer into **one shared reserve**, so any exit draws on the whole
  pool — served from B's ~1-month unlock instead. Directly resolves `pool.clar`'s `TODO #2`.
  (Bites mainly the locked **STX** leg + the operator step; sBTC is freely unstakable anytime.)
- **Instant exit via secondary market.** A fungible SIP-010 token trades on DEXs / is usable
  as collateral, so holders get immediate liquidity by **selling** rather than waiting to
  redeem (how stSTX stays liquid in practice). Router positions can't.
- **Yield smoothing + diversification.** Rewards averaged over a large pool → lower variance;
  a bad/slow/slashed signer is **diluted**, not fatal to one small vault.
- **Simpler UX.** Deposit one asset → get one token; no vault to pick or manage, no need to
  hold both legs.

## Cons of the LST

- **Exit externality is socialized.** Because sBTC can't be re-added mid-term, any holder's
  sBTC withdrawal **permanently cuts pooled yield for everyone left** — not just their
  co-vault depositors. The router isolates that drag. Sharpest con. (Mitigate with an exit fee
  + soonest-expiry sourcing, but the shared drag remains.)
- **Two-sided imbalance risk (new, from tranching).** jBTC and jSTX demand won't naturally
  balance at the ~100:5 ratio. If BTC-only deposits outrun STX-leg providers (or vice-versa),
  the excess can't be staked → sits idle (yield drag) or you must cap/queue one side. Needs a
  pricing/incentive lever (the STX-leg fee) to clear the imbalance.
- **Idle-reserve drag.** Fast withdrawals need an un-staked buffer that earns nothing →
  lowers everyone's average yield. The router can run ~100% staked.
- **Loss of signer sovereignty.** Soft allocation (~20%, à la StackingDAO direct-stacking)
  means you can't fully choose/avoid a signer. The router gives hard control over your risk.
- **Socialized slashing.** A misbehaving signer's loss hits all holders, not just its
  depositors (flip side of diversification).
- **More trust + surface.** Reserve, strategy, rebalancing keepers, withdrawal NFT, ratio
  oracle, plus two tokens with their own peg math = much more code, operator discretion, and
  attack surface vs a thin router.
- **Depeg risk.** Either token can trade below NAV under stress; the redemption delay makes
  arb slow — a failure mode the router doesn't have.

## Net

The LST trades *individual sovereignty + risk isolation* for *single-sided exposure,
liquidity, smoothing, and UX*. The standout reason to do it is **tranching** — pox-5's forced
dual-stake is exactly what an LST is good at unbundling into jBTC / jSTX. The standout risks
are the **socialized exit externality** and the **two-sided imbalance** between the legs; both
point to the same fix — a **fee/incentive lever** (exit fee to compensate stayers, STX-leg fee
to clear imbalance).
