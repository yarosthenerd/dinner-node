// End to end plan-as-a-job against a live node.
//
// Opens a real job from the guest wallet, asks the node for a plan, runs it,
// and reports what the chain says was paid. Nothing here is mocked: this is
// the only way to find out whether planning is fast enough to be usable, which
// is the open question SNAPSHOT raised and no unit test can answer.
//
//   node scripts/plan-e2e.mjs "<goal>" [--host http://localhost:4173] [--budget 1.5]
import 'dotenv/config';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseEther, parseEventLogs, stringToHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';

const chain = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});
const ADDR = process.env.DINNER_NODE_ADDRESS || '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c';
const ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'deposits', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'openJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'string' }, { type: 'bool' }], outputs: [{ type: 'uint256' }] },
  { name: 'closeJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'getJob', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: [{ name: 'requester', type: 'address' }, { name: 'provider', type: 'address' }, { name: 'escrow', type: 'uint256' }, { name: 'paid', type: 'uint256' }, { name: 'tokens', type: 'uint256' }, { name: 'ratePerMillion', type: 'uint256' }, { name: 'maxTokensPerSecond', type: 'uint256' }, { name: 'openedAt', type: 'uint64' }, { name: 'lastSettleAt', type: 'uint64' }, { name: 'open', type: 'bool' }, { name: 'requireCheckpoints', type: 'bool' }] }] },
  { name: 'JobOpened', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'requester', type: 'address', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'promptTag', type: 'string' }] },
];
const MAX_FEE = 2000000000000n;

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : dflt; };
const goal = process.argv[2]?.startsWith('--') ? 'Compare the running cost of a home GPU against a cloud GPU for LLM inference, and say which is cheaper and when.' : (process.argv[2] ?? 'Compare the running cost of a home GPU against a cloud GPU for LLM inference.');
const HOST = arg('--host', 'http://localhost:4173');
const BUDGET = parseEther(arg('--budget', '1.5'));

const pub = createPublicClient({ chain, transport: http() });
const key = process.env.GUEST_PK.startsWith('0x') ? process.env.GUEST_PK : '0x' + process.env.GUEST_PK;
const account = privateKeyToAccount(key);
const w = createWalletClient({ account, chain, transport: http() });

/// Consume an SSE body, handing each parsed frame to `onFrame`. Returns when
/// the stream ends or [DONE] arrives.
async function sse(url, body, onFrame) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') return;
      try { onFrame(JSON.parse(payload)); } catch {}
    }
  }
}

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const health = await (await fetch(HOST + '/health')).json();
console.log(`node ${health.model} via ${health.engine}, provider ${health.provider}`);
console.log(`rate ${health.ratePerMillion} wei/M ($${health.pricing?.usdPerMillion}/M, ${health.pricing?.source})`);
if (!health.plans?.supported) { console.error('this node does not advertise plan support'); process.exit(1); }

// Top up only the shortfall. closeJob returns a job's unspent escrow to
// deposits[guest] rather than to the wallet, so a second run needs far less
// than the budget and asking for the whole thing reverts on a guest whose
// balance is already sitting on the contract.
const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [account.address] });
if (dep < BUDGET) {
  const short = BUDGET - dep;
  const bal = await pub.getBalance({ address: account.address });
  console.log(`[${el()}] deposit ${formatEther(dep)}, need ${formatEther(BUDGET)}, topping up ${formatEther(short)} (wallet ${formatEther(bal)})`);
  if (bal < short) { console.error(`guest wallet holds ${formatEther(bal)} MON and needs ${formatEther(short)} plus gas`); process.exit(1); }
  const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: short, gas: 200000n, maxFeePerGas: MAX_FEE });
  await pub.waitForTransactionReceipt({ hash: h });
}

const salt = toHex(randomBytes(32));
const tag = keccak256(stringToHex(salt + '|' + goal));
console.log(`[${el()}] opening job…`);
const oh = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [health.provider, BUDGET, tag, false], gas: 300000n, maxFeePerGas: MAX_FEE });
const rc = await pub.waitForTransactionReceipt({ hash: oh });
const jobId = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' })[0].args.jobId;
console.log(`[${el()}] job#${jobId} open with ${formatEther(BUDGET)} MON`);

// ---- plan ---------------------------------------------------------------
console.log(`[${el()}] planning: "${goal}"`);
let plan = null, planErr = null, planTok = 0, thoughtTok = 0;
const tPlan = Date.now();
await sse(HOST + '/plan', { jobId: String(jobId), goal }, f => {
  if (f.t !== undefined) { planTok++; process.stdout.write('.'); }
  else if (f.th !== undefined) { thoughtTok++; if (thoughtTok % 50 === 0) process.stdout.write('~'); }
  else if (f.plan) plan = f;
  else if (f.err) planErr = f;
});
process.stdout.write('\n');
const planSecs = ((Date.now() - tPlan) / 1000).toFixed(1);
if (!plan) { console.error(`[${el()}] planning failed after ${planSecs}s:`, JSON.stringify(planErr)); process.exit(1); }
console.log(`[${el()}] plan in ${planSecs}s (${thoughtTok} reasoning + ${planTok} visible tokens billed, ${plan.attempts} attempt(s))`);
console.log(`  ${plan.summary}`);
console.log(`  hash ${plan.planHash}`);
for (const s of plan.plan.steps) console.log(`  ${s.id.padEnd(28)} ${String(s.maxTokens).padStart(5)} tok  deps=[${s.dependsOn.join(', ')}]`);

// ---- run ----------------------------------------------------------------
console.log(`[${el()}] running the plan…`);
const tRun = Date.now();
const perStep = new Map();
let waves = 0, failures = [];
await sse(HOST + '/plan/run', { jobId: String(jobId), plan: plan.plan }, f => {
  if (f.kind === 'wave') { waves++; console.log(`  wave ${f.n}: ${f.steps.join(', ')}`); }
  else if (f.kind === 'step_start') console.log(`    ${f.id} start (prompt ${f.promptTokens} tok, ceiling ${f.maxTokens})`);
  else if (f.kind === 'token' || f.kind === 'thought') perStep.set(f.id, (perStep.get(f.id) ?? 0) + 1);
  else if (f.kind === 'step_done') console.log(`    ${f.id} done: ${f.tokens} billed, ${f.visible} visible${f.truncated ? ', TRUNCATED at ceiling' : ''}`);
  else if (f.kind === 'step_failed') { failures.push(f); console.log(`    ${f.id} FAILED ${f.code}: ${f.message}`); }
  else if (f.kind === 'plan_done') console.log(`  plan_done ok=${f.ok} completed=${f.completed.length} failed=${f.failed.length} billed=${f.tokens}`);
});
console.log(`[${el()}] run finished in ${((Date.now() - tRun) / 1000).toFixed(1)}s, ${waves} wave(s)`);

// ---- what the chain says ------------------------------------------------
await new Promise(r => setTimeout(r, 8000)); // let the final settle land
const j = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [jobId] });
console.log(`\njob#${jobId} on chain: escrow ${formatEther(j.escrow)} paid ${formatEther(j.paid)} tokens ${j.tokens} open=${j.open}`);
if (j.open) {
  console.log('closing to recover the remainder…');
  const ch = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [jobId], gas: 200000n, maxFeePerGas: MAX_FEE });
  await pub.waitForTransactionReceipt({ hash: ch });
  const j2 = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [jobId] });
  console.log(`closed: paid ${formatEther(j2.paid)} for ${j2.tokens} tokens`);
}
console.log(failures.length ? `\nFAILURES: ${failures.map(f => f.id + '/' + f.code).join(', ')}` : '\nno step failures');
