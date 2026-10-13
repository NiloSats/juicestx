// juice-sbtc-autoswap: settings, batch clock, Jing book, router sales,
// oracle guards and emergency recovery, driven through the pool.
import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  MID, POOL, POOL_ID, REWARD_SATS, REWARD_STX, VAULT, VAULT_ID, admin, alice, batchOpen, bob,
  call, claim, clock, cp, expectErr, expectOk, fundRouter, okValue, pool, read,
  readStr, readyToFinish, sbtc, stake, stx, vault, UPDATE,
} from "./helpers/juice";

const RECOVERY = 432;
const MOCK_FT = [cp("mock-ft"), Cl.stringAscii("mock-ft")];

// open a batch holding REWARD_SATS
function openBatch(cycle = 150) {
  stake(alice, cycle, 1n);
  stake(bob, cycle, 3n);
  claim(cycle);
}

function marketDeposit() {
  const cycle = read("v6-market", "get-current-cycle");
  return (read("v6-market", "get-token-x-deposit", [cycle, cp(VAULT)]) as any).value as bigint;
}

describe("settings", function () {
  const SETTERS: [string, number, number, boolean][] = [
    ["window-blocks", 288, 288, false],
    ["leeway-bps", 500, 1000, false],
    ["slippage-bps", 100, 1000, false],
    ["max-chunk-sats", 1_000_000, 100_000_000, true],
    ["dia-band-bps", 1000, 5000, false],
    ["router-cooldown", 1, 144, false],
    ["no-pyth-slippage-bps", 1000, 5000, false],
  ];

  for (const [name, value, max, positive] of SETTERS) {
    it(`set-${name}: pool only, bounded, admin only on the pool`, function () {
      // act + assert
      expectErr(vault(`set-${name}`, [Cl.uint(value)], admin), 16000);
      expectErr(pool(`set-vault-${name}`, [Cl.uint(value)], alice), 100);
      expectErr(pool(`set-vault-${name}`, [Cl.uint(max + 1)]), 16033);
      if (positive) expectErr(pool(`set-vault-${name}`, [Cl.uint(0)]), 16033);
      expectOk(pool(`set-vault-${name}`, [Cl.uint(max)]));
      expect(readStr(VAULT, "get-config")).toContain(`u${max}`);
    });
  }

  it("window can not change while a batch is open (u16045)", function () {
    // arrange
    openBatch();
    // act + assert
    expectErr(pool("set-vault-window-blocks", [Cl.uint(10)]), 16045);
  });

  it("pool wrappers refuse an inactive vault (u119)", function () {
    // act + assert
    expectErr(pool("set-vault-window-blocks", [Cl.uint(1)], admin, "fastpool-swap-vault"), 119);
  });

  it("config and upgrade status read back", function () {
    // act
    const status = okValue({ result: read(VAULT, "get-upgrade-status") });
    // assert
    expect(status.value.pool).toBePrincipal(POOL_ID);
    expect(status.value.empty).toBeBool(true);
    expect(status.value["batch-start"]).toBeNone();
    expect(readStr(VAULT, "get-config")).toContain("(recovery-delay-blocks u432)");
    expect(clock()["window-ends"]).toBeNone();
    expect(read(VAULT, "window-open")).toBeBool(false);
    expect(read(VAULT, "window-elapsed")).toBeBool(false);
  });
});

describe("fund", function () {
  it("pool only; zero refused; refused while a batch is open or awaits finalize", function () {
    // act + assert
    expectErr(vault("fund", [Cl.uint(1)], admin), 16000);
    expectErr(pool("test-fund", [Cl.uint(0)]), 16006);
    openBatch();
    expect(clock()["window-ends"]).toBeSome(expect.anything());
    expectErr(pool("test-fund", [Cl.uint(1)]), 16045);
  });

  it("refused while a closed batch awaits finalize (u16045)", function () {
    // arrange
    fundRouter();
    openBatch();
    simnet.mineEmptyBurnBlocks(288);
    expectOk(vault("router-swap", [UPDATE]));
    // act + assert
    expect(readyToFinish()).toBe(true);
    expectErr(pool("test-fund", [Cl.uint(1)]), 16045);
  });
});

