# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.2

Real fixes for the six remaining latent bugs tracked in the LOCAL
`livejournal-import-latent-bugs` issue-lifecycle model (NEVER filed to the
swamp.club Lab -- see CLAUDE.md's anti-bypass rule): **LB2** (YAML frontmatter
injection), **LB3** (silent-empty success), **LB4** (no fetch/subprocess
timeout), **LB5** (unbounded pagination), **LB6** (fragile comment-JSON
extraction), and **LB8** (`parseLjDate` silent fallthrough). `model.version` and
`manifest.yaml` both bump `2026.08.02.1` -> `2026.08.02.2`. LB1 (SSRF, fixed in
`2026.07.31.1`) and LB7 (path traversal, fixed in `2026.08.02.1`) are untouched.

- **Two new backward-compatible global arguments**: `timeoutMs` (default
  `30000`) and `maxPages` (default `1000`), both `.default(...)`-ed in
  `GlobalArgsSchema` and re-defaulted at the JS destructuring site in `import`'s
  `execute` (so an existing instance, or any caller that hands the method raw
  global args without going through the zod schema, behaves identically unless
  one is set explicitly). Neither is a resource attribute, so the appended
  `upgrades[]` entry is an identity (`upgradeAttributes: (old) => old`).
- **LB2 fix (YAML frontmatter injection via unescaped newlines, MEDIUM)**: a new
  `yamlEscape(s)` helper escapes backslash, `"`, `\n`, `\r`, and other C0
  control characters (not just `"` as before) in `title`/`mood`/`now_playing`/
  each tag's INNER frontmatter content -- the surrounding `"…"` quoting is
  unchanged, so benign input (no backslash/control chars) still produces
  byte-identical frontmatter. A raw embedded newline in any of those fields can
  no longer inject a sibling YAML key into the frontmatter.
- **LB3 fix (silent-empty success, MEDIUM)**: `import` now logs a distinct "no
  posts found" warning when `collectPostUrls` returns zero URLs, instead of this
  reading as an ordinary success with no signal that something may be wrong.
  Logger-only -- `result.errors` stays `[]`.
- **LB4 fix (no fetch/subprocess timeout, MEDIUM)**: every `fetch` call
  (index/post fetch via `fetchWithRetry`, image fetch via `fetchImageSafely`)
  and both `Deno.Command` invocations (`runObsidian`, `getVaultPath`) now carry
  a `timeoutMs`-bounded `AbortController`/`signal`, always `clearTimeout`-ed in
  a `finally` block. A manual `setTimeout`/`clearTimeout` pair is used
  deliberately instead of `AbortSignal.timeout()`, which leaves a pending
  internal timer the op-sanitizer flags and interacts badly with
  `@std/testing`'s `FakeTime`. `fetchImageSafely` keeps `redirect: "manual"`
  alongside the new `signal` -- both are required, neither drops the other.
- **LB5 fix (unbounded pagination/memory, MEDIUM)**: `collectPostUrls` now stops
  after `maxPages` index pages (checked before each fetch, so exactly `maxPages`
  pages are fetched, not one more) and logs a distinct cap-warning when the
  limit is hit.
- **LB6 fix (fragile comment-JSON extraction, LOW)**: the `Site.page = {...}`
  blob is now located with `extractSitePageJson`, a string-aware balanced-brace
  scan (tracking JSON string/escape state) instead of a regex requiring a
  literal `};` + whitespace terminator -- a minified, semicolon-less blob
  (`Site.page={...}</script>`) that the old regex silently dropped now parses
  correctly. `parsePost` returns a new `commentParseFailed` flag (stays
  pure/logger-free) set whenever a `Site.page` marker was present but comments
  could not be recovered from it (unterminated/unbalanced object, or a genuine
  `JSON.parse` failure); the caller logs a distinct warning when it is set. No
  `Site.page` marker at all (an ordinary page with no comments) is not a
  failure.
- **LB8 fix (`parseLjDate` silent fallthrough, LOW)**: a date string not
  matching the expected shape now resolves to a module-level sentinel,
  `"unknown"` (colon-free and space-free, so it stays valid unquoted YAML and
  slug-safe), instead of the raw text passing through unchanged. The caller logs
  a distinct warning when the sentinel is hit. `PostSchema.date` is a required
  `z.string()`, so the sentinel is a mandatory replacement value, not an
  omission. Valid dates are completely unaffected -- byte-identical to before.
