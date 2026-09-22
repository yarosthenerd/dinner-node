import { verifyMessage } from 'viem';
import { ABI, ADDR, monadTestnet, pub } from '../lib';

/**
 * Proving that the machine at a URL is the provider it claims to be.
 *
 * `?host=` and `?peer=` both name a machine in a link, and the client then
 * reads the provider address out of that machine's own `/health`. That is a
 * claim checking itself. A hostile host can never be PAID, because settlement
 * goes to a registered address on chain, but it receives the prompt and the
 * partial answer, and the prompt is the guest's data.
 *
 * So before anything is sent, the host is asked to sign a nonce this browser
 * chose. Only the key the registry pays can produce that signature.
 *
 * The message MUST match `src/attest.ts` `controlMessage` byte for byte. It is
 * duplicated rather than imported because `web/` is a separate package that
 * already keeps its own copy of the chain and the ABI, and both copies are
 * pinned by a test asserting the exact string.
 */
export function controlMessage(c: { registry: string; chainId: number; address: string; url: string; nonce: string }): string {
  const norm = (s: string) => String(s).trim().toLowerCase();
  return [
    'DinnerNode control',
    `registry: ${norm(c.registry)}`,
    `chain: ${c.chainId}`,
    `provider: ${norm(c.address)}`,
    // The origin this browser dialed. Without it a hostile host simply relays
    // the challenge to a real provider and returns that provider's signature,
    // and the proof is worth nothing against the only attacker it exists for.
    // The node signs the origin it was reached on, so a relayed answer names
    // the relay's upstream and fails here.
    `url: ${originOf(c.url)}`,
    `nonce: ${c.nonce}`,
  ].join('\n');
}

/** Must derive the same string as `originOf` in `src/attest.ts`. */
export function originOf(url: string): string {
  try {
    return new URL(String(url)).origin.toLowerCase();
  } catch {
    return `https://${String(url).trim().toLowerCase()}`;
  }
}

/** 0x and 64 lowercase hex characters, the only shape a node will sign. */
export function randomNonce(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${[...b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

export class HostNotProven extends Error {}

/**
 * Ask the host at `url` to prove it holds `address`, and check the answer.
 *
 * Throws rather than returning false, because there is exactly one safe
 * response to a host that cannot prove itself and it is to send it nothing.
 * The caller's failover loop treats that like any other unreachable target.
 */
export async function proveControl(
  url: string, address: `0x${string}`, headers: Record<string, string> = {}, timeoutMs = 8000,
): Promise<void> {
  const nonce = randomNonce();
  let signature: string | undefined;
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`challenge returned ${r.status}`);
    signature = (await r.json())?.signature;
  } catch (e: any) {
    // A node too old to answer /challenge fails here, and that is the intended
    // behaviour rather than an upgrade problem to work around: an unprovable
    // host is one that must not receive a prompt.
    throw new HostNotProven(`${url} did not answer the identity challenge (${e?.message ?? e})`);
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new HostNotProven(`${url} returned no usable signature`);
  }
  const ok = await verifyMessage({
    address,
    // Built from the URL WE dialed, never from anything the host returned.
    message: controlMessage({ registry: ADDR, chainId: monadTestnet.id, address, url, nonce }),
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!ok) throw new HostNotProven(`${url} claims to be ${address.slice(0, 10)}… and cannot prove it`);

  // Proving control of the key is not the same as being a provider the
  // registry knows. Both are required: the first says the machine is who it
  // says, the second says the chain will pay it for what it serves.
  //
  // Retried, and the failure is deliberately NOT HostNotProven. A public RPC
  // having a bad minute is not a host failing to prove itself, and collapsing
  // the two would skip every healthy node in the list on an unrelated fault.
  let active: boolean | null = null;
  for (let attempt = 0; attempt < 3 && active === null; attempt++) {
    try {
      const p = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'getProvider', args: [address] }) as { active: boolean };
      active = !!p?.active;
    } catch (e) {
      if (attempt === 2) throw new Error(`could not reach the registry to check ${address.slice(0, 10)}…: ${(e as any)?.shortMessage ?? (e as any)?.message ?? e}`);
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!active) throw new HostNotProven(`${address.slice(0, 10)}… is not an active provider on chain`);
}