describe("finish", function () {
  it("pool only; needs a closed batch (u16032)", function () {
    // act + assert
    expectErr(vault("finish", [], admin), 16000);
    expectErr(pool("test-finish"), 16032);
  });

  it("a dust-only batch closes and finishes with 0 STX", function () {
    // arrange: a 2-sat reward is at most DUST_SATS, so the batch is empty
    expectOk(call("mock-pox", "set-reward", [Cl.uint(2)]));
    stake(alice, 150, 1n);
    claim(150);
    // act
    const closed = vault("close-batch");
    const amount = pool("finalize-swap", [], alice);
    // assert
    expectOk(closed);
    expect(amount.result).toBeOk(Cl.uint(0));
    expect(read(POOL, "get-stx-pot", [Cl.uint(150), Cl.uint(0)])).toBeUint(0);
  });
});

describe("close-batch", function () {
  it("needs a batch (u16032) and an empty vault (u16043)", function () {
    // act + assert
    expectErr(vault("close-batch"), 16032);
    openBatch();
    expectErr(vault("close-batch"), 16043);
  });

  it("market balance above dust keeps the batch open (u16043)", function () {
    // arrange
    openBatch();
    expectOk(vault("jing-place", [UPDATE]));
    // act + assert
    expectErr(vault("close-batch"), 16043);
    expect(marketDeposit()).toBe(REWARD_SATS);
  });

  it("cancels market dust home and closes once the wallet is sold out", function () {
    // arrange: a 1-sat parked order remains after the wallet sells out
    fundRouter();
    openBatch();
    expectOk(call("v6-market", "test-park-extra", [cp(VAULT), Cl.uint(1)]));
    simnet.mineEmptyBurnBlocks(288);
    expectOk(vault("router-swap", [UPDATE]));
    expect(batchOpen()).toBe(true);
    // act
    const r = vault("close-batch");
    // assert
    expectOk(r);
    expect(readyToFinish()).toBe(true);
    expect(okValue(pool("finalize-swap", [], alice))).toBeUint(REWARD_STX);
  });
});

describe("jing-place / jing-reclaim / refloor", function () {
  it("places the whole balance at the leeway ask while the window is open", function () {
    // arrange
    openBatch();
    // act
    const r = vault("jing-place", [UPDATE]);
    // assert
    expectOk(r);
    expect(marketDeposit()).toBe(REWARD_SATS);
    expect(sbtc(VAULT_ID)).toBe(0n);
    expectErr(vault("jing-place", [UPDATE]), 16006); // nothing left
    expect(okValue(pool("refloor-vault", [UPDATE]))).toBeUint((MID * 9500n) / 10000n);
  });

  it("refuses after the window (u16030) and without a batch", function () {
    // arrange
    expectErr(vault("jing-place", [UPDATE]), 16030);
    openBatch();
    simnet.mineEmptyBurnBlocks(288);
    // act + assert
    expectErr(vault("jing-place", [UPDATE]), 16030);
  });

  it("reclaim waits for the window (u16031), then cancels home", function () {
    // arrange
    openBatch();
    expectOk(vault("jing-place", [UPDATE]));
    expectErr(vault("jing-reclaim"), 16031);
    simnet.mineEmptyBurnBlocks(288);
    // act
    const r = vault("jing-reclaim");
    // assert
    expectOk(r);
    expect(sbtc(VAULT_ID)).toBe(REWARD_SATS);
    expect(marketDeposit()).toBe(0n);
  });

  it("refloor after the window uses the slippage floor; pool + admin only", function () {
    // arrange
    openBatch();
    expectOk(vault("jing-place", [UPDATE]));
    simnet.mineEmptyBurnBlocks(288);
    // act + assert
    expectErr(vault("jing-refloor", [UPDATE], admin), 16000);
    expectErr(pool("refloor-vault", [UPDATE], alice), 100);
    expect(okValue(pool("refloor-vault", [UPDATE]))).toBeUint((MID * 9900n) / 10000n);
  });

  it("a maker fill leaves only STX; anyone closes the emptied batch", function () {
    // arrange
    openBatch();
    expectOk(vault("jing-place", [UPDATE]));
    expectOk(call("v6-market", "swap", [Cl.uint(3_206_412_825n), Cl.uint(MID), UPDATE, ...MOCK_FT, ...MOCK_FT, Cl.bool(false)], bob));
    // act
    const r = vault("close-batch", [], bob);
    // assert
    expectOk(r);
    expect(okValue(pool("finalize-swap", [], alice))).toBeUint(3_203_212_825n);
  });
});

