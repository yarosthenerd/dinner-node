# DinnerNode roadmap

Single source of truth. Supersedes `.context/HANDOFF.md` section 14, which is
stale and marks several things done that never existed. Read alongside:

- `SNAPSHOT.md`: what is built and what is broken, with evidence.
- `.context/REFRAME.md`: positioning and sequencing rationale.
- `SECURITY_REVIEW.md`: the security checklist and the pre-mainnet gate.

Legend: `[x]` done and verified, `[~]` done but not verified against a live run,
`[ ]` open.

Last updated 2026-09-02. Now items 0 through 4 are closed and 7 is struck.
**The tunnel blocker is gone:** all three named tunnels are installed and
running, and both nodes announce public hostnames, so item 5's stated blocker
no longer exists. Item 5 itself is most of the way there and is now blocked on
a contract redeploy rather than on DNS. See the rewritten item below, the DNS
section, and "Found and fixed 2026-09-02" for two live defects closed tonight.

**What this file still does not contain is a single demand-side item.** See
"What this roadmap lacks" at the end, added 2026-09-02.

---

## Status

P0 is closed. Every item the 2026-08-25 sessions opened has been fixed and
verified: three live serverless exposures, the engram and privacy layer, a
plaintext prompt path in the CLI, and thirteen further defects the verification
agents found, several of which the fixes themselves had introduced. The root of
the repo now typechecks, and `web/` has 130 regression tests. The root has 192,
measured 2026-08-29.

**Status of the deployment, corrected 2026-08-31.** The 2026-08-28 late
session's work is committed and live on both halves. The daemons picked it up
at the 2026-08-30 reboot, which is how the `/lanjob` faucet closed, and this
session committed the tree and deployed `web/`. See `SNAPSHOT.md` section 0 of
the 2026-08-31 snapshot for the probes.

The tree is deployed and the site is live at `dinnernode.xyz` on v2. **There is
no serverless surface left at all:** `web/api/` is an empty path, because
`fd86fb8` deleted the cloud kitchen and this session deleted the faucet. Every
transaction a guest causes is now signed by the guest's own key or by a node
the operator runs on a machine, and none by a key sitting in Vercel's
environment.

**The next move is not more hardening.** It is making the differentiator
demonstrable and the price honest. See "Now" below.

---

## DECIDED 2026-08-28 (night): the session shape

The product is a **session held against one node**, not a one-shot call. This
follows from A1 and it is not a preference:

- Cold prefill of a 12k context costs 20.9s. The same prefix with a new tail
  costs **1.36s**. An agent that holds its context pays the big prefill once
  and about a second a step after that.
- Cold TTFT at 95k is 274 seconds, so one-shot long-context serving is not a
  product on this hardware at any price.
- Generation ramps as the node warms: 20 tok/s on the first request after a
  load, then 28, 39, 43, reaching about 58 in steady state. A node that serves
  one request and goes cold never reaches its own throughput.

**Everything below is read in that light.** The session job mechanic already
exists, so the architecture matches the decision; what does not match yet is
the configuration, the pricing and the failover story.

### What the decision commits us to

- [x] Pin one context size. Done 2026-08-28: `CONTEXT_TOKENS` 16384 -> 32768 in
      `.env`. **The nodes must restart to pick it up.** Changing `num_ctx`
      forces a model reload, so a node that adapts context per request pays 16
      to 114 seconds repeatedly. One pinned size is the only workable shape.
- [ ] **65536 is the real target and needs `OLLAMA_NUM_PARALLEL=1` first.**
      95k loaded and ran here without OOM, so context is a configuration
      question rather than a hardware ceiling, but ollama divides the context
      across parallel slots and the machine has 11GB free. Measure before
      raising it again.
- [ ] **`OLLAMA_MAX_LOADED_MODELS=1` breaks the session shape outright. Needs
      sudo, so it is the one item here left undone.** Confirmed live 2026-08-28:
      after node 2 restarted, `ollama ps` showed only `llama3.2:1b` and node 1's
      22GB model had been evicted. Worked around by restarting node 1 last so
      the public provider is resident, which is a restart-order dependency, not
      a fix. The command:
      `sudo systemctl edit --full ollama` and set `OLLAMA_MAX_LOADED_MODELS=2`,
      or drop it in `/etc/systemd/system/ollama.service.d/override.conf`, then
      `sudo systemctl daemon-reload && sudo systemctl restart ollama` and
      restart node 1 to reload its model. Both
      nodes share one ollama and serve different models, so every alternation
      between node 1 and node 2 EVICTS a 22GB model and the next request pays a
      full reload. This is where the reload times in the A1 sweep came from.
      Raise it to 2. Node 2's model is 1.3GB and there is room.
- [x] **`keep_alive` fixed 2026-08-28.** The systemd `OLLAMA_KEEP_ALIVE=-1` was
      a red herring: `src/host.ts:818` and `src/engines.ts:50` send `keep_alive`
      per request, which overrides the server default, and it defaulted to
      `30m`. So a node went cold between sessions and paid a reload plus the
      warm-up ramp. Now `24h` in both env files, confirmed in `ollama ps`. Not
      `-1`, because a string is parsed as a Go duration and `"-1"` has no unit.
- [ ] **Keep a node warm on purpose.** A cold node is 3x slower for its first
      requests, which lands entirely on the first guest of the session. Cheapest
      version is a periodic one-token self-request when idle. Weigh it against
      the idle-PC premise: a node that never sleeps is not an idle PC.

### The conflict this decision forces us to resolve

Free input, mid-answer migration and the session shape cannot all three be
true as currently built.

We charge zero for input. `reassign` hands the replacement a COLD cache, so on
a 95k session it performs 207 seconds of prefill it cannot bill for. The better
the session shape works, the worse the failover economics get, because the
value of a warm cache is exactly what a handover destroys.

**Proposed resolution, not yet built:** bill COLD prefill, keep CACHED prefill
free. That is what commercial providers already do with cached-input pricing,
so a buyer reads it without explanation, and it aligns price with cost, since a
cached prefill genuinely costs the node almost nothing while a cold one is real
GPU seconds. It closes three things at once:

- the P2 prefill hole, because a 30k cold prompt is no longer free
- the replacement provider's unpaid prefill on a handover
- the pricing claim, which sharpens from "free input", which is a subsidy, to
  "we do not bill you for context you have already sent", which is a product

**Open question before building it:** input tokens would have to ride in the
`billed` count the way reasoning already does, which needs no contract change,
but `maxTokensPerSecond` is 400 on node 1 and a 31k prefill in 63s is 490
tok/s. The throughput bound would clamp it. Settle that before writing code.

## Now: the next two weeks

Ordered. Everything here is ahead of every remaining defect in this file.

0. ~~**Ship the 2026-08-28 late tree.**~~ Done 2026-08-31, and not in the
   order this item planned. The 2026-08-30 reboot restarted all four units off
   the working tree, so the node half shipped itself two days before the
   commit: `/lanjob` through the tunnel now answers 403, `/challenge`,
   `/provider/models` and `/announce/nonce` all answer, and `/v1/models`
   answers 501 `endpoint_disabled` because no node sets `API_KEYS`. This
   session then committed the tree and deployed `web/`. The ordering hazard
   this item was built around inverted once the nodes answered `/challenge`.
   The lesson is in `SECURITY_REVIEW.md` section 0.1: the faucet fix was
   written on 2026-08-28 and the hole stayed open until a reboot happened to
   pick it up.

1. ~~**Deploy the current tree.**~~ Done 2026-08-26 evening. `web-okskdkmvt`,
   verified against the deployed bundle. The node now also streams reasoning as
   its own frame and bills it as output; escrow and the three faucet constants
   were re-derived around that. See `SNAPSHOT.md` section 6b.
2. ~~**Fill the three ToS placeholders.**~~ Done 2026-08-26. Operator is
   Yaroslav Belkin, an individual; contact `yaros3920@gmail.com`, abuse
   `yaros3920@gmail.com`. No entity is named, because none is formed and GDPR
   Art 13(1)(a) wants the real controller. Swap all three for domain addresses
   when the domain lands.
