import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { statusFor, trim, WINDOWS, type Probe, type ProviderStatus } from './canary-stats';

/**
 * The canary. It probes the nodes on an interval and publishes what it
 * measured, because the one channel this project wants to be listed on ranks
 * providers on reliability and we had no reliability numbers at all: the
 * provider schema published capacity absent and is_ready false, and every
 * claim about uptime was a claim.
 *
 * Two kinds of probe, kept apart everywhere including the output, because they
 * cost different things and mean different things.
 *
 *   liveness  GET /health. Free, every CANARY_INTERVAL_MS. It measures whether
 *             the node answers and how fast it answers THAT, which is a
 *             statement about the tunnel and the process, not about inference.
 *
 *   answer    POST /lanjob. Off by default. It measures time to first token,
 *             which is the number a buyer actually feels, and it is not free:
 *             /lanjob opens a job the NODE pays for, so every answer probe
 *             spends the operator's own gas and escrow. It is also LAN-gated,
 *             so this only works run beside the nodes.
 *
 * What this deliberately does NOT claim: it is one vantage point, on the
 * operator's own network, watching the operator's own machines. It cannot see
 * an outage that is between a guest and the tunnel, and a node that answers
 * /health while serving nothing reads as up. The caveats travel in the payload
 * rather than in a README, so they cannot be dropped by whoever renders it.
 *
 *   npm run canary            serve and probe on an interval
 *   npm run canary -- --once  probe once, print a table, exit
 */

const PORT = Number(process.env.CANARY_PORT ?? 4180);
const INTERVAL_MS = Number(process.env.CANARY_INTERVAL_MS ?? 60_000);
const TIMEOUT_MS = Number(process.env.CANARY_TIMEOUT_MS ?? 10_000);
const DISCOVERY = process.env.DISCOVERY_URL ?? '';
const ANSWER = (process.env.CANARY_ANSWER ?? 'off').toLowerCase();
const ANSWER_EVERY_MS = Number(process.env.CANARY_ANSWER_EVERY_MS ?? 60 * 60 * 1000);
const ANSWER_TIMEOUT_MS = Number(process.env.CANARY_ANSWER_TIMEOUT_MS ?? 300_000);
const ANSWER_PROMPT = process.env.CANARY_ANSWER_PROMPT ?? 'In one sentence, what is a canary?';
const HISTORY = path.resolve(process.cwd(), process.env.CANARY_HISTORY ?? '.canary-history.json');
const MAX_SAMPLES = Number(process.env.CANARY_MAX_SAMPLES ?? 20_000);
const ONCE = process.argv.includes('--once');

// `addr=url` pairs, or bare urls when the address is not known yet. Only
// needed when discovery is not running; normally the list comes from there.
const TARGETS = (process.env.CANARY_TARGETS ?? '').split(',').map(s => s.trim()).filter(Boolean);

type Target = { address: string; url: string; model: string | null };

let probes: Probe[] = [];
let lastAnswerAt = new Map<string, number>();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
    if (Array.isArray(raw?.probes)) probes = raw.probes;
    console.log(`[canary] ${probes.length} samples from ${HISTORY}`);
  } catch {
    console.log(`[canary] no history at ${HISTORY}, starting empty`);
  }
}

// Written after every round rather than on exit: a canary that loses its
// history when it is killed is blind to exactly the event it exists to record.
function save() {
  probes = trim(probes, MAX_SAMPLES);
  const tmp = HISTORY + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ updated: Date.now(), probes }));
  fs.renameSync(tmp, HISTORY);
}

