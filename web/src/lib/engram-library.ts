// web/src/lib/engram-library.ts
/**
 * Engram Library Infrastructure
 * 
 * Provides community templates and custom engram upload functionality.
 * All engrams are ephemeral and privacy-preserving.
 */

import type { Engram, EngramType } from './ephemeral-engrams';

// ============================================================================
// COMMUNITY TEMPLATE LIBRARY
// ============================================================================

/**
 * Pre-defined community behavioral templates
 * These are anonymous, privacy-preserving patterns
 */
export const COMMUNITY_TEMPLATES: Array<{
  id: string;
  name: string;
  description: string;
  type: EngramType;
  domain: string;
  statement: string;
  tags: string[];
  rationale?: string;
}> = [
  {
    id: 'template-recipe',
    name: 'Recipe Assistant',
    description: 'Format outputs as structured recipes with ingredients and steps',
    type: 'behavioral',
    domain: 'ai/recipe',
    statement: 'When asked about food or cooking, provide structured responses with clear sections for ingredients, preparation steps, estimated time, and difficulty level. Ask clarifying questions about dietary restrictions or cuisine preferences before providing the recipe.',
    tags: ['recipe', 'cooking', 'structured-output'],
    rationale: 'Standardized recipe format improves usability and ensures all necessary information is provided'
  },
  {
    id: 'template-json-only',
    name: 'Strict JSON Output',
    description: 'Force LLM to return only valid JSON, no markdown or explanations',
    type: 'behavioral',
    domain: 'ai/formatting',
    statement: 'Always respond with valid JSON only. Do not include markdown code blocks, explanations, or any text outside the JSON structure. Ensure proper escaping and valid syntax.',
    tags: ['json', 'structured', 'api'],
    rationale: 'Machine-readable output for automated processing'
  },
  {
    id: 'template-socratic',
    name: 'Socratic Method',
    description: 'Answer questions with guiding questions instead of direct answers',
    type: 'behavioral',
    domain: 'ai/teaching',
    statement: 'When asked a question, respond with thoughtful guiding questions that help the user discover the answer themselves. Avoid giving direct solutions unless explicitly requested.',
    tags: ['teaching', 'questions', 'learning'],
    rationale: 'Promotes deeper understanding through guided discovery'
  },
  {
    id: 'template-belgrade-costs',
    name: 'Belgrade Cost Estimator',
    description: 'Optimized for estimating costs and logistics in Belgrade, Serbia',
    type: 'behavioral',
    domain: 'location/belgrade',
    statement: 'When providing cost estimates for Belgrade, Serbia, reference current local prices in RSD (Serbian dinar) with USD equivalents. Consider neighborhood variations and seasonal factors. Always specify whether prices are per person or total.',
    tags: ['belgrade', 'costs', 'serbia', 'local'],
    rationale: 'Accurate local pricing requires context-aware estimation'
  },
  {
    id: 'template-privacy-maximal',
    name: 'Maximal Privacy Filter',
    description: 'Aggressively remove all PII before sending to provider',
    type: 'behavioral',
    domain: 'ai/privacy',
    statement: 'Before processing any request, remove or generalize all personally identifiable information including names, specific addresses, phone numbers, email addresses, and unique identifiers. Replace with generic terms like "user" or "location".',
    tags: ['privacy', 'pii', 'sanitization'],
    rationale: 'Privacy-first approach prevents data leakage to inference providers'
  },
  {
    id: 'template-code-review',
    name: 'Code Review Assistant',
    description: 'Provide structured code feedback with security and best practices',
    type: 'behavioral',
    domain: 'ai/development',
    statement: 'When reviewing code, structure feedback into: 1) Security issues (critical), 2) Best practices violations, 3) Performance concerns, 4) Style suggestions. Provide concrete code examples for each issue.',
    tags: ['code', 'review', 'security'],
    rationale: 'Structured code review ensures comprehensive coverage'
  }
];

/**
 * Get a community template by ID
 */
export function getCommunityTemplate(id: string): Engram | null {
  const template = COMMUNITY_TEMPLATES.find(t => t.id === id);
  if (!template) return null;
  
  // Convert template to engram format (without session binding)
  return {
    id: template.id,
    version: 2,
    status: 'active',
    type: template.type,
    scope: 'community:template',
    statement: template.statement,
    rationale: template.rationale,
    tags: template.tags,
    domain: template.domain,
    // No session binding yet - will be added when stored
  } as Engram;
}

/**
 * Get all community template IDs
 */
export function getCommunityTemplateIds(): string[] {
  return COMMUNITY_TEMPLATES.map(t => t.id);
}

