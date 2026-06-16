# issue: gobrr-trust-ledger
# date: 2026-06-16
# trustSummary is unit-covered in gobrr.test.ts; this is the loop-level view.

Feature: gobrr exposes per-task-type trust derived from terminal task statuses

  Scenario: hydrate/completeReport report per-gate promise-keeping
    Given a run whose tasks have reached terminal statuses
    When the driver reads hydrate (trustSoFar) or completeReport (trust)
    Then each gate (real=code, advisory=test) reports kept/broken, passRate,
      greenFirstTryRate and meanAttemptsToGreen
      And tasks that exhausted via the scheduler lease-reap are counted broken
        the same as those that exhausted via report
      And blocked / infra_error / non-terminal tasks are excluded
