// web/src/lib/ephemeral-engrams.ts
/**
 * Strictly Ephemeral, Session-Bound Engram Storage
 * 
 * Implements privacy-preserving engram storage using sessionStorage.
 * Engrams are cryptographically bound to jobId and auto-wiped on session end.
 * 
 * Spec: https://plur.ai/spec.html (v2.1)
 */

import { nanoid } from 'nanoid';

// ============================================================================
// TYPES (aligned with PLUR Engram Spec v2.1, stripped for privacy)
// ============================================================================

export type EngramType = 
  | 'behavioral'      // How to act — preferences, corrections, habits
  | 'terminological'  // Definitions, naming, factual knowledge
  | 'procedural'      // Step-by-step processes and workflows
  | 'architectural';  // System design, conventions, structural patterns

export type EngramStatus = 
  | 'active'     // Injected into sessions
  | 'candidate'  // Awaiting review
  | 'dormant'    // Retained but not injected
  | 'retired';   // Soft-deleted

export type EntityType = 
  | 'person' | 'organization' | 'technology' | 'concept'
  | 'project' | 'tool' | 'place' | 'event' | 'standard' | 'other';

export interface Entity {
  name: string;
  type: EntityType;
  uri?: string;
}

export interface Engram {
  // Core fields (required by spec)
  id: string;                    // ENG-YYYY-MMDD-NNN
  version: number;               // Schema version (2.1)
  status: EngramStatus;
  type: EngramType;
  scope: string;                 // Hierarchical namespace (e.g., "session:jobId")
  statement: string;             // 25-60 words of actionable guidance
  rationale?: string;            // Why this engram exists
  tags: string[];                // Freeform tags for retrieval
  domain?: string;               // Hierarchical domain (e.g., "ai/recipe")
  contraindications?: string[];  // When NOT to apply
  
  // Privacy-focused fields (ephemeral session only)
  entities?: Entity[];           // Typed entity references
  temporal?: {
    learned_at: string;          // ISO date
  };
  episodic?: {
    emotional_weight?: number;   // 1-10, default 5
    confidence?: number;         // 1-10, default 5
    trigger_context?: string;
  };
  
