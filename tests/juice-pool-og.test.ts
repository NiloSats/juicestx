// OG seats and fee logic of contracts/pox-5/juice-pool-sbtc-signer.clar.
// Runs on the vault harness build (tests/vault/build.py), where the pool's
// POX5 principal is remapped to .mock-pox: mock-pox `stake-test` and
// `stake-bond-test` call validate-stake! as pox-5. Simnet resets before each test.
import { describe, expect, it } from "vitest";
import { Cl, ClarityValue, cvToString } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const admin = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;

const POOL = "juice-pool-sbtc-signer";
const POX = "mock-pox";
const CAP = 2_100_000_000_000n; // 2.1M STX
const STX = 1_000_000n;

function stake(staker: string, amount: bigint, cycle = 150n) {
  return simnet.callPublicFn(
    POX,
    "stake-test",
    [Cl.contractPrincipal(admin, POOL), Cl.principal(staker), Cl.uint(cycle), Cl.uint(amount)],
    staker,
  );
}

function ogSeatEvents(events: { event: string; data: { value?: ClarityValue } }[]) {
  return events.filter(function (e) {
    return e.event === "print_event" && e.data.value && cvToString(e.data.value).includes('"og-seat"');
  });
}

function ogShrinkEvents(events: { event: string; data: { value?: ClarityValue } }[]) {
  return events.filter(function (e) {
    return e.event === "print_event" && e.data.value && cvToString(e.data.value).includes('"og-shrink"');
  });
}

function ogUstx(staker: string) {
  return simnet.callReadOnlyFn(POOL, "get-og-ustx", [Cl.principal(staker)], admin).result;
}

function isOg(staker: string) {
  return simnet.callReadOnlyFn(POOL, "is-og", [Cl.principal(staker)], admin).result;
}

function ogStatus() {
  return simnet.callReadOnlyFn(POOL, "get-og-status", [], admin).result;
}

function status(seats: bigint, covered: bigint, cap = CAP) {
  return Cl.tuple({ seats: Cl.uint(seats), "covered-ustx": Cl.uint(covered), "cap-ustx": Cl.uint(cap) });
}

function stakerFee(staker: string, shares: bigint, owed: bigint, bips: bigint) {
  return simnet.callReadOnlyFn(
    POOL,
    "get-staker-fee",
    [Cl.principal(staker), Cl.uint(shares), Cl.uint(owed), Cl.uint(bips)],
    admin,
  ).result;
}

function admin_(fn: string, args: ClarityValue[] = [], sender = admin) {
  return simnet.callPublicFn(POOL, fn, args, sender);
}

describe("initial state", function () {
  it("starts at 4.5% fee, 2.1M cap, no seats", function () {
    // act + assert
    expect(simnet.callReadOnlyFn(POOL, "get-fee-bips", [], admin).result).toBeUint(450);
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
    expect(isOg(alice)).toBeBool(false);
    expect(ogUstx(alice)).toBeUint(0);
  });
});

