# DinnerNode: your idle PC pays for dinner.

Rent idle consumer hardware to serve local LLM inference. Providers stream tokens;
requesters pay per token, **settled on Monad as the work becomes worth settling**.

**A job survives the node serving it.** When a provider dies mid-answer, the answer
continues on another node from a signed checkpoint, the guest signs nothing, and the two
providers are paid for disjoint ranges of the same answer. That is verified on chain, not
argued for: see the receipt under Protocol.

**Live:** https://dinnernode.xyz · **Registry:** [0x7E98…423c](https://testnet.monadvision.com/address/0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c) (`DinnerNodeV2`, deployed 2026-09-03) · Monad testnet (10143)

Testnet only. MON here has no monetary value. See [terms](web/public/terms.html) and
[acceptable use](web/public/acceptable-use.html).

## Run a node

```
git clone <repo> && cd dinnernode
./dinnernode          # Linux, macOS
dinnernode.cmd        # Windows, or double-click it
```

Either launcher installs dependencies, runs the setup wizard, and serves. The
wizard is idempotent and is also the doctor: `npm run doctor` re-runs every
check and changes nothing.

**The one prerequisite is node 20 or newer.** Everything here runs on it, so a
machine without one cannot be repaired by anything in this repo; both launchers
stop with the install command for that platform. From there the wizard handles
the rest: it offers to install ollama, starts it when it is installed and not
serving, sizes a model against the memory actually present and offers to pull
one, generates the node wallet, asks the faucet for gas, and fetches
cloudflared. Every one of those is a confirm, and declining any of them leaves
the machine exactly as it was.

Both launchers are shims. Dependency freshness lives in
`scripts/deps-stale.mjs` and the public tunnel in `src/tunnel.ts`, so the two
platforms cannot drift apart in shell script.

A node with no public URL serves its own LAN and earns nothing from the
network, and setup now says that in those words rather than printing "ready"
over it. Giving it one takes no Cloudflare account: setup offers to fetch the
cloudflared binary into `bin/`, and the node opens a quick tunnel with it at
boot. Decline, and the node still serves your LAN. Set `PUBLIC_URL` instead for
a hostname that survives a restart, or `TUNNEL=off` to never open one.

## Why Monad
One 60-second answer is roughly 30 settlement transactions, roughly 1.9M gas. What that
costs on Ethereum depends entirely on the gas price and the ETH price on the day: at
0.6 gwei and $2,258 ETH it is about $2.65, and at 20 gwei and $3,000 ETH it is about $114.
On Monad it is fractions of a cent under any of those assumptions. The point is not a single
headline number, it is that per-second post-pay micropayments only become a viable trust
model on a chain with 10k TPS and 400ms blocks, where the settlement cost stays negligible
regardless of what the market is doing.

## Protocol (DinnerNodeV2.sol)
`registerProvider(model, hw, rate, maxTokensPerSecond)` → `deposit()` →
`openJob(provider, budget, promptTag, requireCheckpoints)` →
`settle(jobId, Δtokens, prefixHash, prefixTokens, billedTotal)` @ ~2 Hz →
`closeJob / withdraw / refund`, with `reassignWithAuth` in between when a node dies.
Trust: post-pay per second, bounded per settlement, escrow exhaustion auto-closes.

**What the deployed contract bounds.** `contracts/src/DinnerNodeV2.sol` is what is
live at `0x7E98…423c`. It locks the rate at job open and caps each settlement two ways:
by `elapsed × maxTokensPerSecond`, so a provider cannot bill for tokens it had no time to
produce, and by the published checkpoint, so a replacement provider that checkpoints the
whole answer still has only the unpaid tail as headroom. The guest's worst case is one
settlement interval rather than the whole escrow, and
`test_worst_case_loss_is_one_settlement_interval` is the test that says so.

