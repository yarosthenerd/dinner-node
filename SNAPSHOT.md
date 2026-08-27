# Session snapshot, 2026-08-27 (evening)

> Newest first. Earlier snapshots follow below, unchanged.
> `TODO.md` remains the roadmap; this is the build and defect state.

## 1. Headline

Plan as a job runs end to end on the live node and settles on chain.
Getting there took five defects, and **every one of them was found by running
the thing, not by reading it.** Four had been invisible because the failing
component reported success.

- **A plan produced no output and reported `ok=true`.** Six steps, six
  completions, zero visible tokens, 0.312 MON charged. See section 3.
- **The node served 5,907 tokens and settled none of them**, because the
  provider wallet was empty, while `/health` said `accepting: true`. See
  section 5.
- **The hosted kitchen has rejected every JSON request it has ever
  received.** Not the missing resume path SNAPSHOT recorded; the resume path
  was already there and nothing ever reached it. See section 6.
- **The faucet was drained of about 9.6 MON during the session** by an
  outside caller. Not fixed; blocked on a permission. See section 7.
- A 153 second planning run was thrown away over a step id one character too
  long. See section 3.

Pricing is now derived from the market for the exact model served rather than
from a hand-set constant, and it counts the input we do not charge for.

**Resuming work: read section 12 first.** It carries the next steps split into
what needs the operator, what can start unattended, and what needs a decision.

## 2. Plan as a job: it works

`src/executor.ts` walks a plan wave by wave, transport-free and chain-free the
way `plan.ts` and `planner.ts` are. `Dispatch` takes a step, a composed prompt
and a signal, which is this node's engine today and a peer's `/job` later with
no change to the executor.

Host endpoints: `/plan` produces a plan and bills the tokens that produced it,
`/plan/run` executes one the guest has accepted. Both bill through the same
`active` map `serveJob` uses, so the existing value-triggered settle ticker
pays out mid-run with no second billing path. `/plan/run` re-validates against
the escrow actually left on the job rather than trusting the wire. `/health`
advertises `plans.supported` and the caps.

**Final live run, job#79:**

```
7 steps, 4 waves, all completed with visible output
planning       113.7 s, 1 attempt
execution      355.4 s
settled        0.4813070625 MON for 14,405 tokens
```

Wave 1 ran three independent steps, wave 2 two, then two single-step waves. A
real diamond DAG, executed and paid for.

**Planning is 153 s, not 8.4 minutes.** That was SNAPSHOT's open question. The
8.4 figure was the 27B; on the MoE a plan lands in 56 to 114 seconds.

## 3. Two defects that reported success

**A 33 character step id.** A 153 second run returned a good six step plan
whose fifth id was `determine-break-even-and-conclude`, one character over the
32 cap. The retry produced the same class of id and the run was discarded. The
guest was billed twice and got nothing. Two causes: the planner prompt never
stated the limit, and the validator's answer to a one character overrun was to
throw away a plan correct in every other respect. `normalizeIds` now repairs
deterministically and rewrites every reference to a repaired id, and the 32 is
`PLAN_LIMITS.maxIdChars`, read by the prompt, the validator and the repair.

**A ceiling spent entirely on reasoning.** All six steps of job#76 burned their
whole 1,024 token ceiling thinking, emitted nothing, and the run reported
`ok=true` with six of six completed. 9,339 tokens, 0.3120393375 MON, empty
answer. It compounded: wave 2 ran against empty dependency output and produced
its own empty results, and nothing had reason to complain.

The cause is the ceiling being enforced on BILLED tokens, which is correct and
stays: `maxTokens` is what `planCostWei` escrows, and counting only visible
output would let a reasoning-heavy step bill several times what the guest
approved. On a reasoning model the reasoning arrives first, so a ceiling under
the thinking budget is spent before a visible token exists.

Three changes, none of which relax the cost guarantee: `minTokensPerStep` 2048,
`normalizeTokens` clamping into range so the guest approves the ceiling that
will actually apply, and the executor failing a step that hits its ceiling with
nothing visible, naming the number to raise it above.

## 4. Reasoning is 13x, and plan steps do not need it

Raising the floor was not enough: job#77 failed three steps at a 3,072 ceiling
the same way, and `maxTokensPerStep` caps at 4,096.

Measured on `qwen3.6:35b-a3b`, one short prompt, identical otherwise:

| | thinking frames | visible frames |
|---|---|---|
| `think: true` | 317 | 25 |
| `think: false` | 0 | 32 |

Reasoning is billed here, so a bounded sub-task that reasons costs about
thirteen times what it needs to. `ollama()` takes `think`, sent only when
disabling it because a model without a thinking mode rejects an unexpected
parameter. `/plan/run` dispatches with it off.

Left ON in two places deliberately. A guest's own prompt streams its reasoning,
which is disclosed and part of what they are buying. And the planner reasons,
because choosing the shape of the work is exactly the case reasoning earns its
cost.

## 5. A node that cannot pay to be paid

The provider wallet reached 0.0007 MON mid-session. Every settle reverted with
`Signer had insufficient balance`, `registerProvider` failed three times, and
the node carried on answering. Job#78: four steps completed, 5,907 billed
tokens, `paid 0 for 0 tokens` on chain. The guest got the work free, the
operator paid the electricity, and `/health` advertised `accepting: true`
throughout.

`gate()` now refuses with 503 and a balance, checked BEFORE the pressure check
because this is not a wait-and-retry: no amount of patience refills a wallet.
`/health` reports balance, floor and settles covered. The floor is ten settles
at the last observed gas price rather than a constant, so it moves with the
base fee.

## 6. The hosted kitchen has never accepted a browser request

SNAPSHOT has said since 2026-08-26 that `web/api/p/job.js` "does not accept a
resume payload at all". That is wrong. It destructures `resume`, bounds it at
`MAX_RESUME_CHARS`, verifies the keccak checkpoint and refuses on a mismatch.
All of that was already built.

What is broken is one line above it. Vercel's Node runtime parses a JSON body
into an OBJECT before the handler sees it; the handler called `JSON.parse`
unconditionally, so `JSON.parse({...})` stringified to `"[object Object]"` and
threw. Confirmed by hand against production:

```
content-type: application/json  -> 400 "bad body"
content-type: text/plain        -> reaches the handler ("not my job")
```

The browser sends `application/json`. **Every failover the web app has ever
attempted was rejected before it reached the resume path.** That, not a missing
feature, is why mid-answer migration could not be reproduced from a browser.

**Leg one of migration is verified.** Job#80: the node produced 128 visible
tokens, published a checkpoint, the prefix hashed to it, and it settled
0.0448061625 MON for 1,341 tokens. Leg two is untested, because the fix
deployed but the alias still answered 400 on the check afterwards and that is
not yet explained. `scripts/migrate-e2e.mjs` runs the whole thing and asserts
two providers paid for disjoint ranges; it is ready to run once leg two
responds.

## 7. The faucet is being drained

The house wallet fell from 15.055 to about 5.4 MON during the session, none of
it from anything run here. Vercel logs show `/api/topup` hit repeatedly, 200s
interleaved with 429s from the per-IP cooldown, over roughly eleven minutes.
Each 200 is a 1.2 MON grant.

This is the threat model `web/api/topup.js` documents in its own header:
drainable by construction, because fresh addresses are free and the cooldown is
per serverless instance. `HOUSE_FLOOR` has since stopped it, since 1.43 MON is
below floor plus amount, so the endpoint now refuses. **It will drain again the
moment the house is refilled.**

**Not fixed.** Setting `TOPUP_DISABLED` was blocked by a permission prompt. The
operator needs to run:

```
cd ~/monad-synapse/web && printf '1' | npx vercel env add TOPUP_DISABLED production --visibility config --no-sensitive && npx vercel --prod --yes
```

## 8. Pricing, from the market rather than by hand

The rate was one constant for every model, hand set, justified in `TODO.md`
against a price band for a model this node does not run. `src/pricing.ts`
resolves it from the OpenRouter endpoints listing for the exact weights served.

Measured 2026-08-27 for `qwen/qwen3.6-35b-a3b`, ten providers:

| provider | output $/M | input $/M |
|---|---|---|
| **Darkbloom** | 0.700 | 0.070 |
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

**Darkbloom is already an OpenRouter provider for the exact model this node
serves.** An earlier note in this session that we were 6x more expensive than
Darkbloom was wrong: it compared their Gemma 4 26B against our Qwen. Like for
like we are 1.44x the cheapest and below the ten provider median of $1.114.

