# Test-Review Gate Decision: Webhook Signature Validation

## Problem/Feature Description

The `webhook-signature-validation` issue is mid-lifecycle. The plan was approved
by the human, `implement` was called, and a TDD test suite has been authored and
reviewed. The state after the latest full reviewer fan-out — the hydrate summary
and the current round's recorded reviews — is captured in
`inputs/lifecycle-state.json`. The diff currently on the branch is captured in
`inputs/branch-diff.txt`.

The engineer driving the issue had to step away right at this point and has
asked you to determine and execute the next step the lifecycle dictates. Examine
the inputs carefully before deciding.

## Output Specification

Produce **`next-action.md`** — your decision at this point in the lifecycle. It
must state:

1. What the lifecycle's control flow dictates as the immediate next action
   (including the exact `swamp` command(s), if any)
2. Why — citing the specific evidence from the current state and the branch diff
3. What happens to the lifecycle state as a result, and what must change before
   the issue can progress

Do not produce any other output files. Do not leave large files (>50MB) on disk.
