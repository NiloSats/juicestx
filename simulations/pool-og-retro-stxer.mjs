// OG cover read at payout, on a mainnet fork, side by side (Nilo, an AI agent
// built with Claude; bounty mv8wal65aa4a0c11edcd).
// NEW = the fixed pool (NEW_REV, default 2bf7ac0), OLD = 570226c pool (OLD_REV,
// default 9b28e1e), both via git show, deployed under two names on one fork.
//
// Per pool, with real pox-5 calls for everything the OG cover depends on:
//   - a FILLER holds the whole 2.1M cap (fixture: og-stakers / og-seats /
//     og-covered-ustx, the fork whale holds ~2.7k STX)
//   - BOB stakes 100 STX for real while the cap is full: cover 0
//   - FILLER has no pox-5 lock (get-staker-info none): anyone evicts it
//   - BOB tops up +1 STX for real (stake-update): cover 101 STX, for the
//     next reward cycle on
//   - reward cycle R (already ended) was earned by BOB with no cover: fixture
//     with the same shape as pool-pay-fees-stxer.mjs (pox-5 shares + finalized
//     tranche 0 + stx-pot), pool funded with the pot in real STX
//   - pay-stx-stakers [BOB] R 0
// Expected: OLD pays BOB the whole pot (fee 0: the cover won after R reaches
// back into R); NEW charges the 4.5% fee on R, as the cover BOB had in R was 0.
//
// Run: node simulations/pool-og-retro-stxer.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { juiceForkBlock, traitSource } from './_juice-fork.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(directory, '../package.json'));
const { SimulationBuilder, getSimulationResult } = require('stxer');
const { Cl, ClarityVersion, deserializeCV, cvToString, serializeCV, getAddressFromPrivateKey,
  randomPrivateKey, privateKeyToPublic, signMessageHashRsv } = require('@stacks/transactions');

const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const STRANGER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const STX_WHALE = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const REPO_PATH = 'contracts/pox-5/juice-pool-sbtc-signer.clar';
const NEW_REV = process.env.NEW_REV || '2bf7ac0', OLD_REV = process.env.OLD_REV || '9b28e1e';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const gitShow = (rev) => execFileSync('git', ['show', `${rev}:${REPO_PATH}`], { cwd: resolve(directory, '..'), encoding: 'utf8' });
const SRC = { NEW: gitShow(NEW_REV), OLD: gitShow(OLD_REV) };
if (SRC.NEW === SRC.OLD) throw new Error('NEW and OLD sources are identical');
const TAGS = ['NEW', 'OLD'];
const POOLS = { NEW: `${DEP}.juice-pool-sbtc-signer`, OLD: `${DEP}.juice-pool-sbtc-signer-old` };

const STX = 1_000_000n, CAP = 2_100_000n * STX, BOB_USTX = 100n * STX, TOPUP = 1n * STX;
const POT = 10n * STX + 7n, FEE_BIPS = 450n;
const FEE = (POT * FEE_BIPS * BOB_USTX) / (10000n * BOB_USTX); // shares = BOB_USTX, cover in R = 0
const acct = (d) => getAddressFromPrivateKey(d.repeat(64) + '01', 'mainnet');
const W = { NEW: { FILLER: acct('a'), BOB: acct('b') }, OLD: { FILLER: acct('c'), BOB: acct('d') } };

async function readOnly(id, fn, args = []) {
  const [a, n] = id.split('.');
  const r = await fetch(`${NODE}/v2/contracts/call-read/${a}/${n}/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender: DEP, arguments: args.map((cv) => '0x' + serializeCV(cv).replace(/^0x/, '')) }),
  });
  const body = await r.json();
  if (!body.okay) throw new Error(`${fn}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.result;
}

const forkBlock = await juiceForkBlock(NODE);
const info = await (await fetch(`${NODE}/v2/info`)).json();
const cycleNow = Number(deserializeCV(await readOnly(POX, 'current-pox-reward-cycle')).value);
const R = cycleNow - 1;
let burn = info.burn_block_height;

const builder = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: !process.env.STXER_TRACE })
  .useBlockHeight(forkBlock).withSender(DEP);