Policy is a position in the band times a discount, defaulting to median. This
node runs `median x 0.9` = $1.002/M, which holds the price it already
advertised while making the number derived. An explicit `RATE_PER_MILLION`
still wins; it is commented out in this node's `.env` so the market path runs.
A failed lookup falls back to the pinned 2026-08-27 band, and the source is
published either way.

**Input is the part the output column hides.** `settle()` charges tokensDelta,
which counts tokens this node GENERATED, so a prompt is free here however long
it is. Every provider on that listing bills input. A rival's true price as an
output-only figure is `outUsd + ratio * inUsd`:

- cheaper than 5 of 10 on output alone
- cheaper than 8 of 10 at a 1:1 prompt-to-answer ratio
- cheaper than all 10 at 5:1
- cheaper than Darkbloom once a prompt is **4.3x** the answer

That is the honest form of "we do not charge for input": it is worth a specific
amount and the amount is a ratio. Published in `/health` next to the band.

## 9. Hardware breadth

The catalog stopped at `qwen3:14b`, so every card above 16 GB got the same
recommendation and a 5090 owner was told to serve a third of what their
hardware holds. Added `qwen3.6:35b-a3b`, measured from the registry manifest
and GGUF metadata header the way every other row was: 21,573 MiB weights,
83,968 B/token KV, trained to 262,144.

MoE rather than a dense model of similar size, and the KV geometry is the
argument: 83,968 B/token against the dense 27B's 266,240, so on a 32 GB card it
reaches 132k of context where the dense model stops at 59k.

It is a 32 GB entry, not a 24 GB one. `probeHardware` allots 90% of VRAM, so a
24 GB card offers 22,118 MiB against this model's 23,485 at 16k context. Both
tiers are asserted as tests.

**A real gap remains at 24 GB**, where nothing sits between 14B and this.
`qwen3.8:27b` would fit at 16k, but every measurement this project has of it
was taken on a card where it spilled to CPU, so it is not added on a guess.
Closing it needs someone with a 3090 or 4090, which is also the first useful
thing an early node operator could contribute.

## 10. Live state

```
node        qwen3.6:35b-a3b, ollama, plans supported, gas gate active
price       $1.002/M output, input free, live from OpenRouter, break-even 309 tok
web         web-egmtyr14i deployed; /api/p/job still 400 at the alias, unexplained
contract    V1 0xaF2c...3A92, jobCounter 82
ratings     0xeb0d...d87f, group 0, zero members
house       0xA91a...5CF4   1.4285 MON  <- faucet drained, refuses grants
provider    0x055a...326A  26.9014 MON  <- refilled by the operator mid-session
guest       0xCDd9...5411   1.3154 MON, plus 0.74654 on deposit
tests       100 in the root suite, 104 in web
```

Eight commits: `883df75` catalog, `52a1c4f` and `e09ae94` pricing, `612c0ea`
executor and plan endpoints, `02c6bd7` id repair, `9002cba` ceiling failure,
`65b5090` reasoning off for steps, `ad51aa6` gas gate, `5389f15` cloud body.

## 11. Open, in priority order

1. **Disable the faucet.** Section 7 has the command. Everything else here is
   cheaper than the money that leaves while it is enabled.
2. **Finish the migration test.** `node scripts/migrate-e2e.mjs`. Leg one is
   verified on chain; leg two needs `/api/p/job` to stop answering 400 at the
   alias. Once it passes, this is the migration demo, recordable.
3. **The cloud kitchen still returns canned text.** No inference API key exists
   in any environment, so it cannot become a real second model without the
   operator obtaining one. The chain mechanics around it are real; the words
   are not.
4. **Cap the fee on the two ratings writes** in `web/src/lib/ratings.ts`, which
   are the only browser writes without `MAX_FEE`.
5. **A failed plan still bills.** Job#75 charged 0.2736 MON for planning that
   produced nothing. The node did the work, so this is a policy question rather
   than a defect, but a guest will not read it that way.
6. **Correct `terms.html` on the prompt commitment**, narrowed from per prompt
   to per session opener. Still a live claim the code does not support.
7. **Separate `HOUSE_PK`** into faucet and cloud-kitchen keys.
8. **`TODO.md` pricing section is now wrong** in the other direction and should
   be rewritten around section 8.
9. Carried forward: surface the `engine` field in the browser, the gas comment
   in `web/api/p/_lib.js`, node distribution and `src/discovery.ts`,
   `web/api/topup.js` deletion before mainnet.

## 12. Next session, start here

Written so work can resume without re-deriving any of the above. Everything in
B can begin unattended; A and C cannot.

### A. Needs the operator, before anything else

1. **Disable the faucet.** Money leaves while this waits, and the endpoint
   resumes granting the moment the house is refilled.

   ```
   cd ~/monad-synapse/web && printf '1' | npx vercel env add TOPUP_DISABLED production --visibility config --no-sensitive && npx vercel --prod --yes
   ```

2. **Refill the house wallet**, but only after step 1. It sits at 1.4285 MON
   and is also the cloud-kitchen provider key, so at this level the hosted
   kitchen has gas for roughly a dozen settlements and the faucet dispenses
   nothing. 8 MON restores both.

3. **An inference API key**, if the cloud kitchen is to serve real tokens.
   None exists in any environment: not in `.env`, not in Vercel, not in the
   shell. Without one, item B3 stops at "the chain mechanics are real, the
   words are canned". Any OpenAI-compatible endpoint works; `src/engines.ts`
   already has the client.

4. **The domain**, when bought. It closes the MetaMask warning, the three
   Gmail contact addresses in the legal pages, and `TODO.md` item 2 together.

### B. Ready to start unattended, in order

1. **Finish the migration test.** This is the differentiator and it is one
   defect away from being recordable.

   ```
   node scripts/migrate-e2e.mjs
   ```

   Leg one is verified on chain: job#80 produced 128 tokens, published a
   checkpoint, the prefix hashed to it, 0.0448061625 MON settled. Leg two
   returns 400 from `/api/p/job` at the alias even after the body fix
   deployed, and that is the thing to diagnose first. The likeliest causes,
   in order: the alias still resolving to the previous deployment, or
   `req.body` arriving as a Buffer rather than the object or string the fix
   handles. Distinguish them by reading the 400's text, which the retry did
   not capture: "bad body" is the parse, "bad jobId" is a Buffer falling
   through to an undefined destructure.

2. **Cap the fee on the two ratings writes.** `joinWithJob` and
   `rateProvider` in `web/src/lib/ratings.ts` pass a gas limit and no
   `maxFeePerGas`, the only browser writes without the `MAX_FEE` cap every
   other one has. Small, and it is the guest's own wallet now.

3. **Rewrite `TODO.md`'s pricing section** around section 8 above. It
   currently claims a 60 to 78 percent discount to market, benchmarked
   against a 70B input band for a model this node does not serve. The true
   position is 1.44x the cheapest provider, below the ten provider median,
   and free on input.

4. **Correct `terms.html` on the prompt commitment.** Session jobs narrowed it
   from per prompt to per session opener. A live claim the code does not
   support, and the only item here with a legal edge.

5. **Surface the `engine` field in the browser**, so a guest can tell a mock
   provider from a real one. The hosted kitchen is a mock and says so in
   `/health`; nothing in the UI reads it.

### C. Needs a decision, not code

1. **Should a failed plan bill?** Job#75 charged 0.2736 MON for planning that
   produced nothing. The node did the work, so charging is defensible, and a
   guest will not read it that way. Options: bill nothing on a failed plan,
   bill at a reduced rate, or bill in full and say so before the run starts.

2. **Where to sit in the price band.** `PRICE_POLICY` and `PRICE_DISCOUNT` in
   `.env` are the levers and the node re-reads them on restart. Today
   `median x 0.9`, which is $1.002/M. Undercutting Darkbloom's $0.700 on
   output alone would mean roughly `median x 0.62`, and the break-even line
   in the startup log moves from 309 tokens to about 500. Section 8 has the
   input-side argument for not needing to.

3. **Whether to add a 24 GB catalog entry on an unmeasured guess.** Section 9.
   The alternative is waiting for an operator with a 3090 or 4090.

### Done in the last ten minutes of the session

Three certain items off list B, plus two drafts.

- **Ratings writes capped.** `joinWithJob` and `rateProvider` now carry
  `maxFeePerGas`, so no browser write is uncapped during a base fee spike.
- **The `engine` field is surfaced.** The composer says which model and engine
  the selected host runs, and warns plainly when a host reports `mock`. This
  closes an item carried since 2026-08-27 morning.
- **`TODO.md` pricing section rewritten** around the measured band. The old
  version claimed a 60 to 78 percent discount against a 70B input price for a
  model this node has never served.