describe("oracle guards", function () {
  it("market mid of zero fails closed (u16013)", function () {
    // arrange
    openBatch();
    expectOk(call("v6-market", "test-zero-price", [Cl.bool(true)]));
    // act + assert
    expectErr(vault("jing-place", [UPDATE]), 16013);
  });

  it("DIA divergence below and above the band (u16037), stale DIA (u16036)", function () {
    // arrange
    openBatch();
    // act + assert
    expectOk(call("mock-dia", "set-skew", [Cl.uint(13000)]));
    expectErr(vault("jing-place", [UPDATE]), 16037);
    expectOk(call("mock-dia", "set-skew", [Cl.uint(7000)]));
    expectErr(vault("jing-place", [UPDATE]), 16037);
    expectOk(call("mock-dia", "set-skew", [Cl.uint(10000)]));
    expectOk(call("mock-dia", "set-stale", [Cl.bool(true)]));
    expectErr(vault("jing-place", [UPDATE]), 16036);
  });

  it("band 0 skips DIA entirely", function () {
    // arrange
    openBatch();
    expectOk(pool("set-vault-dia-band-bps", [Cl.uint(0)]));
    expectOk(call("mock-dia", "set-failed", [Cl.bool(true)]));
    // act + assert
    expectOk(vault("jing-place", [UPDATE]));
  });

  it("DIA reads: failure (u16035), zero (u16013), age boundary, price rounding to zero", function () {
    // act + assert
    expect(read(VAULT, "get-dia-price")).toBeOk(Cl.uint(MID));
    expectOk(call("mock-dia", "set-age", [Cl.uint(7200)]));
    expect(read(VAULT, "get-dia-price")).toBeOk(Cl.uint(MID));
    expectOk(call("mock-dia", "set-age", [Cl.uint(7201)]));
    expect(read(VAULT, "get-dia-price")).toBeErr(Cl.uint(16036));
    expectOk(call("mock-dia", "set-age", [Cl.uint(0)]));
    expectOk(call("mock-dia", "set-zero-stx", [Cl.bool(true)]));
    expect(read(VAULT, "get-dia-value", [Cl.stringAscii("STX/USD")])).toBeErr(Cl.uint(16013));
    expectOk(call("mock-dia", "set-zero-stx", [Cl.bool(false)]));
    expectOk(call("mock-dia", "set-failed", [Cl.bool(true)]));
    expect(read(VAULT, "get-dia-value", [Cl.stringAscii("BTC/USD")])).toBeErr(Cl.uint(16035));
    expectOk(call("mock-dia", "set-failed", [Cl.bool(false)]));
    expectOk(call("mock-lazer-oracle", "set-mid", [Cl.uint(1)]));
    expectOk(call("mock-dia", "set-stx-usd", [Cl.uint(200_000_000)]));
    expect(read(VAULT, "get-dia-price")).toBeErr(Cl.uint(16013));
  });

  it("no-Pyth price: DIA source, DIA limit rounding to zero, native fallback and its failures", function () {
    // act + assert
    const dia = (read(VAULT, "get-no-pyth-price") as any).value.value;
    expect(dia.source).toBeAscii("dia");
    expect(dia.limit).toBeUint((MID * 9000n) / 10000n);
    expectOk(call("mock-lazer-oracle", "set-mid", [Cl.uint(1)]));
    expect(read(VAULT, "get-no-pyth-price")).toBeErr(Cl.uint(16013));
    expectOk(call("mock-lazer-oracle", "set-mid", [Cl.uint(MID)]));
    expectOk(call("mock-dia", "set-stale", [Cl.bool(true)]));
    const native = (read(VAULT, "get-no-pyth-price") as any).value.value;
    expect(native.source).toBeAscii("native");
    expect(native.limit).toBeUint(MID / 2n);
    expect(native["dia-error"]).toBeSome(Cl.uint(16036));
    expectOk(call("mock-native", "set-mid", [Cl.uint(1)]));
    expect(read(VAULT, "get-no-pyth-price")).toBeErr(Cl.uint(16013));
    expectOk(call("mock-native", "set-failed", [Cl.bool(true)]));
    expect(read(VAULT, "get-no-pyth-price")).toBeErr(Cl.uint(900));
  });
});

