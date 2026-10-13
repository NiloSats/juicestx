// Merge clarinet-sdk lcov records (one per test) and summarize the two Juice
// production contracts. Lines past the production source length are harness
// wrappers appended by tests/vault/build.py and are ignored.
// Usage: node tests/coverage-summary.mjs [lcov ...] [--uncovered]
import { readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const showUncovered = args.includes("--uncovered");
const files = args.filter(function (a) { return !a.startsWith("--"); });
if (files.length === 0) files.push(resolve(root, "lcov.info"));

const TARGETS = {
  "juice-pool-sbtc-signer": "contracts/pox-5/juice-pool-sbtc-signer.clar",
  "juice-sbtc-autoswap": "contracts/pox-5/juice-sbtc-autoswap.clar",
};

const merged = {};
for (const file of files) {
  let current = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("SF:")) {
      const name = basename(line.slice(3), ".clar");
      current = TARGETS[name] ? (merged[name] ??= { da: new Map(), br: new Map() }) : null;
    } else if (!current) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",").map(Number);
      current.da.set(ln, (current.da.get(ln) ?? 0) + hits);
    } else if (line.startsWith("BRDA:")) {
      const [ln, block, branch, hits] = line.slice(5).split(",");
      const key = `${ln},${block},${branch}`;
      const n = hits === "-" ? 0 : Number(hits);
      current.br.set(key, (current.br.get(key) ?? 0) + n);
    }
  }
}

for (const [name, path] of Object.entries(TARGETS)) {
  const src = readFileSync(resolve(root, path), "utf8").split("\n");
  const m = merged[name] ?? { da: new Map(), br: new Map() };
  const lines = [...m.da].filter(function ([ln]) { return ln <= src.length; });
  const branches = [...m.br].filter(function ([k]) { return Number(k.split(",")[0]) <= src.length; });
  const lh = lines.filter(function ([, h]) { return h > 0; }).length;
  const bh = branches.filter(function ([, h]) { return h > 0; }).length;
  console.log(`${name}: lines ${lh}/${lines.length}, branches ${bh}/${branches.length}`);
  if (!showUncovered) continue;
  for (const [ln, h] of lines.sort(function (a, b) { return a[0] - b[0]; })) {
    if (h === 0) console.log(`  L${ln}: ${src[ln - 1].trim()}`);
  }
  for (const [k, h] of branches.sort(function (a, b) { return Number(a[0].split(",")[0]) - Number(b[0].split(",")[0]); })) {
    if (h === 0) {
      const ln = Number(k.split(",")[0]);
      console.log(`  BR ${k}: ${src[ln - 1].trim()}`);
    }
  }
}
