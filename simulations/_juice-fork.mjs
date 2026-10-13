// Juice fork setup at the current mainnet tip.
// The vault and pool deploy under their production names (free on mainnet), so
// the map below is the identity and the fork deploys the repo file byte for byte.
// Kept as a map so a taken name can be redirected again: then only the two
// contract names and their references are rewritten, in memory, and mapping the
// names back must give the repo file byte for byte.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
export const JUICE_RENAMES={'juice-sbtc-autoswap':'juice-sbtc-autoswap','juice-pool-sbtc-signer':'juice-pool-sbtc-signer'};
export const VAULT_NAME=JUICE_RENAMES['juice-sbtc-autoswap'],POOL_NAME=JUICE_RENAMES['juice-pool-sbtc-signer'];
export const VAULT_ID=`${DEP}.${VAULT_NAME}`,POOL_ID=`${DEP}.${POOL_NAME}`;
const sha=s=>createHash('sha256').update(s).digest('hex');
// `.name` covers both the short form and the fully qualified 'DEP.name form;
// the lookahead keeps longer names (e.g. juice-swap-vault-trait) untouched.
const swap=(src,map)=>src.replace(new RegExp(`\\.(${Object.keys(map).join('|')})(?![A-Za-z0-9_-])`,'g'),(_,n)=>'.'+map[n]);
const inverse=Object.fromEntries(Object.entries(JUICE_RENAMES).map(([a,b])=>[b,a]));
export function renameJuice(source){
 if(Object.entries(JUICE_RENAMES).every(([a,b])=>a===b))return source;
 for(const n of Object.values(JUICE_RENAMES))if(source.includes(n))throw new Error(`source already contains ${n}`);
 const out=swap(source,JUICE_RENAMES),back=swap(out,inverse);
 if(back!==source||sha(back)!==sha(source))throw new Error('renamed source does not map back to the repo file');
 return out;
}
// Reads a repo contract, returns the renamed source to deploy under `name` and
// records both hashes: sourceHashes[repo name] (repo file) and sourceHashes[name] (deployed).
export function juiceSource(repoName,path,sourceHashes={}){
 const source=readFileSync(path,'utf8'),name=JUICE_RENAMES[repoName];
 if(!name)throw new Error(`no fork name for ${repoName}`);
 const deployed=renameJuice(source);
 sourceHashes[repoName]=sha(source);sourceHashes[name]=sha(deployed);
 return {name,source:deployed,repoSha256:sha(source),deployedSha256:sha(deployed)};
}
// juice-swap-vault-trait-v2 is new (v1 is on mainnet and can not gain
// set-pyth-fee-budget), so every fork deploys it from the repo file, as DEP,
// before the vault and the pool.
export const TRAIT_NAME='juice-swap-vault-trait-v2',TRAIT_ID=`${DEP}.${TRAIT_NAME}`;
export function traitSource(sourceHashes={}){
 const source=readFileSync(new URL(`../contracts/pox-5/${TRAIT_NAME}.clar`,import.meta.url),'utf8');
 sourceHashes[TRAIT_NAME]=sha(source);
 return {name:TRAIT_NAME,source,sha256:sha(source)};
}
// One fork height for a whole rerun set: JUICE_FORK_BLOCK, else the newest
// block at least JUICE_FORK_LAG_SECS (default 600) old. The lag keeps a freshly
// fetched Lazer update inside the market's 80 s staleness limit after the sims
// advance ~150 burn blocks (each moves block time 1 s forward).
export async function juiceForkBlock(node){
 if(process.env.JUICE_FORK_BLOCK)return Number(process.env.JUICE_FORK_BLOCK);
 const get=async(path)=>{const r=await fetch(`${node}${path}`,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`${path} HTTP ${r.status}`);return r.json();};
 const tip=(await get('/extended/v1/block?limit=1')).results[0];
 const target=Math.floor(Date.now()/1000)-Number(process.env.JUICE_FORK_LAG_SECS??600);
 if(tip.burn_block_time<=target)return tip.height;
 let lo=tip.height-5000,hi=tip.height;
 while(hi-lo>1){const mid=Math.floor((lo+hi)/2);((await get(`/extended/v2/blocks/${mid}`)).block_time<=target)?lo=mid:hi=mid;}
 return lo;
}
