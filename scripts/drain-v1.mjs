/**
 * Take the value out of DinnerNode v1 before nothing watches it any more.
 *
 * v1 stays callable forever, so nothing here is urgent and nothing is lost by
 * skipping it. What it is, is about 3.87 MON sitting in a contract that no
 * running code points at: node 1's unwithdrawn earnings, node 2's, and the
 * guest's unspent deposits.
 *
 * Read-only unless --send is passed. Run it once without, read what it found,
 * then run it again with. Every key is read from the environment; none is
 * written anywhere.
 *
 *   node scripts/drain-v1.mjs
 *   node scripts/drain-v1.mjs --send
 *
 * Keys it looks for, all optional, each drained if present. The node 2 key
 * lives in .env.node2 rather than .env, so pass that file explicitly:
 *
 *   PROVIDER_PK  a node     withdraw() and refund()
 *   GUEST_PK     the guest  withdraw() and refund()
 *   HOUSE_PK     the house  withdraw() and refund()
 *
 * Both calls are attempted for every key, because a wallet can hold both: the
 * house key is the faucet AND was the cloud kitchen's provider key, and a node
 * that ever opened a job of its own has a deposit as well as earnings.
 *
 *   node scripts/drain-v1.mjs                              # node 1 and the guest
 *   env $(grep PROVIDER_PK .env.node2) node scripts/drain-v1.mjs   # node 2
 */
import 'dotenv/config';
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// v1, deliberately hardcoded. This script exists to talk to the OLD contract,
// so reading DINNER_NODE_ADDRESS would point it at v2 and do nothing useful.
const V1 = '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92';
const EXPLORER = 'https://testnet.monadvision.com';
const MAX_FEE = 2000000000000n;

const chain = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});
const ABI = [
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'refund', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'deposits', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  // v1's positional shape, which is the whole reason this is a separate file.
  { name: 'providers', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }] },
];

const pub = createPublicClient({ chain, transport: http() });
const send = process.argv.includes('--send');

const KEYS = [
  ['node', process.env.PROVIDER_PK],
  ['guest', process.env.GUEST_PK],
  ['house', process.env.HOUSE_PK],
];

let total = 0n;
for (const [label, pk] of KEYS) {
  if (!pk) { console.log(`${label.padEnd(7)} no key in the environment, skipped`); continue; }
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  const w = createWalletClient({ account, chain, transport: http() });
  const [p, dep] = await Promise.all([
    pub.readContract({ address: V1, abi: ABI, functionName: 'providers', args: [account.address] }),
    pub.readContract({ address: V1, abi: ABI, functionName: 'deposits', args: [account.address] }),
  ]);
  const earned = p[3];
  console.log(`${label.padEnd(7)} ${account.address}  earned ${formatEther(earned)} MON  deposit ${formatEther(dep)} MON`);
  total += earned + dep;
  if (!send) continue;

  for (const [fn, amount] of [['withdraw', earned], ['refund', dep]]) {
    if (amount === 0n) continue;
    try {
      const h = await w.writeContract({ address: V1, abi: ABI, functionName: fn, args: [], gas: 120000n, maxFeePerGas: MAX_FEE });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      // writeContract resolves on acceptance, not on success. A reverted
      // withdraw reported as a completed one is how value goes missing
      // quietly, so the receipt is checked rather than assumed.
      console.log(`  ${fn} ${formatEther(amount)} MON  ${rc.status}  ${EXPLORER}/tx/${h}`);
    } catch (e) {
      console.log(`  ${fn} FAILED:`, e?.shortMessage ?? e?.message ?? e);
    }
  }
}

console.log(`\n${formatEther(total)} MON found in v1${send ? '' : '. Re-run with --send to move it.'}`);
// Open jobs are NOT closed here. Each node's own idle timer closes its jobs and
// refunds the remainder to the guest's deposit, so closing them from outside
// would race that and burn gas on a revert. Drain the deposits after the nodes
// have been stopped and their timers have fired.
