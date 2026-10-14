// OG seat eviction on a mainnet fork: og-staying / evict-og in
// juice-pool-sbtc-signer (bounty mv7dfb43df5505479788 #1, Patient Reed).
//
// Real pox-5 throughout, no fixtures. Two real mainnet stakers already locked
// at other signers do the bounty hop with stake-update (no new STX):
//   HOP: 200k STX at fastpool-max500-signer-manager
//   HOP2: ~510 STX at xverse-signer-manager-3
// plus one fresh funded staker (UNS) for the unstake path.
// Scenarios: (a) hop in and out in one cycle, then a third party evicts;
// (b) still staked -> u129; (c) no seat -> u128; (d) unstake keeps the seat
// until the lock ends, then evictable; (e) re-seat after eviction (hop back in,
// and a fresh stake after the lock ended); (f) the prepare phase does not
// matter for evict-og.
//
// Run: node simulations/pool-og-evict-stxer.mjs
import { createRequire } from 'node:module';
import { poolSim, PID, POX, STRANGER, STX, acct, ok, num } from './_juice-pool-sim.mjs';
const { Cl, cvToString, deserializeCV } = createRequire(import.meta.url)('@stacks/transactions');

const HOP = 'SP13CM9QN6J23B6T6415SC0T8JQZ3YADPD1TJ27WZ';
const HOP_SIGNER = 'SPMPMA1V6P430M8C91QS1G9XJ95S59JS1TZFZ4Q4.fastpool-max500-signer-manager';
const HOP_USTX = 200000n * STX;
const HOP2 = 'SP38HNY9QH4B7ZJVE3KD2GDCRXHXEX02RA3PDDKKV';
const HOP2_SIGNER = 'SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-3';
const HOP2_USTX = 509726243n;
const UNS = acct('a');
const UNS_USTX = 500n * STX;
const CAP = 2100000n * STX;

const s = await poolSim();
const cp = (id) => Cl.contractPrincipal(...id.split('.'));
const move = (label, who, to, from, want = ok) => s.call(label, POX, 'stake-update',
  [cp(to), cp(from), Cl.uint(0), Cl.uint(0), Cl.none()], want, who);
const staying = (label, who, want) => s.rd(label, `(og-staying '${who})`, String(want));
const evict = (label, who, want, sender = STRANGER) => s.call(label, PID, 'evict-og', [Cl.principal(who)], want, sender);
const status = (label, seats, covered) => s.rd(label, '(get-og-status)',
  (v) => v.includes(`(seats u${seats})`) && v.includes(`(covered-ustx u${covered})`) && v.includes(`(cap-ustx u${CAP})`));
const signerOf = (label, who, signer) => s.ev(label, POX, `(get-staker-info '${who})`,
  (v) => signer === null ? v === 'none' : v.includes(`(signer ${signer})`));

if (s.offset() > 1800) s.toCycle(s.cycle() + 1, 'clear of the prepare phase');
const C = s.cycle();

// -- preconditions: both hoppers are real stakers at other signers -------------
signerOf('HOP is locked at fastpool on mainnet', HOP, HOP_SIGNER);
signerOf('HOP2 is locked at xverse-3 on mainnet', HOP2, HOP2_SIGNER);
staying('HOP not staying with the pool yet', HOP, false);
status('no seats at start', 0, 0n);

// -- (c) no seat -> u128 -------------------------------------------------------
evict('(c) evict a never-staked principal: u128', STRANGER, '(err u128)');
evict('(c) evict a real staker at another signer, no seat: u128', HOP, '(err u128)');

// -- (a) the bounty hop --------------------------------------------------------
move('(a) HOP stake-updates fastpool -> pool, no new STX', HOP, PID, HOP_SIGNER);
s.rd('(a) HOP took a 200k STX seat', `(get-og-ustx '${HOP})`, `u${HOP_USTX}`);
staying('(a) og-staying true while at the pool', HOP, true);
status('(a) 1 seat, 200k covered', 1, HOP_USTX);
// -- (b) still staked -> u129 --------------------------------------------------
evict('(b) evict while HOP is staked with the pool: u129', HOP, '(err u129)');
s.rd('(b) seat unchanged after u129', `(get-og-ustx '${HOP})`, `u${HOP_USTX}`);
const hopOut = move('(a) HOP stake-updates back pool -> fastpool, same cycle', HOP, HOP_SIGNER, PID);
signerOf('(a) pox-5 names fastpool again at once', HOP, HOP_SIGNER);
staying('(a) og-staying false after the hop out', HOP, false);
s.rd('(a) seat still held until evicted', `(is-og '${HOP})`, 'true');
const evictHop = evict('(a) third party evicts HOP: frees 200k', HOP, `(ok u${HOP_USTX})`);
s.rd('(a) HOP no longer OG', `(is-og '${HOP})`, 'false');
status('(a) cover back to the cap: 0 seats, 0 covered', 0, 0n);
evict('(a) evict again: u128', HOP, '(err u128)');

