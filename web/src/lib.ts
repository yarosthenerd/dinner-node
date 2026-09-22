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

// The burner. It is the fallback identity, not the only one: lib/wallet.ts
// prefers the guest's own injected wallet when one is connected and falls back
// to this key when none is. Nothing here changed except the names, which now
// say which of the two an import is asking for.
let _pk: `0x${string}`;
try { _pk = (localStorage.getItem('dn_pk') as `0x${string}` | null) ?? generatePrivateKey(); localStorage.setItem('dn_pk', _pk); }
catch { _pk = generatePrivateKey(); } // private mode: ephemeral only
export const burnerAddress = privateKeyToAccount(_pk).address;
export const burnerWallet = createWalletClient({ account: privateKeyToAccount(_pk), chain: monadTestnet, transport: http() });
// Takes the address rather than reading the burner's, because with a wallet
// connected the address that needs funding is the guest's own.
//
// The house faucet is GONE. `web/api/topup.js` was a serverless endpoint that
// sent MON from a key the operator controls to any address that asked, and it
// was deleted 2026-08-28 rather than left disabled, because `TOPUP_DISABLED`
// is an environment variable and a deploy that forgets it is a one-variable
// mistake with regulatory consequences. It had already granted nothing since
// the variable was set. Do not reintroduce it: an operator-run dispenser is
// the most legally exposed mechanic this project ever shipped, and on mainnet
// it is a transfer service.
//
// What is left is the public testnet faucet, which is not ours, is rate
// limited per IP, and can refuse. A false return means the guest funds their
// own wallet.
export const faucet = async (address: `0x${string}`) =>
  fetch('https://agents.devnads.com/v1/faucet', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: 10143, address }),
  }).then(r => r.ok).catch(() => false);
export const fmt = (w: bigint) => {
  let s = formatEther(w);
  if (s.includes('.')) s = s.slice(0, s.indexOf('.') + 9).replace(/0+$/, '').replace(/\.$/, '');
  return s;
};

/**
 * The gas limit for a write, estimated rather than padded.
 *
 * Monad charges the gas LIMIT, not the gas used, so every unit of headroom a
 * fixed limit carries is money the guest actually pays. Measured against the
 * live registry on 2026-09-10 at 102 gwei: `deposit` estimates at 34,483
 * against a fixed 200,000 (5.8x) and `openJob` at 180,498 against 300,000
 * (1.7x), which is 0.0291 MON of headroom per order. Job#15 paid 0.049 MON for
 * the inference itself, so the padding cost about 60% of an answer.
 *
 * The 20% pad over the estimate absorbs the state drift between estimating and
 * landing: a first-time depositor writes a fresh storage slot and a repeat one
 * does not, and the estimate is taken against the state at call time.
 *
 * A revert is rethrown rather than padded over. Estimation is the cheapest
 * place to learn that a write cannot succeed, and falling back to the fixed
 * limit here would broadcast a transaction the chain has already said will
 * fail, paying the limit to find out. That is the mistake `47b123a` fixed on
 * the node side; this is the same mistake on the guest side.
 */
export type GasContext = {
  pub: { estimateContractGas: (c: never) => Promise<bigint> };
  address: `0x${string}`;
  abi: unknown;
  fn: string;
  args: readonly unknown[];
  account: `0x${string}`;
  fallback: bigint;
  value?: bigint;
};

/**
 * The estimating core, with the chain client injected so it can be tested
 * without one, and so `PlanPanel` can pass the address and ABI it is handed
 * as props rather than the module's.
 */
export async function estimateGas(c: GasContext): Promise<bigint> {
  try {
    const g = await c.pub.estimateContractGas({
      address: c.address, abi: c.abi, functionName: c.fn, args: c.args, account: c.account,
      // A payable call estimated without its value reverts on the balance
      // check, which would silently return the fallback for every deposit.
      ...(c.value === undefined ? {} : { value: c.value }),
    } as never);
    return (g * 12n) / 10n;
  } catch (e) {
    const m = String((e as { shortMessage?: string; message?: string })?.shortMessage
      ?? (e as { message?: string })?.message ?? e);
    if (/revert|execution reverted/i.test(m)) throw e;
    // Anything else is the estimator being unreachable rather than the call
    // being impossible: a dropped RPC, a rate limit, a wallet that will not
    // estimate. The fixed limit is the right answer there.
    return c.fallback;
  }
}

/** `estimateGas` bound to this module's client, registry and ABI. */
export const gasFor = (
  fn: string,
  args: readonly unknown[],
  account: `0x${string}`,
  fallback: bigint,
  value?: bigint,
): Promise<bigint> =>
  estimateGas({ pub: pub as never, address: ADDR, abi: ABI, fn, args, account, fallback, value });