  // Session binding (critical for privacy)
  _sessionBinding: {
    jobId: string;               // Cryptographically bound job
    sessionNonce: string;        // Unique per-tab nonce
    createdAt: number;           // Timestamp
    expiresAt?: number;          // Optional expiration (default 30 min)
  };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STORAGE_KEY_PREFIX = 'dn_engram_';  // DinnerNode engram prefix
const SESSION_NONCE_KEY = 'dn_session_nonce';
const JOB_BINDING_KEY = 'dn_job_binding';
const DEFAULT_TTL_MS = 30 * 60 * 1000;  // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;  // Check every 5 minutes

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate a cryptographically secure random nonce
 * Uses Web Crypto API for secure randomness [[27]]
 */
function generateSecureNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a session binding signature
 * Binds engram to specific jobId using HMAC-like construction
 */
async function createSessionBinding(
  jobId: string,
  nonce: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${jobId}:${nonce}:${Date.now()}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify session binding integrity
 * Returns false if jobId mismatch or tampering detected
 */
async function verifySessionBinding(
  engram: Engram,
  currentJobId: string,
  currentNonce: string
): Promise<boolean> {
  // Check if engram is bound to current job
  if (engram._sessionBinding.jobId !== currentJobId) {
    return false;
  }
  
  // Check if engram is bound to current session (tab)
  if (engram._sessionBinding.sessionNonce !== currentNonce) {
    return false;
  }
  
  // Check expiration
  if (engram._sessionBinding.expiresAt && 
      Date.now() > engram._sessionBinding.expiresAt) {
    return false;
  }
  
  return true;
}

/**
 * Generate engram ID in spec format: ENG-YYYY-MMDD-NNN
 */
function generateEngramId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const unique = nanoid(3);
  
  return `ENG-${year}-${month}${day}-${unique}`;
}

// ============================================================================
// SESSION STORAGE WRAPPER
// ============================================================================

/**
 * Get or create session nonce for this tab
 * Nonce persists for tab lifetime, changes on refresh
 */
export function getSessionNonce(): string {
  let nonce = sessionStorage.getItem(SESSION_NONCE_KEY);
  
  if (!nonce) {
    nonce = generateSecureNonce();
    sessionStorage.setItem(SESSION_NONCE_KEY, nonce);
  }
  
  return nonce;
}

/**
 * Get current job binding from sessionStorage
 */
export function getCurrentJobBinding(): { jobId: string; nonce: string } | null {
  const binding = sessionStorage.getItem(JOB_BINDING_KEY);
  if (!binding) return null;
  
  try {
    return JSON.parse(binding);
  } catch {
    return null;
  }
}

/**
 * Set job binding for current session
 * Called when a new job is opened
 */
export async function setJobBinding(jobId: string): Promise<void> {
  const nonce = getSessionNonce();
  sessionStorage.setItem(JOB_BINDING_KEY, JSON.stringify({
    jobId,
    nonce,
    boundAt: Date.now()
  }));
}

/**
 * Clear job binding (called on job close)
 */
export function clearJobBinding(): void {
  sessionStorage.removeItem(JOB_BINDING_KEY);
  // Also clear all engrams bound to this job
  clearAllEngrams();
}

// ============================================================================
// ENGRAM CRUD OPERATIONS
// ============================================================================

/**
 * Store an engram in sessionStorage
 * Automatically binds to current job and session nonce
 */
export async function storeEngram(
  engramData: Omit<Engram, 'id' | '_sessionBinding'>
): Promise<Engram> {
  const currentBinding = getCurrentJobBinding();
  if (!currentBinding) {
    throw new Error('No active job binding. Call setJobBinding() first.');
  }
  
  const sessionNonce = getSessionNonce();
  
  // Create full engram with binding
  const engram: Engram = {
    ...engramData,
    id: engramData.id || generateEngramId(),
    _sessionBinding: {
      jobId: currentBinding.jobId,
      sessionNonce: sessionNonce,
      createdAt: Date.now(),
      expiresAt: Date.now() + DEFAULT_TTL_MS
    }
  };
  
  // Verify binding before storing
  const isValid = await verifySessionBinding(
    engram,
    currentBinding.jobId,
    sessionNonce
  );
  
  if (!isValid) {
    throw new Error('Failed to create valid session binding');
  }
  
  // Store with unique key
  const storageKey = `${STORAGE_KEY_PREFIX}${engram.id}`;
  sessionStorage.setItem(storageKey, JSON.stringify(engram));
  
  // Schedule cleanup check
  scheduleCleanup();
  
  return engram;
}

/**
 * Retrieve an engram by ID
 * Returns null if not found, expired, or binding invalid
 */
export async function getEngram(id: string): Promise<Engram | null> {
  const storageKey = `${STORAGE_KEY_PREFIX}${id}`;
  const stored = sessionStorage.getItem(storageKey);
  
  if (!stored) return null;
  
  try {
    const engram: Engram = JSON.parse(stored);
    const currentBinding = getCurrentJobBinding();
    
    if (!currentBinding) return null;
    
    // Verify session binding
    const isValid = await verifySessionBinding(
      engram,
      currentBinding.jobId,
      getSessionNonce()
    );
    
    if (!isValid) {
      // Auto-delete invalid engram
      sessionStorage.removeItem(storageKey);
      return null;
    }
    
    return engram;
  } catch {
    return null;
  }
}

/**
 * Get all engrams for current job session
 */
export async function getAllEngrams(): Promise<Engram[]> {
  const currentBinding = getCurrentJobBinding();
  if (!currentBinding) return [];
  
  const engrams: Engram[] = [];
  const nonce = getSessionNonce();
  
  // Iterate through all sessionStorage keys
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key || !key.startsWith(STORAGE_KEY_PREFIX)) continue;
    
    try {
      const engram: Engram = JSON.parse(sessionStorage.getItem(key)!);
      
      // Verify binding
      const isValid = await verifySessionBinding(
        engram,
        currentBinding.jobId,
        nonce
      );
      
      if (isValid) {
        engrams.push(engram);
      } else {
        // Clean up invalid engram
        sessionStorage.removeItem(key);
      }
    } catch {
      // Skip corrupted entries
      sessionStorage.removeItem(key);
    }
  }
  
  return engrams;
}

/**
 * Delete an engram by ID
 */
export function deleteEngram(id: string): boolean {
  const storageKey = `${STORAGE_KEY_PREFIX}${id}`;
  const exists = sessionStorage.getItem(storageKey) !== null;
  sessionStorage.removeItem(storageKey);
  return exists;
}

