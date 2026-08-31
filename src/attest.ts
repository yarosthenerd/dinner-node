/**
 * Proving that a machine controls a provider address.
 *
 * The hole this closes: `POST /announce` checks that an announced address is a
 * registered provider and never that the announcer runs it, so anyone could
 * claim a live provider's slot and receive guests' prompts. They cannot be
 * paid, because settlement goes to the registered address on chain, but they
 * read the prompt and the partial answer, which is the part that matters. The
 * same gap is reachable from the browser through `?host=` and `?peer=`, where
 * a URL names a machine and the client reads the provider address out of that
 * machine's own `/health`.
 *
 * Both are the same question, so both get the same answer: a random nonce the
 * claimant did not choose, signed by the key the registry pays.
 *
 * Free of every project import, so it can be tested without a chain, and used
 * unchanged by the node, by discovery and by the browser.
 */

/**
 * The message a provider signs.
 *
 * Line-based and fully specified, because a signature is only worth what the
 * message says. Every field a verifier depends on is inside it:
 *
 * - the purpose line, so an announce signature cannot be replayed as a control
 *   proof or the other way round,
 * - the registry and the chain, so a signature made for one deployment cannot
 *   be replayed against another,
 * - the URL, so a valid signature cannot be lifted onto a different host,
 * - the nonce, so a captured signature cannot be replayed at all.
 */
export type AnnounceClaim = {
  registry: string;
  chainId: number;
  address: string;
  url: string;
  model: string;
  nonce: string;
};

export type ControlClaim = {
  registry: string;
  chainId: number;
  address: string;
  /**
   * The origin the claim is about, and the field without which the whole
   * mechanism is theatre.
   *
   * Without it a hostile host relays: the browser sends its nonce to
   * evil.example, evil forwards the same nonce to a real provider's
   * /challenge, gets a valid signature over an identical message, and returns
   * it. The signature recovers to a registered active provider and the prompt
   * goes to evil. `announceMessage` bound the URL from the start and this one
   * did not, which is exactly the gap the relay walks through.
   *
   * The node signs the origin IT was dialed at, taken from the request rather
   * than from the caller's claim, so a relayed signature names the relay's
   * upstream and not the relay.
   */
  url: string;
  nonce: string;
};

/** 0x and 64 hex characters. Nothing else is a nonce. */
export const NONCE_RE = /^0x[0-9a-f]{64}$/;

/**
 * Strict, and this is load bearing rather than tidy. The nonce is the one part
 * of the message a caller supplies, and the format is line-based, so a nonce
 * containing a newline could add or replace a line and produce a signature
 * over a claim the signer never saw. Rejecting anything that is not 64 hex
 * characters makes that impossible rather than unlikely.
 */
export function validNonce(n: unknown): n is string {
  return typeof n === 'string' && NONCE_RE.test(n);
}

function assertNonce(n: string): string {
  if (!validNonce(n)) throw new Error('nonce must be 0x followed by 64 lowercase hex characters');
  return n;
}

// Addresses and hashes are compared lowercase throughout, so the message is
// built lowercase throughout. A verifier that checksummed one field and not
// another would reject its own signatures.
const norm = (s: string) => String(s).trim().toLowerCase();

export function announceMessage(c: AnnounceClaim): string {
  return [
    'DinnerNode announce',
    `registry: ${norm(c.registry)}`,
    `chain: ${c.chainId}`,
    `provider: ${norm(c.address)}`,
    // Not lowercased past the origin: a URL path is case sensitive. Only an
    // origin is ever announced, and `new URL(x).origin` is already lowercase
    // for the host, so this is the same string both sides build.
    `url: ${String(c.url).trim()}`,
    `model: ${String(c.model).trim()}`,
    `nonce: ${assertNonce(c.nonce)}`,
  ].join('\n');
}

export function controlMessage(c: ControlClaim): string {
  return [
    'DinnerNode control',
    `registry: ${norm(c.registry)}`,
    `chain: ${c.chainId}`,
    `provider: ${norm(c.address)}`,
    `url: ${originOf(c.url)}`,
    `nonce: ${assertNonce(c.nonce)}`,
  ].join('\n');
}

/**
 * Both sides have to derive the same string from what they hold: the browser
 * from the URL it dialed, the node from the Host header it was reached on. So
 * the comparison is on origin alone, lowercased, with the default port and any
 * path, query or trailing slash removed.
 */
export function originOf(url: string): string {
  try {
    return new URL(String(url)).origin.toLowerCase();
  } catch {
    // A host and port with no scheme is what a Host header carries.
    return `https://${String(url).trim().toLowerCase()}`;
  }
}

/**
 * Nonces issued to one claimant at a time.
 *
 * One outstanding nonce per address, single use, and it expires. Single use is
 * the property that makes a captured signature worthless; the expiry is what
 * stops the map growing without bound when nobody comes back to spend one.
 *
 * `now` is a parameter rather than a call to Date.now(), so expiry is testable
 * without waiting for it.
 */
export type NonceStore = {
  issue(address: string, now?: number): string;
  consume(address: string, nonce: string, now?: number): boolean;
  size(): number;
};

export function nonceStore(ttlMs: number, random: () => string): NonceStore {
  const out = new Map<string, { nonce: string; expires: number }>();
  const sweep = (now: number) => {
    for (const [k, v] of out) if (v.expires <= now) out.delete(k);
  };
  return {
    issue(address, now = Date.now()) {
      sweep(now);
      const nonce = random();
      // Issuing replaces any outstanding nonce for the same address. A node
      // that asked twice and used the second is the normal case; two live
      // nonces per claimant would only widen the window.
      out.set(norm(address), { nonce, expires: now + ttlMs });
      return nonce;
    },
    consume(address, nonce, now = Date.now()) {
      const k = norm(address);
      const held = out.get(k);
      if (!held) return false;
      if (held.expires <= now) { out.delete(k); return false; }
      if (held.nonce !== nonce) return false;
      out.delete(k);
      return true;
    },
    size() { return out.size; },
  };
}