async function targets(): Promise<Target[]> {
  const out: Target[] = [];
  if (DISCOVERY) {
    try {
      const r = await fetch(DISCOVERY.replace(/\/$/, '') + '/providers', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const j: any = await r.json();
      for (const p of j?.providers ?? []) {
        if (p?.url) out.push({ address: String(p.address), url: String(p.url), model: p.model ?? null });
      }
    } catch (e: any) {
      // Discovery being down is itself worth seeing in the log, and is not a
      // reason to stop probing the targets we were given explicitly.
      console.log(`[canary] discovery unreachable: ${e?.message ?? e}`);
    }
  }
  for (const t of TARGETS) {
    const [a, u] = t.includes('=') ? t.split('=') : ['', t];
    const url = (u ?? '').replace(/\/$/, '');
    if (!url) continue;
    if (!out.some(o => o.url === url)) out.push({ address: a || url, url, model: null });
  }
  return out;
}

async function liveness(t: Target): Promise<Probe> {
  const at = Date.now();
  try {
    const r = await fetch(t.url + '/health', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = Date.now() - at;
    if (!r.ok) return { at, address: t.address, kind: 'liveness', ok: false, ms: null, error: `http ${r.status}` };
    const j: any = await r.json();
    // A 200 carrying no provider address is a tunnel's error page, an
    // interstitial, or somebody else's server on that hostname. Treating it as
    // up is how a status page reports green through an outage.
    if (!j?.provider) return { at, address: t.address, kind: 'liveness', ok: false, ms: null, error: 'health returned no provider' };
    return { at, address: t.address, kind: 'liveness', ok: true, ms };
  } catch (e: any) {
    const kind = e?.name === 'TimeoutError' ? `timeout ${TIMEOUT_MS}ms` : (e?.cause?.code ?? e?.name ?? 'error');
    return { at, address: t.address, kind: 'liveness', ok: false, ms: null, error: String(kind) };
  }
}

/**
 * Time to first VISIBLE token. Reasoning frames arrive as `th` and are not
 * what a reader is waiting for, so they are deliberately not the stop
 * condition: a model that thinks for 30 seconds has not answered in 40ms.
 */
async function answer(t: Target): Promise<Probe> {
  const at = Date.now();
  try {
    const res = await fetch(t.url + '/lanjob', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: ANSWER_PROMPT }),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 120);
      return { at, address: t.address, kind: 'answer', ok: false, ms: null, error: `http ${res.status}: ${body}` };
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') break;
          let ev: any; try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.err) return { at, address: t.address, kind: 'answer', ok: false, ms: null, error: String(ev.err).slice(0, 120) };
          if (ev.t) return { at, address: t.address, kind: 'answer', ok: true, ms: Date.now() - at };
        }
      }
    } finally {
      // Walk away as soon as the number is in hand. The job settles and closes
      // on the node's own timers; reading the rest would only cost it tokens.
      await reader.cancel().catch(() => {});
    }
    return { at, address: t.address, kind: 'answer', ok: false, ms: null, error: 'stream ended with no visible token' };
  } catch (e: any) {
    const kind = e?.name === 'TimeoutError' ? `timeout ${ANSWER_TIMEOUT_MS}ms` : (e?.cause?.code ?? e?.name ?? 'error');
    return { at, address: t.address, kind: 'answer', ok: false, ms: null, error: String(kind) };
  }
}

let known: Target[] = [];

async function round() {
  known = await targets();
  if (known.length === 0) { console.log('[canary] no targets. Set DISCOVERY_URL or CANARY_TARGETS'); return; }
  const now = Date.now();
  const batch: Probe[] = await Promise.all(known.map(liveness));

  if (ANSWER === 'lanjob') {
    for (const t of known) {
      const last = lastAnswerAt.get(t.address) ?? 0;
      if (now - last < ANSWER_EVERY_MS) continue;
      lastAnswerAt.set(t.address, now);
      batch.push(await answer(t));
    }
  }

  probes.push(...batch);
  save();
  for (const b of batch) {
    const who = known.find(k => k.address === b.address);
    console.log(`[canary] ${b.kind.padEnd(8)} ${(who?.model ?? b.address).slice(0, 24).padEnd(24)} ${b.ok ? `ok ${b.ms}ms` : `FAIL ${b.error}`}`);
  }
}

function status() {
  const now = Date.now();
  return {
    updated: now,
    vantage: process.env.CANARY_VANTAGE ?? 'operator network',
    intervalMs: INTERVAL_MS,
    answerProbes: ANSWER === 'lanjob' ? { enabled: true, everyMs: ANSWER_EVERY_MS, path: '/lanjob' } : { enabled: false },
    windows: WINDOWS.map(w => w.label),
    samples: probes.length,
    providers: known.map(t => statusFor(t.address, t, probes, now)),
    // Carried in the payload so a renderer cannot drop them.
    caveats: [
      'One vantage point, on the operator network, watching the operator machines. It cannot see an outage between a guest and the tunnel.',
      'Liveness is GET /health. A node that answers /health while serving nothing reads as up here.',
      ANSWER === 'lanjob'
        ? 'Time to first token is measured over /lanjob, which the node pays for itself, so it is the node fronting its own escrow rather than a guest paying.'
        : 'Time to first token is NOT measured: answer probes are off, because each one spends the node operator own gas.',
      'Percentiles are nearest-rank over the samples held, with no interpolation. Read them beside the sample count.',
    ],
  };
}

const ms = (n: number | null) => (n === null ? '   -' : `${n}ms`);
const pct = (n: number | null) => (n === null ? '  -  ' : `${(n * 100).toFixed(1)}%`);

