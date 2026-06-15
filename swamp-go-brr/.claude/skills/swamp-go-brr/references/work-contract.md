# The work contract: WorkOrder → WorkResult, and the gate

A leaf is a pure text transform run by `claude --print`: the host sends a
`WorkOrder` (serialized into the prompt), the agent returns a `WorkResult`
(parsed from a nonce-fenced stdout envelope). The repo never leaves the host.

## WorkOrder (host → guest, in the prompt)

- `spec` — the one change to make + acceptance criteria.
- `files[]` — the minimal working-set slice (`path` + `content`). The guest does
  NOT clone; it edits these. Keep the slice small (prompt size is the limit).
- `practices` — injected TDD/DDD/review guidance (practices.md).
- `writeAllowlist` — the paths the agent may change (echoed for the agent's
  benefit; the host enforces it on apply regardless).
- `leafModel` / `leafEffort` — the model id + reasoning effort for the leaf
  `claude --print --model … --effort …` (from RunConfig; effort defaults to
  **low** — leaves are small, bounded units). Enum `low|medium|high|xhigh|max`,
  passed natively in the `@magistr/firecracker` fabric `submit` task shape
  (`{prompt, model, effort, gitRepoUrl}`); `gitRepoUrl=""` keeps it no-clone.
- `nonce` — per-invocation high-entropy fence id; the agent must wrap its output
  in the canonical **@@EDIT envelope** (raw line markers — no JSON; multi-line
  code in `@@OLD`/`@@NEW`/`@@NEWFILE` is verbatim, no escaping):

```
<<<GOBRR:<nonce>
@@EDIT <path>
@@OLD
<exact, unique current text in that file>
@@NEW
<replacement text>
@@ENDEDIT
@@NEWFILE <path>
<full content of a file that does not exist yet>
@@ENDFILE
GOBRR:<nonce>>>>
```

One `@@EDIT` block per change to an existing file (`@@OLD` must be an exact,
unique substring of its current content); `@@NEWFILE` for new files. Each marker
alone on its own line; nothing outside the fence.

## WorkResult (host-built from the applied tree)

`source-integration.apply` parses the @@EDIT envelope (carrying the nonce-fence
forgery defense), applies it, and **builds** the `WorkResult` gobrr.report
consumes: `{ diff, changedPaths[], followups?, note?, failureKind? }`. The
`diff` + `changedPaths` are **host-observed** from `jj diff --git` (never the
agent's self-declared paths); the diff is secret-scrubbed. Parse/apply failures
map to a typed `failureKind`
(`envelope_parse|envelope_oversize|nonce_mismatch|claude_error|out_of_allowlist|unsafe_change`)
→ `infra_error`, which does NOT consume an attempt.

## The green gate (unforgeable in the common case)

- `gate` is derived by the host from `writeAllowlist ∩ verifyInputs`: **disjoint
  → `real`** (a code task), **subset → `advisory`** (a test task), **mixed →
  rejected** at scoping (split it).
- GATED-TREE INVARIANT: only `writeAllowlist` hunks reach the gated tree; a code
  task's hunk touching `verifyInputs` is hard-rejected (`out_of_allowlist`). So
  a code task's verify surface is always baseline — it cannot weaken the tests
  that judge it, even via a shared helper.
- gobrr greens ONLY on `docker-verify` `exitCode==0`. A test task (`advisory`)
  auto-merges after a non-forgeable self-check (the verify command still
  passes).

## Accepted residuals (documented limits, improve later)

1. A verify-relevant file mis-declared as _production_ (so in a code task's
   allowlist) could be defanged with tests still green. Mitigation later: a
   coverage-trace classification (advisory when the allowlist intersects the
   files `verifyCommand` actually loads).
2. A test task can keep the suite passing while weakening an assertion
   ("still-runs ≠ still-asserts" — the undecidable test-completeness limit).

Both are bounded by the threat model (single-user homelab, owner's repos) and
the final human PR review of the run-produced jj changes. The gate is a
**filter, not a proof**.
