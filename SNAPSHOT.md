# Session snapshot, 2026-08-25

> Second pass, same day: the P0 items in section 7 have been worked. See
> `TODO.md` for current status; section 7 below is now a historical record.

## 1. What was asked

Execute the P0-OPS and P0 items in `.context/HANDOFF.md` section 14, deploying
the project agents, with market-supervisor and legal-advisor treated as core.

## 2. Headline finding

The engineering in this repo is more defensible than the claims made about it.
Almost every serious exposure found today came from a sentence, not from a
design decision. Separately, `.context/HANDOFF.md` cannot be trusted as a
record of state: it marks four things complete that have never existed.

## 3. Documentation drift confirmed

Files HANDOFF describes as shipped that do not exist on disk and have never
been committed (`git log --all` returns nothing for any of them):

- `src/discovery.ts`: section 4 describes it in detail. Did not exist. BUILT TODAY.
- `SECURITY_REVIEW.md`: section 4 and the P0-OPS gate reference it. Did not exist. WRITTEN TODAY.
- `web/public/terms.html`: section 14 marks it `[x]` done, section 5 describes
  a header link. Neither existed. `https://web-opal-sigma-55.vercel.app/terms.html`
  returned 404. WRITTEN TODAY.
- `TODO.md`: section 4 calls it the merged roadmap. Does not exist. STILL MISSING.

Section 13's guidance was also wrong: it says to fix the "providers 0" stats bar
"with the same getLogs cascade used by the receipt". That cascade never worked.
See 5.1.

## 4. Agent findings

All seven project agents in `.claude/agents/` failed to load this session,
because commit `09c6579` untracked them and `.gitignore` now ignores `.claude`.
They were run as general-purpose agents with their definition files injected as
the operating brief, which preserved their instructions. **Fixing agent
registration is an open item.**

### market-supervisor: the core hypothesis is REFUTED

The operator's premise is that this category cannot compete without serious
privacy (ZK) and legal-compliance layers. The evidence says otherwise.

- Buyers choose on price first, reliability second. Every competitor leads with
  a discount percentage; none leads with privacy.
- The loudest documented complaint is provider dropout and unreliability on
  io.net and Akash. That is what DinnerNode's architecture is genuinely
  positioned to answer.
- Privacy demand that exists is TEE-shaped and attestation-based, and is
  already served by Phala (1.34B tokens in a day, revenue-generating). ZK as
  anonymity is not what buyers ask for, and zkML proving latency rules it out
  for interactive inference.
- Compliance is an architectural anti-fit: SOC 2 and ISO 27001 attest to
  controls over identified infrastructure run by an accountable entity. A
  network of pseudonymous consumer PCs is the structural opposite.
- Per-second on-chain settlement is not itself a purchase driver (x402 has the
  Linux Foundation, Google, Visa, Stripe and AWS behind it and roughly $28k
  daily volume). It is the mechanism that makes mid-answer provider migration
  possible, and that is how it should be framed.

Recommended P0 reordering: deploy to Monad mainnet (not on the list, outranks
most of it, mainnet launched nine months ago); fix the stats bar; fix failover;
long-input reject; model picker; presentation pass. Recommended cuts: engram
verification and panel styling, artifact downloads, localStorage sessions, host
throttling. Recommended to spec rather than build: checkpoints and resumeJob.

**Numbers that fail diligence.** Ethereum gas on 24 Aug 2026 was ~0.618 gwei
with ETH ~$2,258, so 1.9M gas is about **$2.65, not $115**. The deployed
`RATE_PER_MILLION` of 2e18 at MON ~$0.03 is **$0.06 per million tokens**, which
pays the RTX rig about **$0.005/hour, not $0.60**. "Average PC $0.10/h" does not
survive at all. The Belgrade dinner figure and "3B idle PCs" as a headline both
survive.

### legal-advisor: the claims, not the code, are the exposure

- **Prompts were reaching the chain in cleartext** on the LAN path. FIXED.
- **The commitment was unsalted and bound to a stable identifier**, making short
  prompts brute-forceable from the public event and linkable across jobs. The
  EDPB adopted final blockchain guidelines v2.0 on 7 July 2026 holding unsalted
  hashes on a public chain to be personal data, with a carve-out for commitments
  that perfectly hide. FIXED, and the fix moves us into the carve-out.
- **"guests appear as semaphore pseudonyms, not wallets" is false.** `msg.sender`
  is the wallet and is an indexed event topic. FIXED.
- EU AI Act Article 50(1) chatbot disclosure has been in force since
  2 August 2026. Article 50(2) machine-readable marking of synthetic text is due
  2 December 2026. Not high-risk; the Digital Omnibus delay is irrelevant to us.
