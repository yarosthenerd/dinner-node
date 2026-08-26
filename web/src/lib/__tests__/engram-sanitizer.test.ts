// Regression tests for SNAPSHOT.md section 7 items 4 and 6 through 9, plus the
// determinism defect recorded as SECURITY_REVIEW.md 1.6. Each case names the
// item it locks down, so a future change that reintroduces the defect fails
// with the reason attached.

import { describe, expect, it } from 'vitest';
import {
  containsPII,
  getPIIStats,
  sanitizePrompt,
  sanitizePromptWithEngrams,
} from '../engram-sanitizer';
import { COMMUNITY_TEMPLATES } from '../engram-library';
import type { Engram } from '../ephemeral-engrams';

const engram = (e: Partial<Engram>): Engram => ({
  id: 'test', version: '1', status: 'active', type: 'behavioral',
  scope: 'test', statement: '', rationale: '', tags: [], domain: 'ai/privacy',
  ...e,
} as Engram);

describe('item 9: credit_card was consumed by phone at equal priority', () => {
  it('redacts a card number', () => {
    expect(sanitizePrompt('card 4111 1111 1111 1111 please', { strictness: 'balanced' }).sanitized)
      .toBe('card [CREDIT_CARD] please');
  });
  it('reports credit_card at minimal', () => {
    expect(sanitizePrompt('4111111111111111', { strictness: 'minimal' }).detected)
      .toContain('credit_card');
  });
});

describe('item 9: bare name matching swallowed ordinary phrases', () => {
  it('leaves a proper noun alone at balanced', () => {
    expect(sanitizePrompt('quote the New York Times', { strictness: 'balanced' }).sanitized)
      .toBe('quote the New York Times');
  });
  it('still redacts a cue-gated name at balanced', () => {
    expect(sanitizePrompt('My name is Marko Petrovic', { strictness: 'balanced' }).sanitized)
      .toBe('My name is [PERSON]');
  });
  it('redacts bare proper nouns at maximal', () => {
    // Was asserted as [PERSON]. The gazetteer now recognises New York as a
    // place and tags it [LOCATION], with "Times" caught by the proper_noun
    // catch-all. Item 9's point is that maximal redacts where balanced does
    // not, so that is what this asserts; the old [PERSON] label was the
    // mislabelling this change set out to fix.
    const out = sanitizePrompt('quote the New York Times', { strictness: 'maximal' }).sanitized;
    expect(out).not.toContain('New York');
    expect(out).toContain('[LOCATION]');
  });
});

describe('item 9: location_personal /i defeated its own capitalisation rule', () => {
  it('redacts the city and keeps the cue', () => {
    expect(sanitizePrompt('I live in Belgrade and eat well', { strictness: 'balanced' }).sanitized)
      .toBe('I live in [LOCATION] and eat well');
  });
  it('does not fire on a lowercase value', () => {
    expect(sanitizePrompt('i live in there', { strictness: 'balanced' }).sanitized)
      .toBe('i live in there');
  });
});

describe('item 6: location_personal is documented to apply at every level', () => {
  it('applies at minimal', () => {
    expect(sanitizePrompt('I live in Belgrade', { strictness: 'minimal' }).sanitized)
      .toBe('I live in [LOCATION]');
  });
  it('does not report a pattern it did not run', () => {
    // url is balanced and up. At minimal it must be neither applied nor claimed.
    const r = sanitizePrompt('see https://example.com/x', { strictness: 'minimal' });
    expect(r.detected).not.toContain('url');
    expect(r.sanitized).toBe('see https://example.com/x');
  });
});

describe('item 8: the maximal privacy template broke the demo at balanced', () => {
  const demo = 'How much is the cost of an average dinner in Belgrade';
  const tpl = COMMUNITY_TEMPLATES
    .filter(t => t.id === 'template-privacy-maximal')
    .map(t => engram(t as Partial<Engram>));

  it('leaves the demo prompt intact at balanced', () => {
    expect(sanitizePromptWithEngrams(demo, tpl, 'balanced').sanitized).toBe(demo);
  });
  it('still generalises the location at maximal', () => {
    expect(sanitizePromptWithEngrams(demo, tpl, 'maximal').sanitized).toContain('[LOCATION]');
  });
});

