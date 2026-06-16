# issue: si-apply-multi-edit-same-file
# date: 2026-06-16

Feature: source-integration rejects same-path edit/newfile collisions

  Scenario: a path targeted by both @@EDIT and @@NEWFILE is rejected
    Given a WorkResult envelope that targets one path with both @@EDIT and @@NEWFILE
    When source-integration.apply parses it
    Then it returns failureKind envelope_parse
      And it writes nothing to the jj change
