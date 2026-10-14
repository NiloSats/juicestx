// FIXED by the zero-seat guard in take-og-seat. Rendezvous counterexample (tests/rv, invariant-og-seats-is-count, seeds
// 20261014 / 20261015), minimized. contracts/pox-5/juice-pool-sbtc-signer.clar
// take-og-seat: a stake BELOW the cover shrinks the seat to that stake
// (bounty mv7dfb). When the new stake is 0 uSTX the seat is kept with a zero
// cover: is-og stays true, og-seats keeps counting it, evict-og refuses it
// (ERR_OG_NOT_SEATED, covered = 0), and the next stake re-opens it as a NEW
// seat (prev = 0), so og-seats ends above the number of seated stakers.
// Only reachable if pox-5 accepts a 0-uSTX `stake` (contracts/external/pox-5.clar
// `stake` has no minimum-amount check; the node-side lock was not checked).
// Runs on the vault harness build (mock-pox stake-test calls validate-stake!
// as pox-5). Simnet resets before each test.
import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const admin = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const carol = accounts.get("wallet_3")!;
const POOL = "juice-pool-sbtc-signer";
const STX = 1_000_000n;

function stake(staker: string, cycle: bigint, amount: bigint) {
  return simnet.callPublicFn("mock-pox", "stake-test",
    [Cl.contractPrincipal(admin, POOL), Cl.principal(staker), Cl.uint(cycle), Cl.uint(amount)], admin);
}

function ogStatus() {
  return simnet.callReadOnlyFn(POOL, "get-og-status", [], admin).result;
}

function status(seats: bigint, covered: bigint) {
  return Cl.tuple({ seats: Cl.uint(seats), "covered-ustx": Cl.uint(covered), "cap-ustx": Cl.uint(2_100_000_000_000n) });
}

describe("rv repro (fixed): zero-uSTX restake drops the seat", function () {
  it("og-seats stays the count of seated stakers after stake 0 then a top-up", function () {
    // arrange: alice takes a seat, her one-cycle lock (cycle 150) then ends
    expect(stake(alice, 150n, 1_000n * STX).result).toBeOk(Cl.bool(true));
    expect(ogStatus()).toStrictEqual(status(1n, 1_000n * STX));
    expect(simnet.callPublicFn("mock-pox", "set-cycle", [Cl.uint(151)], admin).result).toBeOk(Cl.bool(true));

    // act 1: a fresh stake of 0 uSTX shrinks the seat to 0 but keeps it
    expect(stake(alice, 152n, 0n).result).toBeOk(Cl.bool(true));

    // assert 1: the seat is gone and its cover freed
    expect(simnet.callReadOnlyFn(POOL, "is-og", [Cl.principal(alice)], admin).result).toBeBool(false);
    expect(simnet.callReadOnlyFn(POOL, "get-og-ustx", [Cl.principal(alice)], admin).result).toBeUint(0);
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
    expect(simnet.callPublicFn("mock-pox", "set-cycle", [Cl.uint(153)], admin).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(POOL, "evict-og", [Cl.principal(alice)], carol).result).toBeErr(Cl.uint(128));

    // act 2: her next stake re-opens the seat as a new one (prev = 0)
    expect(stake(alice, 154n, 500n * STX).result).toBeOk(Cl.bool(true));

    // assert 2: one seated staker, one seat
    expect(ogStatus()).toStrictEqual(status(1n, 500n * STX));
    expect(simnet.callReadOnlyFn(POOL, "get-og-ustx", [Cl.principal(alice)], admin).result).toBeUint(500n * STX);
  });
});
