import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseEther, parseEventLogs } from 'viem';
import { ABI, ADDR, EXPLORER, pub, wallet } from './chain';
import { mock, ollama, openai } from './engines';

const w = wallet(process.env.PROVIDER_PK!);
const me = w.account.address;
const PORT = Number(process.env.PORT ?? 4173);
const RATE = BigInt(process.env.RATE_PER_MILLION ?? '2000000000000000000');

function probeHW(): string {
  const gpu = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']).stdout?.toString().trim();
  return `${gpu || 'CPU-only'} | ${os.cpus().length} cores | ${Math.round(os.totalmem() / 1e9)}GB | ${os.hostname()}`;
}
async function pickEngine(): Promise<{ kind: string; model: string; gen: (p: string) => AsyncGenerator<string> }> {
  if (process.env.ENGINE !== 'mock') {
    if (process.env.LLM_BASE_URL) {
      const model = process.env.LLM_MODEL ?? 'local';
      return { kind: 'openai-compat', model, gen: p => openai(p, process.env.LLM_BASE_URL!, model) };
    }
    try {
      const tags = await (await fetch('http://localhost:11434/api/tags')).json() as any;
      const names: string[] = (tags.models ?? []).map((m: any) => m.name);
      let model = process.env.MODEL ?? names[0];
      if (model && !names.includes(model)) { console.log('model ' + model + ' not installed — falling back to ' + names[0]); model = names[0]; }
      if (model) return { kind: 'ollama', model, gen: p => ollama(p, model) };
    } catch {}
  }
  return { kind: 'mock', model: process.env.MODEL ?? 'mock-7b', gen: mock };
}
const engineP = pickEngine();

const active = new Map<bigint, { delta: number }>();
let queue: Promise<unknown> = Promise.resolve();
const settle = (jobId: bigint, delta: number) => {
  queue = queue.then(() =>
    w.writeContract({ address: ADDR, abi: ABI, functionName: 'settle', args: [jobId, BigInt(delta)], gas: 100000n, maxFeePerGas: 2000000000000n })
      .then(h => console.log(`  [settle] job#${jobId} +${delta} tok  ${EXPLORER}/tx/${h}`))
      .catch(e => console.log(`  [settle] failed job#${jobId}:`, (e as any).shortMessage)));
};
setInterval(() => { for (const [id, j] of active) if (j.delta > 0) { settle(id, j.delta); j.delta = 0; } }, 3000);

const GUEST_HTML = `<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width,initial-scale=1">
<title>DinnerNode · laptop kitchen</title>
<body style="background:#0b0e14;color:#d7e0ea;font:14px/1.5 monospace;padding:24px;max-width:760px;margin:auto">
<h1 style="color:#9fef00">DinnerNode <span style="font-size:12px;color:#6b7a89">· served straight from this laptop</span></h1>
<textarea id=p rows=3 style="width:100%;background:#10161f;color:#d7e0ea;border:1px solid #1d2733;padding:8px">How much is the cost of an average dinner in Belgrade?</textarea>
<button id=b style="background:#10161f;color:#9fef00;border:1px solid #9fef00;padding:10px 18px;cursor:pointer">place order</button>
<span id=st style="color:#9fef00"></span>
<pre id=o style="white-space:pre-wrap;background:#10161f;border:1px solid #1d2733;padding:12px;min-height:240px"></pre>
<script>
b.onclick=async()=>{o.textContent='';st.textContent=' — opening job on the laptop…';b.disabled=true;
try{const r=await fetch('/lanjob',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:p.value})});
const rd=r.body.getReader(),d=new TextDecoder();let buf='';
for(;;){const{done,value}=await rd.read();if(done)break;buf+=d.decode(value,{stream:true});let i;
while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);
if(l.startsWith('data: ')&&l!=='data: [DONE]'){try{o.textContent+=JSON.parse(l.slice(6)).t}catch(e){}}}}
st.textContent=' — order up. settlements live on Monad testnet.';}catch(e){st.textContent=' failed: '+e;}
b.disabled=false;};
</script>`;

async function serveJob(jobId: bigint, prompt: string, res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  const e = await engineP;
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 1000);
  active.set(jobId, { delta: 0 });
  console.log(`[job#${jobId}] serving "${String(prompt).slice(0, 60)}" via ${e.kind}/${e.model}`);
  try {
    for await (const tok of e.gen(prompt)) {
      res.write(`data: ${JSON.stringify({ t: tok })}\n\n`);
      active.get(jobId)!.delta++;
    }
  } catch {}
  clearInterval(hb);
  res.write('data: [DONE]\n\n');
  res.end();
  const j = active.get(jobId)!;
  if (j.delta > 0) settle(jobId, j.delta);
  queue = queue.then(() => w.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [jobId], gas: 120000n, maxFeePerGas: 2000000000000n })
    .then(h => console.log(`[job#${jobId}] closed  ${EXPLORER}/tx/${h}`))).catch(() => {});
  active.delete(jobId);
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
    return res.end(JSON.stringify({ provider: me, engine: e.kind, model: e.model, port: PORT }));
  }
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    try {
      if (req.method === 'POST' && req.url === '/lanjob') {
        const { prompt } = JSON.parse(body || '{}');
        const budget = parseEther('0.01');
        const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [me] }) as bigint;
        if (dep < budget) await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget, gas: 200000n, maxFeePerGas: 2000000000000n });
        const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [me, budget, String(prompt).slice(0, 40)], gas: 250000n, maxFeePerGas: 2000000000000n });
        const rc = await pub.waitForTransactionReceipt({ hash: h });
        const [log] = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' });
        return serveJob(log.args.jobId as bigint, prompt, res);
      }
      if (req.method === 'POST' && req.url === '/job') {
        const { jobId, prompt } = JSON.parse(body);
        const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [BigInt(jobId)] }) as any[];
        if (String(job[1]).toLowerCase() !== me.toLowerCase() || !job[5]) { res.statusCode = 400; return res.end('job not mine / closed'); }
        return serveJob(BigInt(jobId), prompt, res);
      }
      res.statusCode = 404; res.end();
    } catch (e: any) { res.statusCode = 500; res.end(String(e?.shortMessage || e)); }
  });
}).listen(PORT, async () => {
  const e = await engineP;
  w.writeContract({ address: ADDR, abi: ABI, functionName: 'registerProvider', args: [e.model, probeHW(), RATE], gas: 250000n, maxFeePerGas: 2000000000000n })
    .then(h => console.log(`registered ${e.kind}/${e.model}\n  tx: ${EXPLORER}/tx/${h}`))
    .catch(err => console.log('register failed (non-fatal, already active):', (err as any).shortMessage));
  const lan = Object.values(os.networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
  console.log(`\nprovider ${me} listening on :${PORT}`);
  console.log(`LAN guest page (same wifi, zero setup): http://${lan ?? 'localhost'}:${PORT}`);
  console.log(`anywhere: npx localtunnel --port ${PORT} -> then ?host=<tunnel-url> on the Vercel site`);
});