// -- (e) re-seat by hopping back in --------------------------------------------
move('(e) HOP stake-updates back into the pool', HOP, PID, HOP_SIGNER);
s.rd('(e) HOP re-seated with 200k', `(get-og-ustx '${HOP})`, `u${HOP_USTX}`);
status('(e) 1 seat again', 1, HOP_USTX);

// -- second hopper, evicted later inside the prepare phase ---------------------
move('HOP2 stake-updates xverse-3 -> pool', HOP2, PID, HOP2_SIGNER);
s.rd('HOP2 took a seat', `(get-og-ustx '${HOP2})`, `u${HOP2_USTX}`);
move('HOP2 stake-updates back pool -> xverse-3', HOP2, HOP2_SIGNER, PID);
staying('HOP2 og-staying false', HOP2, false);

// -- (d) unstake: stays until the lock ends ------------------------------------
s.fund(UNS, 510n * STX);
s.stake('(d) UNS stakes 500 STX into the pool', UNS, UNS_USTX);
s.rd('(d) UNS seated with 500', `(get-og-ustx '${UNS})`, `u${UNS_USTX}`);
const uns = s.call('(d) UNS unstakes', POX, 'unstake', [cp(PID)], ok, UNS);
signerOf('(d) pox-5 still names the pool until the lock ends', UNS, PID);
staying('(d) og-staying true after unstake', UNS, true);
evict('(d) evict right after unstake: u129', UNS, '(err u129)');
status('3 seats: HOP, HOP2, UNS', 3, HOP_USTX + HOP2_USTX + UNS_USTX);

// -- (f) prepare phase ---------------------------------------------------------
s.advance(2030 - s.offset(), `(f) into the cycle ${C} prepare phase`);
s.ev('(f) pox-5 reports the prepare phase', POX, '(is-in-prepare-phase (current-pox-reward-cycle))', 'true');
move('(f) stake-update is refused in the prepare phase (pox-5)', HOP2, PID, HOP2_SIGNER, (v) => v.startsWith('(err'));
staying('(f) HOP2 still not staying in the prepare phase', HOP2, false);
const evictHop2 = evict('(f) evict HOP2 inside the prepare phase', HOP2, `(ok u${HOP2_USTX})`);
evict('(f) HOP still staked: u129 in the prepare phase', HOP, '(err u129)');
evict('(f) UNS lock not ended: u129 in the prepare phase', UNS, '(err u129)');
status('(f) 2 seats after the prepare-phase eviction', 2, HOP_USTX + UNS_USTX);

// -- (d) lock ends at the next cycle -------------------------------------------
s.toCycle(C + 1, `(d) into cycle ${C + 1}, UNS lock ended`);
signerOf('(d) pox-5 get-staker-info UNS = none', UNS, null);
staying('(d) og-staying false once the lock ended', UNS, false);
const evictUns = evict('(d) third party evicts UNS', UNS, `(ok u${UNS_USTX})`);
evict('(d) HOP (lock to cycle 150) still u129', HOP, '(err u129)');
status('(d) 1 seat left (HOP)', 1, HOP_USTX);

// -- (e) re-seat by a fresh stake after the lock ended -------------------------
s.stake('(e) UNS stakes again after its lock ended', UNS, UNS_USTX);
s.rd('(e) UNS re-seated with 500', `(get-og-ustx '${UNS})`, `u${UNS_USTX}`);
staying('(e) UNS staying again', UNS, true);
status('final: 2 seats (HOP, UNS)', 2, HOP_USTX + UNS_USTX);

await s.run('juice-og-evict', (a, result) => {
  const prints = (slot) => (result.steps[slot]?.Result?.Transaction?.Ok?.events ?? [])
    .map((raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    .filter((e) => e.type === 'contract_event' && e.contract_event?.contract_identifier === PID)
    .map((e) => cvToString(deserializeCV(e.contract_event.raw_value)));
  const evicted = (slot, who, freed, seats) => {
    const p = prints(slot).filter((x) => x.includes('"og-evict"'));
    return [p.length === 1 && p[0].includes(`(staker ${who})`) && p[0].includes(`(freed-ustx u${freed})`) && p[0].includes(`(seats u${seats})`), p.join(' | ').slice(0, 200)];
  };
  const unlock = a(uns).match(/\(unlock-cycle u(\d+)\)/)?.[1];
  return [
    ['(a) og-evict print for HOP: 200k freed, 0 seats', ...evicted(evictHop, HOP, HOP_USTX, 0)],
    ['(f) og-evict print for HOP2 in the prepare phase', ...evicted(evictHop2, HOP2, HOP2_USTX, 2)],
    ['(d) og-evict print for UNS', ...evicted(evictUns, UNS, UNS_USTX, 1)],
    ['(a) hop out was a pure move (amount unchanged)', a(hopOut).includes(`(amount-ustx u${HOP_USTX})`) && a(hopOut).includes('(amount-increase u0)'), a(hopOut).slice(0, 160)],
    [`(d) unstake unlock cycle = ${C + 1}`, unlock === String(C + 1), `unlock-cycle ${unlock} (num ${num(a(uns))})`],
  ];
});