- **`terms.html` corrected on the prompt commitment.** It now says one
  commitment per job rather than per message, that later turns of a
  conversation are not committed at all, and that the on-chain record is not a
  per-message log. This was the item with a legal edge.
- **Two drafts in `.context/drafts/`**, untracked like everything in
  `.context`: `x-post.md` carries two options, a four item gate that must be
  true before posting, and the sourcing for every number in it;
  `competitor-darkbloom.md` is the mentor-facing brief, including a section on
  what we deliberately do not claim.

### Plan front end, first cut

Built 2026-08-27 evening, after the steps above were written. Not yet clicked
through in a browser: it typechecks, lints, builds and the wire format is the
one `scripts/plan-e2e.mjs` already exercised against the live node, but no
human has run it.

- `web/src/lib/plan-client.ts` is transport only: SSE reading, `requestPlan`,
  `runPlan`, and a `waves()` that mirrors `readySteps` so the UI can draw the
  wave structure before anything runs. The event shapes are duplicated from
  `src/executor.ts` rather than imported, because the browser and the daemon
  are separate builds; that file is where to look when the node's frames change
  and the UI stops understanding them.
- `web/src/components/PlanPanel.tsx` has three phases, and the middle one is
  the whole point: the guest sees the plan, its waves and its committed ceiling
  BEFORE any step runs, and nothing executes until they approve. A plan that
  ran on approval would be an agent; a plan the guest approves is a quote.
- The panel opens the job itself, because planning is billed and the escrow
  funds both halves. `PLAN_BUDGET` is 1.5 MON, sized from the measured seven
  step run that billed 14,405 tokens end to end.
- Lazy loaded, so a guest who only wants one answer does not pay for it:
  `PlanPanel-*.js` is 8.51 kB and first paint moved 593.8 to 595.3 kB.
- The mode toggle only appears when `/health` reports `plans.supported`, so a
  guest is never offered a feature the selected host will 404.

To try it: `cd web && npm run dev`, pick a host that advertises plans, and
switch to "plan a job".

### Two models, two providers, two prices

Done 2026-08-27 evening. The network had one provider and one price for every
model, which is one machine with a price list rather than a marketplace.

A second node runs on this laptop with its own key, its own model and its own
market-derived rate. On chain now:

| provider | model | rate | break-even |
|---|---|---|---|
| `0x055a...326A` | qwen3.6:35b-a3b | 33.41 MON/M, $1.002 | 309 tok |
| `0x1978...94d3` | llama3.2:1b | 6.70 MON/M, $0.201 | 1,538 tok |

Both prices are resolved live from each model's own OpenRouter listing, which
is `src/pricing.ts` doing the thing it was built for rather than being
exercised by one model.

The small model is deliberate: 1.3 GB, 100% on GPU, warm in 3.1 s, first token
in 0.0 s, and it runs on CPU well enough that it coexists with the 35B MoE
instead of evicting it. It is the configuration an old laptop or a cheap VPS
would actually run, which makes it the "runs on anything" claim rather than a
statement about it.

**Verified by serving a real job.** Job#83 on the small node: 65 visible tokens
in 0.3 s at 196.4 tok/s, settled 0.0004355 MON on chain.

**And it lost money doing it, which is worth stating plainly.** 65 tokens
against a 1,538 token break-even means the settle cost about 0.0103 MON to
collect 0.0004. A small-model node is for demo integrity, network truth and
proving the long tail. It is not a revenue node, and any figure taken from it
should say so.

`scripts/node2.sh` starts it; config is `.env.node2`, gitignored. It runs under
nohup rather than systemd, so **it does not survive a reboot**. Both addresses
are in `web/src/config.ts` so the UI lists them.

One security fix came out of this: `.gitignore` had `.env`, which does not
match `.env.node2`, and that file holds a provider private key. The rule is now
`.env.*`.

### Where the state lives

- `scripts/plan-e2e.mjs` opens a real job, plans, runs, and reports what the
  chain says. `--budget` defaults to 1.5 MON and it tops up only the shortfall.
- `scripts/migrate-e2e.mjs` runs both legs and asserts two providers were paid
  for disjoint ranges.
- The node re-reads pricing, model and gas floor on `systemctl --user restart
  dinnernode.service`, and prints all three before it registers.
- Guest deposit sits at 0.74654 MON on the contract, which is escrow already
  paid in and reusable without another deposit.

---

# Session snapshot, 2026-08-27 (afternoon)

> Newest first. Earlier snapshots follow below, unchanged.
> `TODO.md` remains the roadmap; this is the build and defect state.

## 1. Headline

Both of the top two items in the previous snapshot's open list are closed,
and the second one closed by way of a defect that eleven passing contract
tests were structurally incapable of catching:

- **Guests can order from their own wallet.** The house no longer owns both
  ends of every transfer, which was the reason no usage figure from this
  project meant anything. See section 2.
- **`Semaphore` could never have been deployed by our own script.** It links
  an external library that the script neither deployed nor linked, and
  `forge test` links libraries itself, so the whole suite ran green against
  code that could not reach the chain. See section 3.
- **`DinnerRatings` is live**, at 1.528 MON against the 0.64 estimated. The
  gap is one entire contract nobody knew was a separate deployment.

## 2. The guest's own wallet

The burner key in `lib.ts` was generated in the browser and funded by the
house faucet, so the deposit, the escrow and the settlement were all house
money moving between house addresses. That is what made "guests paid
providers" undemonstrable no matter how many jobs the counter showed.

`web/src/lib/wallet.ts` holds whichever wallet is active and `App.tsx`
destructures it under the old names, so no `writeContract` call site changed.

**The burner stays as the fallback.** A reviewer clicking a link should not
need an extension installed, and removing that would cost more than it buys.

Discovery is EIP-6963 rather than `window.ethereum`, which with two extensions
installed is whichever one won the race to assign it; the header renders one
button per discovered wallet. Connect switches the chain, adds Monad testnet
on a 4902, and sets `chainOk` false rather than throwing when the guest
declines. Reconnect goes through `eth_accounts` only, so a page load never
opens a wallet popup.

**Auto top-up is now burner-only.** The house has no business pushing MON at
an address it does not control, and an automatic grant to a connected wallet
puts the house back on both ends of the flow it was just removed from. A
connected wallet holding too little is told what it holds and what an order
costs. The manual faucet button still works in both modes.

Measured on a live order from MetaMask: two confirmations on the first turn,
`deposit` then `openJob`, and none on later turns of the same session, because
the session job is reused.

Sixteen tests for the state machine: connect, reject, wrong chain, chain add,
account switch, revoke, restore. 104 web tests total. First paint 593.8 kB,
up 4.8 kB.

`terms.html` and `README.md` carry the two-wallet split, the new
`dn_wallet_rdns` key, when an address reaches `/api/topup` in each mode, and a
sharper linkability warning: a wallet already used elsewhere brings its whole
history to every job opened from it.

## 3. A library the tests linked and the script did not

`Semaphore` calls `PoseidonT3` as an **external** library, so solc leaves a
placeholder at six call sites and the deployer is expected to fill them in.
`scripts/deploy-ratings.mjs` sent the placeholder text as initcode. That is
not valid hex, and Monad answered `eth_estimateGas` with a bare
`-32602 Invalid params`.

Three things made this expensive to read correctly:

- The error names the RPC, not us, and `Invalid params` is what a chain says
  when a chain is broken.
- The dry run failed identically before anything was deployed, which looked
  like the ordinary case of a constructor argument that does not exist yet.
- Size was the obvious suspect and was wrong: the verifier is 30,936 bytes of
  initcode and estimates fine, against Semaphore's 13,202.

**`forge test` deploys and links libraries itself.** All eleven `DinnerRatings`
tests passed, including the 570k gas one that runs the real verifier, against
a `Semaphore` this script could not put on chain. No amount of contract
testing would have found this. Only a deploy could.

Fixed in `6263673`. Link offsets come from the artifact's `linkReferences`
rather than from matching placeholder text, and the linked result is checked
for a surviving placeholder before anything is sent. The script now also
reuses `SEMAPHORE_VERIFIER_ADDRESS` and `POSEIDON_T3_ADDRESS` when set, which
was not hypothetical: the verifier deployed successfully and then Semaphore
failed, so a naive re-run would have paid 3,825,292 gas twice.

## 4. Ratings on chain

| contract | address | gas |
|---|---|---|
| PoseidonT3 | `0x910b8ef9fa4fb25ec4f0db0de7f5bfa87344d4f8` | 5,280,601 |
| SemaphoreVerifier | `0x4434cd7fadc248619e8cf171a1b2939af6b3af6c` | 3,825,292 |
| Semaphore | `0x6a399092f254e9317eaec677c60f0519e5248d14` | 2,884,656 |
| DinnerRatings | `0xeb0de71314322e6b0b5d754997dc3ddc1358d87f` | 1,132,523 |

