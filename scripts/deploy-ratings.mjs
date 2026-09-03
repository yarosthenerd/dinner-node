// Deploy the anonymous-ratings stack to Monad testnet.
//
//   node scripts/deploy-ratings.mjs            dry run, prints costs only
//   node scripts/deploy-ratings.mjs --send     deploys
//
// Order matters: SemaphoreVerifier, then Semaphore holding the verifier, then
// DinnerRatings which creates its own group in the constructor and holds the
// DinnerNode address it checks jobs against.
import 'dotenv/config';
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const monadTestnet = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});

const NODE = process.env.DINNER_NODE_ADDRESS ?? '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c';
const EXPLORER = 'https://testnet.monadvision.com';
const send = process.argv.includes('--send');

const art = (p) => {
  const j = JSON.parse(fs.readFileSync(`contracts/out/${p}`, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences ?? {} };
};

/// Splice deployed library addresses into a contract's creation code.
///
/// Semaphore calls PoseidonT3 as an EXTERNAL library, so solc leaves a
/// placeholder (`__$<hash>$__`) at every call site and the deployer is
/// expected to fill them in. Skipping this does not produce a revert: the
/// initcode is then not valid hex, and Monad's RPC answers a bare
/// `-32602 Invalid params` to eth_estimateGas, which reads like an RPC fault
/// and is not one. `forge test` never sees this because it deploys and links
/// libraries itself, so the contract tests all pass against code that cannot
/// be deployed by this script.
///
/// The offsets come from the artifact rather than from matching the
/// placeholder text, because the artifact is authoritative about where they
/// are and the placeholder hash is a keccak of the fully qualified name.
const link = (bytecode, links, libs) => {
  let out = bytecode;
  for (const [file, entries] of Object.entries(links)) {
    for (const [name, spots] of Object.entries(entries)) {
      const addr = libs[name];
      if (!addr) throw new Error(`${file}:${name} is unlinked and no address was given for it`);
      const body = addr.toLowerCase().replace(/^0x/, '');
      if (body.length !== 40) throw new Error(`bad library address for ${name}: ${addr}`);
      for (const { start, length } of spots) {
        if (length !== 20) throw new Error(`unexpected link length ${length} for ${name}`);
        // start is a byte offset into the bytecode; +2 skips the 0x.
        const i = 2 + start * 2;
        out = out.slice(0, i) + body + out.slice(i + 40);
      }
    }
  }
  if (/__\$/.test(out)) throw new Error('bytecode still holds an unlinked placeholder');
  return out;
};

const key = process.env.DEPLOYER_PK ?? process.env.HOUSE_PK;
if (!key) { console.error('set DEPLOYER_PK or HOUSE_PK'); process.exit(1); }
const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key);

const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });

const deploy = async (name, file, args = [], libs = {}) => {
  const a = art(file);
  const abi = a.abi;
  const bytecode = link(a.bytecode, a.links, libs);
  // estimateContractGas is for calls; a deployment is estimated from its
  // creation data, which is the bytecode with the constructor args appended.
  let gas;
  try {
    gas = await pub.estimateGas({ account, data: encodeDeployData({ abi, bytecode, args }) });
  } catch (e) {
    console.log(`${name.padEnd(18)} estimate failed: ${e.shortMessage ?? e.message}`);
    if (!send) return null;
    throw e;
  }
  const price = await pub.getGasPrice();
  const cost = gas * price;
  console.log(`${name.padEnd(18)} gas ${String(gas).padStart(9)}  ${formatEther(cost)} MON`);
  if (!send) return null;
  const hash = await wallet.deployContract({ abi, bytecode, args, gas: (gas * 12n) / 10n });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${name} deploy reverted: ${hash}`);
  console.log(`  -> ${rc.contractAddress}  ${EXPLORER}/tx/${hash}`);
  return rc.contractAddress;
};

const before = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address}  ${formatEther(before)} MON`);
console.log(`node     ${NODE}\n`);

// Reuse anything a previous run already put on chain. The verifier alone is
// 3,825,292 gas, so a re-run after a mid-sequence failure should not pay for
// it twice.
const VERIFIER = process.env.SEMAPHORE_VERIFIER_ADDRESS ?? null;
const POSEIDON = process.env.POSEIDON_T3_ADDRESS ?? null;

const reuse = (name, addr) => { console.log(`${name.padEnd(18)} reusing ${addr}`); return addr; };

const verifier = VERIFIER
  ? reuse('SemaphoreVerifier', VERIFIER)
  : await deploy('SemaphoreVerifier', 'SemaphoreVerifier.sol/SemaphoreVerifier.json');

// Deployed and linked before Semaphore, which calls into it externally.
const poseidon = POSEIDON
  ? reuse('PoseidonT3', POSEIDON)
  : await deploy('PoseidonT3', 'PoseidonT3.sol/PoseidonT3.json');

const semaphore = await deploy('Semaphore', 'Semaphore.sol/Semaphore.json',
  [verifier ?? '0x0000000000000000000000000000000000000001'],
  { PoseidonT3: poseidon ?? '0x0000000000000000000000000000000000000001' });
const ratings = await deploy('DinnerRatings', 'DinnerRatings.sol/DinnerRatings.json',
  [semaphore ?? '0x0000000000000000000000000000000000000001', NODE]);

if (!send) { console.log('\ndry run, nothing sent. re-run with --send'); process.exit(0); }

const after = await pub.getBalance({ address: account.address });
console.log(`\nspent ${formatEther(before - after)} MON, ${formatEther(after)} MON left`);
console.log('\nadd to web/.env and .env:');
console.log(`POSEIDON_T3_ADDRESS=${poseidon}`);
console.log(`SEMAPHORE_VERIFIER_ADDRESS=${verifier}`);
console.log(`VITE_SEMAPHORE_ADDRESS=${semaphore}`);
console.log(`VITE_RATINGS_ADDRESS=${ratings}`);
