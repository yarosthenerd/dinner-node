/**
 * The planner funnel: pull JSON out of model prose, repair what is safe to
 * repair, and hand the rest to the validator.
 *
 * The repairs are the part worth testing hard. They rewrite a plan the guest is
 * then shown and asked to commit a hash of, so a repair that is not
 * deterministic makes the commitment depend on when it was parsed, and a repair
 * that touches a prompt or a token ceiling changes what the guest approved.
 * Both properties are asserted below rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPlannerPrompt, extractJson, normalizeIds, normalizeTokens, parsePlan, describePlan, makePlan,
} from '../planner';
import { PLAN_LIMITS, type Plan } from '../plan';

const step = (over: Record<string, unknown> = {}) => ({
  id: 'research',
  title: 'Research the options',
  prompt: 'List the three cheapest options with prices.',
  maxTokens: 2048,
  dependsOn: [] as string[],
  ...over,
});

const plan = (over: Record<string, unknown> = {}): Plan => ({
  version: 1,
  goal: 'plan a dinner',
  steps: [step()],
  ...over,
}) as Plan;

describe('extractJson', () => {
  it('finds a bare object', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('pulls the object out of surrounding prose', () => {
    expect(extractJson('Sure! Here is the plan:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it('pulls the object out of a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('returns the first balanced object rather than spanning two', () => {
    // A greedy regex from the first brace to the last yields neither object.
    expect(extractJson('{"a":1} and then {"b":2}')).toBe('{"a":1}');
  });

  it('handles nesting', () => {
    expect(extractJson('x {"a":{"b":[1,2]},"c":3} y')).toBe('{"a":{"b":[1,2]},"c":3}');
  });

  it('does not end the object on a brace inside a string', () => {
    expect(extractJson('{"a":"}"}')).toBe('{"a":"}"}');
  });

  it('does not end the object on an escaped quote', () => {
    expect(extractJson('{"a":"say \\"}\\" now"}')).toBe('{"a":"say \\"}\\" now"}');
  });

  it('returns null when there is no object at all', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  it('returns null when the object never closes', () => {
    expect(extractJson('{"a":1')).toBeNull();
  });
});

describe('normalizeTokens', () => {
  it('clamps a step above the per-step cap down to it', () => {
    const p = { steps: [step({ maxTokens: 999999 })] };
    const repairs = normalizeTokens(p);
    expect(p.steps[0].maxTokens).toBe(PLAN_LIMITS.maxTokensPerStep);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain('research');
  });

  it('raises a step below the floor up to it', () => {
    // The floor is not a style preference: on a reasoning model the reasoning
    // is billed first, so a ceiling under the thinking budget is spent before a
    // single visible token appears.
    const p = { steps: [step({ maxTokens: 10 })] };
    normalizeTokens(p);
    expect(p.steps[0].maxTokens).toBe(PLAN_LIMITS.minTokensPerStep);
  });

  it('leaves a step already inside the band untouched and reports no repair', () => {
    const p = { steps: [step({ maxTokens: 3000 })] };
    expect(normalizeTokens(p)).toEqual([]);
    expect(p.steps[0].maxTokens).toBe(3000);
  });

  it('floors a fractional count rather than rejecting it', () => {
    const p = { steps: [step({ maxTokens: 3000.9 })] };
    normalizeTokens(p);
    expect(p.steps[0].maxTokens).toBe(3000);
  });

  it('skips a non-numeric count and leaves it for the validator', () => {
    const p = { steps: [step({ maxTokens: 'lots' })] };
    expect(normalizeTokens(p)).toEqual([]);
    expect(p.steps[0].maxTokens).toBe('lots');
  });

  it('returns no repairs when there are no steps to repair', () => {
    expect(normalizeTokens(null)).toEqual([]);
    expect(normalizeTokens({})).toEqual([]);
    expect(normalizeTokens({ steps: 'nope' })).toEqual([]);
  });
});

describe('normalizeIds', () => {
  it('lowercases and replaces characters outside the allowed set', () => {
    const p = { steps: [step({ id: 'Research Options!' })] };
    normalizeIds(p);
    expect(p.steps[0].id).toBe('research_options_');
  });

  it('truncates an over-long id to the cap', () => {
    const p = { steps: [step({ id: 'a'.repeat(80) })] };
    normalizeIds(p);
    expect(p.steps[0].id).toHaveLength(PLAN_LIMITS.maxIdChars);
  });

  it('names a step that arrived without an id', () => {
    const p = { steps: [step({ id: undefined }), step({ id: undefined })] };
    normalizeIds(p);
    expect(p.steps[0].id).toBe('step_1');
    expect(p.steps[1].id).toBe('step_2');
  });

  it('deduplicates without exceeding the cap', () => {
    // Suffixing a 32 character id must not reintroduce the violation it is
    // repairing.
    const long = 'b'.repeat(PLAN_LIMITS.maxIdChars);
    const p = { steps: [step({ id: long }), step({ id: long })] };
    normalizeIds(p);
    expect(p.steps[0].id).not.toBe(p.steps[1].id);
    expect(p.steps[1].id.length).toBeLessThanOrEqual(PLAN_LIMITS.maxIdChars);
  });

  it('rewrites every reference to an id it renamed', () => {
    const p = {
      steps: [
        step({ id: 'First Step' }),
        step({ id: 'second', dependsOn: ['First Step'] }),
      ],
    };
    normalizeIds(p);
    expect(p.steps[0].id).toBe('first_step');
    expect(p.steps[1].dependsOn).toEqual(['first_step']);
  });

  it('leaves a dangling dependency dangling for the validator to reject', () => {
    const p = { steps: [step({ id: 'a', dependsOn: ['nowhere'] })] };
    normalizeIds(p);
    expect(p.steps[0].dependsOn).toEqual(['nowhere']);
  });

  it('is deterministic, because the id is part of the committed hash', () => {
    const once = { steps: [step({ id: 'A B' }), step({ id: 'A B' }), step({ id: '' })] };
    const twice = { steps: [step({ id: 'A B' }), step({ id: 'A B' }), step({ id: '' })] };
    normalizeIds(once);
    normalizeIds(twice);
    expect(once.steps.map(s => s.id)).toEqual(twice.steps.map(s => s.id));
  });

  it('reports no repair for an id that was already clean', () => {
    const p = { steps: [step({ id: 'research' })] };
    expect(normalizeIds(p)).toEqual([]);
  });
});

describe('parsePlan', () => {
  it('accepts a valid plan wrapped in prose', () => {
    const r = parsePlan('Here you go:\n' + JSON.stringify(plan()));
    expect(r.plan).toBeDefined();
    expect(r.issues).toEqual([]);
  });

  it('reports no_json rather than throwing when the reply has no object', () => {
    const r = parsePlan('I would rather not.');
    expect(r.plan).toBeUndefined();
    expect(r.issues[0].code).toBe('no_json');
  });

  it('reports bad_json on an object that does not parse', () => {
    const r = parsePlan('{"version": 1, oops}');
    expect(r.issues[0].code).toBe('bad_json');
  });

  it('repairs what it can and still returns the repairs alongside a valid plan', () => {
    const raw = JSON.stringify(plan({ steps: [step({ id: 'Step One', maxTokens: 99999 })] }));
    const r = parsePlan(raw);
    expect(r.plan).toBeDefined();
    expect(r.repairs?.length).toBeGreaterThan(0);
    expect(r.plan!.steps[0].id).toBe('step_one');
    expect(r.plan!.steps[0].maxTokens).toBe(PLAN_LIMITS.maxTokensPerStep);
  });

  it('rejects a plan with more steps than the cap', () => {
    const steps = Array.from({ length: PLAN_LIMITS.maxSteps + 1 }, (_, i) => step({ id: `s${i}` }));
    const r = parsePlan(JSON.stringify(plan({ steps })));
    expect(r.plan).toBeUndefined();
    expect(r.issues.some(i => i.code === 'too_many_steps')).toBe(true);
  });

  it('rejects a cycle, which is what turns a bounded plan into an unbounded one', () => {
    const r = parsePlan(JSON.stringify(plan({
      steps: [step({ id: 'a', dependsOn: ['b'] }), step({ id: 'b', dependsOn: ['a'] })],
    })));
    expect(r.plan).toBeUndefined();
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('rejects a dangling dependency', () => {
    const r = parsePlan(JSON.stringify(plan({ steps: [step({ dependsOn: ['ghost'] })] })));
    expect(r.plan).toBeUndefined();
    expect(r.issues.some(i => i.code === 'dangling_dependency')).toBe(true);
  });

  it('never throws, whatever the model produced', () => {
    for (const raw of ['', '{}', '{"steps":null}', '{"steps":[{}]}', '[]', '{"version":"x"}']) {
      expect(() => parsePlan(raw)).not.toThrow();
    }
  });
});

describe('buildPlannerPrompt', () => {
  it('carries the goal and states the caps', () => {
    const p = buildPlannerPrompt('cook a dinner for six');
    expect(p).toContain('cook a dinner for six');
    expect(p).toContain(String(PLAN_LIMITS.maxSteps));
  });

  it('feeds the validator issues back verbatim on a retry', () => {
    // Retrying without the reasons just re-rolls the dice.
    const p = buildPlannerPrompt('a goal', [{ code: 'too_many_steps', message: 'cap is 12' }]);
    expect(p).toContain('too_many_steps');
    expect(p).toContain('cap is 12');
  });

  it('says nothing about a previous attempt on the first try', () => {
    expect(buildPlannerPrompt('a goal')).not.toContain('previous attempt');
  });
});

describe('makePlan', () => {
  const gen = (...replies: string[]) => {
    let n = 0;
    return async function* (_prompt: string) { yield replies[Math.min(n++, replies.length - 1)]; };
  };

  it('returns the plan on a first-attempt success', async () => {
    const r = await makePlan('a goal', gen(JSON.stringify(plan())));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it('retries once with the reasons and succeeds on the second reply', async () => {
    const r = await makePlan('a goal', gen('rubbish', JSON.stringify(plan())));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it('gives up after the attempt budget rather than spiralling', async () => {
    // The retry budget is itself a bound: every attempt is billed to the guest.
    const r = await makePlan('a goal', gen('rubbish'));
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('honours a raised attempt budget', async () => {
    const r = await makePlan('a goal', gen('rubbish'), { maxAttempts: 3 });
    expect(r.attempts).toBe(3);
  });

  it('keeps the last raw reply so a rejection can be read', async () => {
    const r = await makePlan('a goal', gen('rubbish'));
    expect(r.raw).toBe('rubbish');
  });
});

describe('describePlan', () => {
  it('states the step count, the token ceiling and the cost', () => {
    const s = describePlan(plan({ steps: [step({ maxTokens: 2048 }), step({ id: 'b', maxTokens: 2048 })] }), 2000000000000000000n);
    expect(s).toContain('2 steps');
    expect(s).toContain('4096 tokens');
    expect(s).toContain('MON');
  });
});
