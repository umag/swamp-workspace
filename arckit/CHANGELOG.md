# Changelog

## 2026.08.02.1

Real-fix pass closing all six remaining latent bugs tracked on the LOCAL
`arckit-latent-bugs` issue-lifecycle model (NEVER filed to the swamp.club Lab) —
LB2 (MEDIUM) and LB3..LB7 (LOW). `arckit_workspace.ts` was no longer byte-frozen
after the LB1 fix in `2026.08.01.1`; this is the second production change.

- **LB2 (MEDIUM) — `migrateClassification apply=true` non-atomic overwrite, no
  backup.** The apply branch now copies the pre-migration content to a
  `<artifact>.bak` recovery sibling, writes the proposed text to a sibling temp
  file, then `Deno.rename`s it over the artifact — an atomic replace on the same
  filesystem, so a reader always sees the whole old or whole new file, never a
  truncated partial, and a crash mid-write leaves the artifact intact plus a
  recoverable `.tmp` orphan.
- **LB3 (LOW) — unbounded `readTextFile` in `template` /
  `migrateClassification`.** Added a defaulted global arg `maxFileBytes`
  (default 10 MiB) to `GlobalArgsSchema`. `migrateClassification` cap-checks via
  the scan snapshot's `sizeBytes` WITHOUT reading, recording an oversize
  artifact in the new `skipped[]` field (`reason: "oversize"`) in both report
  and apply modes; `template` `Deno.stat`s the bundled file and rejects before
  reading if it exceeds the cap.
- **LB4 (LOW) — non-enum `projectState.state` vacuously satisfies the gate.**
  `ProjectStateSchema.state` is now `z.enum(PROJECT_STATES)` (`PHASES` plus
  `complete`/`abandoned`) instead of `z.string()` — a schema seam change only.
  `readProjectState` (the sole reader for
  `status`/`advance`/`skipPhase`/`abandon`) now rethrows a friendly
  `Corrupted project state for <dir>: ...` error instead of a raw ZodError when
  a hand-edited/datastore-restored state falls outside the enum, so `advance`
  can no longer auto-complete a bogus phase. `nextPhase` and
  `gateFor`/`evaluateGate` are UNCHANGED pure functions — the frozen
  contract-fixture (`nextPhase("bogus") === "complete"`) and
  `coverage_test.ts`'s `gateFor`/`evaluateGate` bogus-phase assertions stay
  byte-behaviorally identical; the schema simply makes them unreachable from the
  public API. Trade-off: `abandon` on a corrupted record now also rejects
  (fail-closed, cannot rescue a corrupted record via abandon) — accepted for a
  LOW corruption-recovery path.
- **LB5 (LOW) — project-id allocation breaks past 999.** `parseProjectDir`'s
  regex and the `startProject` allowlist guard both widen `\d{3}` to `\d{3,}`
  (3-OR-MORE digits); `nextProjectDir`'s `padStart(3, "0")` is unchanged, so ids
  `<=999` keep their existing 3-digit zero-padding and ids `>=1000` widen
  naturally. The guard's character class still forbids `/`, `\`, `.`, so every
  LB1 traversal payload stays rejected; `ARTIFACT_RE` (artifact filename ids) is
  untouched and stays 3-digit.
- **LB6 (LOW/info) — `templates` vs `provisionTemplates` inventory divergence.**
  `templates` now additionally walks the bundled `templates/` directory (the
  same source `provisionTemplates` copies) and surfaces any file with no
  `TEMPLATE_MAP` command in a new defaulted `unmappedFiles: string[]` field on
  `TemplateCatalogSchema`, reconciling the two methods' inventories.
  `templateCount` and the `sizeBytes:0` missing-file behavior are unchanged.
- **LB7 (LOW/info) — symlinked artifacts silently skipped.**
  `listFilesRecursive` and `scanWorkspace` now resolve a symlink entry's target
  kind via `Deno.stat` — a symlinked artifact or project directory is
  inventoried like a real one (bounded by the existing depth cap). Write-safety
  cross-cut with LB1/LB2: `migrateClassification`'s apply branch `Deno.lstat`s
  before writing and skips (reason `"symlink"`, reusing the LB3 `skipped[]`
  field) rather than writing through a symlink to a target outside the
  workspace; report-only mode still reads through the symlink and proposes.

