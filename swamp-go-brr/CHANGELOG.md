# Changelog

All notable changes to `@magistr/swamp-go-brr`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.06.17.1 — assessment-boundary audit + lease-expiry hardening

### Fixed

- `gobrr` `heartbeat` and `add_followup` validated lease OWNERSHIP but not lease
  EXPIRY, while `applyReport` checks both. An expired-but-unreaped lease could
  be renewed (resurrected past its TTL, dodging the scheduler reap) or could
  still inject a follow-up — trusting the owner's continued claim without
  re-measuring the lease's validity. Both methods now reject a lapsed lease via
  the existing pure `leaseExpired`, so lease validity = (owner AND not-expired)
  is enforced consistently at every state-transition method.

### Added

- A Promise-Theory assessment-boundary audit (`docs/decisions/0005`) confirming
  every gobrr handoff measures rather than trusting a self-report, plus
  regression tests pinning the measured-not-asserted invariants: `testReport` is
  never the gate; `parseExitSentinel` takes the host's last sentinel (a
  container cannot forge a green); `parseGitDiffPaths` flags
  symlinks/gitlinks/mode-changes as non-regular (the host-side ACL tripwire). No
  behavior change for these — the boundaries were already sound.

## 2026.06.16.6 — bounded retention for secret-bearing resources

### Changed

- The four secret-bearing resources now have a bounded lifetime instead of
  `infinite`, so any secret the (best-effort) scrubber misses no longer persists
  forever: `source-integration` `workorder` (inlined scrubbed file slices) and
  `applied` (scrubbed diff) → **24h**; `docker-verify` `result` → **24h**;
  `gobrr` `stepOutputs` (the durable audit log, read on post-halt inspection) →
  **7d**. The non-secret state resources (`run`/`summary`/`decision`/`config`)
  stay `infinite` so run history and authoritative state are not dropped.
- `docker-verify` now scrubs `result.stdout` at the write boundary via a pure
  `boundedStdout(s) = scrubSecrets(s).slice(-8000)` helper (it was the only
  secret-bearing field stored RAW); the exit-code gate reads the raw stdout
  before scrubbing, so the gate is unaffected. The field is marked
  `.meta({ sensitive: true })` for downstream redaction.
- Scrubbing stays the PRIMARY control; the bounded TTL is defense-in-depth.

## 2026.06.16.5 — gobrr: record per-step outputs (audit trail)

### Added

- `gobrr` records the OUTPUT of every leaf invocation in a new append-only
  `stepOutputs` resource: the agent-DECLARED envelope summary (block count,
  edits-per-file, target paths), the host-OBSERVED `changedPaths` + scrubbed
  `diffTail`, the docker-verify exit code + scrubbed `verifyTail`, and the
  resolved outcome/failureKind. Only these raw PRUNED measurements are stored;
  rollups (record count, declared-vs-observed mismatches, reaped-invocation
  gaps) are DERIVED by `stepOutputProjection`, never persisted (ADR 0002 — the
  "pruned source rows" exception). `report` persists the run FIRST (the green
  gate is sacred) then best-effort appends the record (never blocking the gate);
  `hydrate` surfaces the projection. Motivated by
  `si-apply-multi-edit-same-file` shipping a dropped edit silently — a declared
  edit that produced no host-observed change is now an inspectable mismatch.
- `source-integration` `apply` returns a `declaredEnvelopeSummary` per task
  (agent-declared, advisory) alongside the host-observed `changedPaths`/`diff`.

### Changed

- `scrubSecrets` extracted to a pure, cycle-free `lib/scrub.ts` (re-exported
  from `source-integration`) and broadened with AWS / GitHub / GitLab / GCP and
  a generic high-entropy `key=value` pattern on top of the legacy
  `sk-ant`/`Authorization` ones, so the new persisted `verifyTail`
  (docker-verify stdout) is scrubbed UNCONDITIONALLY at the gobrr storage
  boundary. This also broadens the existing apply-boundary diff scrub.

### Notes

- `RunSchema` is unchanged — the audit log is a separate read-model resource, so
  the scheduler hot path stays lean and there is no schema/interface bridge
  drift.

## 2026.06.16.4 — gobrr: per-task-type trust projection

### Added

- `gobrr` `trustSummary(run)` — a pure, DERIVED per-task-type promise-keeping
  projection (no stored state) keyed on `task.gate` (real=code, advisory=test):
  `{ kept, broken, passRate, greenFirstTryRate, meanAttemptsToGreen }`. A `done`
  task kept its promise (`attemptsToGreen = attempts + 1`); `exhausted` /
  `merge_conflict` broke it; `blocked` / `infra_error` / non-terminal are
  excluded. Deriving from the final task status captures both the `report` and
  the scheduler lease-reap `exhausted` paths. Surfaced read-only as `trust` in
  `completeReport` and `trustSoFar` in `hydrate`. Promise Theory: trust is the
  measured (gate-exit-code) assessment, never the agent's self-report — the data
  foundation for later adaptive verification.

## 2026.06.16.3 — source-integration: input-validation hardening

### Changed

