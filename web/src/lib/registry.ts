/**
 * The only place in the web app that knows what position a field sits at.
 *
 * viem decodes these reads positionally whether or not the ABI names the
 * outputs, so every call site that wrote `j[5]` was carrying a copy of the
 * struct layout. That is not a style problem. DinnerNodeV2 moves `open` from
 * index 5 to index 9 and `active` from 6 to 7, and the value that lands at the
 * old index is a non-zero rate, which reads as truthy: every liveness check in
 * the app would have gone on passing, silently, on closed jobs and
 * deregistered providers.
 *
 * Reading through these two functions made that a single edit rather than a
 * hunt, and 2026-08-28 is when it was made: the bodies below now call `getJob`
 * and `getProvider` on DinnerNodeV2, which return a named struct and cannot
 * drift at all. No call site changed. The extra v2 fields are carried on the
 * returned types so a caller can read them, and every field the v1 shape had
 * still means what it meant.
 *
 * src/registry.ts is the same file for the node build. The two are duplicated
 * rather than shared because the daemon and the web app are separate builds;
 * if you change one, change the other.
 */
import { ABI, pub } from '../lib';

export type Job = {
  requester: `0x${string}`;
  provider: `0x${string}`;
  escrow: bigint;
  paid: bigint;
  tokens: bigint;
  open: boolean;
  /// v2. Locked at open, so a provider re-registering cannot reprice a job in
  /// flight.
  ratePerMillion: bigint;
  maxTokensPerSecond: bigint;
  openedAt: bigint;
  lastSettleAt: bigint;
  /// v2. When true, settle() refuses to pay for tokens with no published
  /// checkpoint behind them.
  requireCheckpoints: boolean;
};

export type Provider = {
  model: string;
  hw: string;
  ratePerMillion: bigint;
  earned: bigint;
  tokensServed: bigint;
  jobs: bigint;
  active: boolean;
  /// v2. The throughput this node claims; the per-settlement bound is derived
  /// from it and it is capped by MAX_TOKENS_PER_SECOND on chain.
  maxTokensPerSecond: bigint;
  /// v2. Reputation, arm's-length work only, never zeroed by withdraw().
  lifetimeEarned: bigint;
};

/** @param address the DinnerNode contract, not the provider. */
/** @param address the DinnerNode contract, not the provider. */
export async function readJob(address: `0x${string}`, jobId: bigint): Promise<Job> {
  const j = await pub.readContract({ address, abi: ABI, functionName: 'getJob', args: [jobId] }) as Job;
  return j;
}

export async function readProvider(address: `0x${string}`, provider: `0x${string}`): Promise<Provider> {
  const p = await pub.readContract({ address, abi: ABI, functionName: 'getProvider', args: [provider] }) as Provider;
  return p;
}

/** Is this job open, and is it this guest's, against this provider? The check
 *  the resume and release paths make, in one place so it cannot be
 *  half-written. */
export const isOursAndOpen = (j: Job, guest: string, provider?: string) =>
  j.open
  && j.requester.toLowerCase() === guest.toLowerCase()
  && (provider === undefined || j.provider.toLowerCase() === provider.toLowerCase());

/** What is left to spend on a job. Not `escrow` alone, which is what a caller
 *  reaching for a single field tends to grab. */
export const remaining = (j: Job) => j.escrow - j.paid;