describe("router-swap (permissionless)", function () {
  it("waits for the window (u16031); needs funds (u16006)", function () {
    // arrange
    fundRouter();
    openBatch();
    expectErr(vault("router-swap", [UPDATE]), 16031);
    expectOk(vault("jing-place", [UPDATE]));
    simnet.mineEmptyBurnBlocks(288);
    // act + assert: all sBTC rests on the book
    expectErr(vault("router-swap", [UPDATE]), 16006);
  });

  it("sells one chunk at a time with a cooldown, closing on the last chunk", function () {
    // arrange
    fundRouter();
    openBatch();
    expectOk(pool("set-vault-max-chunk-sats", [Cl.uint(600_000)]));
    simnet.mineEmptyBurnBlocks(288);
    // act
    const first = vault("router-swap", [UPDATE]);
    const tooSoon = vault("router-swap", [UPDATE], bob);
    simnet.mineEmptyBurnBlock();
    const last = vault("router-swap", [UPDATE], bob);
    // assert
    expectOk(first);
    expectErr(tooSoon, 16044);
    expectOk(last);
    expect(sbtc(VAULT_ID)).toBe(0n);
    expect(readyToFinish()).toBe(true);
    expect(okValue(pool("finalize-swap", [], alice))).toBeUint(REWARD_STX);
  });

  it("refuses a sale under the floor: nothing sold or a haircut (u16047)", function () {
    // arrange
    fundRouter();
    openBatch();
    simnet.mineEmptyBurnBlocks(288);
    // act + assert
    expectOk(call("mock-router", "set-refuse", [Cl.bool(true)]));
    expectErr(vault("router-swap", [UPDATE]), 16047);
    expectOk(call("mock-router", "set-refuse", [Cl.bool(false)]));
    expectOk(call("mock-router", "set-haircut-bps", [Cl.uint(2000)]));
    expectErr(vault("router-swap", [UPDATE]), 16047);
    expect(sbtc(VAULT_ID)).toBe(REWARD_SATS);
  });
});

describe("router-swap-split (admin through the pool)", function () {
  const split = [Cl.uint(500_000), Cl.uint(100_000), Cl.uint(100_000), Cl.uint(100_000), Cl.uint(200_000), UPDATE];

  it("guards: pool, admin, sum, window, chunk, funds, cooldown", function () {
    // arrange
    fundRouter();
    expectErr(vault("router-swap-split", split, admin), 16000);
    expectErr(pool("router-swap-split", split, alice), 100);
    expectErr(pool("router-swap-split", [Cl.uint(500_001), ...split.slice(1)]), 16040);
    openBatch();
    expectErr(pool("router-swap-split", split), 16031);
    simnet.mineEmptyBurnBlocks(288);
    expectErr(pool("router-swap-split", [Cl.uint(1_000_001), Cl.uint(1_000_001), Cl.uint(0), Cl.uint(0), Cl.uint(0), UPDATE]), 16039);
    expectOk(pool("set-vault-max-chunk-sats", [Cl.uint(5_000_000)]));
    expectErr(pool("router-swap-split", [Cl.uint(1_000_001), Cl.uint(1_000_001), Cl.uint(0), Cl.uint(0), Cl.uint(0), UPDATE]), 16006);
    // act
    const r = pool("router-swap-split", split);
    const again = pool("router-swap-split", split);
    // assert
    expectOk(r);
    expect(sbtc(VAULT_ID)).toBe(500_000n);
    expect(batchOpen()).toBe(true);
    expectErr(again, 16044);
  });
});