1.528 MON across the two runs against 0.64 estimated. The estimate counted the
verifier and missed PoseidonT3, which is the single most expensive item of the
four.

Verified by reading the deployed contract: `semaphore()` returns the new
Semaphore, `node()` returns the live V1 `0xaF2c...3A92`, `groupId` 0 exists,
`memberCount` 0.

`VITE_RATINGS_ADDRESS` is set on Vercel Production as a non-sensitive config
variable. Vercel refuses secret visibility on a `VITE_` prefix, which is
correct, because the value ships to the browser either way. Verified in the
served bundle: the address is compiled into the lazy `ProviderRating` chunk.

**The group has zero members**, so the first guest to rate sees "a group this
small hides nobody". That is the widget behaving as designed rather than a
defect, and it stays true until three guests have joined.

## 5. Live state

```
node        qwen3.6:35b-a3b, engine ollama, accepting, activeJobs 0
web         web-2mf2oxgze, https://web-opal-sigma-55.vercel.app
contract    V1 0xaF2c...3A92, unchanged. V2 still a draft, still not deployed.
ratings     DEPLOYED 0xeb0d...d87f, group 0, zero members
house       0xA91a...5CF4  15.055 MON  -> 12 faucet grants
provider    0x055a...326A  0.2265 MON  -> settle gas only, no headroom to spare
web tests   104, 16 of them new. tsc, oxlint, vite build clean.
```

Two commits: `3b42e28` guest wallets, `6263673` the library link fix.

## 6. Open, in priority order

1. **Cap the fee on the two ratings writes.** `joinWithJob` and `rateProvider`
   in `web/src/lib/ratings.ts` pass a gas limit and no `maxFeePerGas`, so the
   `MAX_FEE` protection every other browser write has does not cover them.
   This mattered less when the burner paid; it is the guest's own wallet now.
2. **Refill the provider wallet.** 0.2265 MON is settle gas and nothing else.
3. **Make the cloud kitchen a real second provider**, unchanged and still the
   load-bearing item. `web/api/p/job.js` ignores `resume` and streams one
   hardcoded sentence while settling real MON. Until this lands, mid-answer
   migration is not reproducible from a browser by anyone reviewing us.
4. **Correct `terms.html` on the prompt commitment**, which session jobs
   narrowed from per prompt to per session opener. Still a live claim the code
   does not support.
5. **Surface the `engine` field in the browser**, so a guest can tell a mock
   provider from a real one.
6. **Decide what to do about unbilled visibility**: 3,745 tokens for 128
   characters of output is defensible and will not feel defensible.
7. **Separate `HOUSE_PK` into faucet and cloud-kitchen keys.** Connecting a
   guest wallet fixed one half of the closed loop; the house still pays and
   receives on the cloud-kitchen side.
8. Carried forward, unchanged: the gas comment in `web/api/p/_lib.js`, node
   distribution and `src/discovery.ts`, `web/api/topup.js` before mainnet.

---

# Session snapshot, 2026-08-27

> Newest first. Earlier snapshots follow below, unchanged.
> `TODO.md` remains the roadmap; this is the build and defect state.

## 1. Headline

Three defects found, all by looking at something running rather than by
reading code, and two of them had been live and invisible:

- **The node served canned text for 32 minutes** while `/health` advertised
  the real model. A boot race, not a code path anyone chose. See section 2.
- **The prompt sanitizer corrupted 11 of 12 ordinary prompts** carrying a long
  number, at every strictness including `minimal`. Measured, not estimated.
  See section 3.
- **Every turn of a real conversation clears its own gas**, which contradicts
  the assumption that short chat turns are a losing shape. Reasoning is billed
  and this model reasons before it answers, so the shortest measured turn
  billed 872 tokens against a 481 token break-even. See section 4.

Two features shipped on the back of that: session jobs, and anonymous ratings
that are actually verified on chain. Neither is deployed.

## 2. The node was serving mock

`pickEngine` in `src/host.ts` probed ollama once at startup and swallowed the
connection error. systemd starts `dinnernode.service` at 08:32:35 and
`ollama.service` at 08:32:40, so the probe lost that race and the daemon ran
the mock engine for the rest of its life.

Nothing surfaced it. The mock branch reuses `process.env.MODEL`, so `/health`
kept reporting `qwen3.6:35b-a3b`, and the only tell was `"engine":"mock"` in a
field nothing in the browser reads. A guest who ordered in that window
received the canned passage and paid a real settlement for it.

A user systemd unit cannot order itself after a system unit, so this has to be
solved in the process. The probe now retries for 30 seconds, and with no
engine and no explicit `ENGINE=mock` the daemon exits non-zero rather than
falling back. With the existing `Restart=always` that turns a boot race into a
retry loop that resolves itself.

**Still open:** the browser ignores the `engine` field, so a guest cannot tell
a mock provider from a real one. The daemon can no longer enter that state,
but another operator's node could.

## 3. A long number is not a phone number

Found from a screenshot: `solve this equation 79145443824 + 89542488129`
reached the model as `[PHONE] + [PHONE]`, and the guest paid in full for an
answer about placeholders.

The phone rule matched any run of nine or more digits with no shape
requirement, from `minimal` up, so no setting a guest could choose avoided it.
Measured over twelve prompts that carry a long number and no personal data:

| | before | after |
|---|---|---|
| false positives at `balanced` | 11/12 | **1/12** |
| true positives | 6/6 | **10/10** |
| bare uncued phone at `balanced` | caught | not caught, deliberate |

Split into three rules: a cue ("call me on ...") redacts a bare number from
`minimal` up, shape (country prefix or internal separators) does the same for
a number written the way phone numbers are written, and the old unconditional
match survives at `maximal` only. The one remaining false positive is the
documented Luhn coincidence in the card rule, not this one.

The two `phone guard bounds` tests asserted the old contract and now assert
the same nine digit floor and absent ceiling at `maximal`. Seven tests added.

## 4. Session jobs

Measured over a real ten turn conversation on this node, 19,604 billed tokens
in 322 s wall clock, with `openJob` estimated against live chain state at
**143,259 gas** and settle and closeJob read from job#49 receipts.

| | one job per turn | one job per session |
|---|---|---|
| openJob | 10x | 1x |
| settle | 13x | 7x |
| closeJob | 10x | 1x |
| guest pays | 0.803 MON | **0.672 MON** |
| gas as share of guest spend | 18.2% | **2.2%** |
| provider net after power | $0.0115 | **$0.0149** |
| net per node-month at 100% | $75 | **$85** |

73% less gas overall. The node keeps a job carrying `session: true` open after
settling and closes it after `SESSION_IDLE_MS` of quiet, refreshed per turn.
V1 has no expiry, so without that timer a closed tab would strand escrow
indefinitely, and the provider is the right party to hold it because the
provider already pays `closeJob`.

The browser decides reuse only from chain state. Three parties can close a job
between turns without telling it: the provider's idle timer, the cloud
kitchen, which closes every job it serves, and `settle()` on escrow
exhaustion. A job is reused only when the chain says open, same guest, same
provider, and at least 0.20 MON of headroom.

**The fear that drove this was wrong.** Break-even is 481 billed tokens and
the concern was that chat turns fall under it. Measured, the shortest turn,
"give me a title for it", returned 50 visible characters and billed 872
tokens. Every one of the ten turns cleared its own gas. The floor is real for
a model that does not reason.

**The finding that should worry us instead:** thinking is **88% of all text
produced**. Turn 8, "translate the title to Serbian", returned 128 visible
characters and billed 3,745 tokens. In a one-shot job that is invisible. In a
chat, where the guest sends ten small things and watches a meter, being
charged 3,745 tokens for a one-line translation will read as theft even though
it is the market convention and we disclose it. A per-turn reasoning cap, a
cheaper model for short turns, or a meter that shows the split are the three
candidate answers. None is built.

**Escrow 0.30 -> 1.00 MON**, about 29,800 tokens, which carried the whole
measured conversation without a top-up. That broke the faucet invariant, so
all three constants were re-derived around a full order costing 1.06 MON:
`TOPUP_AMOUNT` 0.5 -> 1.2, `TOPUP_TRIGGER` 0.4 -> 1.2, `TOPUP_RECIPIENT_MAX`
1.0 -> 2.5. Each guest is now 2.4x more expensive to seed.

**Known consequence, unresolved:** `promptTag` is computed at `openJob`, so
the chain commits to the opening prompt of a session and not to later turns.
V1 has no way to add a commitment to an open job. `terms.html` still describes
a per-prompt commitment and has not been corrected.

