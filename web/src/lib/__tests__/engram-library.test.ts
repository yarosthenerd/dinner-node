/**
 * Community templates and the upload path.
 *
 * The upload path is the interesting half: it takes text a guest pastes in and
 * turns it into an instruction that is prepended to their prompt and sent to a
 * node. So the assertions here are about what it refuses, and about the fact
 * that it refuses by returning an error rather than by throwing, since a throw
 * inside the order flow loses the order.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_TEMPLATES, getCommunityTemplate, getCommunityTemplateIds,
  parseUploadedEngram, createCustomEngram, generateEngramPreview,
} from '../engram-library';

/** A statement inside the 25 to 60 word band the parser enforces. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('COMMUNITY_TEMPLATES', () => {
  it('has unique ids, since the id is the lookup key', () => {
    const ids = COMMUNITY_TEMPLATES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every template the fields the selector renders', () => {
    for (const t of COMMUNITY_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.statement.trim()).not.toBe('');
      expect(Array.isArray(t.tags)).toBe(true);
      expect(t.domain).toBeTruthy();
    }
  });

  it('ships only behavioral templates, which is what the preamble builder expects', () => {
    for (const t of COMMUNITY_TEMPLATES) expect(t.type).toBe('behavioral');
  });

  it('carries no personal data in a statement, since these are shipped to every node', () => {
    for (const t of COMMUNITY_TEMPLATES) {
      expect(t.statement).not.toMatch(/@|\+\d{7,}|\b\d{4} ?\d{4} ?\d{4} ?\d{4}\b/);
    }
  });
});

describe('getCommunityTemplate', () => {
  it('returns an engram shaped object for a known id', () => {
    const e = getCommunityTemplate('template-recipe');
    expect(e).not.toBeNull();
    expect(e!.id).toBe('template-recipe');
    expect(e!.type).toBe('behavioral');
    expect(e!.scope).toBe('community:template');
    expect(e!.status).toBe('active');
    expect(e!.version).toBe(2);
  });

  it('returns null for an unknown id rather than throwing', () => {
    expect(getCommunityTemplate('template-does-not-exist')).toBeNull();
  });

  it('resolves every id the library advertises', () => {
    for (const id of getCommunityTemplateIds()) {
      expect(getCommunityTemplate(id)).not.toBeNull();
    }
  });
});

describe('getCommunityTemplateIds', () => {
  it('lists one id per template', () => {
    expect(getCommunityTemplateIds()).toHaveLength(COMMUNITY_TEMPLATES.length);
  });
});

describe('parseUploadedEngram', () => {
  it('accepts JSON with the required fields', async () => {
    const r = await parseUploadedEngram(
      JSON.stringify({ type: 'behavioral', statement: words(30) }), 'json',
    );
    expect(r.error).toBeUndefined();
    expect(r.engram!.type).toBe('behavioral');
  });

  it('defaults tags to an empty array rather than leaving them undefined', async () => {
    const r = await parseUploadedEngram(
      JSON.stringify({ type: 'behavioral', statement: words(30) }), 'json',
    );
    expect(r.engram!.tags).toEqual([]);
  });

  it('keeps tags that were supplied', async () => {
    const r = await parseUploadedEngram(
      JSON.stringify({ type: 'behavioral', statement: words(30), tags: ['a', 'b'] }), 'json',
    );
    expect(r.engram!.tags).toEqual(['a', 'b']);
  });

  it('refuses an engram with no type', async () => {
    const r = await parseUploadedEngram(JSON.stringify({ statement: words(30) }), 'json');
    expect(r.engram).toBeUndefined();
    expect(r.error).toMatch(/type/);
  });

  it('refuses an engram with no statement', async () => {
    const r = await parseUploadedEngram(JSON.stringify({ type: 'behavioral' }), 'json');
    expect(r.error).toMatch(/statement/);
  });

  it('refuses a statement below the word floor', async () => {
    const r = await parseUploadedEngram(
      JSON.stringify({ type: 'behavioral', statement: words(10) }), 'json',
    );
    expect(r.error).toMatch(/25-60 words/);
  });

  it('refuses a statement above the word ceiling', async () => {
    const r = await parseUploadedEngram(
      JSON.stringify({ type: 'behavioral', statement: words(200) }), 'json',
    );
    expect(r.error).toMatch(/25-60 words/);
  });

  it('accepts both ends of the word band', async () => {
    for (const n of [25, 60]) {
      const r = await parseUploadedEngram(
        JSON.stringify({ type: 'behavioral', statement: words(n) }), 'json',
      );
      expect(r.error).toBeUndefined();
    }
  });

  it('returns a parse error rather than throwing on malformed JSON', async () => {
    // A throw here happens inside the order flow and loses the order.
    const r = await parseUploadedEngram('{not json', 'json');
    expect(r.engram).toBeUndefined();
    expect(r.error).toMatch(/Parse error/);
  });

  it('reads the simple YAML shape the upload control produces', async () => {
    const r = await parseUploadedEngram([
      'type: behavioral',
      'domain: ai/testing',
      `statement: ${words(30)}`,
    ].join('\n'));
    expect(r.error).toBeUndefined();
    expect(r.engram!.type).toBe('behavioral');
    expect(r.engram!.domain).toBe('ai/testing');
  });

  it('strips surrounding quotes from a YAML value', async () => {
    const r = await parseUploadedEngram([
      'type: "behavioral"',
      `statement: "${words(30)}"`,
    ].join('\n'));
    expect(r.engram!.type).toBe('behavioral');
  });

  it('reads a YAML list into an array', async () => {
    const r = await parseUploadedEngram([
      'type: behavioral',
      `statement: ${words(30)}`,
      'tags:',
      '  - alpha',
      '  - beta',
    ].join('\n'));
    expect(r.engram!.tags).toEqual(['alpha', 'beta']);
  });

  it('ignores comments and blank lines', async () => {
    const r = await parseUploadedEngram([
      '# a comment',
      '',
      'type: behavioral',
      `statement: ${words(30)}`,
    ].join('\n'));
    expect(r.error).toBeUndefined();
  });

  it('refuses YAML that carries no type', async () => {
    const r = await parseUploadedEngram(`statement: ${words(30)}`);
    expect(r.error).toMatch(/type/);
  });

  it('defaults to YAML when no format is given', async () => {
    // The control passes the format explicitly, but a caller that forgets must
    // not silently parse YAML as JSON and report a confusing error.
    const r = await parseUploadedEngram(`type: behavioral\nstatement: ${words(30)}`);
    expect(r.error).toBeUndefined();
  });
});

describe('createCustomEngram', () => {
  it('defaults type, tags, domain and scope', async () => {
    const e = await createCustomEngram({ statement: 'x' });
    expect(e.type).toBe('behavioral');
    expect(e.tags).toEqual([]);
    expect(e.domain).toBe('custom');
    expect(e.scope).toBe('user:custom');
  });

  it('honours an explicit scope', async () => {
    const e = await createCustomEngram({ statement: 'x' }, 'user:kitchen');
    expect(e.scope).toBe('user:kitchen');
  });

  it('carries the optional fields through when present', async () => {
    const e = await createCustomEngram({
      statement: 'x', rationale: 'because', contraindications: ['never on Tuesdays'],
    });
    expect(e.rationale).toBe('because');
    expect(e.contraindications).toEqual(['never on Tuesdays']);
  });
});

describe('generateEngramPreview', () => {
  it('shows the type, the domain and the statement', () => {
    const s = generateEngramPreview({ type: 'behavioral', domain: 'ai/recipe', statement: 'Do the thing.' });
    expect(s).toContain('Type: behavioral');
    expect(s).toContain('Domain: ai/recipe');
    expect(s).toContain('Do the thing.');
  });

  it('calls an absent domain general rather than printing undefined', () => {
    const s = generateEngramPreview({ type: 'behavioral', statement: 'x' });
    expect(s).toContain('Domain: general');
    expect(s).not.toContain('undefined');
  });

  it('omits the optional sections when they are empty', () => {
    const s = generateEngramPreview({ type: 'behavioral', statement: 'x', tags: [], contraindications: [] });
    expect(s).not.toContain('Tags:');
    expect(s).not.toContain('Do not apply when:');
    expect(s).not.toContain('Why:');
  });

  it('lists contraindications and tags when there are some', () => {
    const s = generateEngramPreview({
      type: 'behavioral', statement: 'x', rationale: 'r',
      contraindications: ['no'], tags: ['a', 'b'],
    });
    expect(s).toContain('Why: r');
    expect(s).toContain('Do not apply when:');
    expect(s).toContain('- no');
    expect(s).toContain('Tags: a, b');
  });

  it('previews every shipped template without printing undefined', () => {
    for (const id of getCommunityTemplateIds()) {
      const s = generateEngramPreview(getCommunityTemplate(id)!);
      expect(s).not.toContain('undefined');
    }
  });
});
