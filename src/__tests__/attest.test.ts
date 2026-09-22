import { describe, expect, it } from 'vitest';
import { announceMessage, controlMessage, nonceStore, originOf, validNonce } from '../attest';

const N = '0x' + 'ab'.repeat(32);
const claim = {
  registry: '0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd',
  chainId: 10143,
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  url: 'https://node1.dinnernode.xyz',
  model: 'qwen3.8:27b',
  nonce: N,
};

describe('the signed claim', () => {
  it('names everything a verifier depends on', () => {
    expect(announceMessage(claim)).toBe([
      'DinnerNode announce',
      'registry: 0x2881051f957ba0be7253c80dd47af3cc39ffebcd',
      'chain: 10143',
      'provider: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      'url: https://node1.dinnernode.xyz',
      'model: qwen3.8:27b',
      `nonce: ${N}`,
    ].join('\n'));
  });

  it('is built the same from a checksummed address and a lowercase one', () => {
    // Both sides build the message themselves and compare signatures, so a
    // verifier that normalised differently would reject its own nodes.
    expect(announceMessage(claim)).toBe(announceMessage({ ...claim, address: claim.address.toLowerCase() }));
    expect(announceMessage(claim)).toBe(announceMessage({ ...claim, registry: claim.registry.toLowerCase() }));
  });

  it('separates an announce from a control proof', () => {
    // Otherwise a signature harvested from one path is a valid claim on the
    // other, and the browser check and discovery would share one credential.
    expect(controlMessage(claim).startsWith('DinnerNode control')).toBe(true);
    expect(controlMessage(claim)).not.toBe(announceMessage(claim));
  });

  it('builds the control message the browser copy builds', () => {
    // `web/` is a separate package and keeps its own copy of this format, as
    // it already does for the chain and the ABI. The same literal is pinned in
    // `web/src/lib/__tests__/attest.test.ts`, so a change made to one copy and
    // not the other fails in both suites rather than in production as a node
    // the browser quietly refuses to order from.
    expect(controlMessage(claim)).toBe([
      'DinnerNode control',
      'registry: 0x2881051f957ba0be7253c80dd47af3cc39ffebcd',
      'chain: 10143',
      'provider: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      'url: https://node1.dinnernode.xyz',
      `nonce: ${N}`,
    ].join('\n'));
  });

  it('binds the url into the control claim too, which stops a relaying host', () => {
    // A hostile host forwards the browser's nonce to a real provider and
    // returns the signature it gets. The provider signs its own origin, so the
    // message the browser builds for the hostile origin does not match.
    expect(controlMessage({ ...claim, url: 'https://evil.example' })).not.toBe(controlMessage(claim));
  });

  it('normalises a url to its origin on both sides of the wire', () => {
    // The node derives this from a Host header and the browser from the URL it
    // dialed. Neither is allowed to fail over a trailing slash.
    expect(originOf('https://node1.dinnernode.xyz/health?x=1')).toBe('https://node1.dinnernode.xyz');
    expect(originOf('https://NODE1.dinnernode.xyz/')).toBe('https://node1.dinnernode.xyz');
    expect(originOf('http://192.168.3.8:4173')).toBe('http://192.168.3.8:4173');
    // A bare host is what a Host header carries when nothing supplies a scheme.
    expect(originOf('node1.dinnernode.xyz')).toBe('https://node1.dinnernode.xyz');
  });

  it('binds the registry, the chain and the url', () => {
    // Each of these is a replay a signature must not survive: a different
    // deployment, a different chain, or the same claim moved onto another host.
    expect(announceMessage({ ...claim, registry: '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92' })).not.toBe(announceMessage(claim));
    expect(announceMessage({ ...claim, chainId: 31337 })).not.toBe(announceMessage(claim));
    expect(announceMessage({ ...claim, url: 'https://evil.example' })).not.toBe(announceMessage(claim));
  });

  it('refuses a nonce that could forge a line', () => {
    // The one caller-supplied field in a line-based format. A newline here
    // would let a claimant sign a message with a url or provider it chose.
    expect(validNonce(N)).toBe(true);
    expect(validNonce(`${N}\nurl: https://evil.example`)).toBe(false);
    expect(validNonce('0xABCD')).toBe(false);
    expect(validNonce('0x' + 'AB'.repeat(32))).toBe(false);
    expect(validNonce(undefined)).toBe(false);
    expect(() => announceMessage({ ...claim, nonce: 'nope' })).toThrow();
  });
});

describe('the nonce store', () => {
  const seq = () => { let i = 0; return () => `0x${String(++i).padStart(64, '0')}`; };

  it('spends a nonce once', () => {
    const s = nonceStore(60_000, seq());
    const n = s.issue('0xAAA', 1000);
    expect(s.consume('0xaaa', n, 1001)).toBe(true);
    // The property that makes a captured signature worthless.
    expect(s.consume('0xaaa', n, 1002)).toBe(false);
  });

  it('expires an unspent nonce and forgets it', () => {
    const s = nonceStore(60_000, seq());
    const n = s.issue('0xAAA', 1000);
    expect(s.consume('0xAAA', n, 61_001)).toBe(false);
    expect(s.size()).toBe(0);
  });

  it('will not accept another claimant nonce', () => {
    const s = nonceStore(60_000, seq());
    const a = s.issue('0xAAA', 1000);
    s.issue('0xBBB', 1000);
    expect(s.consume('0xBBB', a, 1001)).toBe(false);
    expect(s.consume('0xAAA', a, 1001)).toBe(true);
  });

  it('is why one node must announce on ONE timer', () => {
    // Observed live 2026-09-02: host.ts registered two four-minute announce
    // timers, so a node fetched two nonces and signed two claims. Interleaved
    // the way the network delivered them, the first claim always lost, and the
    // node logged "403 nonce unknown, spent or expired" every four minutes
    // while the second announce quietly succeeded. The store is behaving
    // correctly here; the caller was not. Fixed by deleting the second timer.
    const s = nonceStore(60_000, seq());
    const first = s.issue('0xAAA', 1000);   // timer A asks
    const second = s.issue('0xAAA', 1000);  // timer B asks, replacing it
    expect(s.consume('0xAAA', first, 1001)).toBe(false);  // A announces: 403
    expect(s.consume('0xAAA', second, 1001)).toBe(true);  // B announces: 200
  });

  it('keeps one outstanding nonce per claimant, and sweeps dead ones', () => {
    const s = nonceStore(60_000, seq());
    const first = s.issue('0xAAA', 1000);
    const second = s.issue('0xAAA', 1000);
    expect(s.consume('0xAAA', first, 1001)).toBe(false);
    expect(s.consume('0xAAA', second, 1001)).toBe(true);
    s.issue('0xCCC', 1000);
    s.issue('0xDDD', 200_000);
    // The sweep on issue is what stops the map growing without bound when
    // nobody comes back to spend one.
    expect(s.size()).toBe(1);
  });
});
