import { account, pub, wal, ADDR, ABI, sleep } from './_lib.js';
const TEXT = p => `Cloud kitchen answering "${String(p).slice(0, 50)}": idle silicon is the only waiter that never sleeps. Every token of this reply settles on Monad, one micropayment per second. The RTX 5070 Ti laptop in the registry is the artisanal option; this function is the fast-food window. Both get paid. Tip your compute.`;
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204); return res.end(); }
  const { jobId, prompt } = JSON.parse(req.body || '{}');
  const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [BigInt(jobId)] });
  if (String(job[1]).toLowerCase() !== account.address.toLowerCase() || !job[5]) { res.status(400); return res.end('not my job'); }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const settle = d => d > 0 ? wal.writeContract({ address: ADDR, abi: ABI, functionName: 'settle', args: [BigInt(jobId), BigInt(d)], gas: 300000n }).catch(() => {}) : Promise.resolve();
  const words = TEXT(prompt).split(' ');
  let delta = 0, n = 0;
  for (const w of words) {
    res.write(`data: ${JSON.stringify({ t: w + ' ' })}\n\n`);
    delta++; n++;
    if (n % 15 === 0) { await settle(delta); delta = 0; }
    await sleep(25);
  }
  await settle(delta);
  await wal.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [BigInt(jobId)], gas: 200000n }).catch(() => {});
  res.write('data: [DONE]\n\n');
  res.end();
}
