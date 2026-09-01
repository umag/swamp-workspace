# Phase 4c: Verification (pre-PR controls)

## Prerequisites

- State: `implementing` — all plan steps executed, the approved test suite
  passes locally
- The branch in `state.branch` carries the work

Phase 4c runs the repository's mechanical controls — format, lint, typecheck,
tests — **before** the review fan-out and long before a PR exists. It is the
half of verification that CI used to discover for you, moved to where the
failure can still be fixed in context.

`review_code` is guarded on `verifying`. There is no path from `implementing` to
`code_reviewing` that skips this phase.

## Why this phase exists

CI historically did two unrelated jobs: it **executed** verification and it
**coordinated** merges. That conflation was tolerable when a human wrote code at
human pace and pushed occasionally. An agent iterating at machine pace turns
every discovered-late failure into a round trip through a queue, which is why
throughput can rise while main-branch success rates fall.

Splitting the two jobs is the fix. Verification executes here, in the working
tree, where a failure is a fact you can act on immediately. CI keeps the job
only it can do: coordinating the merge, and validating the evidence
([attestation.md](attestation.md)) rather than regenerating it.

The distinction from a pre-commit hook is that this is a **loop**, not a
trigger. A hook passes or blocks. This phase reads the failure, fixes it, and
runs again.

## Step 1: Read the control declarations

Read `agent-constraints/verification-controls.md` at the repo root. It declares
each control's `name`, `command`, `args`, `cwd`, `tier` and `required` flag.

If the file does not exist, fall back to the repo's `CLAUDE.md` build/test
commands and say plainly in your summary that you inferred the controls rather
than reading a declaration — an attestation built on guessed controls is worth
less than one built on declared ones.

## Step 2: Run every control in one call

```bash
swamp model method run <issue-name> verify --input '{
  "controls": [
    {"name":"fmt","command":"deno","args":["task","fmt:check"],"cwd":"<ext>","tier":"local","required":true},
    {"name":"lint","command":"deno","args":["task","lint"],"cwd":"<ext>","tier":"local","required":true},
    {"name":"check","command":"deno","args":["task","check"],"cwd":"<ext>","tier":"local","required":true},
    {"name":"test","command":"deno","args":["task","test"],"cwd":"<ext>","tier":"local","required":true}
  ],
  "repoDir": "<absolute repo root>",
  "runner": "local"
}'
```

One call, every control — not one call per control. The method acquires the
model lock once and produces the whole round.

State moves to `verifying` whether the controls passed or not. The round is
recorded either way; that record is what the attestation later rests on.

`--input` takes a JSON object. `--arg` is silently ignored by
`swamp model method run`.

## Step 3: Read the outcome

```bash
swamp model method run <issue-name> hydrate
swamp data get <issue-name> hydrate --json
```

`controls.ran`, `controls.total` and `controls.blocking[]` report the round. For
the full per-control detail including `stderrTail`:

```bash
swamp data get <issue-name> current --json
```

Control statuses:

| status    | meaning                               | blocks? |
| --------- | ------------------------------------- | ------- |
| `pass`    | exit 0                                | no      |
| `fail`    | ran, rejected the tree                | yes     |
| `error`   | could not be executed at all          | yes     |
| `skipped` | `managed` control on a `local` runner | yes     |

`error` and `skipped` block exactly as `fail` does when the control is
`required`. A control that could not run has told you nothing, and "told you
nothing" is never evidence of a clean tree.

## Step 4: Fix failures in context, then loop

For each blocking control, read `stderrTail`, fix the cause **now** — you are
already in the code, with the change fresh — and iterate:

```bash
swamp model method run <issue-name> iterate_verification \
  --input '{"reason":"<which control, what broke>","source":"auto"}'
```

State returns to `implementing`. Fix, then call `verify` again.

This loop is **autonomous**. There is nothing to judge: a control passed or it
did not. Do not stop to ask a human whether a lint failure should be fixed.

Read [autonomous-loop.md](autonomous-loop.md) for the shared loop safeguards —
`MAX_VERIFY_ITERATIONS` (default 5), loop detection, and the handover rules when
the loop will not converge. Do not restate that logic here.

**A control failure is not automatically your bug.** If `verify` fails on a
control unrelated to your change — a pre-existing lint error elsewhere in the
tree — file it as a separate issue rather than absorbing the fix into this work
span, and note it in your summary. Scope creep derails lifecycles faster than
anything else.

## Step 5: Hand off to code review

Once every required control is `pass`:

```bash
swamp model method run <issue-name> review_code
```

State moves `verifying` → `code_reviewing`. Continue with
[code-review.md](code-review.md).

Note that `iterate` (from the code-review loop) lands back in `implementing`, so
**every code-review iteration re-enters this phase**. That is deliberate: a code
fix that breaks the build must not reach a reviewer, let alone a PR.

## Next phase

[code-review.md](code-review.md) — the matrix fan-out over the implemented code.
The attestation that follows it is described in
[attestation.md](attestation.md).