describe("take-og-seat via validate-stake!", function () {
  it("first stake opens a seat covering the whole stake", function () {
    // act
    const r = stake(alice, 1_000n * STX);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogSeatEvents(r.events)).toHaveLength(1);
    expect(isOg(alice)).toBeBool(true);
    expect(ogUstx(alice)).toBeUint(1_000n * STX);
    expect(ogStatus()).toStrictEqual(status(1n, 1_000n * STX));
  });

  it("tiny stake (1 uSTX) still opens a seat: no minimum", function () {
    // act
    const r = stake(alice, 1n);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(isOg(alice)).toBeBool(true);
    expect(ogUstx(alice)).toBeUint(1);
    expect(ogStatus()).toStrictEqual(status(1n, 1n));
  });

  it("zero-amount stake opens no seat (nothing to add) but succeeds", function () {
    // act
    const r = stake(alice, 0n);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogSeatEvents(r.events)).toHaveLength(0);
    expect(isOg(alice)).toBeBool(false);
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
  });

  it("top-up grows the cover to the new total without a new seat", function () {
    // arrange
    stake(alice, 1_000n * STX);
    // act: pox-5 passes the new whole position
    const r = stake(alice, 3_000n * STX);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogSeatEvents(r.events)).toHaveLength(1);
    expect(ogUstx(alice)).toBeUint(3_000n * STX);
    expect(ogStatus()).toStrictEqual(status(1n, 3_000n * STX));
  });

  it("smaller stake shrinks the cover to it, seat kept (bounty mv7dfb)", function () {
    // arrange
    stake(alice, 3_000n * STX);
    // act
    const r = stake(alice, 500n * STX);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogSeatEvents(r.events)).toHaveLength(0);
    expect(ogShrinkEvents(r.events)).toHaveLength(1);
    expect(ogUstx(alice)).toBeUint(500n * STX);
    expect(ogStatus()).toStrictEqual(status(1n, 500n * STX));
  });

  it("cycles-only update (same total) adds nothing", function () {
    // arrange
    stake(alice, 3_000n * STX, 150n);
    // act
    const r = stake(alice, 3_000n * STX, 151n);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogSeatEvents(r.events)).toHaveLength(0);
    expect(ogUstx(alice)).toBeUint(3_000n * STX);
    expect(ogStatus()).toStrictEqual(status(1n, 3_000n * STX));
  });

  it("last seat is clamped to the cap left", function () {
    // arrange
    stake(alice, 2_000_000n * STX);
    // act
    const r = stake(bob, 200_000n * STX);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogUstx(bob)).toBeUint(100_000n * STX);
    expect(ogStatus()).toStrictEqual(status(2n, CAP));
  });

  it("cap full: no seat, no top-up, stake still succeeds", function () {
    // arrange
    stake(alice, 2_000_000n * STX);
    stake(bob, 200_000n * STX);
    // act
    const newcomer = stake(carol, 5n * STX);
    const topUp = stake(bob, 300_000n * STX);
    // assert
    expect(newcomer.result).toBeOk(Cl.bool(true));
    expect(topUp.result).toBeOk(Cl.bool(true));
    expect(ogSeatEvents(newcomer.events)).toHaveLength(0);
    expect(ogSeatEvents(topUp.events)).toHaveLength(0);
    expect(isOg(carol)).toBeBool(false);
    expect(ogUstx(bob)).toBeUint(100_000n * STX);
    expect(ogStatus()).toStrictEqual(status(2n, CAP));
  });

  it("raise-og-cap reopens seats and top-ups up to the new room", function () {
    // arrange
    stake(alice, CAP);
    stake(carol, 5n * STX); // refused: cap full
    // act
    const raised = admin_("raise-og-cap", [Cl.uint(CAP + 50n * STX)]);
    const carolAgain = stake(carol, 80n * STX); // new total
    const aliceTopUp = stake(alice, CAP + 1n);
    // assert
    expect(raised.result).toBeOk(Cl.bool(true));
    expect(carolAgain.result).toBeOk(Cl.bool(true));
    expect(ogUstx(carol)).toBeUint(50n * STX); // clamped to the 50 STX added
    expect(aliceTopUp.result).toBeOk(Cl.bool(true));
    expect(ogUstx(alice)).toBeUint(CAP); // no room left after carol
    expect(ogStatus()).toStrictEqual(status(2n, CAP + 50n * STX, CAP + 50n * STX));
  });

  it("raise-og-cap: non-admin u100, equal or lower u127", function () {
    // act
    const notAdmin = admin_("raise-og-cap", [Cl.uint(CAP + 1n)], alice);
    const equal = admin_("raise-og-cap", [Cl.uint(CAP)]);
    const lower = admin_("raise-og-cap", [Cl.uint(CAP - 1n)]);
    // assert
    expect(notAdmin.result).toBeErr(Cl.uint(100));
    expect(equal.result).toBeErr(Cl.uint(127));
    expect(lower.result).toBeErr(Cl.uint(127));
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
  });

  it("bond stake refused u122, no seat", function () {
    // act
    const r = simnet.callPublicFn(
      POX,
      "stake-bond-test",
      [Cl.contractPrincipal(admin, POOL), Cl.principal(alice), Cl.uint(1_000n * STX)],
      alice,
    );
    // assert
    expect(r.result).toBeErr(Cl.uint(122));
    expect(isOg(alice)).toBeBool(false);
  });

  it("direct validate-stake! from a non-pox caller is refused u102", function () {
    // act
    const r = simnet.callPublicFn(
      POOL,
      "validate-stake!",
      [Cl.principal(alice), Cl.uint(150), Cl.uint(1), Cl.uint(1_000n * STX), Cl.uint(0), Cl.bool(false), Cl.none()],
      alice,
    );
    // assert
    expect(r.result).toBeErr(Cl.uint(102));
    expect(isOg(alice)).toBeBool(false);
  });

  it("paused pool refuses the stake u101, no seat", function () {
    // arrange
    admin_("set-paused", [Cl.bool(true)]);
    // act
    const r = stake(alice, 1_000n * STX);
    // assert
    expect(r.result).toBeErr(Cl.uint(101));
    expect(isOg(alice)).toBeBool(false);
  });
});

