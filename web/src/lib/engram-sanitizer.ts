/**
 * Client-Side PII Sanitization Layer
 *
 * Filters and generalizes personally identifiable information before prompts
 * are hashed or sent to providers.
 *
 * What this is: pattern matching in the browser, best effort. It runs before
 * the prompt is hashed and before it leaves the machine, so what it catches is
 * genuinely never sent. What it is not: a guarantee. Unicode homoglyphs,
 * accented names, transliteration and paraphrase all defeat it, and the
 * provider still receives the sanitized prompt in plaintext. Any user-facing
 * copy must say so. See SNAPSHOT.md section 7 items 6 to 9.
 */

import type { Engram } from './ephemeral-engrams';
import { PLACE_PATTERN, DEMONYM_PATTERN, CAPITALISED_STOPWORDS } from './gazetteer';

type Strictness = 'minimal' | 'balanced' | 'maximal';

const LEVEL_RANK: Record<Strictness, number> = { minimal: 0, balanced: 1, maximal: 2 };

type PiiPattern = {
  type: string;
  pattern: RegExp;
  replacement: string;
  /** Higher runs first. Distinct values, because equal priorities left the
   *  outcome to array order and that is how `phone` was eating every credit
   *  card number before `credit_card` ever ran. */
  priority: number;
  /** Lowest strictness at which this pattern applies. */
  minLevel: Strictness;
  /** Optional extra test on a candidate match; a false result rejects it. */
  guard?: (match: string) => boolean;
  /** Optional replacement builder, for patterns that match a cue plus a value
   *  and should only redact the value. */
  replacer?: (match: string, ...groups: string[]) => string;
};

// A phone pattern of [\d\s-]{10,} matches any ten-character run of digits,
// spaces and dashes, including dates, ranges and table rows. Count the digits.
const digitCount = (s: string) => (s.match(/\d/g) || []).length;

// Card numbers and phone numbers are both runs of digits with separators, and
// a 4x4 pattern only recognises one card layout. Amex is 15 digits as 4-6-5 and
// was falling through to `phone` and being labelled [PHONE]. Luhn is what
// actually distinguishes the two: every issued card number satisfies it, and an
// arbitrary phone number satisfies it about one time in ten.
const luhnValid = (s: string): boolean => {
  const d = (s.match(/\d/g) || []).map(Number);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    const fromRight = d.length - 1 - i;
    let v = d[i];
    if (fromRight % 2 === 1) { v *= 2; if (v > 9) v -= 9; }
    sum += v;
  }
  return sum % 10 === 0;
};

