import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

// The registry read is the only part that must be faked: everything else here
// is real. The challenge is answered by a real key producing a real signature,
// and `proveControl` runs the real `verifyMessage` against it, because a test
// that mocks the verifier proves the test rather than the code.
const readContract = vi.fn();
vi.mock('../../lib', async () => {
  const { defineChain, parseAbi } = await import('viem');
  return {
    ADDR: '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c',
    ABI: parseAbi(['function getProvider(address) view returns (bool active)']),
    monadTestnet: defineChain({
      id: 10143, name: 'Monad Testnet',
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
    }),
    pub: { readContract: (...a: unknown[]) => readContract(...a) },
  };
});

const { controlMessage, HostNotProven, originOf, proveControl } = await import('../attest');

const REGISTRY = '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c';
const CHAIN = 10143;
const HOST = 'https://node1.dinnernode.xyz';
// The real provider, and an impostor who put itself in a ?host= link.
const provider = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const impostor = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

/**
 * A host that answers `/challenge`. By default it behaves: it signs the nonce
 * it was given, naming the origin it was dialed on, with the key the registry
 * knows. Each option below is one way of not doing that.
 */
function host(opts: {
  signer?: typeof provider;
  nonce?: string;          // sign a different nonce than the one sent
  url?: string;            // sign a different origin than the one dialed
  status?: number;
  body?: unknown;
  throws?: Error;
} = {}) {
  // `_input` is the URL fetch was called with. The assertions that care about
  // it read it off `mock.calls` rather than from in here, and tsconfig's
  // noUnusedParameters is what `npm run build` enforces even though
  // `tsc --noEmit` does not.
  return vi.fn(async (_input: string, init: any) => {
    if (opts.throws) throw opts.throws;
    if (opts.status && opts.status !== 200) {
      return { ok: false, status: opts.status, json: async () => ({}) } as any;
    }
    const sent = JSON.parse(init.body).nonce;
    if (opts.body !== undefined) return { ok: true, status: 200, json: async () => opts.body } as any;
    const signature = await (opts.signer ?? provider).signMessage({
      message: controlMessage({
        registry: REGISTRY, chainId: CHAIN, address: (opts.signer ?? provider).address,
        url: opts.url ?? HOST, nonce: opts.nonce ?? sent,
      }),
    });
    return { ok: true, status: 200, json: async () => ({ signature }) } as any;
  });
}

const active = (is: boolean) => readContract.mockResolvedValue({ active: is });

beforeEach(() => { readContract.mockReset(); active(true); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('proveControl, the check that decides who receives a prompt', () => {
  it('accepts a host that signs the nonce it was given with the key it claims', async () => {
    const f = host();
    vi.stubGlobal('fetch', f);
    await expect(proveControl(HOST, provider.address)).resolves.toBeUndefined();
    // The nonce is generated per call and sent to the host, never taken from it.
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(f.mock.calls[0][0]).toBe(HOST + '/challenge');
  });

  it('refuses a host that cannot be reached at all', async () => {
    vi.stubGlobal('fetch', host({ throws: new Error('ECONNREFUSED') }));
    await expect(proveControl(HOST, provider.address)).rejects.toBeInstanceOf(HostNotProven);
  });

  it('refuses a node too old to answer /challenge, deliberately', async () => {
    // A 404 here is an unprovable host, and an unprovable host must not get a
    // prompt. Being lenient about the upgrade would be the whole hole.
    vi.stubGlobal('fetch', host({ status: 404 }));
    await expect(proveControl(HOST, provider.address)).rejects.toThrow(/did not answer the identity challenge/);
  });

  it('refuses an answer carrying no usable signature', async () => {
    for (const body of [{}, { signature: null }, { signature: 'not-hex' }, { signature: '0xzz' }]) {
      vi.stubGlobal('fetch', host({ body }));
      await expect(proveControl(HOST, provider.address)).rejects.toThrow(/no usable signature/);
    }
  });

  it('refuses the impostor: a valid signature from the wrong key', async () => {
    // The attack this function exists for. The impostor holds a real key and
    // signs perfectly well; it simply is not the key the registry pays.
    vi.stubGlobal('fetch', host({ signer: impostor }));
    await expect(proveControl(HOST, provider.address)).rejects.toThrow(/cannot prove it/);
  });

  it('refuses a signature over a different nonce, which is a replayed one', async () => {
    // A captured signature from an earlier challenge is exactly this shape.
    vi.stubGlobal('fetch', host({ nonce: '0x' + 'cd'.repeat(32) }));
    await expect(proveControl(HOST, provider.address)).rejects.toThrow(/cannot prove it/);
  });

  it('refuses a relay: a real provider signature naming a different origin', async () => {
    // The relay attack in one test. A hostile host forwards the challenge to
    // node1, gets a genuine signature back, and returns it. That signature
    // names node1's origin; we dialed the relay, so the message we rebuild
    // does not match and the proof fails.
    vi.stubGlobal('fetch', host({ url: 'https://node1.dinnernode.xyz' }));
    await expect(proveControl('https://evil.example', provider.address)).rejects.toThrow(/cannot prove it/);
  });

  it('checks the origin rather than the URL string, so a path or a slash still passes', async () => {
    vi.stubGlobal('fetch', host());
    await expect(proveControl(HOST + '/', provider.address)).resolves.toBeUndefined();
    expect(originOf(HOST + '/some/path')).toBe(originOf(HOST));
  });

  it('refuses a host that proves its key but is not active on chain', async () => {
    // Two separate questions: who the machine is, and whether the chain will
    // pay it. A deregistered provider passes the first and must fail here.
    active(false);
    vi.stubGlobal('fetch', host());
    await expect(proveControl(HOST, provider.address)).rejects.toThrow(/not an active provider/);
  });

  it('retries the registry read before giving up on it', async () => {
    readContract.mockRejectedValueOnce(new Error('rpc hiccup')).mockResolvedValue({ active: true });
    vi.stubGlobal('fetch', host());
    await expect(proveControl(HOST, provider.address)).resolves.toBeUndefined();
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it('does NOT call an RPC outage a failure to prove, which is the difference that matters', async () => {
    // Collapsing the two would make one bad RPC minute skip every healthy node
    // in the list, because the caller's failover treats HostNotProven as "try
    // the next host". A plain Error is a fault, not a verdict on this host.
    readContract.mockRejectedValue(new Error('rpc down'));
    vi.stubGlobal('fetch', host());
    const err = await proveControl(HOST, provider.address).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HostNotProven);
    expect(err.message).toMatch(/could not reach the registry/);
    expect(readContract).toHaveBeenCalledTimes(3);
  });

  it('sends the prompt-bearing headers it was given to the challenge', async () => {
    const f = host();
    vi.stubGlobal('fetch', f);
    await proveControl(HOST, provider.address, { 'ngrok-skip-browser-warning': '1' });
    expect(f.mock.calls[0][1].headers).toMatchObject({ 'ngrok-skip-browser-warning': '1' });
  });

  it('uses a fresh nonce for every call', async () => {
    const f = host();
    vi.stubGlobal('fetch', f);
    await proveControl(HOST, provider.address);
    await proveControl(HOST, provider.address);
    const [a, b] = f.mock.calls.map((c: any) => JSON.parse(c[1].body).nonce);
    expect(a).not.toBe(b);
  });
});
