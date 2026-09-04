# DinnerNode contracts

Three sources, one of them retired. Foundry project; `forge test` runs 72 tests
across 5 suites.

| Source | Deployed | State |
|---|---|---|
| `src/DinnerNodeV2.sol` | [`0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c`](https://testnet.monadvision.com/address/0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c) | **Live.** Everything in the repo points here |
| `src/DinnerNode.sol` | [`0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd`](https://testnet.monadvision.com/address/0x2881051F957Ba0be7253c80DD47aF3Cc39FFEbCd) | Superseded, still callable. Reach for it only to `withdraw` or `refund` |
| `src/DinnerRatings.sol` | `0xeb0d…d87f` | Live. Pins the registry address in its constructor, so it still checks jobs against the superseded one |

## What V2 changes

Three things, and the first two are why the redeploy happened.

**`reassignWithAuth`.** An EIP-712 authorisation the guest signs at order time,
submitted by the incoming provider at the moment of handover, bounded by a
deadline, a monotonic reassign counter, a named-or-wildcard provider and
`msg.sender == newProvider`. A node dying at 3am no longer waits for the guest
to reach their wallet. `DOMAIN_SEPARATOR()` answers on this instance and
reverts on the superseded one, which is the check for whether a deployment has
it.

**Bounded settlement.** `_allowed` caps a settlement by
`elapsed × maxTokensPerSecond` and, once a checkpoint exists, by the unpaid
tail of published progress. The superseded contract accepted any `tokensDelta`
up to the remaining escrow, so one call could take all of it for zero work.
`test_worst_case_loss_is_one_settlement_interval` is the test that draws the
line.

**Named struct reads.** `getJob`, `getProvider`, `getCheckpoint` and `getPlan`
return structs. This is the reason V2 is not a drop-in for V1: `open` moves
from index 5 to index 9 under positional decoding, and the value at the old
index is a non-zero rate, which reads as truthy. Every liveness check would
have gone on passing against a closed job.

## Tests

```
forge test              # 72 tests, 5 suites
forge test -vvv         # with traces
```

| Suite | Covers |
|---|---|
| `DinnerNodeV2Auth.t.sol` | the EIP-712 authorisation path |
| `DinnerNodeV2AuthVector.t.sol` | signature vectors against a fixed domain |
| `DinnerNodeV2Defects.t.sol` | every defect found in review, one test each |
| `DinnerNodeV2Plan.t.sol` | plan commitments and ceilings |
| `DinnerRatings.t.sol` | Semaphore membership and the job burn |

## Deploying

There is no Foundry script. Deployment is `scripts/deploy-v2.mjs` in the repo
root, which is read-only until `--send` and reports its own estimate first:

```
node scripts/deploy-v2.mjs          # estimate, changes nothing
node scripts/deploy-v2.mjs --send   # deploy
node scripts/set-registry.mjs 0x…   # rewrite the nine places that name it
```

`set-registry.mjs` calls `eth_getCode` and refuses an address with no code on
it, because a previous cutover was given the deployer's address instead of the
registry's, and every node then "registered" successfully against an account
with no code.

**Changing the registry address is a three-service restart**, not two:
`dinnernode-discovery` reads the registry at import and will otherwise keep
serving providers read off the old contract while browsers open jobs on the
new one. `GET /health` on discovery publishes which registry it is using.
