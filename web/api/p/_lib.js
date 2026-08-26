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
  'function jobs(uint256) view returns (address requester, address provider, uint256 escrow, uint256 paid, uint256 tokens, bool open)',
  'function providers(address) view returns (string model, string hw, uint256 ratePerMillion, uint256 earned, uint256 tokensServed, uint256 jobsDone, bool active)',
]);
export const account = privateKeyToAccount(process.env.HOUSE_PK);
export const pub = createPublicClient({ chain, transport: http() });
export const wal = createWalletClient({ account, chain, transport: http() });
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// viem returns a positional array for these reads, not an object, so every
// caller was indexing jobs()[5] and providers()[6] by hand. DinnerNodeV2 grows
// jobs() from 6 fields to 10 and providers() from 7 to 8, which moves `open`
// from index 5 to 9 and `active` from 6 to 7. Every hand-written index would
// then read a non-zero rate as a boolean and silently pass. Decoding lives
// here so the migration is one edit in one file.
export async function readJob(jobId) {
  const j = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [BigInt(jobId)] });
  return { requester: j[0], provider: j[1], escrow: j[2], paid: j[3], tokens: j[4], open: j[5] };
}

export async function readProvider(addr) {
  const p = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'providers', args: [addr] });
  return { model: p[0], hw: p[1], ratePerMillion: p[2], earned: p[3], tokensServed: p[4], jobsDone: p[5], active: p[6] };
}

export const MAX_FEE = 2000000000000n; // 2000 gwei; Monad base fee spikes hard

// Monad charges gas_limit, not gas_used, so a loose limit is a real overpayment
// on every call rather than a harmless margin. These endpoints previously used
// 300000 for settle and 200000 for closeJob. Measured with Foundry against
// DinnerNode.sol, plus 21000 intrinsic: settle is 112409 on a provider's first
// payment and 28809 warm, closeJob is 26706. So the old closeJob limit was 7x
// and the old settle limit 2.7x, on a settle that fires every fifteen tokens. Estimate per
// call and add twenty percent, exactly as src/host.ts does; fall back to the
// host's own limits when the estimate cannot be taken.
export async function gasFor(functionName, args, fallback) {
  try {
    const g = await pub.estimateContractGas({ address: ADDR, abi: ABI, functionName, args, account });
    return (g * 120n) / 100n;
  } catch {
    return fallback;
  }
}

// writeContract resolves on acceptance, not on success. Without the receipt
// check a reverted settlement is indistinguishable from a completed payment.
export async function sendChecked(label, functionName, args, fallback) {
  const gas = await gasFor(functionName, args, fallback);
  const hash = await wal.writeContract({ address: ADDR, abi: ABI, functionName, args, gas, maxFeePerGas: MAX_FEE });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} reverted (gas ${gas}, used ${rc.gasUsed}) tx ${hash}`);
  return hash;
}
