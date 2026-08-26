/**
 * The planner: turn a goal into a validated Plan.
 *
 * The model proposes and the validator disposes. Nothing here trusts the
 * model's output, because a planner is exactly the component an attacker or an
 * off day will produce nonsense from, and its nonsense is denominated in the
 * guest's escrow. `validatePlan` is the gate; this file is only the funnel.
 *
 * Two consequences worth stating, because both were tempting to do otherwise:
 *
 * - The caps are in the prompt AND enforced afterwards. Telling the model the
 *   limits raises the hit rate; it does not make the limits true. A prompt is a
 *   request, not a constraint.
 *
 * - A rejected plan is retried ONCE, with the validator's own issues fed back
 *   verbatim. Retrying without the reasons just re-rolls the dice, and retrying
 *   indefinitely is the spiral this layer exists to prevent: the retry budget is
 *   itself a bound.
 */
import { PLAN_LIMITS, planCostWei, validatePlan, type Plan, type ValidationIssue } from './plan.js';

export type PlanAttempt = {
  ok: boolean;
  plan?: Plan;
  issues: ValidationIssue[];
  /** Raw model output of the last attempt, for debugging a rejection. */
  raw: string;
  attempts: number;
};

export function buildPlannerPrompt(goal: string, issues: ValidationIssue[] = []): string {
  const retry = issues.length
    ? `\nYour previous attempt was rejected for these reasons. Fix all of them:\n` +
      issues.map(i => `- ${i.code}: ${i.message}`).join('\n') + '\n'
    : '';

  // Explicitly no control flow in the schema. A step that could say "then do X
  // if Y" would move sequencing into the executor, which is the one thing the
  // orchestrator must keep.
  return `Break the following goal into a plan of independent steps.

GOAL:
${goal}

Reply with ONLY a JSON object, no prose and no code fence, in exactly this shape:

{
  "version": 1,
  "goal": "<restate the goal in one line>",
  "steps": [
    {
      "id": "<short slug, letters digits dash underscore>",
      "title": "<short human label>",
      "prompt": "<the full instruction for this step, self-contained>",
      "maxTokens": <integer>,
      "dependsOn": ["<id of a step this one needs>"]
    }
  ]
}

Rules, all enforced after you reply:
- At most ${PLAN_LIMITS.maxSteps} steps. Fewer is better. Do not pad.
- maxTokens at most ${PLAN_LIMITS.maxTokensPerStep} per step, ${PLAN_LIMITS.maxTotalTokens} in total.
  Estimate honestly: unused tokens are not charged, but the ceiling is what gets escrowed.
- dependsOn lists only steps that must finish first. Use [] when a step can start immediately.
  Independent steps run in parallel on different machines, so do not chain steps that need not be chained.
- No cycles. Dependency chains at most ${PLAN_LIMITS.maxDepth} deep.
- A step prompt must be self-contained and must not refer to "the previous step" by position.
- Steps describe work only. No step may decide what runs next, skip another step, or add steps.
${retry}`;
}

/**
 * Pull a JSON object out of model output.
 *
 * Models wrap JSON in prose, fences, or both, however firmly asked not to. This
 * scans for the first balanced brace run rather than regexing, because a
 * greedy match across a reply containing two objects yields neither.
 */
export function extractJson(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse and validate one candidate. Never throws. */
export function parsePlan(
  raw: string,
  opts: { budgetWei?: bigint; ratePerMillion?: bigint } = {}
): { plan?: Plan; issues: ValidationIssue[] } {
  const json = extractJson(raw);
  if (json === null) {
    return { issues: [{ code: 'no_json', message: 'no JSON object found in the reply' }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e: any) {
    return { issues: [{ code: 'bad_json', message: `JSON did not parse: ${e?.message ?? e}` }] };
  }
  const { ok, issues } = validatePlan(parsed, opts);
  return ok ? { plan: parsed as Plan, issues: [] } : { issues };
}

/**
 * Ask a generator for a plan, validate it, and retry once with the reasons.
 *
 * `gen` is the same AsyncGenerator shape the host's engines expose, so the
 * planner runs on whatever the node already serves and needs no second model.
 */
export async function makePlan(
  goal: string,
  gen: (prompt: string) => AsyncGenerator<string>,
  opts: { budgetWei?: bigint; ratePerMillion?: bigint; maxAttempts?: number } = {}
): Promise<PlanAttempt> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let issues: ValidationIssue[] = [];
  let raw = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    raw = '';
    for await (const tok of gen(buildPlannerPrompt(goal, issues))) raw += tok;
    const r = parsePlan(raw, opts);
    if (r.plan) return { ok: true, plan: r.plan, issues: [], raw, attempts: attempt };
    issues = r.issues;
  }
  return { ok: false, issues, raw, attempts: maxAttempts };
}

/** One-line cost summary for the review UI. */
export function describePlan(plan: Plan, ratePerMillion: bigint): string {
  const tokens = plan.steps.reduce((n, s) => n + s.maxTokens, 0);
  const wei = planCostWei(plan, ratePerMillion);
  return `${plan.steps.length} steps, up to ${tokens} tokens, ceiling ${Number(wei) / 1e18} MON`;
}
