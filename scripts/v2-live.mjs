// The seven defects, re-checked against a DEPLOYED DinnerNodeV2.
//
// contracts/test/DinnerNodeV2Defects.t.sol already proves these in Foundry,
// where time is a variable and gas is free. This script proves the same
// properties against the real contract on Monad testnet, with real wallets,
// real elapsed seconds and real MON, because the two places this project has
// been bitten before were both things a unit test cannot see: a settlement
// that reverted while the node logged success, and a read that decoded the
// wrong field.
//
//   DINNER_NODE_V2=0x... node scripts/v2-live.mjs
//
// Wallets: PROVIDER_PK is provider A and pays for everything, HOUSE_PK is the
// replacement provider B, GUEST_PK is the guest. Nothing here touches the v1
// contract the live site and both running nodes use.
import 'dotenv/config';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseEther, parseEventLogs, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } } });
const ADDR = process.env.DINNER_NODE_V2;
if (!ADDR) { console.error('set DINNER_NODE_V2'); process.exit(1); }
const EXPLORER = 'https://testnet.monadvision.com';
const MAX_FEE = 2000000000000n;

// Cheap on purpose: 1e15 wei per million tokens makes 100,000 tokens cost
// 0.0001 MON, so the whole run is gas rather than escrow.
const RATE = 1_000_000_000_000_000n;
const FAST = 10_000n;
const SLOW = 100n;

const JOB = { components: [
  { name: 'requester', type: 'address' }, { name: 'provider', type: 'address' },
  { name: 'escrow', type: 'uint256' }, { name: 'paid', type: 'uint256' },
  { name: 'tokens', type: 'uint256' }, { name: 'ratePerMillion', type: 'uint256' },
  { name: 'maxTokensPerSecond', type: 'uint256' }, { name: 'openedAt', type: 'uint64' },
  { name: 'lastSettleAt', type: 'uint64' }, { name: 'open', type: 'bool' },
  { name: 'requireCheckpoints', type: 'bool' },
], name: 'j', type: 'tuple' };
const PROV = { components: [
  { name: 'model', type: 'string' }, { name: 'hw', type: 'string' },
  { name: 'ratePerMillion', type: 'uint256' }, { name: 'maxTokensPerSecond', type: 'uint256' },
  { name: 'earned', type: 'uint256' }, { name: 'lifetimeEarned', type: 'uint256' },
  { name: 'tokensServed', type: 'uint256' }, { name: 'jobs', type: 'uint256' },
  { name: 'active', type: 'bool' },
], name: 'p', type: 'tuple' };
const CP = { components: [
  { name: 'prefixHash', type: 'bytes32' }, { name: 'tokens', type: 'uint256' },
  { name: 'billed', type: 'uint256' }, { name: 'chainHash', type: 'bytes32' },
], name: 'c', type: 'tuple' };

const fn = (name, inputs, outputs, mut = 'nonpayable') => ({ name, type: 'function', stateMutability: mut, inputs, outputs });
const ABI = [
  fn('registerProvider', [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }], []),
  fn('deposit', [], [], 'payable'),
  fn('deposits', [{ type: 'address' }], [{ type: 'uint256' }], 'view'),
  fn('openJob', [{ type: 'address' }, { type: 'uint256' }, { type: 'string' }, { type: 'bool' }], [{ type: 'uint256' }]),
  fn('topUp', [{ type: 'uint256' }, { type: 'uint256' }], []),
  fn('settle', [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], []),
  fn('commitCheckpoint', [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], []),
  fn('reassign', [{ type: 'uint256' }, { type: 'address' }], []),
  fn('closeJob', [{ type: 'uint256' }], []),
  fn('getJob', [{ type: 'uint256' }], [JOB], 'view'),
  fn('getProvider', [{ type: 'address' }], [PROV], 'view'),
  fn('getCheckpoint', [{ type: 'uint256' }], [CP], 'view'),
  fn('remainingBudget', [{ type: 'uint256' }], [{ type: 'uint256' }], 'view'),
  { name: 'JobOpened', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'requester', type: 'address', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'promptTag', type: 'string' }] },
  { name: 'JobExhausted', type: 'event', inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'totalTokens', type: 'uint256' }, { name: 'totalPaid', type: 'uint256' }] },
];

