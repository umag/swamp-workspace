# UAT conventions

End-to-end / acceptance scenarios live under `tests/uat/` as Gherkin `.feature`
files (`Given` / `When` / `Then`).

- One feature file per behavior area; name it `<model>-<behavior>.feature`.
- Lead with two comment lines: `# issue: <issue-name>` and
  `# date: <YYYY-MM-DD>`.
- These are the loop-level equivalents of the pure unit tests in
  `extensions/models/*.test.ts`; prefer a unit test when the behavior is pure
  (e.g. `planApply`), and a UAT when it spans the gobrr loop (envelope → apply →
  jj → verify).
