import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { formatEther, keccak256, parseEther, parseEventLogs, stringToHex, toHex } from 'viem';
import { ABI, ADDR, EXPLORER, monadTestnet, pub, wallet } from './chain';
import { isMine, readJob, readProvider, remaining } from './registry';
import { mock, ollama, openai, SYSTEM_PROMPT, type Chunk } from './engines';
import { describeHardware, probeHardware } from './hardware';
import { PLAN_LIMITS, planCostWei, planHash, validatePlan, type Plan } from './plan';
import { describePlan, makePlan } from './planner';
import { executePlan, type Dispatch } from './executor';
import { bill, flush, hold, newLedger, writeOff, type Ledger } from './billing';
import { authorize, chunk, completion, DONE, errorBody, errorChunk, modelsBody, parseChat, parseKeys, usage, usageChunk, type Finish } from './openai-api';
import { announceMessage, controlMessage, originOf, validNonce } from './attest';
import { reach } from './reach';
import { startQuickTunnel } from './tunnel';
import { catalogDocument } from './provider-catalog';
import { DEFAULT_MON_USD, breakEvenTokens, cheaperThanCount, crossoverRatio, describeFreeInput, describeRate, resolveRate, usdPerMillion, type Policy, type Resolved } from './pricing';

const w = wallet(process.env.PROVIDER_PK!);
const me = w.account.address;
const PORT = Number(process.env.PORT ?? 4173);
// Mutable, because the rate is decided by the market for the model this node
// actually serves rather than by a constant. The value here is only what the
// process holds between start and the resolve in the listen callback below,
// which happens before register() writes anything on chain.
//
// RATE_PER_MILLION still wins when an operator sets it. Setting a price is a
// decision, and a file that silently overrode it would be worse than one that
// prices badly.
let RATE = BigInt(process.env.RATE_PER_MILLION ?? '26700000000000000000');
// Where in its own market band this node sits, and by how much it undercuts
// that position. Defaults sit at the median of every provider serving the same
// weights, which is the only position that is both defensible and stable: the
// minimum is a race against whoever is dumping capacity this week.
const PRICE_POLICY = (process.env.PRICE_POLICY ?? 'median') as Policy;
const PRICE_DISCOUNT = Number(process.env.PRICE_DISCOUNT ?? 1);
const MON_USD = Number(process.env.MON_USD ?? DEFAULT_MON_USD);
let pricing: Resolved | null = null;

// Limits. The UI reads these from /health so its estimate matches ours instead
// of guessing, and a prompt is rejected with a number rather than silently
// truncated by the engine.
const MAX_BODY = Number(process.env.MAX_BODY_BYTES ?? 1_000_000);
const CONTEXT_TOKENS = Number(process.env.CONTEXT_TOKENS ?? 32768);
const OUTPUT_RESERVE = Number(process.env.OUTPUT_RESERVE_TOKENS ?? 2048);
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_TOKENS ?? 64);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);
// How long a session job may sit idle before the provider closes it and
// returns the guest's unspent escrow. Long enough to read an answer and think
// of a follow-up, short enough that a closed tab does not lock a deposit up
// for the evening.
const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? 600_000);
const idleTimers = new Map<bigint, ReturnType<typeof setTimeout>>();
// What this node fronts per job it opens for a caller that holds no wallet.
const FRONT_BUDGET = parseEther(process.env.FRONT_BUDGET_MON ?? '0.01');
// What it deposits when the escrow float runs dry. Several jobs' worth, so a
// busy endpoint is not paying a deposit transaction per request.
const FRONT_TOPUP = parseEther(process.env.FRONT_TOPUP_MON ?? '0.1');
// The OpenAI-compatible endpoint is OFF unless the operator sets keys. It is
// the one path where a caller spends the node's own deposit rather than their
// own, so an unset variable has to mean closed rather than open. Compare with
// /lanjob, which fronts the same escrow but is reachable only from the LAN.
const V1_KEYS = parseKeys(process.env.API_KEYS);
// Who may spend the node's own MON through the free LAN path.
//   lan  (default) machines on this network, talking to this node directly
//   off            nobody, for an operator who wants the endpoint gone
//   open           anyone who can reach the port, which from tomorrow is the
//                  internet. Only sensible on a machine with no tunnel and a
//                  deliberate decision behind it.
const LANJOB = (process.env.LANJOB ?? 'lan').toLowerCase();
// What the provider catalog says about where this machine is and whether it
// wants routed traffic. Both default to the cautious answer: no location
// declared, and not ready. An operator opts in to each.
const DATACENTER_COUNTRY = process.env.DATACENTER_COUNTRY ?? null;
const DATACENTER_REGION = process.env.DATACENTER_REGION ?? null;
const PROVIDER_IS_READY = process.env.PROVIDER_IS_READY === '1';
// A ceiling on what the endpoint can bill in a rolling day. In memory, so it
// resets when the daemon restarts: this is a brake on a runaway client, not an
// accounting system, and it is not a substitute for keys the operator trusts.
const V1_DAILY_TOKENS = Number(process.env.V1_DAILY_TOKENS ?? 2_000_000);
let v1WindowStart = Date.now();
let v1Spent = 0;
function v1Remaining(): number {
  if (Date.now() - v1WindowStart > 86_400_000) { v1WindowStart = Date.now(); v1Spent = 0; }
  return Math.max(0, V1_DAILY_TOKENS - v1Spent);
}
// Long enough to cover an ollama started alongside this daemon, short enough
// that a machine with no engine at all fails while the operator is watching.
const ENGINE_PROBE_ATTEMPTS = Number(process.env.ENGINE_PROBE_ATTEMPTS ?? 15);
const ENGINE_PROBE_INTERVAL_MS = Number(process.env.ENGINE_PROBE_INTERVAL_MS ?? 2000);

// Roughly four characters per token. Deliberately an estimate: it only has to
// be good enough to reject an impossible prompt before any money moves.
const estTokens = (s: string) => Math.ceil(s.length / 4);
// The serving instruction is sent with every job and occupies context like any
// other text, so it comes out of the budget. Leaving it out would advertise a
// number the engine cannot honour, which is the same class of defect as the
// missing num_ctx: a prompt accepted here and silently truncated there.
const SYSTEM_TOKENS = Math.ceil(SYSTEM_PROMPT.length / 4);
const PROMPT_BUDGET = CONTEXT_TOKENS - OUTPUT_RESERVE - SYSTEM_TOKENS;

// HOST_PRIORITY decides who loses when the machine is busy. "owner" means the
// person sitting at the keyboard wins and guests get throttled early; "guest"
// means the machine is dedicated and only backs off near saturation.
const PRIORITY = (process.env.HOST_PRIORITY ?? 'owner').toLowerCase();
const THRESHOLDS = PRIORITY === 'guest' ? { soft: 0.85, hard: 0.97 } : { soft: 0.55, hard: 0.85 };

let loadRatio = 0;
let memUsed = 0;
let gpuUtil: number | null = null;
setInterval(() => {
  loadRatio = os.loadavg()[0] / Math.max(1, os.cpus().length);
  memUsed = 1 - os.freemem() / os.totalmem();
}, 2000).unref();
setInterval(() => {
  const p = spawn('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']);
  let out = '';
  p.stdout.on('data', d => out += d);
  p.on('close', () => { const n = parseInt(out.trim().split('\n')[0], 10); gpuUtil = Number.isFinite(n) ? n / 100 : null; });
  p.on('error', () => { gpuUtil = null; });
}, 5000).unref();