## 5. ZK: the old contract was worse than unused

`DinnerZK.sol` is deployed at `0x1D6f...c8A0` and nothing has ever called it,
which was the lesser problem. Its `rate()` took a `proofHash` and trusted it,
with the contract's own comment saying proofs are "generated & verified in the
guest's browser". Browser-side verification proves nothing to anyone else, so
any address could record any rating under any nullifier. `join()` was equally
open, so "paid-guest ratings" was never enforced. Wiring a UI to it would have
produced a ZK-shaped ritual with no ZK property.

`contracts/src/DinnerRatings.sol` replaces it:

- Proofs verified on chain by Semaphore v4.14.3, matching the npm packages
  already in `web/package.json`. Nullifiers tracked by Semaphore.
- `join(jobId, commitment)` requires a closed job, belonging to the caller,
  with `paid > 0`, and burns that jobId.
- Rating travels as the proof `message` and provider as the `scope`, so a
  relayer can neither downgrade a rating nor move it to another provider.
- `allCommitments()` keeps the group readable as state, because the Monad
  testnet RPC caps `eth_getLogs` at a 100 block range and a client cannot
  otherwise rebuild the group to prove membership in it.

Eleven tests, including one that spends 570k gas running the real verifier on
invented Groth16 points and confirms the rating is not recorded.

Two limits are in the contract header rather than left implied: `join` is sent
by the guest's own wallet, so the chain links that wallet to its commitment
and anonymity comes only from group size; and `rate` is deliberately
relayable, which moves trust to the relayer rather than removing it.

Browser side: `web/src/lib/ratings.ts` and a `ProviderRating` widget, lazy
loaded so Semaphore's 447 kB proving stack is its own chunk and first paint
stays at 589 kB. The widget scans stored history for an eligible closed job,
because a session job stays open until it goes idle, and says plainly that a
group under three members hides nobody.

The vendored Semaphore clone is trimmed from 24M to 240K, keeping
`packages/contracts` and the LICENSE. Solidity dependencies live in
`contracts/package.json` rather than the root, where npm had put them by
walking up.

**Honest claim once deployed:** "ZK-verified anonymous ratings". Not prompt
privacy, and not anonymity while the group has a handful of members.

## 6. Live state

```
node        qwen3.6:35b-a3b, engine ollama, warm in 11.1s, restarted 09:04:58
contract    V1 0xaF2c...3A92, unchanged. V2 still a draft, still not deployed.
jobs        jobCounter 69
ratings     DinnerRatings written and tested, NOT deployed
house       0xA91a...5CF4  1.6614 MON  -> zero faucet grants at the new amount
provider    0x055a...326A  0.2769 MON  -> about 17 more settlements
web         tsc, oxlint, vite build clean. 88 tests.
root        tsc clean. 36 tests.
contracts   11 tests, clean forge build.
```

Five commits: `75ae4d1` sanitizer, `578102f` engine probe, `c6cebc3` session
jobs, `2625bc9` ratings, `b63515f` the controller contact address.

Pitch material rebuilt and gitignored under the existing "ship product only"
rule: `DinnerNode_deck.pdf` for sending and `DinnerNode_deck_diligence.pdf`
for a partner who asks what is staged, with `make_deck.py` and
`make_deck_diligence.py` as their sources.

## 7. Open, in priority order

1. **Deploy `DinnerRatings`.** `node scripts/deploy-ratings.mjs --send`, about
   0.64 MON, mostly the 3,825,292 gas verifier. Then set
   `VITE_RATINGS_ADDRESS`. Blocked only on being run.
2. **Redeploy `web/`.** `vercel --prod --yes`. The live site still serves the
   old contact address, the 0.30 escrow and the old phone rule.
3. **Refill the house wallet.** At `TOPUP_AMOUNT` 1.2 and floor 0.5, grants
   are `(balance - 0.5) / 1.2`. 1.66 MON is zero guests, 4 MON is two, 7 MON
   is five. Refilling the provider wallet matters too, at about 17
   settlements of headroom.
4. **Correct `terms.html` on the prompt commitment**, which session jobs
   narrowed from per prompt to per session opener. This is a live claim that
   the code no longer supports.
5. **Surface the `engine` field in the browser**, so a guest can tell a mock
   provider from a real one.
6. **Decide what to do about unbilled visibility**: 3,745 tokens for 128
   characters of output is defensible and will not feel defensible.
7. Carried forward, unchanged: correct the gas comment in
   `web/api/p/_lib.js`, node distribution and `src/discovery.ts`, the cloud
   kitchen still returning canned text, `HOUSE_PK` still being both faucet and
   cloud-kitchen key, `web/api/topup.js` before mainnet.

---

# Session snapshot, 2026-08-26 (evening)

> Newest first. Earlier snapshots follow below, unchanged.
> `TODO.md` remains the roadmap; this is the build and defect state.

## 1. Headline

The node now runs a model that fits its work, at a price taken from that
model's own market, on a settlement cadence derived from measured gas rather
than from a timer. Three numbers this project has been reasoning from were
wrong, and all three were found by measuring rather than by reading:

- **`settle` costs 100,915 gas, not 28,809.** Every economic figure in
  section 4 of the previous snapshot was built on a constant that was never
  achievable. See section 5.
- **`firstTokenMs` was measuring a thinking token.** It published 616 ms while
  the real wait is 15 s to 47 s. See section 4.
- **The reference 27B runs at 5.2 to 6.3 tok/s at every context**, and reducing
  context does not help, because its weights overflow VRAM before any KV cache
  exists. It is retired from this node.

## 2. Model selection, measured not assumed

All measured warm on the RTX 5070 Ti Laptop, 12,227 MiB, at `num_ctx` 16384.

| model | GPU split | tok/s short | tok/s @9.1k prompt | prompt eval | first visible token |
|---|---|---|---|---|---|
| qwen3:8b | **100% GPU** | 53.9 | 37.9 | 2,123 tok/s | 181 ms |
| **qwen3.6:35b-a3b** | 56%/44% CPU | 44.3 | 56.2 | 505 tok/s | 15.0 s |
| qwen3.8:27b | 51%/49% CPU | 6.3 | 5.7 | 158 tok/s | ~10 s |

Context sweep for qwen3:8b: 50.9 / 49.3 / 49.4 tok/s at 4k / 8k / 16k, all
100% GPU, dropping to **27.8 tok/s and 28% on CPU at 32768**, and to 4.5 tok/s
on a 20,617 token prompt. The "one model fits all PCs" claim holds only up to
16k context. `CONTEXT_TOKENS` is now 16384 for exactly this reason.

**Chosen: `qwen3.6:35b-a3b` at 16384.** It earns roughly 1.7x the 8B per hour
of wall clock and 3.4x the 27B, because revenue is throughput times price and
it is the only one of the three that is good at both.

qwen3:8b stays in `src/models.ts` as the right answer for a node with less
VRAM. It is the fastest and the only one with 100% residency, and it earns the
least, because at $0.454/M it needs a 449 token answer just to cover gas.

## 3. Rate raised to $1.006/M

`RATE_PER_MILLION` 2.67e19 -> **3.353e19**, live on chain at tx
`0xa47f844b…a854e1`, verified by reading the provider struct back.

Sourced from this model's own market rather than from a general band: ten
providers serve qwen3.6 35B A3B on OpenRouter at a weighted average of
**$1.006/M output** and $0.1082/M input, cheapest credible $0.6996 (Darkbloom),
modal $1.00. DinnerNode bills output only, so input is free here.

`CLOUD_RATE_PER_MILLION` in `web/api/p/health.js` moved with it, or the receipt
would show two prices for one service.

A4, the long-tail assumption, is **refuted for this model**: ten providers
serve it. The position taken is "at market for a model everyone has", with
continuity and the committed plan ceiling as the reason to choose this node,
rather than "premium for a model nobody has".

## 4. Defects found and fixed

**`settle` fired on a 3 second timer.** Gas per settle is fixed and revenue per
settle is tokens times rate, so a timer charged identical gas for 12 tokens on
a slow node and 159 on a fast one. Replaced with a value trigger: settle once
the unsettled tokens are worth `SETTLE_GAS_MULTIPLE` (10) times the current
cost of settling them, with a 60 s backstop and the end-of-stream flush that
already existed. Verified in production on job#49: **one settle for 509 tokens**
where the timer would have fired three or four.

**The settlement gas constant was self-calibrated after being found wrong.**
`SETTLE_GAS_UNITS` was a hardcoded 34,571. It now takes whatever
`estimateContractGas` last returned for a real settle, seeded at 101,000, and
`/health` publishes it. See section 5.

