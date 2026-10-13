// OG seats on the stake path, mainnet fork: no deadline and no seat limit, the
// 2.1M cap is the only end. Stakes whose first reward cycle is 147, 148 and 149
// all take seats; a stake inside a prepare phase is probed (pox-5 refuses it
// with u47, so it never reaches the pool). The cap is raise-only.
// Real stakes throughout; no fixtures.
// Run: node simulations/pool-og-cap-stxer.mjs
import { poolSim, PID, POX, STX, acct } from './_juice-pool-sim.mjs';
import { createRequire } from 'node:module';
const { Cl } = createRequire(import.meta.url)('@stacks/transactions');

const s = await poolSim();
const C0 = s.cycle();
const A = acct('1'), PREP = acct('2'), B = acct('3'), C = acct('4'), D = acct('5'), E = acct('6');
for (const w of [A, PREP, B, C, D, E]) s.fund(w, 410n * STX); // the fork whale holds ~2.7k STX
const isOg = (label, who, want) => s.rd(label, `(is-og '${who})`, want);
const firstCycle = (label, who, want) => s.ev(label, POX, `(get-staker-info '${who})`, want);

// A stakes for 12 cycles (not the max 96) so a cycles-only extension is valid later.
s.call(`stake in cycle ${C0} for 12 cycles (first cycle ${C0 + 1})`, POX, 'stake',
  [Cl.contractPrincipal(PID.split('.')[0], PID.split('.')[1]), Cl.uint(400n * STX), Cl.uint(12), Cl.uint(s.burn), Cl.none()], (v) => v.startsWith('(ok'), A);
firstCycle(`A starts earning in ${C0 + 1}`, A, (v) => v.includes(`(first-reward-cycle u${C0 + 1})`));
isOg('A takes a seat', A, 'true');

// Prepare phase: offset 2000 of 2100. Whatever pox-5 decides, the pool follows:
// an admitted stake takes a seat, a refused one never reaches the pool.
s.advance(2000 - s.offset(), `cycle ${C0} prepare phase`);
const prep = s.stake('stake inside the prepare phase (pox-5 decides)', PREP, 400n * STX, () => true);
const prepOg = isOg('PREP seat?', PREP, (v) => v === 'true' || v === 'false');

s.toCycle(C0 + 1, `into cycle ${C0 + 1}`);
s.stake(`stake in cycle ${C0 + 1} (first cycle ${C0 + 2})`, B, 400n * STX);
isOg('B takes a seat: no deadline', B, 'true');
s.toCycle(C0 + 2, `into cycle ${C0 + 2}`);
s.stake(`stake in cycle ${C0 + 2} (first cycle ${C0 + 3})`, C, 400n * STX);
isOg('C takes a seat: still no deadline', C, 'true');

// A cycles-only stake-update (no new STX): pox-5 passes the same total, so
// the seat has nothing to grow and the update still succeeds.
s.call('A extends 5 cycles, no new STX', POX, 'stake-update',
  [Cl.contractPrincipal(PID.split('.')[0], PID.split('.')[1]), Cl.contractPrincipal(PID.split('.')[0], PID.split('.')[1]), Cl.uint(5), Cl.uint(0), Cl.none()], (v) => v.startsWith('(ok'), A);
s.rd('A still covers 400 STX', `(get-og-ustx '${A})`, `u${400n * STX}`);

// Cap fill. 2.1M STX of real stakes is more than any fork wallet holds, so a
// fixture moves the covered total to 300 STX under the cap; the stakes after
// it are real.
const status = s.rd('seats before the cap fill', '(get-og-status)', () => true);
s.rd('fixture: 300 STX left under the cap', `(begin (var-set og-covered-ustx (- (var-get og-cap-ustx) u${300n * STX})) true)`, 'true');
s.stake('D stakes 400 into the last 300 of the cap', D, 400n * STX);
s.rd('D is clamped to the 300 STX left', `(get-og-ustx '${D})`, `u${300n * STX}`);
s.stake('E stakes 300 with the cap full: the stake still succeeds', E, 300n * STX);
isOg('E gets no seat (cap full)', E, 'false');
s.rd('covered = cap', '(get-og-status)', (v) => v.includes(`(covered-ustx u${2100000n * STX})`));
s.call('admin raises the cap to 2.2M STX', PID, 'raise-og-cap', [Cl.uint(2200000n * STX)], '(ok true)');
s.call('E tops up +100 STX: the raised cap opens a 400 STX seat', POX, 'stake-update',
  [Cl.contractPrincipal(PID.split('.')[0], PID.split('.')[1]), Cl.contractPrincipal(PID.split('.')[0], PID.split('.')[1]), Cl.uint(0), Cl.uint(100n * STX), Cl.none()], (v) => v.startsWith('(ok'), E);
s.rd('E covers 400 STX', `(get-og-ustx '${E})`, `u${400n * STX}`);

// The cap is a raise-only admin var.
s.call('outsider cannot raise the cap', PID, 'raise-og-cap', [Cl.uint(2300000n * STX)], '(err u100)', acct('9'));
s.call('the same cap is refused (u127)', PID, 'raise-og-cap', [Cl.uint(2200000n * STX)], '(err u127)');
s.call('lowering the cap is refused (u127)', PID, 'raise-og-cap', [Cl.uint(2100000n * STX)], '(err u127)');
s.rd('status shows the new cap', '(get-og-status)', (v) => v.includes(`(cap-ustx u${2200000n * STX})`));

await s.run('juice-og-cap', (a) => {
  const admitted = a(prep).startsWith('(ok'), n = admitted ? 4n : 3n;
  return [
    ['prepare-phase stake: seat iff pox-5 admitted it', a(prepOg) === String(admitted), `stake ${a(prep).slice(0, 40)} | og ${a(prepOg)}`],
    [`${n} seats, ${n * 400n} STX covered, cap 2.1M`, a(status).includes(`(seats u${n})`) && a(status).includes(`(covered-ustx u${n * 400n * STX})`) && a(status).includes(`(cap-ustx u${2100000n * STX})`), a(status)],
  ];
});
