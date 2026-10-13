// Admin handover, pause, signer registration, settle and swap-vault upgrade
// of juice-pool-sbtc-signer.
import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  FAKE_VAULT_SOURCE, fullBatch, fundRouter, POOL, POOL_ID, VAULT, VAULT_ID, admin, alice, bob,
  call, claim, configureFake, cp, deployFakeVault, expectErr, expectOk, fillOgCap, okValue, pool,
  read, readStr, stake, stx, sbtc, REWARD_SATS,
} from "./helpers/juice";

describe("admin handover", function () {
  it("accept needs a pending nominee (u117)", function () {
    // act + assert
    expectErr(pool("accept-admin", [], bob), 117);
  });

  it("only the admin proposes; nominee accepts after 144 burn blocks", function () {
    // arrange
    expectErr(pool("propose-admin", [Cl.principal(alice)], bob), 100);
    expectOk(pool("propose-admin", [Cl.principal(alice)]));
    const pending = readStr(POOL, "get-pending-admin");
    // act
    const early = pool("accept-admin", [], alice);
    const stranger = pool("accept-admin", [], bob);
    simnet.mineEmptyBurnBlocks(144);
    const accepted = pool("accept-admin", [], alice);
    // assert
    expect(pending).toContain(`(admin (some ${alice}))`);
    expectErr(early, 114);
    expectErr(stranger, 100);
    expectOk(accepted);
    expect(read(POOL, "get-admin")).toBePrincipal(alice);
    expect(readStr(POOL, "get-pending-admin")).toContain("(admin none)");
    expectErr(pool("set-paused", [Cl.bool(true)], admin), 100);
    expectOk(pool("set-paused", [Cl.bool(true)], alice));
  });

  it("cancel clears the nominee; non-admin cannot cancel", function () {
    // arrange
    expectOk(pool("propose-admin", [Cl.principal(bob)]));
    simnet.mineEmptyBurnBlocks(144);
    // act
    expectErr(pool("cancel-admin-proposal", [], alice), 100);
    expectOk(pool("cancel-admin-proposal"));
    // assert
    expectErr(pool("accept-admin", [], bob), 117);
    expect(read(POOL, "get-admin")).toBePrincipal(admin);
  });
});

describe("pause", function () {
  it("admin pauses and unpauses; others refused", function () {
    // act
    const stranger = pool("set-paused", [Cl.bool(true)], alice);
    const paused = pool("set-paused", [Cl.bool(true)]);
    const pausedState = read(POOL, "is-paused");
    const resumed = pool("set-paused", [Cl.bool(false)]);
    // assert
    expectErr(stranger, 100);
    expectOk(paused);
    expect(pausedState).toBeBool(true);
    expectOk(resumed);
    expect(read(POOL, "is-paused")).toBeBool(false);
  });
});

describe("register-self", function () {
  it("admin registers through pox-5; others refused", function () {
    // arrange
    const args = [cp(POOL), Cl.bufferFromHex("02".padEnd(66, "0")), Cl.uint(1), Cl.bufferFromHex("00".repeat(65))];
    // act
    const stranger = pool("register-self", args, alice);
    const r = pool("register-self", args);
    // assert
    expectErr(stranger, 100);
    expect(r.result).toBeOk(Cl.bool(true));
  });
});

describe("pox-settle-stakers", function () {
  it("sums what pox-5 settles for every staker", function () {
    // arrange
    stake(alice, 150, 5n);
    stake(bob, 150, 7n);
    // act
    const r = pool("pox-settle-stakers", [Cl.list([Cl.principal(alice), Cl.principal(bob)]), Cl.uint(150), Cl.none()], bob);
    // assert
    expect(r.result).toBeOk(Cl.uint(12));
  });

  it("any failed settle fails the whole call (u103)", function () {
    // arrange
    stake(alice, 150, 5n);
    expectOk(call("mock-pox", "set-settle-fail", [Cl.bool(true)]));
    // act
    const r = pool("pox-settle-stakers", [Cl.list([Cl.principal(alice)]), Cl.uint(150), Cl.none()], bob);
    // assert
    expectErr(r, 103);
  });
});