**`firstTokenMs` measured a thinking token.** The probe used
`stream: false, num_predict: 1`. Ollama returns reasoning in a separate
`thinking` field and `num_predict` counts those tokens, so the probe stopped
after one thinking token and published 616 ms. Measured properly, first
*visible* token on this node is 15.0 s for a short factual question, 21.0 s for
a reasoning question and **46.6 s for a 900 word briefing**. The browser sizes
its abort budget from this number, so 616 ms told every guest to give up while
the model was still thinking. Now streamed, uncapped, read to the first visible
character, on a real question rather than `hi`. Publishes 7.7 s to 14.1 s.

**The answer opened with "as of 2024-2025".** Reasoning models volunteer a
knowledge-cutoff hedge. `src/engines.ts` now sends a node-side `SYSTEM_PROMPT`
on both the ollama and openai-compatible paths, overridable per operator. It
deliberately does not say "never mention your cutoff", because suppressing the
caveat pushes the model to state dated figures as current. It says where the
caveat belongs: at the point it affects an answer. Its 86 tokens are subtracted
from `PROMPT_BUDGET`, which went 14,336 -> 14,250, so `/health` cannot promise
context the engine will not have.

**`releaseJob` waited 5 seconds, sized against a cadence that no longer
exists.** With up to 60 s able to go unsettled, closing that early could
confiscate an entire answer's worth of delivered tokens on any failover. The
grace now comes from the node's published `settleMaxMs` plus five seconds.

**Per-job escrow was 34 seconds of output.** At the new rate 0.05 MON buys
1,491 tokens, and when a settle exhausts the escrow the contract closes the job
itself (`DinnerNode.sol:78`), cutting the answer off mid-sentence. Raised to
**0.10 MON**, about 2,980 tokens or 68 s at 44 tok/s, which clears the measured
900 word briefing roughly 2.5x over. The three faucet constants were re-derived
with it: `TOPUP_TRIGGER` 0.1 -> 0.25, `TOPUP_AMOUNT` 0.15 -> 0.3,
`TOPUP_RECIPIENT_MAX` 0.5 -> 0.7. The invariant is unchanged: the trigger must
clear the cost of one full order (0.10 escrow plus about 0.06 gas) and must sit
below the recipient ceiling, or the app loops on a top-up that is always
refused.

**The behaviour template dropdown did nothing.** Two compounding defects.
`applyEngramSanitization` skips every engram that is not `ai/privacy` or tagged
`sanitization`, so five of six community templates were stored, counted in the
panel summary, and never reached the model. And `preparePrompt` runs before
`openJob` while `applyPendingEngrams` runs after, so even the one privacy
template arrived a job late. Fixed with `resolvePendingEngrams` and
`behavioralPreamble`, the preamble prepended after redaction so maximal
strictness cannot eat the place name out of a location template. 14 new tests.

**The cloud kitchen ignored `resume`.** It destructured `{ jobId, prompt }` and
streamed one hardcoded sentence. It now verifies the checkpoint hash, 400s on
mismatch, 413s on a prefix over 200k chars, emits chained checkpoints every 64
tokens plus a final one, and settles only the tokens it produces. Migration is
triggerable from a browser for the first time. The continuation passage is
still canned and is labelled as such.

**Claims the UI made that the code contradicted.** The footer advertised a ZK
identity layer that was removed from `App.tsx`; `terms.html` 2.7 said "none of
it is transmitted to us" while `/api/topup` receives the wallet address and
`/api/p/job` receives the prompt; an answer that failed over to the hosted
kitchen showed canned text with no label, because the disclosure only fired
when the guest had *selected* that endpoint. All three corrected.

**The receipt showed one row labelled TOTAL.** The feed loop pushed a row only
when `open || id === n2` and broke at the first open job, so a section headed
"live settlements" discarded every completed settlement it had just read from
chain. Now walks the whole 25-job window, labelled "last 25 jobs" and "WINDOW
TOTAL" rather than implying an all-time figure. Also removed a duplicate
`eth_getBalance` and a duplicate `jobCounter` read on every 30 s poll.

## 5. The gas correction

Read from the receipts of job#49, not modelled:

| | assumed everywhere before | measured |
|---|---|---|
| `settle` | 34,571 gas / 0.0035 MON | **100,915 gas / 0.010293 MON** |
| `closeJob` | 32,047 gas / 0.0033 MON | **57,044 gas / 0.005818 MON** |
| per job | 0.0068 MON | **0.016112 MON** |

The `28,809 warm` figure in `web/api/p/_lib.js` was never achievable. `settle`
writes four already-non-zero slots, so 21,000 intrinsic plus 4 x 5,000 is a
41,000 floor before a single SLOAD or event. That comment is the origin of the
wrong economics in the previous snapshot's section 4 and everything derived
from it. **It has not yet been corrected at the source.**

Consequence: **job#49 earned 0.0135903 MON for 509 tokens and cost 0.016112 in
gas. It lost 0.0025 MON.** The value trigger still saved roughly 0.02 MON on
that job by collapsing four settlements into one; the floor is simply higher
than believed.

Break-even answer length on measured gas:

| | break-even | if the guest paid closeJob |
|---|---|---|
| old rate $0.80/M | 603 tok | 386 tok |
| **new rate $1.006/M** | **481 tok** | 307 tok |

Ten times the measured settle cost is 3,855 tokens and the whole escrow is
2,980, so the k=10 threshold is unreachable inside one job. **Every job now
settles exactly once, at the end.** That is the correct behaviour at this rate,
not a bug.

**Decision taken:** `closeJob` stays with the provider. Moving it to the guest
is the larger lever (36% of provider cost against 25.6% of added revenue) but
today the guest is faucet-funded from `HOUSE_PK`, so it moves cost to the house
rather than out of the system, and it creates a locked-escrow case when a guest
closes the tab, which V1 has no expiry for. The better fix is in the contract:
`settle` already closes the job in the escrow-exhausted branch, so `closeJob`
is a pure refund transaction. V2 should fold the refund into the final settle.

## 6. Income at the new rate, and the unpaid half

800-token answers, measured gas, 250W **[A]** and $0.11/kWh, MON $0.03.

| | gross/h | gas/h | net/h | net/mo at 100% |
|---|---|---|---|---|
| counting generation only | $0.1604 | $0.0964 | $0.0366 | $26.69 |
| **including measured thinking** | $0.0876 | $0.0526 | **$0.0075** | **$5.47** |

**Thinking is not billed and it is most of the compute.** Ollama returns
reasoning in a separate `thinking` field, `src/engines.ts` correctly yields
only `response`, and `active.get(jobId).delta++` therefore counts visible
tokens only. Measured on this node:

| prompt | thinking produced | billed | unpaid share of compute |
|---|---|---|---|
| short factual | ~732 tok | 800 | **47.8%** |
| reasoning | ~931 tok | 800 | **53.8%** |
| 900 word briefing | ~3,090 tok | ~1,200 | **72.0%** |

So the node performs roughly twice the work it invoices, and the 15 s to 47 s
of thinking is wall clock during which it earns nothing. That is what takes an
800-token job from $26.69/month to $5.47/month at full utilization.

OpenRouter providers bill reasoning tokens as output tokens, so **the market
convention is to charge for them and this node does not.** Counting them in
`delta` is arithmetically trivial and roughly doubles revenue per job. It
carries one design tension worth deciding deliberately: thinking text is not in
the checkpoint chain, so a settlement that includes it can no longer be fully
reconstructed from the published prefix, which weakens "the replacement settles
only the suffix it produced, verified against a keccak checkpoint" from a
provable claim to a partly-trusted one. **Not changed. Flagged for decision.**

Margin is otherwise flat across utilization, because gross, gas and electricity
all scale with it. **Utilization scales income without changing the
economics.** What changes them is answer length, since `settle` plus `closeJob`
are fixed per job. Below 481 output tokens every job loses money however busy
the node is.

For the first time the economics and the positioning agree: long jobs are both
the only ones that pay and the only ones mid-answer migration is worth
anything for. Short chat is a segment to decline rather than to lose.

## 6b. Addendum, same evening: thinking is billed, and this is deployed

**Decision taken on section 6: reasoning tokens are billed as output.** The node
counts a `{th}` frame into `delta` exactly as it counts a visible one. Gross
income becomes throughput times rate, $0.1604/h on this node, independent of
job shape, and only gas still varies with how the work is split into jobs.

