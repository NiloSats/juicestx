// OG cover shrink on a mainnet fork: Patient Reed recheck of d90dc1c
// (bounty mv7dfb43df5505479788). An OG holding the whole cap unstakes, the
// lock ends, and before anyone calls evict-og they stake 1 STX fresh. With
// the fix, take-og-seat shrinks the cover to the new stake ("og-shrink") and
// the freed room goes back to the cap.
//
// Real pox-5 throughout, no fixtures (the fork whale holds ~2.7k STX, so the
// big cover comes from a real mainnet staker instead of a funded one):
//   HOP: 200k STX locked at fastpool-max500-signer-manager on mainnet. Hops into
//        the pool (stake-update, no new STX) and takes a 200k seat, unstakes,
//        the lock ends, then stakes 1 STX fresh before anyone evicts.
//   ZERO: seated 10 STX, unstakes, lock ends, then tries a 0-STX fresh stake
//         (probes whether pox-5 lets a 0 stake reach validate-stake!)
//   LATE: stakes 1,000 STX after the shrink and takes a normal seat
//
// Run: node simulations/pool-og-shrink-stxer.mjs
import { createRequire } from 'node:module';
import { poolSim, PID, POX, STRANGER, STX, acct, ok } from './_juice-pool-sim.mjs';
const { Cl, cvToString, deserializeCV } = createRequire(import.meta.url)('@stacks/transactions');

const HOP = 'SP13CM9QN6J23B6T6415SC0T8JQZ3YADPD1TJ27WZ';
const HOP_SIGNER = 'SPMPMA1V6P430M8C91QS1G9XJ95S59JS1TZFZ4Q4.fastpool-max500-signer-manager';
const HOP_USTX = 200000n * STX;
const ZERO = acct('d');
const LATE = acct('e');
const CAP = 2100000n * STX;
const LATE_USTX = 1000n * STX;

const s = await poolSim();
const cp = (id) => Cl.contractPrincipal(...id.split('.'));
const update = (label, who, to, from, ext, inc, want = ok) => s.call(label, POX, 'stake-update',
  [cp(to), cp(from), Cl.uint(ext), Cl.uint(inc), Cl.none()], want, who);
const staying = (label, who, want) => s.rd(label, `(og-staying '${who})`, String(want));
const evict = (label, who, want, sender = STRANGER) => s.call(label, PID, 'evict-og', [Cl.principal(who)], want, sender);
const cover = (label, who, ustx) => s.rd(label, `(get-og-ustx '${who})`, `u${ustx}`);
const status = (label, seats, covered) => s.rd(label, '(get-og-status)',
  (v) => v.includes(`(seats u${seats})`) && v.includes(`(covered-ustx u${covered})`) && v.includes(`(cap-ustx u${CAP})`));
const signerOf = (label, who, signer) => s.ev(label, POX, `(get-staker-info '${who})`,
  (v) => signer === null ? v === 'none' : v.includes(`(signer ${signer})`));

if (s.offset() > 1800) s.toCycle(s.cycle() + 1, 'clear of the prepare phase');
const C = s.cycle();

// -- HOP takes a 200k seat, ZERO a 10 STX seat -----------------------------------
signerOf('HOP is locked at fastpool on mainnet', HOP, HOP_SIGNER);
status('no seats at start', 0, 0n);
update('HOP stake-updates fastpool -> pool, no new STX', HOP, PID, HOP_SIGNER, 0, 0);
cover('HOP covers 200k', HOP, HOP_USTX);
s.fund(ZERO, 20n * STX);
s.fund(LATE, LATE_USTX + 10n * STX);
s.stake('ZERO stakes 10 STX', ZERO, 10n * STX);
status('2 seats, 200,010 STX covered', 2, HOP_USTX + 10n * STX);

// -- both unstake; the lock runs to the end of cycle C ---------------------------
const uns = s.call('HOP unstakes', POX, 'unstake', [cp(PID)], ok, HOP);
s.call('ZERO unstakes', POX, 'unstake', [cp(PID)], ok, ZERO);
staying('HOP still staying until the lock ends', HOP, true);
evict('evict HOP right after unstake: u129', HOP, '(err u129)');

