// Claim guards, mainnet fork: a claim with nothing to claim (pox-5 refuses
// first with its own u32, so the pool's u109 is unreachable), a second cycle's
// claim while another swap is pending (u115, whole tx reverts so the cycle stays
// claimable), and settle on unknown stakers (pox-5 settle has no failure path,
// so the pool's u103 is unreachable). Fixture: earned rewards for two cycles.
// Run: node simulations/pool-claim-guards-stxer.mjs
import { poolSim, PID, POX, SBTC, SBTC_WHALE, STRANGER, STX, acct, ok } from './_juice-pool-sim.mjs';
import { createRequire } from 'node:module';
const { Cl } = createRequire(import.meta.url)('@stacks/transactions');

const s = await poolSim();
const A = acct('1'), B = acct('2'), FUND = 100000n;
const R1 = s.cycleNow - 1, R2 = s.cycleNow - 2, R0 = s.cycleNow - 3;
const claim = (label, rc, want) => s.call(label, PID, 'pox-claim-rewards', [Cl.list([]), Cl.uint(rc)], want, STRANGER);

claim(`cycle ${R0} has nothing to claim: pox-5 refuses (u32)`, R0, '(err u32)');
s.rd(`cycle ${R0} untouched`, `(get-last-claim-dist-cycle u${R0})`, 'none');
s.call('fund real PoX sBTC for two cycles (fork only)', SBTC, 'transfer',
  [Cl.uint(2n * FUND), Cl.principal(SBTC_WHALE), Cl.principal(POX), Cl.none()], '(ok true)', SBTC_WHALE);
s.fixture(R1, FUND, [[A, 1000n * STX], [B, 3000n * STX]]);
s.fixture(R2, FUND, [[A, 1000n * STX], [B, 3000n * STX]]);
claim(`claim ${R1}`, R1, (v) => ok(v) && v.includes(`(total-rewards u${FUND})`));
claim(`claim ${R2} while ${R1} is pending (u115)`, R2, '(err u115)');
s.rd(`${R2} claim reverted: no dist cycle recorded`, `(get-last-claim-dist-cycle u${R2})`, 'none');
s.rd(`${R2} tranche count still 0`, `(get-tranche-count u${R2})`, 'u0');
s.rd(`${R2} rewards still in pox-5`, `(get-unclaimed-signer-rewards u${R2} none)`, `u${FUND}`);
s.rd('pending swap is still the first claim', '(get-pending-swap)', (v) => v.includes(`(reward-cycle u${R1})`));
s.call('settle on unknown stakers and an empty cycle still succeeds', PID, 'pox-settle-stakers',
  [Cl.list([Cl.principal(acct('7')), Cl.principal(STRANGER)]), Cl.uint(R0), Cl.none()], '(ok u0)', STRANGER);
s.call('settle on real stakers succeeds', PID, 'pox-settle-stakers',
  [Cl.list([Cl.principal(A), Cl.principal(B)]), Cl.uint(R1), Cl.none()], ok, STRANGER);

await s.run('juice-claim-guards');
