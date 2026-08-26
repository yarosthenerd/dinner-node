import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ADDR } from './config';

export { ADDR };
export const EXPLORER = 'https://testnet.monadvision.com';
export const monadTestnet = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});
export const ABI = parseAbi([
  'function registerProvider(string model, string hw, uint256 ratePerMillion)',
  'function deposit() payable',
  'function openJob(address provider, uint256 budget, string tag) returns (uint256)',
  'function settle(uint256 jobId, uint256 tokensDelta)',
  'function closeJob(uint256 jobId)',
  'function jobCounter() view returns (uint256)',
  'function deposits(address) view returns (uint256)',
  'function jobs(uint256) view returns (address, address, uint256, uint256, uint256, bool)',
  'function providers(address) view returns (string, string, uint256, uint256, uint256, uint256, bool)',
  'event ProviderRegistered(address indexed provider, string model, string hw, uint256 ratePerMillion)',
  'event JobOpened(uint256 indexed jobId, address indexed requester, address indexed provider, string promptTag)',
  'event StreamSettled(uint256 indexed jobId, address indexed provider, uint256 tokensDelta, uint256 amount)',
  'event JobClosed(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid)',
]);
export const pub = createPublicClient({ chain: monadTestnet, transport: http() });

let _pk: `0x${string}`;
try { _pk = (localStorage.getItem('dn_pk') as `0x${string}` | null) ?? generatePrivateKey(); localStorage.setItem('dn_pk', _pk); }
catch { _pk = generatePrivateKey(); } // private mode: ephemeral only
export const guestAddress = privateKeyToAccount(_pk).address;
export const guestWallet = createWalletClient({ account: privateKeyToAccount(_pk), chain: monadTestnet, transport: http() });
export const faucet = async () => {
  try {
    const r = await fetch(`/api/topup?address=${guestAddress}`);
    // A 200 is not necessarily a grant. The endpoint returns
    // {ok:false, reason:'already funded'} with a 200, and treating that as
    // success would tell a caller funds are coming when none are.
    if (r.ok) {
      const body = await r.json().catch(() => ({ ok: true }));
      if (body.ok !== false) return true;
      console.warn('faucet declined:', body.reason);
    }
  } catch {}
  return fetch('https://agents.devnads.com/v1/faucet', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: 10143, address: guestAddress }),
  }).then(r => r.ok);
};
export const fmt = (w: bigint) => {
  let s = formatEther(w);
  if (s.includes('.')) s = s.slice(0, s.indexOf('.') + 9).replace(/0+$/, '').replace(/\.$/, '');
  return s;
};
