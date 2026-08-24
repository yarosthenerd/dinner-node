import { createWalletClient, defineChain, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const chain = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});
const last = new Map();

export default async function handler(req, res) {
  const address = (req.query && req.query.address) || '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: 'bad address' });
  const now = Date.now();
  if ((last.get(address) || 0) + 30000 > now) return res.status(429).json({ error: 'the kitchen is busy, try again in 30s' });
  last.set(address, now);
  try {
    const client = createWalletClient({ account: privateKeyToAccount(process.env.HOUSE_PK), chain, transport: http() });
    const hash = await client.sendTransaction({ to: address, value: parseEther('10'), gas: 30000n });
    res.status(200).json({ ok: true, hash });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
