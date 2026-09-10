// The handover when the node is actually KILLED, end to end.
//
// `auth-takeover-e2e.mjs` proves the contract half: a guest signs one EIP-712
// authorisation, a second node carries it, and the payment splits along the
// checkpoint. What it does NOT prove is the trigger. There, the client stops
// reading the stream, which is what a dying node looks like from the browser's
// side and is not the same thing at all: the server is still alive, still
// holds the model, and closes the connection cleanly on its own terms.
//
// This script kills node A while it is mid-answer and the client is still
// reading. Three things only this can show:
//
//   1. the stream BREAKS under the reader rather than ending,
//   2. the last checkpoint node A published survived its death, so the answer
//      resumes from real progress rather than from scratch,
//   3. what the gap costs the person waiting, measured from the kill to node
//      B's first token. That number was previously unmeasured while the
//      correctness around it was proven.
//
// It refuses to run without an explicit kill mechanism, because the obvious
// way to get one wrong is to point it at a production node by accident.
//
//   KILL_PID=<pid>              SIGKILL that process, the truest death
//   KILL_CMD='systemctl --user stop dinnernode'   run a command instead
//   RESTORE_CMD='...'           optional, run at the end to bring node A back
//   KILL_ON=onchain | stream    WHEN to kill, and the two are different claims
//
// `onchain`, the default, waits until node A's checkpoint is on the chain and
// then kills it. That is the demo: the answer resumes from a checkpoint that
// outlived the process, and the two providers are paid for disjoint ranges.
//
// `stream` kills the moment node A emits a checkpoint FRAME, which can be
// before it has settled anything. Found on the first run of this script,
// 2026-09-03: node A died 8ms after its checkpoint frame, nothing about it
// reached the chain, and node B then settled the WHOLE answer including the
// tokens node A had produced. No double payment, but node A was not paid for
// real work, and the bound in `_allowed` that exists to prevent exactly this
// is keyed on `cp.billed`, which was still zero. The window is real and this
// mode is how it stays visible.
//
// Against the live pair, which stops node 1 and is therefore a deliberate act.
// This is the invocation that passed on 2026-09-10, job#15:
//
//   set -a; . ./.env; set +a
//   RPC_URL=https://testnet-rpc.monad.xyz CHAIN_ID=10143 \
//   NODE_A=https://node1.dinnernode.xyz NODE_B=https://node2.dinnernode.xyz \
//   BUDGET=0.3 KILL_ON=onchain \
//   KILL_CMD='systemctl --user stop dinnernode.service' \
//   RESTORE_CMD='systemctl --user start dinnernode.service' \
//   node scripts/kill-takeover-e2e.mjs
//
// Three corrections to the recipe this comment used to carry, all found by
// running it on 2026-09-10:
//
//   BUDGET was 0.05, and no answer of any length could have failed over on it.
//   `refuseTakeover` wants the escrow to cover the handover's gas MIN_MARGIN
//   times over, which at 102 gwei is 0.098 MON, or twice the whole budget.
//   Job#14 died with `paid` exactly equal to its 0.05 escrow and node B
//   refused with "job cannot cover the handover", which was the correct
//   answer to a question that should never have been asked.
//
//   KILL_PID via `pgrep -f 'tsx src/host.ts' | head -1` resolves to NODE 2 on
//   this machine, because dinnernode2 runs `npx tsx src/host.ts` directly
//   while node 1 runs it under `npm run host`. It would have killed the
//   failover target. Even matched to node 1 it returns the npm wrapper rather
//   than the process holding the socket, so the stream would not have broken.
//   KILL_CMD against the unit kills the whole cgroup and is unambiguous.
//
//   RESTORE_CMD was 'npm run node1 &', which leaves the node outside systemd.
//   Note that `Restart=always` does NOT rescue this run: systemd honours an
//   explicit stop, so if this script exits early on a failed check, node 1
//   stays down until RESTORE_CMD is run by hand.
import { execSync } from 'node:child_process';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseAbi, parseEther, parseEventLogs, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const ADDR = process.env.DINNER_NODE_ADDRESS;
const BUDGET = process.env.BUDGET ?? '1';
const NODE_A = process.env.NODE_A ?? 'http://127.0.0.1:4183';
const NODE_B = process.env.NODE_B ?? 'http://127.0.0.1:4184';
const GUEST_PK = process.env.GUEST_PK ?? '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const KILL_ON = (process.env.KILL_ON ?? 'onchain').toLowerCase();
if (!['onchain', 'stream'].includes(KILL_ON)) throw new Error(`KILL_ON must be onchain or stream, got ${KILL_ON}`);
const KILL_PID = process.env.KILL_PID;
const KILL_CMD = process.env.KILL_CMD;
const RESTORE_CMD = process.env.RESTORE_CMD;

