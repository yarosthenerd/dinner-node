// The wave loop, driven by a fake dispatch.
//
// Everything here is about sequencing and accounting, which is what the
// executor is for. There is no engine, no HTTP and no chain in this file, and
// there should not be: the point of keeping executePlan transport-free is that
// its behaviour can be pinned down exactly, including the failure paths that
// are awkward to provoke against a real model.
import { describe, expect, it, vi } from 'vitest';
import { composePrompt, executePlan, collect, type Dispatch, type ExecEvent } from '../executor';
import type { Plan, PlanStep } from '../plan';

const step = (id: string, dependsOn: string[] = [], over: Partial<PlanStep> = {}): PlanStep => ({
  id, title: id, prompt: `do ${id}`, maxTokens: 100, dependsOn, ...over,
});

const plan = (steps: PlanStep[]): Plan => ({ version: 1, goal: 'g', steps });

/// A dispatch that answers each step with fixed text, one chunk per word, and
/// records the prompt it was handed so the composition can be asserted.
function fakeDispatch(answers: Record<string, string>, seen: string[] = []) {
  const d: Dispatch = async function* (s, prompt) {
    seen.push(prompt);
    for (const w of (answers[s.id] ?? s.id).split(' ')) yield { t: w + ' ' } as any;
  };
  return { d, seen };
}

const drain = async (g: AsyncGenerator<ExecEvent>) => {
  const out: ExecEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
};
const kinds = (es: ExecEvent[], k: ExecEvent['kind']) => es.filter(e => e.kind === k);

describe('composePrompt', () => {
  it('returns the bare prompt when a step has no dependencies', () => {
    expect(composePrompt(step('a'), new Map())).toBe('do a');
  });

  it('prepends each dependency output under its own header', () => {
    const s = step('c', ['a', 'b']);
    const out = composePrompt(s, new Map([['a', 'AAA'], ['b', 'BBB']]));
    expect(out).toBe('## Output of a\n\nAAA\n\n## Output of b\n\nBBB\n\ndo c');
  });

  it('orders dependencies the same way canonicalize does', () => {
    // Same set listed in the other order has to compose identical bytes, or
    // two runs of one plan would disagree about what was sent.
    const outs = new Map([['a', 'AAA'], ['b', 'BBB']]);
    expect(composePrompt(step('c', ['b', 'a']), outs))
      .toBe(composePrompt(step('c', ['a', 'b']), outs));
  });
});

