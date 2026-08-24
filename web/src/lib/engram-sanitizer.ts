/**
 * Client-Side PII Sanitization Layer
 * 
 * Filters and generalizes personally identifiable information
 * before prompts are hashed or sent to providers.
 */

import type { Engram } from './ephemeral-engrams';

const PII_PATTERNS: Array<{
  type: string;
  pattern: RegExp;
  replacement: string;
  priority: number;
}> = [
  { type: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL]', priority: 10 },
  { type: 'phone', pattern: /\+?[\d\s-]{10,}\b/g, replacement: '[PHONE]', priority: 10 },
  { type: 'ip', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP_ADDRESS]', priority: 10 },
  { type: 'url', pattern: /\bhttps?:\/\/[^\s/$.?#].[^\s]*\b/g, replacement: '[URL]', priority: 8 },
  { type: 'address', pattern: /\b\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln)\b/gi, replacement: '[ADDRESS]', priority: 7 },
  { type: 'name', pattern: /\b[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g, replacement: '[PERSON]', priority: 5 },
  { type: 'location', pattern: /\b(?:in|at|from|live(?:s)? in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/gi, replacement: '[LOCATION]', priority: 6 },
  { type: 'id_number', pattern: /\b(?:ID|SSN|Passport|License)[:\s]?\s*[\d-]{8,}\b/gi, replacement: '[ID_NUMBER]', priority: 10 },
  { type: 'credit_card', pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '[CREDIT_CARD]', priority: 10 },
  { type: 'api_key', pattern: /\b(?:api[_-]?key|secret|token|password)[:\s]?\s*['"]?[A-Za-z0-9_-]{20,}['"]?\b/gi, replacement: '[SECRET]', priority: 10 }
];

export function sanitizePrompt(
  prompt: string,
  options: { strictness: 'minimal' | 'balanced' | 'maximal'; preserveContext?: boolean } = { strictness: 'balanced' }
): { sanitized: string; detected: string[]; originalLength: number; sanitizedLength: number } {
  const detected = new Set<string>();
  let sanitized = prompt;
  
  const sortedPatterns = [...PII_PATTERNS].sort((a, b) => b.priority - a.priority);
  
  for (const { type, pattern, replacement } of sortedPatterns) {
    const matches = sanitized.match(pattern);
    if (matches && matches.length > 0) {
      detected.add(type);
      
      if (options.strictness === 'maximal') {
        sanitized = sanitized.replace(pattern, replacement);
      } else if (options.strictness === 'balanced') {
        if (options.preserveContext) {
          sanitized = sanitized.replace(pattern, (match) => {
            if (match.length > 20) return `${match[0]}...${replacement}...${match[match.length - 1]}`;
            return replacement;
          });
        } else {
          sanitized = sanitized.replace(pattern, replacement);
        }
      } else {
        if (type === 'email' || type === 'phone' || type === 'credit_card' || type === 'api_key') {
          sanitized = sanitized.replace(pattern, replacement);
        }
      }
    }
  }
  
  return {
    sanitized,
    detected: Array.from(detected),
    originalLength: prompt.length,
    sanitizedLength: sanitized.length
  };
}

export function applyEngramSanitization(
  prompt: string,
  engrams: Engram[]
): { sanitized: string; rulesApplied: string[] } {
  let sanitized = prompt;
  const rulesApplied = new Set<string>();
  
  for (const engram of engrams) {
    if (engram.domain === 'ai/privacy' || engram.tags.includes('sanitization')) {
      const customRules = extractSanitizationRules(engram);
      for (const rule of customRules) {
        if (sanitized.match(rule.pattern)) {
          sanitized = sanitized.replace(rule.pattern, rule.replacement);
          rulesApplied.add(engram.id);
        }
      }
    }
    
    if (engram.contraindications) {
      for (const contra of engram.contraindications) {
        if (sanitized.toLowerCase().includes(contra.toLowerCase())) {
          rulesApplied.delete(engram.id);
        }
      }
    }
  }
  
  return { sanitized, rulesApplied: Array.from(rulesApplied) };
}

function extractSanitizationRules(engram: Engram): Array<{ pattern: RegExp; replacement: string }> {
  const rules: Array<{ pattern: RegExp; replacement: string }> = [];
  const replacePattern = /replace\s+(.+?)\s+with\s+(.+)/gi;
  let match;
  
  while ((match = replacePattern.exec(engram.statement)) !== null) {
    const [, target, replacement] = match;
    try {
      rules.push({ pattern: new RegExp(target, 'gi'), replacement: replacement.trim() });
    } catch {
      // Invalid regex, skip
    }
  }
  
  if (rules.length === 0 && engram.domain === 'ai/privacy') {
    rules.push({ pattern: /\b(?:I am|I'm|my name is)\s+([A-Z][a-z]+)\b/gi, replacement: '[USER]' });
    rules.push({ pattern: /\b(?:in|at|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/gi, replacement: '[LOCATION]' });
  }
  
  return rules;
}

export function sanitizePromptWithEngrams(
  prompt: string,
  engrams: Engram[],
  strictness: 'minimal' | 'balanced' | 'maximal' = 'balanced'
): {
  sanitized: string;
  detected: string[];
  engramRulesApplied: string[];
  summary: { originalLength: number; sanitizedLength: number; redactionCount: number };
} {
  const standardResult = sanitizePrompt(prompt, { strictness });
  const engramResult = applyEngramSanitization(standardResult.sanitized, engrams);
  const redactionCount = (engramResult.sanitized.match(/\[([A-Z_]+)\]/g) || []).length;
  
  return {
    sanitized: engramResult.sanitized,
    detected: standardResult.detected,
    engramRulesApplied: engramResult.rulesApplied,
    summary: {
      originalLength: standardResult.originalLength,
      sanitizedLength: engramResult.sanitized.length,
      redactionCount
    }
  };
}

export function generatePrivacyEngram(detectedTypes: string[], context: string): Partial<Engram> {
  const statementParts: string[] = [];
  if (detectedTypes.includes('email')) statementParts.push('Replace email addresses with [EMAIL]');
  if (detectedTypes.includes('phone')) statementParts.push('Replace phone numbers with [PHONE]');
  if (detectedTypes.includes('location')) statementParts.push('Generalize specific locations to [LOCATION]');
  if (detectedTypes.includes('name')) statementParts.push('Replace personal names with [PERSON]');
  if (detectedTypes.includes('address')) statementParts.push('Replace physical addresses with [ADDRESS]');
  
  return {
    type: 'behavioral',
    domain: 'ai/privacy',
    statement: statementParts.join('. ') + '. Always apply these transformations before sending prompts to inference providers.',
    rationale: `Privacy protection based on detected PII in: ${context}`,
    tags: ['privacy', 'pii', 'sanitization', ...detectedTypes],
    episodic: { confidence: 9, emotional_weight: 8, trigger_context: context }
  };
}

export function containsPII(text: string): boolean {
  for (const { pattern } of PII_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

export function getPIIStats(text: string): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const { type, pattern } of PII_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) stats[type] = (stats[type] || 0) + matches.length;
  }
  return stats;
}