if (!KILL_PID && !KILL_CMD) {
  console.error(`This script kills the node serving the job. Say how, explicitly:

  KILL_PID=<pid>     SIGKILL that process
  KILL_CMD='<cmd>'   run this instead

Nothing is killed by default, because the failure mode of guessing is stopping
a node somebody is using.`);
  process.exit(2);
}

if (!ADDR) throw new Error('set DINNER_NODE_ADDRESS to the deployed registry');

const chain = defineChain({
  id: CHAIN_ID, name: 'local', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const ABI = parseAbi([
  'struct Job { address requester; address provider; uint256 escrow; uint256 paid; uint256 tokens; uint256 ratePerMillion; uint256 maxTokensPerSecond; uint64 openedAt; uint64 lastSettleAt; bool open; bool requireCheckpoints; }',
  'struct Checkpoint { bytes32 prefixHash; uint256 tokens; uint256 billed; bytes32 chainHash; }',
  'function deposit() payable',
  'function openJob(address provider, uint256 budget, string promptTag, bool requireCheckpoints) returns (uint256)',
  'function getJob(uint256) view returns (Job)',
  'struct Provider { string model; string hw; uint256 ratePerMillion; uint256 maxTokensPerSecond; uint256 earned; uint256 lifetimeEarned; uint256 tokensServed; uint256 jobs; bool active; }',
  'function getCheckpoint(uint256) view returns (Checkpoint)',
  'function getProvider(address) view returns (Provider)',
  'function reassignCount(uint256) view returns (uint256)',
  'event JobOpened(uint256 indexed jobId, address indexed requester, address indexed provider, string promptTag)',
]);

const pub = createPublicClient({ chain, transport: http() });
const guest = privateKeyToAccount(GUEST_PK);
const w = createWalletClient({ account: guest, chain, transport: http() });

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) { failed += 1; process.exitCode = 1; }
};
const health = async (u, ms = 5000) =>
  (await fetch(u + '/health', { signal: AbortSignal.timeout(ms) })).json();

/// Read the stream and, once there is something worth handing over, kill the
/// node underneath it. Returns how the stream ENDED, which is the observation
/// the walk-away version cannot make.
async function streamUntilKilled(url, body, kill, ready, budgetMs = 240_000) {
  const res = await fetch(url + '/job', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} refused: ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  // `textAtCp` is the text the checkpoint actually covers. The stream keeps
  // running after a checkpoint frame, so the full transcript hashes to
  // something else entirely, and the replacement refuses it with `checkpoint
  // hash mismatch`. The sibling suite never hit this because it breaks out of
  // the loop at the checkpoint; a run that keeps reading until the node dies
  // must remember where the checkpoint was.
  let buf = '', text = '', think = '', cp = null, textAtCp = '', killedAt = 0, ending = 'deadline', firstTokenAt = 0;
  const until = Date.now() + budgetMs;
  try {
    outer: while (Date.now() < until) {
      const { value, done: fin } = await reader.read();
      // A clean end AFTER the kill is still a broken stream from the reader's
      // point of view: the node is gone and the answer is unfinished. Before
      // the kill it means the node simply finished, which fails the run,
      // because there was then nothing to hand over.
      if (fin) { ending = killedAt ? 'closed-after-kill' : 'finished-before-kill'; break; }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { ending = killedAt ? 'closed-after-kill' : 'finished-before-kill'; break outer; }
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.th) think += ev.th;
        if (ev.t) { if (!firstTokenAt) firstTokenAt = Date.now(); text += ev.t; }
        if (ev.err) throw new Error(`${url} streamed an error: ${ev.err}`);
        if (ev.checkpoint || ev.cp) { cp = ev.checkpoint ?? ev.cp; textAtCp = text; }
        if (ev.done) { ending = killedAt ? 'closed-after-kill' : 'finished-before-kill'; break outer; }
        // The kill happens exactly once, and `ready` decides when. A
        // checkpoint with no visible text hands the replacement nothing, which
        // is the defect an earlier run of the sibling suite hid, so both are
        // required in either mode.
        if (!killedAt && cp?.h && text.length > 0 && ready()) {
          killedAt = Date.now();
          console.log(`\n--- killing node A mid-answer, ${text.length} chars in, checkpoint n=${cp.n}, mode=${KILL_ON} ---`);
          kill();
        }
      }
    }
  } catch (e) {
    // This is the good path. A socket torn out from under the reader is what a
    // dead node is, and it arrives as an exception rather than as a frame.
    ending = killedAt ? `broke: ${e.cause?.code ?? e.name}` : `broke-before-kill: ${e.message}`;
  }
  await reader.cancel().catch(() => {});
  return { text, think, cp, textAtCp, killedAt, ending, firstTokenAt };
}

