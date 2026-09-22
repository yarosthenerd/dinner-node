/**
 * Deploy DinnerNodeV2 to Monad testnet.
 *
 * The instance at 0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd predates
 * `reassignWithAuth`, so calling DOMAIN_SEPARATOR() on it reverts and the
 * gasless failover is inert in production: the browser probes for the selector
 * once and falls back to asking the guest to confirm a transaction. That is
 * the whole reason for this script.
 *
 * Read-only unless --send is passed. Run it once without, read the estimate,
 * then run it again with.
 *
 *   node scripts/deploy-v2.mjs
 *   node scripts/deploy-v2.mjs --send
 *
 * The key is DEPLOYER_PK, falling back to HOUSE_PK, read from the environment
 * and written nowhere. The contract takes no constructor arguments.
 *
 * What this script does NOT do, deliberately, because each is a decision:
 *   - move the 5.126 MON held by the old registry. See scripts/drain-v1.mjs,
 *     which is the same job against v1 and is the template.
 *   - redeploy DinnerRatings, which pins the registry address in its
 *     constructor and will keep checking jobs against the old one.
 *   - change any file. Run scripts/set-registry.mjs with the new address.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const monadTestnet = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});

const EXPLORER = 'https://testnet.monadvision.com';
const OLD = process.env.DINNER_NODE_ADDRESS ?? '0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd';
const send = process.argv.includes('--send');

const key = process.env.DEPLOYER_PK ?? process.env.HOUSE_PK;
if (!key) { console.error('set DEPLOYER_PK or HOUSE_PK'); process.exit(1); }
const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key);

const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });

const artifact = JSON.parse(fs.readFileSync('contracts/out/DinnerNodeV2.sol/DinnerNodeV2.json', 'utf8'));
const abi = artifact.abi;
const bytecode = artifact.bytecode.object;
if (/__\$/.test(bytecode)) throw new Error('bytecode holds an unlinked library placeholder');

// The selector this deploy exists to add. Asserted against the artifact before
// spending anything, so a stale `forge build` cannot produce a deploy that is
// identical to what is already on chain.
const hasAuth = abi.some(f => f.type === 'function' && f.name === 'reassignWithAuth');
const hasDomain = abi.some(f => f.type === 'function' && f.name === 'DOMAIN_SEPARATOR');
if (!hasAuth || !hasDomain) {
  console.error('the built artifact has no reassignWithAuth/DOMAIN_SEPARATOR. Run: cd contracts && forge build');
  process.exit(1);
}

const balance = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address}  ${formatEther(balance)} MON`);
console.log(`old      ${OLD}`);

// Prove the old instance actually lacks it, rather than trusting the note above.
const old = await pub.readContract({ address: OLD, abi, functionName: 'DOMAIN_SEPARATOR' })
  .then(v => v).catch(() => null);
console.log(`old DOMAIN_SEPARATOR: ${old ?? 'reverts, so it is the pre-auth build'}`);
if (old) console.log('  !  the deployed instance ALREADY has it. A redeploy may not be what you want.');

const data = encodeDeployData({ abi, bytecode, args: [] });
const gas = await pub.estimateGas({ account, data });
const price = await pub.getGasPrice();
console.log(`\nDinnerNodeV2  gas ${gas}  at ${Number(price) / 1e9} gwei  =  ${formatEther(gas * price)} MON`);

if (!send) {
  console.log('\ndry run. re-run with --send to deploy.');
  process.exit(0);
}

const hash = await wallet.deployContract({ abi, bytecode, args: [], gas: (gas * 12n) / 10n });
console.log(`  tx ${EXPLORER}/tx/${hash}`);
const rc = await pub.waitForTransactionReceipt({ hash });
if (rc.status !== 'success') { console.error('deploy reverted'); process.exit(1); }
const addr = rc.contractAddress;
console.log(`  -> ${addr}`);

// Verify the new instance answers the selector, because a deploy that does not
// is a deploy that changed nothing a guest can feel.
const sep = await pub.readContract({ address: addr, abi, functionName: 'DOMAIN_SEPARATOR' });
console.log(`  DOMAIN_SEPARATOR ${sep}`);

console.log(`\nnext:\n  node scripts/set-registry.mjs ${addr}`);
