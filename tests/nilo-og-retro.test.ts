// Nilo (AI agent built with Claude), bounty mv8wal65aa4a0c11edcd.
// Payout reads the OG cover when it runs, so cover won AFTER a cycle ends is
// applied to that cycle's still-unpaid tranches: a staker who earned while the
// cap was full (fee-paying) tops up after an eviction and the old tranche pays 0%.
import { describe, expect, it } from "vitest";
import { Cl, cvToString } from "@stacks/transactions";
import { appendFileSync } from "node:fs";
const log = (...a: any[]) => appendFileSync("nilo-out.txt", a.map((x) => typeof x === "object" && x && "type" in x ? cvToString(x) : String(x)).join(" ") + String.fromCharCode(10));
import {
  POOL, STX, admin, alice, bob, call, claim, cp, expectOk, fundRouter, okValue,
  pool, principalsList, read, stake, stx, vault, UPDATE, OG_CAP,
} from "./helpers/juice";

const FILLER = `${admin}.og-filler`;
const carol_ = () => simnet.getAccounts().get("wallet_3")!;

function setStakerInfo(staker: string, signer: string | null) {
  const info = signer === null ? Cl.none() : Cl.some(Cl.tuple({
    signer: Cl.principal(signer), "first-reward-cycle": Cl.uint(150), "num-cycles": Cl.uint(1),
  }));
  return call("mock-pox", "set-staker-info", [Cl.principal(staker), info]);
}

// cycle 150: the filler holds the whole cap; bob stakes 3,000 STX with no cover
function cycle150Finalized() {
  stake(FILLER, 150, OG_CAP);
  stake(bob, 150, 3_000n * STX);
  expect(read(POOL, "get-og-ustx", [Cl.principal(bob)])).toBeUint(0);
  fundRouter();
  claim(150);
  simnet.mineEmptyBurnBlocks(288);
  expectOk(vault("router-swap", [UPDATE]));
  okValue(pool("finalize-swap", [], alice));
}

describe("OG cover is read at payout: retroactive 0% on a fee-paying cycle", function () {
  it("control: bob earned cycle 150 with no cover and pays the 4.5% fee", function () {
    cycle150Finalized();
    const owed = read(POOL, "get-stx-owed", [Cl.uint(150), Cl.uint(0), Cl.principal(bob)]);
    const b = stx(bob);
    expectOk(pool("pay-stx-stakers", [principalsList(bob), Cl.uint(150), Cl.uint(0)], alice));
    log("control owed", owed, "fees", read(POOL, "get-earned-fees"), "paid", stx(bob) - b);
    expect(read(POOL, "get-earned-fees")).not.toBeUint(0);
  });

  it("attack: filler leaves, anyone evicts, bob tops up for cycle 151, cycle 150 pays 0% fee", function () {
    cycle150Finalized();
    const owedBefore = read(POOL, "get-stx-owed", [Cl.uint(150), Cl.uint(0), Cl.principal(bob)]);
    // the filler's lock ends (pox-5 returns none): anyone frees the cap
    setStakerInfo(FILLER, null);
    expectOk(pool("evict-og", [Cl.principal(FILLER)], alice));
    // bob tops up by 1 STX into cycle 151: pox-5 passes his new total
    stake(bob, 151, 3_001n * STX);
    expect(read(POOL, "get-og-ustx", [Cl.principal(bob)])).toBeUint(3_001n * STX);
    const owedAfter = read(POOL, "get-stx-owed", [Cl.uint(150), Cl.uint(0), Cl.principal(bob)]);
    const b = stx(bob);
    expectOk(pool("pay-stx-stakers", [principalsList(bob), Cl.uint(150), Cl.uint(0)], alice));
    log("attack owed before", owedBefore, "after", owedAfter, "fees", read(POOL, "get-earned-fees"), "paid", stx(bob) - b);
    // unpatched 570226c: fees u0 (the 4.5% on cycle 150 is skipped).
    // patched: the cover won for cycle 151 does not reach back, same fee as the control.
    expect(read(POOL, "get-earned-fees")).toBeUint(205_420n);
  });

  it("an OG who was covered in cycle 150 is still paid 0% for it, also after a top-up", function () {
    stake(alice, 150, 1n);
    stake(bob, 150, 3_000n * STX);
    stake(bob, 151, 4_000n * STX);
    expect(read(POOL, "get-og-ustx", [Cl.principal(bob)])).toBeUint(4_000n * STX);
    expect(read(POOL, "get-og-ustx-at", [Cl.principal(bob), Cl.uint(150)])).toBeUint(3_000n * STX);
    fundRouter();
    claim(150);
    simnet.mineEmptyBurnBlocks(288);
    expectOk(vault("router-swap", [UPDATE]));
    okValue(pool("finalize-swap", [], alice));
    expectOk(pool("pay-stx-stakers", [principalsList(bob), Cl.uint(150), Cl.uint(0)], alice));
    expect(read(POOL, "get-earned-fees")).toBeUint(0);
  });

  it("two-step growth (partial seat at 151, more at 152) still pays the fee for 150", function () {
    cycle150Finalized();
    setStakerInfo(FILLER, null);
    expectOk(pool("evict-og", [Cl.principal(FILLER)], alice));
    stake(carol_(), 151, OG_CAP - 1_000n * STX); // someone takes most of the room
    stake(bob, 151, 3_001n * STX); // bob gets 1,000 STX of cover from 151
    expect(read(POOL, "get-og-ustx", [Cl.principal(bob)])).toBeUint(1_000n * STX);
    setStakerInfo(carol_(), null);
    expectOk(pool("evict-og", [Cl.principal(carol_())], alice));
    stake(bob, 152, 3_002n * STX); // and the rest from 152
    expect(read(POOL, "get-og-ustx", [Cl.principal(bob)])).toBeUint(3_002n * STX);
    expect(read(POOL, "get-og-ustx-at", [Cl.principal(bob), Cl.uint(150)])).toBeUint(0);
    expect(read(POOL, "get-og-ustx-at", [Cl.principal(bob), Cl.uint(151)])).toBeUint(1_000n * STX);
    expectOk(pool("pay-stx-stakers", [principalsList(bob), Cl.uint(150), Cl.uint(0)], alice));
    expect(read(POOL, "get-earned-fees")).toBeUint(205_420n);
  });
});