| job shape (visible + reasoning) | reasoning | jobs/h | gross/h | gas/h | net/h | net/mo at 100% |
|---|---|---|---|---|---|---|
| short factual, 800 + 732 | not billed | 104.1 | $0.0838 | $0.0503 | $0.0060 | $4.35 |
| | **billed** | 104.1 | $0.1604 | $0.0503 | **$0.0826** | **$60.31** |
| reasoning, 800 + 931 | not billed | 92.1 | $0.0741 | $0.0445 | $0.0021 | $1.54 |
| | **billed** | 92.1 | $0.1604 | $0.0445 | **$0.0884** | **$64.53** |
| 900 word briefing, 1,200 + 3,090 | not billed | 37.2 | $0.0449 | $0.0180 | **-$0.0006** | -$0.43 |
| | **billed** | 37.2 | $0.1604 | $0.0180 | **$0.1150** | **$83.93** |

At 44.3 tok/s, $1.006/M, 157,959 gas per job at MON $0.03, 250W **[A]** at
$0.11/kWh. Wall clock is identical in both rows of each pair.

Section 6 says billing reasoning "roughly doubles revenue per job", which is
true of gross and understates net badly: gas and electricity are already paid
either way, so doubling gross against a near-zero net is a 14x to 42x move.
And the briefing, the job shape both the economics and the positioning point
at, was **net negative** unbilled. Billed it is the best shape on the node.
That inverts section 6's conclusion.

Consequences that shipped with it:

- **Escrow 0.10 -> 0.30 MON.** A briefing is a 4,290 billable token job, not a
  1,200 token one. The old ceiling was 2,980 tokens, so the contract would have
  closed it with the answer about a third written.
- **Faucet re-derived:** `TOPUP_TRIGGER` 0.25 -> 0.4, `TOPUP_AMOUNT` 0.3 -> 0.5,
  `TOPUP_RECIPIENT_MAX` 0.7 -> 1.0. Invariant unchanged. House capacity drops to
  about 4 grants above the floor on 2.5 MON, so the house wallet needs refilling
  rather than the amount lowering.
- **The k=10 settle trigger is reachable again.** It is worth about 3,070 tokens
  and a briefing is 4,290, so long jobs settle mid-stream once more. Section 5's
  "every job settles exactly once" holds only for short ones now.
- **The checkpoint claim is narrowed, not dropped.** Reasoning is billed but is
  still not appended to `prefix`, so the chain covers the visible answer only.
  `terms.html` 3.1 now says exactly that. Claim "the replacement provider
  settles only the visible tokens it produced, verified against a keccak
  checkpoint chain". Do not claim it covers reasoning.

**Thinking is now visible to the guest**, which is what makes the charge
honest as well as what stops the watchdog killing jobs during it. Engines yield
a tagged `Chunk`; the host forwards `th` frames; the browser refreshes its
watchdog on them without setting `streaming`, and shows them in a panel that
opens by itself while no answer exists yet.

## 7. Live state

```
node        qwen3.6:35b-a3b, CONTEXT_TOKENS=16384, promptBudget 14250
rate        3.353e19 wei/M ($1.006/M), on chain, verified
provider    0x055a…326A, active, 0.75 MON
contract    V1 0xaF2c…3A92, unchanged. V2 still a draft, still not deployed.
tunnel      https://litter-unfunded-improvise.ngrok-free.dev  200
settle      value trigger k=10, 60s backstop, self-calibrating gas units
web         tsc clean, oxlint clean, 61 tests passing, vite build clean
```

**Committed and deployed.** Three commits: `0482ad2` the session's work,
`97b364c` thinking frames, `0da8fbe` billing reasoning. Production is
`web-okskdkmvt`, promoted and verified against the deployed bundle: escrow
`0.30` and trigger `0.4` present in the JS, `.thinking` rules in the CSS,
`/terms.html` 200 carrying section 3.1, `/api/p/health` reporting
33530000000000000000. Only `HOUSE_PK` is set in Vercel, so every faucet
constant is a code default and cannot be reverted by a forgotten variable.
Root: 36 tests. `web/`: 61 tests. tsc, oxlint and vite build all clean.

## 8. Open, in priority order

1. ~~The browser cannot see thinking.~~ Done, `97b364c`. Not yet confirmed
   against a real job on the node: the fix is deployed but no job has been run
   through it end to end since. **Do that before demoing.**
2. ~~Decide whether thinking tokens are billed.~~ Decided and shipped,
   `0da8fbe`. See section 6b.
3. **Correct the gas comment in `web/api/p/_lib.js`** and the economics in the
   2026-08-26 morning snapshot section 4 that derive from it.
4. ~~Deploy.~~ Done. `web-okskdkmvt`, verified live.
5. **Node distribution.** `src/discovery.ts` works and is not deployed:
   `VITE_DISCOVERY_URL` is unset, and it listens on plain http which an https
   page cannot fetch. There is no routing policy of any kind, and `PUBLIC_URL`
   is unset so a second node cannot announce itself. Deliberately deferred.
6. Cloud kitchen still returns canned text. `HOUSE_PK` is still both faucet and
   cloud-kitchen provider key. `web/api/topup.js` must be deleted before
   mainnet. The five same-day legal edits remain unapplied.
7. Meter the wall draw to retire A2. The GPU rail alone reads 47 W on a model
   at 100% GPU, so the 250 W estimate is probably pessimistic and every net
   figure above with it.

---

# Session snapshot, 2026-08-26

> Newest first. The 2026-08-25 snapshot follows below and is unchanged.
> `TODO.md` remains the roadmap; this is the build and defect state.

## 1. Headline

Five deploys shipped. The live site now runs the current tree: legal pages with
a named controller, a corrected on-chain rate, a reworked conversation UI, and a
node-operator onboarding page replacing the fake hosting simulation. A node
operator can go from `git clone` to a listening provider with one command.

Two findings outrank all of it, because both invalidate numbers the pitch rests
on:

- **Settlement gas costs roughly 10x what the tokens earn.** Not electricity,
  gas. See section 4.
- **The reference GPU runs its model 56% on CPU.** A1's 25 tok/s is out by
  roughly 6x on the machine the pitch describes. See section 5.

## 2. Shipped and verified live

All verified against the deployed bundle, not assumed from the source.

| Change | Evidence |
|---|---|
| ToS and AUP name a controller and contacts | `/terms.html`, `/acceptable-use.html` 200, zero placeholders |
| Rate 2e18 -> 2.67e19 | `/api/p/health` and the contract provider struct both read 26700000000000000000 |
| Faucet 0.25 -> 0.15, floor 1 -> 0.5 | code defaults, not Vercel env, so a forgotten variable cannot revert them |
| Per-job budget 0.01 -> 0.05 MON | job#31 settled 419 tok for 0.0111873 MON, exactly 419 x 2.67e19 / 1e6 |
| Engram panel rework | `.engram-head`, `.engram-body` in deployed CSS |
| Length-scaled stream watchdog | `6e4+Math.ceil(M/150)*1e3` in deployed JS |
| Maximal sanitizer widened | `[NATIONALITY]` and the place gazetteer in deployed JS |
| Conversation UI, sim removed | `transcript` present; `your kitchen (sim)` and `start hosting` absent |
| `/hosting.html` | 200, contains "Run a node" |

Contract is unchanged: still V1 at `0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92`.
DinnerNodeV2.sol remains a draft and is still not deployed.

## 3. Defects found and fixed

Each was found by measurement or by replaying a real artifact, not by reading.

**The rate raise was a no-op in production.** `health.js` gated re-registration
on `!p.active`. The provider was already active, so `registerProvider` was never
called again and the contract billed 2e18 indefinitely. The gate now also fires
on rate drift. Note for future work: V1 `settle` reads the provider's rate at
settle time (`DinnerNode.sol:66`) and `openJob` stores no rate, so there is no
snapshot and one re-registration corrects billing for open jobs too.

**Every job was being killed by the client, not the engine.** Jobs logged
`engine error: This operation was aborted`. `host.ts:184` aborts the ollama
fetch when the response closes, so the browser was hanging up. The watchdog
keyed off raw bytes, and the host heartbeats `": hb"` every second: the first
heartbeat at t=1s flipped `streaming` true and collapsed the 60s cold grace to
20s before any token could exist, while also refreshing the deadline and
defeating the wedge detection it exists for. Now keyed to real tokens, with a
cold budget of `60s + promptTokens/150` seconds.

**Long prompts were silently truncated.** `num_ctx` was never sent. Ollama does
not use a model's architectural context length; it applies the server default
unless the Modelfile or request sets `num_ctx`, and the served tag carries none.
The stack advertised a 30720 token budget while ollama truncated past 4096 and
answered confidently about text it had not seen. Now sent from `CONTEXT_TOKENS`
on both the serving and warm paths. **Verified: a 19,153 token prompt recalls a
marker at position 0.** A 40,528 token prompt correctly fails, truncated from
the front, which is why the host's 30720 guard is load-bearing.