// Pressure is the worst of the signals we have. GPU counts only when readable.
const pressure = () => Math.max(loadRatio, memUsed, gpuUtil ?? 0);
// Above the soft threshold, pace the stream instead of dropping the job. The
// guest still gets their answer and still pays only for tokens delivered.
const throttleMs = () => {
  const p = pressure();
  if (p <= THRESHOLDS.soft) return 0;
  const span = Math.max(0.01, THRESHOLDS.hard - THRESHOLDS.soft);
  return Math.round(Math.min(1, (p - THRESHOLDS.soft) / span) * 120);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Probed once at start. The string goes on chain in the provider record, so a
// guest choosing between nodes sees what they are choosing between.
const HW = probeHardware();

/**
 * What a guest has to wait for before the first token, and how much of the
 * model is actually on the GPU. Both are measured rather than assumed, and
 * both are published on /health, because the guest's stream watchdog has to
 * size its patience from something. A node serving a model too large for its
 * VRAM answers in minutes, and a client that gives up at sixty seconds aborts
 * every job on it before a single token exists.
 */
let firstTokenMs: number | null = null;
/**
 * Generation rate, from streams this node has actually served.
 *
 * Timed from the FIRST token rather than from the request, because model load
 * dominates a cold start and does not scale with the work: 16s at num_ctx 16k
 * and 114s at 40k, paid once. Folding that in would publish a capacity figure
 * that says more about how recently the node was busy than about how fast it
 * is. Null until something has been served, and published as absent rather
 * than as a guess, since an absent capacity means undeclared and a wrong one
 * means a router sending work this node cannot keep up with.
 */
let measuredTokensPerSecond: number | null = null;
function recordThroughput(tokens: number, ms: number) {
  // A handful of tokens is a sample of the scheduler, not of the model.
  if (tokens < 32 || ms <= 0) return;
  const rate = (tokens / ms) * 1000;
  // Weighted to the past, so one throttled stream on a busy machine does not
  // rewrite the figure a router is costing against.
  measuredTokensPerSecond = measuredTokensPerSecond === null ? rate : measuredTokensPerSecond * 0.7 + rate * 0.3;
}
let gpuFraction: number | null = null;

export type GenOptions = {
  /** Whether the model may reason before answering. Costs about 13x on this
   *  node's model and is billed, so a plan step turns it off. See engines.ts. */
  think?: boolean;
};
type Engine = { kind: string; model: string; gen: (p: string, signal?: AbortSignal, o?: GenOptions) => AsyncGenerator<Chunk> };
async function pickEngine(): Promise<Engine> {
  if (process.env.ENGINE === 'mock') {
    return { kind: 'mock', model: process.env.MODEL ?? 'mock-7b', gen: mock };
  }
  if (process.env.LLM_BASE_URL) {
    const model = process.env.LLM_MODEL ?? 'local';
    return { kind: 'openai-compat', model, gen: (p, s) => openai(p, process.env.LLM_BASE_URL!, model, s) };
  }
  // ollama is usually started by the same hand that starts this daemon, and it
  // is not listening for the first few seconds. A single probe here loses that
  // race and used to fall through to the mock engine for the lifetime of the
  // process, while /health went on advertising the configured model name. The
  // node then took payment for a canned passage. Wait for it instead.
  let lastErr = '';
  for (let attempt = 0; attempt < ENGINE_PROBE_ATTEMPTS; attempt++) {
    try {
      const tags = await (await fetch('http://localhost:11434/api/tags')).json() as any;
      const names: string[] = (tags.models ?? []).map((m: any) => m.name);
      // MODEL, when the operator set it, is a decision and not a preference.
      // The fallback that used to sit here served whatever happened to be
      // first in the local list, under a provider record that names the model
      // on chain, at a rate resolved from that model's market band. Three ways
      // to be wrong at once: the guest gets a model they did not choose, the
      // price is derived from different weights, and the node could serve a
      // restrictively licensed model by accident. A node that will not start
      // is the cheaper failure.
      const want = process.env.MODEL;
      if (want && !names.includes(want)) {
        console.error(`model ${want} is not installed on this machine.`);
        console.error(`installed: ${names.join(', ') || '(none)'}`);
        console.error('run `ollama pull ' + want + '`, or change MODEL in .env to one of the above.');
        process.exit(1);
      }
      const model = want ?? names[0];
      if (model) {
        // Unset MODEL still takes the first tag, because a node with one model
        // installed should just work. It says which, because this string is
        // what registerProvider writes on chain and what a guest chooses from.
        if (!want) console.log(`MODEL unset, serving ${model} and registering it on chain`);
        return { kind: 'ollama', model, gen: (p, s, o) => ollama(p, model, s, CONTEXT_TOKENS, undefined, o?.think !== false) };
      }
      lastErr = 'ollama is running but has no models installed';
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
    if (attempt === 0) console.log('waiting for ollama on localhost:11434');
    await new Promise(r => setTimeout(r, ENGINE_PROBE_INTERVAL_MS));
  }
  // Serving canned text from a provider that is registered on chain and being
  // paid per token is worse than not serving at all, so this is fatal. An
  // operator who genuinely wants the mock engine asks for it by name.
  console.error('no inference engine: ' + lastErr);
  console.error('start ollama (`ollama serve`), set LLM_BASE_URL for an OpenAI-compatible server,');
  console.error('or set ENGINE=mock to serve the canned demo passage on purpose.');
  process.exit(1);
}
const engineP = pickEngine();

// Two counters per job, not one. See src/billing.ts for the policy: `delta` is
// output the guest received and is the only thing the settle ticker charges
// for; `hold` is work whose deliverability is not decided yet, and failed work
// is written off from it rather than invoiced.
const active = new Map<bigint, Ledger>();
// gate() runs two awaited round trips before serveJob populates `active`, so
// concurrent requests all saw size 0 and the concurrency ceiling never bound.
// Count in-flight requests from the moment the gate admits one instead.
let inFlight = 0;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run a transaction behind everything else this wallet has in flight.
 *
 * Every other write from the provider key already goes through `queue`, for
 * the reason settle documents: two transactions from one account, sent at
 * once, race on the nonce and one of them is dropped. The job-opening path did
 * not, because it had one caller and that caller was a guest on the LAN typing
 * one prompt at a time. The OpenAI endpoint has concurrent callers by
 * construction, and the race showed up on the second request of the first
 * end-to-end run: `openJob` collided with the previous job's `closeJob` and
 * came back as a 503.
 *
 * The cost is latency. An opening now waits for whatever settlement is in
 * flight, which is a block or so on Monad. That is the right trade against a
 * request that fails outright.
 */
function serialized<T>(f: () => Promise<T>): Promise<T> {
  // `then(f, f)` rather than `then(f)`: a failed settlement must not stop the
  // next job from opening.
  const run = queue.then(f, f);
  queue = run.catch(() => {});
  return run;
}

// Monad charges gas_limit rather than gas_used, so a padded limit overpays on
// every call and a tight one that reverts burns the whole limit for nothing.
// A fixed 100000 was doing exactly that: settle needs about 118000 the first
// time a provider is paid, because `earned` and `tokensServed` go from zero to
// non-zero and cost 20000 each. After every key rotation the first settlement
// of the new wallet reverted and the guest was never charged. Estimating per
// call costs one round trip against a three second settlement interval and
// keeps the limit both sufficient and tight.
async function gasFor(fn: string, args: readonly unknown[], fallback: bigint, value?: bigint): Promise<bigint> {
  try {
    const g = await pub.estimateContractGas({
      address: ADDR, abi: ABI, functionName: fn as any, args: args as any, account: w.account,
      // Payable calls estimate to a revert without the value attached, which
      // silently returned the padded fallback for every deposit this node made.
      ...(value === undefined ? {} : { value }),
    } as any);
    return (g * 120n) / 100n;
  } catch {
    return fallback;
  }
}

// writeContract resolves when the transaction is accepted, not when it
// succeeds. Without the receipt check a reverted settlement was logged as a
// completed payment, which is the worst possible way for this to fail.
async function sendChecked(label: string, fn: string, args: readonly unknown[], fallback: bigint) {
  const gas = await gasFor(fn, args, fallback);
  // Monad charges the limit, so this is what the call actually costs. Feeding it
  // back is what keeps the settlement threshold calibrated to reality instead of
  // to a constant somebody measured once on a different contract state.
  if (fn === 'settle') settleGasUnits = gas;
  const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: fn as any, args: args as any, gas, maxFeePerGas: 2000000000000n });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== 'success') throw new Error(`${label} reverted (gas ${gas}, used ${rc.gasUsed}) ${EXPLORER}/tx/${h}`);
  return h;
}

const ZERO_HASH = `0x${'00'.repeat(32)}` as const;

/**
 * What this node has published, and what it is about to.
 *
 * v2 pays a provider against its own published progress rather than against
 * what it claims in the settle call, so this is no longer bookkeeping: a job
 * this node never checkpoints earns nothing on a reassign, and a job the guest
 * opened with `requireCheckpoints` cannot settle at all without one.
 *
 * Two counts, matching the Checkpoint struct, and they are NOT the same
 * number. `visible` counts the answer text, which is what `prefix` holds and
 * what a replacement provider is handed and must reproduce. `billed` is
 * visible plus reasoning, and is what settle clamps payment against. Reasoning
 * is streamed and charged for (terms 3.1) but is deliberately outside the hash
 * chain, because the chain has to cover exactly the text a replacement gets.
 *
 * Both are CUMULATIVE FOR THE JOB, across every provider that has held it and
 * every turn of a session, because that is the scope `_allowed` compares them
 * against. `prefix` is scoped to the answer currently being written, since that
 * is the text a replacement resumes. The two scopes differ on purpose: the
 * counts bound payment, the text proves continuity.
 */
type Progress = {
  /**
   * The visible answer so far, hashed at settle time rather than on a token
   * interval. Holding the text and not a periodic hash is what decouples
   * settlement from CHECKPOINT_TOKENS: the value-triggered ticker can fire
   * after nine visible tokens, and on a job that requires checkpoints a settle
   * with nothing to publish does not revert, it publishes those nine.
   */
  prefix: string;
  visible: number;
  billed: number;
  /** `visible` as of the last checkpoint that actually landed on chain. */
  publishedVisible: number;
  /** Read from the job at open. When true the chain refuses to pay for tokens
   *  with no checkpoint behind them, so a settle that cannot publish is not
   *  attempted at all. */
  requireCheckpoints: boolean;
};
const progress = new Map<bigint, Progress>();

/**
 * Seed a job's cumulative counts from the chain before serving it.
 *
 * `billed` starts at the job's own paid-for token count and not at zero, even
 * when no checkpoint exists. _allowed computes `proven = cp.billed - j.tokens`
 * and clamps payment to it, so publishing a checkpoint whose `billed` sits
 * below what the job has already paid for would clamp this node's own
 * settlements to nothing. That case is real: it is every job handed over by a
 * provider that settled without publishing.
 */
async function seedProgress(jobId: bigint, prefix: string): Promise<Progress> {
  let visible = 0, billed = 0, requireCheckpoints = false;
  try {
    const [cp, job] = await Promise.all([
      pub.readContract({ address: ADDR, abi: ABI, functionName: 'getCheckpoint', args: [jobId] }) as Promise<{ tokens: bigint; billed: bigint }>,
      readJob(jobId),
    ]);
    visible = Number(cp.tokens);
    billed = Math.max(Number(cp.billed), Number(job.tokens));
    requireCheckpoints = job.requireCheckpoints;
  } catch (e: any) {
    console.log(`[job#${jobId}] could not read published progress, starting from zero:`, e?.shortMessage ?? e?.message);
  }
  const p: Progress = { prefix, visible, billed, publishedVisible: visible, requireCheckpoints };
  progress.set(jobId, p);
  return p;
}

/**
 * Whether this job can be paid right now.
 *
 * On a job the guest opened with `requireCheckpoints`, settle() reverts unless
 * it carries a checkpoint, and _checkpoint reverts unless the visible count
 * strictly advances. A settlement covering reasoning alone satisfies neither,
 * and that is a common shape rather than an edge case: job#93 billed 1,631
 * reasoning tokens against 20 visible. Attempting it would revert, and a
 * reverted settle loses the tokens it was flushed with.
 *
 * So it waits instead. The tokens stay in the ledger and are paid by the next
 * settlement that has visible progress to publish.
 */
const canSettle = (jobId: bigint) => {
  const p = progress.get(jobId);
  if (!p || !p.requireCheckpoints) return true;
  return p.visible > p.publishedVisible;
};

