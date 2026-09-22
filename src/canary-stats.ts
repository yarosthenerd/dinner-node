/**
 * The arithmetic behind the status page, kept apart from the daemon that
 * gathers it so it can be tested without opening a port or spending MON.
 *
 * Everything here is deliberately dumb: nearest-rank percentiles over the
 * samples actually held, no interpolation, no smoothing, no decay. A status
 * page whose numbers cannot be re-derived by hand from the sample file is
 * worse than no status page, because it invites trust it has not earned.
 */

export type ProbeKind = 'liveness' | 'answer';

export type Probe = {
  /** ms since epoch, when the probe STARTED. */
  at: number;
  address: string;
  kind: ProbeKind;
  ok: boolean;
  /**
   * Response time for a liveness probe, time to first token for an answer
   * probe. Null when the probe failed, because a timeout is not a latency and
   * averaging it in is how a dead node comes to look merely slow.
   */
  ms: number | null;
  /** Short reason, present only on failure. */
  error?: string;
};

export type Window = { label: string; ms: number };

export const WINDOWS: Window[] = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

/**
 * Nearest-rank percentile: the smallest value at or above which p percent of
 * the samples fall. With one sample every percentile is that sample, and p99
 * of 12 samples is the largest of them. Both are correct and both are why the
 * sample count is published beside every percentile.
 */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export type WindowSummary = {
  window: string;
  samples: number;
  ok: number;
  failed: number;
  /** null rather than 1 when nothing was sampled: no data is not 100% up. */
  availability: number | null;
  errorRate: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  /** Longest run of consecutive failures, in probes and in wall-clock ms. */
  worstStreak: { probes: number; ms: number };
  errors: Record<string, number>;
};

export function summarize(probes: Probe[], window: Window, now: number): WindowSummary {
  const since = now - window.ms;
  // Sorted by time, because the streak below is a statement about order and
  // the caller's file is append-ordered rather than guaranteed sorted.
  const inWindow = probes.filter(p => p.at >= since && p.at <= now).sort((a, b) => a.at - b.at);
  const ok = inWindow.filter(p => p.ok);
  const failed = inWindow.filter(p => !p.ok);

  const lat = ok.map(p => p.ms).filter((m): m is number => typeof m === 'number').sort((a, b) => a - b);

  let streak = 0, streakStart = 0, worst = { probes: 0, ms: 0 };
  for (const p of inWindow) {
    if (!p.ok) {
      if (streak === 0) streakStart = p.at;
      streak += 1;
      // Wall clock from the first failure to this one. A single failed probe
      // is a streak of one probe and zero ms, which is honest: one probe says
      // nothing about how long the node was gone.
      const span = p.at - streakStart;
      if (streak > worst.probes) worst = { probes: streak, ms: span };
      else if (streak === worst.probes && span > worst.ms) worst = { probes: streak, ms: span };
    } else {
      streak = 0;
    }
  }

  const errors: Record<string, number> = {};
  for (const p of failed) {
    const k = p.error ?? 'unknown';
    errors[k] = (errors[k] ?? 0) + 1;
  }

  return {
    window: window.label,
    samples: inWindow.length,
    ok: ok.length,
    failed: failed.length,
    availability: inWindow.length ? ok.length / inWindow.length : null,
    errorRate: inWindow.length ? failed.length / inWindow.length : null,
    p50: percentile(lat, 50),
    p90: percentile(lat, 90),
    p99: percentile(lat, 99),
    worstStreak: worst,
    errors,
  };
}

export type ProviderStatus = {
  address: string;
  model: string | null;
  url: string | null;
  lastProbe: number | null;
  lastOk: number | null;
  lastError: { at: number; error: string } | null;
  liveness: WindowSummary[];
  answer: WindowSummary[];
};

export function statusFor(
  address: string,
  meta: { model?: string | null; url?: string | null },
  probes: Probe[],
  now: number,
  windows: Window[] = WINDOWS,
): ProviderStatus {
  const mine = probes.filter(p => p.address.toLowerCase() === address.toLowerCase());
  const live = mine.filter(p => p.kind === 'liveness');
  const ans = mine.filter(p => p.kind === 'answer');
  const lastFail = [...mine].filter(p => !p.ok).sort((a, b) => b.at - a.at)[0];
  return {
    address,
    model: meta.model ?? null,
    url: meta.url ?? null,
    lastProbe: mine.length ? Math.max(...mine.map(p => p.at)) : null,
    lastOk: mine.some(p => p.ok) ? Math.max(...mine.filter(p => p.ok).map(p => p.at)) : null,
    lastError: lastFail ? { at: lastFail.at, error: lastFail.error ?? 'unknown' } : null,
    liveness: windows.map(w => summarize(live, w, now)),
    answer: windows.map(w => summarize(ans, w, now)),
  };
}

/**
 * Keep the newest `max` probes and drop the rest. The file is the whole
 * database, so it needs a ceiling that does not depend on anyone remembering
 * to rotate it.
 */
export function trim(probes: Probe[], max: number): Probe[] {
  if (probes.length <= max) return probes;
  return [...probes].sort((a, b) => a.at - b.at).slice(probes.length - max);
}
