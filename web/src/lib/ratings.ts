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
import { estimateGas } from '../lib';

/// Monad's base fee spikes to thousands of gwei and the chain charges
/// gas_limit rather than gas_used, so an uncapped write during a spike can
/// commit several MON. Every other browser write already carried this cap;
/// these two did not, and they are the ones the guest now pays from their own
/// wallet rather than from a burner the house funded. Same value as MAX_FEE in
/// web/src/App.tsx and the daemons.
const MAX_FEE = 2000000000000n;

export const RATINGS_ABI = parseAbi([
  'function join(uint256 jobId, uint256 identityCommitment)',
  'function rate(address provider, uint256 rating, (uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof)',
  'function allCommitments() view returns (uint256[])',
  'function memberCount() view returns (uint256)',
  'function joinedWithJob(uint256) view returns (bool)',
  'function ratingSum(address) view returns (uint256)',
  'function ratingCount(address) view returns (uint256)',
  'function averageRating(address) view returns (uint256)',
  'function node() view returns (address)',
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
/**
 * Read a stored identity back, in either of the two formats this key has held.
 *
 * The legacy format is what `privateKey.toString()` produced: `privateKey` is a
 * Uint8Array, so that is a comma separated list of bytes rather than the key.
 * `new Identity(s)` treats a string as a SEED and derives a key from it, so the
 * value written on the first page load never reproduced the identity that was
 * used on that load. It did reproduce the same derived identity on every load
 * after it, which is why the defect looked like "the first join is wasted"
 * rather than like an identity that changed constantly.
 *
 * So the legacy branch must keep deriving, not switch to importing. Anyone who
 * already joined the group did so as the derived identity, and reading their
 * stored value any other way would take their membership away. The two formats
 * are told apart by shape: `export()` is base64 and a byte list has commas.
 */
function fromStored(stored: string): Identity {
  return stored.includes(',') ? new Identity(stored) : Identity.import(stored);
}

export function loadIdentity(): Identity {
  try {
    const stored = localStorage.getItem(IDENTITY_KEY);
    if (stored) return fromStored(stored);
  } catch {
    // Private mode, or storage disabled. A fresh identity still works for this
    // page load; it just cannot rate twice from the same browser.
  }
  const id = new Identity();
  // `export()` round-trips through `Identity.import`. `privateKey.toString()`
  // did not, and a guest who joined the group on their first page load lost
  // that membership on their next one, along with the paid job they spent to
  // get it.
  try { localStorage.setItem(IDENTITY_KEY, id.export()); } catch {}
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

/// The registry this ratings contract checks jobs against, or null when it
/// cannot be read. `node` is immutable, so every registry redeploy strands the
/// ratings contract on the old one. That happened on 2026-09-03 and was found
/// on 2026-09-22: every join from the site checked the job id against a
/// registry that no longer held it, and reverted. The widget compares this
/// with the registry the site uses and stays out of the way when they differ.
export async function boundRegistry(pub: any): Promise<`0x${string}` | null> {
  try {
    return await pub.readContract({ address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'node' });
  } catch {
    return null;
  }
}

/// Join the group with a job you paid for. The contract enforces that the job
/// is yours, closed, paid and unused; this only has to send it.
///
/// The limit is estimated, not fixed. Monad charges the limit, so the fixed
/// 400,000 this sent before cost about 0.04 MON on every join, and on a join
/// the contract refuses it cost that for a revert. `estimateGas` throws on a
/// revert instead, so a refused join costs nothing.
export async function joinWithJob(pub: any, wallet: any, account: `0x${string}`, jobId: bigint, identity: Identity) {
  const args = [jobId, identity.commitment] as const;
  const gas = await estimateGas({
    pub, address: RATINGS_ADDRESS!, abi: RATINGS_ABI, fn: 'join', args, account, fallback: 400000n,
  });
  return wallet.writeContract({
    address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'join',
    args, gas, maxFeePerGas: MAX_FEE,
  });
}

/// Rate a provider. The rating travels as the proof message and the provider
/// as the scope, so neither can be altered between here and the contract, and
/// the scope also means one identity rates each provider exactly once.
///
/// Proof generation pulls the Groth16 artifacts for the tree depth on first
/// use, so the first rating in a browser session is slow.
export async function rateProvider(
  pub: any, wallet: any, account: `0x${string}`, provider: `0x${string}`, rating: number, identity: Identity,
) {
  if (rating < 1 || rating > 5) throw new Error('rating must be 1 to 5');

  const { members, joined } = await readGroup(pub, identity.commitment);
  if (!joined) throw new Error('this browser has not joined the group with a paid job yet');

  const group = new Group(members);
  const scope = BigInt(provider);
  const proof = await generateProof(identity, group, BigInt(rating), scope);

  const args = [provider, BigInt(rating), {
    merkleTreeDepth: BigInt(proof.merkleTreeDepth),
    merkleTreeRoot: BigInt(proof.merkleTreeRoot),
    nullifier: BigInt(proof.nullifier),
    message: BigInt(proof.message),
    scope: BigInt(proof.scope),
    points: proof.points.map((p: string | bigint) => BigInt(p)) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
  }] as const;
  // Estimated for the same reason as join. A second rating of the same
  // provider reverts on the nullifier, and at the fixed 800,000 this sent
  // before, finding that out cost the guest about 0.08 MON.
  const gas = await estimateGas({
    pub, address: RATINGS_ADDRESS!, abi: RATINGS_ABI, fn: 'rate', args, account, fallback: 800000n,
  });
  return wallet.writeContract({
    address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'rate',
    args, gas, maxFeePerGas: MAX_FEE,
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
