// Guest faucet for the testnet demo.
//
// Threat model. This endpoint spends the house wallet on request from an
// unauthenticated caller, so it is drainable by construction unless the amount
// it can dispense in total is bounded by something the caller cannot forge.
// The in-memory cooldown below is best effort only: on Vercel the module scope
// is per serverless instance and resets on cold start, so it slows a single
// looping client and stops nothing else.
//
// The two controls that actually bound loss are on-chain and therefore global:
//
//   HOUSE_FLOOR - refuse to send once the house wallet drops to the floor.
//   Total dispensable value is (house balance - floor), not the wallet.
//
// That is the only real bound. RECIPIENT_MAX below is NOT a second one: an
// attacker forwards the grant out in one cheap transfer and requests again
// with the same address, and fresh addresses are free anyway. What
// RECIPIENT_MAX actually does is stop an honest returning guest re-triggering
// the faucet, which is worth having but is not a security control.
//
// The floor is also a soft floor. The balance read and the send are not
// atomic, so N concurrent instances all read the same pre-drain balance and
// the wallet can undershoot by up to N * AMOUNT.
//
// This endpoint must not survive to mainnet in any form, and TOPUP_DISABLED is
// not the gate: it is an environment variable, and a deploy that forgets to
// set it is a one-variable mistake with regulatory consequences. Delete the
// file before a mainnet key exists in the same project.
// See SECURITY_REVIEW.md section 4.

import { createPublicClient, createWalletClient, defineChain, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const chain = defineChain({
  id: 10143, name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});

// Must lift a guest holding nothing to above the cost of one full order
// (0.30 escrow + ~0.06 gas), or a grant arrives that still cannot buy anything.
// Re-derived when the node began billing reasoning tokens, which tripled the
// escrow a long job needs.
const AMOUNT = parseEther(process.env.TOPUP_AMOUNT ?? '0.5');
// Must sit ABOVE TOPUP_TRIGGER in web/src/App.tsx (0.4), and above
// TOPUP_TRIGGER + AMOUNT (0.9) or a guest topped up from just under the
// trigger lands over the ceiling and is refused on their next order.
const RECIPIENT_MAX = parseEther(process.env.TOPUP_RECIPIENT_MAX ?? '1.0');
// Unchanged, but it now buys fewer guests: at 0.5 per grant a 2.5 MON house
// balance dispenses about 4 grants above the floor rather than about 13.
// Refilling the house wallet is the answer, not lowering the amount, because
// an amount below one full order is a grant that cannot buy anything.
const HOUSE_FLOOR = parseEther(process.env.TOPUP_HOUSE_FLOOR ?? '0.5');
const COOLDOWN_MS = 60_000;
const REFUSAL_COOLDOWN_MS = 5_000;

const lastByAddress = new Map();
const lastByIp = new Map();

// The maps are unbounded otherwise, and an attacker cycling addresses is
// exactly the caller that grows them.
const sweep = (m, now) => {
  if (m.size < 5000) return;
  for (const [k, t] of m) if (t + COOLDOWN_MS <= now) m.delete(k);
};

const callerIp = (req) => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
};

export default async function handler(req, res) {
  // Structural gate, stated rather than implied. `chain` above is hardcoded to
  // testnet, so this endpoint physically cannot dispense mainnet value without
  // someone editing the file. This assertion makes that a decision rather than
  // a happy accident, and it is a legal control, not a config default.
  if (chain.id !== 10143) {
    return res.status(503).json({ error: 'faucet is testnet-only' });
  }
  if (process.env.TOPUP_DISABLED === '1') {
    return res.status(503).json({ error: 'faucet disabled; fund the guest wallet yourself' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const address = (req.query && req.query.address) || '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: 'bad address' });

  const now = Date.now();
  const key = address.toLowerCase();
  const ip = callerIp(req);
  sweep(lastByAddress, now);
  sweep(lastByIp, now);
  if ((lastByAddress.get(key) || 0) + COOLDOWN_MS > now || (lastByIp.get(ip) || 0) + COOLDOWN_MS > now) {
    return res.status(429).json({ error: 'the kitchen is busy, try again in a minute' });
  }

  if (!process.env.HOUSE_PK) return res.status(503).json({ error: 'faucet unconfigured' });

  try {
    const account = privateKeyToAccount(process.env.HOUSE_PK);
    const pub = createPublicClient({ chain, transport: http() });

    const [guestBalance, houseBalance] = await Promise.all([
      pub.getBalance({ address }),
      pub.getBalance({ address: account.address }),
    ]);

    // Already funded. Not an error for the caller, and not a reason to spend.
    //
    // A refusal still costs two eth_getBalance calls and a function
    // invocation, so a caller that always fails this check would be unmetered
    // forever. Short refusal-side cooldown closes that without locking a
    // legitimate guest out for the full minute.
    if (guestBalance >= RECIPIENT_MAX) {
      lastByIp.set(ip, now - COOLDOWN_MS + REFUSAL_COOLDOWN_MS);
      return res.status(200).json({ ok: false, reason: 'already funded', balance: guestBalance.toString() });
    }
    if (houseBalance < HOUSE_FLOOR + AMOUNT) {
      lastByIp.set(ip, now - COOLDOWN_MS + REFUSAL_COOLDOWN_MS);
      return res.status(503).json({ error: 'faucet is empty' });
    }

    // Claim the cooldown only once the request is going to spend, so a refusal
    // above does not lock a legitimate guest out for a minute.
    lastByAddress.set(key, now);
    lastByIp.set(ip, now);

    const wal = createWalletClient({ account, chain, transport: http() });
    const hash = await wal.sendTransaction({
      to: address, value: AMOUNT, gas: 30000n, maxFeePerGas: 2000000000000n,
    });
    // Receipt checked, like every other write in this layer. A transfer to a
    // contract whose receive() exceeds the 9000 gas stipend reverts, burns the
    // full 30000 limit, and never raises the recipient's balance, so reporting
    // ok:true would let the same caller loop indefinitely on a real cost.
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') {
      return res.status(502).json({ ok: false, reason: 'transfer reverted', hash });
    }
    res.status(200).json({ ok: true, hash });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
