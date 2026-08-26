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
  strictness: 'minimal' | 'balanced' | 'maximal' = 'balanced'
): Promise<{
  sanitized: string;
  original: string;
  detected: string[];
  redactionCount: number;
  hadPII: boolean;
}> {
  // Must use the same strictness the redaction pass will use, or the flag
  // reports PII that minimal will not remove and under-reports at maximal.
  const hadPII = containsPII(prompt, strictness);
  const engrams = await getAllEngrams();
  const result = sanitizePromptWithEngrams(prompt, engrams, strictness);

  return {
    sanitized: result.sanitized,
    original: prompt,
    detected: result.detected,
    redactionCount: result.summary.redactionCount,
    hadPII
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
