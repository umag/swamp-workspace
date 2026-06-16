# issue: si-apply-multi-edit-same-file
# date: 2026-06-16
# Core behavior is unit-covered in source_integration.test.ts; this is the
# end-to-end (gobrr loop) equivalent.

Feature: source-integration folds multiple same-file edits

  Scenario: a leaf that edits one file in two places keeps both edits
    Given a gobrr leaf whose WorkResult envelope has two @@EDIT blocks for the same file
      And one block inserts an import and the other inserts a method
    When source-integration.apply applies the envelope to the jj change
    Then the resulting file contains both the import and the method
      And jj diff reports the file exactly once
