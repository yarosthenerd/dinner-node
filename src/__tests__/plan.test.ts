/**
 * The validator is what stands between a hallucinated plan and a guest's
 * escrow, so these tests are about the ways a plan can be wrong, not the ways
 * it can be right. Each case names the invariant it protects.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_LIMITS,
  canLazyApprove,
  canonicalize,
  planCostWei,
  planHash,
  readySteps,
  validatePlan,
  type Plan,
  type PlanStep,
} from '../plan.js';
import { normalizeIds, normalizeTokens } from '../planner.js';
// The browser copy. A separate build with its own tsconfig, imported here
// precisely because nothing else makes the two agree.
import * as browser from '../../web/src/lib/plan-client';

const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({
  id, title: `step ${id}`, prompt: `do ${id}`, maxTokens: 500, dependsOn: [], ...over,
});

const plan = (steps: PlanStep[], over: Partial<Plan> = {}): Plan =>
  ({ version: 1, goal: 'write a report', steps, ...over });

const RATE = 26_700_000_000_000_000_000n; // 2.67e19, the live provider rate

describe('shape', () => {
  it('accepts a minimal well-formed plan', () => {
    expect(validatePlan(plan([step('a')])).ok).toBe(true);
  });

  it('rejects a non-object without throwing', () => {
    for (const junk of [null, undefined, 42, 'plan', []]) {
      expect(() => validatePlan(junk)).not.toThrow();
    }
    expect(validatePlan(null).ok).toBe(false);
  });

  it('reports a missing steps array rather than cascading', () => {
    const r = validatePlan({ version: 1, goal: 'g' });
    expect(r.ok).toBe(false);
    expect(r.issues.map(i => i.code)).toContain('bad_steps');
  });

  it('rejects duplicate step ids, which would make dependsOn ambiguous', () => {
    const r = validatePlan(plan([step('a'), step('a')]));
    expect(r.issues.map(i => i.code)).toContain('duplicate_step_id');
  });
});

describe('spiral guardrails (HANDOFF.md:213)', () => {
  it('enforces the K cap', () => {
    const many = Array.from({ length: PLAN_LIMITS.maxSteps + 1 }, (_, i) => step(`s${i}`));
    expect(validatePlan(plan(many)).issues.map(i => i.code)).toContain('too_many_steps');
  });

  it('enforces the per-step ceiling, so the waste bound is one step', () => {
    const r = validatePlan(plan([step('a', { maxTokens: PLAN_LIMITS.maxTokensPerStep + 1 })]));
    expect(r.issues.map(i => i.code)).toContain('step_over_cap');
  });

  it('enforces the total independently of the per-step cap', () => {
    // Every step is individually legal; the sum is not. Checking only per-step
    // would let a plan of legal steps exceed any total.
    const n = Math.ceil(PLAN_LIMITS.maxTotalTokens / PLAN_LIMITS.maxTokensPerStep) + 1;
    const steps = Array.from({ length: n }, (_, i) =>
      step(`s${i}`, { maxTokens: PLAN_LIMITS.maxTokensPerStep }));
    const r = validatePlan(plan(steps));
    expect(r.issues.map(i => i.code)).toContain('total_over_cap');
    expect(r.issues.map(i => i.code)).not.toContain('step_over_cap');
  });

  it('refuses a plan that exceeds the escrow it would be committed against', () => {
    const p = plan([step('a', { maxTokens: 4000 })]);
    const cost = planCostWei(p, RATE);
    expect(validatePlan(p, { budgetWei: cost - 1n, ratePerMillion: RATE }).ok).toBe(false);
    expect(validatePlan(p, { budgetWei: cost, ratePerMillion: RATE }).ok).toBe(true);
  });
});

describe('graph', () => {
  it('rejects a dangling dependency', () => {
    const r = validatePlan(plan([step('a', { dependsOn: ['ghost'] })]));
    expect(r.issues.map(i => i.code)).toContain('dangling_dependency');
  });

  it('rejects a self dependency', () => {
    const r = validatePlan(plan([step('a', { dependsOn: ['a'] })]));
    expect(r.ok).toBe(false);
  });

  it('rejects a cycle, which is what makes a bounded plan unbounded', () => {
    const r = validatePlan(plan([
      step('a', { dependsOn: ['c'] }),
      step('b', { dependsOn: ['a'] }),
      step('c', { dependsOn: ['b'] }),
    ]));
    expect(r.issues.map(i => i.code)).toContain('cycle');
  });

  it('terminates on a cycle rather than recursing forever', () => {
    // The failure mode that matters: a cycle detector that loops hangs the tab
    // the guest is reviewing the plan in.
    const t0 = Date.now();
    validatePlan(plan([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })]));
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('accepts a diamond, which is a DAG and not a cycle', () => {
    const r = validatePlan(plan([
      step('a'),
      step('b', { dependsOn: ['a'] }),
      step('c', { dependsOn: ['a'] }),
      step('d', { dependsOn: ['b', 'c'] }),
    ]));
    expect(r.ok).toBe(true);
  });

  it('rejects a chain deeper than the cap', () => {
    const steps = Array.from({ length: PLAN_LIMITS.maxDepth + 2 }, (_, i) =>
      step(`s${i}`, { dependsOn: i === 0 ? [] : [`s${i - 1}`] }));
    expect(validatePlan(plan(steps)).issues.map(i => i.code)).toContain('too_deep');
  });
});

describe('orchestrator sequencing (HANDOFF.md:206)', () => {
  it('offers only steps whose dependencies are met', () => {
    const p = plan([
      step('a'),
      step('b', { dependsOn: ['a'] }),
      step('c', { dependsOn: ['a'] }),
      step('d', { dependsOn: ['b', 'c'] }),
    ]);
    expect(readySteps(p, new Set()).map(s => s.id)).toEqual(['a']);
    // Both b and c, not one: independent steps are the case that makes a
    // marketplace of providers worth anything.
    expect(readySteps(p, new Set(['a'])).map(s => s.id)).toEqual(['b', 'c']);
    expect(readySteps(p, new Set(['a', 'b'])).map(s => s.id)).toEqual(['c']);
    expect(readySteps(p, new Set(['a', 'b', 'c'])).map(s => s.id)).toEqual(['d']);
    expect(readySteps(p, new Set(['a', 'b', 'c', 'd']))).toEqual([]);
  });
});

describe('commitment hash', () => {
  it('is stable across key order and dependency order', () => {
    // Two parties must derive identical bytes or the commitment is worthless.
    const a = plan([step('x', { dependsOn: ['p', 'q'] }), step('p'), step('q')]);
    const b: Plan = {
      steps: [
        { dependsOn: ['q', 'p'], maxTokens: 500, prompt: 'do x', title: 'step x', id: 'x' },
        { id: 'p', title: 'step p', prompt: 'do p', maxTokens: 500, dependsOn: [] },
        { id: 'q', title: 'step q', prompt: 'do q', maxTokens: 500, dependsOn: [] },
      ],
      goal: 'write a report',
      version: 1,
    };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(planHash(a)).toBe(planHash(b));
  });

  it('changes when anything material changes', () => {
    const base = plan([step('a')]);
    expect(planHash(base)).not.toBe(planHash(plan([step('a', { maxTokens: 501 })])));
    expect(planHash(base)).not.toBe(planHash(plan([step('a', { prompt: 'other' })])));
    expect(planHash(base)).not.toBe(planHash(plan([step('a')], { version: 2 })));
  });
});

describe('lazy approval (HANDOFF.md:205)', () => {
  const before = plan([step('a', { maxTokens: 1000 })]);

  it('auto-approves a small increase', () => {
    const after = plan([step('a', { maxTokens: 1090 })], { version: 2 });
    expect(canLazyApprove(before, after, RATE)).toBe(true);
  });

  it('refuses an increase past the threshold', () => {
    const after = plan([step('a', { maxTokens: 1200 })], { version: 2 });
    expect(canLazyApprove(before, after, RATE)).toBe(false);
  });

  it('refuses any change in the set of steps, however cheap', () => {
    // Cost is not the only thing the guest approved. Adding a step that reads a
    // file is not made acceptable by being small.
    const after = plan([step('a', { maxTokens: 500 }), step('b', { maxTokens: 10 })], { version: 2 });
    expect(canLazyApprove(before, after, RATE)).toBe(false);
  });

  it('refuses a revision that does not bump the version', () => {
    expect(canLazyApprove(before, plan([step('a', { maxTokens: 1000 })]), RATE)).toBe(false);
  });
});

// Id repair. The case that produced this: a live 153 second planning run on
// qwen3.6:35b-a3b returned a good six step plan whose fifth id was
// "determine-break-even-and-conclude", 33 characters against a 32 cap, twice
// in a row. The guest was billed for both attempts and got nothing.
describe('normalizeIds', () => {
  const parse = (o: any) => { const p = JSON.parse(JSON.stringify(o)); return { repairs: normalizeIds(p), p }; };

  it('truncates an id that is one character too long', () => {
    const { repairs, p } = parse({ steps: [{ id: 'determine-break-even-and-conclude' }] });
    expect(p.steps[0].id).toBe('determine-break-even-and-conclud');
    expect(p.steps[0].id.length).toBeLessThanOrEqual(PLAN_LIMITS.maxIdChars);
    expect(repairs).toHaveLength(1);
  });

  it('rewrites every dependency that pointed at a repaired id', () => {
    const { p } = parse({ steps: [
      { id: 'determine-break-even-and-conclude', dependsOn: [] },
      { id: 'draft', dependsOn: ['determine-break-even-and-conclude'] },
    ] });
    expect(p.steps[1].dependsOn).toEqual([p.steps[0].id]);
  });

  it('replaces characters the id rule does not allow', () => {
    const { p } = parse({ steps: [{ id: 'Research GPU costs!' }] });
    expect(p.steps[0].id).toBe('research_gpu_costs_');
  });

  it('names a step that arrived without an id', () => {
    const { p } = parse({ steps: [{ title: 'x' }, {}] });
    expect(p.steps[0].id).toBe('step_1');
    expect(p.steps[1].id).toBe('step_2');
  });

  it('deduplicates without reintroducing an over-long id', () => {
    const long = 'a'.repeat(40);
    const { p } = parse({ steps: [{ id: long }, { id: long }, { id: long }] });
    const ids = p.steps.map((s: any) => s.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(PLAN_LIMITS.maxIdChars);
  });

  it('is deterministic, because the id is part of planHash', () => {
    const input = { steps: [{ id: 'A B' }, { id: 'A_B' }] };
    expect(parse(input).p.steps.map((s: any) => s.id)).toEqual(parse(input).p.steps.map((s: any) => s.id));
  });

  it('leaves a valid plan untouched and reports no repairs', () => {
    const { repairs, p } = parse({ steps: [{ id: 'gpu_costs', dependsOn: [] }] });
    expect(repairs).toEqual([]);
    expect(p.steps[0].id).toBe('gpu_costs');
  });

  it('does not rescue a genuinely dangling dependency', () => {
    // Repair rewrites references to ids it changed. It must not invent a step.
    const { p } = parse({ steps: [{ id: 'a', dependsOn: ['nope'] }] });
    expect(p.steps[0].dependsOn).toEqual(['nope']);
  });
});

describe('normalizeTokens', () => {
  const parse = (o: any) => { const p = JSON.parse(JSON.stringify(o)); return { repairs: normalizeTokens(p), p }; };

  it('raises a ceiling too small for a reasoning model to answer under', () => {
    const { repairs, p } = parse({ steps: [{ id: 'a', maxTokens: 1024 }] });
    expect(p.steps[0].maxTokens).toBe(PLAN_LIMITS.minTokensPerStep);
    expect(repairs[0]).toContain('1024');
  });

  it('caps a ceiling above the per-step maximum', () => {
    const { p } = parse({ steps: [{ id: 'a', maxTokens: 999999 }] });
    expect(p.steps[0].maxTokens).toBe(PLAN_LIMITS.maxTokensPerStep);
  });

  it('leaves a sensible ceiling alone', () => {
    const { repairs, p } = parse({ steps: [{ id: 'a', maxTokens: 3000 }] });
    expect(p.steps[0].maxTokens).toBe(3000);
    expect(repairs).toEqual([]);
  });

  it('ignores a non-numeric ceiling, which the validator rejects on its own', () => {
    const { p } = parse({ steps: [{ id: 'a', maxTokens: 'lots' }] });
    expect(p.steps[0].maxTokens).toBe('lots');
  });

  it('clamps upward, so the guest approves the ceiling that will actually apply', () => {
    // The cost shown in the review is computed from the repaired plan, not the
    // one the model wrote, or the escrow would not cover the run.
    const { p } = parse({ steps: [{ id: 'a', maxTokens: 10 }, { id: 'b', maxTokens: 20 }] });
    expect(planCostWei(p as any, 1_000_000n)).toBe(BigInt(PLAN_LIMITS.minTokensPerStep * 2));
  });
});

describe('the browser commits the same hash the node quotes', () => {
  // web/src/lib/plan-client.ts carries its own canonicalize, so the guest can
  // hash the plan they were SHOWN rather than trust the node's figure. Two
  // implementations of one commitment are worth nothing if they disagree, and
  // the disagreement would be invisible: commitPlan would succeed and store a
  // hash matching no plan anyone has.
  const plan = {
    version: 1,
    goal: 'Compare a home GPU against a rented one, and say which is cheaper.',
    steps: [
      { id: 'gather', title: 'Gather costs', prompt: 'List the cost inputs.', maxTokens: 2048, dependsOn: [] },
      // Deliberately out of order: canonicalize sorts dependencies, because
      // two plans differing only in that order are the same plan. If one side
      // sorted and the other did not, only a step with several dependencies
      // would show it.
      { id: 'compare', title: 'Compare', prompt: 'Compare them.', maxTokens: 4096, dependsOn: ['power', 'gather'] },
      { id: 'power', title: 'Power draw', prompt: 'Estimate watts.', maxTokens: 2048, dependsOn: ['gather'] },
    ],
  };

  it('canonicalizes byte for byte', () => {
    expect(browser.canonicalize(plan)).toBe(canonicalize(plan));
  });

  it('hashes to the same commitment', () => {
    expect(browser.planHash(plan)).toBe(planHash(plan));
  });

  it('prices the same ceiling', () => {
    const rate = 26_700_000_000_000_000_000n;
    expect((browser.planMaxTokens(plan) * rate) / 1_000_000n).toBe(planCostWei(plan, rate));
  });
});
