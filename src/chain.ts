import 'dotenv/config';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// RPC_URL and CHAIN_ID exist so the whole daemon can be run end to end against
// a local anvil, with a deployed registry and real transactions, without
// spending anything or touching the operator's testnet provider record. Unset,
// which is the normal case, this is Monad testnet exactly as before.
export const monadTestnet = defineChain({
  // `||` rather than `??`: a bare `CHAIN_ID=` line in .env is an empty string,
  // which `??` passes through to Number('') === 0, and every transaction from
  // this process would then be signed for chain id 0. Same for an empty
  // RPC_URL, which resolves to no endpoint at all and fails on every read.
  id: Number(process.env.CHAIN_ID || 10143), name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'] } },
});
// The deployed testnet registry. Defaulted rather than required: a node
// operator has no way to know this value, and leaving it unset used to produce
// an undefined address that failed deep inside viem rather than at startup.
// Override only to point a node at a different deployment.
// DinnerNodeV2, deployed and verified on Monad testnet 2026-08-28. The v1
// instance at 0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92 stays callable
// forever and is what to point at to withdraw or refund value left in it.
export const DEFAULT_ADDR = '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c' as const;
export const V1_ADDR = '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92' as const;
export const ADDR = (process.env.DINNER_NODE_ADDRESS ?? DEFAULT_ADDR) as `0x${string}`;
export const EXPLORER = 'https://testnet.monadvision.com';
export const ABI = parseAbi([
  // Structs, so getJob/getProvider decode to NAMED objects. The positional
  // reads these replace are the reason v2 could not be a drop-in: `open` moves
  // from index 5 to index 9 and the value at the old index is a non-zero rate,
  // which reads as truthy. Every liveness check would have gone on passing.
  'struct Job { address requester; address provider; uint256 escrow; uint256 paid; uint256 tokens; uint256 ratePerMillion; uint256 maxTokensPerSecond; uint64 openedAt; uint64 lastSettleAt; bool open; bool requireCheckpoints; }',
  'struct Provider { string model; string hw; uint256 ratePerMillion; uint256 maxTokensPerSecond; uint256 earned; uint256 lifetimeEarned; uint256 tokensServed; uint256 jobs; bool active; }',
  'struct Checkpoint { bytes32 prefixHash; uint256 tokens; uint256 billed; bytes32 chainHash; }',
  'struct PlanCommitment { bytes32 planHash; uint256 version; uint256 ceiling; uint64 committedAt; }',

  'function registerProvider(string model, string hw, uint256 ratePerMillion, uint256 maxTokensPerSecond)',
  'function deregisterProvider()',
  'function deposit() payable',
  'function openJob(address provider, uint256 budget, string tag, bool requireCheckpoints) returns (uint256)',
  'function topUp(uint256 jobId, uint256 amount)',
  // ONLY the five-argument form. v2 declares a two-argument convenience
  // overload as well, and viem disambiguates overloads by argument shape:
  // naming both here makes every settle call a guess. A caller that wants no
  // checkpoint passes a zero hash, which is what the overload does anyway.
  'function settle(uint256 jobId, uint256 tokensDelta, bytes32 prefixHash, uint256 prefixTokens, uint256 billedTotal)',
  'function commitCheckpoint(uint256 jobId, bytes32 prefixHash, uint256 tokens, uint256 billed)',
  'function commitPlan(uint256 jobId, bytes32 planHash, uint256 version, uint256 ceiling)',
  'function reassign(uint256 jobId, address newProvider)',
  // The unattended handover. The guest signs a ReassignAuth once at order
  // time and the INCOMING provider submits it, so a node dying mid-answer
  // does not wait for a human to confirm a wallet prompt. See
  // DinnerNodeV2.reassignWithAuth for what the signature can and cannot do.
  'function reassignWithAuth(uint256 jobId, address newProvider, uint256 maxReassigns, uint64 deadline, bytes signature)',
  'function reassignCount(uint256 jobId) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function closeJob(uint256 jobId)',
  'function withdraw()',
  'function refund()',

  'function getJob(uint256 jobId) view returns (Job)',
  'function getProvider(address provider) view returns (Provider)',
  'function getCheckpoint(uint256 jobId) view returns (Checkpoint)',
  'function getPlan(uint256 jobId) view returns (PlanCommitment)',
  'function remainingBudget(uint256 jobId) view returns (uint256)',
  'function jobCounter() view returns (uint256)',
  'function deposits(address) view returns (uint256)',

  'event ProviderRegistered(address indexed provider, string model, string hw, uint256 ratePerMillion, uint256 maxTokensPerSecond)',
  'event JobOpened(uint256 indexed jobId, address indexed requester, address indexed provider, string promptTag)',
  'event JobToppedUp(uint256 indexed jobId, uint256 added, uint256 escrow)',
  'event StreamSettled(uint256 indexed jobId, address indexed provider, uint256 tokensDelta, uint256 amount)',
  'event CheckpointCommitted(uint256 indexed jobId, address indexed provider, bytes32 prefixHash, uint256 tokens, uint256 billed, bytes32 chainHash)',
  'event PlanCommitted(uint256 indexed jobId, bytes32 indexed planHash, uint256 version, uint256 ceiling)',
  'event JobReassigned(uint256 indexed jobId, address indexed from, address indexed to, uint256 settledOut)',
  'event JobExhausted(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid)',
  'event JobClosed(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid)',
  'event Withdrawn(address indexed provider, uint256 amount)',
  'event Refunded(address indexed requester, uint256 amount)',
]);

export const pub = createPublicClient({ chain: monadTestnet, transport: http() });
export const wallet = (pk: string) =>
  createWalletClient({ account: privateKeyToAccount(pk as `0x${string}`), chain: monadTestnet, transport: http() });

export async function jobIdFromReceipt(hash: `0x${string}`): Promise<bigint> {
  const rc = await pub.waitForTransactionReceipt({ hash });
  const [log] = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' });
  return log.args.jobId;
}
