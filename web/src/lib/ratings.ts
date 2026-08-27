// Anonymous provider ratings, proved with Semaphore and verified on chain.
//
// What this gives a guest: they can rate a provider they actually paid, and
// the rating cannot be traced back to which of their jobs it came from. What
// it does not give them is anonymity in a small group. Semaphore's own
// documentation is blunt about it, and so is this module: with fewer than
// three members there is nothing to hide among, and `groupTooSmall` exists so
// the UI can say that rather than imply a protection that is not there.
import { Group } from '@semaphore-protocol/group';
import { Identity } from '@semaphore-protocol/identity';
import { generateProof } from '@semaphore-protocol/proof';
import { parseAbi } from 'viem';

export const RATINGS_ABI = parseAbi([
  'function join(uint256 jobId, uint256 identityCommitment)',
  'function rate(address provider, uint256 rating, (uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof)',
  'function allCommitments() view returns (uint256[])',
  'function memberCount() view returns (uint256)',
  'function joinedWithJob(uint256) view returns (bool)',
  'function ratingSum(address) view returns (uint256)',
  'function ratingCount(address) view returns (uint256)',
  'function averageRating(address) view returns (uint256)',
]);

/// Address of the deployed DinnerRatings, or null when the feature is not
/// configured. Every export below degrades to a no-op rather than throwing, so
/// a build without the variable set behaves as if ratings do not exist.
export const RATINGS_ADDRESS =
  (import.meta.env.VITE_RATINGS_ADDRESS as `0x${string}` | undefined) ?? null;

export const ratingsEnabled = () => RATINGS_ADDRESS !== null;

/// Below this the group hides nobody. Semaphore says one or two members cannot
/// be considered anonymous; three is the first size where the claim is not
/// outright false, and it is still weak.
export const MIN_ANONYMITY_SET = 3;

const IDENTITY_KEY = 'dn_zk_identity';

/// The guest's Semaphore identity, created on first use and kept in
/// localStorage. It is deliberately separate from `dn_pk`, the wallet key: the
/// whole point is that the rating is not linked to the wallet, so reusing the
/// wallet key as the identity seed would hand that linkage to anyone who ever
/// sees both.
export function loadIdentity(): Identity {
  try {
    const stored = localStorage.getItem(IDENTITY_KEY);
    if (stored) return new Identity(stored);
  } catch {
    // Private mode, or storage disabled. A fresh identity still works for this
    // page load; it just cannot rate twice from the same browser.
  }
  const id = new Identity();
  try { localStorage.setItem(IDENTITY_KEY, id.privateKey.toString()); } catch {}
  return id;
}

export type GroupState = { members: bigint[]; joined: boolean; tooSmall: boolean };

/// Read the group from chain state rather than from events. The Monad testnet
/// RPC caps eth_getLogs at a 100 block range, so a client cannot reconstruct
/// membership from `Joined` events; DinnerRatings keeps the list readable for
/// exactly this reason.
export async function readGroup(pub: any, commitment: bigint): Promise<GroupState> {
  const members = (await pub.readContract({
    address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'allCommitments',
  })) as readonly bigint[];
  return {
    members: [...members],
    joined: members.includes(commitment),
    tooSmall: members.length < MIN_ANONYMITY_SET,
  };
}

/// Join the group with a job you paid for. The contract enforces that the job
/// is yours, closed, paid and unused; this only has to send it.
export async function joinWithJob(wallet: any, jobId: bigint, identity: Identity) {
  return wallet.writeContract({
    address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'join',
    args: [jobId, identity.commitment], gas: 400000n,
  });
}

/// Rate a provider. The rating travels as the proof message and the provider
/// as the scope, so neither can be altered between here and the contract, and
/// the scope also means one identity rates each provider exactly once.
///
/// Proof generation pulls the Groth16 artifacts for the tree depth on first
/// use, so the first rating in a browser session is slow.
export async function rateProvider(
  pub: any, wallet: any, provider: `0x${string}`, rating: number, identity: Identity,
) {
  if (rating < 1 || rating > 5) throw new Error('rating must be 1 to 5');

  const { members, joined } = await readGroup(pub, identity.commitment);
  if (!joined) throw new Error('this browser has not joined the group with a paid job yet');

  const group = new Group(members);
  const scope = BigInt(provider);
  const proof = await generateProof(identity, group, BigInt(rating), scope);

  return wallet.writeContract({
    address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'rate',
    args: [provider, BigInt(rating), {
      merkleTreeDepth: BigInt(proof.merkleTreeDepth),
      merkleTreeRoot: BigInt(proof.merkleTreeRoot),
      nullifier: BigInt(proof.nullifier),
      message: BigInt(proof.message),
      scope: BigInt(proof.scope),
      points: proof.points.map((p: string | bigint) => BigInt(p)) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    }],
    gas: 800000n,
  });
}

/// Average rating in stars, or null when the provider has none.
export async function readAverage(pub: any, provider: `0x${string}`): Promise<number | null> {
  const [avg, count] = await Promise.all([
    pub.readContract({ address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'averageRating', args: [provider] }),
    pub.readContract({ address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'ratingCount', args: [provider] }),
  ]);
  return (count as bigint) === 0n ? null : Number(avg as bigint) / 100;
}
