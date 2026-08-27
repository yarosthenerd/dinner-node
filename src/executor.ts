/**
 * Plan execution: the wave loop.
 *
 * `plan.ts` decides what a plan IS and `readySteps` decides what may run next.
 * This file is the thing that actually walks a plan to completion, and it is
 * kept transport-free and chain-free for the same reason those two are: the
 * host wraps it in SSE and settles its token counts, the tests drive it with a
 * fake dispatch, and neither concern leaks into the sequencing logic.
 *
 * The invariant this file exists to protect is that EXECUTORS NEVER SEQUENCE.
 * A dispatch target receives a fully composed prompt and a ceiling, and knows
 * nothing about the plan it belongs to, which step ran before it, or what runs
 * next. That is what lets a wave of independent steps go to four different
 * providers without any of them being trusted.
 */
import { readySteps, type Plan, type PlanStep } from './plan';
import type { Chunk } from './engines';

/** Header used to introduce a dependency's output. Part of the prompt the
 *  model sees, so it is stable text rather than a template someone may retune
 *  later without noticing the step prompts were written against it. */
export const DEP_HEADER = (id: string) => `## Output of ${id}\n\n`;

export type StepOutcome = {
  id: string;
  /** The visible answer. Reasoning is deliberately not in here; see below. */
  text: string;
  /** Billed tokens: visible plus reasoning, matching what settle() charges. */
  tokens: number;
  /** Visible tokens only, which is what downstream steps actually consume. */
  visible: number;
  ok: boolean;
  /** Set when the step hit its own maxTokens ceiling and was cut off. */
  truncated?: boolean;
  code?: string;
  error?: string;
};

export type ExecEvent =
  | { kind: 'wave'; n: number; steps: string[] }
  | { kind: 'step_start'; id: string; title: string; maxTokens: number; promptTokens: number }
  | { kind: 'token'; id: string; t: string }
  | { kind: 'thought'; id: string; th: string }
  | { kind: 'step_done'; id: string; tokens: number; visible: number; truncated: boolean }
  | { kind: 'step_failed'; id: string; code: string; message: string }
  | { kind: 'plan_done'; ok: boolean; completed: string[]; failed: string[]; tokens: number };

/**
 * How a step reaches something that can answer it.
 *
 * The signature is the host's own engine shape with a step attached, so
 * dispatching to this node's engine is the identity case and dispatching to a
 * peer's /job is a different implementation of the same function. Adding
 * remote providers later needs no change here.
 */
export type Dispatch = (
  step: PlanStep,
  prompt: string,
  signal: AbortSignal,
) => AsyncGenerator<Chunk>;

export type ExecOptions = {
  /** Reject a composed prompt larger than this many tokens. The host passes
   *  its advertised PROMPT_BUDGET so a step fails here, before any money
   *  moves, rather than being silently truncated by the engine. */
  promptBudget?: number;
  /** How many steps of one wave may run at once. Defaults to 1, because on a
   *  single node the steps share one model and running four at once only
   *  interleaves them. Parallelism pays when the dispatch targets differ. */
  maxParallel?: number;
  /** Same four-characters-per-token estimate the host uses, injected so the
   *  two cannot drift apart. */
  estTokens?: (s: string) => number;
  signal?: AbortSignal;
};

const defaultEst = (s: string) => Math.ceil(s.length / 4);

/**
 * Build the prompt a step is actually sent.
 *
 * Dependency outputs are prepended in the order `dependsOn` lists them after
 * sorting, which is the same order `canonicalize` uses. Two runs of the same
 * plan therefore compose byte-identical prompts, which matters the moment a
 * step prompt is committed to or compared across providers.
 */
export function composePrompt(step: PlanStep, outputs: ReadonlyMap<string, string>): string {
  const deps = [...step.dependsOn].sort();
  if (deps.length === 0) return step.prompt;
  const parts = deps.map(id => DEP_HEADER(id) + (outputs.get(id) ?? '') + '\n\n');
  return parts.join('') + step.prompt;
}

/** Run one step to completion, enforcing its ceiling. Never throws. */
async function runStep(
  step: PlanStep,
  prompt: string,
  dispatch: Dispatch,
  parent: AbortSignal | undefined,
  emit: (e: ExecEvent) => void,
): Promise<StepOutcome> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  parent?.addEventListener('abort', onAbort, { once: true });

  let text = '';
  let tokens = 0;
  let visible = 0;
  let truncated = false;

  /**
   * A step that spent its whole ceiling and produced no visible output has
   * FAILED, however calmly it stopped.
   *
   * Measured on a live run: six steps at a 1,024 ceiling each burned the lot
   * on reasoning, emitted nothing, and the run reported ok=true with six of
   * six completed. The guest paid 0.312 MON for an empty answer that looked
   * like a success, which is worse than an error, because nothing downstream
   * had any reason to complain: the dependent steps then ran against empty
   * dependency output and produced their own empty results.
   */
  const finish = (): StepOutcome => {
    if (truncated && visible === 0) {
      return {
        id: step.id, text, tokens, visible, ok: false, truncated,
        code: 'ceiling_before_output',
        error: `spent all ${tokens} tokens of its ceiling on reasoning without producing an answer; `
          + `raise this step's maxTokens above ${tokens}`,
      };
    }
    return { id: step.id, text, tokens, visible, ok: true, truncated };
  };

  try {
    for await (const c of dispatch(step, prompt, ac.signal)) {
      if (c.th !== undefined) {
        // Reasoning is billed and forwarded, and it is NOT part of `text`.
        // A dependent step consumes the answer, not the deliberation that
        // produced it, and feeding reasoning downstream would spend a later
        // step's context on it. The host makes the same split for the same
        // reason; see the {th} handling in serveJob.
        tokens++;
        emit({ kind: 'thought', id: step.id, th: c.th });
      } else {
        tokens++;
        visible++;
        text += c.t;
        emit({ kind: 'token', id: step.id, t: c.t });
      }
      // The ceiling is enforced on BILLED tokens, because maxTokens is what
      // planCostWei multiplies by the rate. Enforcing it on visible tokens
      // would let a reasoning-heavy step bill several times what the guest
      // approved while still appearing to respect its ceiling.
      if (tokens >= step.maxTokens) {
        truncated = true;
        ac.abort();
        break;
      }
    }
    return finish();
  } catch (e: any) {
    // A ceiling abort surfaces here as an AbortError on some engines, and it
    // is a completed step rather than a failed one.
    if (truncated) return finish();
    return {
      id: step.id, text, tokens, visible, ok: false,
      code: 'engine_error', error: String(e?.message ?? e),
    };
  } finally {
    parent?.removeEventListener('abort', onAbort);
  }
}