function table(s: ReturnType<typeof status>) {
  const lines: string[] = [];
  for (const p of s.providers as ProviderStatus[]) {
    lines.push(`\n${p.model ?? p.address}  ${p.url ?? ''}`);
    lines.push(`  window  samples  up      errors  p50     p90     p99     worst outage`);
    for (const w of p.liveness) {
      lines.push(`  ${w.window.padEnd(7)} ${String(w.samples).padStart(7)}  ${pct(w.availability)}  ${String(w.failed).padStart(6)}  ` +
        `${ms(w.p50).padEnd(7)} ${ms(w.p90).padEnd(7)} ${ms(w.p99).padEnd(7)} ${w.worstStreak.probes} probes / ${Math.round(w.worstStreak.ms / 1000)}s`);
    }
    const a = p.answer.find(x => x.samples > 0);
    if (a) lines.push(`  time to first token, ${a.window}: p50 ${ms(a.p50)} p99 ${ms(a.p99)} over ${a.samples} probes`);
    if (p.lastError) lines.push(`  last failure: ${new Date(p.lastError.at).toISOString()} ${p.lastError.error}`);
  }
  return lines.join('\n');
}

const page = (s: ReturnType<typeof status>) => `<!doctype html><meta charset="utf-8">
<title>DinnerNode status</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:light dark;--fg:#111;--dim:#666;--ok:#0a7a35;--bad:#b3261e;--line:#ddd;--bg:#fff}
 @media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--dim:#999;--ok:#4ade80;--bad:#f87171;--line:#333;--bg:#111}}
 body{background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:24px}
 h1{font-size:18px;margin:0 0 4px} .dim{color:var(--dim)} .ok{color:var(--ok)} .bad{color:var(--bad)}
 table{border-collapse:collapse;margin:8px 0 20px;width:100%;max-width:820px} td,th{border-bottom:1px solid var(--line);padding:4px 10px 4px 0;text-align:right}
 th:first-child,td:first-child{text-align:left} .wrap{overflow-x:auto} ul{max-width:820px;padding-left:18px}
</style>
<h1>DinnerNode status</h1>
<p class="dim">measured, not claimed. ${s.samples} samples, probed every ${Math.round(s.intervalMs / 1000)}s from ${s.vantage}. updated ${new Date(s.updated).toISOString()}</p>
${(s.providers as ProviderStatus[]).map(p => `
<h2 style="font-size:15px;margin:18px 0 2px">${p.model ?? p.address} <span class="dim">${p.url ?? ''}</span></h2>
<p class="dim" style="margin:2px 0">${p.lastOk ? `last ok ${new Date(p.lastOk).toISOString()}` : 'never seen up'}${p.lastError ? ` · last failure ${new Date(p.lastError.at).toISOString()}: ${p.lastError.error}` : ''}</p>
<div class="wrap"><table>
<tr><th>window</th><th>samples</th><th>up</th><th>errors</th><th>p50</th><th>p90</th><th>p99</th><th>worst run</th></tr>
${p.liveness.map(w => `<tr><td>${w.window}</td><td>${w.samples}</td><td class="${w.availability === null ? 'dim' : w.availability === 1 ? 'ok' : 'bad'}">${pct(w.availability)}</td><td>${w.failed}</td><td>${ms(w.p50)}</td><td>${ms(w.p90)}</td><td>${ms(w.p99)}</td><td>${w.worstStreak.probes} / ${Math.round(w.worstStreak.ms / 1000)}s</td></tr>`).join('')}
${p.answer.filter(w => w.samples > 0).map(w => `<tr><td>ttft ${w.window}</td><td>${w.samples}</td><td class="${w.availability === 1 ? 'ok' : 'bad'}">${pct(w.availability)}</td><td>${w.failed}</td><td>${ms(w.p50)}</td><td>${ms(w.p90)}</td><td>${ms(w.p99)}</td><td></td></tr>`).join('')}
</table></div>`).join('')}
<h2 style="font-size:15px">what these numbers are not</h2>
<ul class="dim">${s.caveats.map(c => `<li>${c}</li>`).join('')}</ul>
<p class="dim"><a href="/status">/status</a> is the same thing as JSON.</p>`;

async function main() {
  load();
  if (ONCE) {
    await round();
    console.log(table(status()));
    return;
  }
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/status') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(status(), null, 2));
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(page(status()));
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(PORT, () => console.log(`[canary] status on :${PORT}, probing every ${INTERVAL_MS}ms, answer probes ${ANSWER}`));
  await round();
  setInterval(() => { round().catch(e => console.log('[canary] round failed:', e?.message ?? e)); }, INTERVAL_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
