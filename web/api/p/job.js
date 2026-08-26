import { account, pub, ADDR, ABI, sleep, sendChecked, MAX_FEE, gasFor, wal, readJob } from './_lib.js';

const TEXT = p => `Cloud kitchen answering "${String(p).slice(0, 50)}": idle silicon is the only waiter that never sleeps. Every token of this reply settles on Monad, one micropayment per second. The RTX 5070 Ti laptop in the registry is the artisanal option; this function is the fast-food window. Both get paid. Tip your compute.`;

// The settle chain waits on a receipt per call, so the function needs more than
// the 10s Hobby default: four serialized settles at roughly 1.5 to 2s each plus
// closeJob lands past it, and a kill mid-chain leaves the job open with escrow
// locked and nothing on this side to retry it.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204); return res.end(); }

  let jobId, prompt;
  try { ({ jobId, prompt } = JSON.parse(req.body || '{}')); }
  catch { res.status(400); return res.end('bad body'); }
  if (!/^\d+$/.test(String(jobId))) { res.status(400); return res.end('bad jobId'); }

  const job = await readJob(jobId);
  if (String(job.provider).toLowerCase() !== account.address.toLowerCase() || !job.open) {
    res.status(400); return res.end('not my job');
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

  // Settlements are serialized on a promise chain rather than awaited inside
  // the token loop, so a settlement never stalls the stream and closeJob
  // cannot overtake the settle that precedes it. Same shape as src/host.ts.
  let queue = Promise.resolve();
  let failed = null;
  const settle = (d) => {
    if (d <= 0) return;
    queue = queue.then(() =>
      sendChecked('settle', 'settle', [BigInt(jobId), BigInt(d)], 150000n)
        .catch((e) => { failed = (e && e.message) || String(e); console.error('settle failed:', failed); }));
  };

  const words = TEXT(prompt).split(' ');
  let delta = 0, n = 0;
  for (const w of words) {
    res.write(`data: ${JSON.stringify({ t: w + ' ' })}\n\n`);
    delta++; n++;
    if (n % 15 === 0) { settle(delta); delta = 0; }
    await sleep(25);
  }
  settle(delta);
  await queue;

  // closeJob refunds the unspent escrow to the requester, so it must fire even
  // when a settlement failed. Its own failure is reported rather than swallowed.
  //
  // Re-read first. When a settle exhausts the escrow the contract sets
  // open = false itself (DinnerNode.sol:78-81) and closeJob then reverts on
  // require(j.open). gasFor swallows the estimate revert and returns the
  // fallback, so without this check we would knowingly send a doomed
  // transaction and Monad would charge the full limit for it.
  try {
    const still = await readJob(jobId);
    if (still.open) {
      const gas = await gasFor('closeJob', [BigInt(jobId)], 60000n);
      const hash = await wal.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [BigInt(jobId)], gas, maxFeePerGas: MAX_FEE });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== 'success') failed = failed ?? `closeJob reverted ${hash}`;
    }
  } catch (e) {
    failed = failed ?? `closeJob failed: ${(e && e.message) || e}`;
  }

  if (failed) res.write(`data: ${JSON.stringify({ warn: failed })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
