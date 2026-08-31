# DinnerNode: your idle PC pays for dinner.

Rent idle consumer hardware to serve local LLM inference. Providers stream tokens;
requesters pay per token, **settled on Monad as the work becomes worth settling**.

**Live:** https://dinnernode.xyz · **Contract:** [0x2881…EbCd](https://testnet.monadvision.com/address/0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd) · Monad testnet (10143)

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
**salted keccak256 commitment** of the prompt as sent plus **the guest's wallet address**.
Client-side sanitization runs on the site's own order path and nowhere else: the LAN guest
page a node serves, and `/v1/chat/completions`, both commit and send the prompt exactly as
the caller wrote it.
The address is `msg.sender` and is also an indexed topic on `JobOpened`, so guests are
identified on chain by wallet address, not by a pseudonym.

The salt is 32 random bytes per job, generated in the browser, never stored and never sent.
After that the commitment cannot be checked against a candidate prompt by anyone, which is
what makes it functionally unlinkable. The earlier construction hashed the prompt against a
stable per-user value and was brute-forceable from the public event; that is fixed.

The provider sees the prompt in plaintext, sanitized on the site's order path and unmodified
on the other two, because a model cannot answer text it cannot read. Client-side PII sanitization (`web/src/lib/engram-sanitizer.ts`) is regex pattern
matching, best-effort, and not a guarantee.

### What is stored in your browser
All local, none of it sent anywhere by us. The per-job commitment salt is not in this list
because it is never stored at all: it is generated, used to build the hash, and discarded.

| Key | Store | Holds | Cleared |
|---|---|---|---|
| `dn_pk` | `localStorage` | the generated guest wallet private key, used when no wallet is connected | never, until you clear site data |
| `dn_wallet_rdns` | `localStorage` | which browser wallet you last connected, so the page can reconnect without asking | on disconnect, or when you clear site data |
| `dn_sessions` | `localStorage` | your session history: the **sanitized** prompt, the answer, job id and cost. **Written only if you switch history on, which is off by default** | when you switch history off, the clear control, or site data |
| `dn_keep_history` | `localStorage` | whether you switched history on. Absent until you do | when you switch it off, or clear site data |
| `dn_zk_identity` | `localStorage` | your Semaphore identity secret, used to sign anonymous provider ratings. It is a long-lived private key | never, until you clear site data |
| `dn_topped` | `sessionStorage` | a flag recording that the faucet was already called for this tab | on tab close |
| `dn_engram_*`, `dn_job_binding`, `dn_session_nonce` | `sessionStorage` | any behaviour engrams and their job binding | on job close, tab close, and on a 30 minute TTL |

`dn_sessions` is the one to know about, and it is **off unless you switch it on**. By default the
orders on the receipt live in the page and close with the tab. Switched on, they survive a browser
restart, hold the 20 most recent sessions, and anyone with access to that browser profile can read
your past prompts and answers; switching it back off deletes them. Keeping them is not necessary to
serve an order, which under ePrivacy Article 5(3) is what makes it a consent question rather than a
delete-afterwards one. It stores the sanitized prompt rather than the raw one, so whatever the
sanitizer caught is not in there either. Measured recall is well short of complete, though, so
assume bare names, non-Latin text and short number sequences are still in it. There is no
server-side copy.

The accurate one-liner: **the chain sees a salted hash and the payer's address; the provider
sees the prompt; your browser keeps nothing unless you ask it to.**

### ZK: verified on chain, and anonymous only once the group is large
`DinnerRatings.sol` is deployed at `0xeb0d…d87f`. Semaphore proofs are verified **on
chain** by the deployed verifier, not in the browser, so a rating that does not carry a
valid membership proof is not recorded. `join(jobId, commitment)` requires a closed job
belonging to the caller with `paid > 0`, and burns that job, so a rating is backed by
work actually paid for.

Two limits, stated because they are real. `join` is sent by the guest's own wallet, so
the chain links that wallet to its commitment: anonymity comes from group size and
nothing else, and the group currently has **zero members**. And `rate` is deliberately
relayable, which moves trust to the relayer rather than removing it.

**`DinnerZK.sol` is retired.** An instance is still deployed at `0x1D6f…c8A0` and cannot
be removed, because it has no owner and no selfdestruct. Nothing calls it and nothing
should: it took a `proofHash` and trusted it, so any address could record any rating
under any nullifier, and its `join` was open to anyone. The source has been deleted from
this repo so it cannot be wired up by mistake. Treat that address as abandoned.

Still roadmap, not built: Brevis ZK coprocessor, Phala TEE confidential inference, zkML
proof-of-inference.

## Calling a node

Two ways in, and they differ in who pays rather than in what runs.

**From the site**, with your own wallet or the burner it generates for you. You
sign `openJob`, the escrow is yours, and the settlement records that you paid
for what you received.

**From any OpenAI client**, if the operator has set `API_KEYS`:

```bash
curl https://node1.dinnernode.xyz/v1/chat/completions \
  -H "authorization: Bearer $DINNERNODE_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"qwen3.8:27b","messages":[{"role":"user","content":"how much is dinner in Belgrade"}],"stream":true}'
```

Streaming and buffered both work, `GET /v1/models` lists what the node answers
to, and the base URL drops into the OpenAI SDK unchanged. Sampling parameters
are accepted and ignored; tools, `n` > 1 and image parts are refused by name
rather than silently dropped.

**What this path does not do, stated because it would otherwise be assumed:**
a caller here holds a key, not a wallet, so the node fronts the escrow from its
own deposit and settles against itself. The chain still records what was served
and what it cost, checkpoint by checkpoint. It does not record who paid. For
the same reason these jobs earn no on-chain reputation: `_credit` excludes
self-dealt jobs from `tokensServed`, deliberately, because discovery ranks on
it. The endpoint is off unless the operator sets keys, and capped by
`V1_DAILY_TOKENS`.

`GET /provider/models` publishes the same node in OpenRouter's provider schema:
price per token from the market band, context and output ceiling, and measured
generation capacity. It reports `is_ready: false` until an operator opts in,
and `compliance.zdr: false`, because operators are asked not to retain prompts
and an ask is not an attestation.

## Who receives your prompt

Discovery is off chain: the registry knows a provider exists and what it
charges, not where to reach it. A node announces its URL, and that
announcement is signed. Discovery issues a single-use nonce, the node signs a
claim naming the registry, the chain, itself, its URL and its model, and an
unsigned announcement is refused. Before the browser sends a prompt to a
machine named by `?host=` or `?peer=`, it makes that machine sign a nonce it
chose and checks the registry still calls it active.

That proves the machine is the provider it claims to be. It does not say who
that provider is, and a provider can put itself in a link, so the interface
still tells you which machines a link named.

## Real vs. demo
Real: the registry, escrow, and settlements; laptop inference via ollama; prompt commitments;
engram sanitization; mid-answer migration between two real nodes, verified on chain.
Discovery is off-chain.

Removed: the hosted cloud kitchen. It streamed a fixed pre-written passage while settling
real testnet MON, so the payment rail was real and the inference behind that one endpoint
was not. Deleting it costs the site its failover target until discovery serves reachable
peers, which is the honest trade: an order against a dead node now fails and returns its
escrow instead of charging for text no model produced.

Built with monskills on Monad testnet. *Every token is a tip.*