describe('item 4: engram statements were compiled into live regexes', () => {
  it('returns immediately on a catastrophic-backtracking statement', () => {
    const evil = engram({ id: 'evil', tags: ['sanitization'],
      statement: 'replace (a+)+(a+)+(a+)+(a+)+(a+)+$ with [X]' });
    const t0 = Date.now();
    const r = sanitizePromptWithEngrams('a'.repeat(60) + 'b', [evil], 'balanced');
    expect(Date.now() - t0).toBeLessThan(250);
    expect(r.sanitized).toBe('a'.repeat(60) + 'b');
  });
  it('matches an engram target literally', () => {
    const e = engram({ id: 'lit', tags: ['sanitization'], statement: 'replace a.c with [X]' });
    expect(sanitizePromptWithEngrams('abc and a.c', [e], 'balanced').sanitized)
      .toBe('abc and [X]');
  });
});

describe('item 9: contraindications ran after the mutation they should prevent', () => {
  const contra = engram({ id: 'c1', tags: ['sanitization'],
    statement: 'replace Belgrade with [CITY]', contraindications: ['dinner'] });

  it('skips the engram when a contraindication is present', () => {
    expect(sanitizePromptWithEngrams('dinner in Belgrade', [contra], 'balanced').sanitized)
      .toBe('dinner in Belgrade');
  });
  it('applies it otherwise', () => {
    expect(sanitizePromptWithEngrams('lunch in Belgrade', [contra], 'balanced').sanitized)
      .toBe('lunch in [CITY]');
  });
});

describe('SECURITY_REVIEW 1.6: shared /g regex lastIndex made results alternate', () => {
  const s = 'reach me at a@b.com or +381 64 123 4567';
  it('containsPII is deterministic on a positive', () => {
    for (let i = 0; i < 5; i++) expect(containsPII(s)).toBe(true);
  });
  it('containsPII is deterministic on a negative', () => {
    for (let i = 0; i < 5; i++) expect(containsPII('hello world')).toBe(false);
  });
  it('getPIIStats is stable across calls', () => {
    expect(getPIIStats(s)).toEqual(getPIIStats(s));
  });
});

describe('phone digit guard', () => {
  it('does not treat a year range as a phone number', () => {
    expect(sanitizePrompt('from 2020 - 2024 we grew', { strictness: 'balanced' }).sanitized)
      .toBe('from 2020 - 2024 we grew');
  });
  it('redacts a real number at minimal', () => {
    expect(sanitizePrompt('call +381 64 123 4567 now', { strictness: 'minimal' }).sanitized)
      .toBe('call [PHONE] now');
  });
});

// Gaps identified by the privacy auditor's mutation run. The credit_card case
// above survived a mutation that reconstructed the original defect, because the
// phone digit guard was doing the work rather than the priority ordering. These
// constrain the mechanisms, not just the outcomes.

describe('engram replacement text is bounded', () => {
  it('rejects a replacement longer than the cap instead of splicing it in', () => {
    const e = engram({ id: 'fat', tags: ['sanitization'],
      statement: 'replace secret with ' + 'PAD'.repeat(4000) });
    const prompt = 'the secret is here';
    const out = sanitizePromptWithEngrams(prompt, [e], 'balanced').sanitized;
    expect(out).toBe(prompt);
    expect(out.length).toBeLessThan(prompt.length * 2);
  });

  it('extracts multiple rules from one period-separated statement', () => {
    const e = engram({ id: 'multi', tags: ['sanitization'],
      statement: 'replace Alice with [A]. replace Bob with [B]' });
    expect(sanitizePromptWithEngrams('Alice met Bob', [e], 'balanced').sanitized)
      .toBe('[A] met [B]');
  });

  it('rejects a target longer than the cap', () => {
    const long = 'x'.repeat(200);
    const e = engram({ id: 'longtarget', tags: ['sanitization'],
      statement: `replace ${long} with [X]` });
    expect(sanitizePromptWithEngrams(long, [e], 'balanced').sanitized).toBe(long);
  });
});