3. ~~**Decide `TOPUP_HOUSE_FLOOR`.**~~ Done 2026-08-26: floor `0.5`, and
   `TOPUP_AMOUNT` cut 0.25 to 0.15. The floor was never the binding constraint.
   `HOUSE_PK` is also the cloud-kitchen provider key, so the same wallet pays
   about 0.067 MON of settle gas per job at 102 gwei, and a fully spent 0.25
   grant costs the house another 0.34 in gas. Real capacity is about 5 guests
   end to end whatever the floor says. Amount is the lever: 2.5 MON dispensable
   at 0.15 is about 16 grants against 8, and 0.5 held back is about 7 jobs of
   settle gas so the demo does not brick mid-review. Revisit once item 7 splits
   the keys.
4. ~~**Raise `RATE_PER_MILLION` to about 2.67e19.**~~ Done 2026-08-26. It was
   two code defaults, not one environment variable: `src/host.ts:13` and
   `CLOUD_RATE_PER_MILLION` in `web/api/p/health.js:11`, neither set in `.env`.
   `registerProvider` overwrites unconditionally (`DinnerNode.sol:39`) and both
   call sites re-register on start, so the on-chain rate follows the deploy.
   The per-job budget in `web/src/App.tsx` had to move with it: at 2.67e19 the
   old 0.01 MON escrow bought 374 output tokens instead of 5,000, so it is now
   0.05 for about 1,870.
5. **`reassign` between two live providers, from the browser.** The
   load-bearing item. **Rewritten 2026-09-02: the DNS blocker is gone and the
   remaining blocker is a contract redeploy.**

   What is now true. Both nodes are reachable on the public internet at
   `node1.dinnernode.xyz` and `node2.dinnernode.xyz` and both announce those
   hostnames to discovery, so a browser has a failover target for the first
   time. `c1b3f07` built the automatic half: `reassignWithAuth`, an EIP-712
   authorisation the guest signs when they order, carried to the chain by the
   INCOMING provider at the moment of handover, so a node dying at 3am no
   longer waits for somebody to approve a MetaMask prompt. Bounded by a
   deadline, a monotonic reassign counter, a named-or-wildcard provider, and
   `msg.sender == newProvider`. `src/takeover.ts` refuses every reason it can
   find before paying gas. Verified end to end against anvil with two nodes and
   a real registry in `scripts/auth-takeover-e2e.mjs`.

   - [ ] **Redeploy the registry. This is the blocker.** The contract in the
         tree has `reassignWithAuth`; the deployed one at `0x2881…` does not.
         Confirmed 2026-09-02 by calling `DOMAIN_SEPARATOR()` on it, which
         reverts. The client probes for it once and falls back to asking the
         guest for a transaction, so **in production the failover still needs
         the guest awake and at their wallet.** Everything else on this item is
         built and inert until the redeploy.
   - [ ] Automatic failover on stream death, exercised against the two LIVE
         nodes rather than against anvil. Anvil proves the mechanism; it does
         not prove the tunnels, the announce path or the browser's peer
         discovery under a real network failure.
   - [ ] Point the site and both nodes at whatever address the redeploy
         produces, in one pass. Three places carry it today.

   One honest note that survives the redeploy: both nodes run on ONE machine
   under one operator, sharing one ollama. A migration demo between them is
   house-to-house, which is the same criticism item 7 makes of usage figures.
   It proves the mechanism and it does not prove the network.
6. **Record the migration demo.** Start a job, kill the laptop mid-answer, watch
   it continue elsewhere, with an on-chain receipt showing two providers paid
   for disjoint token ranges. Nobody in the competitive set can run this.
7. ~~**Separate the faucet key from the cloud-kitchen provider key.**~~ Moot
   2026-08-28. Both halves are gone: the cloud kitchen was deleted in
   `fd86fb8`, and `web/api/topup.js` was deleted this session. `HOUSE_PK` no
   longer signs anything a guest can trigger. The underlying warning stands in
   a different form: any usage figure produced by the operator's own wallets is
   house-to-house flow, whatever the keys are.
8. **Model list with per-model rates.** Cheapest way to look like a marketplace
   rather than a single-host demo, and it is what the long-tail thesis requires.
9. **Distribution, which is the gap the Darkbloom comparison actually names.**
   Eigen Labs' network went from research preview to 4.5B tokens in four months
   on distribution, not on mechanism: it is a paid provider on OpenRouter, so
   it sits inside a routing table buyers already use. We are in nobody's.
   - [x] **An OpenAI-compatible endpoint on the node.** Done 2026-08-28.
         `POST /v1/chat/completions` streaming and buffered, `GET /v1/models`,
         bearer keys, the OpenAI error envelope on every refusal including the
         admission checks. `src/openai-api.ts` is the wire format and is pure;
         `src/host.ts` keeps the money. Verified end to end against a local
         anvil with a deployed registry, so the settle and close transactions
         in that run were real. See `SNAPSHOT.md` section 1 of the late
         snapshot.
   - [x] The provider catalog they read. Done 2026-08-28: `GET /provider/models`
         in their schema 2.4, from `src/provider-catalog.ts`. Input priced at an
         explicit zero, capacity absent until measured, `compliance.zdr` false,
         `is_ready` false until `PROVIDER_IS_READY=1`.
   - [x] Load-shed with 429 rather than 503 on `/v1`. Their uptime is total
         requests minus 4xx, 429s and geo-blocks, so honest backpressure in the
         old shape counted as downtime.
   - [ ] Apply to be an OpenRouter provider. The form is at
         `openrouter.ai/how-to-list`. Remaining blockers are not code: a public
         hostname, and a way for them to pay us, which needs auto top-up or
         invoicing and therefore an entity. **Corrected 2026-08-29:** the
         hostname blocker is not the nameserver move, which is done. It is the
         tunnels, which are not installed. See the DNS block below.
   - [ ] Decide what the endpoint bills. A caller holds a key, not a wallet, so
         these jobs are fronted from the node's own deposit and settle the node
         against itself. There is no off-chain invoice, no account, and no way
         to charge anyone. Until that exists the endpoint gives tokens away at
         the node's own gas cost, which is fine for a pilot key and is not fine
         for an aggregator listing.
   - [ ] Reputation does not accrue on this path, and the contract is right to
         refuse it. `_credit` excludes self-dealt jobs from `tokensServed` and
         `lifetimeEarned`, discovery ranks on `tokensServed`, and every fronted
         job is self-dealt. So volume through `/v1` is invisible on chain.
         Either the caller opens their own job, or any tokens-served figure has
         to say which path it came through.
   - [ ] `V1_DAILY_TOKENS` is an in-memory brake that resets on restart. It
         limits a runaway client and it is not an accounting system.

One correctness note for the pitch: on the deployed V1 contract, "does not pay
twice" is enforced by the host choosing to settle only what it produced, not by
the contract. Claim "the replacement provider settles only the suffix it
produced, verified against a keccak checkpoint chain", which is true today. Do
not claim contract enforcement until the V2 items below land.

## DNS and tunnels, state on 2026-09-02

**All closed.** Re-audited tonight against live DNS, the running units and the
public endpoints. The three commits that closed this landed after the previous
audit was written, which is why the section above them was stale for two days.

- [x] Move the zone to Cloudflare. `dinnernode.xyz` is delegated to
      `desi.ns.cloudflare.com` and `piers.ns.cloudflare.com`.
- [x] **Install the named tunnels.** Done in `5d8d8fa` and `a987070`. Three
      `cloudflared` processes are running under
      `dinnernode-tunnel-node1.service`, `-node2.service` and
      `-discovery.service`, all active.
- [x] **`node1`, `node2` and `discovery.dinnernode.xyz` resolve and answer.**
      Verified 2026-09-02: all three return 200 in about 100ms.
      `https://node1.dinnernode.xyz/health` serves the qwen node,
      `node2` the llama3.2:1b node, `discovery/providers` lists both.
