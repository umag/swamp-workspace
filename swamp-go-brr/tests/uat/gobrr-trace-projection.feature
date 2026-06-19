# issue: gobrr-observability
# date: 2026-06-18
Feature: gobrr derives an OTLP trace + per-leaf metrics from run state
  gobrr.emit_otlp turns the Run + 7d step records into a traceOtlp span tree and a
  metricsOtlp series, purely (ADR 0002/0008). Unit-pinned in gobrr_observability.test.ts
  + lib/otlp.test.ts; this is the loop-level acceptance.

  Scenario: a completed run yields a valid nested OTLP trace with per-leaf usage
    Given a run with a traceId and tasks that each have a spanId
    And step records carrying invocationSpanId, hostDurationMs and leafDeclared usage
    When emit_otlp runs
    Then traceOtlp.status is "ok"
    And every invocation span parents to its task span and every task span to the run root
    And no two spans share a spanId and no span is orphaned
    And each invocation span carries leaf.declared.{input_tokens,cost_usd} and leaf.host.duration_ms
    And metricsOtlp has per-gate gobrr.leaf.tokens / cost_usd / duration_ms points

  Scenario: a pre-feature run (no traceId) is reported as unavailable, not faked
    Given a run persisted before the tracing feature (traceId absent)
    When emit_otlp runs
    Then traceOtlp.status is "unavailable" and no fabricated trace id is emitted

  Scenario: a run whose 7d step records were GC'd is reported partial
    Given a run with a traceId whose tasks have attempts > 0 but zero step records
    When emit_otlp runs
    Then traceOtlp.status is "partial" (the gap is visible, never a silently empty trace)

  Scenario: a pre-feature task (no spanId) is suppressed whole, never orphaned
    Given a run with one task that has a spanId and one task that lacks a spanId
    And both tasks have invocation records
    When emit_otlp runs
    Then the spanId-less task contributes NO task span and NO invocation spans
    And suppressedTasks is 1