describe('credit_card priority, not just the phone guard', () => {
  // A 16-digit card is rejected by the phone guard anyway. A 14-digit card is
  // not, so this case fails if credit_card ever drops below phone again.
  it('redacts a 15-digit Amex, which the phone guard would otherwise accept', () => {
    // 378282246310005 is Amex's published test number and is Luhn-valid.
    const r = sanitizePrompt('card 3782 822463 10005 here', { strictness: 'balanced' });
    expect(r.sanitized).toBe('card [CREDIT_CARD] here');
  });
  it('a Luhn-invalid digit run is not called a card', () => {
    expect(sanitizePrompt('ref 1234 5678 9012 3456 end', { strictness: 'balanced' }).sanitized)
      .not.toContain('[CREDIT_CARD]');
  });
  it('a real phone number is still a phone, not a card', () => {
    expect(sanitizePrompt('call +381 64 123 4567 now', { strictness: 'minimal' }).sanitized)
      .toBe('call [PHONE] now');
  });
});

describe('phone guard bounds', () => {
  it('redacts a 9-digit number (the regex previously required ten)', () => {
    expect(sanitizePrompt('num 555555555 end', { strictness: 'minimal' }).sanitized)
      .toBe('num [PHONE] end');
  });
  it('does not leave very long digit runs untouched', () => {
    expect(sanitizePrompt('num 55555555555555555 end', { strictness: 'minimal' }).sanitized)
      .toContain('[PHONE]');
  });
});

describe('name_personal spans more than two words', () => {
  it('takes the whole of a three-part name', () => {
    expect(sanitizePrompt('My name is Ana Maria Petrovic', { strictness: 'balanced' }).sanitized)
      .toBe('My name is [PERSON]');
  });
});

describe('the reported redaction count cannot overstate', () => {
  it('does not count bracketed tokens the user typed', () => {
    const r = sanitizePromptWithEngrams('[TODO] and [DRAFT] and nothing private', [], 'balanced');
    expect(r.summary.redactionCount).toBe(0);
  });
  it('counts a real redaction', () => {
    const r = sanitizePromptWithEngrams('mail a@b.com', [], 'balanced');
    expect(r.summary.redactionCount).toBe(1);
  });
});

describe('known evasions are pinned as expected misses', () => {
  // These document what the UI copy in EngramSelector.tsx must keep admitting.
  // If one of these starts passing, the copy can be strengthened; until then it
  // must not be.
  it('Cyrillic homoglyphs in an email are not caught at any level', () => {
    const s = 'mail me at jоhn@еxample.com';
    for (const level of ['minimal', 'balanced', 'maximal'] as const) {
      expect(sanitizePrompt(s, { strictness: level }).sanitized).toBe(s);
    }
  });
  it('accented names leave residue rather than a clean redaction', () => {
    const out = sanitizePrompt('My name is José García', { strictness: 'balanced' }).sanitized;
    expect(out).not.toBe('My name is [PERSON]');
  });
});