describe("router-swap-split-dia (no-Pyth emergency sale)", function () {
  it("guards and a native-priced sale", function () {
    // arrange
    fundRouter();
    expectErr(vault("router-swap-split-dia", [Cl.uint(1), Cl.uint(1), Cl.uint(0), Cl.uint(0)], admin), 16000);
    expectErr(pool("router-swap-split-dia", [Cl.uint(10), Cl.uint(9), Cl.uint(0), Cl.uint(0)]), 16040);
    expectErr(pool("router-swap-split-dia", [Cl.uint(1), Cl.uint(1), Cl.uint(0), Cl.uint(0)]), 16031);
    openBatch();
    simnet.mineEmptyBurnBlocks(288);
    expectErr(pool("router-swap-split-dia", [Cl.uint(1_000_001), Cl.uint(1_000_001), Cl.uint(0), Cl.uint(0)]), 16039);
    expectErr(pool("router-swap-split-dia", [Cl.uint(0), Cl.uint(0), Cl.uint(0), Cl.uint(0)]), 16006);
    expectOk(call("mock-dia", "set-stale", [Cl.bool(true)]));
    const before = stx(VAULT_ID);
    // act
    const r = pool("router-swap-split-dia", [Cl.uint(100_000), Cl.uint(40_000), Cl.uint(30_000), Cl.uint(30_000)]);
    // assert
    const payload = okValue(r).value.payload.value;
    expect(payload["price-source"]).toBeAscii("native");
    expect(stx(VAULT_ID) - before).toBe(320_000_000n);
    expectErr(pool("router-swap-split-dia", [Cl.uint(100_000), Cl.uint(100_000), Cl.uint(0), Cl.uint(0)]), 16044);
  });

  it("a failing price source reverts the sale, cooldown included", function () {
    // arrange
    fundRouter();
    openBatch();
    simnet.mineEmptyBurnBlocks(288);
    expectOk(call("mock-dia", "set-failed", [Cl.bool(true)]));
    expectOk(call("mock-native", "set-failed", [Cl.bool(true)]));
    const config = readStr(VAULT, "get-config");
    // act
    const r = pool("router-swap-split-dia", [Cl.uint(100_000), Cl.uint(100_000), Cl.uint(0), Cl.uint(0)]);
    // assert
    expectErr(r, 900);
    expect(readStr(VAULT, "get-config")).toBe(config);
    expect(sbtc(VAULT_ID)).toBe(REWARD_SATS);
  });

  it("sells the whole batch on DIA and closes it", function () {
    // arrange
    fundRouter();
    openBatch();
    simnet.mineEmptyBurnBlocks(288);
    // act
    const r = pool("router-swap-split-dia", [Cl.uint(1_000_000), Cl.uint(400_000), Cl.uint(300_000), Cl.uint(300_000)]);
    // assert
    expect(okValue(r).value.payload.value["price-source"]).toBeAscii("dia");
    expect(readyToFinish()).toBe(true);
  });
});

describe("jing-take (admin through the pool)", function () {
  it("guards: pool, admin, window", function () {
    // arrange
    expectErr(vault("jing-take", [Cl.uint(1), UPDATE], admin), 16000);
    expectErr(pool("jing-take", [Cl.uint(1), UPDATE], alice), 100);
    openBatch();
    // act + assert
    expectErr(pool("jing-take", [Cl.uint(1), UPDATE]), 16031);
  });

  it("sweeps the whole balance into a resting bid and closes the batch", function () {
    // arrange: bob bids STX on the book
    openBatch();
    expectOk(call("mock-ft", "mint", [Cl.uint(7), cp(VAULT)]));
    expectOk(call("v6-market", "deposit-token-y", [Cl.uint(4_000_000_000n), Cl.uint(MID), Cl.some(Cl.uint(0)), UPDATE, ...MOCK_FT], bob));
    expectOk(pool("set-vault-max-chunk-sats", [Cl.uint(5_000_000)]));
    simnet.mineEmptyBurnBlocks(288);
    const before = stx(VAULT_ID);
    // act: requested 1 sat, but the whole (<= chunk) balance is swept
    const r = pool("jing-take", [Cl.uint(1), UPDATE]);
    // assert
    const out = okValue(r).value.payload.value.out.value as bigint;
    expect(out > 0n).toBe(true);
    expect(stx(VAULT_ID) - before).toBe(out);
    expect(sbtc(VAULT_ID)).toBe(0n);
    expect(readyToFinish()).toBe(true);
  });

  it("above the chunk the requested amount is honoured and bounded (u16006)", function () {
    // arrange
    openBatch();
    expectOk(call("mock-ft", "mint", [Cl.uint(7), cp(VAULT)]));
    expectOk(pool("set-vault-max-chunk-sats", [Cl.uint(1_000_000)]));
    simnet.mineEmptyBurnBlocks(288);
    // act + assert
    expectErr(pool("jing-take", [Cl.uint(0), UPDATE]), 16006);
    expectErr(pool("jing-take", [Cl.uint(1_000_008), UPDATE]), 16006);
  });

  it("a partial take leaves the batch open", function () {
    // arrange
    openBatch();
    expectOk(call("mock-ft", "mint", [Cl.uint(7), cp(VAULT)]));
    expectOk(call("v6-market", "deposit-token-y", [Cl.uint(4_000_000_000n), Cl.uint(MID), Cl.some(Cl.uint(0)), UPDATE, ...MOCK_FT], bob));
    expectOk(pool("set-vault-max-chunk-sats", [Cl.uint(1_000_000)]));
    simnet.mineEmptyBurnBlocks(288);
    // act
    const r = pool("jing-take", [Cl.uint(500_000), UPDATE]);
    // assert
    expectOk(r);
    expect(sbtc(VAULT_ID)).toBe(500_007n);
    expect(batchOpen()).toBe(true);
  });
});

