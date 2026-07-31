# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4d, FINAL
batch of the extension-quality backfill program, `ext-quality-test-backfill`).
No behavior change -- `arckit_workspace.ts` (1487 LOC) is byte-frozen and the
model `version` stays `2026.07.16.2` (`manifest.yaml` is also unchanged).

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
