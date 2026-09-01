// Taking over a job on a signed authorisation, from the standby node's side.
//
// `reassignWithAuth` lets the INCOMING provider carry the guest's signature to
// the chain, which is what makes an unattended failover possible: the guest
// signed once when they ordered, and nobody has to be awake when the first
// node dies. The cost of that is borne here. This node pays the gas for a
// transaction that benefits a guest it has never served, on a job it does not
// yet hold, so every reason to refuse has to be found BEFORE the send.
//
// Three classes of refusal, and they are different:
//
//   1. It would revert. Expired, already spent, not open, already ours, or a
//      signature that does not recover to the requester. Sending these burns
//      gas to learn something readable for free.
//   2. It is not worth taking. A job whose remaining escrow cannot cover the
//      gas of the handover plus some real work is a job that costs this node
//      money to accept. Without this check a guest opens a dust job, signs an
//      authorisation, and walks every registered provider through a paid
//      transaction for nothing.
//   3. We cannot serve it. Checked by the caller, not here.
//
// The signature is verified locally rather than trusted, using the same typed
// data the contract rebuilds. A node that skipped this would still be safe on
// chain, and would pay for the privilege of finding out.
import { recoverTypedDataAddress } from 'viem';

export const ANY_PROVIDER = '0x0000000000000000000000000000000000000000' as const;

export type ReassignAuth = {
  jobId: bigint;
  newProvider: `0x${string}`;
  maxReassigns: bigint;
  deadline: bigint;
  signature: `0x${string}`;
};

/// Must match DinnerNodeV2.REASSIGN_AUTH_TYPEHASH and the browser's copy in
/// web/src/lib/reassign-auth.ts. Pinned on all three sides by parity tests.
export const REASSIGN_AUTH_TYPES = {
  ReassignAuth: [
    { name: 'jobId', type: 'uint256' },
    { name: 'newProvider', type: 'address' },
    { name: 'maxReassigns', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export function authDomain(chainId: number, verifyingContract: `0x${string}`) {
  return { name: 'DinnerNode', version: '2', chainId, verifyingContract } as const;
}

/// Parse the wire form. Returns a string on refusal rather than throwing,
/// because every one of these becomes a 400 with a reason the client can act
/// on, and an exception here would read as a node fault instead of a bad ask.
export function parseAuth(raw: any): ReassignAuth | string {
  if (!raw || typeof raw !== 'object') return 'no authorisation';
  const { jobId, newProvider, maxReassigns, deadline, signature } = raw;
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return 'malformed signature';
  if (typeof newProvider !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(newProvider)) return 'malformed newProvider';
  let ids: bigint, mx: bigint, dl: bigint;
  try {
    ids = BigInt(jobId); mx = BigInt(maxReassigns); dl = BigInt(deadline);
  } catch { return 'malformed authorisation numbers'; }
  if (ids <= 0n) return 'malformed jobId';
  // uint64 on the contract side. A value that does not fit is a client bug,
  // and sending it would revert on ABI encoding rather than on any rule.
  if (dl <= 0n || dl > 2n ** 64n - 1n) return 'malformed deadline';
  if (mx <= 0n) return 'authorisation allows no handovers';
  return { jobId: ids, newProvider: newProvider as `0x${string}`, maxReassigns: mx, deadline: dl, signature: signature as `0x${string}` };
}

/// Does this signature actually authorise US to take this job?
///
/// The contract has to try both digests, because all it receives is the
/// provider taking the job and it cannot tell which form was signed. Here we
/// are told: `auth.newProvider` is the value the guest signed over, so there
/// is exactly one digest to check and no guessing.
export async function authorises(
  auth: ReassignAuth,
  requester: `0x${string}`,
  me: `0x${string}`,
  chainId: number,
  registry: `0x${string}`,
): Promise<boolean> {
  if (auth.newProvider !== ANY_PROVIDER && auth.newProvider.toLowerCase() !== me.toLowerCase()) return false;
  try {
    const signer = await recoverTypedDataAddress({
      domain: authDomain(chainId, registry),
      types: REASSIGN_AUTH_TYPES,
      primaryType: 'ReassignAuth',
      message: {
        jobId: auth.jobId, newProvider: auth.newProvider,
        maxReassigns: auth.maxReassigns, deadline: auth.deadline,
      },
      signature: auth.signature,
    });
    return signer.toLowerCase() === requester.toLowerCase();
  } catch {
    // A signature that will not recover is simply not a match. The contract
    // reverts on the same input; there is nothing to report beyond "no".
    return false;
  }
}

export type TakeoverCheck = {
  job: { open: boolean; provider: `0x${string}`; requester: `0x${string}`; escrow: bigint; paid: bigint };
  auth: ReassignAuth;
  me: `0x${string}`;
  used: bigint;
  nowSeconds: number;
  /// What the handover transaction is expected to cost this node, in wei.
  gasCostWei: bigint;
  /// How many times that cost the job must still be able to pay before this
  /// node is willing to front it. One would mean breaking even on a perfect
  /// job; the default is higher because a takeover that earns exactly its own
  /// gas back is not a reason to take a stranger's work.
  minMargin: bigint;
};

/// Every reason to refuse, in the order that costs least to discover.
/// Returns null when the handover should be attempted.
export function refuseTakeover(c: TakeoverCheck): string | null {
  if (!c.job.open) return 'job is closed';
  if (c.job.provider.toLowerCase() === c.me.toLowerCase()) return 'job is already ours';
  if (c.auth.deadline <= BigInt(c.nowSeconds)) return 'authorisation expired';
  if (c.used >= c.auth.maxReassigns) return 'authorisation spent';
  if (c.auth.newProvider !== ANY_PROVIDER
      && c.auth.newProvider.toLowerCase() !== c.me.toLowerCase()) return 'authorisation names another provider';
  const left = c.job.escrow - c.job.paid;
  if (left <= c.gasCostWei * c.minMargin) return 'job cannot cover the handover';
  return null;
}
