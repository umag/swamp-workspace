# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4a child
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `telegram_import.ts` is byte-frozen; the model `version` stays
`2026.07.16.2` and `manifest.yaml` is unchanged (no version bump).

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
