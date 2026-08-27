import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { formatEther, keccak256, parseEther, parseEventLogs, stringToHex, toHex } from 'viem';
import { ABI, ADDR, EXPLORER, pub, wallet } from './chain';
import { mock, ollama, openai, SYSTEM_PROMPT, type Chunk } from './engines';
import { describeHardware, probeHardware } from './hardware';
import { PLAN_LIMITS, planCostWei, planHash, validatePlan, type Plan } from './plan';
import { describePlan, makePlan } from './planner';
import { executePlan, type Dispatch } from './executor';
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
      let model = process.env.MODEL ?? names[0];
      if (model && !names.includes(model)) { console.log('model ' + model + ' not installed, falling back to ' + names[0]); model = names[0]; }
      if (model) return { kind: 'ollama', model, gen: (p, s, o) => ollama(p, model, s, CONTEXT_TOKENS, undefined, o?.think !== false) };
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

const active = new Map<bigint, { delta: number; since: number }>();
// gate() runs two awaited round trips before serveJob populates `active`, so
// concurrent requests all saw size 0 and the concurrency ceiling never bound.
// Count in-flight requests from the moment the gate admits one instead.
let inFlight = 0;
let queue: Promise<unknown> = Promise.resolve();

// Monad charges gas_limit rather than gas_used, so a padded limit overpays on
// every call and a tight one that reverts burns the whole limit for nothing.
// A fixed 100000 was doing exactly that: settle needs about 118000 the first
// time a provider is paid, because `earned` and `tokensServed` go from zero to
// non-zero and cost 20000 each. After every key rotation the first settlement
// of the new wallet reverted and the guest was never charged. Estimating per
// call costs one round trip against a three second settlement interval and
// keeps the limit both sufficient and tight.
async function gasFor(fn: string, args: readonly unknown[], fallback: bigint): Promise<bigint> {
  try {
    const g = await pub.estimateContractGas({ address: ADDR, abi: ABI, functionName: fn as any, args: args as any, account: w.account });
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

const settle = (jobId: bigint, delta: number) => {
  queue = queue.then(() =>
    sendChecked('settle', 'settle', [jobId, BigInt(delta)], 150000n)
      .then(h => console.log(`  [settle] job#${jobId} +${delta} tok  ${EXPLORER}/tx/${h}`))
      .catch(e => console.log(`  [settle] FAILED job#${jobId}:`, (e as any).shortMessage ?? (e as any).message)));
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
    settle(id, j.delta);
    j.delta = 0;
    j.since = now;
  }
}, 1000);

// Announce to the discovery listener so the web app can find this node by URL.
// The listener re-checks providers(me) on chain before it trusts any of this.
const DISCOVERY = process.env.DISCOVERY_URL ?? '';
const PUBLIC_URL = process.env.PUBLIC_URL ?? '';
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
    const r = await fetch(`${DISCOVERY.replace(/\/$/, '')}/announce`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: me, url: PUBLIC_URL, model: e.model }),
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

