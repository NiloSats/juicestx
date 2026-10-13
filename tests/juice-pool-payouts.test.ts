// Reward claim -> vault -> finalize -> STX payouts of juice-pool-sbtc-signer.
import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  POOL, POOL_ID, REWARD_STX, STX, VAULT_ID, admin, alice, bob, call, carol, claim, cp, expectErr,
  expectOk, fillOgCap, fullBatch, fundRouter, nextDist, pool, principalsList, read, sbtc, stake,
  stx, vault, UPDATE, OG_CAP, REWARD_SATS,
} from "./helpers/juice";

describe("pox-claim-rewards", function () {
  it("funds the vault, opens a batch and records tranche + dist cycle", function () {
    // arrange
    stake(alice, 150, 1n);
    // act
    const r = pool("pox-claim-rewards", [Cl.list([]), Cl.uint(150)], bob);
    // assert
    expectOk(r);
    expect(sbtc(VAULT_ID)).toBe(REWARD_SATS);
    expect(read(POOL, "get-pending-swap")).toBeSome(Cl.tuple({ "reward-cycle": Cl.uint(150), tranche: Cl.uint(0) }));
    expect(read(POOL, "get-last-claim-dist-cycle", [Cl.uint(150)])).toBeSome(Cl.uint(300));
    expect(read(POOL, "get-tranche-count", [Cl.uint(150)])).toBeUint(1);
  });

  it("refuses a second claim for the cycle in the same distribution cycle (u112)", function () {
    // arrange
    fundRouter();
    fullBatch(150);
    // act
    const again = pool("pox-claim-rewards", [Cl.list([]), Cl.uint(150)], alice);
    nextDist();
    const next = pool("pox-claim-rewards", [Cl.list([]), Cl.uint(150)], alice);
    // assert
    expectErr(again, 112);
    expectOk(next);
    expect(read(POOL, "get-tranche-count", [Cl.uint(150)])).toBeUint(2);
  });

  it("refuses an empty claim (u109)", function () {
    // arrange
    expectOk(call("mock-pox", "set-reward", [Cl.uint(0)]));
    // act + assert
    expectErr(pool("pox-claim-rewards", [Cl.list([]), Cl.uint(150)], alice), 109);
  });

  it("refuses a claim while another batch is pending (u115)", function () {
    // arrange
    claim(150);
    // act + assert
    expectErr(pool("pox-claim-rewards", [Cl.list([]), Cl.uint(151)], alice), 115);
  });

  it("works while paused (claims are not gated by pause)", function () {
    // arrange
    expectOk(pool("set-paused", [Cl.bool(true)]));
    // act + assert
    expectOk(pool("pox-claim-rewards", [Cl.list([]), Cl.uint(150)], alice));
  });
});

describe("finalize-swap", function () {
  it("needs a pending batch (u115) and a finished vault (u16032)", function () {
    // arrange
    expectErr(pool("finalize-swap", [], alice), 115);
    claim(150);
    // act + assert
    expectErr(pool("finalize-swap", [], alice), 16032);
  });

  it("books the STX pot and clears the pending swap", function () {
    // arrange
    fundRouter();
    // act
    const amount = fullBatch(150);
    // assert
    expect(amount).toBe(REWARD_STX);
    expect(stx(POOL_ID)).toBe(REWARD_STX);
    expect(read(POOL, "get-stx-pot", [Cl.uint(150), Cl.uint(0)])).toBeUint(REWARD_STX);
    expect(read(POOL, "get-pending-swap")).toBeNone();
  });
});

