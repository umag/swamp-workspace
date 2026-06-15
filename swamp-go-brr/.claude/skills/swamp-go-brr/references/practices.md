# Practices injected into each leaf's prompt

The TDD/DDD/review practices are **injected as content** into the WorkOrder
prompt — NOT installed as Claude Code skills. Skill names are the global install
key; the canonical `tessl__tdd` / `tessl__ddd` / `tessl__review-*` skills are
already owned by `issue-lifecycle`'s package, so vending them here would
collide.

## Anti-drift posture

The text below is a **distilled checklist + a pointer**, not a fork. Source of
truth = the canonical skills' SKILL.md. Pin the distilled version to a canonical
skill version string in the WorkOrder; on a periodic drift check, re-distill if
the canonical skill version advanced. Do not deep-copy the references.

## Distilled checklist (inject verbatim into the leaf prompt)

You are implementing ONE small task in an isolated microVM. You are given the
working-set files inline; edit only paths in your writeAllowlist; do NOT touch
test files unless this task's allowlist is test-only.

- **TDD (red→green→refactor).** Write the failing test first (if your allowlist
  is test-only); make the minimum change to pass; refactor while green. Report
  `testReport.redFirst` honestly (advisory only — the host re-runs the real
  gate).
- **DDD.** Name things in the domain's ubiquitous language. Prefer value objects
  over primitives; keep aggregate invariants inside the root; don't leak
  persistence into the domain.
- **Review lenses (self-apply before emitting).** Correctness (logic gaps),
  security (no secrets in output; no shelling out to untrusted input), error
  handling, idempotency, API contracts, resource cleanup.

## Leaf authoring patterns (learned — they cost retries when ignored)

Two leaf kinds; the rules are language-agnostic (TS / Rust / Python — same
flow).

- **Create your file(s) with `@@NEWFILE`; do not rely on editing a stub.**
  Leaves emit a whole new file reliably and `@@EDIT` an existing stub unreliably
  (they silently drop imports / `use` / declarations). The host removes any stub
  at your apply base, so emit the COMPLETE file via `@@NEWFILE`, **including
  every import/use** you reference.
- **Test leaf:** write the test file AND a **signature-only contract** for the
  unit — the exported signatures the impl must satisfy, no logic (TS:
  interface/`.d.ts`; Rust: `trait`/sig stub; Python: `.pyi`/`Protocol`). The
  contract is the handoff the code leaf implements against; the assertions stay
  hidden from it. Your gate is a static check of the contract, not a test run.
- **Code leaf:** you are given the **contract (signatures), NOT the test**.
  Implement the unit to satisfy the contract exactly (every name, argument, and
  return type), honouring its implied behaviour — it is then run against a
  hidden test. You cannot see or change that test; do not try to.

## Output

Emit ONLY the nonce-fenced WorkResult envelope (see work-contract.md). Put any
unfinished/blocked dependency you discover into `followups[]` with a tight
`spec` and a `writeAllowlist` inside the repo — it becomes a blocking DAG node.
