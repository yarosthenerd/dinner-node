// Regression test for SNAPSHOT.md section 7 item 5. `getAllEngrams` and
// `runCleanup` removed entries from sessionStorage while walking it by index.
// sessionStorage is indexed live, so removing key i shifts every later key down
// and the loop's i++ steps over the next one. The result was stale engrams
// surviving AND valid ones being dropped from the returned set, which
// under-sanitizes the prompt.
//
// The test is written against the observable symptom rather than the loop, so
// it stays valid if the implementation is rewritten again.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllEngrams,
  getAllEngrams,
  setJobBinding,
  storeEngram,
} from '../ephemeral-engrams';

// jsdom's sessionStorage is a live-indexed Storage, which is the property under
// test, so no stub is used.

const base = {
  version: 1,
  status: 'active' as const,
  type: 'behavioral' as const,
  scope: 'test',
  tags: ['sanitization'],
  domain: 'ai/privacy',
};

describe('item 5: removal while iterating by index skipped entries', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns every valid engram when an invalid one sits among them', async () => {
    await setJobBinding('job-1');

    // Interleave so that whichever entry is removed, a valid one follows it.
    for (let i = 0; i < 6; i++) {
      await storeEngram({ ...base, id: `valid-${i}`, statement: `rule ${i}` });
    }

    // Three entries bound to a different job. getAllEngrams must remove them
    // and still return all six valid ones. Under the index-walk bug the
    // removals shifted the survivors past the cursor and some were dropped.
    for (let i = 0; i < 3; i++) {
      sessionStorage.setItem(`dn_engram_stale-${i}`, JSON.stringify({
        ...base, id: `stale-${i}`, statement: 'stale',
        _sessionBinding: { jobId: 'job-0', sessionNonce: 'other', createdAt: Date.now() },
      }));
    }

    const found = await getAllEngrams();
    expect(found.map(e => e.id).sort()).toEqual(
      ['valid-0', 'valid-1', 'valid-2', 'valid-3', 'valid-4', 'valid-5']
    );

    // And the stale ones are actually gone, not merely skipped.
    const remaining = Object.keys(sessionStorage).filter(k => k.startsWith('dn_engram_'));
    expect(remaining.some(k => k.includes('stale'))).toBe(false);
  });

  it('clearAllEngrams leaves nothing behind', async () => {
    await setJobBinding('job-2');
    for (let i = 0; i < 5; i++) {
      await storeEngram({ ...base, id: `e-${i}`, statement: `rule ${i}` });
    }
    clearAllEngrams();
    expect(Object.keys(sessionStorage).filter(k => k.startsWith('dn_engram_'))).toEqual([]);
    expect(await getAllEngrams()).toEqual([]);
  });
});

describe('unreachable engrams are removed, not merely hidden', () => {
  beforeEach(() => { sessionStorage.clear(); });

  const engramKeys = () => Object.keys(sessionStorage).filter(k => k.startsWith('dn_engram_'));

  it('clears storage when the job binding is gone', async () => {
    await setJobBinding('job-3');
    await storeEngram({ ...base, id: 'e1', statement: 'rule' });
    sessionStorage.removeItem('dn_job_binding');

    expect(await getAllEngrams()).toEqual([]);
    // The point of the test: not just that nothing is returned, but that
    // nothing is left behind.
    expect(engramKeys()).toEqual([]);
  });

  it('clears every engram, not just the first, when the binding is gone', async () => {
    // The single-engram case above passes even against a loop that removes one
    // key and steps over the next, which is the bug this whole file exists
    // for. Five entries is what distinguishes the two.
    await setJobBinding('job-4');
    for (let i = 0; i < 5; i++) await storeEngram({ ...base, id: `many-${i}`, statement: `rule ${i}` });
    expect(engramKeys()).toHaveLength(5);

    sessionStorage.removeItem('dn_job_binding');
    expect(await getAllEngrams()).toEqual([]);
    expect(engramKeys()).toEqual([]);
  });

  it('clears storage when the binding is unreadable rather than absent', async () => {
    // A truncated or hand-edited value is not the same as a missing one, and
    // "no usable binding" has to mean the same thing in both cases.
    await setJobBinding('job-5');
    await storeEngram({ ...base, id: 'e2', statement: 'rule' });
    sessionStorage.setItem('dn_job_binding', '{not json');

    expect(await getAllEngrams()).toEqual([]);
    expect(engramKeys()).toEqual([]);
  });

  it('drops an engram once its TTL has passed, and keeps the ones that have not', async () => {
    // The TTL is a promise to the guest that prompt-shaping text does not
    // outlive the session, so an expired engram must not come back from
    // getAllEngrams even while the binding is still valid.
    await setJobBinding('job-6');
    await storeEngram({ ...base, id: 'fresh', statement: 'fresh rule' });
    await storeEngram({ ...base, id: 'stale', statement: 'stale rule' });

    const key = engramKeys().find(k => k.includes('stale'))!;
    const stored = JSON.parse(sessionStorage.getItem(key)!);
    stored._sessionBinding.expiresAt = Date.now() - 1000;
    sessionStorage.setItem(key, JSON.stringify(stored));

    const found = await getAllEngrams();
    expect(found.map(e => e.id)).toEqual(['fresh']);
    // Removed, not merely filtered out of the answer.
    expect(engramKeys().some(k => k.includes('stale'))).toBe(false);
    expect(engramKeys().some(k => k.includes('fresh'))).toBe(true);
  });
});
