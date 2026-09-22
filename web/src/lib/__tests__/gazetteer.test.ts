/**
 * The place and demonym lists behind the maximal sanitizer.
 *
 * The bug this file exists to prevent a repeat of: both patterns were built
 * with /g and no /i, so "serbia belgrade" matched nothing while "Serbia
 * Belgrade" matched both. Every other maximal rule is also capitalisation
 * gated, so a prompt typed in lower case, which is how a great many people
 * type, made the strictest setting produce byte-identical output to the
 * loosest. The strictest setting silently did nothing.
 *
 * These patterns carry /g, so lastIndex is stateful across calls. Every
 * assertion below resets it, which is also a reminder that a caller reaching
 * for `.test()` twice will get a wrong answer the second time.
 */
import { describe, expect, it } from 'vitest';
import { PLACE_PATTERN, DEMONYM_PATTERN, CAPITALISED_STOPWORDS } from '../gazetteer';

/** `.test()` on a /g regex advances lastIndex, so reset before asking. */
const hits = (re: RegExp, s: string): string[] => { re.lastIndex = 0; return s.match(re) ?? []; };
const matches = (re: RegExp, s: string) => hits(re, s).length > 0;

describe('PLACE_PATTERN', () => {
  it('matches a capitalised place', () => {
    expect(matches(PLACE_PATTERN, 'dinner in Belgrade tonight')).toBe(true);
  });

  it('matches the same place in lower case', () => {
    // The whole point of the fix. A closed list is the one place dropping case
    // is safe, because the alternation only ever matches names on the list.
    expect(matches(PLACE_PATTERN, 'dinner in belgrade tonight')).toBe(true);
  });

  it('matches in upper case too', () => {
    expect(matches(PLACE_PATTERN, 'DINNER IN BELGRADE')).toBe(true);
  });

  it('matches a country as well as a city', () => {
    expect(matches(PLACE_PATTERN, 'a trip to serbia')).toBe(true);
    expect(matches(PLACE_PATTERN, 'a trip to Japan')).toBe(true);
  });

  it('finds every place in a prompt rather than only the first', () => {
    // The /g flag is what makes the sanitizer's replace pass redact all of them.
    expect(hits(PLACE_PATTERN, 'from Belgrade to Paris')).toHaveLength(2);
  });

  it('respects word boundaries rather than matching inside a longer word', () => {
    expect(matches(PLACE_PATTERN, 'Chinatown')).toBe(false);
    expect(matches(PLACE_PATTERN, 'Indiana')).toBe(false);
  });

  it('does not match ordinary words that are on no list', () => {
    expect(matches(PLACE_PATTERN, 'a quick dinner for four')).toBe(false);
  });

  it('prefers the longest entry, so a multi-word place is not split', () => {
    const m = hits(PLACE_PATTERN, 'a weekend in New York');
    expect(m).toContain('New York');
    expect(m).not.toContain('York');
  });

  it('is a global, case-insensitive pattern', () => {
    expect(PLACE_PATTERN.flags).toContain('g');
    expect(PLACE_PATTERN.flags).toContain('i');
  });
});

describe('DEMONYM_PATTERN', () => {
  it('matches a demonym, which carries no place name at all', () => {
    // "a classic Serbian dinner" passes every positional rule and still tells
    // the provider which country the guest is in. That is how a recipe answer
    // came back opening "Since you're in Belgrade".
    expect(matches(DEMONYM_PATTERN, 'a classic Serbian dinner')).toBe(true);
  });

  it('matches a demonym in lower case', () => {
    expect(matches(DEMONYM_PATTERN, 'a classic serbian dinner')).toBe(true);
  });

  it('respects word boundaries', () => {
    expect(matches(DEMONYM_PATTERN, 'Frenchman')).toBe(false);
  });

  it('does not match an unrelated adjective', () => {
    expect(matches(DEMONYM_PATTERN, 'a classic hearty dinner')).toBe(false);
  });

  it('is a global, case-insensitive pattern', () => {
    expect(DEMONYM_PATTERN.flags).toContain('g');
    expect(DEMONYM_PATTERN.flags).toContain('i');
  });
});

describe('CAPITALISED_STOPWORDS', () => {
  it('holds the pronouns and articles the catch-all must not redact', () => {
    for (const w of ['I', 'The', 'This', 'What', 'Please']) {
      expect(CAPITALISED_STOPWORDS.has(w)).toBe(true);
    }
  });

  it('holds weekdays and months, which are capitalised and reveal nothing', () => {
    for (const w of ['Monday', 'Sunday', 'January', 'December']) {
      expect(CAPITALISED_STOPWORDS.has(w)).toBe(true);
    }
  });

  it('holds the common prompt verbs, so an instruction is not redacted', () => {
    for (const w of ['Write', 'Explain', 'Summarise', 'Summarize', 'Recommend']) {
      expect(CAPITALISED_STOPWORDS.has(w)).toBe(true);
    }
  });

  it('holds the domain words this product sees constantly', () => {
    for (const w of ['Recipe', 'Dinner', 'Cook', 'Tonight']) {
      expect(CAPITALISED_STOPWORDS.has(w)).toBe(true);
    }
  });

  it('does not hold a proper noun, which is the thing being caught', () => {
    for (const w of ['Belgrade', 'Serbia', 'Marko', 'Anthropic']) {
      expect(CAPITALISED_STOPWORDS.has(w)).toBe(false);
    }
  });

  it('is exact-case, because the check is made against a capitalised word', () => {
    expect(CAPITALISED_STOPWORDS.has('the')).toBe(false);
    expect(CAPITALISED_STOPWORDS.has('The')).toBe(true);
  });

  it('does not overlap the place or demonym lists', () => {
    // A stopword that is also a place would be handed back unredacted by the
    // catch-all after the place rule had already passed over it, which silently
    // exempts that name from redaction everywhere. Checked against the real
    // patterns rather than against a sample, and by asking whether the word
    // matches in its entirety rather than in part.
    const wholeWord = (re: RegExp, w: string) => hits(re, w).includes(w);
    const overlapping = [...CAPITALISED_STOPWORDS].filter(
      w => wholeWord(PLACE_PATTERN, w) || wholeWord(DEMONYM_PATTERN, w),
    );
    expect(overlapping).toEqual([]);
  });
});
