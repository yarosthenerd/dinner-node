import { describe, expect, it, vi } from 'vitest';
import { controlMessage, randomNonce } from '../attest';

const N = '0x' + 'ab'.repeat(32);

describe('the control message', () => {
  it('is byte for byte the message src/attest.ts builds', () => {
    // Pinned on both sides. This file and `src/__tests__/attest.test.ts`
    // assert the same literal, so a change to one copy that is not made to the
    // other fails here rather than in production as a node the browser
    // silently refuses to order from.
    expect(controlMessage({
      registry: '0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd',
      chainId: 10143,
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      url: 'https://node1.dinnernode.xyz',
      nonce: N,
    })).toBe([
      'DinnerNode control',
      'registry: 0x2881051f957ba0be7253c80dd47af3cc39ffebcd',
      'chain: 10143',
      'provider: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      'url: https://node1.dinnernode.xyz',
      `nonce: ${N}`,
    ].join('\n'));
  });

  it('lowercases a checksummed address and registry', () => {
    const a = controlMessage({ registry: '0xAbC', chainId: 1, address: '0xDeF', url: 'https://a.example', nonce: N });
    const b = controlMessage({ registry: '0xabc', chainId: 1, address: '0xdef', url: 'https://a.example', nonce: N });
    expect(a).toBe(b);
  });

  it('binds the origin, which is what stops a relaying host', () => {
    // The attack this line exists for: evil.example forwards the browser's
    // nonce to a real provider's /challenge and returns that signature. The
    // provider signs its OWN origin, so the message the browser verifies
    // against evil.example does not match and the host is skipped.
    const base = { registry: '0xabc', chainId: 10143, address: '0xdef', nonce: N };
    expect(controlMessage({ ...base, url: 'https://evil.example' }))
      .not.toBe(controlMessage({ ...base, url: 'https://node1.dinnernode.xyz' }));
  });

  it('compares origins, not URL strings', () => {
    // Both sides derive this independently: the browser from the URL it
    // dialed, the node from its Host header. A path or a trailing slash on one
    // side must not fail an otherwise valid proof.
    const base = { registry: '0xabc', chainId: 1, address: '0xdef', nonce: N };
    const canonical = controlMessage({ ...base, url: 'https://node1.dinnernode.xyz' });
    for (const u of ['https://node1.dinnernode.xyz/', 'https://NODE1.dinnernode.xyz', 'https://node1.dinnernode.xyz/health?x=1']) {
      expect(controlMessage({ ...base, url: u }), u).toBe(canonical);
    }
  });
});

describe('the nonce', () => {
  it('is 32 random bytes in the only shape a node will sign', () => {
    const n = randomNonce();
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
    expect(n).not.toBe(randomNonce());
  });

  it('comes from the CSPRNG, not Math.random', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    randomNonce();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
