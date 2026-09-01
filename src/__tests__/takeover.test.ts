import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parseAuth, authorises, refuseTakeover, authDomain, REASSIGN_AUTH_TYPES,
  ANY_PROVIDER, type ReassignAuth,
} from '../takeover';

const guest = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const stranger = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const ME = '0x000000000000000000000000000000000000b0b1' as const;
const OTHER = '0x000000000000000000000000000000000000cafe' as const;
const REGISTRY = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as const;
const CHAIN = 10143;

async function sign(over: {
  jobId?: bigint; newProvider?: `0x${string}`; maxReassigns?: bigint; deadline?: bigint;
  signer?: typeof guest; chainId?: number; registry?: `0x${string}`;
} = {}): Promise<ReassignAuth> {
  const jobId = over.jobId ?? 1n;
  const newProvider = over.newProvider ?? ANY_PROVIDER;
  const maxReassigns = over.maxReassigns ?? 2n;
  const deadline = over.deadline ?? 1788000000n;
  const signature = await (over.signer ?? guest).signTypedData({
    domain: authDomain(over.chainId ?? CHAIN, over.registry ?? REGISTRY),
    types: REASSIGN_AUTH_TYPES, primaryType: 'ReassignAuth',
    message: { jobId, newProvider, maxReassigns, deadline },
  });
  return { jobId, newProvider, maxReassigns, deadline, signature };
}

const job = (over: Partial<{ open: boolean; provider: `0x${string}`; requester: `0x${string}`; escrow: bigint; paid: bigint }> = {}) => ({
  open: true, provider: OTHER, requester: guest.address, escrow: 10n ** 18n, paid: 0n, ...over,
});

const check = (over: any = {}) => ({
  auth: over.auth, me: ME, used: 0n,
  nowSeconds: 1787000000, gasCostWei: 10n ** 15n, minMargin: 2n,
  ...over,
  // After the spread, so a partial `job` in `over` is merged into a full one
  // rather than replacing it with an object whose `open` is undefined.
  job: job(over.job),
});

describe('parseAuth', () => {
  it('accepts a well-formed authorisation', async () => {
    const a = await sign();
    const got = parseAuth({ ...a, jobId: '1', maxReassigns: '2', deadline: '1788000000' });
    expect(typeof got).not.toBe('string');
    expect((got as ReassignAuth).jobId).toBe(1n);
  });

  it.each([
    ['no authorisation', undefined],
    ['malformed signature', { jobId: '1', newProvider: ANY_PROVIDER, maxReassigns: '2', deadline: '1', signature: '0xdead' }],
    ['malformed newProvider', { jobId: '1', newProvider: 'nope', maxReassigns: '2', deadline: '1', signature: `0x${'11'.repeat(65)}` }],
    ['malformed jobId', { jobId: '0', newProvider: ANY_PROVIDER, maxReassigns: '2', deadline: '1', signature: `0x${'11'.repeat(65)}` }],
    ['authorisation allows no handovers', { jobId: '1', newProvider: ANY_PROVIDER, maxReassigns: '0', deadline: '1', signature: `0x${'11'.repeat(65)}` }],
  ])('refuses with "%s"', (reason, input) => {
    expect(parseAuth(input)).toBe(reason);
  });

  it('refuses a deadline that does not fit uint64', () => {
    expect(parseAuth({
      jobId: '1', newProvider: ANY_PROVIDER, maxReassigns: '2',
      deadline: (2n ** 64n).toString(), signature: `0x${'11'.repeat(65)}`,
    })).toBe('malformed deadline');
  });
});

