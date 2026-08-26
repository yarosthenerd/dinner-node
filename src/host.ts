import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { keccak256, parseEther, parseEventLogs, stringToHex, toHex } from 'viem';
import { ABI, ADDR, EXPLORER, pub, wallet } from './chain';
import { mock, ollama, openai } from './engines';

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

// Roughly four characters per token. Deliberately an estimate: it only has to
// be good enough to reject an impossible prompt before any money moves.
const estTokens = (s: string) => Math.ceil(s.length / 4);
const PROMPT_BUDGET = CONTEXT_TOKENS - OUTPUT_RESERVE;

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

function probeHW(): string {
  const gpu = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']).stdout?.toString().trim();
  return `${gpu || 'CPU-only'} | ${os.cpus().length} cores | ${Math.round(os.totalmem() / 1e9)}GB | ${os.hostname()}`;
}

type Engine = { kind: string; model: string; gen: (p: string, signal?: AbortSignal) => AsyncGenerator<string> };
async function pickEngine(): Promise<Engine> {
  if (process.env.ENGINE !== 'mock') {
    if (process.env.LLM_BASE_URL) {
      const model = process.env.LLM_MODEL ?? 'local';
      return { kind: 'openai-compat', model, gen: (p, s) => openai(p, process.env.LLM_BASE_URL!, model, s) };
    }
    try {
      const tags = await (await fetch('http://localhost:11434/api/tags')).json() as any;
      const names: string[] = (tags.models ?? []).map((m: any) => m.name);
      let model = process.env.MODEL ?? names[0];
      if (model && !names.includes(model)) { console.log('model ' + model + ' not installed, falling back to ' + names[0]); model = names[0]; }
      if (model) return { kind: 'ollama', model, gen: (p, s) => ollama(p, model, s, CONTEXT_TOKENS) };
    } catch {}
  }
  return { kind: 'mock', model: process.env.MODEL ?? 'mock-7b', gen: mock };
}
const engineP = pickEngine();

const active = new Map<bigint, { delta: number }>();
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
setInterval(() => { for (const [id, j] of active) if (j.delta > 0) { settle(id, j.delta); j.delta = 0; } }, 3000);

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
<pre id=o style="white-space:pre-wrap;background:#10161f;border:1px solid #1d2733;padding:12px;min-height:240px"></pre>
<script>
var BUDGET=${PROMPT_BUDGET};
function upd(){var n=Math.ceil(p.value.length/4);est.textContent=n+' / '+BUDGET+' tokens (estimate)';est.style.color=n>BUDGET?'#ff6b6b':'#6b7a89';b.disabled=n>BUDGET;}
p.oninput=upd;upd();
b.onclick=async()=>{o.textContent='';st.textContent=' — opening job on the laptop…';b.disabled=true;
try{const r=await fetch('/lanjob',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:p.value})});
if(!r.ok){st.textContent=' — '+(await r.text());b.disabled=false;return;}
const rd=r.body.getReader(),d=new TextDecoder();let buf='';
for(;;){const{done,value}=await rd.read();if(done)break;buf+=d.decode(value,{stream:true});let i;
while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);
if(l.startsWith('data: ')&&l!=='data: [DONE]'){try{var j=JSON.parse(l.slice(6));if(j.t)o.textContent+=j.t}catch(e){}}}}
st.textContent=' — order up. settlements live on Monad testnet.';}catch(e){st.textContent=' failed: '+e;}
b.disabled=false;upd();};
</script>`;

async function serveJob(jobId: bigint, prompt: string, res: http.ServerResponse, resume?: { text: string; n: number }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  const e = await engineP;
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 1000);
  active.set(jobId, { delta: 0 });

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
  try {
    for await (const tok of e.gen(effective, ac.signal)) {
      if (res.writableEnded) break;
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
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ cp: { n: (resume?.n ?? 0) + produced, h: keccak256(stringToHex(prefix)), final: true } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
  const j = active.get(jobId);
  if (j && j.delta > 0) { settle(jobId, j.delta); j.delta = 0; }
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
      priority: PRIORITY, pressure: Number(pressure().toFixed(2)),
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
  await w.writeContract({ address: ADDR, abi: ABI, functionName: 'registerProvider', args: [e.model, probeHW(), RATE], gas: 250000n, maxFeePerGas: 2000000000000n })
    .then(h => console.log(`registered ${e.kind}/${e.model}\n  tx: ${EXPLORER}/tx/${h}`))
    .catch(err => console.log('register failed (non-fatal, already active):', (err as any).shortMessage));
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
  }
  announce();
  setInterval(announce, 4 * 60 * 1000).unref();
});
