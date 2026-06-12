# Test-Review Gate Decision: CSV Streaming Export

## Problem/Feature Description

The `csv-export-streaming` issue is mid-lifecycle. The plan was approved by the
human, `implement` was called, and the TDD test suite for the approved plan has
been authored and driven through the test-review loop. The state of the
lifecycle after the latest full reviewer fan-out — the hydrate summary and the
current round's recorded reviews — is captured in `inputs/lifecycle-state.json`.
The diff currently on the branch is captured in `inputs/branch-diff.txt`.

The engineer driving the issue had to step away right at this point and has
asked you to determine and execute the next step the lifecycle dictates.

## Output Specification

Produce **`next-action.md`** — your decision at this point in the lifecycle. It
must state:

1. What the lifecycle's control flow dictates as the immediate next action
   (including the exact `swamp` command, if any)
2. Why — citing the specific gate conditions from the current state
3. What happens to the lifecycle state as a result, and which phase comes next

Do not produce any other output files. Do not leave large files (>50MB) on disk.
