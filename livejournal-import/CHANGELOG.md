# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4a child
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change -- `livejournal_import.ts` is byte-frozen and the model
`version` stays `2026.07.16.2` (manifest.yaml is also unchanged).

- Added `extensions/models/livejournal_import_test.ts` (contract-fixture),
  `livejournal_import_methods_test.ts` (methods),
  `livejournal_import_adversarial_test.ts` (adversarial),
  `livejournal_import_coverage_test.ts` (coverage), and
  `livejournal_import_property_test.ts` (property-invariant-flow) -- 0 tests
  before this change, 53 after (14 + 22 + 9 + 6 + 2, contract-fixture split as
  2/adversarial 14/coverage 22/methods 9/property 6).
- Added `fixtures/` -- 8 synthetic HTML pages (`index`, `index_paginated`,
  `index_empty`, `post_full`, `post_ssrf`, `post_injection`, `post_bad_date`,
  `post_bad_comments`) plus `PROVENANCE.md`. No live call was made against any
  real LiveJournal blog while authoring these fixtures; every value is
  synthetic (RFC 2606 `.example.com` hosts, RFC 5737-adjacent addresses for
  the SSRF pin target, `Fixture`/`fixture-`-prefixed names, invented post
  ids/dates/comments).
- Every test drives `model.methods.import.execute()` against a stubbed
  `globalThis.fetch` (index/post HTML fetch + raw image binary fetch) and a
  stubbed `Deno.Command`/`Deno.mkdir`/`Deno.writeFile` (the `obsidian` CLI
  seam and the vault-attachment disk writes) -- `collectPostUrls`, `parsePost`,
  `htmlToMarkdown`, `parseLjDate`, `sanitize`, `runObsidian`, and
  `getVaultPath` are module-private, so the single `import` method is the only
  reachable seam. HTML fixtures are parsed with the REAL `cheerio@1.0.0` the
  model itself uses, never a stubbed DOM. Deno stubs are installed via
  `(globalThis as any).Deno.X = ...` (deno-lint-ignored) and restored in a
  `finally` block, so the suite needs no `--allow-write`/`--allow-run`.
