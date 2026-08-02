# Changelog

## 2026.08.02.1

Fixes the eight latent bugs (#1-4, #6-9) that were tracked, unfixed, in the
LOCAL `jabber-latent-bugs` issue-lifecycle model (never filed to the swamp.club
Lab) as of 2026.08.01.1. **Bug #5 (folder path traversal) is untouched** -- it
was already fixed in 2026.08.01.1 by the `resolveVaultPathSafe` path-confinement
change, and that fix's headless `vaultRoot`/PR #141 behavior is unmodified here.

- **#1 (decodeJid resilience)**: `decodeJid` now wraps `decodeURIComponent` in a
  try/catch and falls back to the `_at_`-replaced raw string on a `URIError`,
  instead of letting one malformed-`%` filename abort listing -- and therefore
  every method -- for the WHOLE directory. `list`/`read`/
  `search`/`importToObsidian` all now RESOLVE against a directory containing a
  poisoned filename; the poisoned entry surfaces with its fallback jid instead
  of taking down every other file with it.
- **#2 (sanitizeFilename collision dedup)**: `importToObsidian` now tracks used
  filename stems in a `Map` and appends `(2)`, `(3)`, ... on collision (the same
  pattern `fidonet_msgbase.ts` already uses for its Obsidian note paths),
  instead of silently letting the second write clobber the first.
- **#3 (frontmatter/body injection, both vectors)**: added `yamlEscape` (copied
  verbatim from `livejournal_import.ts`) and applied it to the
  `title`/`jid`/`account` frontmatter fields (previously only `"` was escaped),
  plus a new `neutralizeBodyDelimiters` helper that backslash-escapes any
  message-body LINE that is, once trimmed, exactly a `---`/`***`/`___`
  delimiter. A `%0A`-encoded JID no longer injects a second `title:` line; a
  body containing an internal `---` line no longer forges a second frontmatter
  block. (The prior #3b pin was VACUOUS -- its fixture body started with `---`
  but rendered inline as ordinary text, never as its own line; the rewritten
  test uses a body with an internal newline so the injected delimiter is a real
  line, and is non-vacuous: an unfixed model produces 3 `---` lines, the fixed
  one produces exactly 2.)
- **#4 (was live-only, now offline-testable)**: `read` now validates each parsed
  pipe-format message against the model's own `MessageSchema` and drops (with a
  `logger.warn`) any that fail -- localizing the damage the same way the #1 fix
  localizes one bad filename -- instead of letting a malformed
  timestamp/direction pass straight through untouched. The regression test now
  directly asserts `model.resources.conversation.schema.parse(payload)` no
  longer throws, which is exactly the live-instance failure mode this bug used
  to describe as untestable in this backfill's fake `writeResource` harness.
- **#6/#7 (obsidian subprocess hardening)**: `getVaultPath` now spawns with an
  `AbortController`-derived `signal` (a manual `setTimeout`/`clearTimeout` pair,
  never `AbortSignal.timeout()` -- see the doc comment on `getVaultPath`)
  bounded by a new `timeoutMs` global argument (default `30000`ms), so a hung
  Obsidian CLI no longer blocks the import indefinitely. A new `obsidianBin`
  global argument (default `"obsidian"`, unchanged) lets an operator pin an
  absolute path instead of the bare PATH-resolved command name.
- **#8 (unbounded memory)**: a new `maxFileBytes` global argument (default
  `52428800` = 50 MiB) routes every file read through a new `readFileWithCap`
  helper, which `Deno.stat`s the file first and skips it (with a warning) if it
  exceeds the cap, instead of always reading it whole regardless of size. The
  default is far above any realistic history file, so behavior is unchanged
  unless an operator explicitly lowers the cap.
- **#9 (lone-surrogate filename truncation)**: `sanitizeFilename` now slices via
  `Array.from(cleaned).slice(0, 80).join("")` (Unicode code points) instead of a
  raw UTF-16 code-unit `.slice(0, 80)`, so a surrogate pair straddling the
  80-character boundary is never split.