async function serveJob(jobId: bigint, prompt: string, res: http.ServerResponse, resume?: { text: string; n: number }, session = false) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  const e = await engineP;
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 1000);
  active.set(jobId, { delta: 0, since: Date.now() });

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
  let prefix = resume?.text ?? '';
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
        thought += c.th;
        // Reasoning IS billed. It is compute this node performs and delivers,
        // it is what OpenRouter providers charge for as output tokens, and not
        // charging for it made a 900 word briefing - the job shape this
        // project is built around - net negative at full utilization. One
        // frame is one token here exactly as it is on the visible path, so it
        // increments the same counter.
        active.get(jobId)!.delta++;
        // It is still NOT appended to `prefix` and NOT counted in `produced`.
        // The checkpoint chain covers the visible answer only, because that is
        // the text a replacement provider is handed and must reproduce. What
        // this costs is the strength of the claim: a settlement can no longer
        // be fully reconstructed from the published prefix, since part of it
        // paid for reasoning that was streamed but never checkpointed. The
        // claim narrows to the visible answer; see terms.html.
        res.write(`data: ${JSON.stringify({ th: c.th })}\n\n`);
        continue;
      }
      const tok = c.t;
      res.write(`data: ${JSON.stringify({ t: tok })}\n\n`);
      prefix += tok;
      produced++;
      active.get(jobId)!.delta++;
      if (++sinceCp >= CHECKPOINT_EVERY) {
        sinceCp = 0;
        // A checkpoint lets a different provider pick the answer up from here
        // and prove it has the same prefix, rather than starting over.
        res.write(`data: ${JSON.stringify({ cp: { n: (resume?.n ?? 0) + produced, h: keccak256(stringToHex(prefix)) } })}\n\n`);
      }
      const t = throttleMs();
      if (t) await sleep(t);
    }
  } catch (err: any) {
    console.log(`[job#${jobId}] engine error:`, err?.message ?? err);
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ err: String(err?.message ?? err) })}\n\n`);
  }
  clearInterval(hb);
  if (thought) {
    const th = estTokens(thought);
    console.log(`[job#${jobId}] ${produced} tok visible + ~${th} tok reasoning, both billed (${Math.round((th / (th + produced || 1)) * 100)}% reasoning)`);
  }
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ cp: { n: (resume?.n ?? 0) + produced, h: keccak256(stringToHex(prefix)), final: true } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
  const j = active.get(jobId);
  if (j && j.delta > 0) { settle(jobId, j.delta); j.delta = 0; j.since = Date.now(); }

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
  if (j && j.delta > 0) { settle(jobId, j.delta); j.delta = 0; j.since = Date.now(); }
  const t = idleTimers.get(jobId);
  if (t) { clearTimeout(t); idleTimers.delete(jobId); }
  queue = queue.then(() => sendChecked('closeJob', 'closeJob', [jobId], 120000n)
    .then(h => console.log(`[job#${jobId}] closed  ${EXPLORER}/tx/${h}`))
    .catch(e => console.log(`[job#${jobId}] close FAILED:`, (e as any).shortMessage ?? (e as any).message)));
  active.delete(jobId);
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

