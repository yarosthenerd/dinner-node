/**
 * Where a request came from, and whether the free path may serve it.
 *
 * `/lanjob` opens a job the NODE pays for. That is deliberate and it is the
 * point of the LAN guest page: someone on the same wifi orders with no wallet,
 * no extension and no setup. It is also, unchanged, a stranger spending the
 * operator's MON, and the only thing that ever kept it honest was that nobody
 * outside the flat could reach port 4173.
 *
 * A tunnel removes exactly that. From tomorrow the node answers on a public
 * hostname, and every internet request arrives through cloudflared as a
 * connection from 127.0.0.1, so the address alone says "local" for the whole
 * internet. The forwarding headers are what still tell the truth: a tunnelled
 * request carries the client's real address in one of them, and a machine on
 * the wifi talking to the node directly carries none.
 *
 * So the rule is both halves, and it fails closed: private or loopback peer
 * AND no evidence of a proxy in front. Anything else is a stranger, and a
 * stranger who wants tokens can hold an API key like every other caller.
 */

/** Headers a reverse proxy, CDN or tunnel adds. Their presence is the signal. */
export const FORWARD_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray',
  'true-client-ip',
  'fastly-client-ip',
  'x-client-ip',
] as const;

export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  // node reports IPv4 peers on a dual-stack socket as ::ffff:127.0.0.1.
  const a = addr.trim().toLowerCase().replace(/^::ffff:/, '');
  if (a === '::1' || a === '127.0.0.1' || a === 'localhost') return true;
  if (/^127\./.test(a)) return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  // 172.16.0.0 through 172.31.255.255, and not 172.32+ which is public.
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  // Link-local, both families, and IPv6 unique local addresses.
  if (/^169\.254\./.test(a)) return true;
  if (/^fe80:/.test(a)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;
  return false;
}

export type Reach = { local: boolean; why: string };

/**
 * `headers` is node's IncomingHttpHeaders shape: string, string[] or absent.
 */
export function reach(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): Reach {
  const proxied = FORWARD_HEADERS.filter(h => headers[h] !== undefined);
  if (proxied.length) return { local: false, why: `forwarded by a proxy or tunnel (${proxied.join(', ')})` };
  if (!isPrivateAddress(remoteAddress)) return { local: false, why: `remote address ${remoteAddress ?? 'unknown'} is not on a local network` };
  return { local: true, why: `direct from ${remoteAddress}` };
}
