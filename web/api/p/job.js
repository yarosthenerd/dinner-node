import { keccak256, stringToHex } from 'viem';
import { account, pub, ADDR, ABI, sleep, sendChecked, MAX_FEE, gasFor, wal, readJob } from './_lib.js';

const OPENING = p => `Cloud kitchen answering "${String(p).slice(0, 50)}": idle silicon is the only waiter that never sleeps. Every token of this reply settles on Monad, one micropayment per second. The RTX 5070 Ti laptop in the registry is the artisanal option; this function is the fast-food window. Both get paid. Tip your compute.`;

// A resume is a different passage on purpose. This endpoint is a fixed script,
// so it cannot genuinely continue somebody else's sentence, and pretending to
// would make the migration demo look like model output it is not. What it can
// do honestly is the part that matters on chain: verify the checkpoint, refuse
// to bill for the prefix, and settle only the tokens written below.
const CONTINUATION = n => `— picking that up from token ${n}, on a different machine, mid-answer. The node that started this reply is gone. Its tokens are already paid for and are not being charged again: the prefix above arrived with a keccak checkpoint, this function verified it before writing a word, and the settlements from here are for these tokens only. That is the whole trick. The guest never lost the answer, the first node keeps what it earned, and the receipt shows two providers paid for two disjoint token ranges of one job.`;

// Matches CHECKPOINT_TOKENS in src/host.ts, so a guest migrating between the
// two providers sees checkpoints at the same cadence in both directions.
const CHECKPOINT_EVERY = 64;

// The resumed prefix is replayed input from an untrusted caller and is held in
// memory and hashed here. src/host.ts bounds the same field via MAX_BODY plus
// its context gate; this function has neither, so it needs its own ceiling.
const MAX_RESUME_CHARS = 200000;

// The settle chain waits on a receipt per call, so the function needs more than
// the 10s Hobby default: four serialized settles at roughly 1.5 to 2s each plus
// closeJob lands past it, and a kill mid-chain leaves the job open with escrow
// locked and nothing on this side to retry it.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204); return res.end(); }

  // Vercel's Node runtime parses a JSON body into an OBJECT before the handler
  // sees it, and leaves other content types as a string. This used to call
  // JSON.parse unconditionally, so `JSON.parse({...})` stringified the object
  // to "[object Object]" and threw, and every request sent as
  // application/json was answered with 400 "bad body".
  //
  // That is what the browser sends. The hosted kitchen has therefore rejected
  // every failover the web app ever attempted, which is why mid-answer
  // migration could not be reproduced from a browser: not because the resume
  // path was missing, but because nothing ever reached it.
  let jobId, prompt, resume;
  try {
    const parsed = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
    ({ jobId, prompt, resume } = parsed);
  } catch { res.status(400); return res.end('bad body'); }
  if (!/^\d+$/.test(String(jobId))) { res.status(400); return res.end('bad jobId'); }

  // A resume is only honoured if the claimed prefix hashes to the checkpoint
  // the previous provider published. Without this check a caller could hand
  // this endpoint any text and have it treated as work already paid for, which
  // is the whole basis on which the replacement declines to re-bill it. Same
  // rule, same failure mode as src/host.ts:446.
  let cp;
  if (resume && resume.text) {
    const text = String(resume.text);
    if (text.length > MAX_RESUME_CHARS) {
      res.status(413);
      return res.end(JSON.stringify({ error: 'resume prefix too large', maxChars: MAX_RESUME_CHARS }));
    }
    if (keccak256(stringToHex(text)) !== String(resume.h)) {
      res.status(400);
      return res.end(JSON.stringify({ error: 'checkpoint hash mismatch' }));
    }
    cp = { text, n: Number(resume.n) || 0 };
  }

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

  const words = (cp ? CONTINUATION(cp.n) : OPENING(prompt)).split(' ');
  // The hash chain runs over the whole answer, prefix included, so a guest can
  // migrate a second time and the next provider can verify a checkpoint this
  // one published. Token numbering continues from the prefix; only `delta`,
  // which drives settle, counts what this function produced.
  let prefix = cp ? cp.text : '';
  let delta = 0, produced = 0, sinceCp = 0;
  for (const w of words) {
    const t = w + ' ';
    res.write(`data: ${JSON.stringify({ t })}\n\n`);
    prefix += t;
    delta++; produced++;
    if (++sinceCp >= CHECKPOINT_EVERY) {
      sinceCp = 0;
      res.write(`data: ${JSON.stringify({ cp: { n: (cp ? cp.n : 0) + produced, h: keccak256(stringToHex(prefix)) } })}\n\n`);
    }
    if (delta >= 15) { settle(delta); delta = 0; }
    await sleep(25);
  }
  settle(delta);
  res.write(`data: ${JSON.stringify({ cp: { n: (cp ? cp.n : 0) + produced, h: keccak256(stringToHex(prefix)), final: true } })}\n\n`);
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