function gate(res: http.ServerResponse, prompt: string, resumeText = ''): boolean {
  // Checked before pressure, because this one is not a wait-and-retry: no
  // amount of patience refills the wallet, and accepting the job would mean
  // producing tokens that can never be settled.
  if (brokeForGas()) {
    res.statusCode = 503;
    res.setHeader('retry-after', '300');
    res.end(JSON.stringify({
      error: 'provider out of gas', balanceWei: String(providerBalance ?? 0n),
      needWei: String(gasFloorWei()), settles: MIN_GAS_SETTLES,
    }));
    return false;
  }
  if (pressure() > THRESHOLDS.hard) {
    res.statusCode = 503;
    res.setHeader('retry-after', '15');
    res.end(JSON.stringify({ error: 'host busy', priority: PRIORITY, pressure: Number(pressure().toFixed(2)) }));
    return false;
  }
  if (inFlight >= MAX_CONCURRENT) {
    res.statusCode = 503;
    res.setHeader('retry-after', '10');
    res.end(JSON.stringify({ error: 'all burners in use', active: inFlight, max: MAX_CONCURRENT }));
    return false;
  }
  // Resumed text is replayed into the engine as context, so it consumes the
  // same context window the prompt does. Gating on the prompt alone let a
  // caller ship up to MAX_BODY of "resume" past a check that thought the
  // request was small, which is free compute and a prompt-injection path.
  const n = estTokens(prompt) + estTokens(resumeText);
  if (n > PROMPT_BUDGET) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: 'prompt exceeds context window', estimatedTokens: n, promptBudget: PROMPT_BUDGET, contextTokens: CONTEXT_TOKENS }));
    return false;
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
      const h = await w.writeContract({
        address: ADDR, abi: ABI, functionName: 'registerProvider',
        args: [e.model, describeHardware(HW), RATE], gas: 250000n, maxFeePerGas: 2000000000000n,
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
    const p = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'providers', args: [me] });
    const [model, , rate, , , , active] = p as unknown as [string, string, bigint, bigint, bigint, bigint, boolean];
    if (active) console.log(`registry: active as ${model} at ${rate} wei per million tokens`);
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

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, bypass-tunnel-reminder, ngrok-skip-browser-warning');
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
    if (req.url === '/lanjob') {
      const { prompt } = JSON.parse(body || '{}');
      if (!gate(res, String(prompt ?? ''))) return;
      admitted = true;
      const budget = parseEther('0.01');
      const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [me] }) as bigint;
      if (dep < budget) {
        const dh = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget, gas: 200000n, maxFeePerGas: 2000000000000n });
        await pub.waitForTransactionReceipt({ hash: dh });
      }
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
      const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [me, budget, tag], gas: 250000n, maxFeePerGas: 2000000000000n });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      const [log] = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' });
      return serveJob(log.args.jobId as bigint, prompt, res);
    }

    if (req.url === '/job') {
      const { jobId, prompt, resume, session } = JSON.parse(body);
      if (!gate(res, String(prompt ?? ''), String(resume?.text ?? ''))) return;
      admitted = true;
      const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [BigInt(jobId)] }) as unknown as any[];
      if (String(job[1]).toLowerCase() !== me.toLowerCase() || !job[5]) { res.statusCode = 400; return res.end('job not mine / closed'); }

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
      const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [BigInt(jobId)] }) as unknown as any[];
      if (String(job[1]).toLowerCase() !== me.toLowerCase() || !job[5]) { res.statusCode = 400; return res.end('job not mine / closed'); }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
      const id = BigInt(jobId);
      const e = await engineP;
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 1000);
      active.set(id, { delta: 0, since: Date.now() });
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      console.log(`[job#${id}] planning ${estTokens(String(goal))} tok goal via ${e.kind}/${e.model}`);

      // Planning IS generation and is billed as such. A plan for a real goal
      // measured 8.4 minutes on this node, which is not compute to give away,
      // and an unbilled planner would be the same defect as the cloud kitchen
      // serving canned text while settling real MON.
      const billed = async function* (prompt: string) {
        for await (const c of e.gen(prompt, ac.signal)) {
          active.get(id)!.delta++;
          if (c.th !== undefined) res.write(`data: ${JSON.stringify({ th: c.th })}\n\n`);
          else res.write(`data: ${JSON.stringify({ t: c.t })}\n\n`);
          yield c.th !== undefined ? '' : c.t;
        }
      };

      const budgetWei = (job[2] as bigint) - (job[3] as bigint);
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
      const jp = active.get(id);
      if (jp && jp.delta > 0) { settle(id, jp.delta); jp.delta = 0; jp.since = Date.now(); }
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

      const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [BigInt(jobId)] }) as unknown as any[];
      if (String(job[1]).toLowerCase() !== me.toLowerCase() || !job[5]) { res.statusCode = 400; return res.end('job not mine / closed'); }

      // Re-validated here rather than trusted from the caller. The plan
      // arrives over the wire and nothing proves it is the one this node
      // produced, so the caps are enforced again against the escrow that is
      // actually left on this job.
      const remaining = (job[2] as bigint) - (job[3] as bigint);
      const v = validatePlan(plan, { budgetWei: remaining, ratePerMillion: RATE });
      if (!v.ok) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'plan rejected', issues: v.issues, remainingWei: String(remaining) }));
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
      const id = BigInt(jobId);
      const e = await engineP;
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 1000);
      active.set(id, { delta: 0, since: Date.now() });
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
          if (ev.kind === 'token' || ev.kind === 'thought') active.get(id)!.delta++;
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      } catch (err: any) {
        console.log(`[job#${id}] plan run error:`, err?.message ?? err);
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ err: String(err?.message ?? err) })}\n\n`);
      }

      clearInterval(hb);
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
      const jr = active.get(id);
      if (jr && jr.delta > 0) { settle(id, jr.delta); jr.delta = 0; jr.since = Date.now(); }
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
  announce();
  // Unref'd: a re-announce timer should never be the reason this process stays
  // alive.
  if (DISCOVERY && PUBLIC_URL) setInterval(announce, ANNOUNCE_EVERY_MS).unref?.();
  setInterval(announce, 4 * 60 * 1000).unref();
});