`extensions/models/arckit_workspace.ts`: all six fixes land in a single
consolidated ordered block inside `migrateClassification`'s per-file apply loop
(LB3 cap-check → read+propose → LB7 symlink skip / LB2 backup+atomic write),
plus the schema/regex/directory-walk changes above.
`manifest.yaml`/`model.version` bumped `2026.08.01.1` → `2026.08.02.1` in
lockstep. Added `upgrades[]` (previously absent on this model) with identity
`upgradeAttributes: (old) => old` entries — `maxFileBytes` is a defaulted global
arg and `skipped`/`unmappedFiles` are defaulted resource-schema arrays, so no
stored data needs transformation.

- `extensions/models/arckit_workspace_adversarial_test.ts`: flipped LB2
  (`:121`), LB4 (`:197`, `:221`), LB5 (`:251`), LB6 (`:270`), and LB7 (`:306`)
  from `pin (arckit-latent-bugs LBN, SEVERITY):`-titled current-behavior pins to
  `fix regression (arckit-latent-bugs LBN,
  SEVERITY):`-titled POST-fix
  assertions; relabeled the two LB3 500 KB pins from "no size cap" to "under the
  default 10 MiB cap, round-trips whole". Added: LB2 crash-safety (`.bak` + no
  `.tmp` orphan) and idempotent-second-run cases; LB3 oversize-skip cases for
  both `migrateClassification` and `template` (via a small overridden
  `maxFileBytes`); LB7 symlinked-directory and symlinked-artifact-write-skip
  cases.
- `extensions/models/arckit_workspace_coverage_test.ts`: flipped the LB5
  boundary pin (`:416`) to assert `parseProjectDir("1000-new")` now parses;
  relabeled the LB4 `gateFor`/`evaluateGate` reinforcement (`:406`, unchanged
  pure-function behavior) and the LB6 `templateCount` reinforcement (`:432`,
  extended with an `unmappedFiles` assertion for the three seeded orphans).
- `extensions/models/arckit_workspace_property_test.ts`: broadened property
  (c)'s `nextProjectDir`/`parseProjectDir` arbitrary from `<=998` to `<=9998`,
  verifying the monotonic + round-trip invariant ACROSS the former 999 boundary
  instead of excluding it; property (g) re-verified to still reach `complete`
  for every profile.
- `extensions/models/fixtures/workspace.ts`: widened `FakeContext.globalArgs` to
  `{ path: string; maxFileBytes?: number }` (additive/optional — every existing
  call site stays valid).
- Full `deno task check` / `test` / `fmt:check` / `lint` all green; property
  suite re-verified at `FC_NUM_RUNS=10000`. The four LB1 fix-regression pins and
  the frozen contract-fixture (`arckit_workspace_test.ts`) are unchanged and
  stay green.

## 2026.08.01.1

Security fix: `startProject`'s `dir` argument is no longer trusted verbatim.
Fixes **arckit-latent-bugs LB1 (HIGH)** — path traversal / arbitrary directory
creation — tracked in the LOCAL `arckit-latent-bugs` issue-lifecycle model
(NEVER filed to the swamp.club Lab). `parseProjectDir`'s regex `^(\d{3})-(.+)$`
lets the `(.+)` tail carry `/` and `..`, and the accepted `dir` used to flow
verbatim into `Deno.mkdir` under `projects/` and into `writeResource`'s instance
name, with zero sanitization — a dir like `001-a/../../../../<abs>/pwn` could
create a directory OUTSIDE the configured workspace root.

- `extensions/models/arckit_workspace.ts`: `startProject.execute` now rejects
  any `dir` not matching `/^\d{3}-[a-z0-9-]+$/` with a clear error, placed
  immediately after the existing `000`-reserved check and BEFORE
  `readProjectState`, `Deno.mkdir`, and `writeResource` — the guard precedes all
  three write-side sinks. `parseProjectDir` itself is UNCHANGED and stays
  permissive: it is the shared read-model parser used by `scanWorkspace` to
  inventory pre-existing on-disk directories, and tightening it there would
  regress that inventory and the LB5 (`>999`) boundary pin. The allowlist guard
  lives only in `startProject`, the sole write-side factory that turns caller
  input into a filesystem path plus a resource key.
