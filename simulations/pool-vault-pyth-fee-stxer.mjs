// Pyth Lazer fee budget, mainnet fork. The live oracle
// (SPMV5...pyth-lazer-oracle) charges its fee to tx-sender on every verify.
// Inside the vault's as-contract? that is the vault, so a fee > 0 needs a
// with-stx allowance (pyth-fee-budget) and STX in the vault.
// Fixture: the oracle fee is var-set to u10 with Eval in the oracle's own
// context (governance set-fee is not driven). A real STX maker bid rests on a
// fresh exact v6-3 market, so the router's Jing leg verifies the update inside
// the vault. How often one Jing fill verifies is read from the market
// source deployed below (JING_SRC): the deployed v6-3 swap verified twice
// (entry and settle-with-refresh); the bounty fix verifies once and hands
// the feeds to settle-with-verified-feeds. So one fill costs the vault
// VERIFIES x fee.
// Expected: router-swap aborts with budget 0 and with budget = VERIFIES x
// fee - 1 (err u1, the with-stx allowance), and sells after
// set-vault-pyth-fee-budget u100, the vault paying exactly VERIFIES x fee.
// Run: node simulations/pool-vault-pyth-fee-stxer.mjs
import {appendJingStack,JING_SRC} from './_jing-v6-3.mjs';
import {POOL_NAME,VAULT_NAME,juiceSource,juiceForkBlock,traitSource} from './_juice-fork.mjs';
import {withVaultArgument} from './_pool-vault-interface.mjs';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(here,'../package.json'));
const {SimulationBuilder,getSimulationResult}=require('stxer');
const {Cl,ClarityVersion,deserializeCV,cvToString,serializeCV,getAddressFromPrivateKey}=require('@stacks/transactions');
const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const STRANGER='SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const STX_WHALE='SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
const SBTC_WHALE='SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api';
const API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const POX='SP000000000000000000002Q6VF78.pox-5';
const ORACLE='SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8.pyth-lazer-oracle';
const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const WSTX='SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
const MKT=`${DEP}.markets-sbtc-stx-jing-v6-3`,ROUTER=`${DEP}.swap-router-sbtc-stx-jing-v5-3`;
const pid=`${DEP}.${POOL_NAME}`,vid=`${DEP}.${VAULT_NAME}`;
const ALICE=getAddressFromPrivateKey('7'.repeat(64)+'01','mainnet');
const BOB=getAddressFromPrivateKey('8'.repeat(64)+'01','mainnet');
const FUND=100000,FEE=10,FLOAT=1000,BUDGET=100;
// verifies per Jing fill, from the market source the fork deploys
const marketSource=readFileSync(resolve(JING_SRC,'markets-sbtc-stx-jing-v6-3.clar'),'utf8');
const VERIFIES=marketSource.includes('(settle-with-verified-feeds (get feed-x feeds) (get feed-y feeds)')?1:2;
const SHORT=VERIFIES*FEE-1; // one uSTX under what a fill costs the vault
if(BUDGET<VERIFIES*FEE)throw new Error('BUDGET must cover a fill');
console.log(`market swap verifies ${VERIFIES}x per fill: a fill costs the vault ${VERIFIES*FEE} uSTX`);