- [x] **`PUBLIC_URL` is set on both nodes.** Discovery shows node 1 announcing
      `https://node1.dinnernode.xyz` and node 2 `https://node2.dinnernode.xyz`,
      both `source: announce`. The LAN address that blocked item 5 is gone.
- [x] The legal half of the proxy question is settled. Done 2026-08-31, see the
      `<!--email_off-->` markers in `web/public/terms.html`.
- [ ] **Retire `dinnernode-tunnel.service`.** The ngrok unit is still running
      and still holds `litter-unfunded-improvise.ngrok-free.dev` against port
      4173. Nothing announces it any more, so it is dead weight rather than a
      hazard, but it is a second public door onto node 1 that no document
      accounts for. `systemctl --user disable --now dinnernode-tunnel.service`.
- [ ] **Decide the proxy question, on caching grounds only.** The apex and
      `www` are proxied while the migration doc asks for DNS-only. Unchanged
      since 2026-08-29. If the site ever looks stale for reasons the repo does
      not explain, purge the Cloudflare cache before debugging anything.

## Found and fixed 2026-09-02 (night)

Two defects, both live, both found by probing the running nodes rather than by
reading the code. Neither had a ticket, and neither would have surfaced from
the test suite, because both live in the gap between what the code does and
what the machine was doing when it started.

- [x] **The node registered itself on chain as CPU-only, on a machine with an
      RTX 5070 Ti.** `/health` and discovery both served
      `CPU-only | 24 cores | 31GB` while the same process logged
      `first token in 18.5s, 42% on GPU` a minute later. `probeHardware()` ran
      once at module import, systemd started the node at 21:40:22 and the
      NVIDIA kernel module had loaded at 21:40:20.42, so nvidia-smi was not yet
      answering and the probe fell through to the CPU branch. That string is an
      argument to `registerProvider`, so the wrong answer went on chain and
      stayed there: nothing re-probes, so only a restart could fix it.
      **Every buyer-facing description of the network's only real provider said
      CPU-only.** Fixed with `probeHardwareReady` in `src/hardware.ts`: it
      re-probes on an interval while `nvidiaPending()` says this machine looks
      like it has a card whose driver has not come up, bounded at 60 seconds,
      and gives up loudly rather than silently. A machine with genuinely no
      NVIDIA GPU never waits, which is asserted in the tests. `host.ts` calls
      it before `register` rather than at import. 6 tests.
      **The chain still holds the wrong string until node 1 restarts.**
      `registerProvider` overwrites unconditionally, so a restart corrects it.
- [x] **`[announce] 403 nonce unknown, spent or expired`, every four minutes
      since boot.** `src/host.ts` registered two announce timers, both at four
      minutes, microseconds apart. Each fired its own announce; the second
      `/announce/nonce` replaced the first one's outstanding nonce, so the
      first claim always lost. The announcement itself always landed, so this
      cost nothing but a recurring false alarm in the log, which is its own
      kind of expensive: it is the line an operator learns to ignore. Fixed by
      deleting the unconditional second timer. The store was behaving
      correctly and the caller was not, which is now asserted in
      `attest.test.ts`.
- [ ] **Node 2 reports `gpuFraction: null` and `first token in 14.3s` for a
      1.3GB model.** Not chased tonight. It is consistent with the
      `OLLAMA_MAX_LOADED_MODELS=1` eviction already recorded under the session
      decision above: node 2's model is not resident on the GPU. Worth one
      look after that sudo item lands, because 14 seconds to first token on a
      1B model is a number a buyer would notice.

**Not done, and waiting for the operator:** neither fix is live. Both nodes
are running the pre-fix tree. Restarting them is what puts the correct hardware
string on chain and silences the 403:
`systemctl --user restart dinnernode.service dinnernode2.service`

## Open, from the reviews of 2026-08-28 (late)

Everything the four agents raised that was NOT fixed the same night. Each is
worth reading against `SNAPSHOT.md` section 0.

- [ ] **Before setting `API_KEYS` on any node**, the OpenAI path needs its own
      notice. A caller there has no terms, no privacy notice, no processor
      agreement, and no warning that a salted commitment of every prompt goes
      on a public chain permanently, nor that no sanitizer runs on that path.
      Terms 2.1 is also incomplete for it: the on-chain requester is the node,
      not the caller. The legal reviewer's smallest version is a short API
      terms section plus an `x-dinnernode-terms` header and a line in
      `/health`. This is the item that becomes expensive if deferred, because
      the first paying caller creates the record.
- [ ] **Prompts transit Cloudflare by default now**, since a node with no
      `PUBLIC_URL` opens a quick tunnel at boot. `hosting.html` calls
      cloudflared optional and terms 2.7 lists who sees the prompt without
      naming a transit provider. One sentence in each.
- [ ] **`hosting.html` settings table is stale in a way that touches money.**
      It omits `API_KEYS`, `FRONT_BUDGET_MON`, `FRONT_TOPUP_MON`,
      `V1_DAILY_TOKENS`, `LANJOB`, `DATACENTER_COUNTRY` and
      `PROVIDER_IS_READY`, and states `OLLAMA_KEEP_ALIVE` default `30m` where
      both live nodes run `24h`. An operator reading only that page would never
      learn that setting `API_KEYS` lets a stranger spend their deposit.
      `.env.example` now documents all of them and is the source to copy from.
- [ ] **`DATACENTER_COUNTRY` is published unvalidated.** A node can declare
      `DE` while running in Belgrade and nothing checks it. Validate against
      ISO 3166-1 alpha-2 at startup, the way `MODEL` now refuses, and say in
      `hosting.html` that the value is operator-declared and republished
      verbatim.
- [ ] **`proveControl` has no tests**, and it is the one function whose failure
      mode is "sends the prompt anyway". Wants a bad signature, an inactive
      provider, a non-2xx `/challenge`, and the relay case.
- [ ] **`dn_wallet_rdns` is now the inconsistent one.** Having accepted that
      cross-restart convenience is not strictly necessary for `dn_sessions`, it
      is hard to argue it is for this. Cheapest fix is sessionStorage.
- [ ] **Ratings are unreachable by default.** `ProviderRating` finds a rateable
      job by scanning stored history, which is now off unless the guest opts
      in, so the anonymity-set problem gets harder rather than easier.
- [ ] `finish_reason: 'error'` is not in the OpenAI enum. A strict SDK will
      reject the final chunk of a failed stream.
- [ ] `gasFor` swallows a revert and then broadcasts the padded fallback,
      burning the full limit for a call that was never going to succeed.
      Distinguish a revert from an RPC failure and refuse to send on the first.
- [ ] `openFronted` holds the transaction queue across two receipt waits, with
      viem's default 180s timeout each, so a stalled opening delays every
      settle. Bounded, not a deadlock. Wants an explicit timeout.
- [ ] Duplicate announce timer in `host.ts`, both at 240s, which now costs two
      nonces per interval.
- [ ] `FRONT_TOPUP_MON` below `FRONT_BUDGET_MON` makes every `openJob` revert,
      with no startup validation.
- [ ] The LAN guest page performs no sanitization, and now says so nowhere. It
      is a page this project serves to a guest who did not choose an API.

## Testnet, resolved

**Stay on testnet.** Previously the highest-leverage open question in the
project; treat it as answered unless a Delta V mentor says otherwise.

Monad's own Momentum program states the requirement as "a functional product on
Monad Testnet with imminent plans for Mainnet deployment". Testnet with a dated
mainnet plan is the stated norm, not a demerit. The application is already
submitted, so a mainnet deploy does not change the artifact under review; it
only changes what can go in a weekly update, and "we changed chainId" is a
weaker update than a job surviving its provider being killed. Mainnet also
converts every dormant item in the legal section below into a live one on the
same day.

Put a dated mainnet line in the pitch. Ask a mentor directly, since that is
cheap information and Delta V's own criteria page could not be read.

## Pricing, measured