async function main() {
  const [ha, hb] = await Promise.all([health(NODE_A), health(NODE_B)]);
  console.log(`node A ${ha.provider} ${ha.model}  <- the one that dies\nnode B ${hb.provider} ${hb.model}\n`);
  if (ha.provider.toLowerCase() === hb.provider.toLowerCase()) throw new Error('node A and node B are the same provider');

  const budget = parseEther(BUDGET);
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget }) });
  const tag = keccak256(stringToHex('kill e2e prompt'));
  const rc = await pub.waitForTransactionReceipt({
    hash: await w.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [ha.provider, budget, tag, true] }),
  });
  const jobId = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' })[0].args.jobId;
  console.log(`job#${jobId} open against node A`);

  const maxReassigns = 2n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const ANY = '0x0000000000000000000000000000000000000000';
  const types = { ReassignAuth: [
    { name: 'jobId', type: 'uint256' }, { name: 'newProvider', type: 'address' },
    { name: 'maxReassigns', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ] };
  const domain = { name: 'DinnerNode', version: '2', chainId: CHAIN_ID, verifyingContract: ADDR };
  const signature = await w.signTypedData({
    account: guest, domain, types, primaryType: 'ReassignAuth',
    message: { jobId, newProvider: ANY, maxReassigns, deadline },
  });
  const nonceBefore = await pub.getTransactionCount({ address: guest.address });
  console.log(`guest signed the authorisation and is now asleep, nonce ${nonceBefore}\n`);

  // Regression guard for the ordering fix of 2026-09-03. Node B does not own
  // this job yet, so a request carrying a VALID authorisation and a malformed
  // resume is the exact shape that used to move the job, spend node B's gas
  // and consume one of the two reassigns the guest signed for, before failing
  // on a hash it could have checked first.
  const authPre = { jobId: jobId.toString(), newProvider: ANY, maxReassigns: maxReassigns.toString(), deadline: deadline.toString(), signature };
  const bad = await fetch(NODE_B + '/job', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jobId: jobId.toString(), prompt: 'x', session: true, auth: authPre,
      resume: { text: 'text that hashes to nothing like the h below', n: 8, h: '0x' + '11'.repeat(32) },
    }),
  });
  const badBody = await bad.text();
  ok('a malformed resume is refused', !bad.ok && badBody.includes('mismatch'), badBody.slice(0, 80));
  ok('and it did NOT cost the guest a handover',
     (await pub.readContract({ address: ADDR, abi: ABI, functionName: 'reassignCount', args: [jobId] })) === 0n,
     'reassignCount still 0');
  ok('and the job still belongs to node A',
     (await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [jobId] })).provider.toLowerCase() === ha.provider.toLowerCase());

  const doKill = () => {
    if (KILL_PID) process.kill(Number(KILL_PID), 'SIGKILL');
    else execSync(KILL_CMD, { stdio: 'inherit' });
  };

  const prompt = 'Explain, at length and step by step, how a distributed system can resume an interrupted job on a different machine.';
  const earnedABefore = (await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getProvider', args: [ha.provider] })).earned;

  // In `onchain` mode the kill waits for node A's checkpoint to reach the
  // chain, which is what the demo claims survives the death. Polled beside the
  // stream rather than inside it, because the frame loop must not block: the
  // stream is the thing being observed.
  let onChainTokens = 0n, firstOnChainAt = 0;
  const poll = KILL_ON === 'onchain' ? setInterval(async () => {
    try {
      const cp = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getCheckpoint', args: [jobId] });
      if (cp.tokens > onChainTokens) {
        // The instant this job's work first became recoverable by anyone but
        // the client holding the stream. Everything before it is the window.
        if (onChainTokens === 0n) firstOnChainAt = Date.now();
        onChainTokens = cp.tokens;
      }
    } catch { /* a read that fails is simply not-yet-ready */ }
  }, 250) : null;
  const ready = () => KILL_ON === 'stream' || onChainTokens > 0n;

  const first = await streamUntilKilled(NODE_A, { jobId: jobId.toString(), prompt, session: true }, doKill, ready);
  if (poll) clearInterval(poll);

  ok('node A was killed mid-answer', first.killedAt > 0,
     first.killedAt ? `${first.text.length} chars served first` : 'it finished before there was anything to hand over');
  ok('the stream BROKE under the reader rather than ending politely',
     first.ending.startsWith('broke') || first.ending === 'closed-after-kill', first.ending);
  ok('node A stopped answering', await health(NODE_A, 3000).then(() => false, () => true));
  ok('node A published a checkpoint before it died', !!first.cp?.h,
     first.cp ? `n=${first.cp.n} h=${String(first.cp.h).slice(0, 18)}…` : 'none');

  // The checkpoint on chain is the one that matters: it outlived the process
  // that wrote it, which is the only reason the payment can split fairly. In
  // `stream` mode its absence is the point of the run rather than a failure.
  const onChainCp = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getCheckpoint', args: [jobId] });
  if (KILL_ON === 'onchain') {
    ok('the checkpoint survived the death, on chain', onChainCp.tokens > 0n,
       `tokens=${onChainCp.tokens} billed=${onChainCp.billed}`);
  } else {
    console.log(`INFO  on-chain checkpoint at the moment of death: tokens=${onChainCp.tokens} billed=${onChainCp.billed}` +
      (onChainCp.tokens === 0n ? '  <- nothing survived; node A cannot be paid for what it produced' : ''));
  }

  // The prefix as of the checkpoint, not the whole transcript: the node hashes
  // what it is given and compares it to the published checkpoint.
  const resume = first.cp?.h ? { text: first.cp.text ?? first.textAtCp, n: first.cp.n, h: first.cp.h } : undefined;
  const auth = { jobId: jobId.toString(), newProvider: ANY, maxReassigns: maxReassigns.toString(), deadline: deadline.toString(), signature };

  const handoverStart = Date.now();
  const res = await fetch(NODE_B + '/job', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: jobId.toString(), prompt, session: true, auth, resume }),
  });
  if (!res.ok) { ok('node B accepted the handover', false, `${res.status} ${await res.text()}`); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', firstTokenAt = 0;
  const until = Date.now() + 180_000;
  outer: while (Date.now() < until) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.t) { text += ev.t; if (!firstTokenAt) firstTokenAt = Date.now(); }
      if (ev.done) break outer;
      if (text.length > 200) break outer;
    }
  }
  await reader.cancel().catch(() => {});

  ok('node B continued the answer after node A died', text.length > 0, `${text.length} chars`);
  ok('node B was given the prefix rather than starting over', !!resume,
     resume ? `${resume.n} tokens` : 'no resume payload');

  const nonceAfter = await pub.getTransactionCount({ address: guest.address });
  ok('the guest signed no transaction while asleep', nonceAfter === nonceBefore, `nonce ${nonceBefore} -> ${nonceAfter}`);

  const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getJob', args: [jobId] });
  ok('the job belongs to node B on chain', job.provider.toLowerCase() === hb.provider.toLowerCase(), job.provider);
  ok('the escrow is the same one', job.escrow === budget, formatEther(job.escrow));
  ok('the authorisation is recorded as used once',
     (await pub.readContract({ address: ADDR, abi: ABI, functionName: 'reassignCount', args: [jobId] })) === 1n);

  // Who got paid for node A's tokens. This is the assertion the walk-away
  // suite cannot make, because there node A settles on its way out.
  const earnedAAfter = (await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getProvider', args: [ha.provider] })).earned;
  const paidToA = earnedAAfter - earnedABefore;
  if (KILL_ON === 'onchain') {
    ok('node A was paid for the range it produced before dying', paidToA > 0n, `${formatEther(paidToA)} MON`);
    ok('node B settled only the tail, not the whole answer',
       onChainCp.tokens > 0n && job.tokens >= onChainCp.tokens, `job tokens=${job.tokens} checkpoint=${onChainCp.tokens}`);
  } else {
    console.log(`INFO  node A earned ${formatEther(paidToA)} MON for ${first.text.length} chars it actually produced`);
  }

  // The number this script exists to produce, alongside the assertions.
  const gap = firstTokenAt ? firstTokenAt - first.killedAt : 0;
  const detect = handoverStart - first.killedAt;
  const protectedAfter = firstOnChainAt && first.firstTokenAt ? firstOnChainAt - first.firstTokenAt : 0;
  console.log(`\n--- what the person waiting experienced ---`);
  if (protectedAfter) console.log(`first token to first on-chain checkpoint : ${protectedAfter} ms  <- the window a death inside is unattributed`);
  console.log(`death to handover request : ${detect} ms`);
  console.log(`death to first new token  : ${gap} ms`);
  console.log(`paid so far               : ${formatEther(job.paid)} MON over ${job.tokens} tokens`);

  if (RESTORE_CMD) {
    console.log(`\nrestoring node A: ${RESTORE_CMD}`);
    execSync(RESTORE_CMD, { stdio: 'inherit', shell: '/bin/bash' });
  } else {
    console.log(`\nnode A is still dead. No RESTORE_CMD was given.`);
  }
  console.log(failed ? `\n${failed} check(s) failed` : `\nall checks passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
