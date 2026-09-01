---
name: olympus
description: >
  Author Project Olympus (shipd.ai) challenge submissions through the
  @magistr/olympus/submission swamp model — a phase-gated state machine over
  submissions/<slug>/ holding problem.md, test.patch, solution.patch and a
  Dockerfile. Pick and vet a repo (500+ stars, permissive license, active,
  accepted language), rule out prior art in PRs/issues/discussions, write the
  problem description as maintainer-style prose, write test.sh plus the new
  tests, write the reference solution, write the Dockerfile, then reproduce the
  reviewer's local review in Docker (base passes / new fails at the base
  commit; both pass with the solution) before submitting. Triggers on "olympus",
  "shipd", "olympus challenge", "create a challenge", "challenge submission",
  "problem.md", "test.patch", "solution.patch", "local review", "prior art",
  "acknowledge prior art", "ready to submit". Do NOT use for ordinary code
  review of this repo (use review-code) or for swamp issue tracking (use
  issue-lifecycle).
---

# Olympus

Drive a challenge submission from repo selection to a green local review.

The model owns the state and the checks; **you** write the artifacts. Never
hand-wave a gate — run the method and read the findings.

## The loop

For every turn of work:

1. `swamp model method run <instance> status --arg slug=<slug>` — read the
   gate, the blockers and the next action.
2. Produce the artifact for the current phase (write it into
   `submissions/<slug>/`).
3. `preflight` — fix every `error`; read every `warn` and decide deliberately.
4. `advance` — it refuses if the gate is not clean; that refusal is the point.
   Resolve a refusal by fixing the offending artifact — or, for prior-art hits,
   by recording an adjudication with `acknowledgePriorArt` (the refusal resolved
   by recording a human decision rather than editing a file).

Run `swamp data get <instance> --name '<slug>.status'` (or `.preflight`,
`.review`, …) to read a result; the method writes, you query.

## Phases and what each one demands

### repo

`checkRepo --arg slug=<slug> [--arg ref=<branch|tag|sha>]` pins a commit and
checks the bar. Then `scanPriorArt --arg slug=<slug> --arg terms='["…","…"]'`.

Read every prior-art hit. **A closed or unmerged PR that already implements
the idea still rules it out** — not landing does not make it fresh. A
maintainer ruling in an issue or a discussion counts as misalignment with the
repo. This is the single biggest rejection reason; the scan surfaces
candidates, it does not decide for you.

If the scan returns hits, the repo gate stays shut until they are adjudicated:
present every hit to the user with your disposition (does it rule the idea out,
or not, and why), obtain an explicit decision, then record it with
`acknowledgePriorArt --arg slug=<slug> --arg urls='["…","…"]'` passing exactly
the hit URLs. A clear scan (zero hits **and** not truncated) needs no acknowledgement — the
gate opens on its own. A scan that hit its result cap is truncated and holds the
gate regardless of the count until you re-run it with narrower terms (or a
higher `perTerm`). `acknowledgePriorArt` **records** a decision the user made;
it does not make one, and running it is never "the gate approved" or "prior art
cleared". A re-scan drops any prior acknowledgement, so re-run it after changing
terms.

Also read the repo's README and get a feel for its philosophy before
committing to an idea. A feature the project would never want is a rejection
even if every check is green.

### problem

Write `problem.md` the way a maintainer writes an issue: natural prose, full
sentences. Open with the ask itself ("Add X to Y", "Fix Z when …") and let the
first line stand on its own without a title. Skip the motivation and the "what
the repo currently lacks" preamble.

No headings, no bulleted requirement lists, no code snippets doing the
describing — the linter treats those as errors. Do not spell out what a
developer in the repo would find themselves (internal class names, helpers,
field names, file layout); describe the behaviour, not the implementation.

Use judgement: if a detail is genuinely part of the contract and the task
cannot be pinned down without it, state it. A task nobody can implement is
worse than one that names a field.

The task must be **hard**. If you think you know what challenging means, bump
it up a notch.

### tests

Write `test.sh` at the repo root plus the new tests, then
`git diff > test.patch`.

`test.sh --output_path <xml> base` runs the repo's existing tests in the
change's blast radius — a genuine regression check, not a smoke test — and
must pass. `test.sh --output_path <xml> new` runs your new tests and must fail
without the solution. No fail-fast flags: every test result is needed.

`chmod +x test.sh` before generating the patch. The reviewer invokes
`./test.sh`, so a harness committed non-executable fails the review for a
reason that has nothing to do with your task.

Tests must be deterministic (no timing, randomness or ordering), must not need
the network (`--network none`), must cover the obvious edge cases, must not
check unspecified or undiscoverable behaviour, and must not over-pin output —
assert the behaviour holds, not the exact wording of a message, unless the
description or the repo's existing patterns make the wording part of the
contract.

Treat the patch like a real PR: nothing named challenge, quest or olympus
anywhere, in a path or in a comment.

### solution

Write the reference implementation, then `git diff > solution.patch` (the test
patch is already applied, so generate the solution diff separately).

Meet every requirement, follow the repo's existing patterns, change nothing
unrelated, break no existing tests, and leave no AI slop — no odd comments, no
unexplained defensive code, no new patterns the repo does not already use.

`preflight` reports the effective LOC: implementation lines only. Comments,
blanks, tests and generated files do not count toward the bar.

### dockerfile

Start `FROM` the approved base image for the repo's language, `WORKDIR /app`,
install everything at build time (the runtime container is offline), run no
tests during the build, end with `CMD ["/bin/bash"]`, and make sure it builds
without either patch applied.

### review

`localReview --arg slug=<slug>` runs the whole reviewer loop in Docker. All
four runs must land: base passes and new fails at the base commit, both pass
with the solution applied.

Read the failing stage's output rather than guessing. A `new` run that passes
before the solution means the tests do not actually pin the missing behaviour.
A `base` run that fails after the solution means a regression.

### ready

`bundle --arg slug=<slug>` emits the four fields for the form.

Before submitting, be your own reviewer: read the agent runs. An agent should
fail because the task is genuinely hard — not because a sentence was
ambiguous, a requirement was hidden, or a test asked for something the
description never stated. If agents trip on something you did not intend, fix
it now; after submission it comes back as a revision. If they solve it in far
fewer lines than your solution, your effective LOC is lower than it looks.

Checks cost tokens and go stale the moment you edit anything, so fix
everything you can spot in one pass before rerunning.

## Setup

```bash
swamp model create @magistr/olympus/submission olympus   # globalArguments.path -> workspace root
swamp model method run olympus init
swamp model method run olympus startSubmission \
  --arg slug=frostdb-distinct \
  --arg repoUrl=https://github.com/polarsignals/frostdb
swamp model method run olympus checkRepo --arg slug=frostdb-distinct
swamp model method run olympus scanPriorArt \
  --arg slug=frostdb-distinct \
  --arg terms='["distinct aggregation","count distinct"]'
# Only when the scan returns hits, after reviewing each one with the user:
swamp model method run olympus acknowledgePriorArt \
  --arg slug=frostdb-distinct \
  --arg urls='["https://github.com/polarsignals/frostdb/pull/123"]'
```