Rewritten 2026-08-27. The previous version of this section claimed a 60 to 78
percent discount to market, benchmarked against a 70B input band for a model
this node has never served. Both halves of that were wrong, and it flattered us
in one direction and understated the competition in the other.

The rate is no longer a constant. `src/pricing.ts` resolves it at startup from
the OpenRouter endpoints listing for the exact weights being served, at a
position in that band times a discount, and publishes the whole derivation in
`/health`. See `SNAPSHOT.md` 2026-08-27 (evening) section 8.

**The real band, measured 2026-08-27, for `qwen/qwen3.6-35b-a3b`, the model
this node actually runs. Ten providers.**

| provider | output $/M | input $/M |
|---|---|---|
| Darkbloom | 0.700 | **0.050** |
| AkashML | 0.900 | 0.100 |
| DeepInfra | 0.950 | 0.100 |
| Venice | 1.000 | 0.100 |
| Parasail | 1.000 | 0.150 |
| **DinnerNode** | **1.002** | **0** |
| AtlasCloud | 1.114 | 0.186 |
| Io Net | 1.190 | 0.190 |
| CoreWeave | 1.250 | 0.250 |
| Phala | 1.270 | 0.200 |
| SiliconFlow | 1.600 | 0.200 |

So the position is: **1.44x the cheapest provider, below the ten provider
median of $1.114, and free on input.** Not a deep discount, and not a giveaway.

**Corrected 2026-08-28 (night).** Darkbloom's input price is $0.05, not the
$0.070 this table carried, so the break-even ratio against them is 6.0x rather
than 4.3x. Band re-read the same night and current on every other row. The
figure was wrong in the direction that flattered us and is checkable in one
click, which is the reason to fix it before it reaches a deck.

**Darkbloom is on this list.** Eigen Labs' network is already an OpenRouter
provider for the same weights, at the bottom of the band. Any pricing claim we
make is checkable against the same listing a buyer would read, which is the
reason the derivation is published rather than asserted.

**Input is the part an output column hides.** `settle()` charges tokensDelta,
which counts tokens the node GENERATED, so a prompt is free here however long
it is. Every provider above bills input. Stated as an output-only figure, a
rival's true price for a job is `outUsd + ratio * inUsd` for a prompt `ratio`
times the length of the answer:

- cheaper than 5 of 10 on output alone
- cheaper than 8 of 10 at a 1:1 prompt-to-answer ratio
- cheaper than all 10 at 5:1
- cheaper than Darkbloom once a prompt is **6.0x** the answer

That is the defensible form of the claim, and it is the one to use in a pitch:
it is a specific number, it moves with the workload, and anyone can check it.

- [x] Rate resolved from the market rather than set by hand. Done 2026-08-27.
- [x] Input-side comparison modelled and published in `/health`. Done 2026-08-27.
- [x] Correct `.context/REFRAME.md` section 3, which still carried the Groq
      comparison and the $0.80 figure. Done 2026-09-02: section 3 rewritten
      against the measurements, the Groq comparator withdrawn because it does
      not serve these weights, the utilisation model folded in, and the
      assumptions register updated so A1, A1b and A3 read as resolved. A4 is
      the only one left. Changelog entry v2.
- [ ] Decide the band position. `PRICE_POLICY` and `PRICE_DISCOUNT` in `.env`
      are the levers; today `median x 0.9`. Undercutting Darkbloom on output
      alone is roughly `median x 0.62` and moves break-even from 309 tokens to
      about 500 per settle. The input-side argument above says it may not be
      necessary.
- [ ] Record what the price buys against the band: measured throughput on this
      node, and no SLA. That is a defensible position rather than a giveaway.

## The thesis problem

Phala is now a listed OpenRouter provider for Qwen3.6 27B at $0.32/$2.70 with
TEE attestation per response. It occupies the privacy niche, the 27B niche and
aggregator distribution at once. "A specific 27B nobody keeps warm" is therefore
not true of the model we actually serve.

- [ ] Name models genuinely absent from OpenRouter, or the long-tail thesis
      fails. This is assumption A4 and it is not a side assumption: mid-answer
      migration beats OpenRouter's refund only when the work already done is
      expensive, which means only when jobs are long. **A4 is the moat.**
      Resolving it is worth more than anything else in this file.

### A4 is CONTESTED, 2026-08-28 (night)

A market review recommended cutting A4 outright and recording it as resolved
negative. **It is recorded as contested rather than cut, because that is a
strategy decision and it has not been made.** The evidence against it, so it
can be weighed rather than remembered:

- **Featherless AI** serves 47,400+ open-source models as Hugging Face's
  largest inference provider, at $25/month for any model size with unlimited
  tokens, on stated positioning that is close to verbatim this thesis: the long
  tail of fine-tuned and niche-language models no other provider hosts, against
  competitors covering only the top 100. If that holds, the window closed
  before the thesis was written down.
- **Weak price elasticity.** The OpenRouter 100-trillion-token study (arXiv
  2601.10088) finds even drastic cost differences do not fully shift demand. So
  "long-tail model plus lower price" has both halves independently
  disconfirmed.
- **The long-jobs premise runs backwards.** TraceLab (arXiv 2606.30560, ~4,300
  coding-agent sessions) measures long contexts with SHORT outputs: median 252
  output tokens for one agent, 184 for another, p90 under 1.7k. A ReAct agent
  can sit at a 164:1 input-to-output ratio. Migration is worth less over the
  next 12 months on this trend, not more, because the per-call unit of work is
  shrinking while the per-call context grows.
- **The value of the gap, sized.** At our own $1.002/M a median lost generation
  is worth $0.00025 and a half-lost 10,000-token run $0.005. At the 99.91%
  routed availability OpenRouter publishes for our exact model, a buyer doing a
  million requests a year loses about $0.25 to mid-stream death.

What survives unchallenged: the gap itself is real and the market leader
documents it in its own words. OpenRouter states it cannot fail over once
partial content has been delivered, and does not refund cancelled streams on
every provider. Nobody resumes across providers. The question the review raises
is not whether we are alone in doing it. It is whether anyone will pay for it.

**The proposed replacement thesis, flagged by the reviewer as inferred and NOT
verified:** auditable metered inference. The settlement record here is a public
third-party-checkable object rather than an invoice, and a mid-stream failure
elsewhere gives the buyer no usage number at all. Stripe's acquisition of
OpenRouter is offered as evidence that token metering is now understood as a
payments problem. The reviewer found **no buyer currently paying for billing
attestation** and said so. Five customer conversations settle this; more
searching does not.

**Also recommended and not acted on:** apply to be an OpenRouter provider,
ahead of item 8's model list, on the argument that distribution rather than
mechanism is what took Darkbloom from research preview to 4.5B tokens in four
months, and that we already meet most of the published provider requirements.

## P1: DinnerNodeV2, settle before deploying

All seven closed 2026-08-27. `contracts/test/DinnerNodeV2Defects.t.sol` has one
section per item, written as the attack rather than as the fix: each test does
the thing a guest or a provider could actually do and asserts the money that
changes hands. 48 contract tests pass.

**Deployed to Monad testnet at `0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd`**
and verified against the deployed instance, not just in Foundry:
`DINNER_NODE_V2=0x2881... node scripts/v2-live.mjs` runs all seven as real
transactions with real wallets and real elapsed seconds. 27 live checks pass.

**Nothing points at it yet.** The site, both running nodes and DinnerRatings
still use v1 at `0xaF2c...3A92`. Cutting over is a separate job: `settle` and
`openJob` changed signature, so it needs `src/chain.ts`, `web/src/lib.ts`, the
two `registry.ts` files, and a `host.ts` change to pass prefix hashes into
`settle`. Not started.

