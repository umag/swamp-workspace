# issue: gobrr-record-step-outputs
# date: 2026-06-16
# Pure helpers (buildStepOutput, stepOutputProjection, summarizeEnvelope, scrubSecrets)
# are unit-covered in gobrr.test.ts / source_integration.test.ts / lib/scrub.test.ts.
# This is the loop-level (gobrr report → stepOutputs resource → hydrate) view.

Feature: gobrr records a per-leaf-invocation audit trail and derives its rollups

  Scenario: each reported invocation appends one step-output record
    Given a run whose leaves have been applied and verified
    When the driver calls report() for each leaf with its WorkResult, verify exit
      code, and audit (declared envelopeSummary + raw verifyTail)
    Then the stepOutputs resource holds one record per report() call
      And each record stores the declared envelope summary, the host-observed
        changedPaths, the scrubbed diff tail, the verify exit code, the scrubbed
        verify tail, and the resolved outcome/failureKind
      And a secret in the verify tail is redacted in the stored record
      And the green gate decision is persisted even if the audit append fails

  Scenario: hydrate surfaces the derived dropped-block and reaped signals
    Given a run with recorded step outputs
    When the driver reads hydrate (stepOutputs projection)
    Then a leaf whose declared target path is absent from the host-observed
      changedPaths is reported as a mismatch (the dropped-block signature)
      And a task whose attempts exceed its recorded step outputs is reported as a
        reaped-invocation gap (a lower bound — never a gate)
      And the projection is derived on read, never stored on the run aggregate
