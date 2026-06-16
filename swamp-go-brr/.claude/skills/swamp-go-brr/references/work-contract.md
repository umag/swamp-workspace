# The work contract: WorkOrder → WorkResult, and the gate

A leaf is a pure text transform run by `claude --print`: the host sends a
`WorkOrder` (serialized into the prompt), the agent returns a `WorkResult`
(parsed from a nonce-fenced stdout envelope). The repo never leaves the host.

## WorkOrder (host → guest, in the prompt)

- `spec` — the one change + acceptance criteria. The leaf cannot see
  `verifyInputs` (build_workorder only slices the allowlist), so the driver
  embeds what it needs there: a **code leaf** gets U's `contract` (the exported
  signatures) and NEVER the test assertions; a **test leaf** gets the acceptance
  criteria for the test it writes. See "TDD ordering" below.
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

Multiple `@@EDIT` blocks may target the same file; they are applied one after
another and each block's `@@OLD` must be an exact, unique substring of that
file's **running** content (the result of the preceding blocks for that file),
not the original on-disk text. Use `@@NEWFILE` for new files; a `@@NEWFILE` path
must be unique and may not also appear as an `@@EDIT` target in the same
envelope. Each marker alone on its own line; nothing outside the fence.

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

## TDD ordering — test leaf, then code leaf (signature handoff)

Each unit U is **two leaves**. The flow is the same in any language (TS, Rust,
Python, …) — only the commands and the contract's syntax change. A leaf produces
the test, then a second leaf writes the code, and the code leaf sees U's
**signature, not the assertions** — so it implements to the interface and is
judged by a test it never read.

1. **Test leaf** (gate `advisory` — allowlist = U's test file + U's CONTRACT,
   both inside `verifyInputs`). Writes the real tests AND a **signature-only
   contract** for U: the exported types/signatures the impl must satisfy, with
   no logic.
   - TS: a type-only `U.contract.ts` / `.d.ts` (interfaces + function types).
   - Rust: a `trait` or signature stub (`fn …;` declarations).
   - Python: a `.pyi` stub or a `typing.Protocol`.

   **Gate = a STATIC CHECK of the contract**, not the test run (no impl exists
   yet, so the suite would be red): `deno check` / `cargo check` / `mypy` (or
   `pyright`). On green it auto-merges; test + contract become `verifyInputs`.
2. **Code leaf** (gate `real` — `dependsOn` the test leaf, allowlist = U's impl
   file). Its WorkOrder embeds **the contract** (the signature) and **NEVER the
   test** — it implements to the interface and cannot overfit the assertions.
   **Gate = RUN THE TESTS** (`deno test` / `cargo test` / `pytest`) → green =
   the code passed a test it never read. The GATED-TREE INVARIANT bars it from
   touching the test/contract.

The driver picks the **gate command per leaf kind** — test leaf → the static
check, code leaf → the test run — and feeds the exit code to `report`; gobrr
greens on exit 0 either way, so **no gobrr change is needed**. Run config:
`verifyInputs` must cover the tests + the contracts; seed each code leaf
`dependsOn` its test leaf so the scheduler runs them in order.

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