describe("get-staker-fee", function () {
  it("non-OG pays the full rate: owed * bips / 10000", function () {
    // act + assert: 1,000,000 * 450 * 1000 / (10000 * 1000) = 45,000
    expect(stakerFee(bob, 1_000n, 1_000_000n, 450n)).toBeUint(45_000);
    // floor: 999 * 450 / 10000 = 44.955 -> 44
    expect(stakerFee(bob, 7n, 999n, 450n)).toBeUint(44);
  });

  it("full OG (shares <= cover) pays zero", function () {
    // arrange
    stake(alice, 1_000n * STX);
    // act + assert
    expect(stakerFee(alice, 1_000n * STX, 5_000_000n, 450n)).toBeUint(0);
    expect(stakerFee(alice, 400n * STX, 5_000_000n, 500n)).toBeUint(0);
  });

  it("partial OG pays only on shares above the cover, floored", function () {
    // arrange: cover 1,000 STX, shares 4,000 STX -> 3,000 taxed
    stake(alice, 1_000n * STX);
    const shares = 4_000n * STX;
    const owed = 1_000_003n;
    // act
    const fee = stakerFee(alice, shares, owed, 450n);
    // assert: 1,000,003 * 450 * 3e9 / (10000 * 4e9) = 33,750.10125 -> 33,750
    expect(fee).toBeUint(33_750);
    expect(fee).toBeUint((owed * 450n * (shares - 1_000n * STX)) / (10_000n * shares));
  });

  it("zero shares with no cover returns zero (no division by zero)", function () {
    // act + assert
    expect(stakerFee(bob, 0n, 1_000_000n, 450n)).toBeUint(0);
  });
});

describe("fee-bips timelock", function () {
  it("propose then confirm only after FEE_COOLDOWN (144 burn blocks)", function () {
    // arrange
    expect(admin_("propose-fee-bips", [Cl.uint(300)]).result).toBeOk(Cl.uint(300));
    const proposedAt = BigInt(simnet.burnBlockHeight);
    simnet.mineEmptyBurnBlocks(143);
    // act
    const early = admin_("confirm-fee-bips"); // proposedAt + 143
    simnet.mineEmptyBurnBlocks(1);
    const onTime = admin_("confirm-fee-bips"); // proposedAt + 144
    // assert
    expect(cvToString(simnet.callReadOnlyFn(POOL, "get-pending-fee", [], admin).result)).toContain("(fee none)");
    expect(early.result).toBeErr(Cl.uint(114));
    expect(onTime.result).toBeOk(Cl.bool(true));
    expect(BigInt(simnet.burnBlockHeight)).toBe(proposedAt + 144n);
    expect(simnet.callReadOnlyFn(POOL, "get-fee-bips", [], admin).result).toBeUint(300);
    expect(admin_("confirm-fee-bips").result).toBeErr(Cl.uint(113));
  });

  it("propose at exactly MAX_FEE_BIPS (500) is allowed, 501 refused u110", function () {
    // act + assert
    expect(admin_("propose-fee-bips", [Cl.uint(501)]).result).toBeErr(Cl.uint(110));
    expect(admin_("propose-fee-bips", [Cl.uint(500)]).result).toBeOk(Cl.uint(500));
  });

  it("non-admin cannot propose, confirm or cancel", function () {
    // arrange
    admin_("propose-fee-bips", [Cl.uint(100)]);
    simnet.mineEmptyBurnBlocks(144);
    // act + assert
    expect(admin_("propose-fee-bips", [Cl.uint(0)], alice).result).toBeErr(Cl.uint(100));
    expect(admin_("confirm-fee-bips", [], alice).result).toBeErr(Cl.uint(100));
    expect(admin_("cancel-fee-bips", [], alice).result).toBeErr(Cl.uint(100));
    expect(simnet.callReadOnlyFn(POOL, "get-fee-bips", [], admin).result).toBeUint(450);
  });

  it("cancel clears the pending fee; confirm then fails u113", function () {
    // arrange
    admin_("propose-fee-bips", [Cl.uint(0)]);
    simnet.mineEmptyBurnBlocks(144);
    // act
    const cancelled = admin_("cancel-fee-bips");
    const confirm = admin_("confirm-fee-bips");
    // assert
    expect(cancelled.result).toBeOk(Cl.bool(true));
    expect(confirm.result).toBeErr(Cl.uint(113));
    expect(simnet.callReadOnlyFn(POOL, "get-fee-bips", [], admin).result).toBeUint(450);
    const pending = simnet.callReadOnlyFn(POOL, "get-pending-fee", [], admin).result;
    expect(cvToString(pending)).toContain("(fee none)");
  });

  it("a new proposal restarts the cooldown", function () {
    // arrange
    admin_("propose-fee-bips", [Cl.uint(100)]);
    simnet.mineEmptyBurnBlocks(140);
    admin_("propose-fee-bips", [Cl.uint(200)]);
    simnet.mineEmptyBurnBlocks(10);
    // act
    const r = admin_("confirm-fee-bips");
    // assert
    expect(r.result).toBeErr(Cl.uint(114));
  });

  it("the new rate applies to non-OG fees", function () {
    // arrange
    admin_("propose-fee-bips", [Cl.uint(500)]);
    simnet.mineEmptyBurnBlocks(144);
    admin_("confirm-fee-bips");
    const bips = simnet.callReadOnlyFn(POOL, "get-fee-bips", [], admin).result;
    // act + assert
    expect(bips).toBeUint(500);
    expect(stakerFee(bob, 1_000n, 1_000_000n, 500n)).toBeUint(50_000);
  });
});

