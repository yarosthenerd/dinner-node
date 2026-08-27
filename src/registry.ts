/**
 * The only place in the node that knows what position a field sits at.
 *
 * viem decodes these reads positionally whether or not the ABI names the
 * outputs, so every call site that wrote `job[5]` was carrying a copy of the
 * struct layout. That is not a style problem. DinnerNodeV2 moves `open` from
 * index 5 to index 9 and `active` from 6 to 7, and the value that lands at the
 * old index is a non-zero rate, which reads as truthy: every liveness check in
 * the project would have gone on passing, silently, on closed jobs and
 * deregistered providers.
 *
 * Reading through these two functions makes that a single edit rather than a
 * hunt. When v2 is deployed, the bodies below switch to `getJob` and
 * `getProvider`, which return a named struct and cannot drift at all, and no
 * call site changes.
 *
 * web/src/lib/registry.ts is the same file for the browser build. The two are
 * duplicated rather than shared because the daemon and the web app are
 * separate builds; if you change one, change the other.
 */
import { ABI, ADDR, pub } from './chain';

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

export async function readJob(jobId: bigint): Promise<Job> {
  const j = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [jobId] }) as unknown as readonly unknown[];
  return {
    requester: j[0] as `0x${string}`,
    provider: j[1] as `0x${string}`,
    escrow: j[2] as bigint,
    paid: j[3] as bigint,
    tokens: j[4] as bigint,
    open: j[5] as boolean,
  };
}

export async function readProvider(address: `0x${string}`): Promise<Provider> {
  const p = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'providers', args: [address] }) as unknown as readonly unknown[];
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

/** Whether this job is open AND belongs to `me` as the provider. The check
 *  every request handler makes, in one place so it cannot be half-written. */
export const isMine = (j: Job, me: string) =>
  j.open && j.provider.toLowerCase() === me.toLowerCase();

/** What is left to spend on a job. Not `escrow` alone, which is what a caller
 *  reaching for a single field tends to grab. */
export const remaining = (j: Job) => j.escrow - j.paid;