- [x] Clamp `settle` to published progress. The checkpoint now carries a
      `billed` count beside the visible `tokens`, and settle refuses to take a
      job's paid token count past it. Because `tokens` is cumulative across
      every provider that has held the job, a replacement's headroom is what it
      published minus what the job already paid for, which is what stops it
      being paid for the prefix it inherited. `settle` takes the checkpoint in
      the same transaction, so the bound costs no extra gas, and `openJob` takes
      a `requireCheckpoints` flag so a guest can make it mandatory rather than
      something a provider opts into by publishing.
      **Why two counts:** reasoning is billed (terms 3.1) but is deliberately
      not part of the hash chain, which has to cover exactly the text a
      replacement is handed. Clamping against the visible count would have made
      reasoning unbillable.
- [x] `reassign` pays the outgoing provider out, up to what its own published
      checkpoint evidences and bounded by the same rules a settle would have
      been. A provider that published nothing is owed nothing, which is also
      the incentive to publish. Before this, a requester could let a node stream
      for a full settlement interval and reassign a moment before it settled,
      taking the work for free, repeatably.
- [x] `reassign` now moves `maxTokensPerSecond` down only, mirroring the rate.
      Taking the replacement's figure outright let a handover RAISE the bound
      the job locked at open.
- [x] Checkpoints must strictly advance in both counts, so a same-height hash
      rewrite is refused, and each one extends a `chainHash` over the whole
      history including which provider published it.
- [x] Reputation counters ignore self-dealing: `tokensServed` and a new
      `lifetimeEarned` only count jobs where the requester is not the provider.
      `earned` is a withdrawable balance and still always accrues.
      **Honest limit:** two wallets still inflate the figures for the price of
      gas. This makes it harder and no longer free; it does not prevent it.
      Ranking on figures a stranger attested to is DinnerRatings' job.
- [x] `settle` no longer auto-closes on an exhausted escrow. It emits
      `JobExhausted` and leaves the job open, so `topUp` can rescue it instead
      of the guest losing the checkpoint chain and paying `openJob` twice.
      Leaving it open is inert: `remainingBudget` is zero, so every later
      settle pays nothing. Closing is the provider's call, as it already was.
- [x] Centralised the decoding. `getJob`, `getProvider`, `getCheckpoint` and
      `getPlan` return named structs, and `remainingBudget(jobId)` publishes
      the rule so a client does not reimplement it. Client-side, `src/registry.ts`
      and `web/src/lib/registry.ts` are now the only two places that know a
      field's position; all 13 call sites read through them. Switching to v2 is
      an edit to those two files.

### The v2 cutover: what is actually left

Scoped 2026-08-27 by reading every call site and measuring the deployed
contract. Nothing here is blocked on the domain; the domain blocks the MetaMask
warning and the legal contact addresses, not this.

**A. Without these, v2 does not run at all.** Signature changes, mechanical.

- [x] `registerProvider` gained `maxTokensPerSecond`. Done 2026-08-28. `src/host.ts` passes
      three arguments, so a node cannot register on v2 at all. This is the first
      thing that breaks.
- [x] `openJob` gained `requireCheckpoints`. Done 2026-08-28. Six call sites, and
      only `PlanPanel.tsx` passes false, because a plan has no single prefix: `src/guest.ts:47`,
      `src/host.ts:807` (the LAN page), `web/src/App.tsx:516`,
      `web/src/components/PlanPanel.tsx:82`, and the three e2e scripts.
- [x] `settle` gained three checkpoint arguments. Done 2026-08-28. Only the
      five-argument form is in either client ABI, so viem never disambiguates.
      **Gotcha:** v2 declares two `settle` overloads, and viem disambiguates
      overloads by argument shape. Simplest fix is to put only the five-argument
      form in the client ABI and never mention the convenience overload.
- [x] Rewrite both ABIs: `src/chain.ts` and `web/src/lib.ts`. Done 2026-08-28.
- [x] Point both `registry.ts` bodies at `getJob`/`getProvider`. Done
      2026-08-28, and it was as prepared: no call site changed.
- [x] Addresses: `.env`, `.env.node2`, `web/src/config.ts` and the three e2e
      scripts. Done 2026-08-28. **The nodes still have to be restarted to pick
      this up, and they must be, because the v1 contract has no four-argument
      `registerProvider` for them to call.**

**B. Without these you take v2's costs and none of its benefit.**

- [x] **`host.ts` publishes checkpoints inside `settle`.** Done 2026-08-28.
      One thing the scoping missed: a settle covering only reasoning cannot
      publish, because `_checkpoint` requires a strict advance in visible
      tokens and job#93 billed 1,631 reasoning against 20 visible. The node
      settles without a checkpoint in that case rather than reverting the
      stream. Was: Until it does, `requireCheckpoints` has to stay false and the
      published-progress bound -- the headline guarantee, the thing that makes
      "worst case one settlement" true -- is opt-in and switched off. `serveJob`
      already tracks `prefix`, `produced` and the billed delta, so it is a
      contained change: pass `keccak256(prefix)`, visible tokens and billed
      tokens into the settle it already makes.
      **Measured on the deployed contract, so this is affordable:** the
      checkpoint adds 77,366 gas the first time a job writes one and **6,293 gas
      every settle after that**, because the four slots are warm. A checkpointed
      v2 settle estimates at 61,791 gas against the 113,430 the live node
      currently budgets per v1 settle. Different jobs in different storage
      states, so treat it as indicative rather than exact, but v2 with the
      guarantee on does not look more expensive than v1 with it off.
- [x] **Call `commitPlan`.** Done 2026-08-28. `PlanPanel` commits before the
      first step runs and refuses to run if the commitment fails, and the hash
      is computed in the browser from the plan on screen rather than taken
      from the node. The ceiling is `paid + run cost`, not the run alone,
      because planning is billed before the plan exists. Was: The plan ceiling built last session
      is dead code: `web/src/components/PlanPanel.tsx` has the guest approve a
      plan and its cost in the browser and never writes that approval to chain,
      which is the difference between a promise a web page makes and a limit the
      chain holds. The panel already computes the hash and the ceiling.

**C. Value that must be moved before the switch, or it strands.**

- [x] `refund()` the guest's v1 deposits, and `withdraw()` both nodes' v1
      earnings. **Done. Verified on chain 2026-08-28 (night)**, not read out of
      this file, which had it marked open: `deposits()` and the `earned` field
      of `providers()` on v1 `0xaF2c...3A92` return **0 for every key
      `scripts/drain-v1.mjs` covers** -- both node addresses and the house
      `0xA91a...5CF4`. The 3.8756995575 MON the dry run found is out.

**What is still in v1, and none of it is what the script targets.** The
contract holds **3.678 MON**. Identified so far:

| what | where | amount |
|---|---|---|
| burner deposits | `0x592244b5...` | 1.2143 MON |
| burner deposits | `0x9880e39f...` | 0.0093 MON |
| retired provider earnings | `0xEadCAED4...` | 0.0114 MON |
| escrow in 23 open jobs | jobs 1-25, 39, 63 | about 0.55 MON |

- [ ] The two burner deposits are **probably unrecoverable**. Those are browser
      wallets: the key lives in one browser's `localStorage` under `dn_pk` and
      nowhere else. If either browser profile still exists, `refund()` from it
      works; otherwise that MON stays. Worth one look before writing it off,
      since 1.21 MON is not nothing.
- [ ] `withdraw()` the retired provider key `0xEadCAED4...`, if the operator
      still holds it. It is a pre-rotation key and is not in the script.
- [~] The 23 open v1 jobs hold **0.5044 MON**, enumerated 2026-08-28 with the
      new `scripts/close-v1-jobs.mjs` (read-only unless `--send`). Four are
      closeable with keys we hold. **Only 0.019248 MON of it comes back to us**,
      and the reason corrects what this item used to say.
      **Job#63's 0.30 MON is not ours to recover by holding the provider key.**
      v1 `closeJob` admits the provider OR the requester, but it credits the
      unspent escrow to the **requester's** deposit. Job#63's requester is
      `0x592244b5…`, a burner. So closing it costs gas and hands 0.30 MON to a
      wallet we may not have. `0x592244b5…` is also the requester on eight
      other open jobs, which makes it the single wallet worth hunting for: if
      that browser profile still exists under `dn_pk`, closing these and
      calling `refund()` from it recovers most of the 0.5 MON at once. If it
      does not, all of it is written off and there is nothing else to try.
      - [ ] Look for the `0x592244b5…` browser profile. That one answer decides
            whether 0.5 MON is recoverable or gone.
      - [ ] Then, and only then, run `close-v1-jobs.mjs --send` followed by
            `drain-v1.mjs --send`.
