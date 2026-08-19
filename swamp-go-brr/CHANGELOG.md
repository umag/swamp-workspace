# Changelog

## 2026.08.19.1

- Version bump and smoke test

All notable changes to `@magistr/swamp-go-brr`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.08.07.1 — privacy: neutral defaults for sshUser/jjPath/fcHost

`preflight`'s `GlobalArgs` defaulted three fields to this homelab's REAL
infrastructure: `sshUser` to the operator's actual local unix username, `jjPath`
to that user's actual home-directory path, and `fcHost` to the operator's actual
Firecracker fabric hostname. Any installer who created a `preflight` instance
without overriding these globals inherited that disclosure verbatim (surfaced in
`instanceCommands`' generated `swamp model create` strings). All five models
bump to `2026.08.07.1` (lockstep, single manifest version); only `preflight`
changes functionally.

### Fixed

- `preflight`'s `GlobalArgs.sshUser` default (the operator's real local unix
  username) → `runner` (a generic agent/CI-style username, matches no real
  account).
- `preflight`'s `GlobalArgs.jjPath` default (an absolute path under that same
  real user's home directory) → `jj` (PATH-relative — matches
  `source-integration`'s own `jjPath` default, which was already neutral).
- `preflight`'s `GlobalArgs.fcHost` default (the operator's real Firecracker
  fabric hostname) → `firecracker.example.com` (RFC 2606 reserved example
  domain).
- Behavior-preserving for every instance that already sets these globals
  explicitly (the overwhelming majority — the defaults only matter for a
  brand-new instance created with no `--global-arg` overrides). No resource
  schema change; `upgradeAttributes` is identity on all five models.

### Changed

- `preflight.test.ts`'s `SUB` fixture and the `instanceCommands` expected
  command strings updated to the new neutral defaults.
- Five `// Run: …` dev-comment header lines across the test suite
  (`gobrr.test.ts`, `gobrr_observability.test.ts`, `lib/otlp.test.ts`,
  `otlp_export.test.ts`, `source_integration_leaf_json.test.ts`) that hardcoded
  the same real absolute home-directory path in an example `deno test`
  invocation now use `~/.swamp/deno/deno` (matches the convention already used
  by `reading-list/README.md`). Comment-only, no behavior change.

## 2026.08.02.1 — security: real-fix B1–B8 + five-suite quality (Grade A)

All eight latent bugs tracked in the LOCAL `swamp-go-brr-latent-bugs`
issue-lifecycle bug model (never the Lab, per this repo's convention) are now
REAL-FIXED, not just characterized. All five models bump to `2026.08.02.1`
(lockstep, single manifest version) and each gains its first `upgrades[]` entry
(identity `upgradeAttributes`, no resource schema change anywhere — every new
global arg is additive-defaulted).

### Fixed

- **B3 (MED, secure-by-default)** — `lib/ssh.ts` no longer hardcodes
  `StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null` for every ssh
  invocation. The default is now `StrictHostKeyChecking=accept-new` (TOFU:
  trusts an unseen host key on first contact, refuses one that later CHANGES)
  with ssh's own known_hosts file — never a blanket `/dev/null`. The historical
  insecure pairing remains reachable only via the documented opt-out: new
  `sshStrictHostKeyChecking` (`accept-new`/`yes`/`no`, default `accept-new`) and
  `sshKnownHostsFile` global args on `docker-verify`.
- **B1 (MED)** — `docker-verify`'s ssh transport (`sshExecRaw`) now enforces a
  client-side timeout wrapping the WHOLE invocation (handshake + remote
  command), via `AbortController`+`setTimeout` (`clearTimeout` always in
  `finally`). On expiry the child is killed and a synthetic `exitCode=124` is
  recorded (fail-closed) instead of hanging the ssh session indefinitely past
  ssh's own `ConnectTimeout=10` (which bounds only the handshake). New
  `verifyTimeoutMs` global arg (default `1800000`ms / 30min).
- **B2 (MED, within-temp)** — `preflight.scaffoldRepo` now pre-validates EVERY
  `ScaffoldFile.path` with `pathEscapes` before any write, rejecting a `../` (or
  absolute/whitespace) path with `unsafe scaffold path: …` instead of writing it
  straight into `repoPath`'s parent. Fail-closed: no partial scaffold on
  rejection.
- **B4 (LOW)** — `lib/scrub.ts`'s generic `key=value` pattern's value floor is
  raised `{8,}` -> `{11,}`, so a short (<11 char) benign `token=`-shaped value
  (e.g. `token=abc12345`) no longer false-positives; secrets >=11 chars,
  including all-lowercase-hex, are still caught. `scrubSecrets` now also imposes
  its own tail-preserving `MAX_SCRUB_BYTES` (`262144`) cap independent of any
  caller-side bound (a caller that forgets to bound its input, e.g.
  `build_workorder`'s raw file read, is no longer exposed to an unbounded regex
  scan). `source-integration`'s diff capture switches from scrub-then-slice to
  bound-then-scrub (`scrubSecrets(dr.stdout.slice(0,
  20000))`);
  `docker-verify`'s and `gobrr`'s tail-preserving callers are unchanged.
- **B5 (LOW)** — `scrubSecrets` now redacts a BARE high-entropy run (>=32 chars,
  mixing lower/upper/digit) even with no recognizable key word ahead of it —
  previously an accepted, documented gap.
- **B6 (LOW)** — `source-integration`'s local `jjRun` now carries `--no-pager`
  on every invocation and enforces a client-side timeout (new `jjTimeoutMs`
  global arg, default `120000`ms), mirroring `lib/ssh.ts`'s
  `AbortController`+`clearTimeout`-in-`finally` pattern.
- **B7 (LOW)** — `parseGitDiffPaths`'s `diff --git a/<A> b/<B>` header parse now
  splits at the `b/` boundary where the two halves are EQUAL (scanning every
  occurrence), instead of the old non-greedy regex stopping at the FIRST `b/` —
  so a path containing a literal `" b/"` substring (e.g. `weird
  b/file.ts`) no
  longer mis-splits. Still unreachable via the real `apply()` flow either way
  (`pathEscapes` rejects any whitespace-containing path upstream) — the CONTRAST
  pin stays.
- **B8 (LOW)** — `apply()`'s per-file write now goes through a new `lib/acl.ts`
  helper, `safeWriteWithinRepo`: refuses an existing symlink at the final path
  component (no-follow) and, after the write lands, re-confines the real path
  under `repoRoot` via a new `confineWrittenPath` — detecting and best-effort
  unlinking a TOCTOU ancestor-symlink-swap race instead of silently leaving an
  escaped write in place.

### Changed

- All eight adversarial pins in `swamp_go_brr_adversarial_test.ts` flip from
  "asserts buggy behavior" to "asserts fixed behavior" (non-vacuous — each was
  re-verified to actually exercise the new code path), plus new tests: the B3
  opt-out, B1/B6 timeout-fires-under-a-hung-child (a new `stubHangUntilAbort`
  Deno.Command stub), B2's reject-before-any-write, B4's
  cap-enforced-on-oversize-input, B5's bare-blob-redacted, and B8's
  symlinked-final-component/symlinked-parent refusals (added to
  `lib/acl.test.ts`). The B7 CONTRAST pin (`pathEscapes` rejects a
  whitespace-containing path upstream of `apply()`) stays.
- `swamp_go_brr_property_test.ts`'s `arbBenignText` now also excludes any
  generated run matching B5's bare-high-entropy pattern (mirrors the production
  regex), preventing the pre-existing "no false-positive redaction on benign
  text" property from flaking red at a high `FC_NUM_RUNS`; a new positive
  property asserts an arbitrary bare high-entropy blob (>=32 chars, all 3
  char-classes) is always redacted.
