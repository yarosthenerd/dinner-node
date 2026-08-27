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
 * Reading through these two functions makes that a single edit rather than a
 * hunt. When v2 is deployed, the bodies below switch to `getJob` and
 * `getProvider`, which return a named struct and cannot drift at all, and no
 * call site changes.
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
};

export type Provider = {
  model: string;
  hw: string;
  ratePerMillion: bigint;
  earned: bigint;
  tokensServed: bigint;
  jobs: bigint;
  active: boolean;
};

/** @param address the DinnerNode contract, not the provider. */
export async function readJob(address: `0x${string}`, jobId: bigint): Promise<Job> {
  const j = await pub.readContract({ address, abi: ABI, functionName: 'jobs', args: [jobId] }) as unknown as readonly unknown[];
  return {
    requester: j[0] as `0x${string}`,
    provider: j[1] as `0x${string}`,
    escrow: j[2] as bigint,
    paid: j[3] as bigint,
    tokens: j[4] as bigint,
    open: j[5] as boolean,
  };
}

export async function readProvider(address: `0x${string}`, provider: `0x${string}`): Promise<Provider> {
  const p = await pub.readContract({ address, abi: ABI, functionName: 'providers', args: [provider] }) as unknown as readonly unknown[];
  return {
    model: String(p[0]),
    hw: String(p[1]),
    ratePerMillion: p[2] as bigint,
    earned: p[3] as bigint,
    tokensServed: p[4] as bigint,
    jobs: p[5] as bigint,
    active: p[6] as boolean,
  };
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