- Roughly 1.89 MON of the contract's balance is still unaccounted for. It will
      be more deposits and more retired-provider earnings, and there is no
      cheap way to enumerate it: the public RPC caps `eth_getLogs` at 100
      blocks, so the account list cannot be recovered from events.

**D. `DinnerRatings` has to be redeployed, and it loses history.**

- [x] Done 2026-08-28, interface and redeploy both. The stub in
      `DinnerRatings.t.sol` carries non-zero middle fields so a v1 decode fails
      the test rather than passing it silently. Redeployed against v2 for
      1.616 MON: ratings `0xb418490c7679765ae5e05069c6ebedc132cba731`,
      semaphore `0xa7d933dd5b80f6578c72be9962048a5c0e1857c8`, verified on chain
      that `node()` returns the v2 address. `VITE_RATINGS_ADDRESS` updated in
      Vercel production and confirmed in the deployed chunk. The old stack is
      left on chain, unused; its group had no members so nothing was lost,
      which is the argument for having done the cutover this week.
      Previously: its `IDinnerNode` hard-coded v1's six-field `jobs()`, and both
      `node` and `groupId` are `immutable`, so it cannot be repointed. A v2
      ratings deploy needs the interface switched to `getJob` and creates a
      **new Semaphore group**: existing memberships and ratings do not carry
      over. Cheap today, since the group has zero members. It gets expensive the
      day it does not, which is an argument for doing the cutover soon.

### Found while verifying, 2026-08-27

- **`closeJob` reverts after an escrow-exhausting settle, on v1, in production.**
  Seen live on job#91 and three times in the last three days of node 1's
  journal: `settle` auto-closes when the escrow runs out, so the provider's own
  `closeJob` a moment later hits `require(j.open)` and reverts. Monad charges
  the gas limit, so each one burns 120,000 gas for nothing. This is defect 6
  observed from the outside, and the v2 fix removes it: v2 does not auto-close.
  Harmless on v1 beyond the wasted gas and an alarming log line.
- **`src/guest.ts` could not order from a reasoning model at all.** It wrote
  `JSON.parse(l).t` for every SSE frame, so the first `{th}` frame crashed it
  with `ERR_INVALID_ARG_TYPE`, aborting the stream. Node 1 serves a reasoning
  model, so the CLI guest had been broken against its own main node. Fixed: the
  three frame shapes are now handled and reasoning is counted and reported.
- **`DinnerRatings` cannot be pointed at v2 as written.** Its `IDinnerNode`
  interface declares the v1 six-field `jobs()`, which decodes v2's eleven-field
  return wrong: `open` would read a rate. `node` is immutable and the deployed
  instance points at v1, so nothing is broken today, but a v2 ratings deploy
  must switch that interface to `getJob`. This is the same defect as item 7, in
  a place the original list did not cover.

## P2: hardening still open

- [x] ~~`web/api/p/job.js` unauthenticated denial-of-wallet~~ and ~~cross-instance
      nonce collisions on `HOUSE_PK`~~. Both closed by deletion rather than by a
      fix: `fd86fb8` removed `web/api/p/*` and this session removed
      `web/api/topup.js`, so there is no serverless code and no house key in a
      serverless environment for either finding to apply to. **Read them before
      writing any new endpoint that signs with an operator key**, because both
      are properties of that shape and not of that file: an endpoint gated only
      on chain state a caller can create is a denial-of-wallet, and a nonce
      serialized per instance is not serialized.
- [ ] **Prefill is unbilled, and it is the node's scarcest resource.** `settle`
      charges `tokensDelta`, which counts tokens GENERATED, so a guest can send
      a 30,000 token prompt, take one token back, and pay for one token while
      consuming the node's full context prefill. `gate()` in `src/host.ts`
      accepts anything under `PROMPT_BUDGET`, so no exploit code is needed,
      only a long prompt in the box. Found 2026-08-28 (night) by a market
      review and confirmed in the code. This is the same line the pitch calls
      "free on input", which makes it a giveaway and an availability hole
      wearing the same clothes. Fix is small: bill input at a nominal rate, or
      bound prompt length against the escrow. **Decide it together with the
      long-context question below, because they are the same decision.**
- [ ] **We price for a workload we have decided not to serve.** Free input pays
      most at high input-to-output ratios, and at the 164:1 an agent reaches,
      Darkbloom costs $8.90 per million output-equivalent against our $1.002.
      That is the strongest economic claim in the project and we cannot honour
      it: `.context/REFRAME.md` section 4 says we do not sell long input
      prompts, and `CONTEXT_TOKENS` is 32,768, which cannot hold an 82K
      context. Either long context becomes the product and the hardware
      requirement changes, or free input comes out of the pitch as a claim that
      only pays in a case we decline.
- [x] `deposit`, `openJob` and `registerProvider` used fixed padded gas limits.
      Closed 2026-08-28: all three go through `gasFor`, which estimates and
      pads 20 percent, the same path settle has used since the key rotation
      bug. `gasFor` also takes a `value` now, without which a payable estimate
      prices a reverting call and silently returns the padded fallback, which
      is what `deposit` was doing. Verified on a local anvil by reading the
      limit and the usage off every transaction: each one now sits at exactly
      1.20x of what it used, and `deposit` fell from a fixed 200000 to 54312.
      The browser's own `openJob` at 300000 in `web/src/App.tsx` is untouched
      and is the remaining padded call.
- [~] `/announce` verified the address was a registered provider but not that
      the announcer controlled it. **Fixed in the tree, still open in
      production as of 2026-08-29:** the live discovery answers
      `/announce/nonce` with 404, so the running listener still accepts an
      unsigned announce. Downgraded from `[x]` until Now item 0 ships.
      Written and verified 2026-08-28 with the signed nonce challenge:
      `src/attest.ts`, a single-use 60 second nonce from discovery, a
      signature over a claim naming registry, chain, provider, url, model and
      nonce, and `POST /challenge` on the node for the browser's half. The
      browser now proves a `?host=` or `?peer=` target before sending the
      prompt. Attacked against a local anvil: hijack, unsigned, replay and
      url-substitution all refused. Node and discovery must be restarted
      together, since the shape is not backward compatible.
- [~] `/lanjob` is unauthenticated and spends the host's gas per request.
      **Open in production and reachable from the internet as of 2026-08-29;
      see Now item 0.** Closed in the tree 2026-08-28. The note written then
      said a tunnel was about to make this much worse, since every tunnelled
      request arrives from 127.0.0.1 and the implicit "only the LAN can reach
      it" protection would end silently. The audit of 2026-08-29 found that
      ngrok had already ended it. `src/reach.ts`
      requires a private peer AND no forwarding header. `LANJOB=off|lan|open`,
      default `lan`. `/v1/chat/completions` fronts the same escrow and is off
      unless `API_KEYS` is set, capped by `V1_DAILY_TOKENS`.
- [x] `deposit` and `openJob` bypassed the nonce queue. Closed 2026-08-28: both
      run inside `serialized()` as one unit, which also fixed a second defect
      found with them, that the balance check and the opening were not atomic
      so concurrent requests all saw enough float for one job. Four concurrent
      requests now produce four jobs. `registerProvider` still bypasses it and
      runs once at startup before the node serves anything.
- [ ] `watchContractEvent` will hit the 100-block RPC ceiling in a backgrounded
      tab. Self-recovers via `onError`, so this is low.