// evict-og: mock-pox get-staker-info models pox-5 (none once first + num <=
// current cycle). stake-test records this pool as signer for one cycle;
// set-staker-info models a move to another signer, a longer lock or an exit.
function setStakerInfo(staker: string, signer: string | null, first = 150n, num = 1n) {
  const info =
    signer === null
      ? Cl.none()
      : Cl.some(
          Cl.tuple({
            signer: Cl.principal(signer),
            "first-reward-cycle": Cl.uint(first),
            "num-cycles": Cl.uint(num),
          }),
        );
  return simnet.callPublicFn(POX, "set-staker-info", [Cl.principal(staker), info], admin);
}

function setCycle(c: bigint) {
  return simnet.callPublicFn(POX, "set-cycle", [Cl.uint(c)], admin);
}

function ogStaying(staker: string) {
  return simnet.callReadOnlyFn(POOL, "og-staying", [Cl.principal(staker)], admin).result;
}

function evict(staker: string, sender = carol) {
  return simnet.callPublicFn(POOL, "evict-og", [Cl.principal(staker)], sender);
}

function ogEvictEvents(events: { event: string; data: { value?: ClarityValue } }[]) {
  return events.filter(function (e) {
    return e.event === "print_event" && e.data.value && cvToString(e.data.value).includes('"og-evict"');
  });
}

const OTHER_SIGNER = `${admin}.mock-signer-trait`;

