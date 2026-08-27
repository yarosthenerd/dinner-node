// Plan as a job, in the browser.
//
// Three states, and the middle one is the point of the whole feature: the
// guest sees the plan and its committed ceiling BEFORE any step runs, and
// nothing is executed until they say so. A plan that ran on approval would be
// an agent; a plan the guest approves is a quote.
//
// The escrow pays for both halves. Planning is billed like any other
// generation, so the job is opened before /plan rather than before /plan/run,
// and the same job carries the run.
import { useCallback, useMemo, useRef, useState } from 'react';
import { formatEther, keccak256, parseEther, parseEventLogs, toHex } from 'viem';
import { runPlan, requestPlan, waves, type ExecEvent, type PlanResult } from '../lib/plan-client';

type Props = {
  pub: any;
  wallet: any;
  guestAddress: `0x${string}`;
  nodeAddress: `0x${string}`;
  nodeAbi: any;
  /// The host to plan against, already health-checked by the caller.
  host: string;
  provider: `0x${string}`;
  maxFee: bigint;
  explorer: string;
};

/// Escrow for a planned job. Larger than a single answer's budget because it
/// funds the planning run AND every step: a measured seven step plan billed
/// 14,405 tokens end to end, about 0.48 MON at this node's rate.
const PLAN_BUDGET = parseEther('1.5');

type StepState = {
  status: 'waiting' | 'running' | 'done' | 'failed';
  text: string;
  tokens: number;
  visible: number;
  truncated?: boolean;
  error?: string;
};

