---
issue: gobrr-record-step-outputs
date: 2026-06-16
kind: decision
---

# Store the pruned step-output measurements; derive every rollup

## Context

[0002](0002-derive-dont-store-run-projections.md) established: derive aggregate
projections from `run.tasks`, never store a denormalized field — _unless the
projection is expensive or the source rows are pruned_.
`gobrr-record-step-outputs` wants a per-leaf-invocation audit trail (envelope
summary, host-observed changedPaths + scrubbed diff, verify exit + output tail,
outcome/failureKind) so a silently-dropped edit (the
`si-apply-multi-edit-same-file` bug) becomes inspectable.

The tension: 0002 says "don't store." But the raw inputs to `report()` — the
diff, the parsed envelope, the docker-verify output — exist **nowhere** after
the call returns. They are exactly 0002's stated exception: **pruned source
rows**. You cannot derive a diff that was never kept.

## Decision

Store **only** the raw, non-derivable measurements, in a dedicated append-only
`stepOutputs` resource (`{records: StepOutput[]}`), separate from the `run`
aggregate. Keep **every rollup derived**: `stepOutputProjection(records, tasks)`
computes the record count, the declared-vs-observed mismatches, and the
reaped-invocation gaps on read (in `hydrate`), never persisted — mirroring
`trustSummary`.

Consequences of the split-resource choice:

- `RunSchema` is **untouched** — no schema/interface bridge churn, and the
  scheduler hot path (`next`/`heartbeat` read+write the run on every call) stays
  lean instead of dragging diffs along.
- `report()` is the **single producer** — a leaf result exists nowhere else. The
  scheduler lease-reap path produces no measurement, so there is no second write
  site and the 0002 dual-write failure mode structurally cannot occur.
- The append is **best-effort**: `report()` persists the run FIRST (the green
  gate is sacred) and then appends the audit record inside a `try/catch` that
  logs and never rethrows. An audit-write failure degrades the trail, never the
  gate.

## Consequences

- **Declared vs observed is the whole point.** The envelope summary
  (`declaredTargetPaths`, `declaredEditsPerFile`) is AGENT-DECLARED intent; the
  `changedPaths`/`diff` are HOST-OBSERVED
  ([0001](0001-source-integration-host-observed-state.md)). The mismatch
  projection treats host observation as the only truth and flags a declared path
  that produced no observed change — the dropped-block signature.
- **Reaped gap is a lower bound.** `attempts - records`: a reaped/expired-lease
  invocation bumps `attempts` but writes no record, while an `infra_error` is
  recorded without bumping `attempts`. The `attempts > recorded` guard keeps the
  gap non-negative; never use it as a hard gate.
- General rule reinforced: **derive what you can, store only what is pruned** —
  and when you must store, keep it off the hot aggregate and make the write
  best-effort if it is not itself the decision.
