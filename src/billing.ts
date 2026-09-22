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

/**
 * How many tokens an escrow can still pay for, at a rate.
 *
 * Integer division, so it rounds DOWN: a remainder that cannot buy a whole
 * token buys none. That direction is the safe one. Rounding up would let a
 * stream produce a token the escrow cannot cover, and the contract caps
 * payment at the escrow rather than refusing it, so the overshoot is not a
 * revert the operator would notice. It is unpaid work.
 *
 * A rate of zero means this node is not charging, and an escrow that cannot
 * run out imposes no ceiling at all.
 */
export function affordableTokens(remainingWei: bigint, ratePerMillion: bigint): number {
  if (ratePerMillion <= 0n) return Infinity;
  if (remainingWei <= 0n) return 0;
  const n = (remainingWei * 1_000_000n) / ratePerMillion;
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
}

/**
 * The token ceiling this node should serve a job to, which is NOT the same as
 * what the job can afford.
 *
 * A job served to the last wei of its escrow is a job no other node will take
 * over, because `refuseTakeover` requires the escrow to still cover the
 * handover's gas several times before a standby will front it. So a stream
 * that spends everything has, at the moment it finishes, also removed its own
 * failover. Measured against the live pair on 2026-09-10, job#14: node 1
 * served 2,562 tokens against an escrow good for 1,666, `paid` hit the escrow
 * exactly, and the handover was then refused with "job cannot cover the
 * handover" because nothing was left to pay for it.
 *
 * `reserveWei` is what stays unspent so the failover stays possible. It is a
 * policy, not a constant: an operator who does not want the reserve sets it to
 * zero and gets the old behaviour, a job that serves until the money is gone.
 */
export function serveCeiling(c: {
  remainingWei: bigint;
  ratePerMillion: bigint;
  reserveWei?: bigint;
}): number {
  const spendable = c.remainingWei - (c.reserveWei ?? 0n);
  if (spendable <= 0n) return 0;
  return affordableTokens(spendable, c.ratePerMillion);
}

/**
 * Whether a stream has produced as many billed tokens as it may, counting
 * reasoning. One rule for both paths through the generation loop, because the
 * loop used to test it on the visible path only: a model still reasoning ran
 * straight past the ceiling, and the first visible token then found the stream
 * far over it. Job#16, 2026-09-21: ceiling 1,156, served 2,835 reasoning
 * tokens and 1 visible, and the contract clamped the payment, so the node did
 * the excess for nothing.
 */
export function reachedCeiling(visible: number, reasoning: number, cap: number): boolean {
  return visible + reasoning >= cap;
}
