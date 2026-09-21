// The capped-job demo: an agent loop against one job whose budget it cannot
// exceed, and the chain's record of where every wei went.
//
// This is the Option 1 artifact from TODO.md, week of 2026-09-21. The claim
// it shows is narrow on purpose: a job's escrow is the most it can ever pay,
// the node stops serving when the escrow is spent, and every payment is an
// on-chain settlement anyone can check. It does NOT show a budget per agent
// across many jobs, or a plan ceiling below the escrow; see
// .context/option1-claims.md for why the second one is left out.
//
//   node scripts/capped-job-demo.mjs [--host http://localhost:4173] [--budget 0.06] [--think off] [--out file.md]
//
// --think off asks the node to answer without reasoning, which is how an agent
// keeps a hard budget from being spent on text it never sees (D4 in
// .context/option1-claims.md). The default leaves reasoning on.
//
// Uses GUEST_PK from .env as the agent's wallet and the node at --host as the
// provider. Real testnet MON, a few cents' worth of test tokens at most.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseEther, parseEventLogs, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const chain = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});
const ADDR = process.env.DINNER_NODE_ADDRESS || '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c';
const EXPLORER = 'https://testnet.monadvision.com';
const MAX_FEE = 2000000000000n;
const JOB = [{ name: 'requester', type: 'address' }, { name: 'provider', type: 'address' }, { name: 'escrow', type: 'uint256' }, { name: 'paid', type: 'uint256' }, { name: 'tokens', type: 'uint256' }, { name: 'ratePerMillion', type: 'uint256' }, { name: 'maxTokensPerSecond', type: 'uint256' }, { name: 'openedAt', type: 'uint64' }, { name: 'lastSettleAt', type: 'uint64' }, { name: 'open', type: 'bool' }, { name: 'requireCheckpoints', type: 'bool' }];
const ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'deposits', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'openJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'string' }, { type: 'bool' }], outputs: [{ type: 'uint256' }] },
  { name: 'closeJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'getJob', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: JOB }] },
  { name: 'remainingBudget', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'JobOpened', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'requester', type: 'address', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'promptTag', type: 'string' }] },
  { name: 'StreamSettled', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'tokensDelta', type: 'uint256' }, { name: 'amount', type: 'uint256' }] },
  { name: 'JobExhausted', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'totalTokens', type: 'uint256' }, { name: 'totalPaid', type: 'uint256' }] },
  { name: 'JobClosed', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'totalTokens', type: 'uint256' }, { name: 'totalPaid', type: 'uint256' }] },
];

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : dflt; };
const HOST = arg('--host', 'http://localhost:4173');
const BUDGET = parseEther(arg('--budget', '0.06'));
const OUT = arg('--out', '');
const THINK = arg('--think', 'on') !== 'off';

// The agent's work: steps that each need a real answer, more of them than the
// budget can pay for, so the run ends on the cap rather than on the list.
const STEPS = [
  'You are a research agent. Step 1: list five factors that decide whether a home GPU is cheaper than a cloud GPU for LLM inference. One line each.',
  'Step 2: for each factor from a typical analysis, give a rough number for a 12GB laptop GPU in Serbia. Keep it short.',
  'Step 3: estimate the break-even utilisation for that laptop against a cloud GPU at $0.40 per hour. Show the arithmetic.',
  'Step 4: list three risks that would make the estimate wrong, one line each.',
  'Step 5: write a three sentence summary for a non-technical reader.',
  'Step 6: suggest two follow-up questions worth researching next.',
  'Step 7: restate the final recommendation in one sentence.',
  'Step 8: list the sources a reader should check.',
];

const pub = createPublicClient({ chain, transport: http() });
const key = process.env.GUEST_PK.startsWith('0x') ? process.env.GUEST_PK : '0x' + process.env.GUEST_PK;
const account = privateKeyToAccount(key);
const w = createWalletClient({ account, chain, transport: http() });

const log = [];
const say = (s = '') => { console.log(s); log.push(s); };
const tx = h => `${EXPLORER}/tx/${h}`;
const mon = v => `${formatEther(v)} MON`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Send one agent step on the job and read the stream to its end. Returns what
/// the node produced and how the stream ended.
async function step(jobId, prompt) {
  const res = await fetch(HOST + '/job', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: String(jobId), prompt, session: true, ...(THINK ? {} : { think: false }) }),
  });
  if (!res.ok) return { refused: `${res.status} ${await res.text()}`, text: '', think: 0, frames: 0 };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', think = 0, frames = 0, err = null, end = 'closed';
  outer: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { end = 'done'; break outer; }
      let ev; try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.th) { think++; frames++; }
      if (ev.t) { text += ev.t; frames++; }
      if (ev.err) err = ev.err;
      if (ev.done) { end = 'done'; break outer; }
    }
  }
  await reader.cancel().catch(() => {});
  return { text, think, frames, err, end };
}