const key = k => { const v = process.env[k]; return v.startsWith('0x') ? v : '0x' + v; };
const pub = createPublicClient({ chain, transport: http() });
const A = privateKeyToAccount(key('PROVIDER_PK'));  // provider A, and the funder
const B = privateKeyToAccount(key('HOUSE_PK'));     // provider B, the replacement
const G = privateKeyToAccount(key('GUEST_PK'));     // the guest
const wA = createWalletClient({ account: A, chain, transport: http() });
const wB = createWalletClient({ account: B, chain, transport: http() });
const wG = createWalletClient({ account: G, chain, transport: http() });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${got}, want ${want}`);

// Every write goes through here: writeContract resolves on ACCEPTANCE, not on
// success, and a reverted transaction logged as a success is the exact defect
// that hid a broken settle path in this project for a day.
async function send(w, functionName, args, fallback = 300000n) {
  // Monad charges the gas LIMIT, not the gas used, so a padded constant is a
  // real cost and a tight one that reverts burns the whole limit. Estimating
  // per call is the same discipline src/host.ts uses, and it turns a failing
  // require into a clear error here instead of a burned transaction.
  let gas = fallback;
  try { gas = (await pub.estimateContractGas({ address: ADDR, abi: ABI, functionName, args, account: w.account })) * 125n / 100n; } catch { /* let it revert on chain and report */ }
  const hash = await w.writeContract({ address: ADDR, abi: ABI, functionName, args, gas, maxFeePerGas: MAX_FEE });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${functionName} REVERTED ${EXPLORER}/tx/${hash}`);
  return rc;
}
async function expectRevert(name, w, functionName, args) {
  try {
    await pub.simulateContract({ address: ADDR, abi: ABI, functionName, args, account: w.account });
    ok(name, false, 'did not revert');
  } catch (e) {
    const m = e.shortMessage ?? e.message;
    ok(name, true, m.split('\n')[0].slice(0, 70));
  }
}
const getJob = id => pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [id] });
const getProv = a => pub.readContract({ address: ADDR, abi: ABI, functionName: 'getProvider', args: [a] });
const getCp = id => pub.readContract({ address: ADDR, abi: ABI, functionName: 'getCheckpoint', args: [id] });
const cpHash = n => keccak256(stringToHex(`prefix-${n}`));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openJob(w, provider, budget, requireCheckpoints) {
  const dep = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [w.account.address] });
  if (dep < budget) {
    // deposit() is the one payable call here, so it does not go through send().
    const gas = await pub.estimateContractGas({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget - dep, account: w.account });
    const hash = await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget - dep, gas: gas * 125n / 100n, maxFeePerGas: MAX_FEE });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`deposit reverted ${EXPLORER}/tx/${hash}`);
  }
  const rc = await send(w, 'openJob', [provider, budget, 'v2-live', requireCheckpoints]);
  const [log] = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' });
  return log.args.jobId;
}