const settle = (jobId: bigint, delta: number) => {
  const p = progress.get(jobId);
  // Publish only when the visible answer has actually advanced since the last
  // checkpoint that landed. _checkpoint requires a strict advance, so a settle
  // covering reasoning alone would revert and strand the stream, and that is
  // not a rare case: job#93 billed 1,631 reasoning tokens against 20 visible.
  // A plan run takes this branch permanently, which is correct: it has no
  // single growing prefix and its ceiling comes from commitPlan instead.
  const publish = !!p && p.visible > p.publishedVisible;
  // Hashed here, over the prefix as it stands at this instant, so the height
  // published and the text hashed are the same moment. Reading a hash computed
  // on a token interval would publish a count from now against a hash from up
  // to CHECKPOINT_TOKENS ago, and a replacement handed that text would compute
  // a different hash and refuse to continue.
  const args = publish
    ? [jobId, BigInt(delta), keccak256(stringToHex(p!.prefix)), BigInt(p!.visible), BigInt(p!.billed)]
    : [jobId, BigInt(delta), ZERO_HASH, 0n, 0n];
  // Claimed before the call rather than after it, because settles are queued
  // and the stream keeps producing while one is in flight. Leaving it until
  // the receipt lets a second settle publish the same height, which reverts on
  // "checkpoint must advance". Restored below if the transaction fails.
  const claimed = publish ? p!.publishedVisible : 0;
  if (publish) p!.publishedVisible = p!.visible;
  queue = queue.then(() =>
    sendChecked('settle', 'settle', args, 150000n)
      .then(h => console.log(`  [settle] job#${jobId} +${delta} tok${publish ? ` cp@${p!.visible} vis` : ''}  ${EXPLORER}/tx/${h}`))
      .catch(e => {
        if (publish && p) p.publishedVisible = claimed;
        console.log(`  [settle] FAILED job#${jobId}:`, (e as any).shortMessage ?? (e as any).message);
      }));
};
// SETTLEMENT CADENCE.
//
// This was a flat 3 second timer, and that is the single most expensive line
// the project has had. Gas per settle is fixed; revenue per settle is
// tokens x RATE, so a timer charges identical gas no matter how much work it
// covers. Measured: settle costs 28,809 gas warm, Monad charges the limit
// rather than the usage, and gasFor adds 20 percent, so 34,571 gas is charged
// every time. At 102 gwei that is 0.00353 MON. At RATE = 2.67e19 wei per
// million, a token earns 0.0000267 MON. Gas therefore equals revenue at
// exactly 132 tokens per settle, and every settle covering fewer than that
// loses the provider money.
//
// A 3 second timer covers 12 tokens on a node running 4 tok/s and 159 on one
// running 53, so the same interval is a 10x loss on one machine and roughly
// break-even on the next. Node speed is not something this file can know.
//
// So the trigger is denominated in value instead. Settle once the unsettled
// tokens are worth SETTLE_GAS_MULTIPLE times what it currently costs to settle
// them. That self-corrects for a slow node, a fast node, and a base fee spike,
// which is the third variable: at 2000 gwei break-even moves from 132 tokens to
// 2,590, and any hardcoded token count would be catastrophically wrong there.
//
// k = 10 puts gas at about 9 percent of each settlement. SETTLE_MAX_MS is the
// backstop so a very slow node still pays out on a human timescale, and the
// end-of-stream flush in serveJob settles whatever is left regardless.
//
// Note that billing reasoning tokens brought this threshold back into range.
// At 100,915 gas it is worth about 3,070 tokens, which no job reached while
// only visible output was billed, so every job settled exactly once at the
// end. A measured 900 word briefing is about 4,290 billable tokens now, so a
// long job settles mid-stream again and the guest sees value moving while the
// answer is still being written.
// What this node claims it can produce per second, written on chain at
// registration and locked into every job at openJob. v2 derives bound 1 from
// it: one settlement can never be paid for more than `elapsed * this` tokens,
// whatever `tokensDelta` says, which is what stops a compromised or buggy node
// draining a whole escrow in a single call.
//
// The default is roughly twice the fastest decode ever measured here (215.5
// tok/s on llama3.2:1b, see src/earnings.ts), so a real stream never trips it
// while a runaway settlement is still bounded to seconds of plausible work.
// Both visible and reasoning tokens count against it, because both are billed.
// The contract caps it at MAX_TOKENS_PER_SECOND = 10,000 regardless.
const MAX_TOKENS_PER_SECOND = BigInt(process.env.MAX_TOKENS_PER_SECOND ?? 400);

const SETTLE_GAS_MULTIPLE = BigInt(process.env.SETTLE_GAS_MULTIPLE ?? 10);
const SETTLE_MAX_MS = Number(process.env.SETTLE_MAX_MS ?? 60000);
// SELF-CALIBRATING, because the hardcoded figure was wrong by 2.9x.
//
// This was 34571n, from a "28,809 warm" measurement carried in
// web/api/p/_lib.js and repeated through SNAPSHOT's economics. The first job
// served after the value trigger shipped (job#49) charged 100,915 gas for its
// settle and 57,044 for its closeJob, so the real estimate is about 84,000 and
// the constant understated the cost of settling by nearly three times. Every
// threshold derived from it fired far too early.
//
// A constant cannot be right here anyway: settle costs more the first time a
// provider is ever paid, more again when a storage slot goes from zero to
// non-zero, and the contract may change under it. gasFor already asks the node
// for a real estimate before every call, so the threshold now uses what that
// estimate last returned and only falls back to a static figure before the
// first settlement of the process.
//
// Seeded high on purpose. Being pessimistic settles later, which costs the
// provider a little unsettled exposure; being optimistic settles too often,
// which costs real money on every job.
let settleGasUnits = 101000n;

// Cached rather than read per tick. It only sizes a threshold, so a value up to
// fifteen seconds stale is fine, and this runs once per second per job.
let gasPriceWei = 102_000_000_000n;
const refreshGasPrice = async () => {
  try { gasPriceWei = await pub.getGasPrice(); } catch {}
};
refreshGasPrice();
setInterval(refreshGasPrice, 15000).unref?.();

/** What one settle transaction costs right now, in wei. */
const settleCostWei = () => settleGasUnits * gasPriceWei;
/** What `delta` unsettled tokens are worth, in wei. */
const settleValueWei = (delta: number) => (BigInt(delta) * RATE) / 1_000_000n;

setInterval(() => {
  const now = Date.now();
  const threshold = settleCostWei() * SETTLE_GAS_MULTIPLE;
  for (const [id, j] of active) {
    if (j.delta <= 0) continue;
    const worthIt = settleValueWei(j.delta) >= threshold;
    const waitedLongEnough = now - j.since >= SETTLE_MAX_MS;
    if (!worthIt && !waitedLongEnough) continue;
    // Held back rather than attempted on a job that requires checkpoints and
    // has produced nothing visible since the last one. The tokens stay in the
    // ledger and the next settlement with visible progress pays for them.
    if (!canSettle(id)) continue;
    settle(id, flush(j, now));
  }
}, 1000);

// Announce to the discovery listener so the web app can find this node by URL.
// The listener re-checks providers(me) on chain before it trusts any of this.
const DISCOVERY = process.env.DISCOVERY_URL ?? '';
// Mutable, because a node with no URL of its own gets one at startup from a
// quick tunnel. Set in .env it is a named tunnel or any other arrangement the
// operator made, and nothing below touches it.
let PUBLIC_URL = process.env.PUBLIC_URL ?? '';
// off  never start one, for a node that is deliberately LAN only
// auto (default) start one when PUBLIC_URL is unset and cloudflared exists
const TUNNEL = (process.env.TUNNEL ?? 'auto').toLowerCase();
// The listener expires an announced URL after DISCOVERY_TTL_MS, ten minutes by
// default, and reverts that provider to url: null. announce() ran exactly once
// at startup, so every node vanished from discovery's URL list ten minutes
// after it booted and stayed missing until someone restarted it. Discovery
// still knew the address from the chain; it just no longer knew where to reach
// it, which is the one thing it exists to know.
//
// Re-announcing on a timer well inside that window is the fix. Four minutes
// gives two chances to land before the TTL runs out, so a single failed
// announce is not enough to drop a live node.
const ANNOUNCE_EVERY_MS = Number(process.env.ANNOUNCE_INTERVAL_MS ?? 240_000);
let announced = false;
async function announce() {
  if (!DISCOVERY || !PUBLIC_URL) return;
  try {
    const e = await engineP;
    const base = DISCOVERY.replace(/\/$/, '');
    // Discovery now wants proof this machine holds the key the registry pays,
    // and not merely that the address it names is registered. Two requests: it
    // issues a nonce, this node signs a claim naming the registry, the chain,
    // itself, its URL, its model and that nonce.
    const nres = await fetch(`${base}/announce/nonce?address=${me}`, { headers: { 'ngrok-skip-browser-warning': '1' } });
    if (!nres.ok) {
      console.log(`[announce] no nonce: ${nres.status} ${(await nres.text()).slice(0, 120)}`);
      announced = false;
      return;
    }
    const { nonce, registry, chainId } = await nres.json() as { nonce: string; registry?: string; chainId?: number };
    // The origin, because that is what discovery stores and therefore what it
    // will rebuild the message from. Signing the raw string would produce a
    // valid signature over a claim the verifier never sees.
    const url = new URL(PUBLIC_URL).origin;
    const claim = announceMessage({
      // Discovery's own registry and chain rather than ours, so a mismatch
      // fails as a rejected signature with both values visible instead of
      // silently announcing into a table for a different deployment.
      registry: registry ?? ADDR, chainId: chainId ?? monadTestnet.id,
      address: me, url, model: e.model, nonce,
    });
    const signature = await w.signMessage({ message: claim });
    const r = await fetch(`${base}/announce`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: me, url, model: e.model, nonce, signature }),
    });
    const body = (await r.text()).slice(0, 120);
    // Only the first announce and any failure are worth a line. A success
    // every four minutes for the life of the process is noise that hides the
    // failures underneath it.
    if (!announced || !r.ok) console.log(`[announce] ${r.status} ${body}`);
    announced = r.ok;
  } catch (e: any) {
    announced = false;
    console.log('[announce] failed (non-fatal):', e?.message ?? e);
  }
}

const GUEST_HTML = `<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width,initial-scale=1">
<title>DinnerNode · laptop kitchen</title>
<body style="background:#0b0e14;color:#d7e0ea;font:14px/1.5 monospace;padding:24px;max-width:760px;margin:auto">
<h1 style="color:#9fef00">DinnerNode <span style="font-size:12px;color:#6b7a89">· served straight from this laptop</span></h1>
<textarea id=p rows=3 style="width:100%;background:#10161f;color:#d7e0ea;border:1px solid #1d2733;padding:8px">How much is the cost of an average dinner in Belgrade?</textarea>
<div id=est style="color:#6b7a89;font-size:12px"></div>
<button id=b style="background:#10161f;color:#9fef00;border:1px solid #9fef00;padding:10px 18px;cursor:pointer">place order</button>
<span id=st style="color:#9fef00"></span>
<div id=th style="display:none;white-space:pre-wrap;background:#0d131c;border:1px dashed #1d2733;padding:10px;color:#6b7a89;font-size:12px;max-height:140px;overflow-y:auto"></div>
<pre id=o style="white-space:pre-wrap;background:#10161f;border:1px solid #1d2733;padding:12px;min-height:240px"></pre>
<script>
var BUDGET=${PROMPT_BUDGET};
function upd(){var n=Math.ceil(p.value.length/4);est.textContent=n+' / '+BUDGET+' tokens (estimate)';est.style.color=n>BUDGET?'#ff6b6b':'#6b7a89';b.disabled=n>BUDGET;}
p.oninput=upd;upd();
b.onclick=async()=>{o.textContent='';th.textContent='';th.style.display='none';st.textContent=' — opening job on the laptop…';b.disabled=true;
try{const r=await fetch('/lanjob',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:p.value})});
if(!r.ok){st.textContent=' — '+(await r.text());b.disabled=false;return;}
const rd=r.body.getReader(),d=new TextDecoder();let buf='';
for(;;){const{done,value}=await rd.read();if(done)break;buf+=d.decode(value,{stream:true});let i;
while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);
if(l.startsWith('data: ')&&l!=='data: [DONE]'){try{var j=JSON.parse(l.slice(6));
if(j.th){th.style.display='block';th.textContent+=j.th;th.scrollTop=th.scrollHeight;st.textContent=' — thinking…';}
if(j.t){st.textContent=' — streaming…';o.textContent+=j.t}}catch(e){}}}}
st.textContent=' — order up. settlements live on Monad testnet.';}catch(e){st.textContent=' failed: '+e;}
b.disabled=false;upd();};
</script>`;