describe("read-only passthroughs", function () {
  it("signer/staker reward reads, effective fee, defaults", function () {
    // act + assert
    expect(read(POOL, "get-unclaimed-signer-rewards", [Cl.uint(150), Cl.none()])).toBeUint(0);
    expect(read(POOL, "get-staker-entitlement", [Cl.principal(alice), Cl.uint(150), Cl.none()])).toBeUint(0);
    expect(read(POOL, "get-effective-fee-bips", [Cl.principal(alice)])).toBeUint(450);
    expect(read(POOL, "get-swap-vault")).toBePrincipal(VAULT_ID);
    expect(read(POOL, "get-last-claim-dist-cycle", [Cl.uint(150)])).toBeNone();
    expect(read(POOL, "get-pending-swap")).toBeNone();
    expect(read(POOL, "get-earned-fees")).toBeUint(0);
    expect(read(POOL, "get-earned-sbtc-fees")).toBeUint(0);
    expect(readStr(POOL, "get-pending-swap-vault")).toContain("(vault none)");
  });
});

describe("withdraw fees (STX)", function () {
  it("admin only, and never more than earned (u111)", function () {
    // act + assert
    expectErr(pool("withdraw-fees", [Cl.uint(0), Cl.principal(admin)], alice), 100);
    expectErr(pool("withdraw-all-fees", [Cl.principal(admin)], alice), 100);
    expectErr(pool("withdraw-fees", [Cl.uint(1), Cl.principal(admin)]), 111);
  });
});