const plan = [];
const push = (p) => { plan.push(p); return plan.length - 1; };
const call = (label, id, fn, args, want, sender = STRANGER) => {
  builder.withSender(sender).addContractCall({ contract_id: id, function_name: fn, function_args: args });
  builder.withSender(DEP);
  return push({ label, kind: 'tx', want });
};
const ev = (label, id, code, want) => { builder.addEvalCode(id, code); return push({ label, kind: 'eval', want }); };
const fund = (who, ustx) => {
  builder.withSender(STX_WHALE).addSTXTransfer({ recipient: who, amount: Number(ustx) });
  builder.withSender(DEP);
  return push({ label: `fund ${who.slice(0, 8)}… ${ustx} uSTX`, kind: 'transfer' });
};
const cp = (id) => Cl.contractPrincipal(...id.split('.'));
const ok = (v) => v.startsWith('(ok');

// -- deploy ---------------------------------------------------------------------
const sourceHashes = {};
const trait = traitSource(sourceHashes);
builder.addContractDeploy({ contract_name: trait.name, source_code: trait.source, clarity_version: ClarityVersion.Clarity6 });
push({ label: `deploy ${trait.name}`, kind: 'deploy' });
for (const tag of TAGS) {
  const name = POOLS[tag].split('.')[1];
  sourceHashes[name] = sha(SRC[tag]);
  builder.addContractDeploy({ contract_name: name, source_code: SRC[tag], clarity_version: ClarityVersion.Clarity6 });
  push({ label: `deploy ${tag} ${name} (${tag === 'NEW' ? NEW_REV : OLD_REV} file)`, kind: 'deploy' });
}

const idx = {};
for (const tag of TAGS) {
  const P = POOLS[tag], { FILLER, BOB } = W[tag], i = (idx[tag] = {});
  // a real pox-5 signer registration, as in _juice-pool-sim.mjs
  const AUTH_ID = 7, priv = randomPrivateKey(), key = privateKeyToPublic(priv);
  const grant = await readOnly(POX, 'get-signer-grant-message-hash', [cp(P), Cl.uint(AUTH_ID)]);
  const sig = signMessageHashRsv({ messageHash: grant.replace(/^0x/, '').slice(2 + 8), privateKey: priv });
  call(`${tag} register the pool as a pox-5 signer`, P, 'register-self',
    [cp(P), Cl.buffer(Buffer.from(key.replace(/^0x/, ''), 'hex')), Cl.uint(AUTH_ID),
     Cl.buffer(Buffer.from(sig.replace(/^0x/, ''), 'hex'))], ok, DEP);

  // the cap is full: one FILLER seat covers all of it
  ev(`${tag} fixture: FILLER holds the whole ${CAP / STX} STX cap`, P,
    `(begin (map-set og-stakers '${FILLER} u${CAP}) (var-set og-seats u1) (var-set og-covered-ustx u${CAP}) true)`, 'true');
  ev(`${tag} og status: 1 seat, cap covered`, P, '(get-og-status)',
    (v) => v.includes('(seats u1)') && v.includes(`(covered-ustx u${CAP})`) && v.includes(`(cap-ustx u${CAP})`));

  // BOB stakes for real while the cap is full: no cover
  fund(BOB, BOB_USTX + TOPUP + 10n * STX);
  call(`${tag} BOB stakes ${BOB_USTX / STX} STX (real pox-5) while the cap is full`, POX, 'stake',
    [cp(P), Cl.uint(BOB_USTX), Cl.uint(96), Cl.uint(burn), Cl.none()], ok, BOB);
  ev(`${tag} BOB cover 0 (cap full)`, P, `(get-og-ustx '${BOB})`, 'u0');

  // FILLER has no lock on pox-5: anyone evicts it, the whole cap is free again
  ev(`${tag} pox-5 get-staker-info FILLER = none`, POX, `(get-staker-info '${FILLER})`, 'none');
  i.evict = call(`${tag} STRANGER evicts FILLER`, P, 'evict-og', [Cl.principal(FILLER)], `(ok u${CAP})`);

  // BOB tops up 1 STX for real: the cover he wins applies from the next cycle
  i.topup = call(`${tag} BOB stake-update +${TOPUP / STX} STX (real pox-5)`, POX, 'stake-update',
    [cp(P), cp(P), Cl.uint(0), Cl.uint(TOPUP), Cl.none()], ok, BOB);
  ev(`${tag} BOB cover now ${(BOB_USTX + TOPUP) / STX} STX`, P, `(get-og-ustx '${BOB})`, `u${BOB_USTX + TOPUP}`);
  if (tag === 'NEW') ev('NEW BOB cover for the ended cycle R is 0', P, `(get-og-ustx-at '${BOB} u${R})`, 'u0');

  // cycle R (ended) was earned by BOB with no cover: payout state fixture
  const pkey = `{ reward-cycle: u${R}, bond-index: none, signer: '${P} }`;
  ev(`${tag} fixture: pox-5 cycle ${R} shares, BOB ${BOB_USTX}`, POX,
    `(begin (map-set signer-shares-staked-for-cycle ${pkey} u${BOB_USTX})
      (map-set staker-shares-staked-for-cycle { reward-cycle: u${R}, bond-index: none, signer: '${P}, staker: '${BOB} } u${BOB_USTX}) true)`, 'true');
  ev(`${tag} fixture: cycle ${R} tranche 0 finalized, pot ${POT} uSTX`, P,
    `(begin (map-set finalized-tranches { reward-cycle: u${R}, tranche: u0 } true)
      (map-set stx-pot { reward-cycle: u${R}, tranche: u0 } u${POT}) (map-set tranche-count u${R} u1) true)`, 'true');
  fund(P, POT);
  ev(`${tag} fee is 4.5%`, P, '(get-fee-bips)', `u${FEE_BIPS}`);
  ev(`${tag} earned fees before payout 0`, P, '(get-earned-fees)', 'u0');

  i.before = ev(`${tag} BOB STX before payout`, P, `(stx-get-balance '${BOB})`, (v) => /^u\d+$/.test(v));
  i.pay = call(`${tag} pay-stx-stakers [BOB] cycle ${R} tranche 0`, P, 'pay-stx-stakers',
    [Cl.list([Cl.principal(BOB)]), Cl.uint(R), Cl.uint(0)],
    tag === 'NEW' ? `(ok u${POT - FEE})` : (v) => ok(v));
  i.after = ev(`${tag} BOB STX after payout`, P, `(stx-get-balance '${BOB})`, (v) => /^u\d+$/.test(v));
  i.fees = ev(`${tag} earned fees after payout`, P, '(get-earned-fees)', (v) => /^u\d+$/.test(v));
}