describe("emergency-recover (vault side)", function () {
  it("pool only; a batch already closed by its sale has no clock (u16032)", function () {
    // arrange
    expectErr(vault("emergency-recover", [], admin), 16000);
    fundRouter();
    openBatch();
    simnet.mineEmptyBurnBlocks(288);
    expectOk(vault("router-swap", [UPDATE]));
    simnet.mineEmptyBurnBlocks(RECOVERY);
    // act
    const r = pool("emergency-recover", [], alice);
    // assert: the pool still has a pending swap, but finalize is the way out
    expectErr(r, 16032);
    expect(okValue(pool("finalize-swap", [], alice))).toBeUint(REWARD_STX);
  });

  it("a wallet-only batch needs no reclaim", function () {
    // arrange
    openBatch();
    simnet.mineEmptyBurnBlocks(RECOVERY);
    // act
    const r = pool("emergency-recover", [], alice);
    // assert
    expect(r.result).toBeOk(Cl.tuple({ stx: Cl.uint(0), sbtc: Cl.uint(REWARD_SATS) }));
    expect(sbtc(POOL_ID)).toBe(REWARD_SATS);
  });

  it("reclaims resting and parked balances, then returns both assets", function () {
    // arrange
    openBatch();
    expectOk(vault("jing-place", [UPDATE]));
    expectOk(call("v6-market", "test-park-extra", [cp(VAULT), Cl.uint(7)]));
    simnet.mineEmptyBurnBlocks(RECOVERY);
    expectOk(call("v6-market", "set-paused", [Cl.bool(true)]));
    // act
    const r = pool("emergency-recover", [], alice);
    // assert
    expect(r.result).toBeOk(Cl.tuple({ stx: Cl.uint(0), sbtc: Cl.uint(1_000_007) }));
    expect(read(VAULT, "is-empty")).toBeBool(true);
  });

  it("parked-only balance is reclaimed", function () {
    // arrange
    openBatch();
    expectOk(call("v6-market", "rv-park-x-for-test", [cp(VAULT)]));
    simnet.mineEmptyBurnBlocks(RECOVERY);
    // act
    const r = pool("emergency-recover", [], alice);
    // assert
    expectOk(r);
  });

  it("an all-STX batch (maker fill) recovers STX only", function () {
    // arrange
    openBatch();
    expectOk(vault("jing-place", [UPDATE]));
    expectOk(call("v6-market", "swap", [Cl.uint(3_206_412_825n), Cl.uint(MID), UPDATE, ...MOCK_FT, ...MOCK_FT, Cl.bool(false)], bob));
    simnet.mineEmptyBurnBlocks(RECOVERY);
    // act
    const r = okValue(pool("emergency-recover", [], alice));
    // assert
    expect(r.value.sbtc).toBeUint(0);
    expect(r.value.stx).toBeUint(3_203_212_825n);
  });

  it("a short sBTC transfer above dust fails the emptiness guard (u16043) and rolls back", function () {
    // arrange
    openBatch();
    expectOk(vault("jing-place", [UPDATE]));
    simnet.mineEmptyBurnBlocks(RECOVERY);
    const position = marketDeposit();
    expectOk(call("mock-ft", "set-short-by", [Cl.uint(3)]));
    expectOk(call("mock-ft", "set-short-transfer", [Cl.bool(true)]));
    // act
    const r = pool("emergency-recover", [], alice);
    // assert
    expectErr(r, 16043);
    expect(marketDeposit()).toBe(position);
    expect(batchOpen()).toBe(true);
  });
});
