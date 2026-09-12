/**
 * The browser half of the struct decode. Duplicated from src/registry.ts on
 * purpose, because the daemon and the web app are separate builds, so it needs
 * its own test for the same reason it needs its own file.
 *
 * The defect being guarded is silent: V2 moves `open` from index 5 to index 9,
 * and the value at the old index is a non-zero rate, which is truthy. A
 * positional reader keeps answering "open" for a closed job. The assertions
 * that matter are therefore the false ones.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const readContract = vi.fn();

vi.mock('../../lib', () => ({
  ABI: [{ type: 'function', name: 'getJob' }, { type: 'function', name: 'getProvider' }],
  pub: { readContract: (...a: unknown[]) => readContract(...a) },
}));

const { readJob, readProvider, isOursAndOpen, remaining } = await import('../registry');

const REGISTRY = '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c' as const;
const GUEST = '0x000000000000000000000000000000000000cafe' as const;
const STRANGER = '0x000000000000000000000000000000000000b0b1' as const;
const NODE1 = '0x055a2e24f4588915aB133Cb85753b0E4BBBC326A' as const;
const NODE2 = '0x1978602dF1865eD61EA0754030817fD8F6A694d3' as const;

const job = (over: Partial<Record<string, unknown>> = {}) => ({
  requester: GUEST,
  provider: NODE1,
  escrow: 1000n,
  paid: 250n,
  tokens: 800n,
  ratePerMillion: 2000000000000000000n,
  maxTokensPerSecond: 60n,
  openedAt: 1757500000n,
  lastSettleAt: 1757500005n,
  open: true,
  requireCheckpoints: true,
  ...over,
}) as never;

beforeEach(() => readContract.mockReset());

describe('readJob', () => {
  it('takes the contract address as its first argument, not the provider', async () => {
    // The signature differs from the node's on purpose: the browser may talk to
    // more than one deployment, so the address is passed rather than imported.
    readContract.mockResolvedValue(job());
    await readJob(REGISTRY, 12n);
    const [args] = readContract.mock.calls[0] as [Record<string, unknown>];
    expect(args.address).toBe(REGISTRY);
    expect(args.functionName).toBe('getJob');
    expect(args.args).toEqual([12n]);
  });

  it('returns fields reachable by name, including the v2 additions', async () => {
    readContract.mockResolvedValue(job({ open: false, requireCheckpoints: false }));
    const j = await readJob(REGISTRY, 1n);
    expect(j.open).toBe(false);
    expect(j.requireCheckpoints).toBe(false);
    expect(j.ratePerMillion).toBe(2000000000000000000n);
  });
});

describe('readProvider', () => {
  it('passes the contract and the provider separately', async () => {
    readContract.mockResolvedValue({ model: 'llama3.2:1b', active: true } as never);
    await readProvider(REGISTRY, NODE2);
    const [args] = readContract.mock.calls[0] as [Record<string, unknown>];
    expect(args.address).toBe(REGISTRY);
    expect(args.args).toEqual([NODE2]);
    expect(args.functionName).toBe('getProvider');
  });

  it('reports a deregistered provider as inactive despite a truthy rate', async () => {
    readContract.mockResolvedValue({ active: false, ratePerMillion: 2000000000000000000n } as never);
    expect((await readProvider(REGISTRY, NODE2)).active).toBe(false);
  });
});

describe('isOursAndOpen', () => {
  it('is true for an open job belonging to this guest', () => {
    expect(isOursAndOpen(job(), GUEST)).toBe(true);
  });

  it('is false on a closed job', () => {
    expect(isOursAndOpen(job({ open: false }), GUEST)).toBe(false);
  });

  it('is false for another guest, which is what stops a resume on a stranger job', () => {
    expect(isOursAndOpen(job(), STRANGER)).toBe(false);
  });

  it('ignores the provider when none is given', () => {
    // The release path knows the guest but not always which node holds the job.
    expect(isOursAndOpen(job({ provider: NODE2 }), GUEST)).toBe(true);
  });

  it('checks the provider when one is given', () => {
    expect(isOursAndOpen(job(), GUEST, NODE1)).toBe(true);
    expect(isOursAndOpen(job(), GUEST, NODE2)).toBe(false);
  });

  it('compares both addresses case-insensitively', () => {
    expect(isOursAndOpen(job(), GUEST.toUpperCase().replace('0X', '0x'), NODE1.toLowerCase())).toBe(true);
  });
});

describe('remaining', () => {
  it('is escrow minus paid', () => {
    expect(remaining(job({ escrow: 1000n, paid: 250n }))).toBe(750n);
  });

  it('is zero once the escrow is spent, which is what gates a top-up', () => {
    expect(remaining(job({ escrow: 1000n, paid: 1000n }))).toBe(0n);
  });
});
