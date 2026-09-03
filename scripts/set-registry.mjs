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
const force = process.argv.includes('--force');
if (!next || !/^0x[0-9a-fA-F]{40}$/.test(next)) {
  console.error('usage: node scripts/set-registry.mjs 0x<40 hex> [--write] [--force]');
  process.exit(1);
}

/**
 * Refuse an address that has no code on it.
 *
 * A well-formed address is not a registry. On 2026-09-03 this script was given
 * the DEPLOYER's own address, copied out of the deploy script's own first line
 * of output, because the deploy step had not been run yet and that was the only
 * 40-hex string on the screen. It wrote all nine files, both nodes restarted
 * and "registered" by sending a transaction to an account with no code, which
 * succeeds and does nothing, and the failure surfaced two steps later as
 * `deposits returned no data ("0x")`.
 *
 * Nothing about the shape of an address can catch that. The chain can, in one
 * call, so it is asked before anything is written.
 */
const RPC = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const codeAt = async (address) => {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`eth_getCode: ${j.error.message}`);
  return j.result ?? '0x';
};

const code = await codeAt(next).catch(e => { console.error(`could not check ${next}: ${e.message}`); process.exit(1); });
if (code === '0x') {
  console.error(`
  !  ${next} has NO CODE on ${RPC}.

     That is an account, not a registry. Every node pointed at it will send
     registrations to an address that cannot receive them, succeed, and serve
     guests against a contract that does not exist.

     If you have not deployed yet:   node scripts/deploy-v2.mjs --send
     and use the address it prints, not the deployer address in its first line.

     --force overrides this, for a deploy that has not landed yet.`);
  if (!force) process.exit(1);
  console.error('     --force given, continuing anyway.\n');
} else {
  console.log(`${next} has ${(code.length - 2) / 2} bytes of code`);
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
