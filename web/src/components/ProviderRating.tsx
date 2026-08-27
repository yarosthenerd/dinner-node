// Rate the provider you just paid, without revealing which job you were.
//
// Two constraints from the layers underneath shape this component:
//
//  1. `join` needs a CLOSED job, and a session job stays open until the
//     provider's idle timer closes it. So this scans stored session history
//     for an eligible job instead of assuming the most recent one qualifies.
//  2. A Semaphore group of one or two hides nobody. Rather than quietly
//     letting someone believe otherwise, the widget says so and still lets
//     them rate, because refusing to record the rating would be worse.
import { useCallback, useEffect, useState } from 'react';
import {
  MIN_ANONYMITY_SET, RATINGS_ABI, RATINGS_ADDRESS,
  joinWithJob, loadIdentity, rateProvider, readAverage, readGroup,
} from '../lib/ratings';

type Props = {
  pub: any;
  wallet: any;
  provider: `0x${string}`;
  nodeAbi: any;
  nodeAddress: `0x${string}`;
  jobIds: bigint[];
  guestAddress: `0x${string}`;
};

export default function ProviderRating({ pub, wallet, provider, nodeAbi, nodeAddress, jobIds, guestAddress }: Props) {
  const [identity] = useState(() => loadIdentity());
  const [members, setMembers] = useState<number | null>(null);
  const [joined, setJoined] = useState(false);
  const [eligible, setEligible] = useState<bigint | null>(null);
  const [average, setAverage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  /// A job can buy a membership when it is this guest's, closed, actually paid
  /// for, and has not already been spent on a membership. All four are read
  /// from chain state; none is inferred from what this browser remembers.
  const findEligible = useCallback(async () => {
    for (const id of jobIds) {
      try {
        const j = await pub.readContract({ address: nodeAddress, abi: nodeAbi, functionName: 'jobs', args: [id] }) as readonly any[];
        const [requester, jobProvider, , paid, , open] = j as unknown as [string, string, bigint, bigint, bigint, boolean];
        if (open) continue;
        if (paid === 0n) continue;
        if (requester.toLowerCase() !== guestAddress.toLowerCase()) continue;
        if (jobProvider.toLowerCase() !== provider.toLowerCase()) continue;
        const used = await pub.readContract({ address: RATINGS_ADDRESS!, abi: RATINGS_ABI, functionName: 'joinedWithJob', args: [id] }) as boolean;
        if (!used) return id;
      } catch {
        // A job that cannot be read is a job we cannot vouch for. Skip it.
      }
    }
    return null;
  }, [pub, nodeAbi, nodeAddress, jobIds, guestAddress, provider]);

  const refresh = useCallback(async () => {
    try {
      const g = await readGroup(pub, identity.commitment);
      setMembers(g.members.length);
      setJoined(g.joined);
      setAverage(await readAverage(pub, provider));
      if (!g.joined) setEligible(await findEligible());
    } catch (e) {
      console.error('ratings read failed', e);
    }
  }, [pub, identity, provider, findEligible]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function join() {
    if (!eligible) return;
    setBusy(true);
    setNote('joining the rating group with a job you paid for…');
    try {
      const h = await joinWithJob(wallet, eligible, identity);
      await pub.waitForTransactionReceipt({ hash: h });
      setNote('joined. your rating is now unlinkable to any single job.');
      await refresh();
    } catch (e: any) {
      console.error('join failed', e);
      setNote(e?.shortMessage ?? 'could not join the group');
    } finally { setBusy(false); }
  }

  async function rate(stars: number) {
    setBusy(true);
    setNote('proving membership… the first proof in a session takes a few seconds');
    try {
      const h = await rateProvider(pub, wallet, provider, stars, identity);
      await pub.waitForTransactionReceipt({ hash: h });
      setNote(`rated ${stars}/5, verified on chain`);
      await refresh();
    } catch (e: any) {
      console.error('rating failed', e);
      // The contract rejects a second rating of the same provider by the same
      // identity through the nullifier, which is the intended behaviour and
      // deserves a sentence rather than a stack trace.
      setNote(e?.shortMessage?.includes('nullifier')
        ? 'you have already rated this provider'
        : e?.shortMessage ?? 'the rating was rejected');
    } finally { setBusy(false); }
  }

  return (
    <div className="engram-head" style={{ display: 'block' }}>
      <div>
        rate this provider
        {average !== null && <span className="dim"> · {average.toFixed(2)}/5 so far</span>}
        {members !== null && <span className="dim"> · group of {members}</span>}
      </div>

      {members !== null && members < MIN_ANONYMITY_SET && (
        <div className="dim" style={{ marginTop: 4 }}>
          a group this small hides nobody. your rating is verified, not anonymous, until more guests join.
        </div>
      )}

      {!joined && (
        eligible
          ? <button disabled={busy} onClick={join} style={{ marginTop: 6 }}>join with job#{eligible.toString()}</button>
          : <div className="dim" style={{ marginTop: 4 }}>
              rating opens once a job you paid for has closed. a session job closes when it goes idle.
            </div>
      )}

      {joined && (
        <div style={{ marginTop: 6 }}>
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} disabled={busy} onClick={() => rate(n)} style={{ marginRight: 4 }}>{n}</button>
          ))}
        </div>
      )}

      {note && <div className="dim" style={{ marginTop: 4 }}>{note}</div>}
    </div>
  );
}
