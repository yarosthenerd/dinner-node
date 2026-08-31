/**
 * Close the v1 jobs that are still open, and put their unspent escrow back.
 *
 * `drain-v1.mjs` deliberately leaves jobs alone, on the grounds that each
 * node's idle timer closes its own and closing from outside would race it.
 * That reasoning has expired: nothing points at v1 any more, so no idle timer
 * will ever fire for these, and `refund()` cannot return escrow that is still
 * locked inside an open job. About 0.55 MON sits behind that, of which job#63
 * holds 0.30 and names the house key as its provider.
 *
 * v1's `closeJob` admits the requester OR the provider, so a job is closeable
 * if any key you hold is either. It moves the unspent escrow to the
 * REQUESTER's deposit, not to the caller: closing a job whose requester is a
 * lost burner wallet costs you gas and recovers nothing for you. This script
 * says which case each job is before it does anything.
 *
 * Read-only unless --send. Run it, read the table, then run it again.
 *
 *   node scripts/close-v1-jobs.mjs
 *   node scripts/close-v1-jobs.mjs --send
 *   env $(grep PROVIDER_PK .env.node2) node scripts/close-v1-jobs.mjs
 *
 * Keys, all optional: PROVIDER_PK, GUEST_PK, HOUSE_PK.
 */
import 'dotenv/config';
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// v1, hardcoded for the same reason drain-v1.mjs hardcodes it: reading
// DINNER_NODE_ADDRESS would point this at v2, where these jobs do not exist.
const V1 = '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92';
const EXPLORER = 'https://testnet.monadvision.com';
const MAX_FEE = 2000000000000n;