describe("og-staying / evict-og", function () {
  it("bounty hop: other signer -> pool -> other signer in one cycle, evict frees the cover", function () {
    // arrange
    setStakerInfo(alice, OTHER_SIGNER);
    expect(ogStaying(alice)).toBeBool(false);
    stake(alice, 2_000_000n * STX);
    expect(ogStaying(alice)).toBeBool(true);
    expect(ogStatus()).toStrictEqual(status(1n, 2_000_000n * STX));
    setStakerInfo(alice, OTHER_SIGNER);
    // act
    const r = evict(alice);
    // assert
    expect(r.result).toBeOk(Cl.uint(2_000_000n * STX));
    const ev = ogEvictEvents(r.events);
    expect(ev).toHaveLength(1);
    expect(ev[0].data.value).toStrictEqual(
      Cl.tuple({
        topic: Cl.stringAscii("og-evict"),
        staker: Cl.principal(alice),
        "freed-ustx": Cl.uint(2_000_000n * STX),
        seats: Cl.uint(0),
      }),
    );
    expect(isOg(alice)).toBeBool(false);
    expect(ogUstx(alice)).toBeUint(0);
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
  });

  it("still staked with the pool: u129, seat unchanged", function () {
    // arrange
    stake(alice, 1_000n * STX);
    // act
    const r = evict(alice);
    // assert
    expect(r.result).toBeErr(Cl.uint(129));
    expect(ogUstx(alice)).toBeUint(1_000n * STX);
    expect(ogStatus()).toStrictEqual(status(1n, 1_000n * STX));
  });

  it("no seat: u128 (also for a staker who is not staked anywhere)", function () {
    // arrange
    setStakerInfo(bob, OTHER_SIGNER);
    // act
    const r1 = evict(alice);
    const r2 = evict(bob);
    // assert
    expect(r1.result).toBeErr(Cl.uint(128));
    expect(r2.result).toBeErr(Cl.uint(128));
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
  });

  it("unstake: staying until the lock ends, then evictable", function () {
    // arrange: locked cycles 150..152 with the pool; unstake keeps the lock
    stake(alice, 1_000n * STX);
    setStakerInfo(alice, `${admin}.${POOL}`, 150n, 3n);
    setCycle(152n);
    // act + assert: last locked cycle, still staying
    expect(ogStaying(alice)).toBeBool(true);
    expect(evict(alice).result).toBeErr(Cl.uint(129));
    // act + assert: lock ended, pox-5 returns none
    setCycle(153n);
    expect(ogStaying(alice)).toBeBool(false);
    expect(evict(alice).result).toBeOk(Cl.uint(1_000n * STX));
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
  });

  it("re-seat after eviction while the cap has room; freed cover goes to others", function () {
    // arrange: alice fills the cap, bob gets nothing
    stake(alice, CAP);
    stake(bob, 1_000n * STX);
    expect(isOg(bob)).toBeBool(false);
    setStakerInfo(alice, OTHER_SIGNER);
    expect(evict(alice).result).toBeOk(Cl.uint(CAP));
    // act
    const rb = stake(bob, 1_000n * STX);
    const ra = stake(alice, 500n * STX);
    // assert
    expect(rb.result).toBeOk(Cl.bool(true));
    expect(ra.result).toBeOk(Cl.bool(true));
    expect(ogSeatEvents(ra.events)).toHaveLength(1);
    expect(ogUstx(bob)).toBeUint(1_000n * STX);
    expect(ogUstx(alice)).toBeUint(500n * STX);
    expect(ogStatus()).toStrictEqual(status(2n, 1_500n * STX));
  });

  it("anyone can evict: the staker or a stranger, no admin needed", function () {
    // arrange
    stake(alice, 1_000n * STX);
    stake(bob, 2_000n * STX);
    setStakerInfo(alice, null);
    setStakerInfo(bob, OTHER_SIGNER);
    // act
    const r1 = evict(alice, alice);
    const r2 = evict(bob, carol);
    // assert
    expect(r1.result).toBeOk(Cl.uint(1_000n * STX));
    expect(r2.result).toBeOk(Cl.uint(2_000n * STX));
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
    // a second eviction of the same staker has no seat
    expect(evict(alice, admin).result).toBeErr(Cl.uint(128));
  });
});

