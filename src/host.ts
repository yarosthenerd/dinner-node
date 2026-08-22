import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseEther, formatEther } from 'viem';
import { ABI, ADDR, EXPLORER, monadTestnet, pub, wallet } from './chain';
import { mock, ollama, openai } from './engines';

const PK = process.env.PROVIDER_PK!;
const w = wallet(PK);
const me = w.account.address;
const PORT = Number(process.env.PORT ?? 4173);
const RATE = BigInt(process.env.RATE_PER_MILLION ?? '2000000000000000000'); // 2 MON/1M tok (illustrative)

function probeHW(): string {
  const gpu = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']).stdout?.toString().trim();
  return `${gpu || 'CPU-only'} | ${os.cpus().length} cores | ${Math.round(os.totalmem() / 1e9)}GB | ${os.hostname()}`;
}
async function pickEngine(): Promise<{ kind: string; model: string; gen: (p: string) => AsyncGenerator<string> }> {
  const force = process.env.ENGINE;
  if (force !== 'mock') {
    if (process.env.LLM_BASE_URL) {
      const model = process.env.LLM_MODEL ?? 'local';
      return { kind: 'openai-compat', model, gen: p => openai(p, process.env.LLM_BASE_URL!, model) };
    }
    try {
      const tags = await (await fetch('http://localhost:11434/api/tags')).json() as any;
      const model = process.env.MODEL ?? tags.models?.[0]?.name;
      if (model) return { kind: 'ollama', model, gen: p => ollama(p, model) };
    } catch {}
  }
  return { kind: 'mock', model: process.env.MODEL ?? 'mock-7b', gen: mock };
}

const active = new Map<bigint, { delta: number; total: number }>();
let queue: Promise<unknown> = Promise.resolve();
const settle = (jobId: bigint, delta: number) => {
  queue = queue.then(() =>
    w.writeContract({ address: ADDR, abi: ABI, functionName: 'settle', args: [jobId, BigInt(delta)] })
      .then(h => console.log(`  [settle] job#${jobId} +${delta} tok  ${EXPLORER}/tx/${h}`))
      .catch(e => console.log(`  [settle] failed job#${jobId}:`, e.shortMessage))
  );
};
setInterval(() => { for (const [id, j] of active) if (j.delta > 0) { settle(id, j.delta); j.total += j.delta; j.delta = 0; } }, 1000);

const engineP = pickEngine();

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const e = await engineP;
    return res.end(JSON.stringify({ provider: me, engine: e.kind, model: e.model, port: PORT }));
  }
  if (req.method !== 'POST' || req.url !== '/job') { res.statusCode = 404; return res.end(); }
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    const { jobId, prompt } = JSON.parse(body);
    const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [BigInt(jobId)] }) as any[];
    if (job[1].toLowerCase() !== me.toLowerCase() || !job[5]) { res.statusCode = 400; return res.end('job not mine / closed'); }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const e = await engineP;
    active.set(BigInt(jobId), { delta: 0, total: 0 });
    console.log(`[job#${jobId}] serving "${prompt.slice(0, 60)}" via ${e.kind}/${e.model}`);
    for await (const tok of e.gen(prompt)) {
      res.write(`data: ${JSON.stringify({ t: tok })}\n\n`);
      active.get(BigInt(jobId))!.delta++;
    }
    res.write('data: [DONE]\n\n'); res.end();
    const j = active.get(BigInt(jobId))!;
    if (j.delta > 0) settle(BigInt(jobId), j.delta);
    queue = queue.then(() => w.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [BigInt(jobId)] })
      .then(h => console.log(`[job#${jobId}] closed  ${EXPLORER}/tx/${h}`)));
    active.delete(BigInt(jobId));
  });
}).listen(PORT, async () => {
  const e = await engineP;
  const hw = probeHW();
  const h = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'registerProvider', args: [e.model, hw, RATE] });
  console.log(`registered ${e.kind}/${e.model}  hw: ${hw}\n  tx: ${EXPLORER}/tx/${h}`);
  const lan = Object.values(os.networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
  console.log(`\nprovider ${me} listening on :${PORT}`);
  console.log(`rent me from another machine:\n  npm run rent -- --provider http://${lan ?? 'localhost'}:${PORT} --prompt "..."`);
});