- `source-integration` now validates inputs through two pure, unit-tested
  predicates: `isSafeRepoScope` (absolute, no shell metacharacters / whitespace
  / `..`) is enforced in **both** `apply` and `build_workorder` (the latter
  previously had no guard before `realPathSync`), and `isSafeRevision`
  (non-empty, no leading `-`, no whitespace) guards `args.base` before `jj new`,
  which now also passes a `--` separator (defense vs flag injection). The `.jj`
  existence check uses `lstatSync` (no-follow) so a symlinked `.jj` fails
  closed. All defense-in-depth — no live exploit; surfaced by the
  si-apply-multi-edit review.

## 2026.06.16.2 — source-integration: reject duplicate @@NEWFILE paths

### Fixed

- `source-integration` `planApply` rejected a path present in both `@@EDIT` and
  `@@NEWFILE` but not two `@@NEWFILE` blocks for the same path — the second
  silently clobbered the first. The pre-check now also rejects duplicate
  `@@NEWFILE` paths, keyed on the normalized path (so `dir//x.ts` and `dir/x.ts`
  cannot slip past as distinct), returning `envelope_parse` before any write.
  Multiple `@@EDIT` blocks per file remain valid (they fold).

## 2026.06.16.1 — source-integration: cumulative same-file edit fold

### Fixed

- `source-integration` `planApply` lost data when a leaf emitted multiple
  `@@EDIT` blocks for the SAME file: each block was computed against the
  pristine snapshot and pushed as a separate write, so the apply write-loop kept
  only the last block (e.g. a sibling that added a method but dropped its
  import). Blocks for one file are now applied one after another over a per-path
  running copy and folded into a single cumulative write, with `@@OLD`
  inclusion/uniqueness and the `MAX_ENVELOPE_BYTES` cap checked against the
  running content. A path present in both `@@EDIT` and `@@NEWFILE` is rejected
  (`envelope_parse`), and a no-op fold (content unchanged) emits no write.
  Guards stay per block; the apply write-loop and the host-observed
  `changedPaths`/diff are unchanged.

## 2026.06.15.1 — preflight (+ scaffold), bundled skill, two-leaf TDD

### Added

- `@magistr/swamp-go-brr/preflight` — codebase-agnostic substrate setup. Ensures
  the local OCI registry and digest-pins the codebase's OWN gate image
  (`pin_image`: builds a `buildContext` or pins a prebuilt `sourceImage`,
  pushes, resolves the RepoDigest, pulls it back for the `--network none` gate),
  then emits the run `config` (gate params, `fabric_up` inputs, the vault CEL
  for the OAuth token, and the `si`/`dv`/`fab` create commands). No language
  toolchain is baked in — that lives in the codebase's gate image. Shells to
  `docker` only (never `swamp`, which would deadlock on the per-process
  `__global__` lock).
- Bundled the `swamp-go-brr` driving skill (SKILL.md + inline-loop /
  work-contract / practices / reporting references + trigger evals) into the
  package under `.claude/skills/swamp-go-brr/`, declared via the manifest
  `skills:` list. The loop is driver-free — the agent IS the driver — so the
  cross-model protocol (gobrr → build_workorder → fabric submit/poll → apply →
  docker-verify → report), the sacred rules, and the concurrency gotchas now
  ship with the models instead of living only in one repo.
- `preflight scaffold` — scaffold a greenfield repo for a run: write the
  caller-provided baseline files, `jj git init --colocate`, describe the
  bootstrap change, and return the common base change id. jj-only (no `swamp`),
  toolchain-agnostic (the caller brings the file set).

### Changed

- Skill: surface `preflight` as **Phase 0** (it was implemented but undocumented
  — the top cause of slow runs) via a new `references/preflight.md`: the
  substrate + fabric-readiness + greenfield-scaffold recipe, with
  **per-language** gate presets (TS / Rust / Python), not deno-only.
- Skill: redefined TDD as a **two-leaf, language-agnostic** flow — a **test
  leaf** writes the tests + a signature-only **contract** (gated by a static
  check of the contract), then a **code leaf** (`dependsOn` it) implements
  against the contract and is gated by running the hidden tests, seeing the
  signature but never the assertions. Added leaf-authoring patterns
  (`@@NEWFILE`-on-absent; test-leaf vs code-leaf) and the fabric-readiness +
  per-kind gate-command gotchas. No gobrr change — the driver picks the gate
  command per leaf kind.

## 2026.06.12.1 — source-integration + driver-free loop

### Added

- `@magistr/swamp-go-brr/source-integration` — the host code-ownership /
  allowlist-ACL actor: `build_workorder` (read the allowlist file slice into the
  leaf prompt, no-clone) and `apply` (parse the `@@EDIT` envelope, apply each
  task as a **per-task base-isolated** jj change behind a **realpath-anchored**
  allowlist ACL with a DENY set + mode/symlink/gitlink rejection + size caps,
  return host-observed `changedPaths` + a secret-scrubbed diff). Shared path-ACL
  kernel in `extensions/models/lib/acl.ts`.

### Changed

- `gobrr` is now a strictly PURE DAG state machine: its JSON `parseEnvelope` is
  removed (envelope parsing moved to `source-integration`, which owns the
  canonical `@@EDIT` wire format + the nonce-fence forgery defense).
  `unsafe_change` added to the failureKind vocabulary. The loop is driven inline
  (no driver script).