async function main() {
  console.log(`DinnerNodeV2 live check\n  contract ${ADDR}\n  A(provider) ${A.address}\n  B(replacement) ${B.address}\n  G(guest) ${G.address}\n`);

  // ---- funding and registration -----------------------------------------
  const gBal = await pub.getBalance({ address: G.address });
  if (gBal < parseEther('0.5')) {
    console.log(`  funding guest (${formatEther(gBal)} MON)...`);
    const hash = await wA.sendTransaction({ to: G.address, value: parseEther('1'), maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: 1n, gas: 21000n });
    await pub.waitForTransactionReceipt({ hash });
  }
  console.log('  registering A(fast) and B(slow) on the new contract...');
  // B starts FAST so the double-pay check below is bound by the CHECKPOINT and
  // not by throughput; it is re-registered SLOW before the throughput check.
  await send(wA, 'registerProvider', ['live-check-A', 'hw', RATE, FAST]);
  await send(wB, 'registerProvider', ['live-check-B', 'hw', RATE, FAST]);

  // ---- 7. named struct reads --------------------------------------------
  console.log('\n7. struct reads, so index drift cannot happen');
  const id0 = await openJob(wG, A.address, parseEther('0.01'), true);
  const j0 = await getJob(id0);
  ok('getJob returns named fields', j0.requester.toLowerCase() === G.address.toLowerCase() && j0.open === true && j0.requireCheckpoints === true,
     `open=${j0.open} requireCheckpoints=${j0.requireCheckpoints} rate=${j0.ratePerMillion}`);
  ok('remainingBudget agrees with escrow-paid',
     (await pub.readContract({ address: ADDR, abi: ABI, functionName: 'remainingBudget', args: [id0] })) === j0.escrow - j0.paid);

  // ---- 1c. a job that requires checkpoints refuses a bare settle ---------
  console.log('\n1. settle is clamped to published progress');
  await expectRevert('a required checkpoint cannot be skipped', wA, 'settle', [id0, 100_000n, '0x' + '00'.repeat(32), 0n, 0n]);

  // 1b. claim far more than the checkpoint evidences.
  await sleep(4000); // real elapsed seconds; A is FAST so throughput is not the binding cap
  await send(wA, 'settle', [id0, 90_000n, cpHash(1), 10_000n, 10_000n]);
  const j1 = await getJob(id0);
  eq('a provider cannot outrun its own checkpoints', j1.tokens, 10_000n);
  eq('and is paid only for what it published', j1.paid, 10_000n * RATE / 1_000_000n);

  // ---- 4. checkpoints advance, and they chain ---------------------------
  console.log('\n4. checkpoints advance, and they chain');
  await expectRevert('same-height rewrite is refused', wA, 'commitCheckpoint', [id0, cpHash(99), 10_000n, 10_000n]);
  await expectRevert('going backwards is refused', wA, 'commitCheckpoint', [id0, cpHash(99), 5_000n, 20_000n]);
  await expectRevert('billed below visible is refused', wA, 'commitCheckpoint', [id0, cpHash(99), 20_000n, 19_999n]);
  const cpBefore = await getCp(id0);
  await send(wA, 'commitCheckpoint', [id0, cpHash(2), 20_000n, 30_000n]);
  const cpAfter = await getCp(id0);
  ok('the chain hash advances over the whole history', cpAfter.chainHash !== cpBefore.chainHash,
     `${cpBefore.chainHash.slice(0, 12)} -> ${cpAfter.chainHash.slice(0, 12)}`);
  ok('reasoning stays billable above the visible prefix', cpAfter.billed > cpAfter.tokens,
     `visible ${cpAfter.tokens}, billed ${cpAfter.billed}`);

  // ---- 1a. a replacement cannot be paid for the prefix it inherited ------
  //
  // Note this reads the state AFTER reassign rather than before, because
  // reassign now settles the outgoing provider out (defect 2). A's checkpoint
  // stands at 30,000 billed and the job had paid for 10,000, so A collects the
  // 20,000 it published and the job's cumulative count becomes 30,000. That is
  // the baseline B inherits.
  // Real elapsed seconds, so the throughput bound is not the binding one. On a
  // chain with sub-second blocks this gap is the difference between measuring
  // the checkpoint clamp and measuring how fast the last block arrived.
  await sleep(6000);
  const beforeHandover = await getJob(id0);
  await send(wG, 'reassign', [id0, B.address]);
  const afterHandover = await getJob(id0);
  ok('the outgoing provider collected what it published',
     afterHandover.tokens > beforeHandover.tokens && afterHandover.tokens <= 30_000n,
     `${beforeHandover.tokens} -> ${afterHandover.tokens}, its checkpoint stood at 30000 billed`);
  await sleep(6000);
  // B now publishes a checkpoint covering the WHOLE 60,000 token answer,
  // including A's prefix, and bills for all of it.
  await send(wB, 'settle', [id0, 60_000n, cpHash(3), 40_000n, 60_000n]);
  const j2 = await getJob(id0);
  // The job's cumulative count is the published total, NOT the sum. B was paid
  // for 30,000 -- the part above what the job had already paid for -- and the
  // guest is not charged twice for A's prefix.
  eq('the job counts the published total, not the sum', j2.tokens, 60_000n);
  ok('so the guest is never charged twice for the prefix',
     j2.tokens < afterHandover.tokens + 60_000n,
     `cumulative ${j2.tokens}, not ${afterHandover.tokens + 60_000n}; B billed 60000 and was paid for ${j2.tokens - afterHandover.tokens}`);

  // ---- 2. reassign pays out the work it takes away ----------------------
  console.log('\n2. reassign cannot strand the outgoing provider');
  const idR = await openJob(wG, A.address, parseEther('0.01'), true);
  await sleep(4000);
  await send(wA, 'commitCheckpoint', [idR, cpHash(10), 5_000n, 5_000n]);
  const beforeR = await getJob(idR);
  eq('nothing settled yet', beforeR.paid, 0n);
  const aEarnedBefore = (await getProv(A.address)).earned;
  await send(wG, 'reassign', [idR, B.address]);
  const afterR = await getJob(idR);
  ok('the outgoing provider is paid on reassign', afterR.paid > 0n, `paid ${formatEther(afterR.paid)} MON`);
  ok('and the money reached provider A', (await getProv(A.address)).earned > aEarnedBefore);
  ok('the job now belongs to B', afterR.provider.toLowerCase() === B.address.toLowerCase());

  // ---- 3. reassign never raises the throughput ceiling ------------------
  console.log('\n3. reassign never raises maxTokensPerSecond');
  await send(wB, 'registerProvider', ['live-check-B', 'hw', RATE, SLOW]);
  const idT = await openJob(wG, B.address, parseEther('0.01'), true); // opened against SLOW B
  const jT0 = await getJob(idT);
  eq('job locked the slow figure', jT0.maxTokensPerSecond, SLOW);
  await send(wG, 'reassign', [idT, A.address]);                        // handed to FAST A
  const jT1 = await getJob(idT);
  eq('handover did not raise it', jT1.maxTokensPerSecond, SLOW);
  await sleep(4000);
  await send(wA, 'settle', [idT, 1_000_000n, cpHash(20), 900_000n, 1_000_000n]);
  const jT2 = await getJob(idT);
  ok('and the locked figure actually binds', jT2.tokens < 2_000n,
     `${jT2.tokens} tokens, not the 1,000,000 claimed`);

  // ---- 5. reputation ignores self-dealing -------------------------------
  console.log('\n5. reputation counters ignore self-dealing');
  const repBefore = await getProv(A.address);
  const idS = await openJob(wA, A.address, parseEther('0.01'), false);  // A is BOTH parties
  await sleep(4000);
  await send(wA, 'settle', [idS, 50_000n, '0x' + '00'.repeat(32), 0n, 0n]);
  const repAfter = await getProv(A.address);
  eq('tokensServed did not move', repAfter.tokensServed, repBefore.tokensServed);
  eq('lifetimeEarned did not move', repAfter.lifetimeEarned, repBefore.lifetimeEarned);
  ok('but the withdrawable balance did', repAfter.earned > repBefore.earned,
     `${formatEther(repBefore.earned)} -> ${formatEther(repAfter.earned)} MON`);
  await send(wA, 'closeJob', [idS]);

  // ---- 6. topUp rescues an exhausted job --------------------------------
  console.log('\n6. topUp can rescue an exhausted job');
  // 100 tokens' worth of escrow at RATE, so one settle drains it exactly.
  const tiny = 100n * RATE / 1_000_000n;
  const idE = await openJob(wG, A.address, tiny, false);
  await sleep(4000);
  const rcE = await send(wA, 'settle', [idE, 100_000n, '0x' + '00'.repeat(32), 0n, 0n]);
  const exhausted = parseEventLogs({ abi: ABI, logs: rcE.logs, eventName: 'JobExhausted' });
  ok('exhaustion announces itself', exhausted.length === 1);
  const jE = await getJob(idE);
  eq('escrow is spent', jE.paid, tiny);
  ok('and the job is STILL OPEN', jE.open === true, 'this is the whole defect: it used to close here');
  // topUp draws on the deposit balance, and openJob drained it. The guest has
  // to put money back in before they can extend the job.
  {
    const gas = await pub.estimateContractGas({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: tiny, account: G });
    const h = await wG.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: tiny, gas: gas * 125n / 100n, maxFeePerGas: MAX_FEE });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  await send(wG, 'topUp', [idE, tiny]);
  await sleep(4000);
  await send(wA, 'settle', [idE, 100_000n, '0x' + '00'.repeat(32), 0n, 0n]);
  const jE2 = await getJob(idE);
  ok('topUp revived it and the run continued', jE2.paid > jE.paid,
     `${formatEther(jE.paid)} -> ${formatEther(jE2.paid)} MON`);

  // ---- tidy up -----------------------------------------------------------
  for (const [w, id] of [[wG, id0], [wG, idR], [wG, idT], [wG, idE]]) {
    try { await send(w, 'closeJob', [id]); } catch { /* already closed */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('\nFATAL', e.shortMessage ?? e.message); process.exit(1); });
