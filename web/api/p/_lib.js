import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
export const chain = defineChain({ id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } } });
export const ADDR = '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92';
export const ABI = parseAbi([
  'function registerProvider(string model, string hw, uint256 ratePerMillion)',
  'function settle(uint256 jobId, uint256 tokensDelta)',
  'function closeJob(uint256 jobId)',
  'function jobs(uint256) view returns (address, address, uint256, uint256, uint256, bool)',
  'function providers(address) view returns (string, string, uint256, uint256, uint256, uint256, bool)',
]);
export const account = privateKeyToAccount(process.env.HOUSE_PK);
export const pub = createPublicClient({ chain, transport: http() });
export const wal = createWalletClient({ account, chain, transport: http() });
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