- [x] Pin the served model. Closed 2026-08-28: `MODEL` set to something not
      installed now refuses to start, naming what is installed, instead of
      silently serving the first tag in the list. That fallback was wrong three
      ways at once, since the model name goes on chain in the provider record,
      the rate is resolved from that model's market band, and the node could
      serve a restrictively licensed model by accident. `MODEL` unset still
      takes the first tag, and now says which one it registered.
- [x] Make `dn_sessions` opt-in, defaulted off. Done 2026-08-28. A switch in
      the receipt, off until the guest turns it on, and turning it off deletes
      what was kept rather than only stopping the next write. The receipt still
      lists this visit's orders from React state, so nothing is lost by
      declining; the switch decides only whether it survives the tab closing.
      `terms.html` 2.7, its storage table and the new `dn_keep_history` key
      updated with it.
- [ ] ngrok authtoken rotation. Manual dashboard step, and moot once the
      cloudflared named tunnels replace it. See `ops/cloudflare-migration.md`.

## Test coverage still missing

`web/` has 135 tests across 7 files and a measured mutation score of 8 of 9 as
of the pass that recorded it. The root has 223 across 14 files, both counts
measured 2026-09-02. Gaps, in the order worth adding:

- [x] The `>128` target cap, the 64 character replacement cap and the 16-rule
      cap in `extractSanitizationRules`. Done 2026-08-28.
- [x] The no-binding path of `getAllEngrams`, now with five engrams rather than
      one, plus an unreadable binding. One engram passes even against the
      index-walking bug this file exists for. Done 2026-08-28.
- [x] TTL expiry removal, asserting the key is gone rather than merely absent
      from the answer. Done 2026-08-28.
- [x] The ReDoS case no longer asserts on elapsed time. It asserts the evil
      target is matched LITERALLY, which is the fix itself, and that a prompt
      which would trigger backtracking is untouched. Done 2026-08-28.
- [~] `src/**` now has tests for every pure module: billing, plan, pricing,
      engines, executor, models, earnings, `openai-api`, `attest`, `takeover`
      and, as of 2026-09-02, `hardware`. 223 root tests. What is still untested is the code that cannot
      be imported without a key and a chain, chiefly `host.ts` and
      `discovery.ts`, which this session exercised against a local anvil by
      hand instead. `web/api/**` no longer exists.
- [ ] `host.ts` and `discovery.ts` have no automated tests, because both open a
      server and take a wallet at import. The pure parts have been extracted as
      far as they usefully go; the rest wants a harness that boots them against
      an anvil, which is what `scripts/` would hold.

## P3: before real users or mainnet

All blocking. See `SECURITY_REVIEW.md` section 4.

- [x] **Delete** `web/api/topup.js`. Done 2026-08-28, deleted rather than left
      disabled, because `TOPUP_DISABLED` is an environment variable and a deploy
      that forgets it is a one-variable mistake with regulatory consequences.
      `web/src/lib.ts` `faucet()` no longer calls `/api/topup` and goes straight
      to the public testnet faucet, which is not ours and can refuse. Nothing
      was lost that worked: the endpoint had granted nothing since
      `TOPUP_DISABLED` was set. The client-side funding invariant in
      `web/src/App.tsx` lost its upper bound with it, since the grant size is
      no longer ours to set.
- [ ] **Node operators have never agreed to `reassign`.** `hosting.html:280`
      points them at `terms.html` section 5, which covers data duties and says
      nothing about a live job being taken away and the compensation fixed
      unilaterally by the contract. On testnet a provider forfeiting valueless
      MON has no claim. On mainnet, one that streams 40 seconds, publishes no
      checkpoint and is reassigned to zero has an unjust-enrichment argument
      under Serbian law, and `DinnerNodeV2.sol:473` deliberately gives it
      nothing. A clause was drafted by the legal review 2026-08-28 and wants
      the operator's wording. Raised by the legal review, 2026-08-28 (night).
- [ ] A handover writes MORE on-chain records keyed to the guest's address.
      `terms.html` 2.1 describes the footprint as "exactly two items", which a
      reassign makes an understatement. One sentence in 2.6.
- [ ] Independent review of the fixed contract.
- [ ] Serbian counsel on escrow-as-custody and the house wallet as a possible
      transfer service.
- [ ] Entity formation before outside money.
- [ ] Design-stage counsel on the P3 slashing and rented-arbitrator mechanics,
      before building rather than after.
- [ ] EU AI Act Article 50(2) machine-readable marking of synthetic text.
      **2 December 2026 is not the application date.** Article 50 has applied
      since 2 August 2026; 2 December is an AI Omnibus grandfathering window open
      only to systems placed on the market BEFORE 2 August 2026. A mainnet deploy
      or a launch-framed relaunch may count as placing a new system, in which
      case there is no grace period. Roughly two days plus a signature:
      - Sign the Code of Practice on Transparency of AI-generated Content. It is
        a form, and it carries a presumption of conformity. Highest value per
        hour on this list.
      - Emit provenance metadata on the SSE stream and in artifact downloads.
      - Expose a public `GET /verify?jobId=` detector backed by the on-chain
        settlement trail. This is a genuine detector and a differentiator worth
        naming in the Delta V material.
      - ~~Mark the mock output too.~~ Moot: there is no mock output left.
        Replaced by a harder one: **mark output on both the original and the
        replacement provider's stream.** A failover means one answer can have
        two producers, and a marking scheme that tags only the first is worse
        than none.
      - **Do not plan around 2 December.** The legal review's reading,
        2026-08-28: we almost certainly never qualified for the grandfathering.
        Claiming it means evidencing this system was on the market before
        2 August 2026, against a domain bought last week, new metadata, a new
        contract and a launch-framed update. Treat 50(2) as due now.
      - Scope: Serbia is a third country, but Art 2(1)(c) catches third-country
        providers whose output is used in the Union, and the site is public and
        indexed. Assume we are in scope. Do not build a plan around not being
        in the EU.
      - Document the proportionality choice in one page.

## Assumptions still unmeasured

From `.context/REFRAME.md` section 10. Each is cheap to settle and none has been.

- [x] **A1 throughput. MEASURED 2026-08-28 (night)**, `scripts/bench-throughput.py`,
      through ollama directly so the numbers are the machine's rather than the
      billing path's. `qwen3.6:35b-a3b`, RTX 5070 Ti Laptop 12GB, 24 cores.

      | prompt tok | prefill s | prefill tok/s | model load s | TTFT s | gen tok/s |
      |---|---|---|---|---|---|
      | 517 | 2.3 | 222 | 0.0 | 2.3 | 57.5 |
      | 1,936 | 3.7 | 521 | 0.0 | 3.7 | 62.9 |
      | 7,777 | 20.4 | 382 | 16.0 | 36.3 | 57.9 |
      | 15,532 | 34.9 | 446 | 42.7 | 77.6 | 55.2 |
      | 31,075 | 63.4 | 490 | 114.3 | 177.6 | 54.6 |
      | 63,085 | 128.9 | 490 | 43.6 | 172.5 | 43.8 |
      | 95,128 | 207.4 | 459 | 66.4 | 273.8 | 31.9 |

      **The 25 tok/s guess was low by 2.3x.** Generation is 58 tok/s at working
      context and holds there, because this is a MoE with about 3B active
      parameters: speed barely depends on the 22.6GB of weights, most of which
      sit in system RAM at `gpuFraction` 0.43. It degrades only past 32k, to
      43.8 at 63k and 31.9 at 95k, which is KV cache pressure.

      **Prefill is 460 to 490 tok/s and essentially flat to 95k.** The 158
      tok/s in the `web/src/App.tsx` cold-start comment is wrong and makes the
      browser wait longer than it needs to.
      - [x] Correct that comment and the watchdog budget derived from it. Was
            already done in the same session that measured it: `App.tsx` now
            carries the remeasured note and divides by 300 rather than 150.
            Verified 2026-08-28, this item was stale rather than open.

      **95k context fits. It does not OOM.** So `CONTEXT_TOKENS=16384` on both
      live nodes is a configuration choice, not a hardware limit.

      **What actually breaks is time to first token**, and the cost is model
      load rather than prefill: 16s at 16k, 43s at 32k, 114s at 40k. Changing
      `num_ctx` forces a reload, so a node serving mixed context sizes pays it
      repeatedly. Any long-context product must pin one context size.