// ============================================================================
// ENGRAM UPLOAD/IMPORT
// ============================================================================

/**
 * Parse and validate uploaded engram YAML/JSON
 * Returns parsed engram or error message
 */
export async function parseUploadedEngram(
  content: string,
  format: 'yaml' | 'json' = 'yaml'
): Promise<{ engram?: Partial<Engram>; error?: string }> {
  try {
    let parsed: Partial<Engram>;
    
    if (format === 'json') {
      parsed = JSON.parse(content);
    } else {
      // Simple YAML parser (for basic structures)
      // In production, use a proper YAML library like js-yaml
      parsed = parseSimpleYAML(content);
    }
    
    // Validate required fields
    if (!parsed.type) {
      return { error: 'Missing required field: type' };
    }
    
    if (!parsed.statement) {
      return { error: 'Missing required field: statement' };
    }
    
    // Check statement length
    const wordCount = parsed.statement.trim().split(/\s+/).length;
    if (wordCount < 25 || wordCount > 60) {
      return { 
        error: `Statement must be 25-60 words (got ${wordCount})` 
      };
    }
    
    // Ensure tags array exists
    if (!parsed.tags) {
      parsed.tags = [];
    }
    
    return { engram: parsed };
  } catch (err) {
    return { 
      error: `Parse error: ${err instanceof Error ? err.message : 'Unknown error'}` 
    };
  }
}

/**
 * Simple YAML parser for basic engram structures
 * For production, replace with js-yaml library
 */
function parseSimpleYAML(yaml: string): Partial<Engram> {
  const result: Record<string, any> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;
  let multilineBuffer: string[] = [];
  
  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;
    
    // Check for array item
    const arrayMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayMatch && currentArray) {
      currentArray.push(arrayMatch[1].replace(/^["']|["']$/g, ''));
      continue;
    }
    
    // Check for key: value
    const kvMatch = line.match(/^([\w_]+):\s*(.*)$/);
    if (kvMatch) {
      // Save previous multiline value
      if (currentKey && multilineBuffer.length > 0) {
        result[currentKey] = multilineBuffer.join('\n').trim();
        multilineBuffer = [];
      }
      
      const [, key, value] = kvMatch;
      currentKey = key;
      
      // Check if value is empty (start of multiline or array)
      if (!value.trim()) {
        // Check next line to determine type
        const nextLine = lines[lines.indexOf(line) + 1];
        if (nextLine && nextLine.trim().startsWith('-')) {
          currentArray = [];
          result[key] = currentArray;
        } else {
          // Multiline string
          multilineBuffer = [];
        }
      } else {
        // Simple value
        currentArray = null;
        result[key] = value.replace(/^["']|["']$/g, '');
      }
    } else if (currentKey && multilineBuffer) {
      // Continuation of multiline
      multilineBuffer.push(line.trim());
    }
  }
  
  // Save final multiline value
  if (currentKey && multilineBuffer.length > 0) {
    result[currentKey] = multilineBuffer.join('\n').trim();
  }
  
  return result as Partial<Engram>;
}

/**
 * Create engram from uploaded content
 * Validates and prepares for storage
 */
export async function createCustomEngram(
  template: Partial<Engram>,
  customScope?: string
): Promise<Partial<Engram>> {
  return {
    type: template.type || 'behavioral',
    statement: template.statement!,
    rationale: template.rationale,
    tags: template.tags || [],
    domain: template.domain || 'custom',
    scope: customScope || 'user:custom',
    entities: template.entities,
    episodic: template.episodic,
    contraindications: template.contraindications
  };
}

// ============================================================================
// ENGRAM PREVIEW
// ============================================================================

/**
 * Generate preview text showing what transformations will be applied
 */
export function generateEngramPreview(engram: Partial<Engram>): string {
  const lines: string[] = [];
  
  lines.push(`Type: ${engram.type}`);
  lines.push(`Domain: ${engram.domain || 'general'}`);
  lines.push('');
  lines.push('Behavior:');
  lines.push(`  ${engram.statement}`);
  
  if (engram.rationale) {
    lines.push('');
    lines.push(`Why: ${engram.rationale}`);
  }
  
  if (engram.contraindications && engram.contraindications.length > 0) {
    lines.push('');
    lines.push('Do not apply when:');
    engram.contraindications.forEach(c => lines.push(`  - ${c}`));
  }
  
  if (engram.tags && engram.tags.length > 0) {
    lines.push('');
    lines.push(`Tags: ${engram.tags.join(', ')}`);
  }
  
  return lines.join('\n');
}

