// Drive the browser's own plan client against a live node.
//
// PlanPanel.tsx is React and needs a browser, but everything underneath it is
// plain fetch and TextDecoder, so the part most likely to carry a contract bug
// can be exercised here: does readStream frame correctly, does requestPlan
// recognise the plan frame, does runPlan classify every executor event, and
// does waves() draw the same shape the node actually runs.
//
//   npx tsx scripts/plan-ui-check.ts [--host http://localhost:4173]
import 'dotenv/config';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseEther, parseEventLogs, stringToHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { requestPlan, runPlan, waves, type ExecEvent } from '../web/src/lib/plan-client.js';

const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } } });
const ADDR = (process.env.DINNER_NODE_ADDRESS || '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92') as `0x${string}`;
const ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'deposits', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'openJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'string' }], outputs: [{ type: 'uint256' }] },
  { name: 'closeJob', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'jobs', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }] },
  { name: 'JobOpened', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'requester', type: 'address', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'promptTag', type: 'string' }] },
] as const;
const MAX_FEE = 2000000000000n;
const i = process.argv.indexOf('--host');
const HOST = i > -1 ? process.argv[i + 1] : 'http://localhost:4173';
// Same figure PlanPanel uses, so this exercises the budget the UI commits.
const PLAN_BUDGET = parseEther('1.5');

const pub = createPublicClient({ chain, transport: http() });
const account = privateKeyToAccount((process.env.GUEST_PK!.startsWith('0x') ? process.env.GUEST_PK! : '0x' + process.env.GUEST_PK!) as `0x${string}`);
const w = createWalletClient({ account, chain, transport: http() });

const fails: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };

const health = await (await fetch(HOST + '/health')).json() as any;
check(!!health.plans?.supported, 'host advertises plans.supported, which is what gates the UI toggle');

const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [account.address] }) as bigint;
if (dep < PLAN_BUDGET) {
  const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: PLAN_BUDGET - dep, gas: 200000n, maxFeePerGas: MAX_FEE });
  await pub.waitForTransactionReceipt({ hash: h });
}
const salt = toHex(randomBytes(32));
const goal = 'List the three biggest running costs of a home GPU, then say which dominates.';
const tag = keccak256(stringToHex(salt + '|' + goal));
const oh = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [health.provider, PLAN_BUDGET, tag], gas: 300000n, maxFeePerGas: MAX_FEE });
const rc = await pub.waitForTransactionReceipt({ hash: oh });
const jobId = (parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' })[0] as any).args.jobId as bigint;
console.log(`\njob#${jobId} open, planning through the browser's own client…`);

let reasoning = 0, visible = 0;
const plan = await requestPlan(HOST, jobId, goal, f => { if (f.th !== undefined) reasoning++; else visible++; });
check(!!plan.plan?.steps?.length, 'requestPlan returned a plan with steps');
check(typeof plan.planHash === 'string' && plan.planHash.startsWith('0x'), 'planHash arrived as the UI expects');
check(!!plan.summary && !!plan.costWei, 'summary and costWei arrived, which the review panel renders');
check(reasoning + visible > 0, `planning progress streamed (${reasoning} reasoning, ${visible} visible)`);
check(plan.plan.steps.every(s => typeof s.maxTokens === 'number' && Array.isArray(s.dependsOn)), 'every step carries the fields the panel reads');

const drawn = waves(plan.plan);
check(drawn.flat().length === plan.plan.steps.length, `waves() covers every step (${drawn.length} waves: ${drawn.map(w => w.length).join('+')})`);
console.log(`  ${plan.summary}, ceiling ${formatEther(BigInt(plan.costWei))} MON`);

console.log('\nrunning through the browser client…');
const seen = new Set<string>();
const ran: string[][] = [];
const perStep = new Map<string, { tokens: number; text: string }>();
let done: any = null;
await runPlan(HOST, jobId, plan.plan, (e: ExecEvent) => {
  seen.add(e.kind);
  if (e.kind === 'wave') ran.push(e.steps);
  else if (e.kind === 'token') {
    const cur = perStep.get(e.id) ?? { tokens: 0, text: '' };
    perStep.set(e.id, { tokens: cur.tokens + 1, text: cur.text + e.t });
  } else if (e.kind === 'step_done') console.log(`  ${e.id}: ${e.visible} visible of ${e.tokens} billed${e.truncated ? ' (truncated)' : ''}`);
  else if (e.kind === 'step_failed') console.log(`  ${e.id} FAILED ${e.code}: ${e.message}`);
  else if (e.kind === 'plan_done') done = e;
});

check(seen.has('wave') && seen.has('step_start') && seen.has('step_done'), `every event kind the panel switches on arrived: ${[...seen].join(', ')}`);
check(!!done, 'plan_done arrived, which is what flips the panel to finished');
check(JSON.stringify(ran) === JSON.stringify(drawn), 'the waves the node ran match the waves the panel drew before approval');
check([...perStep.values()].every(v => v.text.length > 0), 'every step produced text for the panel to show');

const j = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [jobId] }) as readonly any[];
console.log(`\nchain: ${j[4]} tokens, ${formatEther(j[3] as bigint)} MON, open=${j[5]}`);
check((j[3] as bigint) > 0n, 'the run settled on chain');
if (j[5]) {
  const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [jobId], gas: 200000n, maxFeePerGas: MAX_FEE });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log('closed, remainder returned');
}
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(' | ')}` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
