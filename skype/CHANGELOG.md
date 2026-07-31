# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4a of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `skype.ts` is BYTE-FROZEN and the model `version` stays `2026.07.16.2`;
`manifest.yaml` is unchanged (no version bump).

- Added `extensions/models/skype_test.ts` (contract-fixture),
  `skype_methods_test.ts` (methods), `skype_adversarial_test.ts` (adversarial),
  `skype_coverage_test.ts` (coverage), `skype_property_test.ts`
  (property-invariant-flow) — 61 tests, 0 before this change.
- Added `fixtures/` — pure hand-authored, synthetic `sqlite3 -separator "\t"`
  list-mode TSV fixtures (`conversations`, `contacts`, `messages_read`,
  `messages_search`, `messages_export`, plus three deliberately hostile
  variants: `messages_newline_corruption`, `messages_tab_corruption`,
  `messages_entities`) plus `PROVENANCE.md`. No real `main.db` was ever read;
  every handle is an invented `live:.cid.fake000N` /
  `19:fakegroupid001@thread.skype` identity and every name is a generic
  placeholder.
- Every suite drives `model.methods.<m>.execute()` against a stubbed
  `Deno.Command` (installed via `(globalThis as any).Deno.Command =`, never a
  `as typeof Deno.Command` cast, per the deno 2.8.3 CI toolchain rule) for the
  `sqlite3` subprocess path, and a REAL filesystem (`Deno.makeTempDir`) for
  `listProfiles`'s `Deno.readDir`/`Deno.stat` walk and `importToObsidian`'s
  vault writes — no subprocess is ever spawned and no network call is made.
- Pinned 9 latent bugs, characterized rather than fixed. Filed against the LOCAL
  `skype-latent-bugs` issue-lifecycle model (never the Lab):
  1. **TSV row corruption on embedded newline (HIGH)** — `queryDb`'s
     `text.split("\n").map(line => line.split("\t"))` runs the newline split
     BEFORE the tab split; a `body_xml` containing a raw, un-quoted newline
     (real `sqlite3` list-mode output does not escape embedded newlines)
     fabricates a second, garbage message row and silently truncates the real
     message's body at the newline. A sibling variant — an embedded raw tab —
     shifts every following column one position right and silently drops the
     final field.
  2. **Path traversal via unsanitized `folder` (HIGH)** — `importToObsidian`
     joins `args.folder` into `noteDir` with no validation; `folder=../escaped`
     writes files outside the intended vault directory.
  3. **Resource-name/note-filename collision → overwrite (MEDIUM)** —
     `readConversation`'s `conv_<safeKey>` (50-char truncation) and
     `exportToObsidian`/`importToObsidian`'s 80-char-truncated filename both
     collide for two distinct conversations sharing a long common prefix,
     clobbering one's data with the other's in a real instance.
  4. **`exportToObsidian` unbounded memory + single-blob resource (MEDIUM)** —
     every conversation's full chat log is accumulated into one in-memory array
     and written as exactly one `writeResource` call, regardless of how many
     conversations exist.
  5. **No subprocess timeout (MEDIUM)** — `queryDb`'s `Deno.Command` carries no
     `signal`/timeout option; a wedged `sqlite3` process would hold the lock
     forever. Pinned by inspecting the captured constructor options, never by
     simulating a real hang.
  6. **Lone-surrogate slice truncation (MEDIUM)** — `importToObsidian`'s 80-char
     filename slice can cut an astral-emoji surrogate pair in half;
     `Deno.writeTextFile` silently tolerates this, replacing the lone surrogate
     with U+FFFD on disk rather than erroring or skipping the write.
  7. **YAML frontmatter injection via a raw line-break in the display name
     (MEDIUM)** — the frontmatter `title: "..."` template only escapes `"`,
     never a line-break; a display name carrying a raw `\r` (a real newline
     character that, unlike `\n`, survives `queryDb`'s own newline-based row
     split intact) injects arbitrary additional YAML-shaped lines into the
     frontmatter block.
  8. **Emoji numeric-entity mis-decode (LOW)** — `stripXml`'s `&#(\d+);` decoder
     uses `String.fromCharCode`, correct for BMP code points but silently wrong
     for any astral (`>0xFFFF`) code point — e.g. `&#128512;` (grinning face)
     decodes to an unrelated BMP character instead of the intended emoji.
  9. **Fragile hand-rolled SQL escaping (MEDIUM, not currently exploitable)** —
     every search term is escaped with a bare `replace(/'/g, "''")`; pinned
     (including a property test over arbitrary strings) that this escaping holds
     today, and pinned as a covered NEGATIVE that `queryDb` invokes `sqlite3`
     via a plain argv array (never `sh -c`), so there is no shell metacharacter
     injection surface at the process layer — only the SQL string-literal
     escaping matters, and it currently holds.
- `deno.json`: default `test` task stays subprocess-less and network-less —
  scoped to `--allow-read --allow-write --allow-env=FC_NUM_RUNS` (read for
  fixtures + module graph, write for the real temp-dir filesystem tests); added
  `test:soak` for the high-count nightly property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (skype bundles no
  Claude skill — a chat-history importer, nothing to document as a skill);
  measured ratchet 100/"Grade A". Removed from `quality-allowlist.txt` in the
  same change.

## 2026.07.16.2

Initial release: Skype `main.db` SQLite reader via the `sqlite3` CLI —
`listProfiles`, `listConversations`, `listContacts`, `readConversation`,
`searchBySender`, `searchByText`, and Obsidian export either as swamp data
(`exportToObsidian`) or written directly into a vault directory
(`importToObsidian`).