/**
 * Where a served stream is written.
 *
 * `serveJob` owns the billing, the checkpoint chain and the settlement, and it
 * owned the wire format too until this node had a second kind of caller. The
 * frames DinnerNode's own client reads are not the frames an OpenAI client
 * reads, and duplicating the loop to say the same thing twice would have meant
 * two copies of the money path. So the loop stays single and the format moves
 * behind this interface: one billing path, two ways of writing it down.
 */
type Wire = {
  head(): void;
  hb(): void;
  th(text: string): void;
  tok(text: string): void;
  cp(n: number, h: `0x${string}`): void;
  err(message: string): void;
  end(f: { n: number; h: `0x${string}`; visible: number; reasoning: number; finish: Finish }): void;
};

/** The native format, byte for byte what this node has always sent. */
function nativeWire(res: http.ServerResponse): Wire {
  return {
    head() { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' }); },
    hb() { try { res.write(': hb\n\n'); } catch {} },
    th(text) { res.write(`data: ${JSON.stringify({ th: text })}\n\n`); },
    tok(text) { res.write(`data: ${JSON.stringify({ t: text })}\n\n`); },
    cp(n, h) { res.write(`data: ${JSON.stringify({ cp: { n, h } })}\n\n`); },
    err(message) { res.write(`data: ${JSON.stringify({ err: message })}\n\n`); },
    end(f) {
      res.write(`data: ${JSON.stringify({ cp: { n: f.n, h: f.h, final: true }, bill: { visible: f.visible, reasoning: f.reasoning } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    },
  };
}

/**
 * The OpenAI-compatible format, streaming or buffered.
 *
 * Checkpoints are dropped: an OpenAI client has no field for them and no use
 * for one, since it is not the party that could hand the prefix to another
 * provider. That is the cost of this wire and it is the reason the native one
 * is still the default. Reasoning is forwarded as `reasoning`, which is what
 * OpenRouter sends and what `src/engines.ts` already accepts on the way in.
 */
function openaiWire(res: http.ServerResponse, o: {
  id: string; model: string; stream: boolean; includeUsage: boolean; promptTokens: number;
}): Wire {
  const created = Math.floor(Date.now() / 1000);
  const headers = { 'access-control-allow-origin': '*', 'x-dinnernode-job': o.id };
  let content = '';
  let reasoning = '';
  let wrote = false;
  return {
    head() {
      if (!o.stream) return;
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      // The role-only opening chunk. Stock clients read the role from it and
      // never see it again on this stream.
      res.write(chunk(o.id, created, o.model, { role: 'assistant', content: '' }));
      wrote = true;
    },
    hb() { if (o.stream) { try { res.write(': hb\n\n'); } catch {} } },
    th(text) { reasoning += text; if (o.stream) res.write(chunk(o.id, created, o.model, { reasoning: text })); },
    tok(text) { content += text; if (o.stream) res.write(chunk(o.id, created, o.model, { content: text })); },
    cp() { /* nothing to say on this wire */ },
    err(message) {
      if (o.stream) { res.write(errorChunk(message)); return; }
      // Nothing has been sent yet on a buffered request, so the failure can
      // still be a status code rather than a 200 carrying an error object.
      if (!wrote) {
        wrote = true;
        res.writeHead(502, { ...headers, 'content-type': 'application/json' });
        res.end(errorBody(message, 'server_error', 'engine_error'));
      }
    },
    end(f) {
      const u = usage(o.promptTokens, f.visible + f.reasoning);
      if (o.stream) {
        res.write(chunk(o.id, created, o.model, {}, f.finish));
        if (o.includeUsage) res.write(usageChunk(o.id, created, o.model, u));
        res.write(DONE);
        res.end();
        return;
      }
      if (wrote) { if (!res.writableEnded) res.end(); return; }
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(completion(o.id, created, o.model, content, reasoning, u, f.finish));
    },
  };
}

async function serveJob(jobId: bigint, prompt: string, res: http.ServerResponse, resume?: { text: string; n: number }, session = false, opts: { wire?: Wire; maxTokens?: number; onBilled?: (tokens: number) => void } = {}) {
  const wire = opts.wire ?? nativeWire(res);
  // A caller that asked for fewer tokens than the engine would produce. The
  // stream stops at the ceiling and the job settles for what it produced, so
  // the cap costs the caller nothing beyond what it received.
  const cap = opts.maxTokens ?? Infinity;
  let finish: Finish = 'stop';
  wire.head();
  const e = await engineP;
  const hb = setInterval(() => wire.hb(), 1000);
  active.set(jobId, newLedger());
  // Read before a token is produced, so the first settlement of the stream
  // already carries a checkpoint the contract will accept.
  const prog = await seedProgress(jobId, resume?.text ?? '');

  // On a resume the earlier text is replayed as context but is never charged
  // again: this node only settles the tokens it actually produces.
  const effective = resume
    ? `${prompt}\n\nContinue the following answer exactly where it stops. Do not repeat any of it.\n\n${resume.text}`
    : prompt;

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  // Prompt text is the guest's data and this node is a processor, not a
  // recipient. Log the shape of the work, never its content.
  console.log(`[job#${jobId}] serving ${estTokens(String(prompt))} tok in via ${e.kind}/${e.model}${resume ? ` (resume from ${resume.n} tok)` : ''}`);

  let produced = 0;
  // Set when the first frame of any kind arrives, so the rate below measures
  // generation and not the model load in front of it.
  let genStart = 0;
  // Reasoning frames BILLED, which is one per frame, the same increment the
  // ledger takes. Counted rather than estimated from the text: estTokens is
  // chars/4 and came out 84 tokens under the truth on job#15, so the figure the
  // guest was shown was 9% below the figure they paid. Terms 3.1 says the
  // guest can see what they are charged for, and that has to be the same
  // number.
  let reasoned = 0;
  let sinceCp = 0;
  // Unbilled reasoning, accumulated only to report the ratio. This node
  // performs roughly twice the compute it invoices and nothing measured it
  // per job until now.
  let thought = '';
  try {
    for await (const c of e.gen(effective, ac.signal)) {
      if (res.writableEnded) break;
      // Reasoning is forwarded and nothing else. It is not billed, because
      // `delta` is what settle() charges for; it is not appended to `prefix`,
      // because the checkpoint hash must cover exactly the text a replacement
      // provider can be handed to reproduce. Its only job is to tell the
      // browser that a 15 to 47 second silence is a model working rather than
      // an engine wedged, which was aborting jobs before they produced a
      // single visible character.
      if (c.th !== undefined) {
        if (!genStart) genStart = Date.now();
        thought += c.th;
        // Reasoning IS billed. It is compute this node performs and delivers,
        // it is what OpenRouter providers charge for as output tokens, and not
        // charging for it made a 900 word briefing - the job shape this
        // project is built around - net negative at full utilization. One
        // frame is one token here exactly as it is on the visible path, so it
        // increments the same counter.
        active.get(jobId)!.delta++;
        prog.billed++;
        reasoned++;
        // It is still NOT appended to `prefix` and NOT counted in `produced`.
        // The checkpoint chain covers the visible answer only, because that is
        // the text a replacement provider is handed and must reproduce. What
        // this costs is the strength of the claim: a settlement can no longer
        // be fully reconstructed from the published prefix, since part of it
        // paid for reasoning that was streamed but never checkpointed. The
        // claim narrows to the visible answer; see terms.html.
        wire.th(c.th);
        continue;
      }
      const tok = c.t;
      if (!genStart) genStart = Date.now();
      wire.tok(tok);
      prog.prefix += tok;
      produced++;
      active.get(jobId)!.delta++;
      prog.visible++;
      prog.billed++;
      if (++sinceCp >= CHECKPOINT_EVERY) {
        sinceCp = 0;
        // A checkpoint lets a different provider pick the answer up from here
        // and prove it has the same prefix, rather than starting over.
        // The frame the browser and a failover client read. The chain gets
        // the same hash from the same text at settle time, inside a
        // settlement this node is making anyway: 6,293 gas once the four slots
        // are warm, against a whole transaction for commitCheckpoint.
        wire.cp((resume?.n ?? 0) + produced, keccak256(stringToHex(prog.prefix)));
      }
      // Checked after the checkpoint, so the last token the caller was given is
      // covered by a published prefix like every other token in the stream.
      //
      // Reasoning counts, because reasoning is BILLED. Testing visible tokens
      // alone let a caller asking for max_tokens 16 be charged for thousands
      // on a reasoning model, and made usage.completion_tokens come back above
      // the max_tokens the client sent, which an aggregator reads as a broken
      // provider.
      if (produced + reasoned >= cap) { finish = 'length'; break; }
      const t = throttleMs();
      if (t) await sleep(t);
    }
  } catch (err: any) {
    console.log(`[job#${jobId}] engine error:`, err?.message ?? err);
    finish = 'error';
    if (!res.writableEnded) wire.err(String(err?.message ?? err));
  }
  // Stopping the generator once the ceiling is reached rather than letting it
  // run on unread. Done after the loop and outside the try, so the abort cannot
  // surface as an engine error in a stream that ended normally.
  if (finish === 'length') ac.abort();
  clearInterval(hb);
  // Both counts, because both are compute this node performed and both are
  // billed. The catalog publishes this as tokens per minute.
  if (genStart) recordThroughput(produced + reasoned, Date.now() - genStart);
  // Reported here rather than from the wire, because the wire's end() runs
  // only when the response is still open. A client that hangs up mid-stream,
  // and a buffered request whose engine failed, both settle on chain and both
  // skipped the wire, so the daily ceiling never moved: a caller could hold
  // the node's compute and gas open forever by disconnecting in a loop.
  if (produced + reasoned > 0) opts.onBilled?.(produced + reasoned);
  if (reasoned > 0) {
    console.log(`[job#${jobId}] ${produced} tok visible + ${reasoned} tok reasoning, both billed (${Math.round((reasoned / (reasoned + produced || 1)) * 100)}% reasoning)`);
  }
  if (!res.writableEnded) {
    // `bill` is what this node actually charged for this stream, sent so the
    // guest reads the node's own numbers rather than re-deriving them from the
    // text. The browser cannot compute the reasoning figure honestly: the
    // frames are the billing unit and their token boundaries are not
    // recoverable from the concatenated string.
    wire.end({ n: (resume?.n ?? 0) + produced, h: keccak256(stringToHex(prog.prefix)), visible: produced, reasoning: reasoned, finish });
  }
  const j = active.get(jobId);
  if (j && j.delta > 0) {
    // A job that requires checkpoints and produced no visible token at all has
    // nothing publishable, so there is nothing the chain will pay for. That is
    // the same policy as a plan step that spent its ceiling on reasoning and
    // returned nothing: this node ate the compute. Writing it off is honest and
    // it is also the only option, since the settle would revert.
    if (canSettle(jobId)) settle(jobId, flush(j));
    else console.log(`[job#${jobId}] ${flush(j)} tok written off: the job requires checkpoints and no visible token was produced`);
  }

  // A session job stays open across turns, so one conversation pays openJob and
  // closeJob once instead of once per turn. Measured over a real ten turn
  // conversation on this node that is 73% less gas overall, and it takes gas
  // from 18.2% of what the guest pays down to 2.2%.
  //
  // The risk it introduces is a guest who closes the tab: V1 has no expiry, so
  // the escrow would sit open forever. The idle timer below is the safety net,
  // and it is the provider's job because the provider is already the party
  // paying closeJob.
  if (session) {
    idleClose(jobId);
    return;
  }
  closeNow(jobId);
}

// Close and stop tracking. Used at the end of a one-shot job and by the session
// idle timer.
function closeNow(jobId: bigint) {
  const j = active.get(jobId);
  if (j && j.delta > 0) {
    if (canSettle(jobId)) settle(jobId, flush(j));
    else console.log(`[job#${jobId}] ${flush(j)} tok written off at close: checkpoints required, none publishable`);
  }
  const t = idleTimers.get(jobId);
  if (t) { clearTimeout(t); idleTimers.delete(jobId); }
  queue = queue.then(() => sendChecked('closeJob', 'closeJob', [jobId], 120000n)
    .then(h => console.log(`[job#${jobId}] closed  ${EXPLORER}/tx/${h}`))
    .catch(e => console.log(`[job#${jobId}] close FAILED:`, (e as any).shortMessage ?? (e as any).message)));
  active.delete(jobId);
  // Deleted here and not at end of stream: a session job serves many turns on
  // one jobId and the published height has to survive between them, or the
  // next turn's first checkpoint claims a height the chain already holds and
  // reverts on "checkpoint must advance".
  progress.delete(jobId);
}

// Restart the idle countdown for a session job. Every turn pushes it back; a
// guest who walks away has their escrow released after SESSION_IDLE_MS rather
// than never.
function idleClose(jobId: bigint) {
  const prev = idleTimers.get(jobId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    console.log(`[job#${jobId}] session idle for ${Math.round(SESSION_IDLE_MS / 1000)}s, closing`);
    closeNow(jobId);
  }, SESSION_IDLE_MS);
  // Do not hold the process open for an idle guest.
  if (typeof t.unref === 'function') t.unref();
  idleTimers.set(jobId, t);
  console.log(`[job#${jobId}] left open for the session, idle close in ${Math.round(SESSION_IDLE_MS / 1000)}s`);
}

// Bounded body read. The old version appended every chunk to a string with no
// ceiling, so a large or hostile POST grew memory without limit.
function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
  return new Promise(resolve => {
    let body = '';
    let over = false;
    req.on('data', c => {
      if (over) return;
      body += c;
      if (body.length > MAX_BODY) {
        over = true;
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'body too large', maxBytes: MAX_BODY }));
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => { if (!over) resolve(body); });
    req.on('error', () => { if (!over) resolve(null); });
  });
}

function gate(res: http.ServerResponse, prompt: string, resumeText = '', fmt?: (message: string, code: string) => string): boolean {
  // One set of admission conditions, two ways of writing the refusal down.
  // `fmt` renders the OpenAI error envelope for a /v1 caller, whose client
  // parses that shape and nothing else. Without it the native bodies go out
  // exactly as they always have, extra fields included, because the browser
  // reads those fields.
  // Backpressure is a 429 on the OpenAI path and a 503 on the native one, and
  // the difference is not cosmetic. OpenRouter scores provider uptime as total
  // requests minus 4xx, 429s and 403 geo-blocks, and asks providers to return
  // early 429s under load rather than queueing. A 503 for "host busy" would be
  // counted as downtime, so an honest refusal to overload the machine would
  // read as a node that falls over. Running out of gas stays a 503 on both,
  // because that one is this node failing rather than shedding load.
  const busy = fmt ? 429 : 503;
  const refuse = (status: number, retry: string | null, code: string, message: string, native: unknown) => {
    res.statusCode = status;
    if (retry) res.setHeader('retry-after', retry);
    res.setHeader('content-type', 'application/json');
    res.end(fmt ? fmt(message, code) : JSON.stringify(native));
    return false;
  };
  // Checked before pressure, because this one is not a wait-and-retry: no
  // amount of patience refills the wallet, and accepting the job would mean
  // producing tokens that can never be settled.
  if (brokeForGas()) {
    return refuse(503, '300', 'provider_out_of_gas',
      `provider out of gas: balance ${String(providerBalance ?? 0n)} wei against a floor of ${String(gasFloorWei())} wei`,
      { error: 'provider out of gas', balanceWei: String(providerBalance ?? 0n), needWei: String(gasFloorWei()), settles: MIN_GAS_SETTLES });
  }
  if (pressure() > THRESHOLDS.hard) {
    return refuse(busy, '15', 'host_busy',
      `host busy: pressure ${pressure().toFixed(2)} with priority ${PRIORITY}`,
      { error: 'host busy', priority: PRIORITY, pressure: Number(pressure().toFixed(2)) });
  }
  if (inFlight >= MAX_CONCURRENT) {
    return refuse(busy, '10', 'all_burners_in_use',
      `all burners in use: ${inFlight} of ${MAX_CONCURRENT}`,
      { error: 'all burners in use', active: inFlight, max: MAX_CONCURRENT });
  }
  // Resumed text is replayed into the engine as context, so it consumes the
  // same context window the prompt does. Gating on the prompt alone let a
  // caller ship up to MAX_BODY of "resume" past a check that thought the
  // request was small, which is free compute and a prompt-injection path.
  const n = estTokens(prompt) + estTokens(resumeText);
  if (n > PROMPT_BUDGET) {
    return refuse(413, null, 'context_length_exceeded',
      `prompt is about ${n} tokens against a budget of ${PROMPT_BUDGET} in a ${CONTEXT_TOKENS} token context`,
      { error: 'prompt exceeds context window', estimatedTokens: n, promptBudget: PROMPT_BUDGET, contextTokens: CONTEXT_TOKENS });
  }
  inFlight++;
  return true;
}

/**
 * Gas floor. Below this the node stops accepting work.
 *
 * Found by running out. The provider wallet reached 0.0007 MON mid-test and
 * every settle reverted with "Signer had insufficient balance", while the node
 * carried on serving: one plan run produced 5,907 billed tokens and settled
 * none of them. The guest got the work free, the operator paid the electricity,
 * and /health went on advertising `accepting: true` throughout.
 *
 * A node that cannot pay to be paid is not open for business, and saying so is
 * the difference between a node that is down and a node that is quietly
 * working for nothing. Sized at about ten settles at the last observed gas
 * price, so the floor moves with the base fee rather than being a constant
 * that stops meaning anything during a spike.
 */
const MIN_GAS_SETTLES = Number(process.env.MIN_GAS_SETTLES ?? 10);
let providerBalance: bigint | null = null;
const gasFloorWei = () => settleGasUnits * gasPriceWei * BigInt(MIN_GAS_SETTLES);
/** null while the first balance read is still outstanding, so a node does not
 *  refuse work on startup merely because it has not looked yet. */
const brokeForGas = () => providerBalance !== null && providerBalance < gasFloorWei();
const refreshProviderBalance = async () => {
  try {
    const b = await pub.getBalance({ address: me });
    const wasBroke = brokeForGas();
    providerBalance = b;
    if (brokeForGas() && !wasBroke) {
      console.log(`GAS: balance ${formatEther(b)} MON is under ${formatEther(gasFloorWei())} `
        + `(${MIN_GAS_SETTLES} settles). Refusing new work until it is topped up.`);
    } else if (!brokeForGas() && wasBroke) {
      console.log(`GAS: balance ${formatEther(b)} MON, accepting work again`);
    }
  } catch { /* a read failure is not evidence of being broke */ }
};
refreshProviderBalance();
setInterval(refreshProviderBalance, 30000).unref?.();

// Registration needs gas. Setup funds the wallet from the faucet, but the
// faucet returns before the transfer confirms, so a node started immediately
// after can come up, fail to register, and listen forever as a provider no
// guest can find. That failure used to be one line of log and nothing else.
// Wait for the balance, then retry, then say plainly whether this node is
// discoverable.
const REGISTER_MIN_BALANCE = 10n ** 16n; // 0.01 MON, one registration's gas

async function register(e: Engine): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const bal = await pub.getBalance({ address: me }).catch(() => 0n);
    if (bal >= REGISTER_MIN_BALANCE) break;
    if (i === 0) console.log(`waiting for gas — ${me} holds ${formatEther(bal)} MON`);
    await sleep(5000);
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Estimated rather than padded. Monad charges the gas LIMIT, not the
      // usage, so a fixed 250000 against a measured 126392 first-time and
      // 29665 warm was paying up to 8.4x for this call on every restart.
      const rargs = [e.model, describeHardware(HW), RATE, MAX_TOKENS_PER_SECOND] as const;
      const h = await w.writeContract({
        address: ADDR, abi: ABI, functionName: 'registerProvider',
        args: rargs, gas: await gasFor('registerProvider', rargs, 250000n), maxFeePerGas: 2000000000000n,
      });
      await pub.waitForTransactionReceipt({ hash: h });
      console.log(`registered ${e.kind}/${e.model}\n  tx: ${EXPLORER}/tx/${h}`);
      break;
    } catch (err: any) {
      const msg = err?.shortMessage ?? err?.message ?? String(err);
      console.log(`register attempt ${attempt}/3 failed: ${msg}`);
      if (attempt < 3) await sleep(5000 * attempt);
    }
  }

  // Whatever happened above, the only thing that matters is what the registry
  // says. A node that is not active here earns nothing, however healthy it
  // looks locally.
  try {
    const p = await readProvider(me);
    if (p.active) console.log(`registry: active as ${p.model} at ${p.ratePerMillion} wei per million tokens`);
    else console.log('\n  !  NOT REGISTERED — this node is invisible to guests and will earn nothing.\n' +
                     `     fund ${me} with testnet MON and restart.\n`);
  } catch {
    console.log('  !  could not read the registry to confirm registration');
  }
}