export default function PlanPanel({ pub, wallet, guestAddress, nodeAddress, nodeAbi, host, provider, maxFee, explorer }: Props) {
  const [goal, setGoal] = useState('Compare the running cost of a home GPU against a rented cloud GPU for LLM inference, and say which is cheaper and at what utilization.');
  const [phase, setPhase] = useState<'idle' | 'planning' | 'review' | 'running' | 'finished'>('idle');
  const [note, setNote] = useState('');
  const [planning, setPlanning] = useState({ reasoning: 0, visible: 0 });
  const [result, setResult] = useState<PlanResult | null>(null);
  const [jobId, setJobId] = useState<bigint | null>(null);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [wave, setWave] = useState(0);
  const [summary, setSummary] = useState<{ ok: boolean; tokens: number; failed: string[] } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);

  const plannedWaves = useMemo(() => (result ? waves(result.plan) : []), [result]);

  /// Open a job for this plan, or reuse one this panel already opened and has
  /// not spent. Read from the chain rather than from local state, because
  /// settle() closes a job the moment its escrow runs out.
  const ensureJob = useCallback(async (): Promise<bigint> => {
    if (jobId !== null) {
      try {
        const j = await pub.readContract({ address: nodeAddress, abi: nodeAbi, functionName: 'jobs', args: [jobId] }) as readonly any[];
        const [requester, , escrow, paid, , isOpen] = j as unknown as [string, string, bigint, bigint, bigint, boolean];
        if (isOpen && requester.toLowerCase() === guestAddress.toLowerCase() && escrow - paid > parseEther('0.2')) return jobId;
      } catch { /* fall through and open a new one */ }
    }
    const dep = await pub.readContract({ address: nodeAddress, abi: nodeAbi, functionName: 'deposits', args: [guestAddress] }) as bigint;
    if (dep < PLAN_BUDGET) {
      // Top up only the shortfall. closeJob returns unspent escrow to the
      // deposit rather than the wallet, so a second plan usually needs far
      // less than the full budget.
      setNote(`depositing ${formatEther(PLAN_BUDGET - dep)} MON…`);
      const h = await wallet.writeContract({ address: nodeAddress, abi: nodeAbi, functionName: 'deposit', args: [], value: PLAN_BUDGET - dep, gas: 200000n, maxFeePerGas: maxFee });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    setNote('opening the job…');
    // Salted per job and discarded here, exactly as the single-answer path
    // does it. The goal is the guest's text and must not reach the chain.
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const tag = keccak256(new TextEncoder().encode(salt + '|' + goal));
    const h = await wallet.writeContract({ address: nodeAddress, abi: nodeAbi, functionName: 'openJob', args: [provider, PLAN_BUDGET, tag], gas: 300000n, maxFeePerGas: maxFee });
    const rc = await pub.waitForTransactionReceipt({ hash: h });
    // `nodeAbi` arrives as `any` from the caller, so viem cannot infer the
    // event's argument shape and types the log without `args`.
    const [log] = parseEventLogs({ abi: nodeAbi, logs: rc.logs, eventName: 'JobOpened' }) as any[];
    const id = log.args.jobId as bigint;
    setJobId(id);
    return id;
  }, [jobId, pub, wallet, nodeAddress, nodeAbi, guestAddress, provider, maxFee, goal]);

  async function plan() {
    if (!goal.trim()) return;
    setPhase('planning');
    setResult(null); setSteps({}); setSummary(null); setWave(0);
    setPlanning({ reasoning: 0, visible: 0 });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const id = await ensureJob();
      setNote('planning. this takes a minute or two, and the reasoning below is billed.');
      const r = await requestPlan(host, id, goal, f => {
        setPlanning(p => f.th !== undefined ? { ...p, reasoning: p.reasoning + 1 } : { ...p, visible: p.visible + 1 });
      }, ac.signal);
      setResult(r);
      setPhase('review');
      setNote('');
    } catch (e: any) {
      setPhase('idle');
      setNote(e?.shortMessage ?? e?.message ?? 'planning failed');
    }
  }

  async function run() {
    if (!result || jobId === null) return;
    setPhase('running');
    setNote('');
    const init: Record<string, StepState> = {};
    for (const s of result.plan.steps) init[s.id] = { status: 'waiting', text: '', tokens: 0, visible: 0 };
    setSteps(init);
    const ac = new AbortController();
    abortRef.current = ac;
    const on = (e: ExecEvent) => {
      if (e.kind === 'wave') setWave(e.n);
      else if (e.kind === 'step_start') setSteps(s => ({ ...s, [e.id]: { ...s[e.id], status: 'running' } }));
      else if (e.kind === 'token') setSteps(s => ({ ...s, [e.id]: { ...s[e.id], text: s[e.id].text + e.t, tokens: s[e.id].tokens + 1, visible: s[e.id].visible + 1 } }));
      else if (e.kind === 'thought') setSteps(s => ({ ...s, [e.id]: { ...s[e.id], tokens: s[e.id].tokens + 1 } }));
      else if (e.kind === 'step_done') setSteps(s => ({ ...s, [e.id]: { ...s[e.id], status: 'done', tokens: e.tokens, visible: e.visible, truncated: e.truncated } }));
      else if (e.kind === 'step_failed') {
        if (!e.id) { setNote(e.message); return; }
        setSteps(s => ({ ...s, [e.id]: { ...s[e.id], status: 'failed', error: `${e.code}: ${e.message}` } }));
      } else if (e.kind === 'plan_done') setSummary({ ok: e.ok, tokens: e.tokens, failed: e.failed });
    };
    try {
      await runPlan(host, jobId, result.plan, on, ac.signal);
    } catch (e: any) {
      setNote(e?.shortMessage ?? e?.message ?? 'the run ended early');
    }
    setPhase('finished');
  }

  /// Release the escrow the guest has not spent. The node leaves a plan job
  /// open for the session, so without this the remainder sits there until the
  /// idle timer fires.
  /// Release the escrow the guest has not spent, AFTER giving the node time to
  /// settle what it produced.
  ///
  /// closeJob the instant a run finishes trips settle()'s require(j.open) and
  /// takes tokens the provider already delivered. Measured on job#88: the
  /// final settle of 575 tokens landed thirteen seconds after the last frame
  /// of the stream, and a guest clicking this button immediately would have
  /// won that race and kept the work for free.
  ///
  /// The node publishes its own backstop as settleMaxMs, so the wait is that
  /// number rather than a constant that silently stops matching. Polled, so
  /// the common case still returns in about a second. This is the same shape
  /// as releaseJob in App.tsx and for the same reason.
  async function close() {
    if (jobId === null) return;
    setNote('waiting for the node to settle what it produced…');
    let graceMs = 65000;
    try {
      const h = await (await fetch(host + '/health', { signal: AbortSignal.timeout(6000) })).json();
      if (h?.settleMaxMs) graceMs = Number(h.settleMaxMs) + 5000;
    } catch { /* the default already covers this node's published backstop */ }
    try {
      const deadline = Date.now() + graceMs;
      for (;;) {
        const cur = await pub.readContract({ address: nodeAddress, abi: nodeAbi, functionName: 'jobs', args: [jobId] }) as readonly any[];
        // The node closes a plan job itself once it goes idle, so a job that is
        // already shut needs nothing from us.
        if (!cur[5]) { setNote('the node closed it and settled. nothing left to release.'); setJobId(null); return; }
        if (Date.now() >= deadline) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      setNote('closing the job and returning unspent escrow…');
      const h = await wallet.writeContract({ address: nodeAddress, abi: nodeAbi, functionName: 'closeJob', args: [jobId], gas: 200000n, maxFeePerGas: maxFee });
      await pub.waitForTransactionReceipt({ hash: h });
      setNote('closed. the unspent remainder is back on your deposit.');
      setJobId(null);
    } catch (e: any) {
      setNote(e?.shortMessage ?? 'could not close the job');
    }
  }

  const busy = phase === 'planning' || phase === 'running';
  const costMon = result ? formatEther(BigInt(result.costWei)) : null;

  return (
    <div className="card">
      <h2>plan a job</h2>
      <p className="dim">
        A goal becomes a set of steps with a cost ceiling committed before any of
        them run. Independent steps are grouped into waves, which is the shape
        that lets different machines take different steps. You approve the plan
        and its ceiling before a single step is paid for.
      </p>

      <textarea
        className="composer"
        rows={3}
        value={goal}
        disabled={busy}
        onChange={e => setGoal(e.target.value)}
        placeholder="what do you want done?"
      />

      <div className="composer-row">
        {phase === 'idle' && <button className="cta" onClick={plan} disabled={!goal.trim()}>plan it</button>}
        {phase === 'planning' && (
          <span className="dim">
            planning… {planning.reasoning} reasoning + {planning.visible} visible tokens billed so far
          </span>
        )}
        {phase === 'review' && (
          <>
            <button className="cta" onClick={run}>run this plan</button>
            <button onClick={() => { setResult(null); setPhase('idle'); }}>discard</button>
          </>
        )}
        {phase === 'running' && <span className="dim">running, wave {wave}…</span>}
        {phase === 'finished' && <button onClick={() => { setResult(null); setSteps({}); setSummary(null); setPhase('idle'); }}>plan another</button>}
        {jobId !== null && !busy && <button onClick={close}>close job#{jobId.toString()}</button>}
      </div>

      {note && <div className="note">{note}</div>}

      {jobId !== null && (
        <div className="dim">
          job <a href={`${explorer}/address/${nodeAddress}`} target="_blank" rel="noreferrer">#{jobId.toString()}</a>
          {' '}· escrow {formatEther(PLAN_BUDGET)} MON, unspent is refunded on close
        </div>
      )}

      {result && (
        <div className="receipt">
            {/* Composed here rather than rendered from the node's `summary`
              string, which already ends in "ceiling N MON" and so printed the
              ceiling twice next to the row below it. This also stops the panel
              depending on the node's phrasing. */}
          <div className="rrow">
            <span>{result.plan.steps.length} steps, up to {result.plan.steps.reduce((n, s) => n + s.maxTokens, 0)} tokens</span>
          </div>
          <div className="rrow dim">
            <span>ceiling</span><span>{costMon} MON</span>
          </div>
          <div className="rrow dim">
            <span>plan hash</span><span>{result.planHash.slice(0, 10)}…{result.planHash.slice(-6)}</span>
          </div>
          {plannedWaves.map((ids, i) => (
            <div key={i}>
              <div className="rowline">
                wave {i + 1}
                {ids.length > 1 && <span className="dim"> · {ids.length} steps that can run on different machines at once</span>}
              </div>
              {ids.map(id => {
                const s = result.plan.steps.find(x => x.id === id)!;
                const st = steps[id];
                return (
                  <div className="rrow" key={id}>
                    <span onClick={() => setOpen(o => ({ ...o, [id]: !o[id] }))} style={{ cursor: 'pointer' }}>
                      {st?.status === 'done' ? '✓ ' : st?.status === 'failed' ? '✕ ' : st?.status === 'running' ? '… ' : ''}
                      {s.title}
                    </span>
                    <span className="dim">{st && st.status !== 'waiting' ? `${st.visible}/${s.maxTokens} tok` : `${s.maxTokens} tok`}</span>
                  </div>
                );
              })}
              {ids.map(id => open[id] && (
                <div className="engram-preview" key={id + '-body'}>
                  <div className="dim">{result.plan.steps.find(x => x.id === id)!.prompt}</div>
                  {steps[id]?.error && <div className="engram-err">{steps[id].error}</div>}
                  {steps[id]?.text && <div className="md">{steps[id].text}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {summary && (
        <div className="note">
          {summary.ok
            ? `done. ${summary.tokens} tokens billed across ${result?.plan.steps.length} steps.`
            : `finished with ${summary.failed.length} failed step(s): ${summary.failed.join(', ')}. ${summary.tokens} tokens billed.`}
          {' '}Unspent escrow comes back when you close the job.
        </div>
      )}

      {phase === 'finished' && summary?.ok && result && (
        <div className="artifacts">
          <button onClick={() => {
            const body = result.plan.steps
              .filter(s => steps[s.id]?.text)
              .map(s => `## ${s.title}\n\n${steps[s.id].text}`).join('\n\n');
            const blob = new Blob([`# ${result.plan.goal}\n\n${body}`], { type: 'text/markdown' });
            const href = URL.createObjectURL(blob);
            const el = document.createElement('a');
            el.href = href; el.download = 'plan-output.md'; el.click();
            setTimeout(() => URL.revokeObjectURL(href), 1000);
          }}>download the whole answer</button>
        </div>
      )}
    </div>
  );
}
