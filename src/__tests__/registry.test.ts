/**
 * The decode that item 1.13 in SECURITY_REVIEW.md was about.
 *
 * The defect these guard against is not a crash. V2 moves `open` from index 5
 * to index 9 and `active` from 6 to 7, and the value sitting at the old index
 * is a non-zero rate, which is truthy. A positional reader therefore goes on
 * answering "yes, open" for a closed job, silently, forever. So the assertions
 * below are deliberately about the NAME a field is read by and about the false
 * cases, because the true cases pass either way and prove nothing.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const readContract = vi.fn();

vi.mock('../chain', () => ({
  ADDR: '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c',
  ABI: [{ type: 'function', name: 'getJob' }, { type: 'function', name: 'getProvider' }],
  pub: { readContract: (...a: unknown[]) => readContract(...a) },
}));

const { readJob, readProvider, isMine, remaining } = await import('../registry');

const ME = '0x055a2e24f4588915aB133Cb85753b0E4BBBC326A' as const;
const OTHER = '0x1978602dF1865eD61EA0754030817fD8F6A694d3' as const;
const GUEST = '0x000000000000000000000000000000000000cafe' as const;

/** A v2 job as `getJob` returns it: a named struct, every field present. */
const job = (over: Partial<Record<string, unknown>> = {}) => ({
  requester: GUEST,
  provider: ME,
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
  it('asks for getJob by name, against the configured address', async () => {
    readContract.mockResolvedValue(job());
    await readJob(12n);
    const [args] = readContract.mock.calls[0] as [Record<string, unknown>];
    expect(args.functionName).toBe('getJob');
    expect(args.address).toBe('0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c');
    expect(args.args).toEqual([12n]);
  });

  it('returns the struct with its fields reachable by name', async () => {
    readContract.mockResolvedValue(job({ escrow: 7n, open: false }));
    const j = await readJob(1n);
    expect(j.escrow).toBe(7n);
    expect(j.open).toBe(false);
    // The v2-only fields are carried through rather than dropped, which is what
    // lets a caller read the locked rate instead of re-reading the provider.
    expect(j.ratePerMillion).toBe(2000000000000000000n);
    expect(j.requireCheckpoints).toBe(true);
  });
});

describe('readProvider', () => {
  it('asks for getProvider by name and passes the provider address through', async () => {
    readContract.mockResolvedValue({ model: 'qwen3.6:35b-a3b', active: true } as never);
    const p = await readProvider(ME);
    const [args] = readContract.mock.calls[0] as [Record<string, unknown>];
    expect(args.functionName).toBe('getProvider');
    expect(args.args).toEqual([ME]);
    expect(p.model).toBe('qwen3.6:35b-a3b');
  });

  it('reports a deregistered provider as inactive', async () => {
    // The exact case the index drift hid: `active` false while a truthy rate
    // sits where a positional reader used to look for it.
    readContract.mockResolvedValue({ active: false, ratePerMillion: 2000000000000000000n } as never);
    expect((await readProvider(ME)).active).toBe(false);
  });
});

describe('isMine', () => {
  it('is true only when the job is open and the provider is me', () => {
    expect(isMine(job(), ME)).toBe(true);
  });

  it('is false on a closed job even when the provider matches', () => {
    expect(isMine(job({ open: false }), ME)).toBe(false);
  });

  it('is false when the job belongs to another provider', () => {
    expect(isMine(job({ provider: OTHER }), ME)).toBe(false);
  });

  it('compares addresses case-insensitively', () => {
    // Checksummed on one side and lower case on the other is the normal case:
    // the chain returns checksummed, and an env var is usually typed flat.
    expect(isMine(job(), ME.toLowerCase())).toBe(true);
    expect(isMine(job({ provider: ME.toLowerCase() as `0x${string}` }), ME)).toBe(true);
  });
});

describe('remaining', () => {
  it('is escrow minus paid rather than escrow', () => {
    expect(remaining(job({ escrow: 1000n, paid: 250n }))).toBe(750n);
  });

  it('is zero on a fully spent job', () => {
    expect(remaining(job({ escrow: 1000n, paid: 1000n }))).toBe(0n);
  });
});