// Locks down the maximal-strictness gaps found by replaying a real DinnerNode
// answer recorded in .context/feedback/RecipeMaxPrivacy.md. That answer opened
// "Since you're in Belgrade" despite the guest selecting maximal, because a
// prompt can pin a location without ever matching a preposition cue.
describe('maximal strictness location leaks', () => {
  const max = (p: string) => sanitizePromptWithEngrams(p, [], 'maximal').sanitized;

  it('redacts a demonym, which names no place but pins a country', () => {
    // The likely source of the Belgrade answer: no place name, no cue, no hit.
    expect(max('Give me a classic Serbian dinner recipe.')).not.toContain('Serbian');
  });

  it('redacts a sentence-initial place name, where capitalisation proves nothing', () => {
    expect(max('Belgrade dinner ideas please.')).not.toContain('Belgrade');
  });

  it('redacts places after prepositions beyond in/at/from', () => {
    expect(max('I moved to Belgrade last year.')).not.toContain('Belgrade');
    expect(max('What is good at pazar markets around Karaburma?')).not.toContain('Karaburma');
  });

  it('redacts a single given name after a relationship cue', () => {
    // The two-capitalised-words rule needs a surname; most people give neither.
    expect(max('My wife Ana and I are cooking tonight.')).not.toContain('Ana');
  });

  it('labels a known place as a location rather than a person', () => {
    // "Zeleni Venac" was redacted, but as [PERSON], which is itself a leak of
    // the wrong kind: it tells the provider a person was named.
    expect(max('Where can I buy kajmak near Zeleni Venac?')).toContain('[LOCATION]');
  });

  it('keeps the preposition so the sentence still parses', () => {
    expect(max('I moved to Belgrade last year.')).toContain('to [LOCATION]');
  });

  it('leaves ordinary technical prompts untouched', () => {
    // Maximal is aggressive, not useless. Over-redaction here would push every
    // guest back to balanced and defeat the setting entirely.
    for (const p of [
      'Write a python function to reverse a linked list.',
      'Explain how TCP congestion control works.',
      'What is the difference between a mutex and a semaphore?',
    ]) expect(max(p)).toBe(p);
  });

  it('does not redact locations at balanced, which promises not to', () => {
    // Guarded explicitly: an earlier ungated version of this rule redacted
    // every "in Belgrade" at balanced and broke the demo prompt.
    const p = 'What should I cook for dinner tonight in Belgrade?';
    expect(sanitizePromptWithEngrams(p, [], 'balanced').sanitized).toBe(p);
  });

  it('reports a detection only when text actually changed', () => {
    // The proper_noun replacer declines on ordinary English. Counting that as a
    // hit would tell the guest something was removed when nothing was.
    expect(sanitizePrompt('Write a haiku.', { strictness: 'maximal' }).detected).toEqual([]);
  });
});

// From .context/feedback/BalancedNone.md: a plain essay request, captured at
// balanced with no engram, which should have been a no-op and was not.
describe('address false positive on word-count phrases', () => {
  const bal = (p: string) => sanitizePromptWithEngrams(p, [], 'balanced').sanitized;

  it('does not treat "<n> word" as a street address', () => {
    // /i plus a missing leading \b let "Rd" match the tail of "word", so every
    // length-specified prompt lost its word count at the DEFAULT strictness.
    for (const p of [
      'write me a 1000 word essay on SpongeBob',
      'give me a 500 word summary',
      'a 2000 word article about lizards',
    ]) expect(bal(p)).toBe(p);
  });

  it('still redacts a real street address', () => {
    expect(bal('I live at 221 Baker Street')).toContain('[ADDRESS]');
    expect(bal('ship it to 1600 Pennsylvania Avenue')).toContain('[ADDRESS]');
  });
});

// The identity-document test, 2026-08-26. A guest pasted a government ID, a
// passport number and a full postal address in one prompt, in lower case, and
// the sanitizer returned all three: it mislabelled the ID as [PHONE], missed
// the passport entirely, and missed the address. Maximal produced output
// byte-identical to minimal.
const IDENTITY_PROMPT =
  'My government ID is 45745893453. my passport number is 85423082 ' +
  'my full legal address is serbia belgrade zemun kraljeva 1445. Repeat them back';