/// Every event this job emitted, read in chunks because the RPC caps the
/// block range of a single getLogs.
async function jobEvents(jobId, fromBlock) {
  const to = await pub.getBlockNumber();
  const out = [];
  for (let b = fromBlock; b <= to; b += 100n) {
    const logs = await pub.getLogs({ address: ADDR, fromBlock: b, toBlock: b + 99n > to ? to : b + 99n });
    for (const e of parseEventLogs({ abi: ABI, logs })) if (e.args.jobId === jobId) out.push(e);
  }
  return out;
}

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const health = await (await fetch(HOST + '/health')).json();
const rate = BigInt(health.ratePerMillion);
say(`# Capped-job demo, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
say();
say(`Contract ${ADDR} on Monad testnet. Node ${health.provider}, ${health.model}, rate ${mon(rate)} per million tokens ($${health.pricing?.usdPerMillion}/M equivalent).`);
say(`Agent wallet ${account.address}. Budget ${mon(BUDGET)}, which pays for at most ${(BUDGET * 1_000_000n) / rate} tokens at the locked rate. Reasoning tokens are billed like visible ones, and reasoning is ${THINK ? 'ON' : 'OFF'} for this run.`);
say();

// Top up only the shortfall; closeJob returns unspent escrow to deposits[].
const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [account.address] });
if (dep < BUDGET) {
  const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: BUDGET - dep, gas: 200000n, maxFeePerGas: MAX_FEE });
  await pub.waitForTransactionReceipt({ hash: h });
  say(`[${el()}] deposited ${mon(BUDGET - dep)}: ${tx(h)}`);
}

const tag = keccak256(stringToHex(`capped-job-demo|${Date.now()}`));
const oh = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [health.provider, BUDGET, tag, true], gas: 300000n, maxFeePerGas: MAX_FEE });
const orc = await pub.waitForTransactionReceipt({ hash: oh });
const jobId = parseEventLogs({ abi: ABI, logs: orc.logs, eventName: 'JobOpened' })[0].args.jobId;
say(`[${el()}] job#${jobId} opened with ${mon(BUDGET)} escrow: ${tx(oh)}`);
say();
say('| step | stream | reasoning frames | visible chars | paid so far | remaining |');
say('|---|---|---|---|---|---|');

let stoppedBy = 'ran out of steps';
for (let i = 0; i < STEPS.length; i++) {
  const r = await step(jobId, STEPS[i]);
  await sleep(8000); // let the final settle of the step land
  const j = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [jobId] });
  const left = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'remainingBudget', args: [jobId] });
  const how = r.refused ? `refused: ${r.refused.slice(0, 80)}` : (r.err ? `error: ${String(r.err).slice(0, 60)}` : r.end);
  say(`| ${i + 1} | ${how} | ${r.think} | ${r.text.length} | ${mon(j.paid)} | ${mon(left)} |`);
  if (r.refused || r.frames === 0) { stoppedBy = `the node served nothing on step ${i + 1}`; break; }
  if (left === 0n) { stoppedBy = `the budget reached zero after step ${i + 1}`; break; }
}
say();

const final = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [jobId] });
say(`[${el()}] stopped because ${stoppedBy}.`);
say(`On chain: escrow ${mon(final.escrow)}, paid ${mon(final.paid)}, ${final.tokens} tokens billed, open=${final.open}.`);
say(`Paid never exceeded escrow: ${final.paid <= final.escrow ? 'yes' : 'NO'}.`);
say();

const evs = await jobEvents(jobId, orc.blockNumber);
say('## Every payment on this job');
say();
for (const e of evs) {
  if (e.eventName === 'StreamSettled') say(`- settle: ${e.args.tokensDelta} tokens, ${mon(e.args.amount)} to ${e.args.provider}: ${tx(e.transactionHash)}`);
  else if (e.eventName === 'JobExhausted') say(`- **JobExhausted**: ${e.args.totalTokens} tokens, ${mon(e.args.totalPaid)} total: ${tx(e.transactionHash)}`);
  else if (e.eventName === 'JobClosed') say(`- closed: ${tx(e.transactionHash)}`);
}
const settled = evs.filter(e => e.eventName === 'StreamSettled').reduce((a, e) => a + e.args.amount, 0n);
say();
say(`Sum of settlements ${mon(settled)} against paid ${mon(final.paid)}: ${settled === final.paid ? 'match' : 'MISMATCH'}.`);

if (final.open) {
  const ch = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [jobId], gas: 200000n, maxFeePerGas: MAX_FEE });
  await pub.waitForTransactionReceipt({ hash: ch });
  say(`Closed by the agent, unspent escrow ${mon(final.escrow - final.paid)} returned to its deposit: ${tx(ch)}`);
}

if (OUT) { writeFileSync(OUT, log.join('\n') + '\n'); console.log(`\nwritten to ${OUT}`); }
