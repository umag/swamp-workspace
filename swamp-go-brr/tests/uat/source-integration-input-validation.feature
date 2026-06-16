# issue: si-input-validation-hardening
# date: 2026-06-16
# Pure predicates (isSafeRepoScope/isSafeRevision) are unit-covered in
# source_integration.test.ts; these are the end-to-end (method-level) equivalents.

Feature: source-integration validates method inputs

  Scenario: build_workorder rejects an unclean repoScope before touching the filesystem
    Given a build_workorder call whose repoScope is relative or contains shell metacharacters
    When the method runs
    Then it throws before calling realPathSync and reads no files

  Scenario: apply rejects an unsafe base revision before jj new
    Given an apply call whose base revision is empty or starts with "-"
    When the method runs
    Then it throws "unsafe base revision" before creating any jj change

  Scenario: jj new isolates the base revision with a -- separator
    Given a valid base revision
    When apply creates the sibling change
    Then jj new is invoked as new -m <msg> -- <base> so the base can never be read as a flag
