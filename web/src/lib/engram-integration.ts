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
  const hadPII = containsPII(prompt);
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
