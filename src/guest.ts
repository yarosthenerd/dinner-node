import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { formatEther, keccak256, parseEther, stringToHex, toHex } from 'viem';
import { ABI, ADDR, EXPLORER, jobIdFromReceipt, pub, wallet } from './chain';
import { readJob } from './registry';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
const providerUrl = flag('--provider') ?? 'http://localhost:4173';
const prompt = flag('--prompt') ?? 'Explain why idle GPUs should pay for dinner.';
const budget = parseEther(flag('--budget') ?? '0.01');

const w = wallet(process.env.GUEST_PK!);
const me = w.account.address;
const MAX_FEE = 2000000000000n; // 2000 gwei; Monad base fee spikes hard

const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [me] }) as bigint;
if (dep < budget) {
  console.log('depositing', formatEther(budget), 'MON...');
  // Sequenced on a receipt before openJob. Two writes from the same key back
  // to back collide on the nonce ("An existing transaction had higher
  // priority"). It survived until now only because viem re-fetches a pending
  // nonce, which is racy rather than correct.
  const dh = await w.writeContract({
    address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget,
    gas: 200000n, maxFeePerGas: MAX_FEE,
  });
  await pub.waitForTransactionReceipt({ hash: dh });
}

console.log('opening job with provider', providerUrl);
const provider = (await fetch(providerUrl + '/health').then(r => r.json())).provider;
// This line used to pass `prompt.slice(0, 40)`, putting forty characters of
// the raw prompt into a public event field. That is the same defect
// SECURITY_REVIEW.md 1.4 records as fixed in src/host.ts; it was fixed there
// and in web/src/App.tsx and missed here, while README.md and the published
// terms.html both went on to state that prompt text never reaches the chain.
//
// Salted keccak commitment, matching src/host.ts and web/src/App.tsx byte for
// byte. The salt is generated here, used once, and discarded, so the tag is
// not linkable to the prompt once this process exits. Note there is no
// sanitizer on this path: sanitization is browser-only, so a CLI prompt is
// sent to the provider exactly as typed.
const salt = toHex(randomBytes(32));
const tag = keccak256(stringToHex(salt + '|' + prompt));
const openHash = await w.writeContract({
  address: ADDR, abi: ABI, functionName: 'openJob',
  args: [provider, budget, tag],
  gas: 250000n, maxFeePerGas: MAX_FEE,
});
const jobId = await jobIdFromReceipt(openHash);
console.log(`job#${jobId} open  ${EXPLORER}/tx/${openHash}`);

// Live settlement feed. The handle is kept because the poller holds the event
// loop open: without unwatching, this process printed its whole answer and then
// hung until something killed it.
const unwatch = pub.watchContractEvent({
  address: ADDR, abi: ABI, eventName: 'StreamSettled',
  args: { jobId },
  onLogs: logs => logs.forEach(l =>
    console.log(`  💸 settled +${l.args.tokensDelta} tok  ${formatEther(l.args.amount!)} MON  ${EXPLORER}/tx/${l.transactionHash}`)),
});

const res = await fetch(providerUrl + '/job', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jobId: jobId.toString(), prompt }),
});
let tokens = 0;
let thought = 0;
for await (const line of res.body!.pipeThrough(new TextDecoderStream()) as any) {
  for (const l of line.split('\n')) if (l.startsWith('data: ') && l !== 'data: [DONE]') {
    const f = JSON.parse(l.slice(6));
    // Three frame shapes reach this loop and only one of them is the answer.
    // Writing `.t` unconditionally crashed on the first reasoning frame, which
    // meant this CLI could not order from a reasoning model at all -- and the
    // node this project is built around serves one. Checkpoints and errors are
    // structural too, so they are named rather than swallowed.
    if (f.th !== undefined) { thought++; continue; }
    if (f.err !== undefined) { console.error(`\n  ! node reported: ${f.err}`); continue; }
    if (f.cp !== undefined) continue;
    if (typeof f.t !== 'string') continue;
    process.stdout.write(f.t); tokens++;
  }
}
console.log(`\n--- session: ${tokens} tokens visible + ${thought} reasoning, both billed, from someone else's hardware`);

// Settlement is ASYNCHRONOUS to the stream. The node flushes its last tokens
// after the final frame and closes the job a moment later, so reading the job
// the instant the stream ends reported `paid: 0 MON` on a session that had in
// fact just settled 0.0146 MON. Printing zero next to a real payment is the
// same class of defect as logging a reverted settlement as a success, and this
// number is the whole point of the receipt, so wait for the chain to catch up.
const DEADLINE_MS = 45_000;
const t0 = Date.now();
let job = await readJob(jobId);
while (job.open && Date.now() - t0 < DEADLINE_MS) {
  await new Promise(r => setTimeout(r, 1500));
  job = await readJob(jobId);
}
unwatch();
if (job.open) {
  // Said out loud rather than papered over with whatever `paid` happened to
  // read: the figure below is a snapshot of an unfinished settlement.
  console.log(`--- paid so far: ${formatEther(job.paid)} MON for ${job.tokens} tok. The job is still open after ${DEADLINE_MS / 1000}s;`
    + ` the node settles and closes on its own timer, so the final figure may be higher.`);
} else {
  console.log(`--- paid: ${formatEther(job.paid)} MON for ${job.tokens} tok billed`
    + ` | refunded ${formatEther(job.escrow - job.paid)} MON of the ${formatEther(job.escrow)} MON escrow`);
}
