/**
 * Plan as a job: schema, canonical hash, and validator.
 *
 * A plan is a DAG of steps that a guest commits to on chain as a single hash
 * before any of it runs. The point is not orchestration for its own sake. It is
 * that a long job becomes bounded and inspectable BEFORE money moves: the guest
 * sees what will be spent and on what, can hand-edit it, and the contract can
 * refuse anything the plan did not authorise.
 *
 * Three invariants carry the design. They are the reason this file is pure and
 * has no network, no chain and no model in it.
 *
 * 1. EXECUTORS NEVER SEQUENCE (HANDOFF.md:206). A step carries a prompt and a
 *    token ceiling and nothing else. It cannot branch, loop, spawn a step, or
 *    name the provider that runs it. The orchestrator holds the graph; a
 *    provider only ever sees one step. A provider that could sequence could
 *    spend the whole budget on work the guest never approved, which is the
 *    agent-spiral failure this layer exists to prevent.
 *
 * 2. THE WASTE BOUND IS ONE STEP (HANDOFF.md:214). Every cost ceiling is
 *    per-step as well as total, so aborting costs at most the step in flight.
 *    A plan whose steps are individually unbounded has a total that means
 *    nothing.
 *
 * 3. THE VALIDATOR IS DUMB (HANDOFF.md:203). Deliberately. It is arithmetic and
 *    graph checks, no model and no judgement, because it is the thing standing
 *    between a hallucinated plan and a guest's escrow. A validator that needed
 *    a model to decide would be another thing that can be talked into saying
 *    yes.
 *
 * What this file does NOT do yet: commit anything on chain. `planHash` is
 * written to match what a Solidity `commitPlan(bytes32)` would verify, and the
 * canonical form exists so the two can never disagree, but DinnerNodeV2.sol has
 * no plan primitives yet. See TODO.md, "P1: DinnerNodeV2".
 */
import { keccak256, stringToHex } from 'viem';

/** Hard caps. These are the spiral guardrails, and they belong in the contract
 *  too (HANDOFF.md:213); here they are the first line, not the only one. */
export const PLAN_LIMITS = {
  /** The K cap. A plan is a plan, not a program. */
  maxSteps: 12,
  /** Per-step token ceiling, so the waste bound is one step. */
  maxTokensPerStep: 4096,
  /** Total across every step, independent of the per-step ceilings. */
  maxTotalTokens: 32768,
  /** A step prompt still has to fit a context window with room to answer. */
  maxPromptChars: 8000,
  maxGoalChars: 2000,
  /** Depth of the dependency chain. A deep chain is a loop wearing a hat. */
  maxDepth: 6,
  /** A revision that grows the budget by more than this needs the guest to
   *  approve it explicitly; under it, the UI may lazily auto-approve
   *  (HANDOFF.md:205). Expressed in basis points of the committed budget. */
  lazyApprovalBps: 1000, // 10%
} as const;

export type PlanStep = {
  /** Stable across revisions, so revisePlan can be diffed rather than replaced. */
  id: string;
  /** Human-readable, shown in the review UI. Not sent to a provider. */
  title: string;
  /** The actual prompt for this step. Already sanitized by the caller. */
  prompt: string;
  /** Ceiling for this step alone. Billing is by tokens actually produced. */
  maxTokens: number;
  /** Step ids whose output this step needs. A DAG, never a sequence the
   *  executor discovers. Empty means it can start immediately. */
  dependsOn: string[];
};

export type Plan = {
  /** Bumped by revisePlan. Part of the hash, so a revision is a new commitment. */
  version: number;
  /** What the guest actually asked for, kept so the plan can be audited
   *  against its own intent. */
  goal: string;
  steps: PlanStep[];
};

export type ValidationIssue = { code: string; message: string; stepId?: string };

/**
 * Canonical serialization. The hash is a commitment, so two parties must
 * produce identical bytes from the same plan or the commitment is worthless.
 * Key order is fixed here rather than left to JSON.stringify's insertion order,
 * which differs between a plan built by the planner and the same plan parsed
 * back from storage.
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

/** What `commitPlan(bytes32)` would store. Never hash a non-canonical form. */
export function planHash(plan: Plan): `0x${string}` {
  return keccak256(stringToHex(canonicalize(plan)));
}

