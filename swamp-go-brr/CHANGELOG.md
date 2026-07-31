# Changelog

All notable changes to `@magistr/swamp-go-brr`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## Unreleased — test/docs-only: five-suite quality backfill (Grade A)

### Added

- `extensions/models/swamp_go_brr_methods_test.ts`,
  `swamp_go_brr_adversarial_test.ts`, `swamp_go_brr_coverage_test.ts`, and
  `swamp_go_brr_property_test.ts` — the model now has full five-suite coverage
  (contract-fixture, methods, adversarial, coverage, property-invariant-flow),
  closing the gap left by the pre-existing 12 tests: gobrr's
  start/seed_tasks/next/report/complete/emit_otlp/hydrate/abort, and
  source-integration's build_workorder/apply, docker-verify's verify, and
  preflight's pin_image/scaffold/config, are now driven at the
  `model.methods.<m>.execute()` level (through `arguments.parse()`, so the zod
  arg schema is pinned too) against real fake contexts, a real temp repo, and a
  stubbed `Deno.Command` — BOTH shapes used in production: the "direct output"
  seam (`new Deno.Command(cmd,{args}).output()`, used by lib/ssh.ts and
  source-integration's local `jjRun`) and preflight's "spawn+stdin" seam
  (`new Deno.Command(...).spawn()` + `child.stdin.getWriter()` +
  `child.output()`). No behavior change — `gobrr.ts`, `docker_verify.ts`,
  `otlp_export.ts`, `preflight.ts`, `source_integration.ts`, and
  `lib/{acl,otlp,scrub,ssh}.ts` are byte-identical (frozen source;
  ext-quality-bf-swamp-go-brr). Property suite added `npm:fast-check@4.8.0`
  (`FC_NUM_RUNS` override, verified manually at `FC_NUM_RUNS=5000`); a new
  `deno task test:soak` runs it at that iteration count.
- Eight known-but-unfixed issues pinned as characterization tests, tracked in
  the LOCAL `swamp-go-brr-latent-bugs` issue-lifecycle bug model (never the Lab,
  per this repo's convention): B1 (MED) — docker-verify's ssh transport has no
  client-side timeout on the remote verify command's runtime (only ssh's own
  `ConnectTimeout=10` bounds the handshake); B2 (MED, within-temp) —
  `preflight.scaffoldRepo` joins `ScaffoldFile.path` into `repoPath` with no
  traversal guard; B3 (MED) — `lib/ssh.ts` hardcodes
  `StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null` (MITM-
  susceptible); B4 (LOW) — `lib/scrub.ts`'s generic `key=value` pattern is a
  documented, deliberately over-eager false-positive-prone approximation, and
  `scrubSecrets` imposes no input-size cap of its own (callers tail-bound after
  scrubbing, not before); B5 (LOW) — a bare high-entropy secret with no
  recognizable key word is not redacted (an accepted, already-documented gap);
  B6 (LOW) — source-integration's local `jjRun` carries no timeout and never
  passes `--no-pager`; B7 (LOW) — `parseGitDiffPaths`'s `a/(.+?) b/` regex
  mis-splits a path containing a literal `" b/"` substring, but this is
  UNREACHABLE via the real `apply()` flow because `pathEscapes` already rejects
  any whitespace-containing path upstream; B8 (LOW) — `apply()`'s per-file write
  is resolve-then-write, not atomic — a symlink swapped into place between
  `resolveWithinRepo`'s check and the actual write escapes the repo (TOCTOU).
- Rewrites `quality.yaml`: corrects the honest per-file role map (the scaffolder
  had dumped all 12 pre-existing tests under contract-fixture), all five suites
  `present`, `docs.skill: present` (`.claude/skills/swamp-go-brr/SKILL.md`),
  ratchet `baselinePercentage: 100`, `label: "Grade A"`, `rubricVersion: 3`.
- Adds a `deno task test:soak` and removes `swamp-go-brr` from the repo-root
  `quality-allowlist.txt`.

## 2026.06.19.3 — docs: expanded manifest description

### Changed

- Expanded the manifest `description` with a human-oriented overview (what the
  loop does + the host-isolation/green-gate guarantee) and a "getting started"
  pointer. The swamp-club extension page renders the `description` (not the
  bundled README), so this is what shows there. Docs-only — no behaviour change.

## 2026.06.19.2 — maintenance: CI republish

No code change. `2026.06.19.1` was published manually (to work around a
temporary registry yank), which collided with the CI publish-on-push for the
same version ("version already exists"). This release is cut by CI, with
per-version release notes now sourced from this CHANGELOG.

## 2026.06.19.1 — docs: task-oriented README + full symbol docs

### Changed

- README rewritten in a task-oriented shape (Tutorial → How-to → Reference →
  Explanation), brought current with all five models (incl. `preflight` +
  `otlp-export`) and the observability how-tos.
- JSDoc added to every exported symbol across the model entrypoints, so
  `swamp extension quality` scores 14/14 (`rich-readme` + `symbols-docs`).

Docs-only — no behaviour change, no schema change.

## 2026.06.18.1 — OTLP observability + per-leaf cost/tokens/time

### Added

- `gobrr.emit_otlp` derives two resources from the Run + 7d step records (pure,
  ADR 0002/0008): `traceOtlp` (run→task→invocation OTLP/JSON span tree, with a
  4-state `content.status` of ok|unavailable|empty|partial) and `metricsOtlp`
  (per-gate leaf token/cost/duration/invocation sums). A pre-feature task (no
  spanId) is suppressed whole — never orphaned to a trace root.
- W3C `traceId` (Run) + `spanId` (Task) + `invocationSpanId` (StepOutput) are
  ROOT FACTS: `.optional()` with NO default (absence is meaningful), generated
  in the execute methods. `intake` + `spec` are now marked `sensitive`.
- Per-leaf usage: the firecracker fabric gains opt-in
  `submit … outputFormat=json`; `source-integration.extractLeafJson` validates
  claude's `usage`/`total_cost_usd`/ `duration_ms` and maps `is_error` →
  `claude_error` (single site, text + json). Stored as `leaf.declared.*`
  (agent-declared, never a gate input) vs the host-measured
  `leaf.host.duration_ms` (ADR 0001/0005/0009).
- NEW model `@magistr/swamp-go-brr/otlp-export` (`export_run`): the loop's ONLY
  network egress — POSTs the OTLP over https to an endpoint+token from a vault
  CEL, best-effort (`exportStatus` ok|skipped|error), never persists/logs the
  URL or key.
- New `lib/otlp.ts` (cycle-free serializer + the authoritative attribute scrub +
  the `METRIC_LABELS` allowlist), ADRs 0008/0009, and
  `references/observability.md`.

### Notes

- Requires `@magistr/firecracker` ≥ `2026.06.18.1` ONLY for leaf-usage capture;
  an older fabric returns text and usage is simply absent. In-guest sub-spans +
  traceparent-into-the-leaf remain non-goals (separate follow-ups).

## 2026.06.17.4 — typed `applied` result contract

### Changed

- `source-integration`: the `applied` resource schema is no longer the opaque
  `z.record(string, z.unknown())`. The per-task result is now a typed
  `AppliedTaskResultSchema` — a `z.union` of two strict members: Success
  (`changeId`, host-observed `changedPaths`, scrubbed `diff`,
  `declaredEnvelopeSummary`) and Failure (`failureKind`, `note`). Strict members
  make the union genuinely discriminate (a hybrid success+failure result is
  rejected, never silently routed as a success). Issue
  `si-applied-result-typing`, surfaced by the assessment-boundary audit (ADR
  0005).
- The secret-bearing `diff` field is now marked `.meta({ sensitive: true })` —
  impossible while it was hidden inside `z.unknown()`. The scrub-at-write
  boundary is unchanged.
- The host-observed-vs-agent-declared `changedPaths` provenance invariant stays
  guarded at runtime by `gobrr`'s `stepOutputProjection` mismatch audit (ADR
  0002/0005); it is not a type-system property (both are `string[]`), so no
  nominal brand is introduced. Existing 24h-retained `applied` records already
  conform (the data shape never changed, only the schema strictness) — no
  migration.

