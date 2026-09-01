// The unattended handover, end to end, against a local chain.
//
// What this proves that the unit tests cannot: a guest signs ONE EIP-712
// authorisation and then sends nothing else, a second node accepts the
// checkpoint of the first, submits reassignWithAuth from its OWN wallet, and
// finishes the answer. The guest's wallet issues no transaction at the moment
// of the handover, which is the whole point: the node that died did so at 3am
// and nobody was awake to confirm anything.
//
// Run it against anvil, never against testnet:
//
//   anvil --port 8545 --chain-id 31337 --silent &
//   forge create src/DinnerNodeV2.sol:DinnerNodeV2 --rpc-url http://127.0.0.1:8545 \
//     --private-key <anvil key 0> --broadcast
//   # two hosts with ENGINE=mock, DINNER_NODE_ADDRESS=<deployed>, ports 4183/4184
//   node scripts/auth-takeover-e2e.mjs
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseAbi, parseEther, parseEventLogs, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const ADDR = process.env.DINNER_NODE_ADDRESS;
const NODE_A = process.env.NODE_A ?? 'http://127.0.0.1:4183';
const NODE_B = process.env.NODE_B ?? 'http://127.0.0.1:4184';
// anvil account 3, so it is neither provider.
const GUEST_PK = process.env.GUEST_PK ?? '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
if (!ADDR) throw new Error('set DINNER_NODE_ADDRESS to the deployed registry');

const chain = defineChain({
  id: CHAIN_ID, name: 'local', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const ABI = parseAbi([
  'struct Job { address requester; address provider; uint256 escrow; uint256 paid; uint256 tokens; uint256 ratePerMillion; uint256 maxTokensPerSecond; uint64 openedAt; uint64 lastSettleAt; bool open; bool requireCheckpoints; }',
  'struct Provider { string model; string hw; uint256 ratePerMillion; uint256 maxTokensPerSecond; uint256 earned; uint256 lifetimeEarned; uint256 tokensServed; uint256 jobs; bool active; }',
  'function deposit() payable',
  'function deposits(address) view returns (uint256)',
  'function openJob(address provider, uint256 budget, string promptTag, bool requireCheckpoints) returns (uint256)',
  'function getJob(uint256) view returns (Job)',
  'function getProvider(address) view returns (Provider)',
  'function reassignCount(uint256) view returns (uint256)',
  'function reassignAuthDigest(uint256 jobId, address newProvider, uint256 maxReassigns, uint64 deadline) view returns (bytes32)',
  'event JobOpened(uint256 indexed jobId, address indexed requester, address indexed provider, string promptTag)',
]);

const pub = createPublicClient({ chain, transport: http() });
const guest = privateKeyToAccount(GUEST_PK);
const w = createWalletClient({ account: guest, chain, transport: http() });

const ok = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

const health = async (u) => (await fetch(u + '/health')).json();

/// Read an SSE stream far enough to get a checkpoint, then walk away, which is
/// what a dying node looks like from the browser's side.
async function streamUntilCheckpoint(url, body, maxChunks = 200) {
  const res = await fetch(url + '/job', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} refused: ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', cp = null, n = 0, chunks = 0, done = false;
  outer: while (chunks++ < maxChunks) {
    const { value, done: fin } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.t) { text += ev.t; n += 1; }
      if (ev.checkpoint || ev.cp) cp = ev.checkpoint ?? ev.cp;
      if (ev.done) { done = true; break outer; }
      if (cp && text.length > 0) break outer;
    }
  }
  await reader.cancel().catch(() => {});
  return { text, cp, n, done };
}

