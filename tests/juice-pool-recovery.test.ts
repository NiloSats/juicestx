// Emergency recovery and recovered-sBTC payouts of juice-pool-sbtc-signer.
import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  POOL, POOL_ID, REWARD_SATS, admin, alice, bob, call, carol, claim, cp, expectErr, expectOk,
  fillOgCap, fundRouter, pool, principalsList, read, sbtc, stake, vault, UPDATE,
} from "./helpers/juice";

const RECOVERY = 432;

// stake, claim, rest the whole batch on the Jing book, wait out recovery
function restedBatch(cycle: number, shares: [string, bigint][]) {
  for (const [who, amount] of shares) stake(who, cycle, amount);
  claim(cycle);
  expectOk(vault("jing-place", [UPDATE]));
  simnet.mineEmptyBurnBlocks(RECOVERY);
}

describe("emergency-recover", function () {
  it("needs a pending batch (u115), then the vault delay (u16046)", function () {
    // arrange
    expectErr(pool("emergency-recover", [], alice), 115);
    stake(alice, 150, 1n);
    claim(150);
    simnet.mineEmptyBurnBlocks(RECOVERY - 2);
    // act
    const early = pool("emergency-recover", [], alice);
    // assert
    expectErr(early, 16046);
  });

  it("is permissionless and brings resting sBTC home as a recovered tranche", function () {
    // arrange
    restedBatch(150, [[alice, 1n], [bob, 3n]]);
    // act
    const r = pool("emergency-recover", [], carol);
    // assert
    expect(r.result).toBeOk(Cl.tuple({ stx: Cl.uint(0), sbtc: Cl.uint(REWARD_SATS) }));
    expect(sbtc(POOL_ID)).toBe(REWARD_SATS);
    expect(read(POOL, "get-pending-swap")).toBeNone();
    expect(read(POOL, "is-recovered-tranche", [Cl.uint(150), Cl.uint(0)])).toBeBool(true);
    expect(read(POOL, "get-recovered-sbtc-pot", [Cl.uint(150), Cl.uint(0)])).toBeUint(REWARD_SATS);
    expectErr(pool("finalize-swap", [], alice), 115);
  });

  it("rolls back fully when the sBTC transfer home fails", function () {
    // arrange
    restedBatch(150, [[alice, 1n]]);
    expectOk(call("mock-ft", "set-blocked-recipient", [Cl.some(cp(POOL))]));
    // act
    const r = pool("emergency-recover", [], alice);
    // assert
    expectErr(r, 402);
    expect(read(POOL, "get-pending-swap")).toBeSome(expect.anything());
    expect(read(POOL, "is-recovered-tranche", [Cl.uint(150), Cl.uint(0)])).toBeBool(false);
  });

  it("recovers a mixed batch (part sold for STX, part resting)", function () {
    // arrange
    fundRouter();
    stake(alice, 150, 1n);
    stake(bob, 150, 3n);
    claim(150);
    simnet.mineEmptyBurnBlocks(288);
    expectOk(pool("set-vault-max-chunk-sats", [Cl.uint(500_000)]));
    expectOk(vault("router-swap", [UPDATE]));
    simnet.mineEmptyBurnBlocks(RECOVERY);
    // act
    const r = pool("emergency-recover", [], alice);
    // assert
    expect(r.result).toBeOk(Cl.tuple({ stx: Cl.uint(1_600_000_000n), sbtc: Cl.uint(500_000) }));
    expect(read(POOL, "get-stx-pot", [Cl.uint(150), Cl.uint(0)])).toBeUint(1_600_000_000n);
  });
});