- **Byte-stability guarantee for benign input**: none of the six fixes change
  output for well-formed input. `yamlEscape` is byte-identical to the old
  `.replace(/"/g, '\\"')` when the input has no backslash/control character;
  `extractSitePageJson` extracts the identical substring the old regex did for
  every well-formed fixture in this repo; valid dates parse identically; the
  default `timeoutMs`/`maxPages` are far above anything any existing test or
  real journal would ever hit.
- **Tests**: all six LB pins in `livejournal_import_adversarial_test.ts` flip
  from characterizing the bug to asserting the fix (title suffixed `-- FIXED`),
  reusing the existing fixtures (`post_injection.html`, `index_empty.html`,
  `post_full.html`, `post_bad_date.html`, `post_bad_comments.html`). New
  adversarial coverage: an `isAllowedImageHost` keys-list update
  (`timeoutMs`/`maxPages` added to the credential-leak covered-negative's
  expected key set), a `signal instanceof AbortSignal` regression test with a
  tiny `timeoutMs` and a never-resolving image fetch (per-post error recorded,
  no crash), and a `maxPages: 3` pagination-cap test against the existing
  12-page harness. The LB2 pin now parses the captured note's frontmatter with
  `jsr:@std/yaml` and asserts the injected sibling keys (`and`, `injected`) are
  absent and `title` round-trips. `livejournal_import_coverage_test.ts` gains
  one new positive-case test (a semicolon-less minified `Site.page` blob now
  extracts comments). LB1/LB7 pins are untouched and stay green;
  contract-fixture, methods, and property suites are unmodified and stay green
  (soak-verified at `FC_NUM_RUNS=10000`).
- Added an identity `upgrades[]` entry (`2026.08.02.1 -> 2026.08.02.2`,
  `upgradeAttributes: (old) => old`, no resource schema change).
- `deno.lock`: gains the TEST-ONLY dev dependency `jsr:@std/yaml@1` (resolved
  `1.0.10`, matching the version already pinned in this workspace's
  `talm-cluster` extension). Source dependencies (`npm:zod@4`,
  `npm:cheerio@1.0.0`, `npm:domhandler@5.0.3`) are unchanged.
- `manifest.yaml`/model `version`: `2026.08.02.1` -> `2026.08.02.2`.

## 2026.08.02.1

