import { account, pub, wal, ADDR, ABI } from './_lib.js';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const p = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'providers', args: [account.address] });
    if (!p[6]) throw 0;
  } catch {
    await wal.writeContract({ address: ADDR, abi: ABI, functionName: 'registerProvider',
      args: ['cloud-mock-7b (hosted)', 'Vercel serverless cloud kitchen', 2000000000000000000n], gas: 500000n }).catch(() => {});
  }
  res.status(200).json({ provider: account.address, model: 'cloud-mock-7b (hosted)', kind: 'mock' });
}