- The five contract-fixture suites (`source_integration.test.ts`,
  `source_integration_framing.test.ts`,
  `source_integration_applied_result.test.ts`, `lib/otlp.test.ts`,
  `gobrr_observability.test.ts`) stay byte-identical — none of them touch
  `Deno.Command`/`jjRun`/ssh directly, only pure functions unaffected by this
  release.
- README: documents the new global args (`verifyTimeoutMs`,
  `sshStrictHostKeyChecking`, `sshKnownHostsFile`, `jjTimeoutMs`) and B3's
  secure-by-default posture + opt-out.
- `quality.yaml`: re-stamped from a real `swamp extension quality` run; drops
  the "byte-frozen"/"UNFIXED" framing (B1–B8 are fixed now, not pinned-as-
  known-gaps); five suites still present, `label: "Grade A"`.

### Also in this release (previously undocumented as "Unreleased")

The prior `2026.07.16.2` version bump shipped the model's full five-suite test
coverage (contract-fixture, methods, adversarial, coverage,
property-invariant-flow — closing the gap left by the pre-existing 12 tests)
without its own CHANGELOG entry; folded in here for the record:

- `extensions/models/swamp_go_brr_methods_test.ts`,
  `swamp_go_brr_adversarial_test.ts`, `swamp_go_brr_coverage_test.ts`, and
  `swamp_go_brr_property_test.ts` drive gobrr's
  start/seed_tasks/next/report/complete/emit_otlp/hydrate/abort,
  source-integration's build_workorder/apply, docker-verify's verify, and
  preflight's pin_image/scaffold/config at the `model.methods.<m>.execute()`
  level (through `arguments.parse()`, so the zod arg schema is pinned too)
  against real fake contexts, a real temp repo, and a stubbed `Deno.Command` —
  BOTH shapes used in production: the "direct output" seam
  (`new
  Deno.Command(cmd,{args}).output()`, used by lib/ssh.ts and
  source-integration's local `jjRun`) and preflight's "spawn+stdin" seam
  (`new Deno.Command(...).spawn()` + `child.stdin.getWriter()` +
  `child.output()`). Property suite added `npm:fast-check@4.8.0` (`FC_NUM_RUNS`
  override, verified manually at `FC_NUM_RUNS=5000`); `deno task test:soak` runs
  it at that iteration count.
- Corrected `quality.yaml`'s honest per-file role map (the scaffolder had dumped
  all 12 pre-existing tests under contract-fixture); five suites `present`,
  `docs.skill: present` (`.claude/skills/swamp-go-brr/SKILL.md`).
- Removed `swamp-go-brr` from the repo-root `quality-allowlist.txt`.

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
