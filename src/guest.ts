import 'dotenv/config';
import { formatEther, parseEther } from 'viem';
import { ABI, ADDR, EXPLORER, jobIdFromReceipt, pub, wallet } from './chain';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
const providerUrl = flag('--provider') ?? 'http://localhost:4173';
const prompt = flag('--prompt') ?? 'Explain why idle GPUs should pay for dinner.';
const budget = parseEther(flag('--budget') ?? '0.01');

const w = wallet(process.env.GUEST_PK!);
const me = w.account.address;

const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [me] }) as bigint;
if (dep < budget) {
  console.log('depositing', formatEther(budget), 'MON...');
  await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget });
}

console.log('opening job with provider', providerUrl);
const openHash = await w.writeContract({
  address: ADDR, abi: ABI, functionName: 'openJob',
  args: [(await fetch(providerUrl + '/health').then(r => r.json())).provider, budget, prompt.slice(0, 40)],
});
const jobId = await jobIdFromReceipt(openHash);
console.log(`job#${jobId} open  ${EXPLORER}/tx/${openHash}`);

pub.watchContractEvent({  // live settlement feed = the wow
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
for await (const line of res.body!.pipeThrough(new TextDecoderStream()) as any) {
  for (const l of line.split('\n')) if (l.startsWith('data: ') && l !== 'data: [DONE]') {
    process.stdout.write(JSON.parse(l.slice(6)).t); tokens++;
  }
}
console.log(`\n--- session: ${tokens} tokens streamed from someone else's hardware`);
const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [jobId] }) as any[];
console.log(`--- paid: ${formatEther(job[3])} MON | provider earned it for doing what their PC was doing anyway: nothing`);