/**
 * One short generation, after warming, to learn what this machine's guests are
 * actually in for. Runs in the background: a slow node must not be a node that
 * takes ninety seconds to start listening.
 */
function measureFirstToken(model: string): void {
  const t0 = Date.now();
  fetch('http://localhost:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Streamed, uncapped, and read until the first VISIBLE character.
      //
      // This was `stream: false, num_predict: 1`, which on a reasoning model
      // measures nothing a guest experiences. Ollama returns thinking in a
      // separate `thinking` field and num_predict counts those tokens, so the
      // probe stopped after one thinking token and reported 616 ms while the
      // real wait on this node is 15 s for a short question and 47 s for a long
      // one. The browser sizes its abort budget from this number, so publishing
      // 616 ms told every guest to give up while the model was still thinking.
      //
      // The prompt is a real question rather than 'hi', because how long a
      // reasoning model thinks depends on what it was asked, and 'hi' is the
      // one input it will not think about.
      model, prompt: 'In two sentences, what is idle compute?', stream: true,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? '30m',
      options: { num_ctx: CONTEXT_TOKENS },
    }),
  }).then(async r => {
    if (!r.ok || !r.body) return;
    const rd = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let seen = false;
    outer: for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (typeof j.response === 'string' && j.response.length) { seen = true; break outer; }
          if (j.done) break outer;
        } catch { /* partial frame */ }
      }
    }
    try { await rd.cancel(); } catch { /* already closed */ }
    if (!seen) return;
    firstTokenMs = Date.now() - t0;
    // /api/ps reports how much of the model ollama could keep in VRAM. Anything
    // below 1 means layers are running on the CPU, which is the usual reason
    // firstTokenMs is large.
    const ps = await fetch('http://localhost:11434/api/ps').then(x => x.json() as Promise<any>).catch(() => null);
    const m = ps?.models?.find((x: any) => x.name === model || x.model === model);
    if (m?.size > 0) gpuFraction = Math.min(1, (m.size_vram ?? 0) / m.size);
    const pct = gpuFraction === null ? '' : `, ${Math.round(gpuFraction * 100)}% on GPU`;
    console.log(`first token in ${(firstTokenMs / 1000).toFixed(1)}s${pct}`);
    if (firstTokenMs > 20000) {
      console.log('  !  that is slow enough that guests will time out. This model does not fit in\n' +
                  '     this machine\'s VRAM at the current context. Run: npm run setup');
    }
  }).catch(() => { /* a node that cannot measure still serves */ });
}

