# Changelog

## 2026.08.01.2

Adds an optional headless `vaultRoot` filesystem backend to `import`, so the
import can run with the Obsidian desktop app closed (swamp-workspace #57;
mirrors the CLI/filesystem backend split done for `@magistr/obsidian-vault` in
PR #56 — see that PR for the path-confinement rationale). The Obsidian CLI
(`getVaultPath` + `runObsidian("create", ...)`) is kept as the fallback for when
`vaultRoot` is not set. Cross-reference: swamp-workspace#57.

- Added the `vaultRoot` global argument. When set, the vault path resolves to it
  directly (skipping the `obsidian vault ... info=path` CLI call), and the note
  is written with a confined atomic write instead of
  `runObsidian("create", ...)`.
- Added `resolveVaultPath`/`resolveVaultPathSafe` (realpath + symlink refusal
  - `..` rejection) and the atomic-write helpers (`writeAtomic`,
    `ensureParentDir`, `chmodQuietly`), copied VERBATIM (same names/comments,
    per the approved plan's scope constraint against a shared cross-extension
    module — swamp bundles each extension independently) from
    `obsidian-vault/extensions/models/obsidian_vault.ts` (PR #56). The note
    write now resolves through `resolveVaultPathSafe` before every
    `mkdir`/write, closing folder-traversal and symlink-escape vectors on the
    new headless path (the CLI fallback is untouched and keeps whatever behavior
    it already had).
- **Upgraded `isPathContained`/`safeCopyMedia` (LB-1's extractDir confinement)
  from lexical-only to realpath-aware**: after the existing lexical containment
  check passes, every existing path segment between `extractDir`'s realpath and
  the candidate is walked with `Deno.lstat`, refusing to follow a symlink —
  closing the "symlink created inside extractDir that points outside it"
  residual the 2026.08.01.1 CHANGELOG entry documented as accepted. A segment
  that does not exist yet is not an error, same as before.
- No `npm:yaml` dependency was added — this model emits brand-new hand-built
  frontmatter into notes it owns, it never round-trips existing frontmatter, so
  PR #56's yaml-`Document` rationale does not apply here. Every hand-built
  frontmatter string stays byte-for-byte identical to before this change.
- Dot-dir/`.trash` exclusion is N/A: `import` writes into a caller-named folder,
  it never walks the vault tree (covered by a covered-negative test in the
  adversarial suite).
- **Real-world behavior note**: writing the note directly via
  `Deno.writeTextFile` (through the new atomic-write helper) may not be
  byte-identical to what the real Obsidian CLI's `create` command would have
  produced on disk — the CLI has never been observed to differ in this repo's
  tests (it's always stubbed), but a real `obsidian create` call could in
  principle normalize a trailing newline differently than a raw
  `Deno.writeTextFile`. Not reproduced or fixed here, just flagged.
- Extended all five test suites (contract-fixture, methods, adversarial,
  coverage, property-invariant-flow) with `vaultRoot` coverage: a golden
  fs-backend run against `fixtures/basic/result.json`, a method-level test
  proving the CLI is never invoked when `vaultRoot` is set (`Deno.Command`
  stubbed to throw on `"obsidian"`), a backend-selection precedence branch
  matrix, path-confinement adversarial tests (`..` traversal and symlinked
  folder segment refused, `/var`-vs-`/private/var` real-root containment), and a
  property test asserting exactly one note per message with frontmatter
  round-trip and no path escaping the vault's real root, for any synthetic set
  of messages with unique ids. `telegram_import_test_helpers.ts` gained two new
  `StubConfig` options (`realMkdir`, `throwOnObsidian`) so these new tests can
  let `Deno.mkdir` run for real against a real `Deno.makeTempDir` vault while
  keeping `Deno.Command`/`copyFile` stubbed. No new committed fixture files were
  needed.
- `manifest.yaml`/model `version`: `2026.08.01.1` -> `2026.08.01.2`.

## 2026.08.01.1

Fix for latent bug **LB-1 (path-traversal via export photo/file/video path,
HIGH)** plus a model upgrade-chain repair (**LB-0**), both tracked in the LOCAL
`telegram-import-latent-bugs` issue-lifecycle model (NEVER filed to the
swamp.club Lab — see CLAUDE.md's anti-bypass rule). `model.version` and
`manifest.yaml` both bump `2026.07.16.2` -> `2026.08.01.1`.

- **Path-traversal fix (LB-1, HIGH)**: added
  `isPathContained(base,
  candidate)`, a posix-normalize path-containment guard
  — both `base` (`extractDir`) and `candidate` (a computed media source path)
  are normalized with `jsr:@std/path@1/posix`'s `normalize` (collapsing `..`/`.`
  segments and redundant slashes) BEFORE the containment check runs, and the
  prefix compare requires a trailing separator (or exact equality) so a sibling
  directory that merely shares `base` as a string prefix (e.g. base `/tmp/x`
  wrongly accepting candidate `/tmp/xy/evil`) can never be mistaken for
  containment. Wired into a new `safeCopyMedia` helper applied IDENTICALLY at
  all three `Deno.copyFile` sites (photo, file, video) — extracting one shared
  helper (rather than inlining the check three times) avoids the drift risk of
  three near-identical copies, and in particular keeps the file branch's
  `_thumb.jpg` skip running BEFORE the containment check, so thumbnails still
  stay silently skipped and only true escapes record an error. On an escaping
  source, the copy is skipped and an `errors[]` entry is recorded (same shape as
  the pre-existing per-item copy-failure catch) — the note for that message is
  still created either way; import continues to the next message.
- **Accepted residual**: this is lexical normalization only, not a `realpath` —
  a symlink created INSIDE `extractDir` that points outside it would still let
  `copyFile` read outside even after the containment check passes. Low risk here
  since extraction uses `unzip`, which does not create symlinks by default, and
  the attacker controls only the zip contents.
- **Accepted incidental behavior, pinned by a test**: an absolute-looking
  `msg.photo` (e.g. `/etc/passwd`) is joined as
  `extractDir + "/" +
  msg.photo`, a plain string concatenation, so it
  normalizes to a path INSIDE `extractDir` rather than jumping to a real
  filesystem root — safe, and now pinned so it stays intentional rather than
  incidental.
- **Upgrade-chain repair (LB-0)**: `model.upgrades[]` previously ended at
  `2026.03.28.2` while `model.version` was already `2026.07.16.2`, so
  `swamp extension quality` errored on the broken chain instead of scoring the
  extension. Added two identity lineage-repair bridge entries
  (`2026.03.28.2 -> 2026.05.25.1 -> 2026.07.16.2`,
  `upgradeAttributes: (old)
  => old`, no resource schema change) plus the new
  `2026.07.16.2 ->
  2026.08.01.1` entry, so the chain is continuous and its
  final `toVersion` equals `model.version`.
- **Quality ratchet un-frozen**: with the chain repaired,
  `swamp extension
  quality manifest.yaml --json` now emits a real score (14/14
  points, 100%, `allPassed: true`, `dependencyTrust` passed) instead of
  erroring. `quality.yaml`'s `ratchet` is restamped from that tool output:
  `baselinePercentage: 0` / UNSCORABLE -> `baselinePercentage: 100` / Grade A.
- **Tests**: the LB-1 pin in `telegram_import_adversarial_test.ts` is flipped
  from "the escape src reaches `Deno.copyFile` verbatim" to a fix-regression
  test asserting rejection — no escaping `copyInvocation`, an `errors[]` entry
  records it, and the note for that message is still created (via the captured
  `obsidian create` call). Added regression pins: dedicated escape-rejection
  tests for the FILE and VIDEO copy sites (not just photo, since all three share
  `safeCopyMedia`), a sibling-prefix false-accept probe (a source under
  `<extractDir-basename>-evil`, pinning the trailing-separator requirement found
  during test review), the three legit relative media sources from
  `fixtures/basic/result.json` (`photos/photo_4@2x.jpg`,
  `files/fixture_report.pdf`, `video_files/fixture_clip.mp4`, msg ids 4/5/6)
  still reaching `Deno.copyFile` byte-exact and unchanged, and the absolute-path
  incidental-containment pin. LB-2 through LB-9 pins in the same file are
  untouched and stay green — the guard does not touch their code paths.
  `telegram_import_contract_test.ts`'s static-contract test is updated to assert
  the new `model.version`.
- **Dependency**: `jsr:@std/path@1` (subpath import `jsr:@std/path@1/posix`) is
  a new direct dependency, now in `deno.lock` (previously only a transitive
  dependency of the test toolchain). Passes the quality ratchet's
  `dependency-trust` factor (audited clean).
- Full `deno task check` / `test` / `fmt:check` / `lint` all green; property
  suite re-verified at `FC_NUM_RUNS=5000`. LB-2 (MEDIUM), LB-3 (MEDIUM), and
  LB-4..LB-9 (MEDIUM/LOW) remain deferred on the `telegram-import-latent-bugs`
  model — none share LB-1's fix path.

## Unreleased (folded into 2026.08.01.1 above)

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4a child
of the extension-quality backfill program, `ext-quality-test-backfill`). At
authorship time this was NO behavior change — `telegram_import.ts` was
byte-frozen and the model `version` stayed `2026.07.16.2` (`manifest.yaml` was
also unchanged, no version bump); the LB-1/LB-0 fix above is the change that
finally moved the version, so both land together in `2026.08.01.1`.

- Added `extensions/models/telegram_import_test_helpers.ts` — a shared harness:
  a fake ctx (globalArgs, tagged-template-safe logger, capturing
  `writeResource`), a method runner mirroring the swamp runtime's
  schema-parse-then-execute sequence, and a full stub seam for
  `Deno.Command`/`copyFile`/`mkdir`/`makeTempDir`/`remove` (no real subprocess,
  no real file copy, no real directory ever touched by the system under test).
  The one real filesystem call anywhere in the suite — `Deno.readTextFile` —
  reads a harness-owned scratch `result.json` written with Deno primitives
  captured _before_ any stubbing.
- Added `extensions/models/telegram_import_contract_test.ts` (contract-fixture)
  — the static contract (model type/version, `GlobalArgsSchema` required
  fields + defaults, exact one-method list) plus a golden pipeline run over
  `fixtures/basic/result.json` under FakeTime: exact `result` summary counts and
  a byte-exact rendered note for message id 2.
- Added `extensions/models/telegram_import_methods_test.ts` (methods) —
  branch-by-branch coverage of the single `import` method: the service-message
  filter, photo/file/`_thumb`-skip/video handling, forwarded/reply frontmatter,
  the obsidian `create` argv shape (and the finding that `noteKey` is always
  `"path"`, never `"name"`, because `folder`/`slug` are joined with a literal
  `/`), and `errors[]` accumulation across independent photo/file/create
  failures.
- Added `extensions/models/telegram_import_adversarial_test.ts` (adversarial,
  new) — pins nine found latent bugs (characterized, NOT fixed — tracked in the
  LOCAL `telegram-import-latent-bugs` issue-lifecycle model, never filed to the
  Lab):
  1. **LB-1** (HIGH) — `msg.photo` escaping `extractDir` (e.g.
     `../../../../etc/hostname`) reaches `Deno.copyFile` verbatim, with no
     path-containment check.
  2. **LB-2** (MEDIUM) — a crafted string `msg.id` containing `../` segments
     propagates unsanitized into the obsidian `create path=` argument via
     `noteSlug`'s `${date}-${msg.id}` interpolation.
  3. **LB-3** (MEDIUM) — `forwarded_from` and the channel `name` are
     interpolated into YAML frontmatter with no quote-escaping or
     newline-stripping — an embedded `"` plus YAML mapping syntax breaks out of
     the frontmatter block unescaped.
  4. **LB-4** (MEDIUM) — one malformed message (e.g. a non-string `date`) throws
     INSIDE the per-message loop and rejects the entire `import` call; the final
     `result` summary is never written, though posts already processed before
     the throw keep their own resource writes.
  5. **LB-5** (MEDIUM) — the top-level export shape is never validated: a
     missing `messages` array throws a raw `TypeError`, and a missing `name`
     silently renders the literal string `"undefined"` into every note's
     `channel` frontmatter line instead of failing loudly.
  6. **LB-6** (LOW) — `find`'s subprocess `success`/`code` is never inspected
     (only its `stdout` matters), so a genuinely failing `find` is
     indistinguishable from an empty match; there is also no subprocess timeout
     anywhere in the pipeline (not reproduced as an actual hang).
  7. **LB-7** (LOW) — `text.substring(0, 500)` can cut a UTF-16 surrogate pair
     in half, leaving a lone (unpaired) high surrogate at the end of the
     truncated `post.text`.
  8. **LB-8** (LOW) — `JSON.parse` on the export's `result.json` has no size
     guard of any kind.
  9. **LB-9** (LOW) — command-injection is CLOSED (every `Deno.Command` call
     passes an argv array, never a shell string), but a `zipPath` beginning with
     `-` is passed through verbatim as unzip's second argv element —
     positionally ambiguous with a real `unzip` binary, though never
     shell-interpreted.
- Added `extensions/models/telegram_import_coverage_test.ts` (coverage, new) —
  the remaining branches of the module-private
  `telegramTextToMarkdown`/`noteSlug` helpers (every `text_entities` type incl.
  `mention`/`hashtag`/`email`/`phone`/an unknown future type, a bare string
  array item, a non-object/non-string array item, the `pre` fenced-code-block
  entity, `link` vs `text_link`), a date with no `T` separator, and the
  fully-minimal message (none of
  photo/file/forwarded_from/reply_to_message_id/media_type set).
- Added `extensions/models/telegram_import_property_test.ts`
  (property-invariant-flow, new) — `fast-check@4.8.0`, `FC_NUM_RUNS`-gated,
  under FakeTime: message-count, id-preservation, the 500-char truncation
  invariant, the `Telegram/<dateOnly>-<id>` slug-format invariant, and a
  re-import idempotency property (running `import` twice over the same input
  yields an identical summary and identical posts).
- Added `fixtures/` — three synthetic `result.json` exports (`basic`,
  `malicious`, `edge`) plus `PROVENANCE.md`. Every value is invented; no real
  Telegram usernames, user IDs, phone numbers, channel names, or media filenames
  tied to real people appear anywhere in the corpus, and no binary media files
  exist anywhere in the corpus — `Deno.copyFile` is always stubbed, so no media
  path is ever actually opened.
- `deno.json`: `test` task now scopes to
  `--allow-read --allow-write --allow-env=FC_NUM_RUNS` (read for module +
  fixture reads, write for the harness's own scratch `result.json`, no
  `--allow-net` and no real subprocess access anywhere); `check` now covers
  every file under `extensions/models/`; added `test:soak` for the high-count
  nightly property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` is `na` (telegram-import
  bundles no Claude skill). Ratchet is **UNSCORABLE** (rubricVersion 3,
  baselinePercentage 0) — `swamp extension quality` errors on
  telegram_import.ts's broken model-upgrade chain (declared version
  `2026.07.16.2`, but the only declared `upgrades[]` entry ends at
  `2026.03.28.2`), predating this backfill and out of scope for a byte-frozen
  change (`ext-quality-bf-seanime` precedent). Tracked as LB-0 in
  `telegram-import-latent-bugs`. Removed from `quality-allowlist.txt` in the
  same change — five-suite presence graduates it, per the seanime precedent,
  regardless of the unscorable ratchet.