// Patient Reed recheck (bounty mv7dfb): an OG unstakes, the lock ends and,
// before anyone calls evict-og, they stake a small amount fresh. og-staying is
// true again (evict u129), so the cover must shrink to the new stake.
describe("og-shrink: fresh small stake after the lock ended", function () {
  it("attack: 1M cover, lock ends, 1 STX fresh stake -> cover 1 STX, room freed for others", function () {
    // arrange: alice holds the whole cap, bob gets nothing
    stake(alice, CAP, 150n);
    stake(bob, 1_000n * STX, 150n);
    expect(isOg(bob)).toBeBool(false);
    setCycle(151n); // lock 150..150 ended, pox-5 returns none
    expect(ogStaying(alice)).toBeBool(false);
    // act: fresh 1 STX stake before anyone evicts
    const r = stake(alice, 1n * STX, 152n);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogStaying(alice)).toBeBool(true);
    expect(evict(alice).result).toBeErr(Cl.uint(129));
    const ev = ogShrinkEvents(r.events);
    expect(ev).toHaveLength(1);
    expect(ev[0].data.value).toStrictEqual(
      Cl.tuple({
        topic: Cl.stringAscii("og-shrink"),
        staker: Cl.principal(alice),
        "covered-ustx": Cl.uint(1n * STX),
        "freed-ustx": Cl.uint(CAP - 1n * STX),
      }),
    );
    expect(ogSeatEvents(r.events)).toHaveLength(0);
    expect(isOg(alice)).toBeBool(true);
    expect(ogUstx(alice)).toBeUint(1n * STX);
    expect(ogStatus()).toStrictEqual(status(1n, 1n * STX));
    expect(stakerFee(alice, 1_000_000n * STX, 1_000_000n, 450n)).toBeUint(
      (1_000_000n * 450n * (1_000_000n * STX - 1n * STX)) / (10_000n * 1_000_000n * STX),
    );
    // act + assert: the freed room goes to another staker
    const rb = stake(bob, 1_000n * STX, 152n);
    expect(rb.result).toBeOk(Cl.bool(true));
    expect(ogUstx(bob)).toBeUint(1_000n * STX);
    expect(ogStatus()).toStrictEqual(status(2n, 1_001n * STX));
  });

  it("stake equal to the cover: unchanged, no event", function () {
    // arrange
    stake(alice, 1_000n * STX, 150n);
    setCycle(151n);
    // act
    const r = stake(alice, 1_000n * STX, 152n);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogShrinkEvents(r.events)).toHaveLength(0);
    expect(ogSeatEvents(r.events)).toHaveLength(0);
    expect(ogUstx(alice)).toBeUint(1_000n * STX);
    expect(ogStatus()).toStrictEqual(status(1n, 1_000n * STX));
  });

  it("top-up still grows the cover, no shrink event", function () {
    // arrange
    stake(alice, 1_000n * STX, 150n);
    // act
    const r = stake(alice, 2_500n * STX, 150n);
    // assert
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogShrinkEvents(r.events)).toHaveLength(0);
    expect(ogSeatEvents(r.events)).toHaveLength(1);
    expect(ogUstx(alice)).toBeUint(2_500n * STX);
    expect(ogStatus()).toStrictEqual(status(1n, 2_500n * STX));
  });

  it("shrink then a later top-up grows again, clamped to the cap left", function () {
    // arrange: alice shrinks from the cap to 1 STX, bob takes 1M of the room
    stake(alice, CAP, 150n);
    setCycle(151n);
    stake(alice, 1n * STX, 152n);
    stake(bob, 1_000_000n * STX, 152n);
    expect(ogStatus()).toStrictEqual(status(2n, 1_000_001n * STX));
    // act: alice tops up to the whole cap again
    const r = stake(alice, CAP, 152n);
    // assert: grows only into the 1.1M left
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogSeatEvents(r.events)).toHaveLength(1);
    expect(ogUstx(alice)).toBeUint(CAP - 1_000_000n * STX);
    expect(ogUstx(bob)).toBeUint(1_000_000n * STX);
    expect(ogStatus()).toStrictEqual(status(2n, CAP));
  });

  it("evict after a shrink frees only the shrunk cover", function () {
    // arrange
    stake(alice, 1_000n * STX, 150n);
    setCycle(151n);
    stake(alice, 10n * STX, 152n);
    setCycle(153n);
    // act
    const r = evict(alice);
    // assert
    expect(r.result).toBeOk(Cl.uint(10n * STX));
    expect(isOg(alice)).toBeBool(false);
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
  });

  it("zero-amount stake over a seat: the seat is dropped, counted once on re-entry", function () {
    // arrange
    stake(alice, 1_000n * STX, 150n);
    setCycle(151n);
    // act
    const r = stake(alice, 0n, 152n);
    // assert: a 0 stake deletes the seat and frees its cover
    expect(r.result).toBeOk(Cl.bool(true));
    expect(ogUstx(alice)).toBeUint(0);
    expect(isOg(alice)).toBeBool(false);
    expect(ogStatus()).toStrictEqual(status(0n, 0n));
    setCycle(153n);
    expect(evict(alice).result).toBeErr(Cl.uint(128));
    // act: a later stake opens one new seat
    const again = stake(alice, 5n * STX, 153n);
    expect(again.result).toBeOk(Cl.bool(true));
    expect(ogStatus()).toStrictEqual(status(1n, 5n * STX));
  });
});