**The superseded instance.** `contracts/src/DinnerNode.sol` at
[0x2881…EbCd](https://testnet.monadvision.com/address/0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd)
accepted any `tokensDelta` capped only by remaining escrow, so a single call could take the
whole escrow for zero work. It stays callable forever and nothing in this repo points at it;
it is the address to reach for only to `withdraw` or `refund` value left behind in it.

**Mid-answer migration is live on this instance.** `reassignWithAuth` carries an EIP-712
authorisation the guest signs at order time, submitted by the INCOMING provider, so a node
dying at 3am does not wait for anyone to approve a wallet prompt. `DOMAIN_SEPARATOR()`
answers `0x5940d1d2…`, where the superseded instance reverted. Verified against the two
live nodes on job#12: two providers paid for disjoint token ranges of one answer, each at
its own rate, and the guest's nonce did not move.

The first visible token forces a job's first settlement, so the checkpoint that
makes this split possible is on chain within about one settle round trip rather
than waiting for the value trigger. Measured: 244 ms, against 60,298 ms before
the rule existed. It costs the provider one extra settlement per job, and
`CHECKPOINT_FIRST_TOKENS=0` declines to pay it. The claim is bounded to match:
two providers are paid for disjoint ranges **once a checkpoint is on chain**,
and a node killed in the moments before its first one publishes nothing.

```
node1(qwen)   settled  +812 tok  0.0271 MON   checkpoint tokens=67
HANDOVER      node1 -> node2
node2(llama)  settled   +24 tok  0.00014 MON  checkpoint tokens=91
HANDOVER      node2 -> node1
node1(qwen)  settled +1675 tok  0.0101 MON
```

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
  -d '{"model":"qwen3.6:35b-a3b","messages":[{"role":"user","content":"how much is dinner in Belgrade"}],"stream":true}'
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

## Verifying the claims in this file

Nothing here asks to be taken on trust. Every count below was re-run on 2026-09-03.

| What | Command | Result |
|---|---|---|
| Daemon, chain and pricing logic | `npx vitest run` | 258 tests, 17 files |
| Browser app and streaming | `cd web && npx vitest run` | 135 tests, 7 files |
| Contracts | `cd contracts && forge test` | 72 tests, 5 suites |
| Types | `npm run typecheck` | clean |
| The failover, against the two live nodes | `node scripts/auth-takeover-e2e.mjs` | 12 of 12, real chain |
| The failover when the node is **killed** mid-answer | `node scripts/kill-takeover-e2e.mjs` | 16 of 16, incl. the payment split |
| What a node is actually doing right now | `curl https://node1.dinnernode.xyz/health` | live price band, model, GPU |
| The status page arithmetic | `npx vitest run src/__tests__/canary-stats.test.ts` | 17 tests |
| What the nodes have actually been doing | `npm run canary -- --once` | uptime, error rate, p50/p90/p99 |

`kill-takeover-e2e.mjs` is the one worth running to understand the project. It
SIGKILLs the node serving a job while the client is still reading, and then
checks that the stream broke rather than ended, that the checkpoint outlived the
process on chain, that the replacement resumed from it, that the guest signed
nothing, and that the two providers were paid for disjoint ranges. It measured
the cost to the person waiting, which had never been measured: **9 ms from death
to handover, 36 ms from death to the first new token.** It refuses to run
without an explicit `KILL_PID` or `KILL_CMD`.

## Reliability, measured rather than claimed

`npm run canary` probes every reachable node on an interval, keeps the samples,
and serves what it measured at `/status` as JSON and at `/` as a page: uptime,
error rate, worst continuous outage, and p50/p90/p99, per node and over 1h, 24h
and 7d windows. `npm run canary -- --once` prints the same table and exits.

Two kinds of probe, kept apart in the output because they cost different things.
**Liveness** is `GET /health`, free, and on by default. **Answer** probes measure
time to first visible token over `/lanjob`, which is the number a buyer feels,
and they are off by default because that endpoint opens a job the NODE pays for:
every probe spends the operator's own gas. Turn them on with
`CANARY_ANSWER=lanjob`, and only beside the nodes, since `/lanjob` is LAN-gated.

The numbers are deliberately plain. Percentiles are nearest-rank over the
samples held, with no interpolation, so every figure on the page is a value some
probe actually took, and the sample count sits beside it. A failed probe is
excluded from the latency percentiles and counted in the error rate, because a
timeout is not a slow response and averaging it in makes a dead node look merely
sluggish.

What it does not claim travels in the payload itself, under `caveats`, so a
renderer cannot quietly drop it: one vantage point, on the operator's own
network, watching the operator's own machines. It cannot see an outage between
a guest and the tunnel, and a node answering `/health` while serving nothing
reads as up.

`/health` publishes the whole price derivation rather than a number: the ten-provider
OpenRouter band for the exact weights being served, the policy and discount applied to it,
and where that lands us against each one. The price is resolved at startup from that band,
so it is not a figure typed into this README.

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