// -- run --------------------------------------------------------------------------
console.log(`juice-og-retro: fork block ${forkBlock}, cycle ${cycleNow}, R = ${R}, ${plan.length} steps`);
const id = await builder.run();
const url = `https://stxer.xyz/simulations/mainnet/${id}`;
console.log(`View: ${url}`);
const result = await getSimulationResult(id, { stxerApi: API });
const checks = plan.map((p, n) => {
  const step = result.steps[n]?.Result;
  let actual;
  if (p.kind === 'eval') actual = step?.Eval?.Ok !== undefined ? cvToString(deserializeCV(step.Eval.Ok)) : `ENGINE ${JSON.stringify(step).slice(0, 200)}`;
  else actual = step?.Transaction?.Ok && !step.Transaction.Ok.vm_error ? cvToString(deserializeCV(step.Transaction.Ok.result)) : `ENGINE ${JSON.stringify(step).slice(0, 300)}`;
  const passed = p.kind === 'deploy' || p.kind === 'transfer' ? !actual.startsWith('ENGINE')
    : typeof p.want === 'function' ? p.want(actual) : actual === p.want;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${p.label}: ${actual.slice(0, 220)}`);
  return { label: p.label, passed, actual };
});
const a = (n) => checks[n].actual;
const num = (s) => BigInt(s.match(/u(\d+)/)?.[1] ?? '-1');
const got = (tag) => num(a(idx[tag].after)) - num(a(idx[tag].before));
const extra = [
  [`NEW: BOB receives pot - 4.5% = ${POT - FEE} uSTX`, got('NEW') === POT - FEE, String(got('NEW'))],
  [`NEW: pool earns the ${FEE} uSTX fee on cycle ${R}`, a(idx.NEW.fees) === `u${FEE}`, a(idx.NEW.fees)],
  [`OLD (unfixed): BOB receives the whole pot ${POT} uSTX`, got('OLD') === POT, String(got('OLD'))],
  [`OLD (unfixed): pool earns 0 fee on cycle ${R} (the cover won later reaches back)`, a(idx.OLD.fees) === 'u0', a(idx.OLD.fees)],
];
for (const [label, passed, actual] of extra) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${actual}`);
  checks.push({ label, passed, actual });
}
const failed = checks.filter((c) => !c.passed).length;
const dir = resolve(directory, 'results/pool-vault-stx'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'juice-og-retro.json'), JSON.stringify({ id, url, block: forkBlock, cycle: cycleNow, R, sourceHashes, checks }, null, 2));
console.log(`\n=== juice-og-retro: ${checks.length - failed}/${checks.length} passed ===\nView: ${url}`);
if (failed) process.exit(1);
