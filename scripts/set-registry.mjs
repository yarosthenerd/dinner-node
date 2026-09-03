/**
 * Point everything at a newly deployed DinnerNode registry.
 *
 * The address lives in more places than anyone remembers, and a redeploy that
 * updates four of them leaves the node registering on one contract while the
 * browser opens jobs on another, which fails as "job not found" rather than as
 * anything that names the real cause.
 *
 *   node scripts/set-registry.mjs 0xNEW              dry run, prints the diff
 *   node scripts/set-registry.mjs 0xNEW --write      writes the files
 *
 * Test fixtures are deliberately NOT touched. The address in attest.test.ts
 * and reassign-auth.test.ts is a frozen vector: the assertions are about the
 * digest built from it, not about which contract is live, and rewriting it
 * would change what those tests prove.
 */
import fs from 'node:fs';

const next = process.argv[2];
const write = process.argv.includes('--write');
if (!next || !/^0x[0-9a-fA-F]{40}$/.test(next)) {
  console.error('usage: node scripts/set-registry.mjs 0x<40 hex> [--write]');
  process.exit(1);
}

// Everything that carries a live registry address, and nothing that carries a
// historical one. V1_ADDR stays: it is what to point at to withdraw value left
// in the old instance, which is the opposite of stale.
const files = [
  '.env',
  '.env.node2',
  '.env.example',
  'src/chain.ts',
  'web/src/config.ts',
  'scripts/migrate-e2e.mjs',
  'scripts/plan-e2e.mjs',
  'scripts/plan-ui-check.ts',
  'scripts/deploy-ratings.mjs',
];

// The address being replaced is read from .env rather than hardcoded, so this
// script keeps working across successive redeploys.
const envText = fs.readFileSync('.env', 'utf8');
const current = envText.match(/^DINNER_NODE_ADDRESS=(0x[0-9a-fA-F]{40})/m)?.[1];
if (!current) { console.error('could not read DINNER_NODE_ADDRESS from .env'); process.exit(1); }
if (current.toLowerCase() === next.toLowerCase()) {
  console.log(`.env already names ${next}. Nothing to do.`);
  process.exit(0);
}

console.log(`${current}\n  ->  ${next}\n`);
const re = new RegExp(current, 'gi');
let total = 0;
const misses = [];

for (const f of files) {
  if (!fs.existsSync(f)) { misses.push(`${f} (missing)`); continue; }
  const before = fs.readFileSync(f, 'utf8');
  const hits = (before.match(re) ?? []).length;
  if (!hits) { misses.push(`${f} (0 hits)`); continue; }
  total += hits;
  console.log(`  ${String(hits).padStart(2)}x  ${f}`);
  if (write) fs.writeFileSync(f, before.replace(re, next));
}

for (const m of misses) console.log(`  MISS  ${m}`);
console.log(`\n${total} replacement(s) in ${files.length - misses.length} file(s).`);

if (!write) { console.log('dry run. re-run with --write.'); process.exit(0); }

console.log(`
written. next, in this order:

  1. restart the nodes so they re-register on the new contract
       systemctl --user restart dinnernode.service dinnernode2.service
  2. confirm both registered against the NEW address
       curl -s https://discovery.dinnernode.xyz/providers | head -c 400
  3. run the live suite against it
       DINNER_NODE_V2=${next} node scripts/v2-live.mjs
  4. only then deploy web/, which is what points guests at it
`);