/** Cost ceiling of a plan in wei, at a given provider rate. This is the number
 *  the contract would escrow, and it is an upper bound: unspent tokens are
 *  never charged. */
export function planCostWei(plan: Plan, ratePerMillion: bigint): bigint {
  const total = plan.steps.reduce((n, s) => n + BigInt(s.maxTokens), 0n);
  return (total * ratePerMillion) / 1_000_000n;
}

/**
 * The dumb validator. Pure, total, and it never throws: a malformed plan is a
 * list of issues, because the caller is usually showing them to a guest.
 *
 * Order matters slightly. Shape is checked before graph, so a plan with a
 * missing `steps` array reports that rather than a cascade of dependency
 * errors, and budget last so the guest sees structural problems first.
 */
export function validatePlan(
  plan: unknown,
  opts: { budgetWei?: bigint; ratePerMillion?: bigint } = {}
): { ok: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const bad = (code: string, message: string, stepId?: string) =>
    issues.push({ code, message, stepId });

  if (typeof plan !== 'object' || plan === null) {
    return { ok: false, issues: [{ code: 'not_object', message: 'plan is not an object' }] };
  }
  const p = plan as Partial<Plan>;

  if (!Number.isInteger(p.version) || (p.version as number) < 1) {
    bad('bad_version', 'version must be an integer of at least 1');
  }
  if (typeof p.goal !== 'string' || p.goal.trim() === '') {
    bad('bad_goal', 'goal must be a non-empty string');
  } else if (p.goal.length > PLAN_LIMITS.maxGoalChars) {
    bad('goal_too_long', `goal exceeds ${PLAN_LIMITS.maxGoalChars} characters`);
  }
  if (!Array.isArray(p.steps)) {
    return { ok: false, issues: [...issues, { code: 'bad_steps', message: 'steps must be an array' }] };
  }
  if (p.steps.length === 0) bad('no_steps', 'plan has no steps');
  if (p.steps.length > PLAN_LIMITS.maxSteps) {
    bad('too_many_steps', `plan has ${p.steps.length} steps, cap is ${PLAN_LIMITS.maxSteps}`);
  }

  // ---- per-step shape ----------------------------------------------------
  const ids = new Set<string>();
  let totalTokens = 0;
  for (const [i, s] of p.steps.entries()) {
    const where = `step ${i}`;
    if (typeof s !== 'object' || s === null) { bad('bad_step', `${where} is not an object`); continue; }
    if (typeof s.id !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(s.id)) {
      bad('bad_step_id', `${where} id must match [a-z0-9_-]{1,32}`, s.id);
    } else if (ids.has(s.id)) {
      bad('duplicate_step_id', `duplicate step id ${s.id}`, s.id);
    } else {
      ids.add(s.id);
    }
    if (typeof s.title !== 'string' || s.title.trim() === '') {
      bad('bad_title', `${where} needs a title`, s.id);
    }
    if (typeof s.prompt !== 'string' || s.prompt.trim() === '') {
      bad('bad_prompt', `${where} needs a prompt`, s.id);
    } else if (s.prompt.length > PLAN_LIMITS.maxPromptChars) {
      bad('prompt_too_long', `${where} prompt exceeds ${PLAN_LIMITS.maxPromptChars} characters`, s.id);
    }
    if (!Number.isInteger(s.maxTokens) || s.maxTokens <= 0) {
      bad('bad_max_tokens', `${where} maxTokens must be a positive integer`, s.id);
    } else if (s.maxTokens > PLAN_LIMITS.maxTokensPerStep) {
      // The waste bound. Without this the total is decorative.
      bad('step_over_cap', `${where} maxTokens ${s.maxTokens} exceeds per-step cap ${PLAN_LIMITS.maxTokensPerStep}`, s.id);
    } else {
      totalTokens += s.maxTokens;
    }
    if (!Array.isArray(s.dependsOn)) {
      bad('bad_depends', `${where} dependsOn must be an array`, s.id);
    }
  }

  if (totalTokens > PLAN_LIMITS.maxTotalTokens) {
    bad('total_over_cap', `plan totals ${totalTokens} tokens, cap is ${PLAN_LIMITS.maxTotalTokens}`);
  }

  // ---- graph -------------------------------------------------------------
  // Only run once ids are known good, or every dependency looks dangling.
  const steps = p.steps.filter(
    (s): s is PlanStep => !!s && typeof s.id === 'string' && Array.isArray(s.dependsOn)
  );
  const byId = new Map(steps.map(s => [s.id, s]));

  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (typeof d !== 'string' || !byId.has(d)) {
        bad('dangling_dependency', `step ${s.id} depends on unknown step ${String(d)}`, s.id);
      } else if (d === s.id) {
        bad('self_dependency', `step ${s.id} depends on itself`, s.id);
      }
    }
  }

  // Cycles, by depth-first search with an on-stack marker. A cycle is the shape
  // that turns a bounded plan into an unbounded one, so it is fatal rather than
  // a warning.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(steps.map(s => [s.id, WHITE]));
  const visit = (id: string): boolean => {
    const c = colour.get(id);
    if (c === GREY) return true;      // back edge: cycle
    if (c === BLACK) return false;    // already proven acyclic
    colour.set(id, GREY);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(d) && visit(d)) return true;
    }
    colour.set(id, BLACK);
    return false;
  };
  let cyclic = false;
  for (const s of steps) {
    if (colour.get(s.id) === WHITE && visit(s.id)) {
      bad('cycle', `dependency cycle reachable from step ${s.id}`, s.id);
      cyclic = true;
      break; // one report is enough; the guest fixes the graph, not each edge
    }
  }

  // Depth is the longest dependency chain, which needs its own pass: the cycle
  // search above memoises visited nodes, so a shared prefix returns immediately
  // and any depth counter threaded through it undercounts. Only safe once the
  // graph is known acyclic, or this recurses forever.
  if (!cyclic) {
    const depthOf = new Map<string, number>();
    const chain = (id: string): number => {
      const seen = depthOf.get(id);
      if (seen !== undefined) return seen;
      const deps = (byId.get(id)?.dependsOn ?? []).filter(d => byId.has(d) && d !== id);
      const d = deps.length === 0 ? 1 : 1 + Math.max(...deps.map(chain));
      depthOf.set(id, d);
      return d;
    };
    const deepest = steps.reduce((m, s) => Math.max(m, chain(s.id)), 0);
    if (deepest > PLAN_LIMITS.maxDepth) {
      bad('too_deep', `dependency chain is ${deepest} deep, cap is ${PLAN_LIMITS.maxDepth}`);
    }
  }

  // ---- budget ------------------------------------------------------------
  if (opts.budgetWei !== undefined && opts.ratePerMillion !== undefined) {
    const cost = planCostWei({ version: 1, goal: '', steps }, opts.ratePerMillion);
    if (cost > opts.budgetWei) {
      bad('over_budget', `plan ceiling is ${cost} wei, budget is ${opts.budgetWei} wei`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Steps with no unmet dependencies, given what has already completed.
 *
 * This is the whole of the orchestrator's sequencing authority, and it lives
 * here rather than anywhere a provider can reach. Returning every ready step at
 * once, rather than one, is deliberate: independent steps may run in parallel
 * on different providers, which is the case that makes a marketplace worth
 * having.
 */
export function readySteps(plan: Plan, completed: ReadonlySet<string>): PlanStep[] {
  return plan.steps.filter(
    s => !completed.has(s.id) && s.dependsOn.every(d => completed.has(d))
  );
}

/**
 * Whether a revision may be auto-approved without re-asking the guest.
 *
 * Only a cost increase within the lazy threshold qualifies, and only when the
 * shape of the work is unchanged. A revision that adds or removes a step is a
 * different plan and always needs a human, however cheap it is: cost is not the
 * only thing a guest is approving.
 */
export function canLazyApprove(before: Plan, after: Plan, ratePerMillion: bigint): boolean {
  if (after.version <= before.version) return false;
  const beforeIds = before.steps.map(s => s.id).sort().join(',');
  const afterIds = after.steps.map(s => s.id).sort().join(',');
  if (beforeIds !== afterIds) return false;

  const b = planCostWei(before, ratePerMillion);
  const a = planCostWei(after, ratePerMillion);
  if (a <= b) return true;
  if (b === 0n) return false;
  return ((a - b) * 10_000n) / b <= BigInt(PLAN_LIMITS.lazyApprovalBps);
}
