import { describe, it, expect } from 'vitest';
import { resolvePendingEngrams, behavioralPreamble, preparePrompt } from '../engram-integration';
import { COMMUNITY_TEMPLATES } from '../engram-library';
import type { Engram } from '../ephemeral-engrams';

const eng = (p: Partial<Engram>): Engram => ({ id: 'x', tags: [], statement: '', ...p } as Engram);

describe('resolvePendingEngrams', () => {
  it('resolves a community template without a job binding', () => {
    // The regression: selection happens before openJob, so nothing that needs
    // a binding can run here. This path must not touch storage at all.
    const out = resolvePendingEngrams({ templateId: 'template-json-only' });
    expect(out).toHaveLength(1);
    expect(out[0].statement).toContain('JSON');
  });

  it('ignores an unknown template id rather than throwing', () => {
    expect(resolvePendingEngrams({ templateId: 'nope' })).toEqual([]);
  });

  it('resolves a staged custom engram and both together', () => {
    const out = resolvePendingEngrams({
      templateId: 'template-socratic',
      custom: { type: 'behavioral', statement: 'Answer in exactly two sentences.' },
    });
    expect(out).toHaveLength(2);
    expect(out[1].statement).toBe('Answer in exactly two sentences.');
  });

  it('returns nothing for an empty selection', () => {
    expect(resolvePendingEngrams({})).toEqual([]);
  });
});

describe('behavioralPreamble', () => {
  it('emits behavioural statements as instructions', () => {
    const p = behavioralPreamble([eng({ id: 'a', statement: 'Answer in JSON.' })]);
    expect(p).toContain('Answer in JSON.');
    expect(p.endsWith('\n\n')).toBe(true);
  });

  it('excludes privacy engrams, which the sanitizer consumes as rules', () => {
    expect(behavioralPreamble([eng({ id: 'p', domain: 'ai/privacy', statement: 'Replace names with [PERSON]' })])).toBe('');
    expect(behavioralPreamble([eng({ id: 'p', tags: ['sanitization'], statement: 'Replace names' })])).toBe('');
  });

  it('is empty for no engrams and for blank statements', () => {
    expect(behavioralPreamble([])).toBe('');
    expect(behavioralPreamble([eng({ statement: '   ' })])).toBe('');
  });

  it('bounds both the number of engrams and each statement', () => {
    const many = Array.from({ length: 10 }, (_, i) => eng({ id: 'e' + i, statement: 'x'.repeat(2000) }));
    const p = behavioralPreamble(many);
    expect(p.split('\n').filter(l => l.startsWith('- '))).toHaveLength(4);
    expect(p.length).toBeLessThan(4 * 700);
  });

  it('every shipped community template is either behavioural or a sanitization rule', () => {
    // The defect this file exists for: five of six templates were neither read
    // as rules nor sent as instructions, so the dropdown did nothing at all.
    for (const t of COMMUNITY_TEMPLATES) {
      const isPrivacy = t.domain === 'ai/privacy' || t.tags.includes('sanitization');
      const reaches = isPrivacy || behavioralPreamble([eng(t as Partial<Engram>)]).includes(t.statement.slice(0, 30));
      expect(reaches, `${t.id} reaches neither the sanitizer nor the model`).toBe(true);
    }
  });
});

describe('preparePrompt with staged engrams', () => {
  it('sends a staged behavioural template with the very job it was staged for', async () => {
    const r = await preparePrompt('what should I cook', 'balanced', { templateId: 'template-json-only' });
    expect(r.sanitized).toContain('JSON');
    expect(r.sanitized).toContain('what should I cook');
    expect(r.engramsApplied).toBe(1);
  });

  it('puts the preamble ahead of the prompt, not inside it', async () => {
    const r = await preparePrompt('hello', 'balanced', { templateId: 'template-socratic' });
    expect(r.sanitized.indexOf('Follow these instructions')).toBe(0);
    expect(r.sanitized.endsWith('hello')).toBe(true);
  });

  it('does not redact the preamble itself', async () => {
    // At maximal the gazetteer would eat "Belgrade" out of a location template
    // if the preamble were prepended before sanitization instead of after.
    const r = await preparePrompt('what does it cost', 'maximal', { templateId: 'template-belgrade-costs' });
    const belgrade = COMMUNITY_TEMPLATES.find(t => t.id === 'template-belgrade-costs')!;
    expect(belgrade.statement.includes('Belgrade')).toBe(true);
    expect(r.sanitized).toContain('Belgrade');
  });

  it('still redacts the guest prompt around the preamble', async () => {
    const r = await preparePrompt('email me at a@b.com', 'balanced', { templateId: 'template-json-only' });
    expect(r.sanitized).not.toContain('a@b.com');
    expect(r.redactionCount).toBeGreaterThan(0);
  });

  it('behaves as before when nothing is staged', async () => {
    const r = await preparePrompt('plain question', 'balanced');
    expect(r.sanitized).toBe('plain question');
    expect(r.engramsApplied).toBe(0);
  });
});
