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

const NODE = process.env.DINNER_NODE_ADDRESS ?? '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92';
const EXPLORER = 'https://testnet.monadvision.com';
const send = process.argv.includes('--send');

const art = (p) => {
  const j = JSON.parse(fs.readFileSync(`contracts/out/${p}`, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

const key = process.env.DEPLOYER_PK ?? process.env.HOUSE_PK;
if (!key) { console.error('set DEPLOYER_PK or HOUSE_PK'); process.exit(1); }
const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key);

const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });

const deploy = async (name, file, args = []) => {
  const { abi, bytecode } = art(file);
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

const verifier = await deploy('SemaphoreVerifier', 'SemaphoreVerifier.sol/SemaphoreVerifier.json');
const semaphore = await deploy('Semaphore', 'Semaphore.sol/Semaphore.json',
  [verifier ?? '0x0000000000000000000000000000000000000001']);
const ratings = await deploy('DinnerRatings', 'DinnerRatings.sol/DinnerRatings.json',
  [semaphore ?? '0x0000000000000000000000000000000000000001', NODE]);

if (!send) { console.log('\ndry run, nothing sent. re-run with --send'); process.exit(0); }

const after = await pub.getBalance({ address: account.address });
console.log(`\nspent ${formatEther(before - after)} MON, ${formatEther(after)} MON left`);
console.log('\nadd to web/.env and .env:');
console.log(`VITE_SEMAPHORE_ADDRESS=${semaphore}`);
console.log(`VITE_RATINGS_ADDRESS=${ratings}`);