(`.3` is the concurrent, separately-tracked default-concurrency change; this
entry is independent.)

## 2026.06.17.3 — default concurrency raised to 8

### Changed

- `gobrr` `maxConcurrentVMs` default `5 → 8`. The Firecracker fabric host runs
  only the leaf microVMs (the `docker-verify` gate runs elsewhere), each leaf is
  I/O-bound on the model API (vCPU oversubscribes fine), and RAM is the binding
  constraint at ≈512 MiB/VM — so 8 VMs ≈ 4 GiB fits an 8 GiB host comfortably.
  Paired with `@magistr/firecracker` `fabric_up`/`recycle`/`down` concurrency
  default `4 → 8`. Docs (sacred rule 3, `concurrency.md`, the `fabric_up`
  examples) updated. Above ~6–8, validate the pool with a probe leaf after
  `fabric_up` (the netns-uplink readiness gate).

## 2026.06.17.2 — leaf envelope-format hardening

### Changed

- `source-integration` `build_workorder`: the shared `@@EDIT` envelope
  instructions (in the extracted pure `buildWorkorderPrompt`) now carry an
  explicit close-marker requirement — every `@@EDIT` block must end with
  `@@ENDEDIT` and every `@@NEWFILE` with `@@ENDFILE` before the closing fence —
  plus a pre-fence self-check. The desired-state framing pilots
  (`docs/decisions/0006`) found a dropped `@@ENDEDIT` was the dominant non-gate
  failure (`envelope_parse`), hitting both prompt framings with correct code
  underneath. PROSE only — the `@@EDIT` wire format and `parseEnvelope` are
  unchanged. A same-session old-vs-new spot-check (60 leaves on the hard
  fixture, `claude-sonnet-4-6`) measured `envelope_parse` failures falling from
  **6/30 (80% parse-success)** on the old prompt to **0/30 (100%)** on the
  hardened prompt — the eliminated failures were exactly the slug/account tasks
  where the drops had appeared. N is modest, but it is a clear same-session win
  (no baseline confound). The imperative byte-identity golden is re-anchored to
  the new prompt (prior anchor recoverable via git / ADR 0006).

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