const PII_PATTERNS: PiiPattern[] = [
  { type: 'api_key', priority: 14, minLevel: 'minimal',
    pattern: /\b(?:api[_-]?key|secret|token|password)[:\s]?\s*['"]?[A-Za-z0-9_-]{20,}['"]?/gi,
    replacement: '[SECRET]' },

  // Above `phone`. At equal priority the phone pattern consumed the digits and
  // [CREDIT_CARD] could never appear in any output. The priority is load
  // bearing on its own: a 14 or 15 digit card also satisfies the phone guard,
  // so whichever runs first wins.
  { type: 'credit_card', priority: 13, minLevel: 'minimal',
    pattern: /\b\d(?:[\s-]?\d){12,18}\b/g,
    replacement: '[CREDIT_CARD]',
    guard: luhnValid },

  // The cue and the number are almost never adjacent. This pattern was
  // /(?:ID|SSN|Passport|License)[:\s]?\s*[\d-]{8,}/, which requires the digits
  // to follow the cue immediately, so it never fired on how anyone actually
  // writes: "my government ID is 45745893453", "my passport number is
  // 85423082". Both fell through to `phone`, and an 11 digit national ID was
  // redacted as [PHONE] while an 8 digit passport went through untouched,
  // because it is below the nine digit phone guard.
  //
  // Mislabelling is the worse half of that. The panel tells the guest what it
  // removed, so "[PHONE]" over a government ID reports a protection that did
  // not happen and hides one that did.
  //
  // Filler between cue and value is now allowed, and the value is redacted on
  // its own so the sentence still reads. Priority is above `phone` so a cued
  // number is claimed here first and can never be relabelled.
  //
  // At `minimal`, alongside the other cued high-confidence rules. A number the
  // guest has themselves labelled as an ID is not a judgement call, and
  // leaving it to `balanced` meant the least strict setting kept reporting
  // government IDs as phone numbers.
  { type: 'id_number', priority: 12, minLevel: 'minimal',
    pattern: /\b((?:government|national|personal|social\s+security|tax|driver'?s?|drivers)\s+)?(?:ID|IDs|identity|identification|SSN|JMBG|OIB|NIN|passport|licen[cs]e)(?:\s+(?:number|no\.?|num|code|#))?\s*(?:is|are|:|=|#)?\s*([A-Za-z]{0,2}\d[\d\s-]{4,}\d)/gi,
    replacement: '[ID_NUMBER]',
    // Six digits minimum. The cue itself carries none, so counting over the
    // whole match is counting the value.
    guard: (m) => digitCount(m) >= 6,
    replacer: (m, _lead, value: string) => m.slice(0, m.length - value.length) + '[ID_NUMBER]' },

  // An explicit address cue, redacted to the end of the clause.
  //
  // The pattern below this one needs an English street suffix and US ordering
  // (number, then street name). "serbia belgrade zemun kraljeva 1445" is the
  // European shape - street name then number - in a language whose street
  // words are not in any list, so nothing matched a full postal address the
  // guest had explicitly labelled as one.
  //
  // Taking the rest of the clause is deliberate. An address is the one field
  // where the guest has already told us the remainder is sensitive, and no
  // amount of per-country street vocabulary generalises. Shares priority 12
  // with id_number, which is safe: one requires an address cue and the other
  // an identity cue, so they cannot claim the same text.
  { type: 'address', priority: 12, minLevel: 'minimal',
    pattern: /\b((?:my\s+)?(?:full\s+)?(?:legal\s+|home\s+|postal\s+|mailing\s+|current\s+|permanent\s+|billing\s+|shipping\s+)?address(?:es)?\s*(?:is|are|:|=)\s*)([^.!?\n]+)/gi,
    replacement: '[ADDRESS]',
    // Without this, "the address is not important here" was redacted whole.
    // A postal address carries a number or a comma essentially always, and
    // an English sentence that merely uses the word "address" usually carries
    // neither. The trade is deliberate and falls the safe way: a rare benign
    // clause with a comma in it is over-redacted, rather than a real address
    // without a house number being sent in the clear.
    guard: (m) => /\d/.test(m) || m.includes(','),
    replacer: (_m, cue: string, _rest: string) => cue + '[ADDRESS]' },

  { type: 'email', priority: 11, minLevel: 'minimal',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[EMAIL]' },

  { type: 'ip', priority: 11, minLevel: 'balanced',
    pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: '[IP_ADDRESS]' },

  { type: 'phone', priority: 10, minLevel: 'minimal',
    pattern: /\+?\d[\d\s().-]{7,}\d/g,
    replacement: '[PHONE]',
    // The guard, not the regex, is the binding constraint: nine is the
    // shortest real dialable number in the plans we care about, and it keeps
    // "2020 - 2024" (eight digits) from being redacted as a phone. There is
    // deliberately no upper bound. A 15 digit ceiling meant any longer digit
    // run was left completely untouched, which is the wrong way to fail.
    guard: (m) => digitCount(m) >= 9 },

  // The cue is literal-cased rather than /i, because /i made the [A-Z][a-z]+
  // capitalization requirement on the value meaningless and "i live in there"
  // matched. Only the value is redacted, so the sentence still reads.
  { type: 'location_personal', priority: 9, minLevel: 'minimal',
    pattern: /\b(?:[Ii]\s+live\s+in|[Ii]'?m\s+from|[Ii]\s+am\s+from|[Mm]y\s+city\s+is|[Ww]e\s+live\s+in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g,
    replacement: '[LOCATION]',
    replacer: (m, city) => m.slice(0, m.length - city.length) + '[LOCATION]' },

  // Cue-gated names apply from balanced. The bare two-capitalized-words
  // pattern below is maximal only, because it cannot tell a person from a
  // newspaper and turned "New York Times" into [PERSON] at the default level.
  { type: 'name_personal', priority: 9, minLevel: 'balanced',
    pattern: /\b(?:[Mm]y\s+name\s+is|[Ii]\s+am|[Ii]'m|[Tt]his\s+is|[Ss]igned,?|[Ss]incerely,?)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){0,3})\b/g,
    replacement: '[PERSON]',
    replacer: (m, name) => m.slice(0, m.length - name.length) + '[PERSON]' },

  { type: 'url', priority: 8, minLevel: 'balanced',
    pattern: /\bhttps?:\/\/[^\s/$.?#].[^\s]*/g,
    replacement: '[URL]' },

  // The street-type token needs a word boundary on BOTH sides. With only a
  // trailing \b and the /i flag, "Rd" matched the last two letters of "word",
  // so "write me a 1000 word essay" became "write me a [ADDRESS] essay" at the
  // default strictness. Any "<number> word" phrase was affected, which is one
  // of the most common shapes a prompt takes.
  // Street-suffix addresses with no cue in front of them. Two orderings,
  // because number-first is an English-speaking convention and most of Europe
  // writes the number last. The non-English street words are the ones that
  // appear in the region this node actually serves; the list raises the floor
  // and is not a substitute for the cued rule above.
  { type: 'address', priority: 7, minLevel: 'balanced',
    pattern: /\b(?:\d+\s+[A-Za-z\s]+\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln)|(?:ulica|ul|bulevar|bul|trg|put|aleja|strasse|stra\u00dfe|str|via|rue|calle|plaza|plac)\.?\s+[A-Za-z\u00c0-\u024f]+\s+\d{1,4}[a-z]?|[A-Za-z\u00c0-\u024f]+\s+(?:ulica|bulevar|trg|strasse|stra\u00dfe|via|rue|calle)\s*\d{1,4}[a-z]?)\b/gi,
    replacement: '[ADDRESS]' },

  // Known places, by name. Ranked above location_generic and name so a real
  // place is tagged [LOCATION] rather than being mislabelled [PERSON] by the
  // two-capitalised-words rule, which is what happened to "Zeleni Venac".
  // Position-independent, which is the point: it is the only rule that catches
  // a sentence-initial "Belgrade dinner ideas please."
  { type: 'location_known', priority: 8, minLevel: 'maximal',
    pattern: PLACE_PATTERN,
    replacement: '[LOCATION]' },

  // A demonym names no place and still pins the guest to a country. "Give me a
  // classic Serbian dinner recipe" passed every positional rule and is how an
  // answer came back opening "Since you're in Belgrade".
  { type: 'nationality', priority: 8, minLevel: 'maximal',
    pattern: DEMONYM_PATTERN,
    replacement: '[NATIONALITY]' },

  { type: 'location_generic', priority: 6, minLevel: 'maximal',
    // Was in|at|from only, so "I moved to Belgrade" and "markets around
    // Karaburma" both survived at the strictest setting.
    pattern: /\b(?:in|at|from|to|near|around|outside|inside|within|via|towards?|beside|behind)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g,
    replacement: '[LOCATION]',
    // Keep the preposition, as location_personal does. Replacing the whole
    // match turned "buy kajmak near Zeleni Venac" into "buy kajmak [LOCATION]",
    // which loses the grammar for no privacy gain: "near" reveals nothing.
    replacer: (m, place) => m.slice(0, m.length - place.length) + '[LOCATION]' },

  { type: 'name', priority: 5, minLevel: 'maximal',
    pattern: /\b[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
    replacement: '[PERSON]' },

  // Last resort at maximal: any remaining capitalised word that is not
  // sentence-initial and is not ordinary English. This is what catches a
  // proper noun no list can hold, such as a neighbourhood like "Karaburma".
  // Sentence-initial words are exempt because capitalisation there carries no
  // information, which is precisely why the gazetteer above exists.
  { type: 'proper_noun', priority: 4, minLevel: 'maximal',
    // No `^` alternative: a match at string start IS sentence-initial, which
    // is the case this rule deliberately skips.
    pattern: /([^.!?\n]\s+)([A-Z][a-z]{2,})\b/g,
    replacement: '[REDACTED]',
    replacer: (m, lead: string, word: string) =>
      CAPITALISED_STOPWORDS.has(word) ? m : lead + '[REDACTED]' },
];

const applies = (p: PiiPattern, s: Strictness) => LEVEL_RANK[s] >= LEVEL_RANK[p.minLevel];

/** Every read of a module-level /g regex must start from zero. `.test` and
 *  `.exec` advance lastIndex on the shared object, which is what made
 *  containsPII alternate true and false on identical input. */
const fresh = (p: RegExp) => { p.lastIndex = 0; return p; };

function applyPattern(text: string, p: PiiPattern): { text: string; hit: boolean } {
  let hit = false;
  const out = text.replace(fresh(p.pattern), (...args: any[]) => {
    const match = args[0] as string;
    const groups = args.slice(1, args.length - 2) as string[];
    if (p.guard && !p.guard(match)) return match;
    // Report a hit only when the text actually changed. A replacer may decline
    // (the proper_noun rule returns the match unchanged for ordinary English),
    // and flagging that as detected would tell the user something was removed
    // when nothing was.
    const replaced = p.replacer ? p.replacer(match, ...groups) : p.replacement;
    if (replaced !== match) hit = true;
    return replaced;
  });
  fresh(p.pattern);
  return { text: out, hit };
}

export function sanitizePrompt(
  prompt: string,
  options: { strictness: Strictness; preserveContext?: boolean } = { strictness: 'balanced' }
): { sanitized: string; detected: string[]; originalLength: number; sanitizedLength: number } {
  const detected = new Set<string>();
  let sanitized = prompt;

  const sorted = [...PII_PATTERNS].sort((a, b) => b.priority - a.priority);

  for (const p of sorted) {
    // A pattern that does not apply at this strictness is not run and is not
    // reported. Reporting location_personal as detected while discarding the
    // redaction told the user their city had been removed when it had not.
    if (!applies(p, options.strictness)) continue;
    const { text, hit } = applyPattern(sanitized, p);
    if (hit) { detected.add(p.type); sanitized = text; }
  }

  return {
    sanitized,
    detected: Array.from(detected),
    originalLength: prompt.length,
    sanitizedLength: sanitized.length,
  };
}

export function applyEngramSanitization(
  prompt: string,
  engrams: Engram[],
  strictness: Strictness = 'balanced'
): { sanitized: string; rulesApplied: string[] } {
  let sanitized = prompt;
  const rulesApplied = new Set<string>();

  for (const engram of engrams) {
    if (!(engram.domain === 'ai/privacy' || engram.tags.includes('sanitization'))) continue;

    // Contraindications are checked against the text as it stands BEFORE this
    // engram runs. Checking afterwards, as the previous version did, tested
    // the mutated text for a term the mutation had usually just removed, and
    // then only un-recorded the engram without undoing its edit.
    if (engram.contraindications?.some(c => c && sanitized.toLowerCase().includes(c.toLowerCase()))) continue;

    for (const rule of extractSanitizationRules(engram, strictness)) {
      const next = sanitized.replace(fresh(rule.pattern), rule.replacement);
      if (next !== sanitized) { sanitized = next; rulesApplied.add(engram.id); }
    }
  }

  return { sanitized, rulesApplied: Array.from(rulesApplied) };
}

const MAX_RULES_PER_ENGRAM = 16;
const MAX_TARGET_LENGTH = 128;
const MAX_REPLACEMENT_LENGTH = 64;

/** Regex metacharacters escaped so an engram target is matched literally. */
const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function extractSanitizationRules(
  engram: Engram,
  strictness: Strictness
): Array<{ pattern: RegExp; replacement: string }> {
  const rules: Array<{ pattern: RegExp; replacement: string }> = [];
  // The replacement is bounded and must not cross a sentence or line break.
  // With a greedy `(.+)` the replacement ran to end of line, which had two
  // consequences. A padded statement expanded a 350 character prompt to
  // 600,000 characters, and that expansion is what gets hashed and sent to the
  // provider while the token estimate shown to the user is computed on the
  // pre-sanitization text. And a multi-rule statement collapsed into one rule
  // that spliced the literal remainder of the statement into the prompt, which
  // also made MAX_RULES_PER_ENGRAM unreachable for the period-separated
  // statements every library template uses.
  const replacePattern = /replace\s+(.+?)\s+with\s+([^.\n]+)/gi;
  let match: RegExpExecArray | null;

  replacePattern.lastIndex = 0;
  while ((match = replacePattern.exec(engram.statement)) !== null && rules.length < MAX_RULES_PER_ENGRAM) {
    const [, target, replacement] = match;
    const trimmed = target.trim();
    const replacementText = replacement.trim();
    if (!trimmed || trimmed.length > MAX_TARGET_LENGTH) continue;
    if (!replacementText || replacementText.length > MAX_REPLACEMENT_LENGTH) continue;
    // The target is compiled as a literal, never as user-authored regex
    // syntax. new RegExp(target) on engram text was a live ReDoS: a 28
    // character statement took 1.6 seconds and a 41 character one did not
    // return in 110 seconds, freezing the tab before the prompt was ever sent.
    // Escaping removes the catastrophic-backtracking surface entirely, and
    // "replace X with Y" in an English statement means a literal X anyway.
    rules.push({ pattern: new RegExp(escapeLiteral(trimmed), 'gi'), replacement: replacementText });
  }

  if (rules.length === 0 && engram.domain === 'ai/privacy') {
    rules.push({ pattern: /\b(?:I am|I'm|my name is)\s+([A-Z][a-z]+)\b/g, replacement: '[USER]' });
    // Gated on maximal. Ungated, this fallback redacted every "in Belgrade"
    // at balanced strictness, which is exactly what balanced promises not to
    // do and what broke the demo prompt.
    if (strictness === 'maximal') {
      rules.push({ pattern: /\b(?:in|at|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g, replacement: '[LOCATION]' });
    }
  }

  return rules;
}

export function sanitizePromptWithEngrams(
  prompt: string,
  engrams: Engram[],
  strictness: Strictness = 'balanced'
): {
  sanitized: string;
  detected: string[];
  engramRulesApplied: string[];
  summary: { originalLength: number; sanitizedLength: number; redactionCount: number };
} {
  const standardResult = sanitizePrompt(prompt, { strictness });
  const engramResult = applyEngramSanitization(standardResult.sanitized, engrams, strictness);
  // Counting bracketed uppercase tokens in the OUTPUT counted the user's own
  // [TODO] and [DRAFT] as redactions and reported an inflated number under a
  // privacy heading. Count the delta instead, so the figure can only ever
  // understate.
  const bracketed = (t: string) => (t.match(/\[([A-Z_]+)\]/g) || []).length;
  const redactionCount = Math.max(0, bracketed(engramResult.sanitized) - bracketed(prompt));

  return {
    sanitized: engramResult.sanitized,
    detected: standardResult.detected,
    engramRulesApplied: engramResult.rulesApplied,
    summary: {
      originalLength: standardResult.originalLength,
      sanitizedLength: engramResult.sanitized.length,
      redactionCount,
    },
  };
}

export function generatePrivacyEngram(detectedTypes: string[], context: string): Partial<Engram> {
  const statementParts: string[] = [];
  if (detectedTypes.includes('email')) statementParts.push('Replace email addresses with [EMAIL]');
  if (detectedTypes.includes('phone')) statementParts.push('Replace phone numbers with [PHONE]');
  if (detectedTypes.some(t => t.startsWith('location'))) statementParts.push('Generalize specific locations to [LOCATION]');
  if (detectedTypes.some(t => t === 'name' || t === 'name_personal')) statementParts.push('Replace personal names with [PERSON]');
  if (detectedTypes.includes('address')) statementParts.push('Replace physical addresses with [ADDRESS]');

  return {
    type: 'behavioral',
    domain: 'ai/privacy',
    statement: statementParts.join('. ') + '. Always apply these transformations before sending prompts to inference providers.',
    rationale: `Privacy protection based on detected PII in: ${context}`,
    tags: ['privacy', 'pii', 'sanitization', ...detectedTypes],
    episodic: { confidence: 9, emotional_weight: 8, trigger_context: context },
  };
}

// Both detection entry points default to 'maximal', so an unqualified "does
// this contain PII" question gets the broadest honest answer. They previously
// disagreed ('balanced' here, 'maximal' below), which is a trap for the next
// caller.
export function containsPII(text: string, strictness: Strictness = 'maximal'): boolean {
  for (const p of PII_PATTERNS) {
    if (!applies(p, strictness)) continue;
    fresh(p.pattern);
    let m: RegExpExecArray | null;
    while ((m = p.pattern.exec(text)) !== null) {
      if (!p.guard || p.guard(m[0])) { fresh(p.pattern); return true; }
      if (m.index === p.pattern.lastIndex) p.pattern.lastIndex++;
    }
    fresh(p.pattern);
  }
  return false;
}

export function getPIIStats(text: string, strictness: Strictness = 'maximal'): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const p of PII_PATTERNS) {
    if (!applies(p, strictness)) continue;
    fresh(p.pattern);
    const matches = (text.match(p.pattern) || []).filter(m => !p.guard || p.guard(m));
    fresh(p.pattern);
    if (matches.length) stats[p.type] = (stats[p.type] || 0) + matches.length;
  }
  return stats;
}
