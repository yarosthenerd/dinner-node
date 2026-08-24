/**
 * Strictly Ephemeral, Session-Bound Engram Storage
 * 
 * Implements privacy-preserving engram storage using sessionStorage.
 * Engrams are cryptographically bound to jobId and auto-wiped on session end.
 * 
 * Spec: https://plur.ai/spec.html (v2.1)
 */


export type EngramType = 
  | 'behavioral'
  | 'terminological'
  | 'procedural'
  | 'architectural';

export type EngramStatus = 
  | 'active'
  | 'candidate'
  | 'dormant'
  | 'retired';

export type EntityType = 
  | 'person' | 'organization' | 'technology' | 'concept'
  | 'project' | 'tool' | 'place' | 'event' | 'standard' | 'other';

export interface Entity {
  name: string;
  type: EntityType;
  uri?: string;
}

export interface Engram {
  id: string;
  version: number;
  status: EngramStatus;
  type: EngramType;
  scope: string;
  statement: string;
  rationale?: string;
  tags: string[];
  domain?: string;
  contraindications?: string[];
  entities?: Entity[];
  temporal?: {
    learned_at: string;
  };
  episodic?: {
    emotional_weight?: number;
    confidence?: number;
    trigger_context?: string;
  };
  _sessionBinding: {
    jobId: string;
    sessionNonce: string;
    createdAt: number;
    expiresAt?: number;
  };
}

const STORAGE_KEY_PREFIX = 'dn_engram_';
const SESSION_NONCE_KEY = 'dn_session_nonce';
const JOB_BINDING_KEY = 'dn_job_binding';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function generateSecureNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSessionBinding(jobId: string, nonce: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${jobId}:${nonce}:${Date.now()}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifySessionBinding(engram: Engram, currentJobId: string, currentNonce: string): Promise<boolean> {
  if (engram._sessionBinding.jobId !== currentJobId) return false;
  if (engram._sessionBinding.sessionNonce !== currentNonce) return false;
  if (engram._sessionBinding.expiresAt && Date.now() > engram._sessionBinding.expiresAt) return false;
  return true;
}

function generateEngramId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const unique = Math.random().toString(36).slice(2, 5);
  return `ENG-${year}-${month}${day}-${unique}`;
}

export function getSessionNonce(): string {
  let nonce = sessionStorage.getItem(SESSION_NONCE_KEY);
  if (!nonce) {
    nonce = generateSecureNonce();
    sessionStorage.setItem(SESSION_NONCE_KEY, nonce);
  }
  return nonce;
}

export function getCurrentJobBinding(): { jobId: string; nonce: string } | null {
  const binding = sessionStorage.getItem(JOB_BINDING_KEY);
  if (!binding) return null;
  try {
    return JSON.parse(binding);
  } catch {
    return null;
  }
}

export async function setJobBinding(jobId: string): Promise<void> {
  const nonce = getSessionNonce();
  sessionStorage.setItem(JOB_BINDING_KEY, JSON.stringify({
    jobId,
    nonce,
    boundAt: Date.now()
  }));
}

export function clearJobBinding(): void {
  sessionStorage.removeItem(JOB_BINDING_KEY);
  clearAllEngrams();
}

export async function storeEngram(engramData: Omit<Engram, 'id' | '_sessionBinding'>): Promise<Engram> {
  const currentBinding = getCurrentJobBinding();
  if (!currentBinding) {
    throw new Error('No active job binding. Call setJobBinding() first.');
  }
  
  const sessionNonce = getSessionNonce();
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
  
  const isValid = await verifySessionBinding(engram, currentBinding.jobId, sessionNonce);
  if (!isValid) {
    throw new Error('Failed to create valid session binding');
  }
  
  const storageKey = `${STORAGE_KEY_PREFIX}${engram.id}`;
  sessionStorage.setItem(storageKey, JSON.stringify(engram));
  scheduleCleanup();
  return engram;
}