**The engram panel had never worked.** Selecting a template called `storeEngram`
immediately, which threw `No active job binding` every time, because the binding
is only set after `openJob` lands and the only sensible moment to pick a
template is before ordering. The upload path parsed, promised storage, and
stored nothing. Selection is now staged and applied once the binding exists.

**The prompt box was collapsed to a few pixels.** `EngramSelector` was a flex
sibling of the textarea inside `.rowline` and took the row's width.

**Maximal privacy leaked five of ten realistic prompts.** Replayed from
`.context/feedback/RecipeMaxPrivacy.md`, an answer that opened "Since you're in
Belgrade" under maximal strictness. Demonyms were not covered at all, the
location cue was only `in|at|from`, and no rule caught a lone capitalised word.
Added a gazetteer of places and nationalities ranked above the name rule, so
places stop being labelled `[PERSON]`.

**An address false positive at the DEFAULT level.** From
`.context/feedback/BalancedNone.md`: `"write me a 1000 word essay"` became
`"write me a [ADDRESS] essay"`. The pattern used `/i` with no leading `\b`
before its street-type alternation, so `Rd` matched the tail of **word**. Every
length-specified prompt was losing its word count at balanced.

**`applyPattern` reported detections that never happened.** `hit` was set before
the replacer decided, so a declining replacer still claimed a redaction.

**`maxFeePerGas` over-reserves 20x.** Monad reserves `maxFee x gasLimit`. At the
hardcoded 2000 gwei a `closeJob` costing 0.006 MON reserves 0.114, so the wallet
reports insufficient balance long before it is actually empty.

## 4. The economics finding

`src/host.ts:127` settles **every 3 seconds per active job**. The reference
model generates ~4 tok/s, so each settle covers ~12 tokens.

| per settle | |
|---|---|
| gas (28.8k warm +20%, 102 gwei, Monad charges the limit) | ~0.0035 MON |
| revenue (12 tok x 2.67e19 / 1e6) | ~0.0003 MON |

**Gas is roughly 10x revenue.** Observed burn is consistent: the provider wallet
went from 0.972 MON to 0.0017 in about 25 minutes across ~1,300 settled tokens.
A 1,000 token answer costs ~0.29 MON in gas and earns ~0.027.

This is worse than the pricing gap closed this morning. Raising the rate 13x
closed a 5x gap against electricity; this is a 10x gap against gas alone, and it
worsens as the model gets slower, because fewer tokens fall inside each
3-second window.

Widening the interval, or settling per N tokens instead of per interval, fixes
it directly. Not changed, because "settling every second" is currently the
tagline in the site header and that is a positioning decision. `TODO.md` already
says not to lead with per-second settlement.

**Consequence observed twice today:** a provider that runs dry mid-job strands
the guest's escrow and loses its own unsettled work. Job#32 died this way with
0.0256 MON locked; it was closed manually. Nothing retries `closeJob`, and
nothing watches the balance during a run.

## 5. Hardware reality on the reference machine

RTX 5070 Ti Laptop, **12,227 MiB VRAM**.

- `qwen3.8:27b` is ~19 GB. Only 8.4 GB is resident, so **56% runs on CPU.**
- Measured output is ~4 tok/s. **A1 in REFRAME assumes 25 tok/s: out by ~6x.**
- Prompt evaluation measured at ~158 tok/s. A 17,042 token prompt took ~110s
  before its first token; a full 30,720 token prompt needs ~195s.
- Cold load of a 27B is ~48s, which is why `keep_alive` now holds it resident.
- A 22.6 GB model (`qwen3.6:35b-a3b`) loads anyway and spills 58% to CPU. Two
  models cannot coexist in 12 GB, so loading one evicts the other.

A1 and A2 remain formally unmeasured, but A1 is now known to be wrong in the
optimistic direction. A model that fits entirely in VRAM would be dramatically
faster and is probably the single cheapest performance win available.

## 6. Plan as a job: first code exists

Previously a documented destination with no implementation. `commitPlan`,
`revisePlan`, `planHash`, `PlanStep` and `planner` had zero occurrences anywhere
in the codebase.

Now built, pure and chain-free, with 21 passing tests:

- **`src/plan.ts`** — `Plan`/`PlanStep` types, canonical serialization,
  `planHash` (keccak of the canonical form, shaped to match a future
  `commitPlan(bytes32)`), `planCostWei`, the dumb validator, `readySteps`, and
  `canLazyApprove`.
- **`src/planner.ts`** — planner prompt carrying the caps, brace-balanced JSON
  extraction from model prose, and a single validated retry that feeds the
  validator's own issues back.

Caps enforced: 12 steps, 4096 tokens per step, 32768 total, depth 6, plus cycle
and dangling-dependency rejection and an optional budget ceiling.

Three invariants are encoded deliberately: executors never sequence (a step
carries a prompt and a ceiling, nothing else); the waste bound is one step; the
validator is arithmetic and graph checks only, never a model.

**Verified against the live 27B.** Goal: a 1500 word researched briefing.
Accepted on the first attempt in **501 seconds**:

```
6 steps, up to 16000 tokens, ceiling 0.4272 MON
planHash 0x89547cbe2d4e9e7f82d46f6be92f57c781752efd202dbf4d992842e85b84180a
  research_gpu_specs           2500 tok  deps=[]
  research_power_costs         2000 tok  deps=[]
  research_inference_pricing   2500 tok  deps=[]
  research_utilization_demand  2500 tok  deps=[]
  profitability_analysis       3000 tok  deps=[the four above]
  draft_briefing               3500 tok  deps=[profitability_analysis]
wave 1: 4 parallelisable steps
```

A proper diamond DAG whose first wave is four independent steps that could run
on four providers at once, which is the case that makes a marketplace worth more
than a single host. It is also the first workload today whose committed value
(0.43 MON) would genuinely justify mid-answer migration.

**Not built:** contract primitives, the plan review UI with hand-editing and
per-step abort, the replan flow, and any execution loop. Nothing is committed on
chain.

**Open question the run raises:** 8.4 minutes to produce a plan is too slow, on
a model that is 56% on CPU. Planning wants a small fast model, not the serving
model.

## 7. Node operator setup: works, with three defects

`./dinnernode` plus `src/setup.ts` replace what was previously a hand-written
`.env` with no template and no validation, where a missing `PROVIDER_PK` crashed
inside `privateKeyToAccount` at import time.

**Tested by cloning the repo into a sandbox and running the one command with no
manual intervention.** The clone was clean: no `.env` came along and the
executable bit survived. It installed, generated a wallet at 0600, wrote a
`.env`, warmed the model in 15.1s and listened on the chosen port. So the happy
path genuinely works.

Three defects the test exposed:

1. **The model default is naive.** It offers `models[0]`, which on this machine
   is a 22 GB model against 12 GB of VRAM. An operator taking the default gets a
   node spilling to CPU. It should prefer a model that fits and warn otherwise.
2. **It registered before it had gas.** `register failed: Signer had
   insufficient balance`. The host started before faucet funds landed, so the
   node came up listening and unregistered. No guest can open a job against it,
   and it looks like it worked.
3. **Setup did not gate the handoff.** Neither the `ready` nor `not ready` line
   printed, yet `./dinnernode` still ran `npm run host`. On non-interactive
   stdin the wizard exits 0 without completing, so `npm run setup || exit 1`
   never fires.

Defect 2 is the one that matters: it is the difference between a working node
and one that silently earns nothing.

## 8. Repository state

Branch `session/2026-08-26-hardening-and-node-setup`, five commits, ahead of
`main` at `09c6579`. `main` has not moved.

**Production has been deployed five times from an uncommitted or unmerged
working tree.** The deployed site matches the branch, not `main`.

## 9. Still open, unchanged by this session

- Cloud kitchen is still a fixed passage. `web/api/p/job.js` destructures
  `{ jobId, prompt }` and ignores `resume` entirely, so mid-answer migration
  still cannot be demonstrated from a browser. This is TODO "Now" item 5 and it
  gates the migration demo, which in turn gates plan-as-a-job execution.
- `HOUSE_PK` is still both faucet and cloud-kitchen provider key, so every usage
  figure is house-to-house flow.
- The five same-day legal edits from the 2026-08-26 review are not applied.
  Terms 2.7 still says "none of it is transmitted to us", which
  `web/api/p/job.js` and `web/api/topup.js` both contradict.
- `web/api/topup.js` still exists and must be deleted before mainnet.
- V2 defects in `TODO.md` P1 are untouched.

---

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
