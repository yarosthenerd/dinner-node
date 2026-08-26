import { account, readProvider, sendChecked } from './_lib.js';

// Registration used to hang off a catch around the read: any RPC blip made a
// health poll send a transaction, from an unauthenticated GET, with no
// maxFeePerGas cap and a 500000 gas limit that Monad charges in full. A public
// endpoint that spends the house wallet on failure is a denial-of-wallet.
//
// Now a read failure reports degraded and sends nothing. Registration happens
// only on a successful read that says the provider is genuinely inactive, at
// most once per instance per cooldown, and never concurrently.
const RATE = BigInt(process.env.CLOUD_RATE_PER_MILLION ?? '33530000000000000000');
const MODEL = 'cloud-mock-7b (hosted)';
const HW = 'Vercel serverless cloud kitchen';
const REGISTER_COOLDOWN_MS = 10 * 60_000;

let lastRegisterAt = 0;
let registering = null;

async function ensureRegistered() {
  const now = Date.now();
  if (registering) return registering;
  if (lastRegisterAt + REGISTER_COOLDOWN_MS > now) return null;
  lastRegisterAt = now;
  registering = sendChecked('registerProvider', 'registerProvider', [MODEL, HW, RATE], 250000n)
    .catch((e) => { console.error('registerProvider failed:', (e && e.message) || e); return null; })
    .finally(() => { registering = null; });
  return registering;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let p;
  try {
    p = await readProvider(account.address);
  } catch (e) {
    // Read failed. We do not know whether we are registered, so we do not pay
    // to find out.
    return res.status(200).json({
      provider: account.address, model: MODEL, kind: 'mock',
      registered: 'unknown', degraded: String((e && e.message) || e),
    });
  }

  // Re-register when inactive OR when the on-chain rate has drifted from the
  // configured one. Gating on `!p.active` alone meant a rate change could never
  // reach the chain: the provider was already active, so registerProvider was
  // never called again and the contract kept billing the old rate. The
  // 2e18 -> 2.67e19 raise was silently a no-op in production for exactly this
  // reason. registerProvider overwrites in place (DinnerNode.sol:39) and the
  // deployed ABI offers no setRate, so a re-register is the only mechanism.
  // REGISTER_COOLDOWN_MS still bounds this to one attempt per instance per ten
  // minutes, so a persistently failing write cannot loop on the house wallet.
  if (!p.active || p.ratePerMillion !== RATE) {
    const sent = await ensureRegistered();
    // Answer from the post-write record, not the pre-write one. The old code
    // replied from `p` as read before registering, so the first caller to hit a
    // cold instance was told registered:false and rate "0" even though the
    // write had just landed. Only re-read when a write actually happened.
    if (sent) p = await readProvider(account.address).catch(() => p);
  }

  res.status(200).json({
    provider: account.address, model: MODEL, kind: 'mock',
    registered: p.active, ratePerMillion: String(p.ratePerMillion),
  });
}