- `extensions/models/arckit_workspace_adversarial_test.ts`: the two LB1
  acceptance pins (`dir: "001-a/../b"`, `dir: "002-nested/deep"`) are flipped
  from characterizing acceptance to fix-regression tests asserting rejection,
  nothing created on disk, and no `projectState` resource written. Added
  regression coverage: legit single-segment dirs (`001-payment-gateway`,
  `002-nested`) still succeed and create exactly `projects/<dir>`; synthetic
  traversal payloads (`001-a/../b`, `002-nested/deep`, `001-../../etc`,
  `001-x/../../../tmp/pwn`) are each rejected with nothing created and no
  resource written. All payloads are synthetic strings used only as REJECTED
  inputs, never written to disk, and every case runs inside its own
  `Deno.makeTempDir()`. LB2..LB7 pins in the same file are untouched.
- `manifest.yaml` / `model.version`: bumped `2026.07.16.2` → `2026.08.01.1` in
  lockstep — this is the first production change to `arckit_workspace.ts` since
  the `ext-quality-bf-arckit` backfill; it is no longer byte-frozen.
- `quality.yaml`: header comment updated to record this fix and drop the
  byte-frozen / no-bump language as it pertains to LB1.
- Full `deno task check` / `test` / `fmt:check` / `lint` all green; property
  suite re-verified at `FC_NUM_RUNS=5000`. LB2 (MEDIUM) and LB3..LB7 (LOW)
  remain deferred on the `arckit-latent-bugs` model — none share LB1's fix path.

Also folded into this release (previously recorded here as `Unreleased`, with no
version bump, since it was itself a byte-frozen characterization pass) -- the
test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4d, FINAL
batch of the extension-quality backfill program, `ext-quality-test-backfill`).
At authorship time it was NO behavior change -- `arckit_workspace.ts` (1487 LOC)
was byte-frozen and the model `version` stayed `2026.07.16.2` (`manifest.yaml`
also unchanged); the LB1 fix above is the change that finally moved the version,
so both land together in `2026.08.01.1`.

- Added `extensions/models/arckit_workspace_methods_test.ts` (methods),
  `arckit_workspace_adversarial_test.ts` (adversarial),
  `arckit_workspace_coverage_test.ts` (coverage), and
  `arckit_workspace_property_test.ts` (property-invariant-flow).
  `arckit_workspace_test.ts` (the pre-existing contract-fixture -- pure logic
  plus real-bundled-template presence) is UNCHANGED and keeps its role.
- Added `extensions/models/fixtures/workspace.ts` -- a shared, synthetic fixture
  builder used by the methods/adversarial/coverage/property suites:
  `withTempWorkspace()` creates TWO separate `Deno.makeTempDir()` roots per test
  (the governance workspace `root`, and a `templatesDir` standing in for the
  bundled `templates/` directory via a fake `context.extensionFile`),
  `makeCtx()` builds a fake runtime context (globalArgs + logger +
  writeResource + readResource + extensionFile), and small helpers
  (`writeArtifact`, `writeTemplateFile`, `docControlContent`, `arcFilename`)
  populate them. Real `Deno.mkdir`/`writeTextFile`/`readDir`/`symlink`
  throughout -- no FS stubbing. `templatesDir` is always separate from the real
  bundled `arckit/templates/` that `arckit_workspace_test.ts` (the
  contract-fixture) reads -- none of the four new suites ever touches the real
  bundled directory.
