# issue: si-apply-duplicate-newfile-clobber
# date: 2026-06-16

Feature: source-integration rejects duplicate @@NEWFILE paths

  Scenario: two @@NEWFILE blocks for the same path are rejected
    Given a WorkResult envelope with two @@NEWFILE blocks targeting the same path
    When source-integration.apply parses it
    Then it returns failureKind envelope_parse
      And it writes nothing to the jj change

  Scenario: two @@NEWFILE paths that normalize to the same file are rejected
    Given a WorkResult envelope with @@NEWFILE for "dir/x.ts" and for "dir//x.ts"
    When source-integration.apply parses it
    Then it returns failureKind envelope_parse
