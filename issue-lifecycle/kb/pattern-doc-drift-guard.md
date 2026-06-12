---
kind: pattern
issue: tdd-subcycle-doc-drift
date: 2026-06-12
---

# Pattern: drift-guard contract test between a model and its skill docs

When an extension ships both a swamp model (the behavioral source of truth) and
bundled skill documentation that drives agents, the two WILL drift — the model
is gated by its test suite, the docs by nothing. Bind them with a contract test
that lives next to the model tests and runs in the same `deno task test`:

1. **Per-file token assertions** — each critical fact is asserted against the
   one file that is authoritative for it (positive: the file must name the gate
   method; negative: the file must not contain the superseded transition
   string). These catch the bug class where one doc actively teaches outdated
   behavior.
2. **Dynamic completeness sweep** — enumerate `StateEnum.options` and
   `Object.keys(model.methods)` from the **imported model at test runtime**
   (never a hardcoded list) and require each token to appear **backticked** in
   the canonical reference doc (state-machine.md). The backtick anchor stops
   common-word names (`plan`, `complete`, `close`) from false-passing via prose;
   dynamic enumeration makes every future state/method automatically demand
   documentation.

Wiring notes: the test needs `--allow-read=.` in the test task; resolve doc
paths via `import.meta.url` so CWD doesn't matter; rethrow
`Deno.errors.NotCapable` with a loud message so a permission failure can never
masquerade as an assertion result.

Reference implementation: `extensions/models/issue_lifecycle_docs.test.ts`
(introduced in 2026.06.12.1).