- Added `upgrades[]` (previously absent on this model): a lineage-repair bridge
  `2026.07.16.2` -> `2026.08.01.1` (closing the gap left when the
  headless-vaultRoot change shipped without an `upgrades[]` entry) and this
  change's own `2026.08.01.1` -> `2026.08.02.1` entry. Neither changes the
  resource schema.
- Extended all five test suites with FIXED-behavior pins for the flipped bugs,
  plus new non-vacuous coverage: a mixed good+poison directory (#1), a rewritten
  #3b fixture with an internal newline, a `maxFileBytes`-capped skip test (#8),
  an `obsidianBin`-override pin (#7), and the #9 property test's arbitrary now
  includes an astral (surrogate-pair) character so the code-point-length
  invariant is exercised non-vacuously.
- `manifest.yaml`/model `version`: `2026.08.01.1` -> `2026.08.02.1`.

## 2026.08.01.1

Adds an optional headless `vaultRoot` filesystem backend to `importToObsidian`,
so the import can run with the Obsidian desktop app closed (swamp-workspace #57;
mirrors the CLI/filesystem backend split done for `@magistr/obsidian-vault` in
PR #56 — see that PR for the path-confinement rationale). The Obsidian CLI
(`getVaultPath`) is kept as the fallback for when neither `vaultPath` (method
argument) nor `vaultRoot` (global argument) is set.

- Added the `vaultRoot` global argument. `importToObsidian`'s destination now
  resolves with precedence `vaultPath` (method argument) > `vaultRoot` (global
  argument) > the existing `vault` (name) CLI lookup via `getVaultPath`. jabber
  already wrote notes with `Deno.writeTextFile` (never through the Obsidian
  CLI's `create` command), so only the destination _resolution_ changed -- the
  write path itself is untouched.
- Added `resolveVaultPath`/`resolveVaultPathSafe` (realpath + symlink refusal
  - `..` rejection), copied VERBATIM (same names/comments, per the approved
    plan's scope constraint against a shared cross-extension module -- swamp
    bundles each extension independently) from
    `obsidian-vault/extensions/models/obsidian_vault.ts` (PR #56).
    `importToObsidian`'s `noteDir`/`notePath` now resolve through
    `resolveVaultPathSafe` before every `mkdir`/write, regardless of which of
    the three precedence tiers produced the destination.
  * **This FIXES latent bug #5** (folder path traversal --
    `` `${vaultPath}/${args.folder}` `` was concatenated unsanitized, so a
    `../`-relative `folder` escaped the vault directory): a traversal attempt is
    now rejected before any directory is created. The other eight tracked latent
    bugs (#1-4, #6-9) were UNCHANGED as of this release and remained pinned in
    the LOCAL `jabber-latent-bugs` issue-lifecycle model -- **all eight are now
    FIXED in 2026.08.02.1 above.**
  * No `npm:yaml` dependency was added -- this model emits brand-new hand-built
    frontmatter into notes it owns, it never round-trips existing frontmatter,
    so PR #56's yaml-`Document` rationale does not apply here. Every hand-built
    frontmatter string stays byte-for-byte identical to before this change.
  * Dot-dir/`.trash` exclusion is N/A: `importToObsidian` writes into a
    caller-named folder, it never walks the vault tree (covered by a
    covered-negative test in the adversarial suite).
- Extended all five existing test suites
  (`jabber_test.ts`/`jabber_methods_test.ts`/`jabber_adversarial_test.ts`/
  `jabber_coverage_test.ts`/`jabber_property_test.ts`) with `vaultRoot`
  coverage: a golden fs-backend run against the synthetic `fixtures/good`
  corpus, method-level tests proving the CLI is never invoked when `vaultRoot`
  is set (`Deno.Command` stubbed to throw), a backend-selection precedence
  branch matrix, path-confinement adversarial tests (`..` traversal and
  symlinked folder segments refused, `/var`-vs-`/private/var` real-root
  containment), and a property test asserting exactly one note per importable
  item with frontmatter round-trip and no path escaping the vault's real root,
  for any synthetic set of generated JIDs. No new fixture files were needed --
  every new test builds its own `Deno.makeTempDir` vault and reuses the existing
  `fixtures/good/history/` corpus.
- `manifest.yaml`/model `version`: `2026.07.16.2` -> `2026.08.01.1`.

## Unreleased (folded into 2026.08.01.1 above)

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4a child
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change -- `jabber_history.ts` is byte-frozen and the model `version`
stays `2026.07.16.2`.

- Added `extensions/models/jabber_test.ts` (contract-fixture),
  `jabber_methods_test.ts` (methods), `jabber_adversarial_test.ts`
  (adversarial), `jabber_coverage_test.ts` (coverage), `jabber_property_test.ts`
  (property-invariant-flow) -- 0 tests before this change, 57 after.
- Added `fixtures/good/history/` -- a synthetic on-disk Psi/Psi+ profile tree (a
  pipe-delimited DM, a pipe-delimited conference with and without a plain-text
  twin, a plain-text `_in_` conference log, an empty `.history` file, and a
  `.backup` file that must be skipped) plus `fixtures/PROVENANCE.md`. Kept
  `fixtures/poison/history/bad%ZZ.history` (a malformed-`%` filename) in its OWN
  subtree so it can't abort the good-path listing tests. No real Psi/Psi+
  profile was ever read while authoring these fixtures -- every
  JID/nickname/room is invented under the `example.com`/
  `conference.example.com` domains (RFC 2606).
- Every test drives `model.methods.<m>.execute()` against REAL
  `Deno.readDir`/`Deno.readTextFile`/`Deno.writeTextFile` (the static fixture
  tree above, plus `Deno.makeTempDir` scratch trees built inline for
  parser-edge-case and adversarial scenarios) and a fake context --
  `parsePipeDelimited`, `parsePlainText`, `listHistoryFiles`, `decodeJid`, and
  `sanitizeFilename` are all module-private, so every characterization is
  reached exclusively through the four public methods (`list`, `read`, `search`,
  `importToObsidian`). `importToObsidian`'s `vaultPath` branch does real
  filesystem writes into a temp vault; only its `vault` (name) resolution branch
  stubs `Deno.Command` (success + stderr-fail), so no real `obsidian` binary is
  ever invoked.
- **This model parses NO XML** -- confirmed by reading the frozen source: it
  parses Psi/Psi+'s pipe-delimited `.history` format and a plain-text `_in_`
  conference log via one line regex, with zero XML dependency anywhere. The
  adversarial suite falsifies XXE/DOCTYPE/billion-laughs applicability with a
  covered-negative: such a payload embedded in a message body survives
  byte-for-byte as inert literal text.
- Nine already-shipped latent bugs were PINNED at the time of this change
  (characterized as CURRENT behavior, not fixed -- `jabber_history.ts` was
  byte-frozen by this change) and tracked in the LOCAL `jabber-latent-bugs`
  issue-lifecycle model (NEVER filed to the swamp.club Lab). **All nine are now
  FIXED** -- #5 in 2026.08.01.1 above, and #1-4/#6-9 in 2026.08.02.1 (see the
  top of this file):
  1. **`decodeURIComponent` on a malformed-`%` filename aborts ALL 4 methods
     (MEDIUM)** -- `decodeJid` runs unguarded on every filename inside
     `listHistoryFiles`' `for await` loop; one poisoned filename
     (`bad%ZZ.history`) throws a `URIError` that aborts listing for every OTHER
     file in the same directory too. **FIXED in 2026.08.02.1.**
  2. **`sanitizeFilename` collision silently overwrites notes, data loss
     (MEDIUM)** -- two distinct JIDs (one containing a literal `/`, one already
     containing a literal `-`) can sanitize to the identical filename;
     `importToObsidian`'s returned summary still claims both were written, while
     only one survives on disk. **FIXED in 2026.08.02.1.**
  3. **Obsidian frontmatter/markdown injection from JID or message body
     (MEDIUM)** -- neither the JID nor the message body is escaped for newlines
     anywhere in the markdown-rendering code (only `"` is escaped via
     `.replace(/"/g, '\\"')`). A `%0A`-encoded JID injects a second `title:`
     YAML line; a message body containing a literal `---` line injects a second
     frontmatter delimiter into the note body. **FIXED in 2026.08.02.1.**
  4. **Malformed timestamp/direction -- schema-invalid resource would abort the
     whole run in a REAL swamp instance (MEDIUM, live-only)** -- the blind
     `timestamp + "Z"` append (L80) and the unvalidated `direction` string pass
     straight through the parse layer untouched; this backfill's fake
     `writeResource` never runs the model's own `ConversationSchema` zod
     validation, so only the parse-layer output is pinned here, not the live
     abort-on-schema-violation behavior. **FIXED in 2026.08.02.1** -- now
     offline-testable via a post-parse `MessageSchema` guard, no longer
     live-only.
  5. **`importToObsidian`'s `folder` path traversal (MEDIUM)** --
     `` `${vaultPath}/${args.folder}` `` is never sanitized; a `../`-relative
     folder escapes the vault directory entirely (pinned inside our own temp-dir
     sandbox, never a real system path). **FIXED in 2026.08.01.1 above** by the
     `resolveVaultPathSafe` path-confinement change.
  6. **No timeout on the `obsidian` subprocess -- import can hang (MEDIUM)** --
     `Deno.Command`'s options carry no `AbortSignal`/timeout anywhere (exit code
     and stderr ARE checked); a real hang is never simulated, only the absence
     of any timeout mechanism is pinned. **FIXED in 2026.08.02.1.**
  7. **`obsidian` binary resolved from bare PATH name -- PATH-hijack risk
     (LOW)** -- `new Deno.Command("obsidian", ...)` never uses an absolute path.
     Paired with a covered-negative: the argv-array API means a vault NAME
     containing shell metacharacters (`; rm -rf ~; echo pwned
     $(whoami)`)
     is forwarded as a single, unsplit argv element -- no shell injection is
     possible. **FIXED in 2026.08.02.1** -- mitigable via the new `obsidianBin`
     global argument (default unchanged).
  8. **Unbounded memory -- no streaming or cap (LOW)** -- every method reads
     each history file whole via `Deno.readTextFile` and scans every file in the
     directory; a several-thousand-message single file is read entirely into
     memory with no size guard anywhere. **FIXED in 2026.08.02.1.**
  9. **Lone-surrogate filename truncation (LOW)** -- `sanitizeFilename`'s
     `.slice(0, 80)` is a raw UTF-16 code-unit cut that can split a surrogate
     pair straddling the boundary, emitting a lone unpaired high surrogate
     (observed to survive as-is when the write fails, or get silently
     substituted with the U+FFFD replacement character by the OS/runtime when
     the write succeeds -- both are the same underlying bug). **FIXED in
     2026.08.02.1.**
- `deno.json`: `test` task now grants
  `--allow-read --allow-write
  --allow-env=FC_NUM_RUNS` (real fixture/temp-dir
  I/O; still no `--allow-net` and no `--allow-run` -- `Deno.Command` is always
  stubbed, never actually spawned). Added `test:soak` for the high-count nightly
  property soak.
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependencies
  (`jsr:@std/assert@1`, `npm:fast-check@4.8.0`). The source dependency
  (`npm:zod@4`) is unchanged -- the lock delta carries no runtime/behavior
  implication whatsoever.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (jabber bundles
  no Claude skill -- an XMPP-history importer, nothing to document as a skill).
  `watch`/`canary` stay `backlog` (seeded offender at CI-gate rollout, tracked
  in `ext-quality-test-backfill`). `ratchet` set from the measured
  `swamp extension quality manifest.yaml --json` score. Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: list, read, search, and import Psi/Psi+ Jabber (XMPP) chat
history -- both direct messages and multi-user conference (MUC) rooms -- into an
Obsidian vault as markdown notes. Parses the two on-disk log formats Psi/Psi+
produce: pipe-delimited `.history` files and human-readable `account_in_room`
plain-text conference logs carrying sender nicknames.