/**
 * Open a job this node pays for itself, and return its id.
 *
 * Two callers, one shape. The LAN guest page, where the point is that someone
 * on the wifi needs no wallet, and `/v1/chat/completions`, where the caller
 * holds an API key instead of a key pair. In both the node fronts the escrow
 * from its own deposit and settles against itself.
 *
 * That narrows what the chain proves for these jobs, and the narrowing is the
 * part to keep straight: the settlement still records what was served and what
 * was charged, checkpoint by checkpoint, but it no longer records who paid.
 * A guest ordering from the browser signs their own openJob and that claim is
 * unchanged. Nothing here should be described as the buyer paying on chain.
 *
 * It has a second consequence, found by running this against a local chain
 * rather than by reading the contract. `_credit` excludes self-dealt jobs from
 * `tokensServed` and `lifetimeEarned`, on purpose, because discovery ranks on
 * `tokensServed` and a provider paying itself in a loop would climb it. Every
 * job opened here is self-dealt, so traffic through this path earns real money
 * into `earned` and builds no on-chain reputation at all. That is the contract
 * behaving correctly. It does mean volume on the OpenAI endpoint is invisible
 * to discovery, and any claim about tokens served has to say which path they
 * came through.
 */
async function openFronted(prompt: string): Promise<bigint> {
  const budget = FRONT_BUDGET;

  // The prompt itself must never reach the chain. openJob's tag is a
  // public event field, so it carries a commitment, not 40 characters of
  // whatever the guest typed.
  //
  // Salted, for the same reason the browser path is salted. Prompts are
  // low-entropy natural language, so an unsalted keccak of one is
  // recoverable from the public event with a candidate dictionary. The
  // salt is 32 random bytes, used once and discarded here, and matches
  // web/src/App.tsx byte for byte.
  //
  // Precise wording matters here, because the term selects which rule
  // applies. This is a SALTED HASH under EDPB Guidelines 02/2025 v2.0
  // para 52, not a commitment under the para 53 carve-out: keccak is
  // computationally hiding, and para 53 requires a perfectly hiding scheme
  // (Pedersen and similar). Para 52's conditions are met, since the salt is
  // CSPRNG and destroyed before this function returns, so the tag is not
  // linkable to the prompt. But para 52 also says the hash is itself
  // personal data at the moment it is written. Do not claim the carve-out.
  const salt = toHex(randomBytes(32));
  const tag = keccak256(stringToHex(salt + '|' + String(prompt)));
  // The balance check and the opening are one serialized unit, and that is the
  // whole point rather than a detail. Each opening escrows `budget` out of the
  // deposit, so two openings that check the balance concurrently both see
  // enough for one job and the second reverts. Found by firing four requests at
  // once: three came back with no JobOpened event in the receipt.
  return serialized(async () => {
    const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [me] }) as bigint;
    if (dep < budget) {
      // Sized from the balance rather than fixed, and this is the difference
      // between a float and an outage. `gate()` admits work on gas headroom
      // alone and is blind to the native value the next step is about to
      // spend, so a fixed 0.1 MON deposit from a wallet holding 0.2 could take
      // the node below its own gas floor on ONE request and stop it accepting
      // work until someone noticed. The money is not lost, it is escrowed, but
      // the node is off.
      const spare = (providerBalance ?? 0n) - gasFloorWei() - 200000n * gasPriceWei;
      const topup = FRONT_TOPUP < spare ? FRONT_TOPUP : spare;
      if (topup < budget) throw new Error(`provider balance too low to escrow a job: ${formatEther(providerBalance ?? 0n)} MON, and the gas floor is ${formatEther(gasFloorWei())}`);
      const dh = await w.writeContract({
        address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: topup,
        // Measured at 55094 against the fixed 200000 this used to send, so 3.6x.
        // The value has to reach the estimate or it prices a reverting call.
        gas: await gasFor('deposit', [], 200000n, topup), maxFeePerGas: 2000000000000n,
      });
      const drc = await pub.waitForTransactionReceipt({ hash: dh });
      if (drc.status !== 'success') throw new Error(`deposit reverted ${EXPLORER}/tx/${dh}`);
    }
    const oargs = [me, budget, tag, true] as const;
    // Measured at 166702 against 250000 here and 300000 in the browser.
    const h = await w.writeContract({
      address: ADDR, abi: ABI, functionName: 'openJob', args: oargs,
      gas: await gasFor('openJob', oargs, 250000n), maxFeePerGas: 2000000000000n,
    });
    const rc = await pub.waitForTransactionReceipt({ hash: h });
    // Checked rather than assumed. A reverted opening still returns a receipt,
    // and reading the event off it produced "cannot read properties of
    // undefined" where the real answer was that the deposit was spent.
    if (rc.status !== 'success') throw new Error(`openJob reverted ${EXPLORER}/tx/${h}`);
    const [log] = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' });
    if (!log) throw new Error(`openJob produced no JobOpened event ${EXPLORER}/tx/${h}`);
    return log.args.jobId as bigint;
  });
}

/**
 * Every model id this node will accept on the OpenAI-compatible path.
 *
 * The engine's tag is what the machine actually runs. The market id is the
 * OpenRouter listing the price was resolved from, which is the string an
 * aggregator is likelier to send. Both name the same weights on this node.
 */
function servedIds(engineModel: string): string[] {
  const ids = [engineModel];
  if (pricing?.orId && pricing.orId !== engineModel) ids.push(pricing.orId);
  return ids;
}

/**
 * The key check for /v1.
 *
 * Unset keys mean closed. This is the one path where a caller spends the
 * node's deposit rather than their own, so the failure mode of a missing
 * variable has to be a node that serves nobody rather than a node that serves
 * everybody. 501 rather than 401, because the endpoint is absent on this node
 * rather than the credential wrong.
 */
