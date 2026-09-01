// The signature that lets a job change providers while the guest is asleep.
//
// Why this exists. `reassign` on the registry requires
// `msg.sender == j.requester`, so every failover was a transaction the guest
// had to approve by hand. A node dying mid-answer at 3am left the answer
// stopped until a human confirmed a wallet prompt, which defeats the session
// shape the whole product is built around: hold a context against one node,
// and survive that node going away.
//
// `reassignWithAuth` moves the guest's approval earlier instead of removing
// it. The guest signs one EIP-712 message when they order, which costs no gas
// and is not a transaction, and the INCOMING provider carries it to the chain
// at the moment of the handover. No key is delegated and nothing is
// custodial: the guest's own wallet is still the only thing that can
// authorise a handover of their job.
//
// What the guest is agreeing to, stated plainly because the UI has to say it:
// for `deadline`, up to `maxReassigns` times, any registered active provider
// may take over this one job. That is a liveness risk and not a money risk.
// Every payment bound survives a handover: the rate can only move down, the
// throughput ceiling can only move down, a provider that publishes no
// checkpoint is paid nothing, and nothing is ever paid that was not
// deposited.
import type { GuestWalletClient } from './wallet';

/// Must match DinnerNodeV2.REASSIGN_AUTH_TYPEHASH exactly. The parity test
/// pins one digest against the Solidity implementation; if either side
/// changes this, that test fails rather than every handover at 3am.
export const REASSIGN_AUTH_TYPES = {
  ReassignAuth: [
    { name: 'jobId', type: 'uint256' },
    { name: 'newProvider', type: 'address' },
    { name: 'maxReassigns', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const AUTH_DOMAIN_NAME = 'DinnerNode';
export const AUTH_DOMAIN_VERSION = '2';

/// The zero address means "any registered active provider", which is what the
/// client signs: at order time it does not yet know which standby will still
/// be alive when the first node dies.
export const ANY_PROVIDER = '0x0000000000000000000000000000000000000000' as const;

export type ReassignAuth = {
  jobId: bigint;
  newProvider: `0x${string}`;
  maxReassigns: bigint;
  deadline: bigint;
  signature: `0x${string}`;
};

export function authDomain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: AUTH_DOMAIN_NAME,
    version: AUTH_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

/// Two standbys is what the client tries, so two handovers is what it asks
/// for. Signing for more would be authorising a job to wander further than
/// the client would ever take it.
export const DEFAULT_MAX_REASSIGNS = 2n;

/// Long enough for an overnight session, short enough that a signature does
/// not outlive the reason it was given.
export const DEFAULT_AUTH_TTL_SECONDS = 12 * 60 * 60;

export async function signReassignAuth(
  wallet: GuestWalletClient,
  chainId: number,
  verifyingContract: `0x${string}`,
  jobId: bigint,
  opts?: { maxReassigns?: bigint; ttlSeconds?: number; newProvider?: `0x${string}` },
): Promise<ReassignAuth> {
  const maxReassigns = opts?.maxReassigns ?? DEFAULT_MAX_REASSIGNS;
  const newProvider = opts?.newProvider ?? ANY_PROVIDER;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts?.ttlSeconds ?? DEFAULT_AUTH_TTL_SECONDS));
  const signature = await wallet.signTypedData({
    account: wallet.account,
    domain: authDomain(chainId, verifyingContract),
    types: REASSIGN_AUTH_TYPES,
    primaryType: 'ReassignAuth',
    message: { jobId, newProvider, maxReassigns, deadline },
  });
  return { jobId, newProvider, maxReassigns, deadline, signature };
}

/// The wire form handed to a standby node. Strings rather than bigints,
/// because this crosses JSON.
export type ReassignAuthWire = {
  jobId: string;
  newProvider: `0x${string}`;
  maxReassigns: string;
  deadline: string;
  signature: `0x${string}`;
};

export function toWire(a: ReassignAuth): ReassignAuthWire {
  return {
    jobId: a.jobId.toString(),
    newProvider: a.newProvider,
    maxReassigns: a.maxReassigns.toString(),
    deadline: a.deadline.toString(),
    signature: a.signature,
  };
}

/// True while the authorisation could still be used. A client that holds an
/// expired one should fall back to asking the guest rather than handing a
/// standby something that will revert.
export function isLive(a: ReassignAuth, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return a.deadline > BigInt(nowSeconds);
}
