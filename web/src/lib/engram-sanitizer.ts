// web/src/lib/engram-sanitizer.ts
/**
 * Client-Side PII Sanitization Layer
 * 
 * Filters and generalizes personally identifiable information
 * before prompts are hashed or sent to providers.
 * 
 * Works with ephemeral engrams to enforce privacy policies.
 */

import type { Engram } from './ephemeral-engrams';

// ============================================================================
// PII DETECTION PATTERNS
// ============================================================================

/**
 * Regex patterns for detecting different types of PII
 * Ordered by specificity (most specific first)
 */
const PII_PATTERNS: Array<{
  type: string;
  pattern: RegExp;
  replacement: string;
  priority: number;  // Higher = process first
}> = [
  // Email addresses
  {
    type: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: '[EMAIL]',
    priority: 10
  },
  
  // Phone numbers (international format)
  {
    type: 'phone',
    pattern: /\+?[\d\s-]{10,}\b/g,
    replacement: '[PHONE]',
    priority: 10
  },
  
  // IPv4 addresses
  {
    type: 'ip',
    pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: '[IP_ADDRESS]',
    priority: 10
  },
  
  // URLs with potential personal data
  {
    type: 'url',
    pattern: /\bhttps?:\/\/[^\s/$.?#].[^\s]*\b/g,
    replacement: '[URL]',
    priority: 8
  },
  
  // Physical addresses (street patterns)
  {
    type: 'address',
    pattern: /\b\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln)\b/gi,
    replacement: '[ADDRESS]',
    priority: 7
  },
  
  // Names (capitalized words, 2-3 in sequence)
  {
    type: 'name',
    pattern: /\b[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
    replacement: '[PERSON]',
    priority: 5
  },
  
  // Specific locations (city names with context)
  {
    type: 'location',
    pattern: /\b(?:in|at|from|live(?:s)? in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/gi,
    replacement: '[LOCATION]',
    priority: 6
  },
  
  // ID numbers (various formats)
  {
    type: 'id_number',
    pattern: /\b(?:ID|SSN|Passport|License)[:\s]?\s*[\d-]{8,}\b/gi,
    replacement: '[ID_NUMBER]',
    priority: 10
  },
  
  // Credit card numbers
  {
    type: 'credit_card',
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    replacement: '[CREDIT_CARD]',
    priority: 10
  },
  
  // API keys and secrets
  {
    type: 'api_key',
    pattern: /\b(?:api[_-]?key|secret|token|password)[:\s]?\s*['"]?[A-Za-z0-9_-]{20,}['"]?\b/gi,
    replacement: '[SECRET]',
    priority: 10
  }
];

// ============================================================================
// SANITIZATION ENGINE
// ============================================================================

/**
 * Sanitize a prompt string by removing/generalizing PII
 * Returns sanitized text and list of detected PII types
 */
export function sanitizePrompt(
  prompt: string,
  options: {
    strictness: 'minimal' | 'balanced' | 'maximal';
    preserveContext?: boolean;
  } = { strictness: 'balanced' }
): {
  sanitized: string;
  detected: string[];
  originalLength: number;
  sanitizedLength: number;
} {
  const detected = new Set<string>();
  let sanitized = prompt;
  
  // Sort patterns by priority (highest first)
  const sortedPatterns = [...PII_PATTERNS].sort((a, b) => b.priority - a.priority);
  
  for (const { type, pattern, replacement } of sortedPatterns) {
    const matches = sanitized.match(pattern);
    if (matches && matches.length > 0) {
      detected.add(type);
      
      // Apply filtering based on strictness
      if (options.strictness === 'maximal') {
        // Replace all matches
        sanitized = sanitized.replace(pattern, replacement);
      } else if (options.strictness === 'balanced') {
        // Replace but preserve some context
        if (options.preserveContext) {
          sanitized = sanitized.replace(pattern, (match) => {
            // Keep first and last char for very long matches
            if (match.length > 20) {
              return `${match[0]}...${replacement}...${match[match.length - 1]}`;
            }
            return replacement;
          });
        } else {
          sanitized = sanitized.replace(pattern, replacement);
        }
      } else {
        // Minimal: only replace high-priority PII
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

/**
 * Apply engram-based sanitization rules
 * Engrams can define custom PII patterns and generalization rules
 */
export function applyEngramSanitization(
  prompt: string,
  engrams: Engram[]
): {
  sanitized: string;
  rulesApplied: string[];
} {
  let sanitized = prompt;
  const rulesApplied = new Set<string>();
  
  for (const engram of engrams) {
    // Check if engram has sanitization rules
    if (engram.domain === 'ai/privacy' || engram.tags.includes('sanitization')) {
      // Extract custom patterns from engram statement
      const customRules = extractSanitizationRules(engram);
      
      for (const rule of customRules) {
        if (sanitized.match(rule.pattern)) {
          sanitized = sanitized.replace(rule.pattern, rule.replacement);
          rulesApplied.add(engram.id);
        }
      }
    }
    
    // Apply contraindications (skip certain sanitizations)
    if (engram.contraindications) {
      for (const contra of engram.contraindications) {
        if (sanitized.toLowerCase().includes(contra.toLowerCase())) {
          // This context should not be sanitized
          rulesApplied.delete(engram.id);
        }
      }
    }
  }
  
  return {
    sanitized,
    rulesApplied: Array.from(rulesApplied)
  };
}

/**
 * Extract sanitization rules from engram statement
 * Parses engram text to find pattern definitions
 */
function extractSanitizationRules(engram: Engram): Array<{
  pattern: RegExp;
  replacement: string;
}> {
  const rules: Array<{ pattern: RegExp; replacement: string }> = [];
  
  // Look for "replace X with Y" patterns in statement
  const replacePattern = /replace\s+(.+?)\s+with\s+(.+)/gi;
  let match;
  
  while ((match = replacePattern.exec(engram.statement)) !== null) {
    const [, target, replacement] = match;
    try {
      rules.push({
        pattern: new RegExp(target, 'gi'),
        replacement: replacement.trim()
      });
    } catch {
      // Invalid regex, skip
    }
  }
  
  // Default rule for privacy engrams: generalize specifics
  if (rules.length === 0 && engram.domain === 'ai/privacy') {
    rules.push({
      pattern: /\b(?:I am|I'm|my name is)\s+([A-Z][a-z]+)\b/gi,
      replacement: '[USER]'
    });
    
    rules.push({
      pattern: /\b(?:in|at|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/gi,
      replacement: '[LOCATION]'
    });
  }
  
  return rules;
}

/**
 * Main sanitization pipeline
 * Combines standard PII detection with engram-based rules
 */
export function sanitizePromptWithEngrams(
  prompt: string,
  engrams: Engram[],
  strictness: 'minimal' | 'balanced' | 'maximal' = 'balanced'
): {
  sanitized: string;
  detected: string[];
  engramRulesApplied: string[];
  summary: {
    originalLength: number;
    sanitizedLength: number;
    redactionCount: number;
  };
} {
  // Step 1: Apply standard PII detection
  const standardResult = sanitizePrompt(prompt, { strictness });
  
  // Step 2: Apply engram-based rules
  const engramResult = applyEngramSanitization(standardResult.sanitized, engrams);
  
  // Count redactions
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

// ============================================================================
// ENGRAM GENERATION FROM SANITIZATION
// ============================================================================

/**
 * Generate a privacy-focused engram from sanitization results
 * Creates a reusable rule based on detected PII patterns
 */
export function generatePrivacyEngram(
  detectedTypes: string[],
  context: string
): Partial<Engram> {
  const statementParts: string[] = [];
  
  if (detectedTypes.includes('email')) {
    statementParts.push('Replace email addresses with [EMAIL]');
  }
  
  if (detectedTypes.includes('phone')) {
    statementParts.push('Replace phone numbers with [PHONE]');
  }
  
  if (detectedTypes.includes('location')) {
    statementParts.push('Generalize specific locations to [LOCATION]');
  }
  
  if (detectedTypes.includes('name')) {
    statementParts.push('Replace personal names with [PERSON]');
  }
  
  if (detectedTypes.includes('address')) {
    statementParts.push('Replace physical addresses with [ADDRESS]');
  }
  
  return {
    type: 'behavioral',
    domain: 'ai/privacy',
    statement: statementParts.join('. ') + '. Always apply these transformations before sending prompts to inference providers.',
    rationale: `Privacy protection based on detected PII in: ${context}`,
    tags: ['privacy', 'pii', 'sanitization', ...detectedTypes],
    episodic: {
      confidence: 9,
      emotional_weight: 8,
      trigger_context: context
    }
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if text contains PII
 * Quick check without full sanitization
 */
export function containsPII(text: string): boolean {
  for (const { pattern } of PII_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Get PII detection statistics
 * Useful for privacy dashboard
 */
export function getPIIStats(text: string): Record<string, number> {
  const stats: Record<string, number> = {};
  
  for (const { type, pattern } of PII_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      stats[type] = (stats[type] || 0) + matches.length;
    }
  }
  
  return stats;
}