/**
 * Walk a plan, wave by wave, yielding progress as it goes.
 *
 * Failure policy: once any step fails, no further step is STARTED, but steps
 * already in flight are allowed to finish. Their tokens are already spent, so
 * aborting them would throw away work the guest has paid for without saving
 * anything. The run then ends with `ok: false` and the failed ids named.
 */
export async function* executePlan(
  plan: Plan,
  dispatch: Dispatch,
  opts: ExecOptions = {},
): AsyncGenerator<ExecEvent> {
  const est = opts.estTokens ?? defaultEst;
  const maxParallel = Math.max(1, opts.maxParallel ?? 1);

  const outputs = new Map<string, string>();
  const completed = new Set<string>();
  const failed: string[] = [];
  let billed = 0;
  let wave = 0;

  while (true) {
    if (failed.length) break;
    if (opts.signal?.aborted) break;
    const ready = readySteps(plan, completed);
    if (ready.length === 0) break;

    wave++;
    yield { kind: 'wave', n: wave, steps: ready.map(s => s.id) };

    // Events from concurrent steps are merged through this queue rather than
    // interleaved by awaiting each generator in turn, which would serialise
    // exactly the parallelism the wave exists to express.
    const queue: ExecEvent[] = [];
    let wake: (() => void) | null = null;
    const emit = (e: ExecEvent) => { queue.push(e); wake?.(); wake = null; };

    const pending = [...ready];
    const results: StepOutcome[] = [];
    let active = 0;
    let finished = false;

    const start = (step: PlanStep) => {
      const prompt = composePrompt(step, outputs);
      const promptTokens = est(prompt);
      // Checked before dispatch, so an overflowing step costs nothing. This is
      // the failure mode prepending dependency output introduces: four 2,500
      // token research steps feeding one analysis step can compose a prompt
      // larger than the context window the node advertises.
      if (opts.promptBudget !== undefined && promptTokens > opts.promptBudget) {
        results.push({
          id: step.id, text: '', tokens: 0, visible: 0, ok: false, code: 'deps_over_budget',
          error: `composed prompt is ${promptTokens} tokens, this node's budget is ${opts.promptBudget}`,
        });
        return Promise.resolve();
      }
      emit({ kind: 'step_start', id: step.id, title: step.title, maxTokens: step.maxTokens, promptTokens });
      return runStep(step, prompt, dispatch, opts.signal, emit).then(r => { results.push(r); });
    };

    const pump = () => {
      // An abort stops scheduling as surely as a failure does. Without the
      // signal check here a caller who aborts mid-wave still pays for every
      // remaining step in that wave, which is the opposite of what abort is
      // for.
      while (active < maxParallel && pending.length && !failed.length && !opts.signal?.aborted) {
        const step = pending.shift()!;
        active++;
        void start(step).finally(() => {
          active--;
          if (active === 0 && (pending.length === 0 || failed.length || opts.signal?.aborted)) { finished = true; }
          pump();
          wake?.(); wake = null;
        });
      }
      if (active === 0 && (pending.length === 0 || opts.signal?.aborted)) { finished = true; wake?.(); wake = null; }
    };
    pump();

    // Drain: yield every event the running steps produce until the wave ends.
    while (!finished || queue.length) {
      if (queue.length === 0) {
        await new Promise<void>(r => { wake = r; });
        continue;
      }
      yield queue.shift()!;
    }

    for (const r of results) {
      billed += r.tokens;
      if (r.ok) {
        outputs.set(r.id, r.text);
        completed.add(r.id);
        yield { kind: 'step_done', id: r.id, tokens: r.tokens, visible: r.visible, truncated: !!r.truncated };
      } else {
        failed.push(r.id);
        yield { kind: 'step_failed', id: r.id, code: r.code ?? 'failed', message: r.error ?? 'step failed' };
      }
    }
  }

  yield {
    kind: 'plan_done',
    ok: failed.length === 0 && completed.size === plan.steps.length,
    completed: [...completed],
    failed,
    tokens: billed,
  };
}

/** The outputs of a finished run, in the plan's own step order. Convenience
 *  for a caller that wants the result rather than the progress. */
export function collect(plan: Plan, outputs: ReadonlyMap<string, string>): string {
  return plan.steps
    .filter(s => outputs.has(s.id))
    .map(s => `## ${s.title}\n\n${outputs.get(s.id)}`)
    .join('\n\n');
}
