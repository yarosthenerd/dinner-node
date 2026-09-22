import { describe, expect, it } from 'vitest';
import { isPrivateAddress, reach } from '../reach';

describe('what counts as a local address', () => {
  it('accepts loopback, the three private ranges and link-local', () => {
    for (const a of ['127.0.0.1', '::1', '10.0.0.4', '192.168.3.8', '172.16.0.1', '172.31.255.254', '169.254.1.1', 'fe80::1', 'fd00::1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });

  it('unwraps the IPv4-mapped form node reports on a dual-stack socket', () => {
    // The reason a naive check fails in production and passes in a unit test.
    expect(isPrivateAddress('::ffff:192.168.3.8')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('rejects public addresses, including the ones that look private', () => {
    // 172.32 is public. 10.0.0.4 as a suffix of a public address is public.
    for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '110.0.0.4', '2001:4860::1', '', undefined]) {
      expect(isPrivateAddress(a as any), String(a)).toBe(false);
    }
  });
});

describe('deciding whether the free path may serve a request', () => {
  it('serves a machine on the same wifi', () => {
    expect(reach('192.168.3.14', { host: '192.168.3.8:4173' }).local).toBe(true);
  });

  it('refuses a tunnelled request even though it arrives from 127.0.0.1', () => {
    // The whole reason this module exists. cloudflared and ngrok both connect
    // to the node locally, so the peer address says "local" for every request
    // on the public internet.
    const r = reach('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7', host: 'node1.dinnernode.xyz' });
    expect(r.local).toBe(false);
    expect(r.why).toContain('cf-connecting-ip');
  });

  it('refuses on any forwarding header, not just Cloudflare', () => {
    for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip', 'cf-ray']) {
      expect(reach('127.0.0.1', { [h]: '203.0.113.7' }).local, h).toBe(false);
    }
  });

  it('refuses a direct connection from the internet', () => {
    // A port-forwarded node with no tunnel in front adds no headers at all.
    expect(reach('203.0.113.7', {}).local).toBe(false);
  });

  it('says why, because the answer ends up in a 403 someone has to act on', () => {
    expect(reach('203.0.113.7', {}).why).toContain('203.0.113.7');
    expect(reach('192.168.1.2', {}).why).toContain('192.168.1.2');
  });
});