const chain = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz'] } },
});
const ABI = [
  { name: 'jobCounter', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // v1's positional Job: requester, provider, escrow, paid, tokens, open.
  {
    name: 'jobs', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
  },
  { name: 'closeJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'deposits', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const pub = createPublicClient({ chain, transport: http() });
const send = process.argv.includes('--send');
// Closing a job you cannot benefit from costs gas and recovers nothing,
// because v1 credits the refund to the REQUESTER. So --send closes only the
// jobs whose escrow comes back to a deposit you hold, and --all is the
// explicit way to spend gas tidying up someone else's.
const all = process.argv.includes('--all');

const wallets = new Map();
for (const [label, pk] of [['node', process.env.PROVIDER_PK], ['guest', process.env.GUEST_PK], ['house', process.env.HOUSE_PK]]) {
  if (!pk) continue;
  const account = privateKeyToAccount(pk);
  wallets.set(account.address.toLowerCase(), { label, account, client: createWalletClient({ account, chain, transport: http() }) });
}
if (!wallets.size) {
  console.log('no keys in the environment. Set PROVIDER_PK, GUEST_PK or HOUSE_PK and run again.');
  process.exit(1);
}
console.log(`keys held: ${[...wallets.values()].map(w => `${w.label} ${w.account.address}`).join('\n           ')}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Enough to stay under the public endpoint's limit on a 93 job scan, small
// enough that the scan is still under a minute.
const THROTTLE_MS = Number(process.env.THROTTLE_MS ?? 120);

// Retried like every other read. The public RPC refuses often enough that a
// single attempt here means the script dies before it has read one job.
let count = null;
for (let attempt = 0; attempt < 5 && count === null; attempt++) {
  try {
    count = await pub.readContract({ address: V1, abi: ABI, functionName: 'jobCounter' });
  } catch (e) {
    if (attempt === 4) { console.log(`could not read jobCounter: ${e.shortMessage ?? e.message}`); process.exit(1); }
    await sleep(1000 * (attempt + 1));
  }
}
console.log(`v1 has ${count} jobs. Reading them one at a time, because the public RPC caps eth_getLogs at 100 blocks.\n`);

const unread = [];
let openCount = 0;
let lockedTotal = 0n;
let recoverable = 0n;
const closeable = [];

for (let id = 1n; id <= count; id++) {
  // The public RPC rate-limits a tight read loop, and a first pass over 93
  // jobs lost 15 of them to "RPC Request failed". A job silently missing from
  // this table is the one failure that matters here, because the table is what
  // decides whether the escrow is written off, so every read is retried with
  // backoff and a job that still will not read is reported as unknown rather
  // than skipped.
  let j = null;
  for (let attempt = 0; attempt < 4 && !j; attempt++) {
    try {
      j = await pub.readContract({ address: V1, abi: ABI, functionName: 'jobs', args: [id] });
    } catch (e) {
      if (attempt === 3) { unread.push(id); console.log(`job#${String(id).padStart(3)}  UNREAD after 4 attempts: ${e.shortMessage ?? e.message}`); }
      else await sleep(400 * (attempt + 1));
    }
  }
  if (!j) continue;
  await sleep(THROTTLE_MS);
  const [requester, provider, escrow, paid, tokens, open] = j;
  if (!open) continue;
  openCount++;
  const stuck = escrow - paid;
  lockedTotal += stuck;

  // closeJob admits either party. Being able to close is not the same as
  // getting the money: the refund goes to the requester's deposit.
  const asProvider = wallets.get(provider.toLowerCase());
  const asRequester = wallets.get(requester.toLowerCase());
  const by = asRequester ?? asProvider;
  const mineAfter = !!asRequester;
  if (mineAfter) recoverable += stuck;

  const who = by ? `closeable as ${by.label}` : 'no key for either party';
  const dest = mineAfter ? 'to a deposit you hold' : `to ${requester.slice(0, 10)}…, which you do not hold`;
  console.log(`job#${String(id).padStart(3)}  ${formatEther(stuck).padStart(8)} MON locked  ${tokens} tok served  ${who}, ${dest}`);
  if (by) closeable.push({ id, by, stuck, mineAfter });
}

console.log(`\n${openCount} open jobs, ${formatEther(lockedTotal)} MON locked in escrow.`);
if (unread.length) console.log(`${unread.length} jobs could not be read at all: ${unread.join(', ')}. Re-run before concluding anything about them.`);
console.log(`${closeable.length} closeable with the keys you hold, of which ${formatEther(recoverable)} MON lands in a deposit you can refund().`);
if (!closeable.length) process.exit(0);

if (!send) {
  console.log('\nRead-only. Re-run with --send to close them, then run drain-v1.mjs to pull the deposits out.');
  process.exit(0);
}

const toClose = all ? closeable : closeable.filter(c => c.mineAfter);
if (!toClose.length) {
  console.log(`\nNothing to close that returns anything to you. ${closeable.length} are closeable but refund a wallet you do not hold; --all closes those too, at your gas.`);
  process.exit(0);
}
if (toClose.length < closeable.length) {
  console.log(`\nClosing ${toClose.length} of ${closeable.length}. The rest refund wallets you do not hold; add --all to close those as well.`);
}

for (const c of toClose) {
  try {
    // Estimated rather than padded: Monad charges the limit, and closeJob on a
    // job with nothing to refund is a very different price from one with 0.30
    // MON to move.
    const gas = await pub.estimateContractGas({ address: V1, abi: ABI, functionName: 'closeJob', args: [c.id], account: c.by.account })
      .then(g => (g * 120n) / 100n)
      .catch(() => 120000n);
    const hash = await c.by.client.writeContract({ address: V1, abi: ABI, functionName: 'closeJob', args: [c.id], gas, maxFeePerGas: MAX_FEE });
    const rc = await pub.waitForTransactionReceipt({ hash });
    // A revert reported as a close is how value goes missing quietly.
    console.log(rc.status === 'success'
      ? `job#${c.id} closed, ${formatEther(c.stuck)} MON released  ${EXPLORER}/tx/${hash}`
      : `job#${c.id} REVERTED  ${EXPLORER}/tx/${hash}`);
  } catch (e) {
    console.log(`job#${c.id} failed: ${e.shortMessage ?? e.message}`);
  }
}

console.log('\nNow run: node scripts/drain-v1.mjs      (and again with --send)');