function v1Auth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  res.setHeader('content-type', 'application/json');
  if (!V1_KEYS.length) {
    res.statusCode = 501;
    res.end(errorBody('this node does not serve the OpenAI-compatible API: no API_KEYS are set', 'invalid_request_error', 'endpoint_disabled'));
    return false;
  }
  if (!authorize(req.headers.authorization, V1_KEYS)) {
    res.statusCode = 401;
    res.setHeader('www-authenticate', 'Bearer');
    res.end(errorBody('invalid or missing API key', 'authentication_error', 'invalid_api_key'));
    return false;
  }
  return true;
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, bypass-tunnel-reminder, ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.setHeader('content-type', 'text/html'); return res.end(GUEST_HTML);
  }
  if (req.method === 'GET' && req.url === '/health') {
    const e = await engineP;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({
      provider: me, engine: e.kind, model: e.model, port: PORT,
      ratePerMillion: String(RATE),
      // Published so the price can be checked rather than trusted. A buyer
      // comparing us looks at the same OpenRouter listing this is derived
      // from, so the claim "below the median of N providers for the model we
      // actually serve" is verifiable in one request.
      pricing: pricing && {
        usdPerMillion: Number(pricing.usdPerMillion.toFixed(4)),
        source: pricing.source, reference: pricing.orId,
        policy: pricing.policy, discount: pricing.discount,
        band: pricing.band, monUsd: MON_USD,
        breakEvenTokens: breakEvenTokens(settleGasUnits, gasPriceWei, RATE),
        // We bill output only. settle() charges tokensDelta, which counts
        // tokens this node GENERATED, so a guest's prompt is free however long
        // it is. Every provider on the reference listing bills input, so an
        // output-to-output comparison understates the difference, and the
        // crossover is the honest form of the claim: it is worth a specific
        // amount, and that amount is a ratio.
        input: pricing.band?.endpoints?.length ? {
          weCharge: 0,
          cheaperThanOnOutputAlone: cheaperThanCount(pricing.band, pricing.usdPerMillion, 0),
          cheaperThanAt1to1: cheaperThanCount(pricing.band, pricing.usdPerMillion, 1),
          cheaperThanAt4to1: cheaperThanCount(pricing.band, pricing.usdPerMillion, 4),
          of: pricing.band.endpoints.length,
          crossoverVsCheapest: {
            provider: pricing.band.endpoints[0].name,
            theirOutput: pricing.band.endpoints[0].outUsd,
            theirInput: pricing.band.endpoints[0].inUsd,
            promptToAnswerRatio: Number(crossoverRatio(pricing.band.endpoints[0], pricing.usdPerMillion).toFixed(2)),
          },
        } : null,
      },
      contextTokens: CONTEXT_TOKENS, promptBudget: PROMPT_BUDGET, checkpointEvery: CHECKPOINT_EVERY,
      maxBodyBytes: MAX_BODY, maxConcurrent: MAX_CONCURRENT, activeJobs: active.size,
      // The guest closes an unfinished job to recover its escrow, and closing
      // before this node's last flush lands trips settle()'s require(j.open)
      // and takes tokens the guest already received without paying for them.
      // Published so the browser waits on THIS node's cadence rather than on a
      // constant that silently stopped matching when the cadence changed.
      settleMaxMs: SETTLE_MAX_MS, settleGasMultiple: Number(SETTLE_GAS_MULTIPLE),
      settleGasUnits: Number(settleGasUnits),
      // Advertised so a client can tell a node that executes plans from one
      // that only serves single prompts, rather than discovering it from a
      // 404 after opening a job.
      plans: { supported: true, limits: PLAN_LIMITS },
      // Advertised for the same reason plans are: a client should be able to
      // tell that this node takes a stock OpenAI request without discovering
      // it from a 501. `supported` is false on a node whose operator has set
      // no keys, which is the default.
      openai: {
        supported: V1_KEYS.length > 0,
        path: '/v1/chat/completions',
        models: servedIds(e.model),
        maxCompletionTokens: OUTPUT_RESERVE,
        dailyTokenCap: V1_DAILY_TOKENS,
        dailyTokensLeft: v1Remaining(),
        // Said plainly, because it is the part a buyer would otherwise assume
        // wrongly: a job opened through this endpoint is escrowed by the node,
        // so the settlement records what was served, not who paid.
        settlement: 'fronted by the provider',
      },
      priority: PRIORITY, pressure: Number(pressure().toFixed(2)),
      // null until the startup measurement lands, a few seconds in.
      firstTokenMs, gpuFraction, hardware: describeHardware(HW),
      accepting: !brokeForGas() && pressure() <= THRESHOLDS.hard && active.size < MAX_CONCURRENT,
      // Published rather than implied. A node that cannot settle looks exactly
      // like a working node from the outside, which is how one served 5,907
      // tokens for free.
      gas: {
        balanceWei: String(providerBalance ?? 0n),
        floorWei: String(gasFloorWei()),
        settlesCovered: providerBalance === null ? null
          : Number(providerBalance / (settleGasUnits * gasPriceWei)),
        ok: !brokeForGas(),
      },
    }));
  }

  // The aggregator's view of this node, in OpenRouter's provider schema.
  //
  // Unauthenticated on purpose, unlike /v1/models: it is a price list and a
  // capability list, both of which a router has to be able to read before it
  // holds a key, and neither of which is a secret. `is_ready` is false until
  // the operator sets PROVIDER_IS_READY, so publishing this does not by itself
  // invite traffic.
  if (req.method === 'GET' && req.url === '/provider/models') {
    const e = await engineP;
    res.setHeader('content-type', 'application/json');
    return res.end(catalogDocument(servedIds(e.model).map(id => ({
      id,
      name: `${e.model} on ${describeHardware(HW)}`,
      // The price this node actually charges, resolved from the same public
      // band a buyer would check, not a number typed into a listing.
      usdPerMillion: pricing ? pricing.usdPerMillion : usdPerMillion(RATE, MON_USD),
      contextTokens: CONTEXT_TOKENS,
      maxOutputTokens: OUTPUT_RESERVE,
      // Measured at startup, or null. firstTokenMs is a latency, so it is not
      // the figure here: this is generation rate, which the node knows only
      // once it has served something. Left null rather than guessed.
      tokensPerSecond: measuredTokensPerSecond,
      maxConcurrent: MAX_CONCURRENT,
      countryCode: DATACENTER_COUNTRY,
      region: DATACENTER_REGION,
      isReady: PROVIDER_IS_READY,
    }))));
  }

  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    if (!v1Auth(req, res)) return;
    const e = await engineP;
    return res.end(modelsBody(servedIds(e.model), me, Math.floor(Date.now() / 1000)));
  }

  if (req.method !== 'POST') { res.statusCode = 404; return res.end(); }
  const body = await readBody(req, res);
  if (body === null) return;

  // gate() reserves a slot when it admits a request; this releases it once the
  // response is over, however it ends.
  let admitted = false;
  const release = () => { if (admitted) { admitted = false; inFlight = Math.max(0, inFlight - 1); } };
  res.on('close', release);
  res.on('finish', release);

  try {
    // The OpenAI-compatible path.
    //
    // It exists for one reason: no aggregator lists a provider it cannot call
    // with a stock client, and distribution rather than mechanism is what this
    // project lacks. What it costs is stated in `openFronted`: the caller holds
    // a key, not a wallet, so these jobs settle the node against itself.
    if (req.url === '/v1/chat/completions' || req.url === '/chat/completions') {
      if (!v1Auth(req, res)) return;
      const e = await engineP;
      // The envelope a client of this endpoint can parse. gate() and the rest
      // of this branch write refusals through it rather than in the native
      // shape the browser reads.
      const fmt = (m: string, c: string) => errorBody(m, 'invalid_request_error', c);
      const room = v1Remaining();
      if (room <= 0) {
        res.statusCode = 429;
        res.setHeader('retry-after', '3600');
        res.setHeader('content-type', 'application/json');
        return res.end(errorBody(`this node has billed its daily ceiling of ${V1_DAILY_TOKENS} tokens on this endpoint`, 'rate_limit_error', 'daily_token_cap'));
      }
      // The ceiling is the smaller of what the context reserves for output and
      // what is left of the day, so a caller is never quoted a limit the node
      // will not honour.
      const parsed = parseChat(body, { maxTokensCeiling: Math.min(OUTPUT_RESERVE, room) });
      if (!parsed.ok) {
        res.statusCode = parsed.rej.status;
        res.setHeader('content-type', 'application/json');
        return res.end(parsed.rej.body);
      }
      const cr = parsed.req;
      // A node serves one model. Answering a request for a different one with
      // this model's output would be a silent substitution, so it is a 404
      // naming what is actually served.
      const ids = servedIds(e.model);
      if (cr.model && !ids.includes(cr.model)) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        return res.end(errorBody(`this node serves ${ids.join(' and ')}, not ${cr.model}`, 'invalid_request_error', 'model_not_found', 'model'));
      }
      if (!gate(res, cr.prompt, '', fmt)) return;
      admitted = true;
      // Opening the job is two transactions and can fail on its own: an RPC
      // that is down, a deposit that will not land. Caught here so the caller
      // gets the envelope its client parses rather than the plain string the
      // outer handler ends with.
      let jobId: bigint;
      try {
        jobId = await openFronted(cr.prompt);
      } catch (err: any) {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        return res.end(errorBody(`could not open a job on chain: ${String(err?.shortMessage ?? err?.message ?? err)}`, 'server_error', 'chain_unavailable'));
      }
      return serveJob(jobId, cr.prompt, res, undefined, false, {
        // The daily ceiling only means anything if every path that bills
        // advances it, including the ones that never reach a clean end.
        onBilled: tokens => { v1Spent += tokens; },
        // The completion id carries the job id, so a caller holding a response
        // can find the settlement that paid for it on chain. It is the only
        // part of the on-chain rail this wire can expose.
        wire: openaiWire(res, {
          id: `chatcmpl-dn${jobId}`,
          // The model that answered, not the model that was asked for. They
          // are the same string by the check above, and where a client sent
          // nothing this says what it got.
          model: e.model,
          stream: cr.stream, includeUsage: cr.includeUsage,
          // Estimated, and charged at zero. The serving instruction is included
          // because it occupies the context the same way the prompt does.
          promptTokens: estTokens(cr.prompt) + SYSTEM_TOKENS,
        }),
        maxTokens: cr.maxTokens ?? undefined,
      });
    }

    // Proof that this machine holds the provider key, for a caller that was
    // handed this URL by something it does not trust. `?host=` and `?peer=`
    // both name a machine and then read a provider address out of that
    // machine's own /health, which is a claim checking itself. A hostile host
    // can never be PAID, since settlement goes to a registered address on
    // chain, but it receives the prompt and the partial answer, and that is
    // the loss this closes.
    //
    // The caller chooses the nonce, so nothing here is replayable and this
    // node keeps no state. It is a signing oracle over one fixed message
    // shape, which is safe exactly because the shape is fixed: the nonce is
    // the only caller-controlled field and it must be 64 hex characters, so
    // no caller can insert a line into the claim.
    //
    // Outside the admission gate on purpose. Proving identity must not be
    // refused because the burners are full, or a busy node looks like an
    // impostor.
    if (req.url === '/challenge') {
      const { nonce } = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      if (!validNonce(nonce)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'nonce must be 0x and 64 lowercase hex characters' }));
      }
      // This node's OWN configured URL, and nothing derived from the request.
      //
      // The relay is the attack: a hostile host at evil.example forwards the
      // browser's nonce here and returns the signature it gets. Signing the
      // Host header would sign whatever the relay put in it, which is
      // evil.example, and hand the attacker precisely the signature they
      // asked for. Signing PUBLIC_URL instead means a relayed answer names
      // THIS node, the browser compares it against the origin it dialed, and
      // the mismatch skips the relay.
      //
      // A node with no PUBLIC_URL cannot prove anything to a remote browser
      // and says so, rather than signing a claim it cannot stand behind. That
      // is the correct answer for a LAN-only node reached through a link.
      if (!PUBLIC_URL) {
        res.statusCode = 409;
        return res.end(JSON.stringify({
          error: 'this node has no public URL, so it cannot prove which origin it answers on',
          fix: 'set PUBLIC_URL, or let the node open a quick tunnel by leaving TUNNEL unset',
        }));
      }
      const url = originOf(PUBLIC_URL);
      const message = controlMessage({ registry: ADDR, chainId: monadTestnet.id, address: me, url, nonce });
      const signature = await w.signMessage({ message });
      return res.end(JSON.stringify({ address: me, registry: ADDR, chainId: monadTestnet.id, url, nonce, message, signature }));
    }

    if (req.url === '/lanjob') {
      // Checked before anything is parsed, because this endpoint opens a job
      // the NODE pays for. It was safe for one reason only: nobody outside the
      // flat could reach port 4173. A tunnel ends that, and it ends it
      // invisibly, since every tunnelled request arrives from 127.0.0.1.
      if (LANJOB !== 'open') {
        const r = reach(req.socket.remoteAddress, req.headers);
        if (LANJOB === 'off' || !r.local) {
          console.log(`[lanjob] refused: ${LANJOB === 'off' ? 'disabled by LANJOB=off' : r.why}`);
          res.statusCode = 403;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({
            error: 'the free LAN path serves this network only',
            reason: LANJOB === 'off' ? 'disabled by the operator' : r.why,
            // Said plainly, because the person reading it is either a guest on
            // the wrong network or an operator who has just put a tunnel in
            // front of their node and wants to know why ordering stopped.
            useInstead: '/v1/chat/completions with an API key, or order from the site with your own wallet',
          }));
        }
      }
      const { prompt } = JSON.parse(body || '{}');
      if (!gate(res, String(prompt ?? ''))) return;
      admitted = true;
      return serveJob(await openFronted(String(prompt)), String(prompt), res);
    }

    if (req.url === '/job') {
      const { jobId, prompt, resume, session } = JSON.parse(body);
      if (!gate(res, String(prompt ?? ''), String(resume?.text ?? ''))) return;
      admitted = true;
      const job = await readJob(BigInt(jobId));
      if (!isMine(job, me)) { res.statusCode = 400; return res.end('job not mine / closed'); }

      // A resume is only honoured if the claimed prefix hashes to the
      // checkpoint the previous provider published. Otherwise a client could
      // hand us any text and have it treated as already-paid-for work.
      let r: { text: string; n: number } | undefined;
      if (resume?.text) {
        if (keccak256(stringToHex(String(resume.text))) !== String(resume.h)) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'checkpoint hash mismatch' }));
        }
        r = { text: String(resume.text), n: Number(resume.n ?? 0) };
      }
      return serveJob(BigInt(jobId), prompt, res, r, session === true);
    }

    // ---- plan as a job ---------------------------------------------------
    //
    // Two endpoints, deliberately separate. /plan produces a plan and charges
    // for the tokens that produced it; /plan/run executes one the guest has
    // seen and accepted. Splitting them is the whole point of the shape: the
    // guest approves a committed ceiling BEFORE any step runs, and the plan
    // that was approved is identified by its hash rather than by trust.
    //
    // Both bill through the same `active` map serveJob uses, so the existing
    // value-triggered settle ticker pays this node out mid-run without any
    // second billing path to keep in sync.

    if (req.url === '/plan') {
      const { jobId, goal } = JSON.parse(body);
      if (!gate(res, String(goal ?? ''))) return;
      admitted = true;
      const job = await readJob(BigInt(jobId));
      if (!isMine(job, me)) { res.statusCode = 400; return res.end('job not mine / closed'); }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
      const id = BigInt(jobId);
      const e = await engineP;
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 1000);
      active.set(id, newLedger());
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      console.log(`[job#${id}] planning ${estTokens(String(goal))} tok goal via ${e.kind}/${e.model}`);

      // Planning IS generation and is billed as such. A plan for a real goal
      // measured 8.4 minutes on this node, which is not compute to give away,
      // and an unbilled planner would be the same defect as the cloud kitchen
      // serving canned text while settling real MON.
      const billed = async function* (prompt: string) {
        for await (const c of e.gen(prompt, ac.signal)) {
          // Held, not billed. Planning is atomic: the guest either gets a valid
          // plan or gets nothing, so nothing is invoiced until makePlan returns
          // ok. Job#75 charged 0.2736 MON for planning that produced no plan.
          hold(active.get(id)!);
          if (c.th !== undefined) res.write(`data: ${JSON.stringify({ th: c.th })}\n\n`);
          else res.write(`data: ${JSON.stringify({ t: c.t })}\n\n`);
          yield c.th !== undefined ? '' : c.t;
        }
      };

      const budgetWei = remaining(job);
      const attempt = await makePlan(String(goal), billed, { budgetWei, ratePerMillion: RATE });
      clearInterval(hb);
      if (!res.writableEnded) {
        res.write(attempt.ok
          ? `data: ${JSON.stringify({
              plan: attempt.plan,
              planHash: planHash(attempt.plan!),
              costWei: String(planCostWei(attempt.plan!, RATE)),
              summary: describePlan(attempt.plan!, RATE),
              attempts: attempt.attempts,
            })}\n\n`
          : `data: ${JSON.stringify({ err: 'planner did not produce a valid plan', issues: attempt.issues, attempts: attempt.attempts })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      // Planning is atomic: a valid plan or nothing. Only a plan the guest can
      // actually run is invoiced, so a planner that burned its budget and
      // produced nothing costs this node the compute rather than the guest the
      // MON. This is the case job#75 got wrong.
      const jp = active.get(id)!;
      if (attempt.ok) bill(jp);
      else {
        const n = writeOff(jp);
        if (n > 0) console.log(`[job#${id}] planning produced no valid plan, ${n} tok written off unbilled`);
      }
      if (jp.delta > 0) settle(id, flush(jp));
      // Planning leaves the job OPEN by default. The guest's next call is
      // /plan/run against the same escrow, and closing here would make them
      // pay openJob twice to use the plan they just bought.
      idleClose(id);
      return;
    }

    if (req.url === '/plan/run') {
      const { jobId, plan } = JSON.parse(body);
      // Gated on the largest single step rather than on the whole plan: steps
      // are sent to the engine one prompt at a time, so the plan total is not
      // what has to fit a context window.
      const biggest = Array.isArray(plan?.steps)
        ? plan.steps.reduce((n: number, st: any) => Math.max(n, String(st?.prompt ?? '').length), 0)
        : 0;
      if (!gate(res, 'x'.repeat(biggest))) return;
      admitted = true;

      const job = await readJob(BigInt(jobId));
      if (!isMine(job, me)) { res.statusCode = 400; return res.end('job not mine / closed'); }

      // Re-validated here rather than trusted from the caller. The plan
      // arrives over the wire and nothing proves it is the one this node
      // produced, so the caps are enforced again against the escrow that is
      // actually left on this job.
      const left = remaining(job);
      const v = validatePlan(plan, { budgetWei: left, ratePerMillion: RATE });
      if (!v.ok) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'plan rejected', issues: v.issues, remainingWei: String(left) }));
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
      const id = BigInt(jobId);
      const e = await engineP;
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 1000);
      active.set(id, newLedger());
      const ac = new AbortController();
      res.on('close', () => ac.abort());

      const p = plan as Plan;
      // The hash is echoed so the guest can check that what ran is what they
      // approved. It is not yet checked against a chain commitment, because
      // DinnerNodeV2 has no commitPlan; see TODO.md P1.
      res.write(`data: ${JSON.stringify({ run: { planHash: planHash(p), steps: p.steps.length, costWei: String(planCostWei(p, RATE)) } })}\n\n`);
      console.log(`[job#${id}] running plan ${planHash(p)} (${p.steps.length} steps) via ${e.kind}/${e.model}`);

      // v1 dispatches every step to this node's own engine. The signature is
      // the seam a peer's /job plugs into later without touching the executor.
      // Thinking off for plan steps. A step is a bounded piece of work under a
      // ceiling the guest approved, and reasoning is billed: measured on this
      // node, three steps at a 3,072 ceiling each spent the whole ceiling
      // reasoning and produced nothing at all. The planner still reasons,
      // because choosing the shape of the work is exactly the case reasoning
      // is worth paying for.
      const dispatch: Dispatch = (_step, prompt, signal) => e.gen(prompt, signal, { think: false });

      try {
        for await (const ev of executePlan(p, dispatch, {
          promptBudget: PROMPT_BUDGET,
          estTokens,
          signal: ac.signal,
          // One at a time. This node serves one model, so a wave of four would
          // contend for the same GPU rather than finish sooner. Parallelism is
          // what the wave shape buys once steps go to different providers.
          maxParallel: 1,
        })) {
          if (res.writableEnded) break;
          // Billed exactly like serveJob: one frame is one token, reasoning
          // included, and the settle ticker does the rest.
          // Held per step, released per step. A step that completes delivered
          // its output and is invoiced the moment it lands; a step that fails
          // produced nothing usable and its tokens are dropped. Held tokens are
          // exact regardless of wave parallelism: every step's tokens accrue to
          // `hold`, step_done releases exactly that step's count, and whatever
          // is left when the run ends belongs to steps that failed or never
          // finished.
          if (ev.kind === 'token' || ev.kind === 'thought') hold(active.get(id)!);
          if (ev.kind === 'step_done') bill(active.get(id)!, ev.tokens);
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      } catch (err: any) {
        console.log(`[job#${id}] plan run error:`, err?.message ?? err);
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ err: String(err?.message ?? err) })}\n\n`);
      }

      clearInterval(hb);
      // Anything still held belongs to a step that failed, was aborted, or was
      // cut off by the engine error caught above. None of it reached the guest.
      const jr = active.get(id)!;
      const dropped = writeOff(jr);
      if (dropped > 0) console.log(`[job#${id}] ${dropped} tok written off unbilled (failed or aborted steps)`);
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
      if (jr.delta > 0) settle(id, flush(jr));
      idleClose(id);
      return;
    }

    res.statusCode = 404; res.end();
  } catch (e: any) {
    release();
    res.statusCode = 500;
    res.end(String(e?.shortMessage || e));
  }
}).listen(PORT, async () => {
  const e = await engineP;

  // Priced before registration, because registerProvider writes the rate on
  // chain and a node that registers first would advertise the wrong number
  // until its next restart.
  pricing = await resolveRate({
    model: e.model,
    overrideWei: process.env.RATE_PER_MILLION ? BigInt(process.env.RATE_PER_MILLION) : null,
    policy: PRICE_POLICY, discount: PRICE_DISCOUNT, monUsd: MON_USD,
  });
  if (pricing.ratePerMillionWei > 0n) RATE = pricing.ratePerMillionWei;
  console.log(`price ${describeRate(pricing)}`);
  const freeInput = describeFreeInput(pricing);
  if (freeInput) console.log(`price ${freeInput}`);
  if (pricing.source === 'none') {
    console.log(`price no market reference for ${e.model}; holding ${usdPerMillion(RATE, MON_USD).toFixed(3)}/M from the default`);
  }
  // The number that decides whether a short job is worth serving at all. It
  // moves with the price and with the base fee, so it is printed rather than
  // assumed: undercutting the market raises it, and at some price a chat turn
  // costs more gas than the tokens are worth.
  console.log(`price break-even ${breakEvenTokens(settleGasUnits, gasPriceWei, RATE)} tokens per settle at ${Number(gasPriceWei) / 1e9} gwei`);

  await register(e);
  const lan = Object.values(os.networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
  console.log(`\nprovider ${me} listening on :${PORT}`);
  console.log(`priority=${PRIORITY} soft=${THRESHOLDS.soft} hard=${THRESHOLDS.hard} maxConcurrent=${MAX_CONCURRENT}`);
  console.log(`prompt budget ${PROMPT_BUDGET} tok of ${CONTEXT_TOKENS} context`);
  console.log(`LAN guest page (same wifi, zero setup): http://${lan ?? 'localhost'}:${PORT}`);

  // Pull the model into VRAM now rather than making the first guest wait for
  // it. An empty prompt asks ollama to load and return without generating.
  // Non-fatal: a node that cannot preload can still serve, just slowly.
  if (e.kind === 'ollama') {
    const t0 = Date.now();
    console.log(`warming ${e.model}…`);
    await fetch('http://localhost:11434/api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // Same num_ctx as the serving path. Ollama sizes the KV cache from it, so
      // warming at a different value loads the model twice.
      body: JSON.stringify({
        model: e.model, prompt: '', keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? '30m',
        options: { num_ctx: CONTEXT_TOKENS },
      }),
    }).then(r => console.log(r.ok
      ? `warm in ${((Date.now() - t0) / 1000).toFixed(1)}s`
      : `warm failed: ollama ${r.status}`))
      .catch(err => console.log('warm failed (non-fatal):', err?.message ?? err));
    measureFirstToken(e.model);
  }
  // A public URL before the first announce, for the operator who installed
  // cloudflared and nothing else. Awaited rather than fired and forgotten: the
  // announce below has to carry the URL, and a signed announcement naming an
  // empty one is worse than a late one.
  if (!PUBLIC_URL && TUNNEL !== 'off') {
    const t = await startQuickTunnel(PORT);
    if (t) {
      PUBLIC_URL = t.url;
      console.log(`public url ${PUBLIC_URL} (quick tunnel, new hostname on every restart)`);
      console.log('  for a hostname that survives a restart, see ops/cloudflare-migration.md');
      if (!DISCOVERY) console.log('  DISCOVERY_URL is unset, so nothing will be told about it');
    }
  }
  announce();
  // Unref'd: a re-announce timer should never be the reason this process stays
  // alive.
  if (DISCOVERY && PUBLIC_URL) setInterval(announce, ANNOUNCE_EVERY_MS).unref?.();
  setInterval(announce, 4 * 60 * 1000).unref();
});
