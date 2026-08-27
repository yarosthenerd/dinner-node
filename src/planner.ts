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
      "id": "<slug, lowercase letters digits dash underscore, 32 characters max>",
      "title": "<short human label>",
      "prompt": "<the full instruction for this step, self-contained>",
      "maxTokens": <integer>,
      "dependsOn": ["<id of a step this one needs>"]
    }
  ]
}

Rules, all enforced after you reply:
- Every id must match [a-z0-9_-] and be AT MOST ${PLAN_LIMITS.maxIdChars} CHARACTERS.
  Count them. "gpu_costs" is good; "determine-break-even-and-conclude" is too long.
- At most ${PLAN_LIMITS.maxSteps} steps. Fewer is better. Do not pad.
- maxTokens between ${PLAN_LIMITS.minTokensPerStep} and ${PLAN_LIMITS.maxTokensPerStep} per step, ${PLAN_LIMITS.maxTotalTokens} in total.
  This ceiling counts YOUR REASONING as well as your answer, and reasoning comes
  first. A step whose ceiling is smaller than the thinking it needs produces
  nothing at all. Budget roughly four times the visible output you expect, and
  never less than ${PLAN_LIMITS.minTokensPerStep}.
  Unused tokens are not charged, but the ceiling is what gets escrowed.
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

/**
 * Repair step ids in place, and rewrite every reference to them.
 *
 * A model that gets everything else right and writes a 33 character slug has
 * produced a good plan, and throwing it away costs the guest the whole
 * planning run: measured at 153 seconds on this node, billed, for nothing.
 * The id is an opaque handle rather than meaning, so normalising it changes
 * nothing a guest approved.
 *
 * Deterministic on purpose. The id is part of the canonical form and therefore
 * of planHash, so the same reply must always repair to the same plan or the
 * commitment would depend on when it was parsed.
 *
 * What this does NOT touch: prompts, titles, token ceilings, or the dependency
 * graph's shape. A dangling dependency stays dangling and the validator still
 * rejects it.
 */
export function normalizeTokens(parsed: any): string[] {
  const repairs: string[] = [];
  if (!parsed || !Array.isArray(parsed.steps)) return repairs;
  for (const s of parsed.steps) {
    const n = Number(s?.maxTokens);
    if (!Number.isFinite(n)) continue;
    const clamped = Math.min(PLAN_LIMITS.maxTokensPerStep, Math.max(PLAN_LIMITS.minTokensPerStep, Math.floor(n)));
    if (clamped !== n) {
      repairs.push(`${s.id ?? '(step)'} maxTokens ${n} -> ${clamped}`);
      s.maxTokens = clamped;
    }
  }
  return repairs;
}

export function normalizeIds(parsed: any): string[] {
  const repairs: string[] = [];
  if (!parsed || !Array.isArray(parsed.steps)) return repairs;
  const max = PLAN_LIMITS.maxIdChars;
  const taken = new Set<string>();
  const map = new Map<string, string>();

  parsed.steps.forEach((s: any, i: number) => {
    const original = typeof s?.id === 'string' ? s.id : '';
    let id = original.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, max);
    if (!id) id = `step_${i + 1}`;
    if (taken.has(id)) {
      // Suffix without exceeding the cap, so deduplication cannot reintroduce
      // the very violation being repaired.
      let n = 2;
      let candidate: string;
      do {
        const suffix = `_${n++}`;
        candidate = id.slice(0, max - suffix.length) + suffix;
      } while (taken.has(candidate) && n < 1000);
      id = candidate;
    }
    taken.add(id);
    if (id !== original) {
      repairs.push(`${original || '(missing)'} -> ${id}`);
      if (original) map.set(original, id);
      s.id = id;
    }
  });

  if (map.size) {
    for (const s of parsed.steps) {
      if (!Array.isArray(s?.dependsOn)) continue;
      s.dependsOn = s.dependsOn.map((d: any) => (typeof d === 'string' && map.has(d) ? map.get(d)! : d));
    }
  }
  return repairs;
}

/** Parse and validate one candidate. Never throws. */
export function parsePlan(
  raw: string,
  opts: { budgetWei?: bigint; ratePerMillion?: bigint } = {}
): { plan?: Plan; issues: ValidationIssue[]; repairs?: string[] } {
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
  const repairs = [...normalizeIds(parsed), ...normalizeTokens(parsed)];
  const { ok, issues } = validatePlan(parsed, opts);
  return ok ? { plan: parsed as Plan, issues: [], repairs } : { issues, repairs };
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
