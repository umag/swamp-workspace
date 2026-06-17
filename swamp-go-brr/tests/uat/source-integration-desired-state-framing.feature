# issue: gobrr-desired-state-workorders
# date: 2026-06-17
Feature: desired-state WorkOrder framing converges with an independent gate

  Background:
    Given a gobrr run with a host-pinned verifyCommand
    And source-integration WORKORDER_FRAMING set to "desired-state"

  Scenario: a desired-state leaf is gated the same as an imperative one
    Given a code task whose acceptance criteria are embedded in its spec
    When build_workorder assembles the leaf prompt
    Then the prompt frames the task as a convergence promise with no imperative recipe verb
    And the prompt names no test, runner, or gate mechanism and never inlines verifyCommand
    When the leaf returns an @@EDIT envelope and source-integration apply lands it on a jj change
    And docker-verify runs the host verifyCommand against that change
    Then the run greens only on docker-verify exit 0, independent of the leaf's self-report

  Scenario: desired-state does not regress against imperative (adoption bar)
    Given the same task fixture run under both framings
    When each leaf's envelope is applied and gated
    Then the desired-state pass-rate is at least the imperative pass-rate