// -- lock ended; nobody evicts ---------------------------------------------------
s.toCycle(C + 1, `into cycle ${C + 1}, HOP lock ended`);
signerOf('pox-5 get-staker-info HOP = none', HOP, null);
staying('HOP og-staying false once the lock ended', HOP, false);
cover('HOP cover still 200k (not evicted yet)', HOP, HOP_USTX);

// -- the attack: 1 STX fresh stake before anyone evicts --------------------------
const shrink = s.stake('ATTACK: HOP stakes 1 STX fresh before evict-og', HOP, 1n * STX);
staying('HOP og-staying true again', HOP, true);
evict('evict HOP after the fresh stake: u129 (still staying)', HOP, '(err u129)');
cover('FIX: HOP cover shrank to 1 STX', HOP, 1n * STX);
s.rd('HOP keeps the seat', `(is-og '${HOP})`, 'true');
status('FIX: 2 seats, 11 STX covered (199,999 STX back to the cap)', 2, 11n * STX);
s.rd('HOP fee on a 200k share is charged above the 1 STX cover',
  `(get-staker-fee '${HOP} u${HOP_USTX} u1000000 u450)`,
  `u${(1000000n * 450n * (HOP_USTX - STX)) / (10000n * HOP_USTX)}`);

// -- a later staker takes a normal seat -------------------------------------------
s.stake('LATE stakes 1,000 STX', LATE, LATE_USTX);
cover('LATE covered 1,000 STX', LATE, LATE_USTX);
status('3 seats: HOP 1 + ZERO 10 + LATE 1,000', 3, LATE_USTX + 11n * STX);

// -- equal and top-up on real pox-5 ----------------------------------------------
const same = update('HOP stake-update same total (no extend, no increase)', HOP, PID, PID, 0, 0);
cover('equal: HOP cover still 1 STX', HOP, 1n * STX);
update('HOP tops up +5 STX', HOP, PID, PID, 0, 5n * STX);
cover('top-up: HOP cover grew to 6 STX', HOP, 6n * STX);
status('3 seats: 6 + 10 + 1,000', 3, LATE_USTX + 16n * STX);

// -- zero-amount probe -----------------------------------------------------------
staying('ZERO lock ended', ZERO, false);
const zero = s.stake('PROBE: ZERO stakes 0 STX fresh (pox-5 lock of 0)', ZERO, 0n, () => true);
cover('PROBE: ZERO cover unchanged at 10 STX', ZERO, 10n * STX);
const evictZero = evict('ZERO evictable as before', ZERO, `(ok u${10n * STX})`);
status('final: 2 seats (HOP 6, LATE 1,000)', 2, LATE_USTX + 6n * STX);

await s.run('juice-og-shrink', (a, result) => {
  const prints = (slot) => (result.steps[slot]?.Result?.Transaction?.Ok?.events ?? [])
    .map((raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    .filter((e) => e.type === 'contract_event' && e.contract_event?.contract_identifier === PID)
    .map((e) => cvToString(deserializeCV(e.contract_event.raw_value)));
  const topic = (slot, t) => prints(slot).filter((x) => x.includes(`"${t}"`));
  const sh = topic(shrink, 'og-shrink');
  return [
    ['og-shrink print: covered 1 STX, freed 199,999 STX',
      sh.length === 1 && sh[0].includes(`(covered-ustx u${STX})`) && sh[0].includes(`(freed-ustx u${HOP_USTX - STX})`), sh.join(' | ').slice(0, 220)],
    ['equal update: no og-shrink and no og-seat print',
      topic(same, 'og-shrink').length === 0 && topic(same, 'og-seat').length === 0, prints(same).join(' | ').slice(0, 160)],
    [`unstake unlock cycle = ${C + 1}`, a(uns).includes(`(unlock-cycle u${C + 1})`), a(uns).slice(0, 160)],
    ['zero stake never reaches the pool (node refuses a 0 lock)', a(zero).includes('PoxInvalidLockAmount'), a(zero).slice(0, 200)],
    ['og-evict print for ZERO: 10 STX', topic(evictZero, 'og-evict').length === 1, topic(evictZero, 'og-evict').join('').slice(0, 160)],
  ];
});
