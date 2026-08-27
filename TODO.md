# DinnerNode roadmap

Single source of truth. Supersedes `.context/HANDOFF.md` section 14, which is
stale and marks several things done that never existed. Read alongside:

- `SNAPSHOT.md`: what is built and what is broken, with evidence.
- `.context/REFRAME.md`: positioning and sequencing rationale.
- `SECURITY_REVIEW.md`: the security checklist and the pre-mainnet gate.

Legend: `[x]` done and verified, `[~]` done but not verified against a live run,
`[ ]` open.

Last updated 2026-08-26 (evening). Now items 1, 2, 3 and 4 are closed. Item 5,
the cloud kitchen as a real second provider, is the load-bearing one left.

---

## Status

P0 is closed. Every item the 2026-08-25 sessions opened has been fixed and
verified: three live serverless exposures, the engram and privacy layer, a
plaintext prompt path in the CLI, and thirteen further defects the verification
agents found, several of which the fixes themselves had introduced. The root of
the repo now typechecks for the first time, and `web/` has 36 regression tests.

Nothing is deployed. The live site still runs the old code, including the 10 MON
faucet and the health endpoint that sends a transaction on an RPC blip.

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
5. **Make the cloud kitchen a real second provider.** This is the load-bearing
   item and it is the reason the section exists. `web/api/p/job.js` does not
   accept a `resume` payload at all: it destructures `{ jobId, prompt }` and
   streams one hardcoded sentence while settling real MON. Checkpoint
   verification lives only in `src/host.ts`. So mid-answer migration, the
   claimed differentiator, is reproducible today only between two LAN hosts run
   by hand, and cannot be triggered from a browser by a reviewer. Needs: accept
   `resume`, verify the checkpoint hash, call a real inference API.
6. **Record the migration demo.** Start a job, kill the laptop mid-answer, watch
   it continue elsewhere, with an on-chain receipt showing two providers paid
   for disjoint token ranges. Nobody in the competitive set can run this.
7. **Separate the faucet key from the cloud-kitchen provider key.** Both derive
   from `HOUSE_PK` today, so the on-chain graph is a closed loop and any usage
   or revenue figure is house-to-house flow. Do this before showing anyone a
   number.
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

## Pricing, corrected

`.context/REFRAME.md` section 3 benchmarks $0.80 per million against Groq's
$0.79, but that is a 70B input price and `RATE_PER_MILLION` bills output tokens
only on a 27B model. The live output band for Qwen 27B across seven providers is
$2.00 to $3.60. So $0.80 is a 60 to 78 percent discount to market, not "inside
the band", and the headroom is roughly $1.20.

- [x] Set the rate to 2.67e19 now, as above. Done 2026-08-26.
- [ ] Correct REFRAME section 3, which currently understates our own position.
- [ ] Record what the discount buys: 25 tok/s against DeepInfra's 51, and no SLA.
      That is a defensible discount rather than a giveaway.

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

Do not deploy V2 until these are closed. Not on the critical path for the
migration demo: checkpoint resume already works on V1.

- [ ] Clamp `settle` to `checkpoints[jobId].tokens - j.tokens`. One fix bounds
      loss to one settlement for the first time and stops a replacement provider
      being paid twice for the same prefix.
- [ ] `reassign` lets the requester strand the outgoing provider's unpaid work,
      free and repeatably. The mirror of the defect V2 exists to fix.
- [ ] `reassign` raises `maxTokensPerSecond` without a clamp.
- [ ] Checkpoint regression guard uses `>=`, permitting same-height hash
      rewrites. No hash chaining on chain.
- [ ] Reputation counters accumulate unclamped, and discovery sorts on
      `tokensServed`.
- [ ] `topUp(jobId)` cannot rescue an exhausted job, because `settle` auto-closes
      in the same transaction. Load-bearing under the long-jobs reframe.
- [ ] Centralise `jobs()` and `providers()` decoding in `src/host.ts` and
      `web/src/App.tsx`, as already done in `web/api/p/_lib.js`. V2 moves `open`
      from index 5 to 9 and `active` from 6 to 7, and a non-zero rate at the old
      index reads as truthy, so every liveness check would silently pass.
      **Note:** named ABI outputs do NOT fix this. viem returns a positional
      array regardless. A single-struct return does decode to a named object, so
      adding `getJob(uint256) returns (Job memory)` to V2 would make index drift
      structurally impossible. That is the better fix if V2 is being edited.

## P2: hardening still open

- [ ] `web/api/p/job.js` is an unauthenticated denial-of-wallet. The only gate is
      `job.provider == house && job.open`, so anyone opens a 0.01 MON job and
      fires N concurrent POSTs; all N read `open == true` before any closes, and
      each runs a full settle chain plus `closeJob`. The house pays far more gas
      than the job can return. Needs a requester signature or a shared served
      flag.
- [ ] Cross-instance nonce collisions on `HOUSE_PK`. The promise chain in
      `job.js` serializes within one serverless instance and nothing serializes
      across them, so two concurrent guests collide and a settle is lost. A
      public `health.js` poll can collide with an in-flight settle the same way.
      Needs a shared nonce source or a single serialized worker.
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

`web/` has 36 tests and a measured mutation score of 8 of 9 before this pass.
Gaps, in the order worth adding:

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

- [ ] **Delete** `web/api/topup.js`. Do not merely disable it: `TOPUP_DISABLED`
      is an environment variable and a deploy that forgets it is a one-variable
      mistake with regulatory consequences. The endpoint hardcodes chainId 10143
      and now asserts it, which is a structural gate, but deletion is the real
      one.
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