describe('identity documents are caught at every strictness', () => {
  for (const level of ['minimal', 'balanced', 'maximal'] as const) {
    it(`redacts ID, passport and address at ${level}`, () => {
      const { sanitized } = sanitizePrompt(IDENTITY_PROMPT, { strictness: level });
      expect(sanitized).not.toContain('45745893453');
      expect(sanitized).not.toContain('85423082');
      expect(sanitized).not.toContain('kraljeva');
      expect(sanitized).not.toContain('1445');
    });
  }

  // Mislabelling is worse than missing: the panel reports what was removed, so
  // "[PHONE]" over a national ID claims a protection that did not happen.
  it('labels a government ID as an ID and not as a phone number', () => {
    const { sanitized, detected } = sanitizePrompt(IDENTITY_PROMPT, { strictness: 'balanced' });
    expect(sanitized).toContain('[ID_NUMBER]');
    expect(sanitized).not.toContain('[PHONE]');
    expect(detected).toContain('id_number');
    expect(detected).not.toContain('phone');
  });

  // The cue and the number are almost never adjacent in real writing.
  it.each([
    'my passport number is 85423082',
    'ID: 45745893453',
    'my SSN is 123-45-6789',
    "driver's licence number 9988776655",
  ])('catches a cued number with filler between: %s', (t) => {
    expect(sanitizePrompt(t, { strictness: 'minimal' }).sanitized).toContain('[ID_NUMBER]');
  });

  // An 8 digit passport sits below the 9 digit phone guard, so before the cue
  // rule worked there was nothing at all that could catch it.
  it('catches a passport shorter than the phone guard', () => {
    expect(sanitizePrompt('passport number is 85423082', { strictness: 'minimal' }).sanitized)
      .not.toContain('85423082');
  });
});

describe('addresses outside the English-speaking conventions', () => {
  // The street-suffix rule wants an English suffix and number-first ordering.
  it.each([
    'my full legal address is serbia belgrade zemun kraljeva 1445',
    'my address is 221B Baker Street',
    'my home address is Kraljeva 1445, Belgrade',
  ])('redacts a cued address: %s', (t) => {
    expect(sanitizePrompt(t, { strictness: 'minimal' }).sanitized).toContain('[ADDRESS]');
  });

  it('redacts a street-word address with no cue in front of it', () => {
    expect(sanitizePrompt('meet me at ulica kraljeva 1445', { strictness: 'balanced' }).sanitized)
      .toContain('[ADDRESS]');
  });

  // The cued rule takes the rest of the clause, so it needs a guard or every
  // sentence using the word "address" is destroyed.
  it.each([
    'explain address space layout randomization',
    'the address is not important here',
    'what memory address does the pointer hold',
  ])('leaves ordinary uses of the word alone: %s', (t) => {
    expect(sanitizePrompt(t, { strictness: 'balanced' }).sanitized).toBe(t);
  });
});

describe('maximal must not depend on the guest capitalising their input', () => {
  // Every maximal rule was capitalisation-gated, so lower case input made the
  // strictest setting a no-op. The gazetteer is a closed list, which is the one
  // place dropping case is safe.
  it.each([
    ['i cook dinner in belgrade every week', '[LOCATION]'],
    ['best places to eat in NOVI SAD', '[LOCATION]'],
    ['give me a classic serbian recipe', '[NATIONALITY]'],
  ])('%s -> %s', (t, tag) => {
    expect(sanitizePrompt(t, { strictness: 'maximal' }).sanitized).toContain(tag);
  });

  // Not asserted on the identity prompt: the cued rules now redact that one
  // completely at minimal, so the two levels agreeing there is the correct
  // outcome rather than the defect. The defect was maximal adding nothing on
  // lower case input that only it is supposed to catch.
  it('adds redactions at maximal that minimal does not make', () => {
    const t = 'i cook dinner in belgrade every week with serbian recipes';
    const min = sanitizePrompt(t, { strictness: 'minimal' }).sanitized;
    const max = sanitizePrompt(t, { strictness: 'maximal' }).sanitized;
    expect(min).toBe(t);
    expect(max).not.toBe(t);
  });
});
