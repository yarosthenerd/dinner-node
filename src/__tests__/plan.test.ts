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
