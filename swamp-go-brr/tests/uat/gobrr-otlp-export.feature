# issue: gobrr-observability
# date: 2026-06-18
Feature: otlp-export ships the derived OTLP to a collector, safely
  @magistr/swamp-go-brr/otlp-export is the loop's only network egress; gobrr stays pure.
  Unit-pinned in otlp_export.test.ts (network stubbed); this is the loop-level acceptance.

  Scenario: no endpoint configured is a safe skip, not a failure
    Given the exporter has no endpoint configured
    When export_run runs
    Then exportStatus.status is "skipped" and nothing is sent

  Scenario: a configured https endpoint receives the OTLP payload
    Given a vault CEL supplies an https endpoint and a bearer token
    And gobrr has emitted a traceOtlp resource
    When export_run runs
    Then the token rides only in the Authorization header (never the URL or body)
    And on a 2xx exportStatus.status is "ok"

  Scenario: a collector failure never aborts or corrupts the run
    Given the collector returns 500 (or the POST times out)
    When export_run runs
    Then export_run does not throw and exportStatus.status is "error"

  Scenario: a credential-bearing endpoint URL is never persisted or logged
    Given the resolved endpoint contains basic-auth userinfo or an apikey query param
    When export_run records its status
    Then only a userinfo/query-stripped host appears in exportStatus.endpoint
    And an http:// endpoint is rejected (https required)
