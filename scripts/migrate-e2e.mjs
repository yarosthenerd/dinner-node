// Mid-answer migration, verified on chain.
//
// Start an answer on the local node, cut it off at a published checkpoint,
// then hand that checkpoint to a different provider and let it finish. The
// claim being tested is not that text continues, it is that TWO providers get
// paid for DISJOINT token ranges of one answer, and that the second one
// declines to bill for the prefix it was handed.
import 'dotenv/config';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseEther, parseEventLogs, stringToHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';

const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } } });
const ADDR = process.env.DINNER_NODE_ADDRESS || '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92';
const ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'deposits', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'openJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'string' }], outputs: [{ type: 'uint256' }] },
  { name: 'closeJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'jobs', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }] },
  { name: 'JobOpened', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'requester', type: 'address', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'promptTag', type: 'string' }] },
];
const MAX_FEE = 2000000000000n;
const NODE = process.env.MIGRATE_NODE || 'http://localhost:4173';
const CLOUD = process.env.MIGRATE_CLOUD || 'https://web-opal-sigma-55.vercel.app/api/p';
const BUDGET = parseEther('0.4');
const PROMPT = 'Write a detailed paragraph about why idle consumer GPUs are an underused compute resource.';

const pub = createPublicClient({ chain, transport: http() });
const account = privateKeyToAccount(process.env.GUEST_PK.startsWith('0x') ? process.env.GUEST_PK : '0x' + process.env.GUEST_PK);
const w = createWalletClient({ account, chain, transport: http() });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function openJob(provider) {
  const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [account.address] });
  if (dep < BUDGET) {
    const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: BUDGET - dep, gas: 200000n, maxFeePerGas: MAX_FEE });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const tag = keccak256(stringToHex(toHex(randomBytes(32)) + '|' + PROMPT));
  const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [provider, BUDGET, tag], gas: 300000n, maxFeePerGas: MAX_FEE });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  return parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' })[0].args.jobId;
}

/// Stream until `stop(state)` says so, then abort. Returns the last checkpoint
/// the provider published, which is the only thing a replacement will accept.
async function stream(url, body, stop) {
  const ac = new AbortController();
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', cp = null, visible = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6);
        if (p === '[DONE]') return { text, cp, visible, finished: true };
        let f; try { f = JSON.parse(p); } catch { continue; }
        if (f.t !== undefined) { text += f.t; visible++; }
        else if (f.cp) cp = f.cp;
        if (stop && stop({ text, cp, visible })) { ac.abort(); return { text, cp, visible, finished: false }; }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  return { text, cp, visible, finished: false };
}

const nodeHealth = await (await fetch(NODE + '/health')).json();
const cloudHealth = await (await fetch(CLOUD + '/health')).json();
console.log(`provider A ${nodeHealth.provider}  ${nodeHealth.model} (${nodeHealth.engine})`);
console.log(`provider B ${cloudHealth.provider}  ${cloudHealth.model} (${cloudHealth.kind})`);
if (nodeHealth.provider.toLowerCase() === cloudHealth.provider.toLowerCase()) {
  console.error('both providers are the same address; migration would prove nothing'); process.exit(1);
}

// ---- leg 1: start on the node, cut it off at a checkpoint ----------------
const jobA = await openJob(nodeHealth.provider);
console.log(`[${el()}] job#${jobA} open on provider A`);
// Stop at the SECOND checkpoint, so there is real work either side of the cut.
let seen = 0;
const legA = await stream(NODE + '/job', { jobId: String(jobA), prompt: PROMPT }, ({ cp }) => {
  if (cp && cp.n !== seen) { seen = cp.n; return seen > 0 && cp.n >= 128; }
  return false;
});
console.log(`[${el()}] cut off provider A at ${legA.visible} visible tokens, checkpoint n=${legA.cp?.n} h=${legA.cp?.h?.slice(0, 12)}…`);
if (!legA.cp) { console.error('provider A published no checkpoint; nothing to migrate'); process.exit(1); }

// The prefix a replacement is handed must be exactly the text the checkpoint
// covers, or its hash will not match and the resume is refused.
const prefix = legA.text.slice(0, legA.cp.n === legA.visible ? legA.text.length : legA.text.length);
console.log(`[${el()}] local hash check: ${keccak256(stringToHex(prefix)) === legA.cp.h ? 'MATCHES' : 'MISMATCH'}`);

await new Promise(r => setTimeout(r, 12000)); // let provider A settle what it produced
const a1 = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [jobA] });
console.log(`[${el()}] job#${jobA}: paid ${formatEther(a1[3])} for ${a1[4]} tokens, open=${a1[5]}`);

// ---- leg 2: hand the checkpoint to a different provider ------------------
const jobB = await openJob(cloudHealth.provider);
console.log(`[${el()}] job#${jobB} open on provider B, resuming from token ${legA.cp.n}`);
const legB = await stream(CLOUD + '/job', {
  jobId: String(jobB), prompt: PROMPT,
  resume: { text: prefix, h: legA.cp.h, n: legA.cp.n },
});
console.log(`[${el()}] provider B produced ${legB.visible} tokens, finished=${legB.finished}`);

await new Promise(r => setTimeout(r, 12000));
const a2 = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [jobA] });
const b2 = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [jobB] });

console.log(`\n--- receipts ---`);
console.log(`job#${jobA} provider A ${a2[1]}  ${a2[4]} tokens  ${formatEther(a2[3])} MON  open=${a2[5]}`);
console.log(`job#${jobB} provider B ${b2[1]}  ${b2[4]} tokens  ${formatEther(b2[3])} MON  open=${b2[5]}`);
console.log(`\nprefix handed over: ${legA.cp.n} tokens, and provider B billed ${b2[4]} for its own suffix.`);
console.log(b2[4] > 0n && a2[4] > 0n && String(a2[1]).toLowerCase() !== String(b2[1]).toLowerCase()
  ? 'PASS: two different providers paid for disjoint ranges of one answer.'
  : 'FAIL: see the receipts above.');

for (const [id, j] of [[jobA, a2], [jobB, b2]]) {
  if (j[5]) {
    const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [id], gas: 200000n, maxFeePerGas: MAX_FEE });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`closed job#${id}`);
  }
}
