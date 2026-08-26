# DinnerNode: your idle PC pays for dinner.

Rent idle consumer hardware to serve local LLM inference. Providers stream tokens;
requesters pay per token, **settled on Monad every ~2 seconds**.

**Live:** https://web-opal-sigma-55.vercel.app · **Contract:** [0xaF2c…3A92](https://testnet.monadvision.com/address/0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92) · Monad testnet (10143)

Testnet only. MON here has no monetary value. See [terms](web/public/terms.html) and
[acceptable use](web/public/acceptable-use.html).

## Why Monad
One 60-second answer is roughly 30 settlement transactions, roughly 1.9M gas. What that
costs on Ethereum depends entirely on the gas price and the ETH price on the day: at
0.6 gwei and $2,258 ETH it is about $2.65, and at 20 gwei and $3,000 ETH it is about $114.
On Monad it is fractions of a cent under any of those assumptions. The point is not a single
headline number, it is that per-second post-pay micropayments only become a viable trust
model on a chain with 10k TPS and 400ms blocks, where the settlement cost stays negligible
regardless of what the market is doing.

## Protocol (DinnerNode.sol)
`registerProvider(model, hw, rate)` → `deposit()` → `openJob(provider, budget, promptTag)` →
`settle(jobId, Δtokens)` @ ~2 Hz → `closeJob / withdraw / refund`.
Trust: post-pay per second, escrow exhaustion auto-closes.

**Known defect in the deployed contract.** `DinnerNode.sol`, the version currently live,
accepts any `tokensDelta` a provider passes to `settle`, capped only by the remaining escrow.
A single call can therefore take the whole escrow for zero work. Bounded per-settlement loss
is a property of `contracts/src/DinnerNodeV2.sol`, which locks the rate at job open and caps
each settlement by the tokens the provider could plausibly have produced since the last one.
**V2 is written but not deployed. Roadmap.** Until it ships, the guest's worst case is loss of
the full escrow for a job, not one settlement.

## Privacy: what the chain actually sees
Prompt text never touches the chain. What is written, permanently and publicly, is a
**salted keccak256 commitment** of the sanitized prompt plus **the guest's wallet address**.
The address is `msg.sender` and is also an indexed topic on `JobOpened`, so guests are
identified on chain by wallet address, not by a pseudonym.

The salt is 32 random bytes per job, generated in the browser, never stored and never sent.
After that the commitment cannot be checked against a candidate prompt by anyone, which is
what makes it functionally unlinkable. The earlier construction hashed the prompt against a
stable per-user value and was brute-forceable from the public event; that is fixed.

The provider sees the sanitized prompt in plaintext, because a model cannot answer text it
cannot read. Client-side PII sanitization (`web/src/lib/engram-sanitizer.ts`) is regex pattern
matching, best-effort, and not a guarantee.

### What is stored in your browser
All local, none of it sent anywhere by us. The per-job commitment salt is not in this list
because it is never stored at all: it is generated, used to build the hash, and discarded.

| Key | Store | Holds | Cleared |
|---|---|---|---|
| `dn_pk` | `localStorage` | the generated guest wallet private key | never, until you clear site data |
| `dn_sessions` | `localStorage` | your session history: the **sanitized** prompt, the answer, job id and cost | never, until you clear site data |
| `dn_topped` | `sessionStorage` | a flag recording that the faucet was already called for this tab | on tab close |
| `dn_engram_*`, `dn_job_binding`, `dn_session_nonce` | `sessionStorage` | any behaviour engrams and their job binding | on job close, tab close, and on a 30 minute TTL |

`dn_sessions` is the one to know about: it survives a browser restart, holds the 20 most recent
sessions, and anyone with access to that browser profile can read your past prompts and answers.
It stores the sanitized prompt rather than the raw one, so whatever the sanitizer caught is not
in there either. Measured recall is well short of complete, though, so assume bare names,
non-Latin text and short number sequences are still in it. There is no server-side copy.

The accurate one-liner: **the chain sees a salted hash and the payer's address; the provider
sees the prompt; your browser keeps the history.**

### ZK: roadmap, not load-bearing
`DinnerZK.sol` is deployed at `0x1D6f…c8A0` for anonymous paid-guest ratings, and the
Semaphore packages are in `web/package.json`, but nothing in the shipped app calls either.
No ZK proof is generated, submitted, or relied on in the current build, and the ZK layer
provides no anonymity today. Roadmap: Semaphore group membership wired to the ratings
contract, on-chain verifier, Brevis ZK coprocessor, Phala TEE confidential inference,
zkML proof-of-inference.

## Real vs. demo
Real: the registry, escrow, and settlements; laptop inference via ollama; prompt commitments;
cloud failover; engram sanitization. Discovery is off-chain.

Demo: the hosted cloud kitchen at `web/api/p/job.js` does not run a model. It streams a fixed
pre-written passage word by word, echoing the first 50 characters of the prompt. Its
settlements are genuinely on-chain, so the payment rail is real while the inference behind
that one endpoint is not. The simulated hosting card is labeled as such in the UI.

Built with monskills on Monad testnet. *Every token is a tip.*