describe('executePlan', () => {
  it('runs a linear plan and feeds each output forward', async () => {
    const { d, seen } = fakeDispatch({ a: 'ALPHA', b: 'BETA' });
    const events = await drain(executePlan(plan([step('a'), step('b', ['a'])]), d));
    const done = kinds(events, 'plan_done')[0] as any;
    expect(done.ok).toBe(true);
    expect(done.completed).toEqual(['a', 'b']);
    expect(seen[1]).toBe('## Output of a\n\nALPHA \n\ndo b');
  });

  it('groups independent steps into one wave', async () => {
    const { d } = fakeDispatch({});
    const p = plan([step('a'), step('b'), step('c'), step('sum', ['a', 'b', 'c'])]);
    const waves = kinds(await drain(executePlan(p, d)), 'wave') as any[];
    expect(waves).toHaveLength(2);
    expect(waves[0].steps.sort()).toEqual(['a', 'b', 'c']);
    expect(waves[1].steps).toEqual(['sum']);
  });

  it('bills reasoning but keeps it out of the text passed downstream', async () => {
    const seen: string[] = [];
    const d: Dispatch = async function* (s, prompt) {
      seen.push(prompt);
      if (s.id === 'a') { yield { th: 'thinking ' } as any; yield { t: 'ANSWER' } as any; }
      else yield { t: 'ok' } as any;
    };
    const events = await drain(executePlan(plan([step('a'), step('b', ['a'])]), d));
    const doneA = kinds(events, 'step_done').find((e: any) => e.id === 'a') as any;
    // Two billed tokens, one of them visible.
    expect(doneA.tokens).toBe(2);
    expect(doneA.visible).toBe(1);
    // The downstream step sees the answer and not the deliberation.
    expect(seen[1]).toContain('ANSWER');
    expect(seen[1]).not.toContain('thinking');
    expect(kinds(events, 'thought')).toHaveLength(1);
  });

  it('enforces the ceiling on billed tokens, reasoning included', async () => {
    // Reasoning counts against the ceiling because maxTokens is what
    // planCostWei escrows. Counting only visible output would let a
    // reasoning-heavy step bill several times what the guest approved.
    const d: Dispatch = async function* () {
      for (let i = 0; i < 10; i++) yield { th: 'x' } as any;
      yield { t: 'never reached' } as any;
    };
    const events = await drain(executePlan(plan([step('a', [], { maxTokens: 3 })]), d));
    const failed = kinds(events, 'step_failed')[0] as any;
    // Cut off at exactly the ceiling, and reported as a failure rather than a
    // success, because it never reached an answer. See the ceiling_before_output
    // block below.
    expect(failed.code).toBe('ceiling_before_output');
    expect(failed.message).toContain('all 3 tokens');
  });

  it('counts reasoning against the ceiling even when an answer does arrive', async () => {
    const d: Dispatch = async function* () {
      yield { th: 'thinking' } as any;
      yield { t: 'A' } as any;
      yield { t: 'B' } as any;
      yield { t: 'C' } as any;
    };
    const events = await drain(executePlan(plan([step('a', [], { maxTokens: 3 })]), d));
    const done = kinds(events, 'step_done')[0] as any;
    expect(done.tokens).toBe(3);
    // One reasoning token consumed a third of the ceiling, so only two visible
    // tokens fit under it.
    expect(done.visible).toBe(2);
    expect(done.truncated).toBe(true);
  });

  it('fails a step whose composed prompt exceeds the node budget, before dispatching', async () => {
    const dispatch = vi.fn(async function* () { yield { t: 'x' } as any; });
    const p = plan([step('a'), step('b', ['a'])]);
    const events = await drain(executePlan(p, dispatch as any, {
      // Counted in characters here so the numbers are exact: 'do a' is 4 and
      // fits, and b's composed prompt carries a's whole output on top of its
      // own and does not.
      promptBudget: 10,
      estTokens: s => s.length,
    }));
    const failed = kinds(events, 'step_failed')[0] as any;
    expect(failed.id).toBe('b');
    expect(failed.code).toBe('deps_over_budget');
    // Called once, for a. b never reached an engine, so it cost nothing.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((kinds(events, 'plan_done')[0] as any).ok).toBe(false);
  });

  it('reports an engine failure as a failed step', async () => {
    const d: Dispatch = async function* (s) {
      if (s.id === 'a') throw new Error('engine exploded');
      yield { t: 'x' } as any;
    };
    const events = await drain(executePlan(plan([step('a'), step('b', ['a'])]), d));
    const failed = kinds(events, 'step_failed')[0] as any;
    expect(failed.id).toBe('a');
    expect(failed.code).toBe('engine_error');
    expect(failed.message).toContain('engine exploded');
  });

  it('starts no further step once one has failed', async () => {
    const started: string[] = [];
    const d: Dispatch = async function* (s) {
      started.push(s.id);
      if (s.id === 'a') throw new Error('nope');
      yield { t: 'x' } as any;
    };
    // b and c depend on a, so a failure in wave 1 must strand both.
    const p = plan([step('a'), step('b', ['a']), step('c', ['a'])]);
    const events = await drain(executePlan(p, d));
    expect(started).toEqual(['a']);
    const done = kinds(events, 'plan_done')[0] as any;
    expect(done.ok).toBe(false);
    expect(done.failed).toEqual(['a']);
    expect(done.completed).toEqual([]);
  });

  it('runs a wave concurrently when maxParallel allows it', async () => {
    let inFlight = 0, peak = 0;
    const d: Dispatch = async function* () {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      yield { t: 'x' } as any;
      inFlight--;
    };
    await drain(executePlan(plan([step('a'), step('b'), step('c')]), d, { maxParallel: 3 }));
    expect(peak).toBe(3);
  });

  it('runs one at a time by default', async () => {
    let inFlight = 0, peak = 0;
    const d: Dispatch = async function* () {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      yield { t: 'x' } as any;
      inFlight--;
    };
    await drain(executePlan(plan([step('a'), step('b'), step('c')]), d));
    expect(peak).toBe(1);
  });

  it('totals billed tokens across the whole run', async () => {
    const d: Dispatch = async function* () {
      yield { t: 'a' } as any; yield { th: 'b' } as any; yield { t: 'c' } as any;
    };
    const events = await drain(executePlan(plan([step('a'), step('b')]), d));
    expect((kinds(events, 'plan_done')[0] as any).tokens).toBe(6);
  });

  it('stops when the caller aborts', async () => {
    const ac = new AbortController();
    const d: Dispatch = async function* (s) {
      if (s.id === 'a') ac.abort();
      yield { t: 'x' } as any;
    };
    const events = await drain(executePlan(plan([step('a'), step('b')]), d, { signal: ac.signal }));
    const done = kinds(events, 'plan_done')[0] as any;
    expect(done.ok).toBe(false);
    expect(done.completed).toEqual(['a']);
  });
});

describe('collect', () => {
  it('assembles finished outputs in the plan order, skipping what did not run', () => {
    const p = plan([step('a'), step('b'), step('c')]);
    const out = collect(p, new Map([['c', 'CCC'], ['a', 'AAA']]));
    expect(out).toBe('## a\n\nAAA\n\n## c\n\nCCC');
  });
});

// The failure a live run produced and the executor called a success.
describe('a ceiling spent before any answer', () => {
  it('fails the step instead of reporting an empty success', async () => {
    // Every frame is reasoning, so the ceiling is reached with nothing visible.
    const d: Dispatch = async function* () {
      for (;;) yield { th: 'x' } as any;
    };
    const events = await drain(executePlan(plan([step('a', [], { maxTokens: 8 })]), d));
    const failed = kinds(events, 'step_failed')[0] as any;
    expect(failed.code).toBe('ceiling_before_output');
    expect(failed.message).toContain('raise this step');
    const done = kinds(events, 'plan_done')[0] as any;
    expect(done.ok).toBe(false);
  });

  it('strands the dependent steps rather than feeding them nothing', async () => {
    // The compounding version of the same defect: without this, wave 2 ran
    // against empty dependency output and produced its own empty result.
    const started: string[] = [];
    const d: Dispatch = async function* (s) {
      started.push(s.id);
      for (;;) yield { th: 'x' } as any;
    };
    const p = plan([step('a', [], { maxTokens: 4 }), step('b', ['a'], { maxTokens: 4 })]);
    await drain(executePlan(p, d));
    expect(started).toEqual(['a']);
  });

  it('still accepts a truncated step that produced an answer', async () => {
    const d: Dispatch = async function* () {
      yield { t: 'here is the answer' } as any;
      for (;;) yield { th: 'x' } as any;
    };
    const events = await drain(executePlan(plan([step('a', [], { maxTokens: 5 })]), d));
    const done = kinds(events, 'step_done')[0] as any;
    expect(done.truncated).toBe(true);
    expect(done.visible).toBe(1);
    expect((kinds(events, 'plan_done')[0] as any).ok).toBe(true);
  });
});