describe("pay-recovered-sbtc-stakers", function () {
  it("refuses a tranche that was not recovered (u116)", function () {
    // act + assert
    expectErr(pool("pay-recovered-sbtc-stakers", [principalsList(alice), Cl.uint(150), Cl.uint(0)]), 116);
  });

  it("pays sBTC pro rata with the fee, skips repeats and non-stakers", function () {
    // arrange
    fillOgCap();
    restedBatch(150, [[alice, 1n], [bob, 3n]]);
    expectOk(pool("emergency-recover", [], alice));
    const a = sbtc(alice);
    const b = sbtc(bob);
    // act
    const r = pool("pay-recovered-sbtc-stakers", [principalsList(alice, bob, bob, carol), Cl.uint(150), Cl.uint(0)], carol);
    // assert: 250,000 / 750,000 gross, 4.5% fee each
    expect(r.result).toBeOk(Cl.uint(955_000));
    expect(sbtc(alice) - a).toBe(238_750n);
    expect(sbtc(bob) - b).toBe(716_250n);
    expect(read(POOL, "get-earned-sbtc-fees")).toBeUint(45_000);
    expect(read(POOL, "get-recovered-sbtc-paid", [Cl.uint(150), Cl.uint(0), Cl.principal(bob)])).toBeSome(Cl.uint(716_250));
    expect(read(POOL, "get-recovered-sbtc-paid-shares", [Cl.uint(150), Cl.uint(0)])).toBeUint(4);
    expect(read(POOL, "is-recovered-tranche-fully-paid", [Cl.uint(150), Cl.uint(0)])).toBeBool(true);
    expect(read(POOL, "get-recovered-sbtc-residue", [Cl.uint(150), Cl.uint(0)])).toBeUint(0);
    // no STX moves on an sBTC-only recovery
    expect(pool("pay-stx-stakers", [principalsList(alice, bob), Cl.uint(150), Cl.uint(0)]).result).toBeOk(Cl.uint(0));
  });

  it("a stake too small for a whole sat books zero, and no-share cycles pay nothing", function () {
    // arrange
    restedBatch(150, [[alice, 1n], [`${admin}.whale`, 10_000_000n]]);
    expectOk(pool("emergency-recover", [], alice));
    const a = sbtc(alice);
    // act
    const r = pool("pay-recovered-sbtc-stakers", [principalsList(alice), Cl.uint(150), Cl.uint(0)]);
    // assert
    expect(r.result).toBeOk(Cl.uint(0));
    expect(sbtc(alice)).toBe(a);
    expect(read(POOL, "get-recovered-sbtc-paid", [Cl.uint(150), Cl.uint(0), Cl.principal(alice)])).toBeSome(Cl.uint(0));
  });

  it("a recovered cycle with no shares pays nothing (no division by zero)", function () {
    // arrange
    claim(171);
    expectOk(vault("jing-place", [UPDATE]));
    simnet.mineEmptyBurnBlocks(RECOVERY);
    expectOk(pool("emergency-recover", [], alice));
    // act
    const r = pool("pay-recovered-sbtc-stakers", [principalsList(alice), Cl.uint(171), Cl.uint(0)]);
    // assert
    expect(r.result).toBeOk(Cl.uint(0));
  });
});

describe("sweep-recovered-sbtc-dust", function () {
  it("guards: admin, recovered, fully paid, some dust; then sweeps 1 sat", function () {
    // arrange: shares 1 + 2 leave 1 sat of rounding residue
    expectErr(pool("sweep-recovered-sbtc-dust", [Cl.uint(150), Cl.uint(0)]), 116);
    restedBatch(150, [[alice, 1n], [bob, 2n]]);
    expectOk(pool("emergency-recover", [], alice));
    expectErr(pool("sweep-recovered-sbtc-dust", [Cl.uint(150), Cl.uint(0)], alice), 100);
    expectErr(pool("sweep-recovered-sbtc-dust", [Cl.uint(150), Cl.uint(0)]), 104);
    expectOk(pool("pay-recovered-sbtc-stakers", [principalsList(alice, bob), Cl.uint(150), Cl.uint(0)]));
    const before = sbtc(admin);
    // act
    const r = pool("sweep-recovered-sbtc-dust", [Cl.uint(150), Cl.uint(0)]);
    // assert
    expect(r.result).toBeOk(Cl.uint(1));
    expect(sbtc(admin) - before).toBe(1n);
    expectErr(pool("sweep-recovered-sbtc-dust", [Cl.uint(150), Cl.uint(0)]), 105);
  });
});

describe("withdraw-sbtc-fees", function () {
  it("admin only, bounded by earned sBTC fees", function () {
    // arrange
    fillOgCap();
    restedBatch(150, [[alice, 1n], [bob, 3n]]);
    expectOk(pool("emergency-recover", [], alice));
    expectOk(pool("pay-recovered-sbtc-stakers", [principalsList(alice, bob), Cl.uint(150), Cl.uint(0)]));
    const before = sbtc(carol);
    // act
    const stranger = pool("withdraw-sbtc-fees", [Cl.uint(1), Cl.principal(carol)], alice);
    const over = pool("withdraw-sbtc-fees", [Cl.uint(45_001), Cl.principal(carol)]);
    const r = pool("withdraw-sbtc-fees", [Cl.uint(45_000), Cl.principal(carol)]);
    // assert
    expectErr(stranger, 100);
    expectErr(over, 111);
    expect(r.result).toBeOk(Cl.uint(45_000));
    expect(sbtc(carol) - before).toBe(45_000n);
    expect(read(POOL, "get-earned-sbtc-fees")).toBeUint(0);
  });
});
