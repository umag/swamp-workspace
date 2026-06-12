# Reporting: hydrate, complete, and halt handover

## hydrate (compact, cheap)

`swamp model method run <run> hydrate` → the `summary` resource:
`status`, per-status `buckets`, `invocations/maxInvocations`, `leased` (id+vmId),
`waitingFollowups`, `stallCulprits`, `stallSignature`, `costEstimate` (advisory),
`haltReason`, `haltOptions`.

## complete (final report)

`swamp model method run <run> complete` (requires all tasks `done`) writes the
full report: `buckets` over every end-state
(`done/test_failed/exhausted/infra_error/merge_conflict/blocked/waiting_followup`),
and per task: `gate (real|advisory)`, `attempts/maxAttempts`,
`mergeDisposition (clean|conflict-resolved|conflict-unresolved)`, `failureKind`,
`failureSignature`. Cost is labelled an advisory estimate.

## Halt handover — enumerated per-cause options

Every halt yields a non-empty `haltReason` + numbered `haltOptions`. Present them
verbatim and hand to the human (sacred rule 4). The cause set is closed:

- **exhausted** — a task hit `maxAttempts`:
  1. Inspect the failureSignature; widen the task's spec or writeAllowlist.
  2. Raise `maxAttempts` and resume.
  3. Accept the task and continue without it.
- **stalled** — no progress in the last `stallK` offers (same failures repeat):
  1. Read `stallCulprits` + decoded `stallSignature`.
  2. Re-scope the culprit task(s) — the approach cannot pass the gate.
  3. Abort and re-decompose.
- **blocked** — remaining tasks depend on a failed/exhausted task:
  1. Resolve or accept the blocking dep to unblock descendants.
  2. Re-plan the blocked subtree.
- **infra_error** — firecracker/docker-verify host trouble (or version mismatch):
  1. Check the host + the fail-closed pinned-version assertion.
  2. Re-run; infra_error does not consume task attempts.
- **cap (wallclock/invocations)** — surfaced as `decision.cap`; raise the cap in
  RunConfig and resume, or stop.

A distinct `infra_error.failureKind` (envelope_parse / nonce_mismatch /
claude_error / out_of_allowlist / transport / oversize) tells "the agent produced
garbage" apart from a plain test failure.