describe("pay-stx-stakers", function () {
  it("refuses an unfinalized tranche (u115)", function () {
    // arrange
    claim(150);
    // act + assert
    expectErr(pool("pay-stx-stakers", [principalsList(alice), Cl.uint(150), Cl.uint(0)], bob), 115);
  });

  it("pays pro rata, fee on non-OG stake, no double pay, skips non-stakers", function () {
    // arrange: OG cap filled elsewhere so both pay the 4.5% fee
    fillOgCap();
    fundRouter();
    fullBatch(150);
    const a = stx(alice);
    const b = stx(bob);
    const owedA = read(POOL, "get-stx-owed", [Cl.uint(150), Cl.uint(0), Cl.principal(alice)]);
    // act
    const r = pool("pay-stx-stakers", [principalsList(alice, bob, carol, alice), Cl.uint(150), Cl.uint(0)], carol);
    // assert: 3,200 STX 1:3 -> 800 / 2,400 gross, 4.5% fee
    expect(owedA).toBeUint(764_000_000n);
    expect(r.result).toBeOk(Cl.uint(3_056_000_000n));
    expect(stx(alice) - a).toBe(764_000_000n);
    expect(stx(bob) - b).toBe(2_292_000_000n);
    expect(read(POOL, "get-earned-fees")).toBeUint(144_000_000n);
    expect(read(POOL, "get-stx-paid", [Cl.uint(150), Cl.uint(0), Cl.principal(alice)])).toBeSome(Cl.uint(764_000_000n));
    expect(read(POOL, "get-stx-owed", [Cl.uint(150), Cl.uint(0), Cl.principal(alice)])).toBeUint(0);
    expect(read(POOL, "get-tranche-paid-shares", [Cl.uint(150), Cl.uint(0)])).toBeUint(4);
    expect(read(POOL, "is-tranche-fully-paid", [Cl.uint(150), Cl.uint(0)])).toBeBool(true);
    // replay pays nothing
    expect(pool("pay-stx-stakers", [principalsList(alice, bob), Cl.uint(150), Cl.uint(0)]).result).toBeOk(Cl.uint(0));
  });

  it("OG stakers are paid in full with no fee", function () {
    // arrange: alice and bob take OG seats with their stake
    fundRouter();
    fullBatch(150);
    const b = stx(bob);
    // act
    expectOk(pool("pay-stx-stakers", [principalsList(bob), Cl.uint(150), Cl.uint(0)]));
    // assert
    expect(stx(bob) - b).toBe(2_400_000_000n);
    expect(read(POOL, "get-earned-fees")).toBeUint(0);
  });

  it("a stake too small for a whole uSTX books zero net, zero fee", function () {
    // arrange: a whale in the same cycle dwarfs alice's 1 uSTX
    fundRouter();
    stake(`${admin}.whale`, 150, OG_CAP * 10n);
    fullBatch(150);
    const a = stx(alice);
    // act
    expectOk(pool("pay-stx-stakers", [principalsList(alice), Cl.uint(150), Cl.uint(0)]));
    // assert
    expect(stx(alice)).toBe(a);
    expect(read(POOL, "get-stx-paid", [Cl.uint(150), Cl.uint(0), Cl.principal(alice)])).toBeSome(Cl.uint(0));
  });

  it("a tranche with no shares pays nothing (no division by zero)", function () {
    // arrange: claim a cycle nobody staked in
    fundRouter();
    claim(170);
    simnet.mineEmptyBurnBlocks(288);
    expectOk(vault("router-swap", [UPDATE]));
    expectOk(pool("finalize-swap", [], alice));
    // act
    const r = pool("pay-stx-stakers", [principalsList(alice), Cl.uint(170), Cl.uint(0)]);
    // assert
    expect(r.result).toBeOk(Cl.uint(0));
    expect(read(POOL, "get-stx-owed", [Cl.uint(170), Cl.uint(0), Cl.principal(alice)])).toBeUint(0);
  });
});

describe("sweep-tranche-dust", function () {
  it("guards: admin, finalized, fully paid, some dust", function () {
    // arrange: shares 1 + 2 leave 1 uSTX of rounding residue
    fundRouter();
    stake(alice, 150, 1n);
    stake(bob, 150, 2n);
    expectErr(pool("sweep-tranche-dust", [Cl.uint(150), Cl.uint(0)]), 115);
    claim(150);
    simnet.mineEmptyBurnBlocks(288);
    expectOk(vault("router-swap", [UPDATE]));
    expectOk(pool("finalize-swap", [], alice));
    expectErr(pool("sweep-tranche-dust", [Cl.uint(150), Cl.uint(0)], alice), 100);
    expectErr(pool("sweep-tranche-dust", [Cl.uint(150), Cl.uint(0)]), 104);
    expectOk(pool("pay-stx-stakers", [principalsList(alice, bob), Cl.uint(150), Cl.uint(0)]));
    const before = stx(admin);
    // act
    const r = pool("sweep-tranche-dust", [Cl.uint(150), Cl.uint(0)]);
    // assert
    expect(r.result).toBeOk(Cl.uint(1));
    expect(stx(admin) - before).toBe(1n);
    expect(read(POOL, "get-tranche-residue", [Cl.uint(150), Cl.uint(0)])).toBeUint(0);
    expectErr(pool("sweep-tranche-dust", [Cl.uint(150), Cl.uint(0)]), 105);
  });
});

describe("withdraw fees (STX)", function () {
  it("withdraws part, then all, of the earned fees", function () {
    // arrange
    fillOgCap();
    fundRouter();
    fullBatch(150);
    expectOk(pool("pay-stx-stakers", [principalsList(alice, bob), Cl.uint(150), Cl.uint(0)]));
    const before = stx(carol);
    // act
    const over = pool("withdraw-fees", [Cl.uint(144_000_001n), Cl.principal(carol)]);
    const part = pool("withdraw-fees", [Cl.uint(4_000_000n), Cl.principal(carol)]);
    const rest = pool("withdraw-all-fees", [Cl.principal(carol)]);
    // assert
    expectErr(over, 111);
    expect(part.result).toBeOk(Cl.uint(4_000_000n));
    expect(rest.result).toBeOk(Cl.uint(140_000_000n));
    expect(stx(carol) - before).toBe(144_000_000n);
    expect(read(POOL, "get-earned-fees")).toBeUint(0);
  });
});

describe("paused staking", function () {
  it("a paused pool refuses new stakes", function () {
    // arrange
    expectOk(pool("set-paused", [Cl.bool(true)]));
    // act
    const r = call("mock-pox", "stake-test", [cp(POOL), Cl.principal(alice), Cl.uint(150), Cl.uint(STX)]);
    // assert
    expectErr(r, 101);
  });
});
