import 'dotenv/config';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const monadTestnet = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});
export const ADDR = process.env.DINNER_NODE_ADDRESS as `0x${string}`;
export const EXPLORER = 'https://testnet.monadvision.com';
export const ABI = parseAbi([
  'function registerProvider(string model, string hw, uint256 ratePerMillion)',
  'function deposit() payable',
  'function openJob(address provider, uint256 budget, string tag) returns (uint256)',
  'function settle(uint256 jobId, uint256 tokensDelta)',
  'function closeJob(uint256 jobId)',
  'function jobs(uint256) view returns (address, address, uint256, uint256, uint256, bool)',
  'function deposits(address) view returns (uint256)',
  'function providers(address) view returns (string, string, uint256, uint256, uint256, uint256, bool)',
  'event JobOpened(uint256 indexed jobId, address indexed requester, address indexed provider, string promptTag)',
  'event StreamSettled(uint256 indexed jobId, address indexed provider, uint256 tokensDelta, uint256 amount)',
  'event JobClosed(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid)',
  'event ProviderRegistered(address indexed provider, string model, string hw, uint256 ratePerMillion)',
]);

export const pub = createPublicClient({ chain: monadTestnet, transport: http() });
export const wallet = (pk: string) =>
  createWalletClient({ account: privateKeyToAccount(pk as `0x${string}`), chain: monadTestnet, transport: http() });

export async function jobIdFromReceipt(hash: `0x${string}`): Promise<bigint> {
  const rc = await pub.waitForTransactionReceipt({ hash });
  const [log] = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' });
  return log.args.jobId;
}