const {fetchLazerUpdateAny}=await import('./_pool-vault-lazer.mjs');
const proof=await fetchLazerUpdateAny();
const update=Cl.buffer(Buffer.from(proof.hex.replace(/^0x/,''),'hex'));
const forkBlock=await juiceForkBlock(NODE);
const read=async(id,fn,args=[])=>{
 const [address,name]=id.split('.');
 const r=await fetch(`${NODE}/v2/contracts/call-read/${address}/${name}/${fn}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sender:DEP,arguments:args.map(cv=>'0x'+serializeCV(cv).replace(/^0x/,''))})});
 const body=await r.json();if(!body.okay)throw new Error(`${fn}: ${JSON.stringify(body).slice(0,200)}`);
 return deserializeCV(body.result);
};
const cycle=Number((await read(POX,'current-pox-reward-cycle')).value)-1;
const builder=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API,skipTracing:true}).useBlockHeight(forkBlock).withSender(DEP);
const plan=[],sourceHashes={};
appendJingStack(builder,plan,sourceHashes,forkBlock);
const ok=v=>v.startsWith('(ok');
const deploy=(repoName,path)=>{const j=juiceSource(repoName,path,sourceHashes);
 builder.addContractDeploy({contract_name:j.name,source_code:j.source,clarity_version:ClarityVersion.Clarity6});
 plan.push({label:`deploy ${j.name} (repo source)`,kind:'deploy'});};
const call=(label,id,fn,args,want,sender=DEP)=>{builder.addContractCall({contract_id:id,function_name:fn,function_args:withVaultArgument(pid,vid,id,fn,args,Cl),sender});plan.push({label,kind:'tx',want});return plan.length-1;};
const ev=(label,id,code,want)=>{builder.addEvalCode(id,code);plan.push({label,kind:'eval',want});return plan.length-1;};
const send=(label,who,ustx)=>{builder.withSender(STX_WHALE).addSTXTransfer({recipient:who,amount:ustx});plan.push({label,kind:'tx',want:'(ok true)'});builder.withSender(DEP);};
const vaultStx=label=>ev(label,vid,'(stx-get-balance current-contract)',v=>/^u\d+$/.test(v));

const trait=traitSource(sourceHashes);
builder.addContractDeploy({contract_name:trait.name,source_code:trait.source,clarity_version:ClarityVersion.Clarity6});
plan.push({label:`deploy ${trait.name} (repo source, new trait)`,kind:'deploy'});
deploy('juice-sbtc-autoswap',resolve(here,'../contracts/pox-5/juice-sbtc-autoswap.clar'));
deploy('juice-pool-sbtc-signer',resolve(here,'../contracts/pox-5/juice-pool-sbtc-signer.clar'));
ev('vault config starts with pyth-fee-budget u0',vid,'(get-config)',v=>v.includes('(pyth-fee-budget u0)'));
call('outsider cannot set the budget on the vault',vid,'set-pyth-fee-budget',[Cl.uint(BUDGET)],'(err u16000)',STRANGER);
call('non-admin cannot set the budget through the pool',pid,'set-vault-pyth-fee-budget',[Cl.uint(BUDGET)],'(err u100)',STRANGER);
call('budget above 10 STX refused',pid,'set-vault-pyth-fee-budget',[Cl.uint(10000001)],'(err u16033)');
// PoX reward fixture, same as the lifecycle harness
call('fund real PoX sBTC balance (fork only)',SBTC,'transfer',[Cl.uint(FUND),Cl.principal(SBTC_WHALE),Cl.principal(POX),Cl.none()],'(ok true)',SBTC_WHALE);
const key=`{ reward-cycle: u${cycle}, bond-index: none, signer: '${pid} }`;
ev('fixture: crystallized PoX rewards and 1:3 shares',POX,`(begin
 (map-set signer-shares-staked-for-cycle ${key} u4)
 (map-set signer-pending-staked-ustx-per-cycle { signer: '${pid}, cycle: u${cycle} } u4)
 (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${cycle} none))
 (map-set signer-unclaimed-rewards-for-cycle ${key} u${FUND})
 (map-set staker-shares-staked-for-cycle { reward-cycle: u${cycle}, bond-index: none, signer: '${pid}, staker: '${ALICE} } u1)
 (map-set staker-shares-staked-for-cycle { reward-cycle: u${cycle}, bond-index: none, signer: '${pid}, staker: '${BOB} } u3)
 (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${FUND}))
 (try! (contract-call? '${pid} validate-stake! '${ALICE} u${cycle} u1 u1 u0 false none))
 (try! (contract-call? '${pid} validate-stake! '${BOB} u${cycle} u1 u3 u0 false none))
 (ok true))`,'(ok true)');
call('real PoX claim flows to vault',pid,'pox-claim-rewards',[Cl.list([]),Cl.uint(cycle)],v=>ok(v)&&v.includes(`(total-rewards u${FUND})`),STRANGER);
ev('fixture: patience clock elapsed',vid,'(begin (var-set batch-start (some (- burn-block-height u288))) true)','true');
const mid=proof.px*100000000n/proof.py;
const bid=BigInt(FUND)*mid/10000000000n*150n/100n;
call('real STX maker bid so the router fills on Jing',MKT,'deposit-token-y',[Cl.uint(bid),Cl.uint(mid*105n/100n),Cl.some(Cl.uint(0)),
 Cl.contractPrincipal(...WSTX.split('.')),Cl.stringAscii('wstx')],`(ok u${bid})`,STX_WHALE);
ev('fixture: live oracle fee set to u10 (Eval in oracle context)',ORACLE,`(begin (var-set fee u${FEE}) (get-fee))`,`u${FEE}`);
send('caller holds STX for its own refresh-mid fee',STRANGER,1000000);
send(`vault STX float ${FLOAT} uSTX`,vid,FLOAT);
call('budget 0: router-swap aborts on the with-stx allowance',vid,'router-swap',[update],'(err u1)',STRANGER);
ev('nothing sold under budget 0',vid,`(contract-call? '${SBTC} get-balance current-contract)`,`(ok u${FUND})`);
call(`set budget u${SHORT} (${VERIFIES} x fee - 1)`,pid,'set-vault-pyth-fee-budget',[Cl.uint(SHORT)],'(ok true)');
call(`budget ${VERIFIES} x fee - 1 aborts too: a Jing fill verifies ${VERIFIES}x`,vid,'router-swap',[update],'(err u1)',STRANGER);
ev(`nothing sold under budget u${SHORT}`,vid,`(contract-call? '${SBTC} get-balance current-contract)`,`(ok u${FUND})`);
call(`admin sets budget u${BUDGET} through the pool`,pid,'set-vault-pyth-fee-budget',[Cl.uint(BUDGET)],'(ok true)');
ev(`config reads pyth-fee-budget u${BUDGET}`,vid,'(get-config)',v=>v.includes(`(pyth-fee-budget u${BUDGET})`));
const before=vaultStx('vault STX before the sale');
const recipient=ev('oracle fee recipient',ORACLE,'(get-fee-recipient)',v=>/^S[PM]/.test(v));
const sale=call('router-swap sells the whole batch with the budget set',vid,'router-swap',[update],v=>ok(v)&&v.includes(`(amount u${FUND})`)&&v.includes('(unsold u0)'),STRANGER);
const after=vaultStx('vault STX after the sale');
ev('vault sold out',vid,'(is-empty)','true');
const fin=call('finalize attributes the STX to the pool',pid,'finalize-swap',[],v=>/^\(ok u[1-9]\d*\)$/.test(v),STRANGER);

console.log(`pyth-fee: ${plan.length} checks at mainnet block ${forkBlock}`);
const id=await builder.run();console.log(`View: https://stxer.xyz/simulations/mainnet/${id}`);
const result=await getSimulationResult(id,{stxerApi:API});
const checks=plan.map((p,i)=>{
 const step=result.steps[i]?.Result;let actual;
 if(p.kind==='eval')actual=step?.Eval?.Ok!==undefined?cvToString(deserializeCV(step.Eval.Ok)):`ENGINE ${JSON.stringify(step)}`;
 else actual=step?.Transaction?.Ok&&!step.Transaction.Ok.vm_error?cvToString(deserializeCV(step.Transaction.Ok.result)):`ENGINE ${JSON.stringify(step).slice(0,300)}`;
 const passed=p.kind==='deploy'?actual.startsWith('(ok'):typeof p.want==='function'?p.want(actual):actual===p.want;
 console.log(`${passed?'PASS':'FAIL'} ${p.label}: ${actual.slice(0,240)}`);return {label:p.label,passed,actual};
});
const uint=s=>BigInt(s.match(/u(\d+)/)?.[1]??'-1');
if(checks[sale].passed){
 const out=uint(checks[sale].actual.match(/\(out u\d+\)/)[0]);
 const delta=uint(checks[after].actual)-uint(checks[before].actual);
 const feeTo=checks[recipient].actual;
 const transfers=(result.steps[sale]?.Result?.Transaction?.Ok?.events??[]).map(e=>typeof e==='string'?JSON.parse(e):e).map(e=>e.stx_transfer_event).filter(Boolean);
 const vaultFees=transfers.filter(t=>t.sender===vid&&t.recipient===feeTo).map(t=>BigInt(t.amount));
 const callerFees=transfers.filter(t=>t.sender===STRANGER&&t.recipient===feeTo).map(t=>BigInt(t.amount));
 checks.push({label:`vault paid exactly ${VERIFIES} x ${FEE} uSTX to the fee recipient`,passed:vaultFees.length===VERIFIES&&vaultFees.every(a=>a===BigInt(FEE)),actual:`vault fees [${vaultFees}] to ${feeTo}`});
 checks.push({label:`caller paid its own refresh-mid fee (1 x ${FEE})`,passed:callerFees.length===1&&callerFees[0]===BigInt(FEE),actual:`caller fees [${callerFees}]`});
 checks.push({label:'router out is net of the vault fees (vault STX delta = out)',passed:delta===out,actual:`delta ${delta}, out ${out}`});
 checks.push({label:'finalize passes the whole STX balance (float + out)',passed:uint(checks[fin].actual)===BigInt(FLOAT)+out,actual:`${checks[fin].actual} vs ${BigInt(FLOAT)+out}`});
 let routing;
 for(const raw of result.steps[sale]?.Result?.Transaction?.Ok?.events??[]){
  const e=typeof raw==='string'?JSON.parse(raw):raw;
  if(!e.committed||e.contract_event?.contract_identifier!==ROUTER)continue;
  const t=deserializeCV(e.contract_event.raw_value).value;if(t?.topic?.value==='smart-swap-sbtc-for-stx')routing=t;
 }
 checks.push({label:'the sale went through the Jing leg (market verified inside the vault)',passed:routing?.['jing-in']?.value>0n,actual:routing?`jing-in ${routing['jing-in'].value}`:'router print missing'});
}
for(const c of checks.slice(plan.length))console.log(`${c.passed?'PASS':'FAIL'} ${c.label}: ${c.actual}`);
const dir=resolve(here,'results/pool-vault-stx');mkdirSync(dir,{recursive:true});
writeFileSync(resolve(dir,'juice-pyth-fee.json'),JSON.stringify({id,url:`https://stxer.xyz/simulations/mainnet/${id}`,block:forkBlock,proofTimestamp:proof.ts,verifiesPerFill:VERIFIES,sourceHashes,
 fixtures:['live oracle fee var-set to u10 by Eval','PoX earned rewards and 1:3 shares seeded with Eval','vault clock aged by 288 blocks'],checks},null,2));
const failed=checks.filter(c=>!c.passed).length;
console.log(`=== juice-pyth-fee: ${checks.length-failed}/${checks.length} passed ===`);
if(failed)process.exit(1);
