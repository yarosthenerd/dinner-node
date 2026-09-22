/**
 * Anonymous provider ratings.
 *
 * The claim this module is careful about is the one worth testing: with fewer
 * than three members a Semaphore group hides nobody, and `tooSmall` exists so
 * the UI says that rather than implying a protection that is not there. The
 * live group is still below that threshold, so the flag is not decorative.
 *
 * Proof generation is not exercised here. It pulls Groth16 artifacts over the
 * network on first use, which does not belong in a suite that has to stay
 * hermetic. What is exercised is every guard that runs before it, since those
 * are what decide whether a proof is attempted at all.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Identity } from '@semaphore-protocol/identity';
import {
  RATINGS_ABI, RATINGS_ADDRESS, MIN_ANONYMITY_SET, ratingsEnabled, loadIdentity,
  readGroup, readAverage, joinWithJob, rateProvider, boundRegistry,
} from '../ratings';

const NODE1 = '0x055a2e24f4588915aB133Cb85753b0E4BBBC326A' as const;

const pubWith = (reads: Record<string, unknown>) => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => reads[functionName]),
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the anonymity floor', () => {
  it('is three, the first size where the claim is not outright false', () => {
    expect(MIN_ANONYMITY_SET).toBe(3);
  });
});

describe('ratingsEnabled', () => {
  it('tracks whether an address is configured, whichever way this build is set up', () => {
    // Asserted as a relationship rather than as a fixed value on purpose.
    // `web/.env` is gitignored and sets VITE_RATINGS_ADDRESS locally, so a
    // hardcoded expectation here passes on the operator's machine and fails in
    // CI, which is the kind of test that gets deleted rather than fixed.
    expect(ratingsEnabled()).toBe(RATINGS_ADDRESS !== null);
  });

  it('degrades rather than throwing when the feature is off', () => {
    expect(() => ratingsEnabled()).not.toThrow();
  });
});

describe('the ABI', () => {
  const named = (name: string) => RATINGS_ABI.filter(e => 'name' in e && e.name === name);

  it('declares the two writes and the reads the UI needs', () => {
    expect(named('join')).toHaveLength(1);
    expect(named('rate')).toHaveLength(1);
    expect(named('allCommitments')).toHaveLength(1);
    expect(named('averageRating')).toHaveLength(1);
    expect(named('ratingCount')).toHaveLength(1);
  });

  it('reads membership from state rather than from events', () => {
    // The Monad public RPC caps eth_getLogs at a 100 block range, about forty
    // seconds of history, so membership cannot be rebuilt from `Joined` events.
    // `allCommitments` is why the contract keeps the list readable.
    const fn = named('allCommitments')[0] as unknown as { stateMutability: string };
    expect(fn.stateMutability).toBe('view');
  });
});

describe('loadIdentity', () => {
  it('creates an identity on first use and persists it in an importable form', () => {
    const id = loadIdentity();
    const stored = localStorage.getItem('dn_zk_identity')!;
    expect(stored).toBe(id.export());
    // `privateKey` is a Uint8Array, so its toString() is a comma separated byte
    // list. Storing that was the defect: it is read back as a SEED, and derives
    // a different identity from the one that was just handed to the caller.
    expect(stored).not.toContain(',');
  });

  it('returns the same identity on a second call', () => {
    // The case that was broken. A guest who joined the group on their first
    // page load came back as somebody else on their next one, so the paid job
    // they spent to join bought them a membership they could never use.
    const first = loadIdentity();
    const second = loadIdentity();
    expect(second.commitment).toBe(first.commitment);
  });

  it('survives a reload, which is the same thing from a fresh module state', () => {
    const first = loadIdentity();
    const stored = localStorage.getItem('dn_zk_identity');
    localStorage.clear();
    localStorage.setItem('dn_zk_identity', stored!);
    expect(loadIdentity().commitment).toBe(first.commitment);
  });

  it('keeps an identity stored in the legacy byte-list format', () => {
    // Anyone who already joined the group did so as the identity DERIVED from
    // that string, so it has to keep being read as a seed. Importing it instead
    // would silently take their membership away.
    const legacy = new Identity();
    const csv = legacy.privateKey.toString();
    localStorage.setItem('dn_zk_identity', csv);
    expect(loadIdentity().commitment).toBe(new Identity(csv).commitment);
  });

  it('does not rewrite a legacy value it can still read', () => {
    const csv = new Identity().privateKey.toString();
    localStorage.setItem('dn_zk_identity', csv);
    loadIdentity();
    expect(localStorage.getItem('dn_zk_identity')).toBe(csv);
  });

  it('does not reuse the wallet key as the identity seed', () => {
    // Reusing `dn_pk` would hand the wallet-to-rating linkage to anyone who
    // ever sees both, which is the exact thing the module exists to prevent.
    localStorage.setItem('dn_pk', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const id = loadIdentity();
    expect(localStorage.getItem('dn_zk_identity')).not.toBe(localStorage.getItem('dn_pk'));
    expect(id.privateKey.toString()).not.toContain('59c6995e');
  });

  it('still returns a usable identity when storage throws', () => {
    // Private mode, or site data blocked. A fresh identity works for this page
    // load; it just cannot rate twice from the same browser.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => loadIdentity()).not.toThrow();
    expect(loadIdentity().commitment).toBeTypeOf('bigint');
  });
});

describe('readGroup', () => {
  it('reports a group below the floor as too small', () => {
    const members = [1n, 2n];
    return readGroup(pubWith({ allCommitments: members }), 9n).then(g => {
      expect(g.tooSmall).toBe(true);
      expect(g.members).toEqual([1n, 2n]);
    });
  });

  it('reports a group at the floor as large enough', async () => {
    const g = await readGroup(pubWith({ allCommitments: [1n, 2n, 3n] }), 9n);
    expect(g.tooSmall).toBe(false);
  });

  it('reports an empty group as too small rather than as absent', async () => {
    const g = await readGroup(pubWith({ allCommitments: [] }), 9n);
    expect(g.tooSmall).toBe(true);
    expect(g.joined).toBe(false);
  });

  it('says joined when this browser commitment is in the list', async () => {
    const g = await readGroup(pubWith({ allCommitments: [1n, 42n, 3n] }), 42n);
    expect(g.joined).toBe(true);
  });

  it('says not joined when it is absent', async () => {
    const g = await readGroup(pubWith({ allCommitments: [1n, 2n, 3n] }), 42n);
    expect(g.joined).toBe(false);
  });

  it('copies the list rather than handing back the contract read', async () => {
    const members = [1n, 2n, 3n];
    const g = await readGroup(pubWith({ allCommitments: members }), 1n);
    g.members.push(4n);
    expect(members).toHaveLength(3);
  });
});

describe('readAverage', () => {
  it('is null when the provider has no ratings', async () => {
    // Null rather than zero: a provider nobody rated is not a provider rated
    // badly, and the UI renders the two differently.
    expect(await readAverage(pubWith({ averageRating: 0n, ratingCount: 0n }), NODE1)).toBeNull();
  });

  it('scales the on-chain hundredths back to stars', async () => {
    expect(await readAverage(pubWith({ averageRating: 425n, ratingCount: 3n }), NODE1)).toBe(4.25);
  });

  it('returns a whole number cleanly', async () => {
    expect(await readAverage(pubWith({ averageRating: 500n, ratingCount: 1n }), NODE1)).toBe(5);
  });

  it('returns zero stars when that is genuinely the average', async () => {
    expect(await readAverage(pubWith({ averageRating: 0n, ratingCount: 4n }), NODE1)).toBe(0);
  });
});

describe('joinWithJob', () => {
  const GUEST = '0xCDd994F9f578895326634A3147fBa6738ea15411' as const;

  it('sends the job id and the commitment, capped against a fee spike', async () => {
    // Monad's base fee spikes to thousands of gwei and the chain charges
    // gas_limit rather than gas_used, so an uncapped write can commit several
    // MON from the guest's own wallet.
    const wallet = { writeContract: vi.fn() };
    const pub = { estimateContractGas: vi.fn().mockResolvedValue(150000n) };
    const id = new Identity();
    await joinWithJob(pub, wallet, GUEST, 12n, id);
    const [args] = wallet.writeContract.mock.calls[0] as [Record<string, unknown>];
    expect(args.functionName).toBe('join');
    expect(args.args).toEqual([12n, id.commitment]);
    expect(args.maxFeePerGas).toBe(2000000000000n);
    // The estimate plus 20%, not the fixed 400,000 it replaced.
    expect(args.gas).toBe(180000n);
  });

  it('sends nothing when the contract would refuse the join', async () => {
    // The failure found on 2026-09-22: a ratings contract bound to an old
    // registry reverts every join, and at a fixed limit each one cost the
    // guest the whole limit.
    const wallet = { writeContract: vi.fn() };
    const pub = { estimateContractGas: vi.fn().mockRejectedValue(new Error('execution reverted: not your job')) };
    await expect(joinWithJob(pub, wallet, GUEST, 12n, new Identity())).rejects.toThrow(/reverted/);
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });
});

describe('boundRegistry', () => {
  it('reads the registry the ratings contract checks jobs against', async () => {
    expect(await boundRegistry(pubWith({ node: NODE1 }))).toBe(NODE1);
  });

  it('is null when the read fails, so an RPC blip does not hide the widget', async () => {
    const pub = { readContract: vi.fn().mockRejectedValue(new Error('rpc down')) };
    expect(await boundRegistry(pub)).toBeNull();
  });
});

describe('rateProvider', () => {
  const wallet = () => ({ writeContract: vi.fn() });

  it('refuses a rating below one before touching the chain', async () => {
    const w = wallet();
    await expect(rateProvider(pubWith({}), w, NODE1, NODE1, 0, new Identity())).rejects.toThrow(/1 to 5/);
    expect(w.writeContract).not.toHaveBeenCalled();
  });

  it('refuses a rating above five before touching the chain', async () => {
    const w = wallet();
    await expect(rateProvider(pubWith({}), w, NODE1, NODE1, 6, new Identity())).rejects.toThrow(/1 to 5/);
    expect(w.writeContract).not.toHaveBeenCalled();
  });

  it('refuses when this browser has not joined the group', async () => {
    // Attempting a proof against a group you are not in burns the artifact
    // download and then fails, so the guard is worth having ahead of it.
    const w = wallet();
    const id = new Identity();
    await expect(
      rateProvider(pubWith({ allCommitments: [1n, 2n, 3n] }), w, NODE1, NODE1, 5, id),
    ).rejects.toThrow(/has not joined/);
    expect(w.writeContract).not.toHaveBeenCalled();
  });
});
