// Talking to a node's /plan and /plan/run.
//
// The event shapes here mirror src/executor.ts and the two host handlers
// exactly. They are duplicated rather than imported because the browser and
// the daemon are separate builds with separate tsconfigs, so this file is the
// place to look when the node's frames change and the UI stops understanding
// them.
//
// Everything is transport, nothing is policy. Deciding whether a plan is worth
// running belongs to the guest looking at it, and opening the job belongs to
// the caller that holds the wallet. The one exception is canonicalize below,
// which is policy on purpose: the guest has to be able to compute the hash it
// commits without taking the node's word for it.
import { keccak256, stringToHex } from 'viem';

export type PlanStep = {
  id: string;
  title: string;
  prompt: string;
  maxTokens: number;
  dependsOn: string[];
};

export type Plan = { version: number; goal: string; steps: PlanStep[] };

/**
 * The exact bytes a plan hashes to. A byte-for-byte copy of canonicalize() in
 * src/plan.ts, and src/__tests__/plan.test.ts asserts the two agree on real
 * plans, because a commitment computed two ways is worth nothing if the two
 * ways differ.
 *
 * This exists in the browser so the guest commits a hash of the plan THEY were
 * shown rather than a hash the node handed them. A node that returned a
 * planHash for different text than it displayed would otherwise get that hash
 * signed by the guest.
 */
export function canonicalize(plan: Plan): string {
  return JSON.stringify({
    version: plan.version,
    goal: plan.goal,
    steps: plan.steps.map(s => ({
      id: s.id,
      title: s.title,
      prompt: s.prompt,
      maxTokens: s.maxTokens,
      // Sorted: dependency order is a set, and two plans differing only in the
      // order they list the same dependencies are the same plan.
      dependsOn: [...s.dependsOn].sort(),
    })),
  });
}

/** What commitPlan stores. Never hash a non-canonical form. */
export function planHash(plan: Plan): `0x${string}` {
  return keccak256(stringToHex(canonicalize(plan)));
}

/** Tokens a plan may burn at most, which is what the ceiling is priced from. */
export function planMaxTokens(plan: Plan): bigint {
  return plan.steps.reduce((n, s) => n + BigInt(s.maxTokens), 0n);
}

/// What /plan returns once it has a plan it is willing to stand behind.
export type PlanResult = {
  plan: Plan;
  planHash: `0x${string}`;
  costWei: string;
  summary: string;
  attempts: number;
};

export type ExecEvent =
  | { kind: 'wave'; n: number; steps: string[] }
  | { kind: 'step_start'; id: string; title: string; maxTokens: number; promptTokens: number }
  | { kind: 'token'; id: string; t: string }
  | { kind: 'thought'; id: string; th: string }
  | { kind: 'step_done'; id: string; tokens: number; visible: number; truncated: boolean }
  | { kind: 'step_failed'; id: string; code: string; message: string }
  | { kind: 'plan_done'; ok: boolean; completed: string[]; failed: string[]; tokens: number };

export const TUNNEL_HEADERS = { 'bypass-tunnel-reminder': '1', 'ngrok-skip-browser-warning': 'true' };

/**
 * Read one SSE response, handing each parsed frame to `onFrame`.
 *
 * Resolves when the node sends [DONE] or the body ends. A frame that does not
 * parse is skipped rather than fatal: a single malformed line should not throw
 * away an answer the guest has already paid for.
 */
export async function readStream(
  url: string,
  body: unknown,
  onFrame: (f: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...TUNNEL_HEADERS },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`${url} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    // The last element is a partial line unless the chunk ended on a newline,
    // so it goes back in the buffer rather than being parsed.
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (l === 'data: [DONE]') return;
      if (!l.startsWith('data: ')) continue;
      try { onFrame(JSON.parse(l.slice(6))); } catch { /* skip a torn frame */ }
    }
  }
  if (buf.trim() === 'data: [DONE]') return;
}

/**
 * Ask a node to plan a goal against an open job.
 *
 * The reasoning and the raw planner output are streamed through `onProgress`
 * so the guest sees a model working rather than two minutes of nothing. Both
 * are billed, which is why they are shown.
 */
export async function requestPlan(
  host: string,
  jobId: bigint,
  goal: string,
  onProgress: (f: { th?: string; t?: string }) => void,
  signal?: AbortSignal,
): Promise<PlanResult> {
  type PlanFailure = { err: string; issues?: { code: string; message: string }[] };
  // Held in a one-element box because these are written inside a callback, and
  // TypeScript's control flow analysis cannot see through that: assigning to a
  // plain `let` here leaves it narrowed to null for every read below.
  const box: { result: PlanResult | null; failure: PlanFailure | null } = { result: null, failure: null };
  await readStream(host + '/plan', { jobId: String(jobId), goal }, f => {
    if (f.plan) box.result = f as PlanResult;
    else if (f.err) box.failure = f as PlanFailure;
    else onProgress(f);
  }, signal);
  if (box.result) return box.result;
  const issues = box.failure?.issues?.map(i => i.message).join('; ');
  throw new Error(box.failure?.err
    ? `${box.failure.err}${issues ? ': ' + issues : ''}`
    : 'the node ended the stream without a plan');
}

/// Run a plan the guest has accepted, streaming every executor event.
export async function runPlan(
  host: string,
  jobId: bigint,
  plan: Plan,
  onEvent: (e: ExecEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  await readStream(host + '/plan/run', { jobId: String(jobId), plan }, f => {
    if (f.kind) onEvent(f as ExecEvent);
    // `run` is the opening frame carrying the hash the node is about to
    // execute, and `err` is a mid-stream failure. Both are surfaced as events
    // so the caller has one place to handle everything.
    else if (f.err) onEvent({ kind: 'step_failed', id: '', code: 'stream', message: String(f.err) });
  }, signal);
}

/// Steps whose dependencies are all satisfied, for drawing the waves a plan
/// will run in before it runs. Mirrors readySteps in src/plan.ts.
export function waves(plan: Plan): string[][] {
  const done = new Set<string>();
  const out: string[][] = [];
  // Bounded by step count: every pass must complete at least one step or the
  // graph has a cycle, which the node's validator already rejects.
  for (let guard = 0; guard < plan.steps.length + 1; guard++) {
    const ready = plan.steps.filter(s => !done.has(s.id) && s.dependsOn.every(d => done.has(d)));
    if (!ready.length) break;
    out.push(ready.map(s => s.id));
    for (const s of ready) done.add(s.id);
  }
  return out;
}
