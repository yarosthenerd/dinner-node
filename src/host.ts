import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { formatEther, keccak256, parseEther, parseEventLogs, stringToHex, toHex } from 'viem';
import { ABI, ADDR, EXPLORER, pub, wallet } from './chain';
import { mock, ollama, openai, SYSTEM_PROMPT, type Chunk } from './engines';
import { describeHardware, probeHardware } from './hardware';

const w = wallet(process.env.PROVIDER_PK!);
const me = w.account.address;
const PORT = Number(process.env.PORT ?? 4173);
const RATE = BigInt(process.env.RATE_PER_MILLION ?? '26700000000000000000');

// Limits. The UI reads these from /health so its estimate matches ours instead
// of guessing, and a prompt is rejected with a number rather than silently
// truncated by the engine.
const MAX_BODY = Number(process.env.MAX_BODY_BYTES ?? 1_000_000);
const CONTEXT_TOKENS = Number(process.env.CONTEXT_TOKENS ?? 32768);
const OUTPUT_RESERVE = Number(process.env.OUTPUT_RESERVE_TOKENS ?? 2048);
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_TOKENS ?? 64);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);
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

type Engine = { kind: string; model: string; gen: (p: string, signal?: AbortSignal) => AsyncGenerator<Chunk> };
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
      if (model) return { kind: 'ollama', model, gen: (p, s) => ollama(p, model, s, CONTEXT_TOKENS) };
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
async function announce() {
  if (!DISCOVERY || !PUBLIC_URL) return;
  try {
    const e = await engineP;
    const r = await fetch(`${DISCOVERY.replace(/\/$/, '')}/announce`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: me, url: PUBLIC_URL, model: e.model }),
    });
    console.log(`[announce] ${r.status} ${(await r.text()).slice(0, 120)}`);
  } catch (e: any) {
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

async function serveJob(jobId: bigint, prompt: string, res: http.ServerResponse, resume?: { text: string; n: number }) {
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
  queue = queue.then(() => sendChecked('closeJob', 'closeJob', [jobId], 120000n)
    .then(h => console.log(`[job#${jobId}] closed  ${EXPLORER}/tx/${h}`))
    .catch(e => console.log(`[job#${jobId}] close FAILED:`, (e as any).shortMessage ?? (e as any).message)));
  active.delete(jobId);
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
      contextTokens: CONTEXT_TOKENS, promptBudget: PROMPT_BUDGET, checkpointEvery: CHECKPOINT_EVERY,
      maxBodyBytes: MAX_BODY, maxConcurrent: MAX_CONCURRENT, activeJobs: active.size,
      // The guest closes an unfinished job to recover its escrow, and closing
      // before this node's last flush lands trips settle()'s require(j.open)
      // and takes tokens the guest already received without paying for them.
      // Published so the browser waits on THIS node's cadence rather than on a
      // constant that silently stopped matching when the cadence changed.
      settleMaxMs: SETTLE_MAX_MS, settleGasMultiple: Number(SETTLE_GAS_MULTIPLE),
      settleGasUnits: Number(settleGasUnits),
      priority: PRIORITY, pressure: Number(pressure().toFixed(2)),
      // null until the startup measurement lands, a few seconds in.
      firstTokenMs, gpuFraction, hardware: describeHardware(HW),
      accepting: pressure() <= THRESHOLDS.hard && active.size < MAX_CONCURRENT,
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
      const { jobId, prompt, resume } = JSON.parse(body);
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
      return serveJob(BigInt(jobId), prompt, res, r);
    }

    res.statusCode = 404; res.end();
  } catch (e: any) {
    release();
    res.statusCode = 500;
    res.end(String(e?.shortMessage || e));
  }
}).listen(PORT, async () => {
  const e = await engineP;
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
  setInterval(announce, 4 * 60 * 1000).unref();
});
