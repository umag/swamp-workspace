# Changelog

## Unreleased

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
- Nine already-shipped latent bugs are PINNED (characterized as CURRENT
  behavior, not fixed -- `jabber_history.ts` is byte-frozen by this change) and
  tracked in the LOCAL `jabber-latent-bugs` issue-lifecycle model (NEVER filed
  to the swamp.club Lab):
  1. **`decodeURIComponent` on a malformed-`%` filename aborts ALL 4 methods
     (MEDIUM)** -- `decodeJid` runs unguarded on every filename inside
     `listHistoryFiles`' `for await` loop; one poisoned filename
     (`bad%ZZ.history`) throws a `URIError` that aborts listing for every OTHER
     file in the same directory too.
  2. **`sanitizeFilename` collision silently overwrites notes, data loss
     (MEDIUM)** -- two distinct JIDs (one containing a literal `/`, one already
     containing a literal `-`) can sanitize to the identical filename;
     `importToObsidian`'s returned summary still claims both were written, while
     only one survives on disk.
  3. **Obsidian frontmatter/markdown injection from JID or message body
     (MEDIUM)** -- neither the JID nor the message body is escaped for newlines
     anywhere in the markdown-rendering code (only `"` is escaped via
     `.replace(/"/g, '\\"')`). A `%0A`-encoded JID injects a second `title:`
     YAML line; a message body containing a literal `---` line injects a second
     frontmatter delimiter into the note body.
  4. **Malformed timestamp/direction -- schema-invalid resource would abort the
     whole run in a REAL swamp instance (MEDIUM, live-only)** -- the blind
     `timestamp + "Z"` append (L80) and the unvalidated `direction` string pass
     straight through the parse layer untouched; this backfill's fake
     `writeResource` never runs the model's own `ConversationSchema` zod
     validation, so only the parse-layer output is pinned here, not the live
     abort-on-schema-violation behavior.
  5. **`importToObsidian`'s `folder` path traversal (MEDIUM)** --
     `` `${vaultPath}/${args.folder}` `` is never sanitized; a `../`-relative
     folder escapes the vault directory entirely (pinned inside our own temp-dir
     sandbox, never a real system path).
  6. **No timeout on the `obsidian` subprocess -- import can hang (MEDIUM)** --
     `Deno.Command`'s options carry no `AbortSignal`/timeout anywhere (exit code
     and stderr ARE checked); a real hang is never simulated, only the absence
     of any timeout mechanism is pinned.
  7. **`obsidian` binary resolved from bare PATH name -- PATH-hijack risk
     (LOW)** -- `new Deno.Command("obsidian", ...)` never uses an absolute path.
     Paired with a covered-negative: the argv-array API means a vault NAME
     containing shell metacharacters (`; rm -rf ~; echo pwned
     $(whoami)`)
     is forwarded as a single, unsplit argv element -- no shell injection is
     possible.
  8. **Unbounded memory -- no streaming or cap (LOW)** -- every method reads
     each history file whole via `Deno.readTextFile` and scans every file in the
     directory; a several-thousand-message single file is read entirely into
     memory with no size guard anywhere.
  9. **Lone-surrogate filename truncation (LOW)** -- `sanitizeFilename`'s
     `.slice(0, 80)` is a raw UTF-16 code-unit cut that can split a surrogate
     pair straddling the boundary, emitting a lone unpaired high surrogate
     (observed to survive as-is when the write fails, or get silently
     substituted with the U+FFFD replacement character by the OS/runtime when
     the write succeeds -- both are the same underlying bug).
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
