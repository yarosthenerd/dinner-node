# CLAUDE.md — DinnerNode

## DeltaV weekly updates

DinnerNode has a DeltaV startup profile at
https://deltav.monad.xyz/startup/dinner-node

DeltaV is a founder copilot: the quality of its mentorship depends on how
current the profile is. After meaningful progress (a feature shipped, a
milestone hit, real traction, a launch, a number that changed), **prompt the
operator to post a short weekly update to DeltaV.** Do not post without their
explicit ok, and no more than about once a week.

Write updates in the operator's voice: short, factual, what shipped and what
changed. No marketing register, no em dashes.

```
curl -sS --fail-with-body -X POST https://deltav.monad.xyz/api/v1/weekly-updates \
  -H "Authorization: Bearer $DELTAV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "<the update, in the operator's voice>", "xLink": "<optional link to an X post>"}'
```

The key lives in the `DELTAV_API_KEY` environment variable. **Never write the
key into this repo, any file, or any commit.** If the variable is not set, ask
the operator to export it rather than looking for the value anywhere else.

## Working preferences

See `.context/HANDOFF.md` section 15. In short: complete paste-ready blocks,
one block per goal, confirm-gated steps. Neutral professional register. No em
dashes, no "it's X, not Y" contrasts, no resumptive openers. Quoted heredocs for
files containing backticks or backslashes. Prefer full-file rewrites to regex
patching, and print MISS markers when patching.

## Project state

- `SNAPSHOT.md` is the current build and defect state.
- `.context/REFRAME.md` is the strategic positioning, superseding HANDOFF
  sections 7, 11 and 12.
- `SECURITY_REVIEW.md` is the security checklist and open items.
- `.context/HANDOFF.md` is accurate for operational content (runbook, gas
  lessons, addresses) and unreliable for status: it marks several things
  complete that have never existed.