- Qwen3.8-27B is Apache 2.0, so commercial serving is clean. The host does not
  pin the model, so a node could serve a restrictively licensed one by accident.
- Testnet operation sits outside MiCA and the Serbian Law on Digital Assets, a
  comfortable read rather than a marginal one, but it rests entirely on the
  tokens being worthless.
- **The house wallet faucet is the most legally dangerous mechanic in the repo
  on mainnet.** It must not survive in its current form.
- DSA safe harbour is likely unavailable for model output. Treat it as absent.
- Needs a real lawyer, in order: before mainnet (blocking), at P3 design time
  (not after), ToS review once drafted, entity formation before outside money.

### monad-chain-reviewer: 17 findings, several critical

Confirmed empirically with out-of-tree Foundry tests. The v1 `settle()` drain is
worse than described: `registerProvider` can raise the rate mid-job, so a
provider takes the whole escrow for **one token**. Verified `paid = 10 ether`,
`tokens = 1`.

### web-app-reviewer and engram-privacy-auditor

Both ran executed tests rather than static reading. Findings folded into
sections 5 and 7.

## 5. Work completed this session

### 5.1 Root-caused the "providers 0" bug: the documented fix was impossible

The public Monad RPC caps `eth_getLogs` at a **100 block range**:

```
{"code":-32614,"message":"eth_getLogs is limited to a 100 range"}
```

Every span in HANDOFF's prescribed cascade (earliest, -50k, -20k, -5k, -1k) is
rejected. At roughly half a second per block that is about 40 seconds of
history, so registration history is **not recoverable from this endpoint at
all**. `providers(addr)` reads work fine. The old fallback list in `App.tsx`
also contained only the two wallets retired in the key rotation.

### 5.2 Built `src/discovery.ts` (did not previously exist)

Architected around what actually works: a persisted address cache, POST
`/announce` verified against `providers(addr)` on chain, and a rolling 99-block
forward tail scan. Serves GET `/providers` and `/health` on :4174.

Tested live: verified provider served with URL; unregistered address rejected
403; `javascript:` scheme rejected 400; URL normalized to origin.

### 5.3 Found and fixed a live settlement failure nobody knew about

Running a real job showed `settle` **reverting** while the host logged it as a
success. Two compounding defects:

- `gas: 100000n` is insufficient. Actual estimate is **118,219**, because on a
  freshly rotated provider `earned` and `tokensServed` go zero to non-zero at
  20k each. So **after every key rotation the first settlement of the new wallet
  reverted**, and Monad charges gas_limit so each revert burned the full 100k.
- `writeContract` resolves on acceptance, not success. There was no receipt
  check, so a reverted payment was logged as a completed one.

Fixed with per-call `estimateContractGas` plus 20 percent and a `sendChecked`
helper that throws on a non-success receipt. Verified: job#25 (before) paid 0
and is still open with 0.01 MON stranded; job#26 (after) paid 0.000096 MON for
48 tokens and closed cleanly.

### 5.4 Checkpoint and resume protocol, verified cryptographically

Host emits `{cp:{n,h}}` frames every N tokens, hash chained over the growing
prefix, plus a final checkpoint. A replacement provider verifies
`keccak(text) === h` before honouring a resume, and settles only tokens it
produced itself.

Verified against a live job: 47 token frames, 5 checkpoints, **all five hashes
match the reconstructed prefix**.

### 5.5 Other fixes

| Fix | File |
|---|---|
| Plaintext prompt on-chain replaced with keccak commitment | `src/host.ts` |
| Chunk-boundary JSON tearing that truncated long answers | `src/engines.ts` |
| Host no longer logs prompt text, logs token count | `src/host.ts` |
| Bounded body reading with 413 (was unbounded string growth) | `src/host.ts` |
| Prompt token gate, 413 with numbers, `/health` publishes the budget | `src/host.ts` |
| Resume text now counted against the context gate | `src/host.ts` |
| Concurrency ceiling actually enforced (was a TOCTOU race) | `src/host.ts` |
| Resource pressure throttle + `HOST_PRIORITY` owner/guest | `src/host.ts` |
| `containsPII` alternating true/false on identical input | `web/src/lib/engram-sanitizer.ts` |
| Escrow leak: `closeJob` was never called anywhere in `web/src` | `web/src/App.tsx` |
| Salted per-job commitment, `zkC` dropped from preimage | `web/src/App.tsx` |
| Resume payload text/hash mismatch (could never validate) | `web/src/App.tsx` |
| Failover concatenating two answers | `web/src/App.tsx` |
| `busy` sticking forever; no timeout, abort, or unmount cleanup | `web/src/App.tsx` |
| Stored XSS via `marked` with the guest key in localStorage | `web/src/App.tsx` |
| `releaseJob` grace window so it cannot rob the provider | `web/src/App.tsx` |
| Session write was impure and stored the RAW prompt | `web/src/App.tsx` |
| `maxFeePerGas` cap on all three browser writes | `web/src/App.tsx` |
| Unbounded sequential RPC walk of the settlement feed | `web/src/App.tsx` |