describe('authorises', () => {
  it('accepts the wildcard the client signs', async () => {
    expect(await authorises(await sign(), guest.address, ME, CHAIN, REGISTRY)).toBe(true);
  });

  it('accepts an authorisation that names this node', async () => {
    expect(await authorises(await sign({ newProvider: ME }), guest.address, ME, CHAIN, REGISTRY)).toBe(true);
  });

  it('refuses one that names another node', async () => {
    expect(await authorises(await sign({ newProvider: OTHER }), guest.address, ME, CHAIN, REGISTRY)).toBe(false);
  });

  it('refuses a signature from somebody who is not the requester', async () => {
    expect(await authorises(await sign({ signer: stranger }), guest.address, ME, CHAIN, REGISTRY)).toBe(false);
  });

  it('refuses a signature for a different job', async () => {
    const a = await sign({ jobId: 7n });
    expect(await authorises({ ...a, jobId: 8n }, guest.address, ME, CHAIN, REGISTRY)).toBe(false);
  });

  it('refuses a signature for a different chain or registry', async () => {
    expect(await authorises(await sign({ chainId: 1 }), guest.address, ME, CHAIN, REGISTRY)).toBe(false);
    expect(await authorises(await sign({ registry: OTHER }), guest.address, ME, CHAIN, REGISTRY)).toBe(false);
  });

  it('refuses when the terms were altered after signing', async () => {
    const a = await sign({ maxReassigns: 1n });
    expect(await authorises({ ...a, maxReassigns: 5n }, guest.address, ME, CHAIN, REGISTRY)).toBe(false);
    const b = await sign({ deadline: 1788000000n });
    expect(await authorises({ ...b, deadline: 1799999999n }, guest.address, ME, CHAIN, REGISTRY)).toBe(false);
  });

  it('does not throw on a signature that cannot recover', async () => {
    const a = await sign();
    expect(await authorises({ ...a, signature: `0x${'00'.repeat(65)}` }, guest.address, ME, CHAIN, REGISTRY)).toBe(false);
  });
});

describe('refuseTakeover', () => {
  it('takes a job worth taking', async () => {
    expect(refuseTakeover(check({ auth: await sign() }))).toBeNull();
  });

  it('refuses a closed job', async () => {
    expect(refuseTakeover(check({ auth: await sign(), job: { open: false } }))).toBe('job is closed');
  });

  it('refuses a job it already holds', async () => {
    expect(refuseTakeover(check({ auth: await sign(), job: { provider: ME } }))).toBe('job is already ours');
  });

  it('refuses an expired authorisation', async () => {
    expect(refuseTakeover(check({ auth: await sign({ deadline: 1n }) }))).toBe('authorisation expired');
  });

  it('refuses a spent authorisation', async () => {
    expect(refuseTakeover(check({ auth: await sign({ maxReassigns: 2n }), used: 2n }))).toBe('authorisation spent');
  });

  it('refuses one that names another provider', async () => {
    expect(refuseTakeover(check({ auth: await sign({ newProvider: OTHER }) })))
      .toBe('authorisation names another provider');
  });

  // The economic guard. Without it a guest opens a dust job, signs an
  // authorisation, and walks every registered provider through a paid
  // transaction that can never earn its own gas back.
  it('refuses a job that cannot cover the handover', async () => {
    const auth = await sign();
    expect(refuseTakeover(check({ auth, job: { escrow: 10n ** 15n, paid: 0n } })))
      .toBe('job cannot cover the handover');
    expect(refuseTakeover(check({ auth, job: { escrow: 10n ** 18n, paid: 10n ** 18n - 1n } })))
      .toBe('job cannot cover the handover');
  });

  it('takes one that covers it with margin to spare', async () => {
    const auth = await sign();
    expect(refuseTakeover(check({ auth, job: { escrow: 3n * 10n ** 15n, paid: 0n } }))).toBeNull();
  });

  it('finds the cheapest reason first', async () => {
    // Closed, expired, spent and unaffordable all at once: the answer is the
    // one that costs nothing to discover.
    const auth = await sign({ deadline: 1n, maxReassigns: 1n });
    expect(refuseTakeover(check({ auth, used: 9n, job: { open: false, escrow: 1n, paid: 0n } })))
      .toBe('job is closed');
  });
});