Fix for latent bug LB7 (operator `folder`/`attachmentsFolder` path traversal on
the attachment disk write, LOW) tracked in the LOCAL
`livejournal-import-latent-bugs` issue-lifecycle model (NEVER filed to the
swamp.club Lab -- see CLAUDE.md's anti-bypass rule). `model.version` and
`manifest.yaml` both bump `2026.08.01.1` -> `2026.08.02.1`.

- **LB7 fix**: the attachment disk path (`attachDiskPath`, used for the
  attachments-folder `mkdir` and every downloaded image's `writeFile`) is now
  resolved through the already-copied string-level `resolveVaultPath` before the
  post loop, instead of being built with a raw template-string concatenation
  (`` `${vaultPath}/${folder}/${attachmentsFolder}` ``). A
  `folder`/`attachmentsFolder` containing `..` segments or an absolute path now
  rejects the whole run fast with `"Path escapes vault root"` /
  `"Path is outside vault root"`, instead of silently landing outside the vault.
- **Both branches are fixed**: `vaultPath` is `vaultRoot || getVaultPath(vault)`
  and is non-empty in either case, so the same guard covers the CLI-fallback
  branch (no `vaultRoot` set) and the headless `vaultRoot` filesystem branch
  added in `2026.08.01.1`.
- **Deliberately `resolveVaultPath`, not `resolveVaultPathSafe`**: the
  attachment path check is string-level only (no `Deno.realPath`/`lstat`),
  matching the CLI-fallback branch's semantics where the vault directory need
  not already exist on disk, and keeping the byte-identical
  `"/fixture/vault/LiveJournal/attachments"` contract in the fixture-based test
  suites frozen. A malicious symlinked `folder` path segment is still not caught
  on the attachment side (only the note write's `resolveVaultPathSafe` catches
  that) -- unchanged from before this fix, and out of LB7's scope (LB7 is
  specifically about `..`/absolute traversal, not symlink-following).
- **Fail-fast semantics**: because the guard runs before the post loop and
  outside any per-post `try`, a hostile `folder`/`attachmentsFolder` now aborts
  the entire `import` run (the method's promise rejects) rather than recording a
  soft per-post error. No `result` resource is written in that case -- this is a
  deliberate, documented difference from the per-post error-accumulation
  behavior elsewhere in this model.
- Adversarial suite: the two LB7 pins are flipped from characterizing the
  traversal to asserting rejection (`assertRejects` on
  `"Path escapes vault root"` for the CLI-fallback branch, and on the vaultRoot
  branch's `../escaped` regression case from `2026.08.01.1`, now additionally
  asserting the escaped directory never gets created at all -- a non-vacuous
  proof the guard fires before `Deno.mkdir`). Two new absolute-path variants
  (`"/etc/lj-escape"`-shaped) were added, one per branch, so both the
  CLI-fallback and vaultRoot branches are exercised against both traversal
  shapes (`..`-relative and absolute).
- Coverage suite: added a benign-nested-folder regression (`folder:"sub/dir"`)
  proving a multi-segment, non-traversal `folder` still works end-to-end
  (attachments directory created, note written) -- guards against an over-broad
  fix that would reject every multi-segment folder rather than just
  `..`/absolute escapes.
- The other 7 latent bugs tracked in `livejournal-import-latent-bugs` (LB1 SSRF
  -- already fixed in `2026.07.31.1`; LB2 YAML-newline-injection, LB3
  silent-empty, LB4 no-timeout, LB5 unbounded-pagination, LB6 fragile
  comment-JSON, LB8 parseLjDate-fallthrough) are untouched -- their pins still
  assert current behavior.
- Added an identity `upgrades[]` entry (`2026.08.01.1 -> 2026.08.02.1`,
  `upgradeAttributes: (old) => old`, no resource schema change) -- keeps the
  model-upgrade chain continuous with `final toVersion === model.version`.
- `manifest.yaml`/model `version`: `2026.08.01.1` -> `2026.08.02.1`.

## 2026.08.01.1

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
    new headless path.
- **This guard is scoped to the note write ONLY**: LB7 (folder path traversal on
  the `attachDiskPath` mkdir + image write, LOW, tracked in the local
  `livejournal-import-latent-bugs` model) is UNCHANGED and remains pinned for
  both the CLI branch and the new vaultRoot branch — a malicious `folder` global
  argument still lets `Deno.mkdir`/`Deno.writeFile` land outside the vault for
  attachments, even when vaultRoot is set. Only the note itself is now confined.
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
  coverage, property-invariant-flow) with `vaultRoot` coverage: method-level
  tests proving the CLI is never invoked when `vaultRoot` is set (`Deno.Command`
  stubbed to throw on `"obsidian"`) and that bytes match the CLI branch exactly,
  a backend-selection precedence branch matrix, path-confinement adversarial
  tests (`..` traversal and symlinked folder segment refused,
  `/var`-vs-`/private/var` real-root containment, plus an explicit regression
  pin that LB7's attachment-mkdir traversal is UNCHANGED), and a property test
  asserting exactly one note per generated post with frontmatter round-trip and
  no path escaping the vault's real root. No new fixture files were needed.
- `deno.json`: `test`/`test:soak` tasks gain `--allow-write` (previously
  `--allow-read --allow-env` only) so the new fs-write tests can run.
- Added an identity `upgrades[]` entry (`2026.07.31.1 -> 2026.08.01.1`,
  `upgradeAttributes: (old) => old`, no resource schema change) — required so
  the model-upgrade chain stays continuous with
  `final toVersion ===
  model.version`, per this repo's ratchet-label
  convention.
- `manifest.yaml`/model `version`: `2026.07.31.1` -> `2026.08.01.1`.

## 2026.07.31.1

Fix for latent bug LB1 (SSRF via image `src`, HIGH) tracked in the LOCAL
`livejournal-import-latent-bugs` issue-lifecycle model (NEVER filed to the
swamp.club Lab -- see CLAUDE.md's anti-bypass rule), plus a model upgrade-chain
repair and a quality-ratchet un-freeze. `model.version` and `manifest.yaml` both
bump `2026.07.16.2` -> `2026.07.31.1`.

- **SSRF fix**: added `isAllowedImageHost(imageUrl, journalUrl)`, a pure
  allowlist predicate replacing the old denylist-only filtering. An image URL is
  fetched only if it uses `http(s)`, is NOT an IP-literal host
  (dotted-decimal/decimal/hex IPv4, and any IPv6 form including compressed and
  IPv4-mapped -- `new URL().hostname` normalization is relied on, not substring
  matching), and its host is either a known LiveJournal media CDN
  (`*.livejournal.com`/`*.livejournal.net`, suffix-anchored) or shares the
  configured journal's registrable domain (a conservative last-two-labels
  approximation, not full public-suffix-list parsing -- the journal host is
  operator-supplied trusted input). Applied to BOTH image-collection paths in
  `parsePost`: the `<img src>` path (the existing chrome denylist for
  `userpic`/`pixel`/`spacer`/`stat.livejournal` is kept as a secondary
  exclusion) and the wrapped `<a href>` path, which was previously UNGUARDED by
  any check at all -- a second SSRF entry point.
- **Redirect hardening**: the image-download fetch now passes
  `redirect: "manual"` and re-validates the allowlist at every hop (bounded to
  5), closing the pivot where an allowlisted host 30x-redirects to an internal
  target. Reuses the same `isAllowedImageHost` for redirect targets as for the
  initial URL -- no separate/weaker check.
- **Behavior change**: an image whose host neither shares the journal's
  registrable domain nor is a known LiveJournal media CDN is no longer imported
  (silently dropped, matching the prior denylist's silent-drop semantics --
  `result.errors` stays empty). A journal that embeds off-domain images (e.g.
  Photobucket/Imgur/a personal server) will lose those images from imported
  notes. This is the intended SSRF hardening.
- **Accepted residual**: DNS-rebinding and allowlisted-suffix-collision at
  connect time are not closed by hostname allowlisting alone -- Deno's `fetch`
  offers no connect-time IP validation hook. `fetchWithRetry` (index/post crawl)
  also keeps default redirect-follow, since `journalUrl` is
  operator-supplied/trusted input, narrower and out of scope here.
- **Accepted residual, elevated for operator awareness**: `journalApex`'s
  last-two-labels registrable-domain approximation (not a full
  public-suffix-list algorithm -- see the code comment above `journalApex` in
  `livejournal_import.ts`) misclassifies journals hosted on a multi-label public
  suffix or a shared/wildcard-DNS hosting platform (e.g. `co.uk`, `github.io`,
  `s3.amazonaws.com`, `sslip.io`/`nip.io`-style services that resolve an
  IP-encoded hostname to that literal IP via a normal A record). For such a
  `journalUrl`, the derived apex (e.g. `sslip.io`) is shared with every other
  tenant on that platform, so a post-body image pointing at another host under
  the same apex is incorrectly allowed. **Operators importing a journal hosted
  on such a platform should verify no unexpected image hosts appear in imported
  notes.** A full fix requires a real public-suffix-list dependency, which is
  out of scope for this minimal SSRF-hardening pass (this exact tradeoff, and
  the conservative endsWith-apex alternative to PSL-parsing, was reviewed and
  accepted during planning; the trailing-dot FQDN-notation variant of this issue
  -- which was a genuine bug, not an accepted tradeoff -- is fixed, not merely
  documented, and pinned in the adversarial suite).
- **Upgrade-chain repair**: `model.upgrades[]` previously ended at
  `2026.03.29.1` while `model.version` was already `2026.07.16.2`, so
  `swamp extension quality` errored on the broken chain instead of scoring the
  extension. Added two identity lineage-repair bridge entries
  (`2026.03.29.1 -> 2026.05.25.1 -> 2026.07.16.2`,
  `upgradeAttributes:
  (old) => old`, no resource schema change) plus the new
  `2026.07.16.2 -> 2026.07.31.1` entry, so the chain is continuous and its final
  `toVersion` equals `model.version`.
- **Quality ratchet un-frozen**: with the chain repaired,
  `swamp extension
  quality manifest.yaml --json` now emits a real score (14/14
  points, 100%, `allPassed: true`) instead of erroring. `quality.yaml`'s
  `ratchet` is restamped from that tool output: `baselinePercentage: 0` /
  `UNSCORABLE` -> `baselinePercentage: 100` / Grade A.
- **Tests**: the LB1 pins in `livejournal_import_adversarial_test.ts` are
  flipped from "an internal target IS fetched with no allowlist" to "internal
  targets are NEVER fetched, `imageCount` is 0", plus new tests for the
  allowlist predicate (registrable-domain match, static LJ suffixes, IP-literal
  rejection in multiple encodings, suffix-confusion rejection, non-http(s)
  scheme rejection), the previously-unguarded wrapped-`<a href>` path, and
  redirect hardening (rejected internal target, positive follow-through to
  another allowed host, and multi-hop chains). `fixtures/post_ssrf.html` gained
  a third image: an allowlisted host that 30x-redirects to an RFC 5737
  (TEST-NET-3) documentation-only target, exercising the redirect-rejection
  path. All other latent-bug pins (LB2-LB8) are unchanged and stay green;
  contract-fixture, coverage, methods, and property suites stay green because
  every legitimate fixture image is on a host sharing the synthetic journal's
  registrable domain. Property suite re-verified at `FC_NUM_RUNS=5000` -- no
  idempotence flake recurrence.

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
  real LiveJournal blog while authoring these fixtures; every value is synthetic
  (RFC 2606 `.example.com` hosts, RFC 5737-adjacent addresses for the SSRF pin
  target, `Fixture`/`fixture-`-prefixed names, invented post
  ids/dates/comments).
- Every test drives `model.methods.import.execute()` against a stubbed
  `globalThis.fetch` (index/post HTML fetch + raw image binary fetch) and a
  stubbed `Deno.Command`/`Deno.mkdir`/`Deno.writeFile` (the `obsidian` CLI seam
  and the vault-attachment disk writes) -- `collectPostUrls`, `parsePost`,
  `htmlToMarkdown`, `parseLjDate`, `sanitize`, `runObsidian`, and `getVaultPath`
  are module-private, so the single `import` method is the only reachable seam.
  HTML fixtures are parsed with the REAL `cheerio@1.0.0` the model itself uses,
  never a stubbed DOM. Deno stubs are installed via
  `(globalThis as any).Deno.X = ...` (deno-lint-ignored) and restored in a
  `finally` block, so the suite needs no `--allow-write`/`--allow-run`.
- 8 already-shipped latent bugs are PINNED (characterized as CURRENT behavior,
  not fixed -- `livejournal_import.ts` is byte-frozen by this change) and
  tracked in the LOCAL `livejournal-import-latent-bugs` issue-lifecycle model
  (NEVER filed to the swamp.club Lab):
  1. **SSRF via image `src` (HIGH)** -- the `<img src>`/wrapped-link image URLs
     pass only a denylist (`l-stat.livejournal.net`/`userpic`/
     `stat.livejournal`/`pixel`/`spacer`) before `fetch(imgUrl)` writes the
     response straight to the vault; a link-local or loopback target
     (`169.254.169.254`, `127.0.0.1:8200`) is reached exactly like a real image
     host.
  2. **YAML frontmatter injection via unescaped newlines (MEDIUM)** --
     `title`/`mood`/`now_playing`/tag frontmatter values escape only `"`
     (`.replace(/"/g, '\\"')`), never embedded newlines; a raw `\n` inside any
     of those fields breaks the YAML block scalar and can inject a sibling key
     into the frontmatter.
  3. **Silent-empty success (MEDIUM)** -- `collectPostUrls` returning `[]` (e.g.
     an index page with zero matching post links) resolves as an ordinary
     `"Import complete: 0 notes, 0 images. Errors: 0"` success, with no distinct
     warning that nothing was found.
  4. **No fetch/subprocess timeout (MEDIUM)** -- neither `fetchWithRetry` nor
     the raw image `fetch` pass an `AbortSignal`/timeout, and the `obsidian`
     `Deno.Command` invocations carry no timeout option either; a hung upstream
     or a hung CLI process blocks the run (and the model's lock) indefinitely.
  5. **Unbounded pagination/memory (MEDIUM)** -- `collectPostUrls`'s
     `skip += 10` loop has no page cap; it keeps paging for as long as the
     server keeps advertising a `skip=N` marker and new post ids, with no upper
     bound on requests or accumulated URLs.
  6. **Fragile comment-JSON extraction (LOW)** -- the `Site.page = {...};`
     comments blob is located with a regex requiring a `};` + whitespace
     terminator, then `JSON.parse`d inside an empty `catch`; a corrupted or
     truncated blob silently drops ALL comments with no error surfaced.
  7. **Operator `folder` path traversal on disk write (LOW)** -- the `folder`
     global argument is concatenated directly into the vault attachment disk
     path (`${vaultPath}/${folder}/${attachmentsFolder}`) with no `..`-segment
     guard; a misconfigured `folder` value escapes the intended vault subtree
     (characterized against a synthetic escape target only).
  8. **`parseLjDate` silent fallthrough (LOW)** -- a date string not matching
     the expected `"Month D YYYY, HH:MM"` shape is returned UNCHANGED; the raw
     text then flows unquoted into the frontmatter `date:` line and
     (un-sanitized, unlike the title) into the note's slug/path.
- `deno.json`: `test` task widened to `--allow-read --allow-env` (unscoped env
  access, a deliberate deviation from the `bandcamp`/`porkbun` precedent's
  `--allow-env=FC_NUM_RUNS`) -- `cheerio@1.0.0`'s transitive `undici` dependency
  (used only by cheerio's unused `fromURL` convenience helper) probes several
  different `process.env` keys (`NODE_V8_COVERAGE`, `UNDICI_NO_FG`,
  `JEST_WORKER_ID`, ...) eagerly at module-import time; since
  `livejournal_import.ts` is byte-frozen, this cannot be avoided by swapping
  parsers, so the test task grants full env-read instead of chasing each key
  individually. No `--allow-net` is granted -- the fetch boundary is always
  stubbed. Added `test:soak` for the high-count nightly property soak.
  `fmt.exclude` lists `post_full.html`, `post_bad_comments.html`, and
  `post_injection.html` -- the first two carry the single-line `Site.page` blob
  the `};`+whitespace terminator regex depends on, and the third carries
  deliberately-embedded raw newlines the LB2 pin depends on; `deno fmt`'s HTML
  formatter collapses internal whitespace runs (including real newlines) when it
  re-wraps text for line width, which would silently defeat either pin.
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependencies
  (`jsr:@std/assert@1`, `jsr:@std/testing@1`, `npm:fast-check@4.8.0`). Source
  dependencies (`npm:zod@4`, `npm:cheerio@1.0.0`, `npm:domhandler@5.0.3`) are
  unchanged -- the lock delta carries no runtime/behavior implication
  whatsoever.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na`
  (livejournal-import bundles no Claude skill -- a blog-export importer, nothing
  to document as a skill). `watch`/`canary` stay `backlog` (seeded offender at
  CI-gate rollout, tracked in `ext-quality-test-backfill`). `ratchet` set
  UNSCORABLE (seanime/telegram-import precedent):
  `swamp
  extension quality manifest.yaml --json` errors on this extension's
  pre-existing broken model upgrade chain (model version `2026.07.16.2`, but
  `upgrades[]` only spans `2026.03.28.1 -> 2026.03.28.2 -> 2026.03.29.1`, never
  reaching current) -- predates this backfill, and the source is byte-frozen
  here so the chain cannot be repaired in this change. Removed from
  `quality-allowlist.txt` in the same change (five-suite presence graduates it,
  same as seanime).

## 2026.07.16.2

Initial release: import a LiveJournal blog into an Obsidian vault by walking the
public `?format=light` journal index, fetching every entry, converting the post
HTML to Markdown, downloading inline images as vault attachments, and writing
one Markdown note per post with YAML frontmatter (title, date, source URL,
LiveJournal post id, tags, and when present, mood and now-playing). Reader
comments are extracted from the entry page's embedded `Site.page` JSON and
appended under a Comments section. Relies on the local `obsidian` CLI to resolve
the vault path and create notes.