### 5.6 New features shipped

Discovery wiring with fallback; token estimate against the host's real budget
with the order button disabled when over; resume-from-checkpoint button;
artifact downloads from fenced blocks; localStorage session history (storing the
sanitized prompt); provider "use" button; AI Act Article 50 disclosure; terms
and acceptable-use links; cloud-kitchen canned-output label; sim card labelled
honestly.

### 5.7 Documents written

- `SECURITY_REVIEW.md`: 9 confirmed defects, 4 open items, Monad discipline
  checklist, pre-mainnet blocking list.
- `web/public/terms.html` and `web/public/acceptable-use.html`: drafted to the
  legal brief, theme-matched, with `[CONTACT EMAIL]`, `[ABUSE EMAIL]` and
  `[LEGAL ENTITY / OPERATOR NAME]` placeholders to fill in.
- `README.md`: corrected every claim the code contradicts.
- `contracts/src/DinnerNodeV2.sol`: compiles, **NOT deployed**.

### 5.8 Scope decision to be aware of

The `App.tsx` rewrite **removed the Semaphore/Groth16 proof generation**. It was
a single-member group, generated and verified in the same browser, never
submitted, with `DinnerZK.sol` unwired; both research agents independently said
the claim attached to it was the largest diligence liability in the repo. This
was a judgement call made mid-rewrite and is reversible. Flagging it explicitly
because it was not asked for.

## 6. Verified state

- Build: `tsc -b && vite build` passes. Typecheck clean. `forge build` clean.
- House wallet 0xA91a...5CF4 holds **3 MON**. Section 13's funding blocker is
  already cleared; no sweep needed.
- Provider 0x055a...326A is registered and active on chain, 0.949 MON.
- Discovery, host, checkpoints, settlement and close all verified against live
  Monad testnet, not just read.

## 7. Open items, in priority order

**Superseded.** `TODO.md` is now the single source of truth for the roadmap and
carries the current status of every item below. This section is kept as the
record of what was found on 2026-08-25 and is not maintained.

### Closed in the second pass of 2026-08-25

Items 1 through 10, plus 20, 22 and 23. Detail in `SECURITY_REVIEW.md` 1.10
through 1.15 and in `TODO.md`. In short:

- 1, 2, 3: the three live serverless exposures. `topup.js` is now bounded by
  two on-chain checks a caller cannot forge rather than by a per-instance map;
  `health.js` no longer sends a transaction because a read failed; both
  endpoints share the host's estimate-plus-receipt-check gas discipline.
- 4 through 10: the engram layer. ReDoS closed by matching engram targets
  literally, the sessionStorage index-walk closed by snapshotting keys, the
  sanitizer priorities and strictness gating corrected, and the overstated
  privacy copy replaced. 22 vitest regression cases in
  `web/src/lib/__tests__/`, one per defect.
- 20: the host LAN commitment is salted, matching the browser path.
- 22: the premise was wrong. The agents load fine; they were simply gitignored
  and therefore never committed. `.claude/agents/` is now tracked.
- 23: `TODO.md` exists.

### Still open

11 through 16 (DinnerNodeV2, all blocking on deploy), 17 through 19 and 21
(discovery and host hardening), 24 (ngrok rotation), and 25 through 27. Also
new: 16 is now half done, since the serverless clients decode `jobs()` and
`providers()` in one place but `src/host.ts` and `web/src/App.tsx` still index
by hand. See `TODO.md`.

Items 26 and 27 were carried into `TODO.md` under "Docs" rather than under a
numbered heading, which is why a search by number does not find them. 26 is the
presentation pass (engram panel styling, clearer receipt, mobile check); 27 is
the Delta V application, the v3 spec memo and the Gregor one-pager. Both are now
labelled with their numbers in `TODO.md`.

One correction to the original text of item 16: switching the ABI to named
outputs does **not** make index drift a compile error. viem returns a
positional array for these reads regardless of whether the ABI names the
outputs. Centralising the decode is what fixes it.

## 8. Recommended next move

Take the market-supervisor's reordering seriously. The highest-value next steps
are not on the original P0 list: deploy to Monad mainnet, point the cloud
kitchen at a real inference API (Together, Fireworks or Groq at cents per
session) so failover stops being canned text, and rebuild the pitch around
mid-answer provider migration rather than privacy. Fix the three serverless
endpoints first; they are live exposure today and each is a few lines.

Do not deploy DinnerNodeV2 until 11 through 16 are settled.
