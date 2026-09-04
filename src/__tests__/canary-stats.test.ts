import { describe, expect, it } from 'vitest';
import { percentile, statusFor, summarize, trim, type Probe } from '../canary-stats';

const W = { label: '1h', ms: 60 * 60 * 1000 };
const NOW = 1_700_000_000_000;
const p = (over: Partial<Probe> & { at: number }): Probe => ({
  address: '0xaaa', kind: 'liveness', ok: true, ms: 100, ...over,
});

describe('percentile', () => {
  it('is null for no samples, because no data is not a latency', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('returns the only sample at every percentile', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('is nearest-rank, so p99 of ten samples is the largest', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 90)).toBe(9);
    expect(percentile(s, 99)).toBe(10);
  });

  it('does not interpolate', () => {
    // The p50 of these four is 2, not 2.5. Publishing a number no sample ever
    // took is exactly the invention this module refuses.
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });
});

describe('summarize', () => {
  it('reports null availability when nothing was sampled', () => {
    const s = summarize([], W, NOW);
    expect(s.samples).toBe(0);
    expect(s.availability).toBeNull();
    expect(s.errorRate).toBeNull();
  });

  it('ignores probes outside the window', () => {
    const s = summarize([
      p({ at: NOW - 2 * W.ms }),
      p({ at: NOW - 1000 }),
    ], W, NOW);
    expect(s.samples).toBe(1);
  });

  it('excludes failures from the latency percentiles', () => {
    // A timeout is not a slow response. Counting it as one makes a dead node
    // look merely sluggish, which is the whole failure this guards.
    const s = summarize([
      p({ at: NOW - 3000, ms: 10 }),
      p({ at: NOW - 2000, ok: false, ms: null, error: 'timeout' }),
      p({ at: NOW - 1000, ms: 20 }),
    ], W, NOW);
    expect(s.p50).toBe(10);
    expect(s.p99).toBe(20);
    expect(s.availability).toBeCloseTo(2 / 3);
    expect(s.errorRate).toBeCloseTo(1 / 3);
  });

  it('counts the longest consecutive failure streak, not the total', () => {
    const s = summarize([
      p({ at: NOW - 6000, ok: false, ms: null, error: 'x' }),
      p({ at: NOW - 5000 }),
      p({ at: NOW - 4000, ok: false, ms: null, error: 'x' }),
      p({ at: NOW - 3000, ok: false, ms: null, error: 'x' }),
      p({ at: NOW - 2000, ok: false, ms: null, error: 'x' }),
      p({ at: NOW - 1000 }),
    ], W, NOW);
    expect(s.failed).toBe(4);
    expect(s.worstStreak.probes).toBe(3);
    expect(s.worstStreak.ms).toBe(2000);
  });

  it('gives a single failure a zero-length streak', () => {
    const s = summarize([p({ at: NOW - 1000, ok: false, ms: null, error: 'x' })], W, NOW);
    expect(s.worstStreak).toEqual({ probes: 1, ms: 0 });
  });

  it('tallies errors by reason', () => {
    const s = summarize([
      p({ at: NOW - 3000, ok: false, ms: null, error: 'timeout' }),
      p({ at: NOW - 2000, ok: false, ms: null, error: 'timeout' }),
      p({ at: NOW - 1000, ok: false, ms: null, error: 'http 502' }),
    ], W, NOW);
    expect(s.errors).toEqual({ timeout: 2, 'http 502': 1 });
  });

  it('sorts before streaking, so an out-of-order file is still right', () => {
    const s = summarize([
      p({ at: NOW - 1000 }),
      p({ at: NOW - 3000, ok: false, ms: null, error: 'x' }),
      p({ at: NOW - 2000, ok: false, ms: null, error: 'x' }),
    ], W, NOW);
    expect(s.worstStreak).toEqual({ probes: 2, ms: 1000 });
  });
});

describe('statusFor', () => {
  const probes: Probe[] = [
    p({ at: NOW - 5000, address: '0xAAA' }),
    p({ at: NOW - 4000, address: '0xaaa', ok: false, ms: null, error: 'timeout' }),
    p({ at: NOW - 3000, address: '0xaaa', kind: 'answer', ms: 31_000 }),
    p({ at: NOW - 2000, address: '0xbbb' }),
  ];

  it('matches addresses case-insensitively', () => {
    const s = statusFor('0xAaA', {}, probes, NOW, [W]);
    expect(s.liveness[0].samples).toBe(2);
  });

  it('keeps answer probes out of the liveness numbers', () => {
    // A 31 second time to first token must not be averaged into a health
    // check that answers in 40ms, or the page reports a latency nobody has.
    const s = statusFor('0xaaa', {}, probes, NOW, [W]);
    expect(s.liveness[0].p50).toBe(100);
    expect(s.answer[0].samples).toBe(1);
    expect(s.answer[0].p50).toBe(31_000);
  });

  it('reports the last failure and the last success separately', () => {
    const s = statusFor('0xaaa', {}, probes, NOW, [W]);
    expect(s.lastError).toEqual({ at: NOW - 4000, error: 'timeout' });
    expect(s.lastOk).toBe(NOW - 3000);
    expect(s.lastProbe).toBe(NOW - 3000);
  });

  it('reports a provider never probed as unknown rather than as down', () => {
    const s = statusFor('0xccc', {}, probes, NOW, [W]);
    expect(s.lastProbe).toBeNull();
    expect(s.liveness[0].availability).toBeNull();
  });
});

describe('trim', () => {
  it('keeps the newest', () => {
    const many = Array.from({ length: 10 }, (_, i) => p({ at: NOW - i * 1000 }));
    const kept = trim(many, 3);
    expect(kept.length).toBe(3);
    expect(kept.map(x => x.at)).toEqual([NOW - 2000, NOW - 1000, NOW]);
  });

  it('is a no-op under the ceiling', () => {
    const few = [p({ at: NOW })];
    expect(trim(few, 10)).toBe(few);
  });
});