describe("swap-vault upgrade", function () {
  it("propose: admin only, not the current vault", function () {
    // arrange
    const fake = deployFakeVault();
    // act + assert
    expectErr(pool("propose-swap-vault", [cp(fake)], alice), 100);
    expectErr(pool("propose-swap-vault", [cp(VAULT)]), 119);
  });

  it("propose refuses a vault whose status fails, names another pool, or is busy", function () {
    // arrange
    const fake = deployFakeVault();
    // act + assert
    configureFake(fake, { fails: true });
    expectErr(pool("propose-swap-vault", [cp(fake)]), 9);
    configureFake(fake, { pool: `${admin}.fastpool-stx-vault-signer` });
    expectErr(pool("propose-swap-vault", [cp(fake)]), 119);
    configureFake(fake, { start: 5 });
    expectErr(pool("propose-swap-vault", [cp(fake)]), 120);
    configureFake(fake, { resting: 1 });
    expectErr(pool("propose-swap-vault", [cp(fake)]), 120);
    configureFake(fake, { parked: 1 });
    expectErr(pool("propose-swap-vault", [cp(fake)]), 120);
    expect(readStr(POOL, "get-pending-swap-vault")).toContain("(vault none)");
  });

  it("confirm after SWAP_VAULT_COOLDOWN (4032) switches the vault", function () {
    // arrange
    const fake = deployFakeVault();
    expect(pool("propose-swap-vault", [cp(fake)]).result).toBeOk(cp(fake));
    simnet.mineEmptyBurnBlocks(4031);
    // act
    const early = pool("confirm-swap-vault", [cp(VAULT), cp(fake)]);
    simnet.mineEmptyBurnBlocks(1);
    const stranger = pool("confirm-swap-vault", [cp(VAULT), cp(fake)], alice);
    const done = pool("confirm-swap-vault", [cp(VAULT), cp(fake)]);
    // assert
    expectErr(early, 114);
    expectErr(stranger, 100);
    expect(done.result).toBeOk(cp(fake));
    expect(read(POOL, "get-swap-vault")).toBePrincipal(`${admin}.${fake}`);
    expectErr(pool("pox-claim-rewards", [Cl.list([]), Cl.uint(150)], alice, VAULT), 119);
    expectErr(pool("confirm-swap-vault", [cp(fake), cp(fake)]), 118);
  });

  it("confirm: no proposal u118, wrong old u119, wrong new u119", function () {
    // arrange
    const fake = deployFakeVault();
    const other = deployFakeVault("fake-vault-2");
    expectErr(pool("confirm-swap-vault", [cp(VAULT), cp(fake)]), 118);
    expectOk(pool("propose-swap-vault", [cp(fake)]));
    simnet.mineEmptyBurnBlocks(4032);
    // act + assert
    expectErr(pool("confirm-swap-vault", [cp(other), cp(fake)]), 119);
    expectErr(pool("confirm-swap-vault", [cp(VAULT), cp(other)]), 119);
  });

  it("confirm refuses while a swap is pending (u115)", function () {
    // arrange
    const fake = deployFakeVault();
    expectOk(pool("propose-swap-vault", [cp(fake)]));
    simnet.mineEmptyBurnBlocks(4032);
    stake(alice, 150, 1n);
    claim(150);
    // act + assert: pending batch on the old vault
    expectErr(pool("confirm-swap-vault", [cp(VAULT), cp(fake)]), 115);
  });

  it("confirm refuses a busy old vault (u120)", function () {
    // arrange
    const fake = deployFakeVault();
    expectOk(pool("propose-swap-vault", [cp(fake)]));
    simnet.mineEmptyBurnBlocks(4032);
    expectOk(call("v6-market", "test-park-extra", [cp(VAULT), Cl.uint(1)]));
    // act + assert: old vault has a parked order
    expectErr(pool("confirm-swap-vault", [cp(VAULT), cp(fake)]), 120);
  });

  it("confirm refuses a new vault that became busy after the proposal", function () {
    // arrange
    const fake = deployFakeVault();
    expectOk(pool("propose-swap-vault", [cp(fake)]));
    simnet.mineEmptyBurnBlocks(4032);
    configureFake(fake, { start: 1 });
    // act
    const r = pool("confirm-swap-vault", [cp(VAULT), cp(fake)]);
    // assert
    expectErr(r, 120);
  });

  it("cancel: admin only, clears the proposal", function () {
    // arrange
    const fake = deployFakeVault();
    expectOk(pool("propose-swap-vault", [cp(fake)]));
    // act
    expectErr(pool("cancel-swap-vault-proposal", [], alice), 100);
    expectOk(pool("cancel-swap-vault-proposal"));
    simnet.mineEmptyBurnBlocks(4032);
    // assert
    expectErr(pool("confirm-swap-vault", [cp(VAULT), cp(fake)]), 118);
  });

  it("finalize refuses a vault that reports STX it never sent (u121)", function () {
    // arrange: switch to the lying vault, claim into it
    const fake = deployFakeVault();
    expectOk(pool("propose-swap-vault", [cp(fake)]));
    simnet.mineEmptyBurnBlocks(4032);
    expectOk(pool("confirm-swap-vault", [cp(VAULT), cp(fake)]));
    fillOgCap();
    stake(alice, 150, 1n);
    expectOk(pool("pox-claim-rewards", [Cl.list([]), Cl.uint(150)], alice, fake));
    expect(sbtc(`${admin}.${fake}`)).toBe(REWARD_SATS);
    configureFake(fake, { claim: 5n });
    const before = stx(POOL_ID);
    // act
    const r = pool("finalize-swap", [], alice, fake);
    // assert
    expectErr(r, 121);
    expect(stx(POOL_ID)).toBe(before);
    expect(read(POOL, "get-pending-swap")).toBeSome(expect.anything());
    // an honest zero report closes it with an empty pot
    configureFake(fake, { claim: 0n });
    expect(okValue(pool("finalize-swap", [], alice, fake))).toBeUint(0);
  });

  it("finalize refuses a vault that re-enters the pool and drains STX during finish (u121)", function () {
    // arrange: an unpaid finalized tranche sits in the pool
    fundRouter();
    fullBatch(150);
    const src = FAKE_VAULT_SOURCE.replace(
      "(define-public (finish) (ok (var-get finish-claim)))",
      "(define-public (finish) (begin (try! (contract-call? .juice-pool-sbtc-signer pay-stx-stakers (list '" + alice + " '" + bob + ") u150 u0)) (ok u0)))",
    );
    simnet.deployContract("reentrant-vault", src, { clarityVersion: 4 }, admin);
    expectOk(pool("propose-swap-vault", [cp("reentrant-vault")]));
    simnet.mineEmptyBurnBlocks(4032);
    expectOk(pool("confirm-swap-vault", [cp(VAULT), cp("reentrant-vault")]));
    expectOk(pool("pox-claim-rewards", [Cl.list([]), Cl.uint(151)], alice, "reentrant-vault"));
    const before = stx(POOL_ID);
    // act
    const r = pool("finalize-swap", [], alice, "reentrant-vault");
    // assert: Clarity let the vault call back into the pool; the balance check caught it
    expectErr(r, 121);
    expect(stx(POOL_ID)).toBe(before);
    expect(read(POOL, "get-stx-paid", [Cl.uint(150), Cl.uint(0), Cl.principal(alice)])).toBeNone();
  });
});