- 7 latent bugs discovered while characterizing are PINNED (characterized as
  CURRENT behavior, not fixed -- `arckit_workspace.ts` is byte-frozen by this
  change) and tracked in the LOCAL `arckit-latent-bugs` issue-lifecycle model
  (NEVER filed to the swamp.club Lab):
  1. **Path traversal / arbitrary directory creation via `startProject`'s `dir`
     (HIGH)** -- `parseProjectDir`'s regex `^(\d{3})-(.+)$` lets the `(.+)`
     group contain `/` and `..`, and the accepted `dir` flows verbatim into
     `Deno.mkdir` under `projects/` and into `writeResource`'s instance name,
     with zero sanitization. Pinned within a temp dir (`dir:
     "001-a/../b"`
     resolves to `projects/b`, never escaping the sandbox).
  2. **Non-atomic in-place overwrite + unbounded read in
     `migrateClassification apply=true` (MEDIUM)** -- each matched artifact is
     read whole via `Deno.readTextFile` (no size cap) then rewritten in place
     via `Deno.writeTextFile`, with no temp-then-rename and no backup.
  3. **Unbounded `readTextFile` in `template` / `migrateClassification` (LOW)**
     -- no size limit anywhere; a 500KB fixture round-trips whole in both
     suites, demonstrating the absence of a cap without a multi-GB file.
  4. **Non-enum `projectState.state` auto-completes an unknown-phase gate
     (LOW)** -- `ProjectStateSchema.state` is `z.string()`, not the `PHASES`
     enum; a corrupted/hand-edited/datastore-restored state value outside
     `PHASES` makes `gateFor` return `[]`, so `evaluateGate` is vacuously
     satisfied and `advance` jumps straight to `"complete"`. Not reachable via
     the public API (`startProject` only ever writes a valid phase); the
     adversarial suite seeds the corrupted state directly to pin it.
  5. **Project-id allocation boundary breaks past 999 (LOW)** --
     `nextProjectDir` returns a 4-digit id once the highest existing id is 999,
     which `parseProjectDir` then rejects, so `startProject` throws and no
     further project can be auto-allocated.
  6. **`templates` vs `provisionTemplates` inventory divergence (LOW/info)** --
     `templates` enumerates only the 61 `TEMPLATE_MAP` commands, while
     `provisionTemplates` copies EVERY bundled file; four real bundled templates
     (`data-source-profile-template.md`, `framework-overview-template.md`,
     `tech-note-template.md`, `vendor-scoring-template.md`) are provisioned but
     never surfaced by `templates`.
  7. **Symlinked artifacts silently skipped (LOW/info)** --
     `listFilesRecursive`/`scanWorkspace` count only entries where `isFile` or
     `isDirectory` is `true`; a symlink (both `false`) is silently ignored, so a
     symlinked `ARC-*` artifact never appears in
     `scan`/`gaps`/`migrateClassification`.

  A security-POSITIVE finding is also pinned: `template`'s `command` argument is
  map-gated (`TEMPLATE_MAP[args.command]`), so a path-traversing or unknown
  command throws `"No template"` before any file read is attempted -- unlike
  `startProject`'s `dir` (LB1), `template` never reaches the filesystem with
  unsanitized caller input.
- `deno.json`: `check` task widened from two explicit files to
  `extensions/models/*.ts` (type-checks transitively pull in
  `fixtures/workspace.ts`). `test` task widened to
  `--allow-read --allow-write --allow-env=FC_NUM_RUNS` (`--allow-write` is
  needed for the temp-dir workspace/templates fixtures the new suites write to;
  no `--allow-net`/`--allow-run` -- `arckit_workspace.ts` has no subprocess or
  network seam). Added `test:soak` for the high-count nightly property soak
  (`FC_NUM_RUNS=10000`).
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependency
  `npm:fast-check@4.8.0` (pinned exact version, per this repo's
  bundler-dependency rule) and its transitive `pure-rand`. Source dependencies
  (`npm:zod@4`) are unchanged.
- `quality.yaml`: all five required suites plus `docs.readme`/
  `docs.changelog`/`docs.skill` flip from `backlog` to `present` (`docs.skill`
  -> `.claude/skills/arckit/SKILL.md`, verified present). `watch`/`canary` stay
  `backlog` (seeded offender at CI-gate rollout, tracked in
  `ext-quality-test-backfill`). `ratchet` set to 100 / "Grade A" --
  `swamp extension quality arckit/manifest.yaml --json` reports
  `percentage: 100`, `status: "passed"` (arckit is SCORABLE; the seanime
  UNSCORABLE path does not apply). Removed `arckit` from `quality-allowlist.txt`
  in the same change (five-suite presence graduates it) -- the FINAL line
  removed from that file by the extension-quality backfill program (45
  extensions graduated).

## 2026.07.16.2

Initial release: a standalone swamp port of ArcKit (the Enterprise Architecture
Governance Harness) as a skill-driven state machine. No ArcKit Claude plugin and
no Python CLI required -- 65 bundled arc-kit templates plus a reimplementation
of the Python CLI's classification-migration behavior. `init` scaffolds a
workspace, `scan` inventories every project's `ARC-*` artifacts, `gaps` checks
the mandatory-dependency matrix, and the
`startProject`/`status`/`advance`/`skipPhase`/`abandon` state machine gates 12
governance phases (foundation through story) against artifacts actually on disk,
with `standard`/`uk-gov`/`mod`/`ai` profiles adding gate groups. Ships the
`arckit` skill for driving document production through the lifecycle.