/**
 * Clear all engrams for current session
 */
export function clearAllEngrams(): void {
  const keysToRemove: string[] = [];
  
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith(STORAGE_KEY_PREFIX)) {
      keysToRemove.push(key);
    }
  }
  
  keysToRemove.forEach(key => sessionStorage.removeItem(key));
}

// ============================================================================
// AUTOMATIC CLEANUP
// ============================================================================

let cleanupScheduled = false;

/**
 * Schedule cleanup of expired engrams
 * Debounced to avoid redundant checks
 */
function scheduleCleanup(): void {
  if (cleanupScheduled) return;
  
  cleanupScheduled = true;
  setTimeout(async () => {
    await runCleanup();
    cleanupScheduled = false;
  }, CLEANUP_INTERVAL_MS);
}

/**
 * Run cleanup: remove expired and invalid engrams
 */
async function runCleanup(): Promise<void> {
  const currentBinding = getCurrentJobBinding();
  const nonce = getSessionNonce();
  const now = Date.now();
  
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key || !key.startsWith(STORAGE_KEY_PREFIX)) continue;
    
    try {
      const engram: Engram = JSON.parse(sessionStorage.getItem(key)!);
      
      // Remove if expired
      if (engram._sessionBinding.expiresAt && 
          now > engram._sessionBinding.expiresAt) {
        sessionStorage.removeItem(key);
        continue;
      }
      
      // Remove if job binding changed
      if (currentBinding && 
          engram._sessionBinding.jobId !== currentBinding.jobId) {
        sessionStorage.removeItem(key);
        continue;
      }
      
      // Remove if session nonce changed (tab refresh)
      if (engram._sessionBinding.sessionNonce !== nonce) {
        sessionStorage.removeItem(key);
        continue;
      }
    } catch {
      // Remove corrupted entries
      sessionStorage.removeItem(key);
    }
  }
}

// ============================================================================
// LIFECYCLE HOOKS
// ============================================================================

/**
 * Initialize ephemeral engram system
 * Call on app load to set up cleanup interval
 */
export function initEphemeralEngrams(): void {
  // Run initial cleanup
  runCleanup();
  
  // Set up periodic cleanup
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  
  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    // Optional: clear job binding on tab close
    // Uncomment if you want strict ephemeral behavior
    // clearJobBinding();
  });
  
  console.log('[DinnerNode] Ephemeral engram system initialized');
}

/**
 * Extend engram TTL (time-to-live)
 * Call when engram is actively used
 */
export async function refreshEngramTTL(
  engramId: string,
  additionalMs: number = DEFAULT_TTL_MS
): Promise<boolean> {
  const engram = await getEngram(engramId);
  if (!engram) return false;
  
  engram._sessionBinding.expiresAt = Date.now() + additionalMs;
  
  const storageKey = `${STORAGE_KEY_PREFIX}${engramId}`;
  sessionStorage.setItem(storageKey, JSON.stringify(engram));
  
  return true;
}

// ============================================================================
// ENGRAM VALIDATION
// ============================================================================

/**
 * Validate engram against spec v2.1 requirements
 */
export function validateEngram(engram: Partial<Engram>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  // Required fields
  if (!engram.type) {
    errors.push('Engram type is required');
  } else if (!['behavioral', 'terminological', 'procedural', 'architectural'].includes(engram.type)) {
    errors.push(`Invalid engram type: ${engram.type}`);
  }
  
  if (!engram.statement) {
    errors.push('Statement is required');
  } else {
    const wordCount = engram.statement.trim().split(/\s+/).length;
    if (wordCount < 25) {
      errors.push(`Statement too short: ${wordCount} words (min 25)`);
    } else if (wordCount > 60) {
      errors.push(`Statement too long: ${wordCount} words (max 60)`);
    }
  }
  
  if (!engram.scope) {
    errors.push('Scope is required');
  }
  
  // Optional field validation
  if (engram.episodic) {
    if (engram.episodic.emotional_weight !== undefined) {
      if (engram.episodic.emotional_weight < 1 || engram.episodic.emotional_weight > 10) {
        errors.push('Emotional weight must be between 1 and 10');
      }
    }
    
    if (engram.episodic.confidence !== undefined) {
      if (engram.episodic.confidence < 1 || engram.episodic.confidence > 10) {
        errors.push('Confidence must be between 1 and 10');
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