export async function getEngram(id: string): Promise<Engram | null> {
  const storageKey = `${STORAGE_KEY_PREFIX}${id}`;
  const stored = sessionStorage.getItem(storageKey);
  if (!stored) return null;
  
  try {
    const engram: Engram = JSON.parse(stored);
    const currentBinding = getCurrentJobBinding();
    if (!currentBinding) return null;
    
    const isValid = await verifySessionBinding(engram, currentBinding.jobId, getSessionNonce());
    if (!isValid) {
      sessionStorage.removeItem(storageKey);
      return null;
    }
    return engram;
  } catch {
    return null;
  }
}

export async function getAllEngrams(): Promise<Engram[]> {
  const currentBinding = getCurrentJobBinding();
  if (!currentBinding) return [];
  
  const engrams: Engram[] = [];
  const nonce = getSessionNonce();
  
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key || !key.startsWith(STORAGE_KEY_PREFIX)) continue;
    
    try {
      const engram: Engram = JSON.parse(sessionStorage.getItem(key)!);
      const isValid = await verifySessionBinding(engram, currentBinding.jobId, nonce);
      if (isValid) {
        engrams.push(engram);
      } else {
        sessionStorage.removeItem(key);
      }
    } catch {
      sessionStorage.removeItem(key);
    }
  }
  return engrams;
}

export function deleteEngram(id: string): boolean {
  const storageKey = `${STORAGE_KEY_PREFIX}${id}`;
  const exists = sessionStorage.getItem(storageKey) !== null;
  sessionStorage.removeItem(storageKey);
  return exists;
}

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

let cleanupScheduled = false;

function scheduleCleanup(): void {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  setTimeout(async () => {
    await runCleanup();
    cleanupScheduled = false;
  }, CLEANUP_INTERVAL_MS);
}

async function runCleanup(): Promise<void> {
  const currentBinding = getCurrentJobBinding();
  const nonce = getSessionNonce();
  const now = Date.now();
  
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key || !key.startsWith(STORAGE_KEY_PREFIX)) continue;
    
    try {
      const engram: Engram = JSON.parse(sessionStorage.getItem(key)!);
      if (engram._sessionBinding.expiresAt && now > engram._sessionBinding.expiresAt) {
        sessionStorage.removeItem(key);
        continue;
      }
      if (currentBinding && engram._sessionBinding.jobId !== currentBinding.jobId) {
        sessionStorage.removeItem(key);
        continue;
      }
      if (engram._sessionBinding.sessionNonce !== nonce) {
        sessionStorage.removeItem(key);
        continue;
      }
    } catch {
      sessionStorage.removeItem(key);
    }
  }
}

export function initEphemeralEngrams(): void {
  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  console.log('[DinnerNode] Ephemeral engram system initialized');
}

export async function refreshEngramTTL(engramId: string, additionalMs: number = DEFAULT_TTL_MS): Promise<boolean> {
  const engram = await getEngram(engramId);
  if (!engram) return false;
  
  engram._sessionBinding.expiresAt = Date.now() + additionalMs;
  const storageKey = `${STORAGE_KEY_PREFIX}${engramId}`;
  sessionStorage.setItem(storageKey, JSON.stringify(engram));
  return true;
}

export function validateEngram(engram: Partial<Engram>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!engram.type) {
    errors.push('Engram type is required');
  } else if (!['behavioral', 'terminological', 'procedural', 'architectural'].includes(engram.type)) {
    errors.push(`Invalid engram type: ${engram.type}`);
  }
  
  if (!engram.statement) {
    errors.push('Statement is required');
  } else {
    const wordCount = engram.statement.trim().split(/\s+/).length;
    if (wordCount < 25) errors.push(`Statement too short: ${wordCount} words (min 25)`);
    else if (wordCount > 60) errors.push(`Statement too long: ${wordCount} words (max 60)`);
  }
  
  if (!engram.scope) errors.push('Scope is required');
  
  if (engram.episodic) {
    if (engram.episodic.emotional_weight !== undefined && (engram.episodic.emotional_weight < 1 || engram.episodic.emotional_weight > 10)) {
      errors.push('Emotional weight must be between 1 and 10');
    }
    if (engram.episodic.confidence !== undefined && (engram.episodic.confidence < 1 || engram.episodic.confidence > 10)) {
      errors.push('Confidence must be between 1 and 10');
    }
  }
  
  return { valid: errors.length === 0, errors };
}