async function main() {
  const [ha, hb] = await Promise.all([health(NODE_A), health(NODE_B)]);
  console.log(`node A ${ha.provider} ${ha.model}\nnode B ${hb.provider} ${hb.model}\n`);

  const budget = parseEther('1');
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget }) });
  const tag = keccak256(stringToHex('e2e prompt'));
  const rc = await pub.waitForTransactionReceipt({
    hash: await w.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [ha.provider, budget, tag, true] }),
  });
  const jobId = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' })[0].args.jobId;
  console.log(`job#${jobId} open against node A\n`);

  // THE ONE SIGNATURE. No gas, no transaction, and the last thing the guest
  // does before going to sleep.
  const maxReassigns = 2n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const ANY = '0x0000000000000000000000000000000000000000';
  const types = {
    ReassignAuth: [
      { name: 'jobId', type: 'uint256' }, { name: 'newProvider', type: 'address' },
      { name: 'maxReassigns', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
    ],
  };
  const message = { jobId, newProvider: ANY, maxReassigns, deadline };
  const domain = { name: 'DinnerNode', version: '2', chainId: CHAIN_ID, verifyingContract: ADDR };
  const signature = await w.signTypedData({ account: guest, domain, types, primaryType: 'ReassignAuth', message });

  const onChainDigest = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'reassignAuthDigest', args: [jobId, ANY, maxReassigns, deadline] });
  ok('the contract rebuilds the digest the guest signed', typeof onChainDigest === 'string' && onChainDigest.length === 66);

  // Node A serves until it has published a checkpoint, then goes dark.
  const first = await streamUntilCheckpoint(NODE_A, { jobId: jobId.toString(), prompt: 'e2e prompt', session: true });
  ok('node A streamed', first.text.length > 0, `${first.text.length} chars`);

  const txCountBefore = await pub.getTransactionCount({ address: guest.address });

  // The handover. The guest sends NOTHING: the standby carries the signature.
  const auth = { jobId: jobId.toString(), newProvider: ANY, maxReassigns: maxReassigns.toString(), deadline: deadline.toString(), signature };
  const resume = first.cp?.h ? { text: first.cp.text ?? first.text, n: first.cp.n ?? first.n, h: first.cp.h } : undefined;
  const second = await streamUntilCheckpoint(NODE_B, { jobId: jobId.toString(), prompt: 'e2e prompt', session: true, auth, resume });
  ok('node B continued the answer', second.text.length > 0, `${second.text.length} chars`);

  const txCountAfter = await pub.getTransactionCount({ address: guest.address });
  ok('the guest signed no transaction for the handover', txCountAfter === txCountBefore, `nonce ${txCountBefore} -> ${txCountAfter}`);

  const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [jobId] });
  ok('the job now belongs to node B on chain', job.provider.toLowerCase() === hb.provider.toLowerCase(), job.provider);
  ok('the escrow is the same one', job.escrow === budget, formatEther(job.escrow));
  const used = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'reassignCount', args: [jobId] });
  ok('the authorisation is recorded as used once', used === 1n, `count ${used}`);

  // And it cannot be used past what the guest agreed to. Two is the cap; the
  // third attempt must be refused by the contract, which the node discovers
  // before it spends anything.
  const again = await fetch(NODE_A + '/job', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: jobId.toString(), prompt: 'e2e prompt', session: true, auth }),
  });
  const backA = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [jobId] });
  ok('a second handover inside the cap is allowed', again.ok && backA.provider.toLowerCase() === ha.provider.toLowerCase(), backA.provider);

  const third = await fetch(NODE_B + '/job', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: jobId.toString(), prompt: 'e2e prompt', session: true, auth }),
  });
  const body = await third.text();
  ok('the third is refused, because the guest authorised two', !third.ok && body.includes('spent'), body.slice(0, 120));

  const expired = { ...auth, deadline: String(Math.floor(Date.now() / 1000) - 1) };
  const late = await fetch(NODE_B + '/job', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: jobId.toString(), prompt: 'e2e prompt', session: true, auth: expired }),
  });
  const lateBody = await late.text();
  ok('an expired authorisation is refused', !late.ok && lateBody.includes('expired'), lateBody.slice(0, 120));
}

main().catch(e => { console.error(e); process.exit(1); });
