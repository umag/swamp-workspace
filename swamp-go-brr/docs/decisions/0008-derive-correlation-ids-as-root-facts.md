---
issue: gobrr-observability
date: 2026-06-18
kind: decision
---

# Correlation ids are root facts; the OTLP trace/metrics are derived

## Context

Adding OTel observability needs W3C trace/span ids. ADR 0002 says "derive, don't
store" — so the instinct was to derive ids too (e.g. hash the run/task id).
Review killed that: a hashed id is synthetic (correlates to nothing in a real
backend), and an `.optional().default(crypto…)` field would auto-heal a
pre-feature run on parse, making "this run predates tracing" undetectable.

## Decision

A W3C **traceId** (on the Run) and **spanId** (on each Task), plus a
per-invocation **invocationSpanId** (on the 7d `StepOutput` record, NOT the
lease — the lease is nulled at `report`), are **root facts**: generated ONCE at
the impure method boundary (`start` / `seed_tasks` / `add_followup` execute, and
the loop before `report`) via `crypto.getRandomValues`, stored, never
re-derived. They are `.optional()` with **no `.default()`** so absence is
meaningful.

Everything else is DERIVED (ADR 0002): `buildTrace(run, records)` and
`buildMetrics(run, records)` are pure projections over the Run + the records.
`buildTrace` returns a 4-state status — `unavailable` (no traceId →
pre-feature), `empty` (traceId, no attempts), `partial` (attempts>0 but the 7d
records were GC'd), `ok` — and SUPPRESSES all spans for a task lacking a spanId
(task span AND its invocation spans) rather than orphaning an invocation span to
a trace root.

## Consequences

- **Exception to ADR 0002, stated plainly:** generated correlation ids are
  stable external references, not computed aggregates — store them. The
  derive-don't-store rule still governs the trace/metrics projections
  themselves.
- The root span id is a deterministic 16-hex slice of the traceId (pure, stable)
  — it needs no separate stored field.
- gobrr stays pure: it ASSEMBLES OTLP via `lib/otlp.ts` (a cycle-free serializer
  that is the authoritative attribute-scrub site) but NEVER exports — see
  ADR 0009.
- Relates to 0001 (host-observed vs declared), 0002 (derive), 0004 (bounded
  retention — `traceOtlp` is 7d as it carries scrubbed attribute text).
