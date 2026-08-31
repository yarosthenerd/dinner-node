# DinnerNode security review

Status: in progress. Last updated 2026-08-31, from an audit of what is
RUNNING rather than of what is written. Read section 0 first: the node-side
controls in section 2c went live with a reboot on 2026-08-30, and the browser
half of 2c.1 is still the old deployed bundle.

This file is the checklist that P0-OPS gates on ("wallet and contract review
before real wallets"). It was listed in `.context/HANDOFF.md` section 4 as an
existing file. It did not exist on disk and has never been committed, so this
is a first version rather than an update.

Scope: `contracts/src/*.sol`, `src/chain.ts`, `src/host.ts`, `src/guest.ts`,
`src/faucet.ts`, `src/discovery.ts`, `web/api/**`, and every `writeContract`
call in `web/src/`.

---

## 0. Deployment state, audited 2026-08-31

**The node-side controls in section 2c are now running.** The machine rebooted
at 21:33:28 on 2026-08-30 and all four user units came back. `dinnernode.service`
runs `npm run host` and `dinnernode2.service` runs `npx tsx src/host.ts`, both
straight off the working tree rather than off a build artifact, so the
2026-08-28 late session's work went live with the reboot. That was an accident
of the restart, not a decision, and the 2026-08-29 audit below it is superseded.

Probed on the live daemons on 2026-08-31:

```
POST /lanjob   (via ngrok)  -> 403  "the free LAN path serves this network only"
POST /challenge             -> 400  on a malformed nonce, so the route exists
GET  /provider/models       -> 200
GET  /announce/nonce        -> 400, so the route exists (discovery, port 4175)
GET  /v1/models             -> 501  endpoint_disabled, no API_KEYS set
```

### 0.1 CLOSED: `/lanjob` was an open faucet on the public internet

Recorded here because it was live for about two days and the record should
survive. `/lanjob` opens a job the NODE pays for, out of the node's own
deposit, and the running build had no peer check of any kind. The endpoint was
safe on the sole premise that nobody outside the flat could reach port 4173,
and `dinnernode-tunnel.service` had been publishing that port to the internet
through ngrok the whole time. A well-formed prompt would have escrowed 0.01 MON
of the node's deposit per call, plus opening, settle and close gas, with no
key, no wallet and no rate limit on the caller.

Nobody found it. The journals showed inbound requests from external addresses
and no `/lanjob` traffic, and node 1's on-chain totals were unchanged.

`src/reach.ts` closes it, requiring both a private or loopback peer AND no
forwarding header, and defaulting `LANJOB` to `lan`. It is running now:
the probe above is a real request through the public tunnel, refused.

The lesson worth keeping: the control was written on 2026-08-28 and the hole
stayed open until a reboot happened to pick it up. Writing a fix is not
shipping it, and neither this file nor `SNAPSHOT.md` noticed the reboot that
shipped it.

### 0.2 Half closed: the announce hijack is fixed, the browser is not

The node and discovery halves of 2c.1 are live: discovery answers
`/announce/nonce` and requires a signed announce, and the node answers
`/challenge`. **The deployed client is still the old one.** The live bundle
`assets/index-CN5UhUbj.js` contains no `challenge` and no `proveControl`, so a
`?host=` or `?peer=` link is still trusted on the strength of the named
machine's own `/health`.

The published `terms.html` still carries the old 2.9, which tells the guest we
do not verify the operator of a machine a link names, so the notice and the
deployed code still agree and no published claim is false. The deploy of `web/`
closes this and is no longer the hazard it was on 2026-08-29: the ordering
warning in that audit assumed the nodes 404 on `/challenge`, and they do not.

### 0.3 Not affected

2c.3 and 2c.4 concern `/v1/chat/completions`, which is running but refuses
every request with `endpoint_disabled` because no node sets `API_KEYS`. Before
any node sets it, the API path needs its own notice; see `TODO.md`. Sections 1,
2 and 2b are unaffected by the tree and production split.

---

## 1. Confirmed defects

### 1.1 settle() allows a provider to drain the entire escrow

Severity: critical. Status: fixed in `DinnerNodeV2.sol`, NOT yet deployed.

`contracts/src/DinnerNode.sol:61-82`. `settle(jobId, tokensDelta)` accepts any
`tokensDelta` from the provider. `rawDue` is computed from it directly and
`due` is clamped only by `escrow - paid`. A provider calls
`settle(jobId, 10**12)` once, takes the whole escrow having produced nothing,
and the `rawDue >= remaining` branch then closes the job.

`README.md:16` claims "guest worst-case loss = one settlement". That is false
for the deployed contract. Worst case is the full budget.

Fix: `DinnerNodeV2.sol` clamps `tokensDelta` to
`(block.timestamp - lastSettleAt) * maxTokensPerSecond`, snapshotted per job.

### 1.2 Provider can raise its rate mid-job

Severity: high. Status: fixed in `DinnerNodeV2.sol`, NOT yet deployed.

`DinnerNode.sol:66` reads `providers[msg.sender].ratePerMillion` at settlement
time, and `registerProvider` (line 37) can be called at any time to change it.
A provider advertises one rate, opens a job, then re-registers at a higher rate
and drains faster than the guest agreed to.

Fix: V2 snapshots `ratePerMillion` and `maxTokensPerSecond` into the `Job`
struct at `openJob` and settles against the snapshot.

### 1.3 Escrow permanently stranded by failover

Severity: high. Status: fixed in `web/src/App.tsx`.

`closeJob` was never called anywhere in `web/src`. The old failover path opened
a second job for the same prompt and abandoned the first, leaving it `open`
with its full escrow locked and unrefundable by the app. Every failover leaked
0.01 MON.

Fix: `releaseJob()` plus a `finally` block that closes every job opened and not
finished.

### 1.4 Plaintext prompt written on-chain from the LAN path

Severity: high. Status: fixed in `src/host.ts`.

`src/host.ts` passed `String(prompt).slice(0, 40)` as the `openJob` promptTag,
putting 40 characters of the guest's raw prompt into a public indexed event.
This contradicted `README.md`'s "prompts never touch the chain". The LAN page
is part of the documented test matrix, so the path was exercised.

Fix: the tag became `keccak256(stringToHex(prompt))`, an unsalted commitment.
That was itself a defect, closed later the same day; see 1.14, which salts
this same line.

### 1.5 Unsalted prompt commitment bound to a stable identifier

Severity: high. Status: fixed in `web/src/App.tsx`.

The web path computed `keccak256(sanitizedPrompt + '|' + zkC)` where `zkC` is
the Semaphore identity commitment persisted indefinitely in `localStorage`
under `dn_zk`, identical for every job that browser ever opens. No salt, and
prompts are low-entropy natural language, so the public tag was brute-forceable
from a candidate dictionary and linkable across jobs.

Fix: a fresh 32-byte `crypto.getRandomValues` salt per job, held only in a
local variable for the duration of the call and never written to storage.
`zkC` removed from the preimage. `web/src/App.tsx:283` deliberately keeps the
salt out of `sessionStorage`: a comment there notes that storing it would only
widen the blast radius of any script running on the page.

### 1.6 containsPII returns alternating results for identical input

Severity: medium. Status: fixed in `web/src/lib/engram-sanitizer.ts`.

`containsPII` called `pattern.test(text)` on module-level regexes carrying the
`/g` flag. `.test()` advances `lastIndex` on the shared object, so consecutive
calls on the same string returned true, false, true, false. Reproduced
directly. This function backs the "no personal data detected in prompt" line
shown to the user, so the assurance was not deterministic.

Fix: reset `lastIndex` before and after in `containsPII` and `getPIIStats`.

### 1.7 getLogs cascade never worked

Severity: medium (cause of the "providers 0" bug). Status: fixed.

`HANDOFF.md` section 10 prescribes a getLogs cascade over spans (earliest,
-50k, -20k, -5k, -1k) and `App.tsx` implemented it. The public Monad RPC
rejects all of them:

```
{"code":-32614,"message":"eth_getLogs is limited to a 100 range"}
```

The maximum usable window is 100 blocks, roughly 40 seconds. Registration
history is not recoverable from this endpoint. The old fallback list also
contained only the two wallets retired in the key rotation.

Fix: `src/discovery.ts` uses announce plus `providers(addr)` verification plus
a rolling 99-block tail scan with a persisted cache. `App.tsx` reads the
listener and falls back to on-chain reads of a corrected known list.

### 1.8 Engine streaming truncated long answers

Severity: medium. Status: fixed in `src/engines.ts`.

`ollama()` and `openai()` split each network chunk on `\n` without carrying the
remainder forward, so a JSON object spanning a chunk boundary threw out of the
generator and truncated the answer. Probability rises with output length, which
made it a direct blocker on the P0 "long outputs" item.

Fix: a shared `lines()` reader that buffers across chunks.

### 1.9 Host logged guest prompt text

Severity: medium. Status: fixed in `src/host.ts`.

The host logged the first 60 characters of every prompt to stdout with no
retention policy and no notice to the guest. The node operator is a processor,
not a recipient. Now logs the input token count only.

### 1.10 web/api/topup.js was an unbounded dispenser

Severity: high. Status: bounded, not eliminated. Must not reach mainnet.

The endpoint sent 10 MON to any well-formed address on request. Its only
control was a module-scope `Map` keyed on the caller-supplied address, which on
Vercel is per-serverless-instance and resets on cold start. An attacker looping
fresh addresses met no cooldown at all, and there was no balance check, no
global cap and no per-IP limit.

Fix: **one** control bounds loss, and it is on-chain, so it is global across
instances and unforgeable. The house balance is read before sending; below
`TOPUP_HOUSE_FLOOR` (default 1 MON) the endpoint refuses, so total dispensable
value is `houseBalance - floor` rather than the whole wallet.

The recipient balance check against `TOPUP_RECIPIENT_MAX` is **not** a second
bound and an earlier draft of this section wrongly said it was. An attacker
forwards the grant out in one cheap transfer and requests again with the same
address, and fresh addresses are free regardless. What it does is stop an
honest returning guest re-triggering the faucet.

The floor is also a soft floor: the read and the send are not atomic, so N
concurrent instances read the same pre-drain balance and the wallet can
undershoot by up to `N * AMOUNT`.

**The one control not previously written down is the strongest.** The file
hardcodes `chainId 10143` and a testnet RPC, so it physically cannot dispense
mainnet value without a source edit. That is now an explicit assertion at the
top of the handler rather than an implicit property, and it is a legal control,
not a config default.

Also: amount cut from 10 MON to 0.25, per-IP cooldown alongside per-address,
cooldown claimed only when the request is actually going to spend, both maps
swept so an address-cycling caller cannot grow them without bound, method
allowlist, and a `TOPUP_DISABLED=1` kill switch.

This remains an operator sending native tokens to strangers on request. On
mainnet that is a regulatory exposure independent of the drain risk, and
hardening does not move it: an endpoint that reads a recipient's balance,
applies an eligibility rule and disburses a fixed amount to a named address is
arguably *closer* to a transfer service than an undifferentiated giveaway, not
further from it. There is no de minimis threshold in MiCA's transfer-services
definition and none at all in sanctions screening.

**`TOPUP_DISABLED` is not the mainnet gate.** It is an environment variable, and
a deploy that forgets to set it is a one-variable mistake with regulatory
consequences. The gate is deletion of the file before a mainnet key exists in
the same project. Nothing here logs which addresses were funded either, which
is irrelevant on testnet and a recordkeeping failure on mainnet independent of
licensing. See section 4, and cross-reference 2.1 (shared `HOUSE_PK`): a faucet
drain and provider operation share a failure domain.

### 1.11 web/api/p/health.js registered from an unauthenticated GET

Severity: high. Status: FIXED.

Registration hung off a `catch` around a contract read, so any RPC blip made a
public health poll send a transaction, with no `maxFeePerGas` cap and a 500000
gas limit that Monad charges in full. A public endpoint that spends the house
wallet whenever the RPC is unhappy is a denial-of-wallet.

Fix: a read failure now reports `registered: 'unknown'` with a `degraded` field
and sends nothing. Registration requires a successful read that says the
provider is inactive, is gated behind a ten minute cooldown and a
concurrency guard, and goes through `sendChecked` so it is estimated, fee
capped and receipt checked.

Both guards are **per serverless instance**, because module scope on Vercel is
per instance and resets on cold start. If the contract read genuinely reports
inactive, every warm instance and every cold start fires its own
`registerProvider`, and anyone can drive instance count by polling the public
GET. The residual is bounded and self-closing, since the first success flips
`active` and every subsequent read short-circuits. The read-failure property,
which is the one that mattered, is global and holds unconditionally.

### 1.12 Serverless settlements were loose on gas and swallowed reverts

Severity: medium. Status: FIXED.

`web/api/p/job.js` used `gas: 300000n` for `settle` against a host that needs
roughly 118000, and `200000n` for `closeJob` against 120000, on a `settle` that
fires every fifteen tokens. Monad charges the limit, so this overpaid by two to
three times on every call. Both writes also ended in `.catch(() => {})`, which
is the same defect as 1.3 in a different file: `writeContract` resolves on
acceptance, so a reverted settlement was indistinguishable from a payment.

Fix: `gasFor` and `sendChecked` moved into `web/api/p/_lib.js`, matching
`src/host.ts`. Estimate per call plus twenty percent, fall back to the host's
own limits, cap `maxFeePerGas`, and check the receipt. Settlements are
serialized on a promise chain so `closeJob` cannot overtake the `settle` before
it, and a failure is reported to the client on the stream rather than dropped.

### 1.13 ABI index drift would have broken every client silently

Severity: medium. Status: fixed for the serverless clients, OPEN elsewhere.

DinnerNodeV2 grows `jobs()` from six fields to ten and `providers()` from seven
to eight, moving `open` from index 5 to 9 and `active` from 6 to 7. Every
liveness check reads those by hand-written index, and a non-zero rate at the
old index is truthy, so deploying V2 would have made every client believe every
job was open. Note that viem returns a positional array for these reads even
when the ABI names its outputs, so named outputs alone do not fix this.

Fix: `readJob` and `readProvider` in `web/api/p/_lib.js` decode in one place.
`src/host.ts` and `web/src/App.tsx` still index by hand and must be given the
same treatment before V2 is deployed. Tracked as TODO.md P1 item 16.

### 1.14 Host LAN commitment was unsalted

Severity: medium. Status: FIXED.

`src/host.ts` wrote `keccak256(prompt)` as the `openJob` tag. Prompts are
low-entropy natural language, so an unsalted commitment on a public event is
recoverable with a candidate dictionary. The browser path was salted on
2026-08-25 (1.5) and the LAN path was left leaking what the browser path
protects. Now salted with 32 random bytes, used once and discarded, matching
`web/src/App.tsx`.

**Terminology, corrected.** Earlier drafts, and the code comment, described this
as landing in the EDPB "commitment carve-out". It does not. EDPB Guidelines
02/2025 v2.0 para 53 requires a **perfectly hiding** scheme (Pedersen and
similar); keccak is computationally hiding. What applies is **para 52**, salted
hashing, whose conditions we do meet: CSPRNG salt, destroyed before the function
returns, algorithm unbroken. Para 52 also states plainly that the hash is itself
personal data at the moment it is written. So the accurate claim is "salted hash
under para 52, salt destroyed at generation", never "inside the commitment
carve-out". A diligence reader will check whether the scheme is perfectly hiding.

**A third path was missed entirely.** `src/guest.ts` still passed
`prompt.slice(0, 40)` to `openJob` until it was fixed alongside this entry. See
1.16.

### 1.15 Engram layer: ReDoS, lost engrams, and overstated copy

Severity: high (ReDoS), medium (the rest). Status: FIXED, with regression tests.

- `extractSanitizationRules` compiled engram statement text into `new RegExp`.
  Measured: 28 characters took 1612 ms, 41 characters did not return in 110
  seconds. The tab freezes before the prompt is ever sent. Engram targets are
  now escaped and matched literally, with a length cap and a rule-count cap.
- `getAllEngrams` and `runCleanup` removed from `sessionStorage` while walking
  it by index. Because the store is indexed live, every key after a removal was
  skipped, so stale engrams survived and valid ones were dropped from the set
  used to sanitize the prompt. Keys are now snapshotted first.
- `location_personal` was reported as detected and then discarded at minimal
  strictness, telling the user their city had been removed when it had not.
- `credit_card` could never fire, because `phone` shared its priority and ran
  first. `[CREDIT_CARD]` appeared in no output the app has ever produced. Note
  that reordering the priorities alone did not close this: a mutation test that
  restored the original ordering still passed, because the phone pattern's new
  digit-count guard rejects a 16 digit run. The card pattern was also only ever
  a 16 digit 4x4 layout, so a 15 digit Amex fell through to `phone` and was
  labelled `[PHONE]`. Both are now fixed: the card pattern matches 13 to 19
  digits and is gated on a Luhn check, which is what actually distinguishes a
  card from a phone number, and the priority ordering is load-bearing again.
- `EngramSelector.tsx` claimed "Providers and the chain never see raw personal
  data". False in both halves. Replaced with what is actually true.

`web/src/lib/__tests__/` now holds 22 vitest cases, one per defect. Run with
`npm test` in `web/`.

### 1.16 src/guest.ts wrote the raw prompt on chain, uncapped and unsequenced

Severity: high. Status: FIXED.

`src/guest.ts:23` passed `prompt.slice(0, 40)` as the `openJob` tag. This is
defect 1.4 verbatim in a third file. It was fixed in `src/host.ts` and in
`web/src/App.tsx`, and missed here, while `README.md` and the published
`web/public/terms.html` section 2.2 both went on to assert that prompt text
never reaches the chain. A false statement in a published legal document is a
worse posture than the leak itself.

It is not dead code: `package.json` exposes it as `npm run rent`, and it is the
documented CLI demo path. Note the CLI has no sanitizer at all, because
sanitization is browser-only, so a CLI prompt reaches the provider exactly as
typed. That is now stated in the file.

The same file also violated three Monad rules: no `gas` and no `maxFeePerGas`
on either write, and `openJob` issued immediately after `deposit()` with no
receipt in between. The last is the documented nonce-collision case; it
survived only because viem re-fetches a pending nonce, which is racy rather
than correct. All fixed, and the commitment now matches the other two paths
byte for byte.

### 1.17 Serverless closeJob was sent after the contract had already closed the job

Severity: medium. Status: FIXED.

Verified with Foundry: when `rawDue >= remaining`, `settle` sets
`j.open = false` (`DinnerNode.sol:78-81`), so the `closeJob` that follows
reverts on `require(j.open)`. `gasFor` swallows the estimate revert and returns
the fallback, so the code sent a transaction it had already been told would
fail, and Monad charged the full limit for it. Reachable today on the host path:
at `RATE_PER_MILLION = 2e18` and a 0.01 MON budget the escrow exhausts at 5000
tokens, which a long answer reaches.

Fix: re-read the job and skip `closeJob` when it is already closed. The
`closeJob` fallback limit also dropped from 120000 to 60000 against a measured
26706.

### 1.18 Engram replacement text was unbounded, and multi-rule statements collapsed

Severity: high. Status: FIXED. Introduced by the 1.15 fix, found by audit.

The 1.15 ReDoS fix capped the rule *target* and left the *replacement* as a
greedy `(.+)` running to end of line. Two consequences, both measured:

- A padded statement expanded a 350 character prompt to 600,050 characters, a
  1714x amplification. That expansion is what gets hashed and sent to the
  provider, while the token estimate shown to the user is computed on the
  pre-sanitization text.
- `replace Alice with [A]. replace Bob with [B]` extracted as ONE rule whose
  replacement was `[A]. replace Bob with [B]`, splicing literal statement text
  into the user's prompt. This also made `MAX_RULES_PER_ENGRAM` unreachable for
  every period-separated statement, which is how the library templates are
  written.

Fix: the replacement is bounded to 64 characters and may not cross a sentence
or newline.

---

## 2. Open items

### 2.1 House wallet is also the cloud-kitchen provider

Severity: medium, and a metrics-integrity problem more than a security one.
Status: OPEN.

`web/api/p/_lib.js` derives the cloud-kitchen provider account from the same
`HOUSE_PK` used by the faucet. The on-chain graph is a closed loop: house funds
guest, guest escrows, escrow pays house. Any "jobs", "settled total", or
"earned" figure that includes this loop is house-to-house flow and must not be
presented as usage or revenue.

### 2.2 Model is not pinned — CLOSED 2026-08-28

`MODEL` set to something not installed used to fall back to whatever was first
in the local ollama list. It now refuses to start and prints what is installed.
The original text follows.

### 2.2 Model is not pinned

Severity: low. Status: OPEN.

`src/host.ts` falls back to `process.env.MODEL ?? names[0]`, so a node serves
whatever model happens to be first in the local ollama list. A node operator
with a restrictively licensed model installed would serve it commercially
without deciding to. `/health` reports the model, so an allowlist is possible.

### 2.3 DinnerNodeV2 is unreviewed by a third party and undeployed

Severity: n/a. Status: OPEN. Do not deploy without an independent read.

---

## 2b. Unpriced prefill, found 2026-08-28 (night)

`settle()` charges `tokensDelta`, which counts tokens the node GENERATED. A
prompt is therefore free, however long it is, and that is a deliberate pricing
choice published as "free on input". It is also an unmetered claim on the
node's scarcest resource.

**The shape of it.** `gate()` in `src/host.ts` rejects a prompt only when it
exceeds `PROMPT_BUDGET`, derived from `CONTEXT_TOKENS` (32,768). Under that
ceiling, a guest can send a 30,000 token prompt, receive one token, and pay for
one token, while the node performs the full prefill. No exploit code is
required. The cost to the attacker is one `openJob` and its gas; the cost to
the node is its entire context window of GPU work, repeated.

`MAX_CONCURRENT` and the pressure throttle bound how many run at once, which
makes this a degradation rather than a takedown, and a job still needs escrow
to open. Neither bounds the work per job.

**Not fixed.** It sits with a product decision rather than alone: free input is
the strongest economic claim the project has at high input-to-output ratios,
and honouring that claim means serving long contexts, which the current
`CONTEXT_TOKENS` cannot do and `.context/REFRAME.md` section 4 says we will not
sell. Bill input at a nominal rate, or bound prompt length against the escrow,
and decide both together. See `TODO.md` P2.

**Standing invariant, worth stating once.** The legal review of 2026-08-28
named the strongest single compliance fact this project has, and it became true
only that day: *no key the operator controls may sign a value movement a third
party can trigger.* The faucet deletion and the removal of `web/api/p/*` are
what made it true, and `reassign` does not weaken it, since
`DinnerNodeV2.sol:456` requires `msg.sender == j.requester`. Treat it as a rule
for anything proposed later rather than as a closed item.

## 2c. Closed in the tree 2026-08-28 (late), NOT deployed

Four items, each verified by attacking it rather than by reading the fix.

**Read with section 0.** These fixes are written, tested and uncommitted. The
running node and discovery have none of them, and two of the four holes below
are open in production today. The wording "closed" throughout this section
means closed in the working tree.

### 2c.1 `/announce` and `?peer=` accepted a machine's claim about itself

`POST /announce` verified that an announced address was a registered provider
and never that the announcer controlled it, so anyone could point a live
provider's slot at their own host and be handed guests' prompts. They could not
be paid, because settlement goes to the registered address on chain, but they
read the prompt and the partial answer. The browser had the same hole through
`?host=` and `?peer=`, where it read a provider address out of the named
machine's own `/health`.

Closed with one mechanism for both: a nonce the claimant did not choose, signed
by the key the registry pays. `src/attest.ts` holds the format and the store,
imports nothing, and is unit tested. The signed claim names purpose, registry,
chain, provider, URL, model and nonce, so a signature cannot be replayed as a
control proof, against another deployment, or lifted onto a different host. The
nonce is single use, expires in 60 seconds, and is CONSUMED BEFORE the
signature is checked so a wrong signature burns it rather than allowing
grinding. The nonce must be exactly 64 hex characters, which is load bearing
rather than tidy: the message is line-based and the nonce is the one
caller-supplied field, so a newline in it would sign a claim the signer never
saw.

Attacked against a local anvil: a hijack signed by another key, an unsigned
announce in the old shape, a valid signature replayed, and a valid signature
moved onto a different URL. All four refused.

**Still open in production, 2026-08-29.** See section 0.2. The live discovery
404s `/announce/nonce`, and the deployed client has no `proveControl`.

**Not backward compatible.** An old node announcing to a new discovery is
rejected; a new node finds no nonce endpoint on an old discovery. Restart nodes
and discovery together.

### 2c.2 `/lanjob` was about to become an open faucet

It opens a job the NODE pays for, which is the point of the LAN guest page, and
it was safe for exactly one reason: nobody outside the network could reach the
port. A tunnel ends that invisibly, because every tunnelled request arrives at
the node from 127.0.0.1, so an address check alone reads "local" for the whole
internet. `src/reach.ts` requires both halves, a private or loopback peer AND
no forwarding header, and was verified against the exact shapes cloudflared and
ngrok send. `LANJOB=off|lan|open`, default `lan`.

**The tunnel did not end it invisibly at some future point. It had already
ended it.** The running build has no peer check and is published through ngrok,
so this is a live exposure rather than an anticipated one. See section 0.1,
which records the probe.

### 2c.3 A new endpoint that spends the node's own money

`/v1/chat/completions` fronts jobs from the node's deposit, because an OpenAI
client holds a key rather than a wallet. Controls, all of them defaults rather
than options: the endpoint is OFF unless `API_KEYS` is set, keys are compared
as SHA-256 digests in constant time so neither length nor a matching prefix
leaks, `V1_DAILY_TOKENS` caps what it can bill in a rolling day, `max_tokens`
is clamped to what the escrow can pay for, and the existing concurrency and
pressure gates apply unchanged.

### 2c.4 Two defects in the job-opening path, older than the endpoint

Found by running four concurrent requests rather than by review. Every write
from the provider key was serialized through `queue` except the one that opens
a job, so an opening raced the previous job's `closeJob` on the nonce. And the
deposit check was not atomic with the opening, so concurrent requests all saw
enough float for one job and the rest reverted, reported as "cannot read
properties of undefined" because the code read the event off a reverted
receipt. Both halves now run inside one `serialized()` unit, and receipt status
is checked before the event is read. `/lanjob` shared both and never hit them.

## 3. Monad transaction discipline checklist

Applied to every `writeContract` and `sendTransaction` site.

- [x] Explicit `gas` on every write, including `src/guest.ts`, which previously
      had none at all. Monad charges gas_limit, not gas_used. See the item below
      on which of these are actually tight.
- [x] `maxFeePerGas` capped at 2000 gwei in `src/host.ts` and `src/guest.ts`.
      The `web/api/p/*` and `web/api/topup.js` sites this also covered no longer
      exist; both were deleted, `web/api/p/*` in `fd86fb8` and the faucet on
      2026-08-28.
- [x] `maxFeePerGas` cap on the `web/src` guest writes.
- [x] Gas estimated per call for `settle` and `closeJob` in `src/host.ts`. A
      fixed limit reverted after every key rotation. The two serverless
      endpoints this also covered are deleted.
- [ ] `deposit`, `openJob` and `registerProvider` still use fixed padded limits
      in `src/host.ts`, `src/guest.ts` and `web/src/App.tsx`. Measured with
      Foundry: `deposit` 55094 against a 200000 limit (3.6x), `openJob` 166702
      against 250000 to 300000 (1.5x to 1.8x), `registerProvider` 126392 first
      and 29665 on a repeat against 250000 (2.0x to 8.4x). Explicit, but not
      tight, and Monad charges the limit.
- [x] Receipt checked on every write. `writeContract` resolves on acceptance.
- [x] `deposit()` sequenced on a receipt before `openJob()` in host, web and CLI.
- [ ] House writes are serialized per serverless instance only. Two concurrent
      cloud-kitchen jobs on different Vercel instances share `HOUSE_PK` and
      collide on the nonce; a public `health.js` poll can collide with an
      in-flight settle the same way. Needs a shared nonce source or a single
      serialized worker.
- [n/a] Sweep reserve rule. `src/faucet.ts` only POSTs to the external devnads
      faucet API and sends no transaction of its own, so there is no sweep in
      the repo for the rule to apply to. The sweep described in HANDOFF
      section 8 was run ad hoc and is not committed.
- [x] No `getLogs` call exceeds the 100-block RPC ceiling.

---

## 4. Before real wallets or mainnet

Blocking, in order:

0. Get the tree deployed, which is a prerequisite for every claim this file
   makes about a fix being in place. Added 2026-08-29. Section 0 is the state,
   and 0.1 is live and reachable today.
1. Deploy and independently review a fixed contract. Items 1.1 and 1.2 are
   exploitable by any registered provider against any guest.
2. ~~**Delete** `web/api/topup.js`~~. **Done 2026-08-28**, deleted rather than
   disabled (1.10), because `TOPUP_DISABLED` is an environment variable and is
   not a gate. The reasoning it was deleted for stands as a rule for anything
   proposed later: on mainnet an operator sending native tokens of value to
   users on request, with no KYC, no limit and no sanctions screening, has
   regulatory exposure separate from the drain risk. Users fund their own
   wallets. `web/src/lib.ts` `faucet()` now calls only the public testnet
   faucet, which is not operated by us.
3. ~~Separate the faucet key from the provider key (2.2).~~ Moot 2026-08-28:
   there is no faucet and no serverless provider, so `HOUSE_PK` signs nothing a
   guest can trigger.
4. Legal review. See the separate legal findings: escrow-as-custody under MiCA
   and the Serbian Law on Digital Assets, and the house wallet as a possible
   transfer service, both need Serbian counsel before any value is real.
