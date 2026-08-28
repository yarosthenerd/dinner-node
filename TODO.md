# DinnerNode roadmap

Single source of truth. Supersedes `.context/HANDOFF.md` section 14, which is
stale and marks several things done that never existed. Read alongside:

- `SNAPSHOT.md`: what is built and what is broken, with evidence.
- `.context/REFRAME.md`: positioning and sequencing rationale.
- `SECURITY_REVIEW.md`: the security checklist and the pre-mainnet gate.

Legend: `[x]` done and verified, `[~]` done but not verified against a live run,
`[ ]` open.

Last updated 2026-08-28 (evening). Now items 1 through 4 are closed, and 5 and
7 are struck: the cloud kitchen they were written about was deleted in
`fd86fb8`. The load-bearing item is item 5 as it now reads, `reassign` between
two live providers, triggered from a browser.

---

## Status

P0 is closed. Every item the 2026-08-25 sessions opened has been fixed and
verified: three live serverless exposures, the engram and privacy layer, a
plaintext prompt path in the CLI, and thirteen further defects the verification
agents found, several of which the fixes themselves had introduced. The root of
the repo now typechecks, and `web/` has 115 regression tests.

The tree is deployed and the site is live at `dinnernode.xyz` on v2. **There is
no serverless surface left at all:** `web/api/` is an empty path, because
`fd86fb8` deleted the cloud kitchen and this session deleted the faucet. Every
transaction a guest causes is now signed by the guest's own key or by a node
the operator runs on a machine, and none by a key sitting in Vercel's
environment.

**The next move is not more hardening.** It is making the differentiator
demonstrable and the price honest. See "Now" below.

---

## Now: the next two weeks

Ordered. Everything here is ahead of every remaining defect in this file.

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
   load-bearing item, and it replaces the cloud-kitchen item that stood here.
   `fd86fb8` deleted `web/api/p/job.js`, `health.js` and `_lib.js`, so the
   canned second provider is gone and **the browser has no failover target at
   all**: an order against a dead node fails and returns its escrow.
   `web/src/App.tsx:493` says as much in a comment. What exists is the whole
   precondition and none of the product: v2 `reassign` pays the outgoing
   provider for exactly what it published and clamps the replacement to the
   suffix, proven by 27 live checks in `scripts/v2-live.mjs`; `host.ts`
   publishes a checkpoint inside `settle`; the browser has a manual resume
   button. Needs: a peer URL the client can fail over to, an automatic
   failover on stream death rather than a button, and a `reassign` call so the
   handover is the contract's and not a convention between two hosts.
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

One correctness note for the pitch: on the deployed V1 contract, "does not pay
twice" is enforced by the host choosing to settle only what it produced, not by
the contract. Claim "the replacement provider settles only the suffix it
produced, verified against a keccak checkpoint chain", which is true today. Do
not claim contract enforcement until the V2 items below land.

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
| Darkbloom | 0.700 | 0.070 |
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
- cheaper than Darkbloom once a prompt is 4.3x the answer

That is the defensible form of the claim, and it is the one to use in a pitch:
it is a specific number, it moves with the workload, and anyone can check it.

- [x] Rate resolved from the market rather than set by hand. Done 2026-08-27.
- [x] Input-side comparison modelled and published in `/health`. Done 2026-08-27.
- [ ] Correct `.context/REFRAME.md` section 3, which still carries the Groq
      comparison and the $0.80 figure.
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

- [~] `refund()` the guest's **1.306 MON** sitting in v1 deposits.
      `scripts/drain-v1.mjs` does this and every other item in section C.
      Dry run 2026-08-28 confirms **3.8756995575 MON** across the three keys.
      Not sent: it moves value and wants the operator's word.
- [ ] `withdraw()` node 1's **2.559 MON** of unwithdrawn earnings, and node 2's
      0.0022 MON. Roughly **3.87 MON in total** across both.
      Not lost if skipped -- v1 stays callable forever -- but it is real money
      in a contract nothing will be watching any more.
- [ ] Drain open v1 jobs before switching, or their escrow sits until each
      node's idle timer closes them.

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
- [ ] `deposit`, `openJob` and `registerProvider` still use fixed padded gas
      limits. Measured with Foundry: `deposit` 55094 against 200000 (3.6x),
      `openJob` 166702 against 250000 to 300000, `registerProvider` 126392 first
      and 29665 warm against 250000 (up to 8.4x). Monad charges the limit.
- [ ] `/announce` verifies the address is a registered provider but not that the
      announcer controls it. Anyone can hijack a provider's URL and harvest guest
      prompts under its on-chain reputation. Needs a signed nonce challenge.
- [ ] `/lanjob` is unauthenticated and spends the host's gas per request.
      `deposit`, `openJob` and `registerProvider` bypass the nonce queue.
- [ ] `watchContractEvent` will hit the 100-block RPC ceiling in a backgrounded
      tab. Self-recovers via `onError`, so this is low.
- [ ] Pin or allowlist the served model. `src/host.ts` falls back to whatever is
      first in the local ollama list, so a node could serve a restrictively
      licensed model by accident.
- [ ] Make `dn_sessions` opt-in, defaulted off. Storing prompts and answers on
      the user's device across restarts is not strictly necessary for the
      service, so under ePrivacy Art 5(3) it needs consent. The "clear history"
      control is a deletion mechanism, not consent.
- [ ] ngrok authtoken rotation. Manual dashboard step.

## Test coverage still missing

`web/` has 115 tests across 5 files and a measured mutation score of 8 of 9 as
of the pass that recorded it. Gaps, in the order worth adding:

- [ ] The `>128` target cap and the 16-rule cap in `extractSanitizationRules`.
- [ ] The no-binding path of `getAllEngrams` beyond the one case added.
- [ ] TTL expiry removal.
- [ ] Assert on the compiled pattern source rather than elapsed time for the
      ReDoS case. A synchronous ReDoS blocks the event loop, so a revert hangs
      the whole run past `testTimeout` instead of failing the assertion.
- [ ] No tests at all for `web/api/**` or `src/**`. Both are now typechecked but
      neither is exercised.

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
      - Mark the mock output too. Marking real inference and not the mock is
        worse than either alone.
      - Document the proportionality choice in one page.

## Assumptions still unmeasured

From `.context/REFRAME.md` section 10. Each is cheap to settle and none has been.

- [ ] A1 throughput on the reference machine. 25 tok/s is a guess. One benchmark.
- [ ] A2 power draw under load. 250W is a guess. One wall meter.
- [ ] A3 achievable utilisation. Unmodelled. Decides whether this is a business.
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
