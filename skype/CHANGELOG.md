# Changelog

## 2026.08.01.1

Two of the nine latent bugs pinned below (both HIGH) are now FIXED. Tracked
end-to-end in the LOCAL `skype-latent-bugs` issue-lifecycle model — never a Lab
issue, since this is a `@magistr/*` extension.

1. **TSV row corruption on embedded newline/tab (HIGH), FIXED** — `queryDb`
   transported `sqlite3` output via `-separator "\t"` (TSV list mode), which
   does not escape an embedded newline/tab byte inside a `body_xml` TEXT value:
   a raw newline fabricated a spurious second message row and truncated the real
   body; a raw tab shifted every following column one position right and
   silently dropped the final field. Fixed by switching the transport to
   `sqlite3 -ascii`, whose column separator (0x1F, unit separator) and record
   separator (0x1E) never occur in ordinary text, so embedded newline/tab bytes
   now survive intact inside a field. The parser splits on 0x1E first and drops
   the trailing empty record — `-ascii` terminates every row including the last,
   so a naive split would otherwise fabricate one spurious blank row per query.
   The `string[][]` positional-row return contract, the NULL-to-`""` mapping,
   and every call site are unchanged.
2. **Path traversal via unsanitized `folder`/`profile` (HIGH), FIXED** —
   `importToObsidian` joined `args.folder` and the `profile` global argument
   into `noteDir` with no validation; either one containing `../` wrote `.md`
   files outside the intended vault directory. Fixed with a `resolveWithin`
   guard (`jsr:@std/path@1`'s `resolve`/`relative`/`isAbsolute`) that resolves
   `vaultPath` + `folder` + `profile` as one joined target and throws if it
   escapes `vaultPath` — covering both a hostile `folder` and a hostile
   `profile`, since guarding only one would leave the other open. **Residual
   (accepted, not closed by this fix):** the containment check is lexical — it
   does not call `realpath`/follow symlinks — so a pre-existing symlink inside
   the vault pointing outward could still let a write escape. The threat model
   here is a local user with write access to their own vault, not a hostile
   filesystem, so this residual is accepted rather than closed; a
   `realpath`-based check would be a separate, larger change. `exportToObsidian`
   (which only returns the path as swamp data, never writes to disk) is
   unaffected and out of scope.

- Added the `jsr:@std/path@1` import (pinned major version); regenerated
  `deno.lock`.
- Migrated every `sqlite3` stdout stub across all five test suites, plus all 8
  committed fixtures, from TSV framing (tab/newline) to the real
  `sqlite3 -ascii` wire shape (0x1F column / 0x1E record separator) via a
  per-suite `asciiTable()` helper — required because the parser itself changed;
  a stub still framed as TSV would fail for an unrelated reason (queryDb would
  read the whole blob as one column). The two corruption fixtures
  (`messages_newline_corruption.tsv`, `messages_tab_corruption.tsv`) were
  re-authored so the embedded newline/tab now lives safely INSIDE a field,
  proving the fix rather than the bug. Added boundary tests for the 0x1E
  trailing-record-drop (single-row and empty-result cases) and for the
  `profile`-based traversal escape.
- `model.version` (`extensions/models/skype.ts`) and `manifest.yaml` both bump
  to `2026.08.01.1`, in sync.

## Test backfill (prior to 2026.08.01.1, no version bump at the time)

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4a of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change at the time — `skype.ts` was BYTE-FROZEN and the model `version` stayed
`2026.07.16.2`; `manifest.yaml` was unchanged. The `2026.08.01.1` fixes above
build directly on this test suite (and its fixtures were subsequently migrated
from TSV to ascii framing as part of that fix).

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
