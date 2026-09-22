/**
 * Engram System Integration
 *
 * Wires ephemeral engrams into the DinnerNode job flow.
 * Spec: https://plur.ai/spec.html (v2.1)
 */

import {
  initEphemeralEngrams,
  setJobBinding,
  clearJobBinding,
  getAllEngrams,
  storeEngram
} from './ephemeral-engrams';
import { sanitizePromptWithEngrams, containsPII } from './engram-sanitizer';
import { getCommunityTemplate, COMMUNITY_TEMPLATES } from './engram-library';
import type { Engram } from './ephemeral-engrams';

export function initEngramSystem(): void {
  initEphemeralEngrams();
}

export async function onJobOpen(jobId: string): Promise<void> {
  await setJobBinding(jobId);
}

export function onJobClose(): void {
  clearJobBinding();
}

export async function preparePrompt(
  prompt: string,
  strictness: 'minimal' | 'balanced' | 'maximal' = 'balanced',
  pending: PendingEngrams = {}
): Promise<{
  sanitized: string;
  original: string;
  detected: string[];
  redactionCount: number;
  hadPII: boolean;
  engramsApplied: number;
}> {
  // Must use the same strictness the redaction pass will use, or the flag
  // reports PII that minimal will not remove and under-reports at maximal.
  const hadPII = containsPII(prompt, strictness);
  // Staged engrams are folded in here rather than read back from storage,
  // because storage cannot hold them yet. See resolvePendingEngrams.
  const engrams = [...await getAllEngrams(), ...resolvePendingEngrams(pending)];
  const result = sanitizePromptWithEngrams(prompt, engrams, strictness);

  // Prepended AFTER redaction on purpose. The preamble is our own instruction
  // text; passing it through the sanitizer would let maximal strictness redact
  // the place name in a location template, or the word "JSON" out of a
  // formatting one, and then send the guest a mangled instruction.
  const preamble = behavioralPreamble(engrams);

  return {
    sanitized: preamble + result.sanitized,
    original: prompt,
    detected: result.detected,
    redactionCount: result.summary.redactionCount,
    hadPII,
    engramsApplied: engrams.length,
  };
}

export async function loadCommunityTemplate(templateId: string): Promise<Engram> {
  const template = getCommunityTemplate(templateId);
  if (!template) throw new Error('Template not found: ' + templateId);

  // Strip the template ID so storeEngram generates a spec-compliant ENG-YYYY-MMDD-NNN ID
  const copy: any = { ...template };
  delete copy.id;

  return await storeEngram({ ...copy, status: 'active', scope: 'session:template' });
}

/**
 * What the user picked before a job existed.
 *
 * Engrams are bound to a job id, and the binding is only set by onJobOpen once
 * openJob has landed on chain. But the only moment a user can sensibly choose a
 * template or paste an engram is BEFORE ordering. Selecting one used to call
 * storeEngram immediately, which threw "No active job binding" every time, so
 * the panel's main control failed on every use and the upload path silently
 * stored nothing at all despite promising otherwise. The selection is now held
 * here and applied by applyPendingEngrams once the binding exists.
 */
export interface PendingEngrams {
  templateId?: string;
  // Partial, because parseUploadedEngram validates shape without minting an id
  // or a session binding. Both are assigned by storeEngram at apply time.
  custom?: Partial<Engram>;
}

export async function applyPendingEngrams(pending: PendingEngrams): Promise<number> {
  let applied = 0;
  if (pending.templateId) {
    await loadCommunityTemplate(pending.templateId);
    applied++;
  }
  if (pending.custom) {
    const copy: any = { ...pending.custom };
    delete copy.id;
    delete copy._sessionBinding;
    await storeEngram({ ...copy, status: 'active', scope: 'session:custom' });
    applied++;
  }
  return applied;
}

export function getAvailableTemplates(): Array<{
  id: string;
  name: string;
  description: string;
  domain: string;
}> {
  return COMMUNITY_TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    domain: t.domain
  }));
}

/**
 * Staged engrams, resolved into usable objects without a job binding.
 *
 * The binding only exists after openJob lands, and getAllEngrams returns
 * nothing (and clears storage) until it does. preparePrompt runs BEFORE
 * openJob, because the prompt has to be sanitized before it can be hashed and
 * committed. The consequence was that a staged engram could never influence
 * the job it was staged for: applyPendingEngrams stored it after the prompt had
 * already been sanitized, hashed and sent, so the panel's effect always arrived
 * one job late. Resolving here, off the storage path, is what closes that gap.
 * The objects below are not stored and carry no binding; applyPendingEngrams
 * still stores the real ones once the job exists.
 */
export function resolvePendingEngrams(pending: PendingEngrams): Engram[] {
  const out: Engram[] = [];
  if (pending.templateId) {
    const t = getCommunityTemplate(pending.templateId);
    if (t) out.push(t as Engram);
  }
  if (pending.custom) out.push({ id: 'pending:custom', tags: [], ...pending.custom } as Engram);
  return out;
}

// A preamble is instruction text sent to the provider, not guest data, so it is
// bounded rather than sanitized: running it through the redactor would let the
// maximal gazetteer eat the very place name a location template exists to
// mention. Caps are the same shape as the sanitizer's own rule caps.
const MAX_PREAMBLE_ENGRAMS = 4;
const MAX_STATEMENT_CHARS = 600;

/** True for engrams the sanitizer consumes as redaction rules rather than behaviour. */
const isPrivacyEngram = (e: Engram) =>
  e.domain === 'ai/privacy' || (e.tags ?? []).includes('sanitization');

/**
 * Behaviour templates only ever did something if they were privacy engrams.
 *
 * applyEngramSanitization skips every engram that is not domain 'ai/privacy'
 * or tagged 'sanitization', and nothing else in the app read engrams at all, so
 * five of the six community templates - recipe, json-only, socratic,
 * belgrade-costs, code-review - were stored, counted in the panel summary,
 * described in the UI as "applied when your order opens", and then never
 * reached the model. This is the missing half: a behavioural engram is an
 * instruction, so it is sent as one.
 */
export function behavioralPreamble(engrams: Engram[]): string {
  const lines = engrams
    .filter(e => !isPrivacyEngram(e) && typeof e.statement === 'string' && e.statement.trim())
    .slice(0, MAX_PREAMBLE_ENGRAMS)
    .map(e => '- ' + e.statement.trim().slice(0, MAX_STATEMENT_CHARS));
  return lines.length ? 'Follow these instructions for this answer:\n' + lines.join('\n') + '\n\n' : '';
}
