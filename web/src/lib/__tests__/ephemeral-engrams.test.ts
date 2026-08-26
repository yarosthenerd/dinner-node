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

  it('clears storage when the job binding is gone', async () => {
    await setJobBinding('job-3');
    await storeEngram({ ...base, id: 'e1', statement: 'rule' });
    sessionStorage.removeItem('dn_job_binding');

    expect(await getAllEngrams()).toEqual([]);
    // The point of the test: not just that nothing is returned, but that
    // nothing is left behind.
    expect(Object.keys(sessionStorage).filter(k => k.startsWith('dn_engram_'))).toEqual([]);
  });
});