- [x] **A1b prefix cache reuse. MEASURED**, `scripts/bench-prefix-cache.py`.
      **This is the result that decides whether long context is serveable.**

      | call | prompt tok | prefill s |
      |---|---|---|
      | cold | 11,638 | 20.88 |
      | identical repeat | 11,638 | 0.12 |
      | same prefix, new tail | 11,635 | **1.36** |

      An agent that holds a stable context and changes only the tail pays
      **1.36s per step instead of 20.9s, a 15x reduction.** The product shape
      that works is therefore a SESSION against one node, which is the session
      job mechanic already built, rather than one-shot calls.

      **Two limits, both real.** The cache is resident, so interleaved traffic
      from a second guest evicts it, and `MAX_CONCURRENT` is 2. And it holds
      only while the session stays on one node.

      **The tension this exposes, which nothing else in this file names:** we
      charge zero for input, and a reassign hands the replacement provider a
      cold cache. On a 95k session that is 207 seconds of prefill the
      replacement performs and cannot bill for. Free input and mid-answer
      migration are in direct conflict on exactly the workload the pivot would
      target. Resolve it with the P2 prefill item; they are one decision.

- [~] A2 power draw. **GPU-only measured 2026-08-28: 49.5W mean under load,
      61.7W peak, 42.2W over a mixed window.** Still wants a wall meter, and
      the reason is now specific rather than general: `gpuFraction` is 0.43, so
      the 24-core CPU is doing most of this model's work and a GPU-only figure
      understates system draw badly. The 250W guess is probably high; 120 to
      180W is the plausible band and it is not measured.
- [x] **A3. MODELLED, and it does not need more measurement.** Achievable
      utilisation cannot be measured without demand we do not have, so it
      splits into a number that can be read and a number that can be computed.

      **Realized, read off the chain: 1.13%.** 385,704 tokens ever across v1
      and v2 is 1.79 hours of generation at 58 tok/s, against 158 hours of
      project age. **Total revenue ever, both contracts, $0.387.**

      **Per busy hour: $0.209 gross, $0.188 net** of the 10 percent settle gas
      takes at `settleGasMultiple` 10.

      **The break-even depends entirely on how the electricity is counted, and
      that is the whole answer to A3:**

      | basis | break-even utilisation |
      |---|---|
      | dedicated machine, 250W | 15.9% |
      | dedicated machine, 180W | 11.5% |
      | **idle PC, marginal draw only** | **91% margin per busy hour, utilisation irrelevant** |

      Under the dedicated reading this is marginal and needs 12 to 16 percent
      utilisation. Under the idle-PC reading, which is the project's own
      premise, marginal cost is about $0.016 per busy hour against $0.188 of
      revenue, so it profits at any utilisation and the only question is
      whether the absolute number is worth a stranger's attention:

      | utilisation | net revenue |
      |---|---|
      | 1.13%, what we have achieved | $18.65/yr |
      | 6% | $99/yr |
      | 25% | $413/yr |
      | 100% | $1,650/yr |

      **The 6 percent row is the one to look at.** It lands on $99, and
      Darkbloom's observed figure is about $113 per provider per year across
      900+ providers. An independent network, different hardware, different
      chain, same order of magnitude. Treat $100 to $150 a year as what a
      consumer node earns, and size every claim against that.
- [ ] A4 long-tail demand. See "The thesis problem" above. This is the moat.

## Docs

- [x] Delta V application. Submitted 2026-08-25; building continues under review.
- [ ] Weekly Delta V update once the migration demo lands. Do not post one that
      says only "we fixed defects".
- [ ] v3 spec memo: plan schema, planner prompt, contract diff. Specify now,
      build after the migration demo.
- [ ] One-page reply to Gregor's two objections.
- [ ] Presentation pass: engram panel styling, clearer receipt, mobile check.
- [ ] Rebuild the pitch around mid-answer migration rather than privacy. Do not
      lead with per-second settlement: x402 settlement volume is down 93 percent
      year to date on roughly $28k daily, so micropayment rails are not pulling
      demand on their own.

---

## What this roadmap lacks

Added 2026-09-02, from reading the whole file against
`.context/drafts/competitor-darkbloom.md`. Everything above this line is
supply-side and mechanism-side: hardening, contract correctness, tunnels,
pricing derivation, tests, legal gates. That is a good engineering roadmap and
it is half the problem. These are the gaps in the OTHER half, in the order they
would change what gets built.

1. **There is not one demand item in this file.** The competitor brief's own
   headline finding is that demand is the bottleneck, not supply: a funded team
   with 250 providers and OpenRouter distribution could not fill them, and a
   top earner made about $6. The A4 section says in prose that five customer
   conversations settle the moat and more searching does not. That never became
   a task. **The entire "Now" list can be completed without a single external
   user existing.**
   - [ ] Five conversations with people who buy inference, about the workload
         in A4. Ahead of every code item in this file, because it decides which
         of them are worth doing.

2. **The moat cannot travel through the distribution channel, and nothing here
   notices.** Item 9 says distribution is the gap. Items 5 and 6 say mid-answer
   migration is the differentiator. These conflict: OpenRouter calls one
   provider endpoint, and a cross-provider resume has no representation in that
   protocol. Through the aggregator we are an ordinary slow provider at
   $1.002/M with no way to express the one thing nobody else does.
   - [ ] Decide: migration happens invisibly INSIDE our network behind one
         endpoint, so an aggregator sees one reliable provider, or the
         aggregator is not the channel for it. This reorders items 5, 6 and 9
         and should be settled before spending two weeks on any of them.

3. **No second operator appears anywhere in this plan.** Darkbloom has 250 to
   900 providers. We have one operator running two daemons on one machine that
   share one ollama and evict each other's models. A marketplace with one
   seller is a hosting company, and every migration demo between our own two
   nodes is house-to-house.
   - [ ] One stranger running a node. Needs a one-command installer, a
         hardware and VRAM matrix, Windows instructions, and onboarding docs.
         Nothing in this file currently produces any of it.

4. **No reliability numbers, on a channel that ranks on reliability.**
   `/provider/models` publishes capacity absent and `is_ready` false. We
   already tuned 429-versus-503 for OpenRouter's scoring, which means we know
   they measure this, and we do not measure it ourselves.
   - [ ] Measure and publish uptime, p50/p99 time to first token, and error
         rate, from a canary rather than from a claim. Without it the
         application is not credible and a regression is invisible.

5. **Nobody can pay us.** Item 9's "decide what the endpoint bills" and P3's
   "entity formation before outside money" are treated as unrelated and are the
   same blocker. No invoicing, no accounts, no payout rail, no entity means the
   OpenRouter application cannot complete however good the code is.
   - [ ] Sequence the entity next to item 9 rather than in P3.

6. **A4 is the declared moat and has no decision rule.** Marked contested,
   marked worth more than anything else in this file, left open with no date
   and no falsification test, while Featherless and Phala are both recorded as
   evidence against it.
   - [ ] Give it a test and a date: name ten models genuinely absent from
         OpenRouter with evidence of paid demand, by a date, or adopt the
         replacement thesis. Leaving it open is the most expensive line here.

7. **Competitive tracking is a one-off.** The brief is dated 2026-08-27 and
   Darkbloom's input price already moved under it, caught by accident. The
   band feeds `pricing.ts` and the pitch.
   - [ ] A recurring re-read of the band and the competitive set. The node
         already fetches the band at startup; nothing keeps the BRIEF current.

8. **Smaller, still real.** No answer to "who reads my prompt" for a buyer who
   has heard of Secure Enclave, even a modest one. No Anthropic-compatible
   surface, which Darkbloom has. No status page and no developer docs.
   Migration's user-visible latency cost is unmeasured while its correctness is
   proven.