- 8 already-shipped latent bugs are PINNED (characterized as CURRENT behavior,
  not fixed -- `livejournal_import.ts` is byte-frozen by this change) and
  tracked in the LOCAL `livejournal-import-latent-bugs` issue-lifecycle model
  (NEVER filed to the swamp.club Lab):
  1. **SSRF via image `src` (HIGH)** -- the `<img src>`/wrapped-link image
     URLs pass only a denylist (`l-stat.livejournal.net`/`userpic`/
     `stat.livejournal`/`pixel`/`spacer`) before `fetch(imgUrl)` writes the
     response straight to the vault; a link-local or loopback target
     (`169.254.169.254`, `127.0.0.1:8200`) is reached exactly like a real
     image host.
  2. **YAML frontmatter injection via unescaped newlines (MEDIUM)** --
     `title`/`mood`/`now_playing`/tag frontmatter values escape only `"`
     (`.replace(/"/g, '\\"')`), never embedded newlines; a raw `\n` inside any
     of those fields breaks the YAML block scalar and can inject a sibling
     key into the frontmatter.
  3. **Silent-empty success (MEDIUM)** -- `collectPostUrls` returning `[]`
     (e.g. an index page with zero matching post links) resolves as an
     ordinary `"Import complete: 0 notes, 0 images. Errors: 0"` success, with
     no distinct warning that nothing was found.
  4. **No fetch/subprocess timeout (MEDIUM)** -- neither `fetchWithRetry` nor
     the raw image `fetch` pass an `AbortSignal`/timeout, and the `obsidian`
     `Deno.Command` invocations carry no timeout option either; a hung
     upstream or a hung CLI process blocks the run (and the model's lock)
     indefinitely.
  5. **Unbounded pagination/memory (MEDIUM)** -- `collectPostUrls`'s
     `skip += 10` loop has no page cap; it keeps paging for as long as the
     server keeps advertising a `skip=N` marker and new post ids, with no
     upper bound on requests or accumulated URLs.
  6. **Fragile comment-JSON extraction (LOW)** -- the `Site.page = {...};`
     comments blob is located with a regex requiring a `};` +
     whitespace terminator, then `JSON.parse`d inside an empty `catch`; a
     corrupted or truncated blob silently drops ALL comments with no error
     surfaced.
  7. **Operator `folder` path traversal on disk write (LOW)** -- the
     `folder` global argument is concatenated directly into the vault
     attachment disk path (`${vaultPath}/${folder}/${attachmentsFolder}`)
     with no `..`-segment guard; a misconfigured `folder` value escapes the
     intended vault subtree (characterized against a synthetic escape target
     only).
  8. **`parseLjDate` silent fallthrough (LOW)** -- a date string not matching
     the expected `"Month D YYYY, HH:MM"` shape is returned UNCHANGED; the raw
     text then flows unquoted into the frontmatter `date:` line and
     (un-sanitized, unlike the title) into the note's slug/path.
- `deno.json`: `test` task widened to `--allow-read --allow-env` (unscoped
  env access, a deliberate deviation from the `bandcamp`/`porkbun` precedent's
  `--allow-env=FC_NUM_RUNS`) -- `cheerio@1.0.0`'s transitive `undici`
  dependency (used only by cheerio's unused `fromURL` convenience helper)
  probes several different `process.env` keys (`NODE_V8_COVERAGE`,
  `UNDICI_NO_FG`, `JEST_WORKER_ID`, ...) eagerly at module-import time; since
  `livejournal_import.ts` is byte-frozen, this cannot be avoided by swapping
  parsers, so the test task grants full env-read instead of chasing each key
  individually. No `--allow-net` is granted -- the fetch boundary is always
  stubbed. Added `test:soak` for the high-count nightly property soak.
  `fmt.exclude` lists `post_full.html`, `post_bad_comments.html`, and
  `post_injection.html` -- the first two carry the single-line `Site.page`
  blob the `};`+whitespace terminator regex depends on, and the third carries
  deliberately-embedded raw newlines the LB2 pin depends on; `deno fmt`'s HTML
  formatter collapses internal whitespace runs (including real newlines) when
  it re-wraps text for line width, which would silently defeat either pin.
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependencies
  (`jsr:@std/assert@1`, `jsr:@std/testing@1`, `npm:fast-check@4.8.0`). Source
  dependencies (`npm:zod@4`, `npm:cheerio@1.0.0`, `npm:domhandler@5.0.3`) are
  unchanged -- the lock delta carries no runtime/behavior implication
  whatsoever.
- `quality.yaml`: all five required suites plus `docs.readme`/
  `docs.changelog` flip from `backlog` to `present`; `docs.skill` recorded
  `na` (livejournal-import bundles no Claude skill -- a blog-export
  importer, nothing to document as a skill). `watch`/`canary` stay `backlog`
  (seeded offender at CI-gate rollout, tracked in `ext-quality-test-backfill`).
  `ratchet` set UNSCORABLE (seanime/telegram-import precedent): `swamp
  extension quality manifest.yaml --json` errors on this extension's
  pre-existing broken model upgrade chain (model version `2026.07.16.2`, but
  `upgrades[]` only spans `2026.03.28.1 -> 2026.03.28.2 -> 2026.03.29.1`,
  never reaching current) -- predates this backfill, and the source is
  byte-frozen here so the chain cannot be repaired in this change.
  Removed from `quality-allowlist.txt` in the same change (five-suite
  presence graduates it, same as seanime).

## 2026.07.16.2

Initial release: import a LiveJournal blog into an Obsidian vault by walking
the public `?format=light` journal index, fetching every entry, converting
the post HTML to Markdown, downloading inline images as vault attachments,
and writing one Markdown note per post with YAML frontmatter (title, date,
source URL, LiveJournal post id, tags, and when present, mood and
now-playing). Reader comments are extracted from the entry page's embedded
`Site.page` JSON and appended under a Comments section. Relies on the local
`obsidian` CLI to resolve the vault path and create notes.
