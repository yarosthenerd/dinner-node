/**
 * What a job owes, and what it does not.
 *
 * One rule, and it is an operator policy rather than an implementation detail:
 * a guest pays for output they received. Compute this node performed that
 * produced nothing usable is written off, not invoiced.
 *
 * That distinction needs two counters, not one. `delta` is billable and is what
 * the settle ticker charges for. `hold` is work in flight whose deliverability
 * is not decided yet, and nothing ever settles out of it. Tokens land in `hold`
 * first and move to `delta` only when the thing they produced is delivered.
 *
 * The streaming answer path does not need this: it bills a token in the same
 * breath as it writes that token to the guest, so what is billed is by
 * construction what was delivered, and a stream cut off halfway still delivered
 * the half it sent. Plans are where the gap is. Planning either yields a valid
 * plan or yields nothing at all, and a plan step that fails hands back no
 * output while having spent its whole ceiling. Job#75 charged 0.2736 MON for
 * planning that produced no plan, which is the case this file exists to stop.
 */

export type Ledger = {
  /** Billable: produced AND delivered. The settle ticker reads only this. */
  delta: number;
  /** Produced, not yet known to be deliverable. Never settled from here. */
  hold: number;
  /** When `delta` was last flushed, for the settle ticker's age trigger. */
  since: number;
};

export const newLedger = (now = Date.now()): Ledger => ({ delta: 0, hold: 0, since: now });

/** Count a produced token against work that has not been delivered yet. */
export function hold(l: Ledger, n = 1): void {
  if (n > 0) l.hold += n;
}

/**
 * Move held tokens into the billable counter, because what they produced
 * reached the guest. `n` omitted releases everything held.
 *
 * Capping at what is actually held is what makes this safe under a wave of
 * parallel steps: every step's tokens accrue to the same `hold`, each
 * completion releases its own count, and no completion can release more than
 * the pool contains even if a caller reports a stale or duplicated total.
 */
export function bill(l: Ledger, n?: number): number {
  const amount = n === undefined ? l.hold : Math.min(Math.max(0, n), l.hold);
  l.hold -= amount;
  l.delta += amount;
  return amount;
}

/**
 * Discard held tokens unbilled, because the work failed. Returns how many were
 * written off, which is worth logging: it is the one number that says how much
 * compute this node gave away.
 */
export function writeOff(l: Ledger): number {
  const n = l.hold;
  l.hold = 0;
  return n;
}

/** Take the billable tokens for a settlement, resetting the flush clock. */
export function flush(l: Ledger, now = Date.now()): number {
  const n = l.delta;
  l.delta = 0;
  l.since = now;
  return n;
}
