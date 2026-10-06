# StackingDAO (stSTX/stSTXbtc) vs friedger's pox-5 pool — withdrawal & allocation

How an existing LST solves the "global ratio + per-vault custody" friction that
friedger's `pool.clar` flags as `TODO: global pooled position instead of per-user vault
binding? (see #2)`. Read from local contracts in `stacking-juice/stacking-dao/contracts`.

## The core difference

| | friedger pox-5 pool | StackingDAO |
|---|---|---|
| Custody | **per-vault** (you withdraw from your bound vault) | **one global reserve**, fungible across delegates |
| Signer/pool choice | **hard binding** (`user-vault`) | **soft hint** — "direct stacking", ~20% weight |
| Withdrawal | immediate from one vault (may be thin) | **NFT + ~1-cycle delay**, paid from reserve |
| Rebalancing | manual, operator must keep each vault funded | per-cycle strategy reconciles actual vs ideal |

## How StackingDAO does it

- **Global reserve, not per-vault.** `withdraw` → `reserve.request-stx-for-withdrawal`
  decrements one global `stx-for-withdrawals` and transfers out (`reserve-v1.clar:69-76`).
  No "your delegate" to be short.
- **Withdrawal NFT + 1-cycle wait.** `init-withdraw` escrows stSTX, mints an NFT with
  `{stx-amount, unlock-burn-height}` (`core-v6.clar:214-244`). Unlock = start of next cycle
  (or cycle-after if requested late) (`get-withdraw-unlock-burn-height`, `core-v6.clar:76-91`);
  `withdraw` asserts `burn-block-height >= unlock-burn-height` (`:277`). The delay is what
  buys time to unstack optimally and refill the reserve.
- **Direct stacking = soft signer choice.** Optional `pool` on `deposit` recorded in
  `direct-stacking-user {pool, amount}` (`data-direct-stacking-v1.clar:44-50`). It only
  raises that pool's **allocation target**, never custody — withdrawal still hits the
  global reserve (`core-v6.clar:235` just `subtract-direct-stacking`s the tracker). Only
  `direct-stacking-dependence = 2000 bps (~20%)` of normal stacking follows user ratios;
  protocol keeps ~80% to optimize.
- **Per-cycle strategy.** Inflow `calculate-reach-target` tops up under-allocated delegates;
  outflow `calculate-lowest-combination` unstacks the **minimum necessary** delegates to free
  withdrawal liquidity while max STX stays stacked (`strategy-v3-algo-v1.clar:20-41, 93-115`).
  Pending withdrawals are subtracted from the stacking target (`strategy-v3-pools-v1.clar:33-59`).

## Correction on the sBTC/STX asymmetry

stSTXbtc does **not** treat sBTC as instantly withdrawable while STX is locked. The btc core
uses the **same** unlock calc and 1-cycle NFT lock as stSTX (`stacking-dao-core-btc-v3.clar:191-219, :250`).
The only instant path is `withdraw-idle` — funds deposited but **not yet stacked** (for both
tokens). So: idle → instant; stacked → 1-cycle NFT-gated, both legs. If friedger's pool truly
has a freely-returnable sBTC leg, that's an edge StackingDAO doesn't use — not precedented.

## Takeaway for the pool

1. Pool custody **globally** (one reserve), not per-vault.
2. Make signer choice a **soft allocation hint**, not hard custody binding.
3. Gate withdrawals with an **NFT + 1-cycle delay** — this is the enabler for everything else.
4. Run a **per-cycle strategy** (reach-target in / lowest-combination out) to reconcile
   actual vs ideal allocation and keep max staked.
