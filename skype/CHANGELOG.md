# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.1

The remaining seven of the nine latent bugs pinned in `2026.07.16.2`'s test
backfill (all MEDIUM/LOW) are now real-fixed. Tracked end-to-end in the LOCAL
`skype-latent-bugs` issue-lifecycle model (never a Lab issue). Every adversarial
pin proving each bug now asserts the FIXED behavior instead of the bug; no
benign/frozen contract, methods, or coverage assertion changed byte for byte,
and both `2026.08.01.1` fixes (LB1/LB2) stay green and untouched.

1. **Resource-name/note-filename collision (MEDIUM), FIXED** —
   `readConversation`'s `conv_<safeKey>` (50-char truncation) and
   `exportToObsidian`/`importToObsidian`'s 80-char-truncated filename both
   collided for two distinct conversations sharing a long common prefix,
   silently clobbering one's data with the other's. Fixed with a new
   `truncKey(s, n)` helper: a string that already fits within `n` CODE POINTS is
   returned completely unchanged (so every existing short name stays
   byte-identical); once truncation actually removes something, a short
   deterministic hash (`shortHash`, FNV-1a 32-bit, base36-encoded) of the FULL
   original string is appended, so two names sharing the same truncated prefix
   no longer collide.
2. **`exportToObsidian` unbounded memory + single-blob resource (MEDIUM),
   FIXED** — every conversation's full chat log used to accumulate into one
   in-memory array and write as exactly one `writeResource` call, regardless of
   profile size. A new `maxNotesPerResource` method argument (default `500`,
   backward-compatible) now flushes the accumulated notes to their own data
   resource every N conversations: page 0 keeps the original
   `obsidian_<profile>` name, overflow pages are `obsidian_<profile>_p<N>`, and
   the method now returns one `dataHandles` entry per page. An empty export
   still writes exactly one (empty) page 0, never zero resources. Any profile
   within the default 500-conversation budget — every fixture in this test suite
   — still writes exactly one byte-identical resource.
3. **No subprocess timeout (MEDIUM), FIXED** — `queryDb`'s `Deno.Command`
   carried no `signal`/timeout option; a wedged `sqlite3` process (e.g. a
   locked/corrupt `main.db`) would hold the caller, and the swamp model lock,
   forever. Fixed with a new `queryTimeoutMs` global argument (default
   `30000`ms, backward-compatible) threaded through every `queryDb` call site;
   `queryDb` now wraps its `Deno.Command` in an `AbortController` +
   `setTimeout(() => ac.abort(), timeoutMs)`, clearing the timer in a `finally`
   block on every path (success or failure). Deliberately NOT
   `AbortSignal.timeout(ms)`: that built-in's internal timer has no handle the
   caller can clear, so a query finishing well within budget would still leave a
   live timer running — under Deno's test resource sanitizer that shows up as a
   leaked timer.
4. **Lone-surrogate slice truncation (MEDIUM), FIXED** — `importToObsidian`'s
   (and `exportToObsidian`'s) 80-char filename slice could cut an astral-emoji
   surrogate pair in half; `Deno.writeTextFile` silently tolerated this,
   replacing the lone surrogate with U+FFFD on disk rather than erroring or
   skipping the write. Folded into the same `truncKey` fix as #1 above:
   truncation now happens by CODE POINT via `Array.from`, so a surrogate pair
   landing at the cut boundary is kept whole rather than split. `searchByText`'s
   `textKey` slicing was fixed the same way for consistency, though it was never
   observed to corrupt an on-disk file (it only feeds a resource name).
5. **YAML frontmatter injection via a raw line-break in the display name
   (MEDIUM), FIXED** — the frontmatter `title:`/`identity:`/`profile:` template
   only ever escaped `"`, never a line-break; a display name (or identity, or
   profile) carrying a raw `\r` (a real newline character that, unlike `\n`,
   survives `queryDb`'s row split intact) could inject arbitrary additional
   YAML-shaped lines into the frontmatter block. Fixed with a new `yamlDq(s)`
   helper — backslash and double-quote are backslash-escaped, and every C0
   control character (including a raw CR/LF) is replaced with its escape
   sequence — applied to `title`/`identity`/`profile` in both `exportToObsidian`
   and `importToObsidian`. Byte-identical for every benign
   (control-character-free) value.
6. **Emoji numeric-entity mis-decode (LOW), FIXED** — `stripXml`'s `&#(\d+);`
   decoder used `String.fromCharCode`, correct for BMP code points but silently
   wrong for any astral (`>0xFFFF`) code point — e.g. `&#128512;` (grinning
   face) decoded to an unrelated BMP character instead of the intended emoji.
   Fixed by switching to `String.fromCodePoint`, guarded so an out-of-range code
   point (impossible for `\d+` to produce negative, but `fromCodePoint` throws
   above `0x10FFFF`) leaves the original entity text verbatim rather than
   throwing.
7. **Fragile hand-rolled SQL escaping (MEDIUM, not currently exploitable),
   FIXED** — every search term was escaped with a bare, duplicated
   `replace(/'/g, "''")` across `readConversation`, `searchBySender`, and
   `searchByText`. Centralized into one `sqlString(s)` helper — byte-identical
   `'`-doubling for every existing input — that additionally throws on an
   embedded NUL byte (`\x00`), since sqlite3's own C string handling truncates a
   value at the first NUL, which a `'`-doubling replace alone can never protect
   against. The covered-negative pins (argv-array invocation, no `sh -c`,
   quote-doubling property test) all stay green unchanged.

- `queryTimeoutMs` (global argument, defaulted) and `maxNotesPerResource`
  (method argument on `exportToObsidian`, defaulted) are both new,
  backward-compatible additions — no existing caller or resource schema changes.
  Added an `upgrades` entry (`2026.08.01.1` -> `2026.08.02.1`, identity
  `upgradeAttributes`) since no resource schema changed.
- `model.version` (`extensions/models/skype.ts`) and `manifest.yaml` both bump
  to `2026.08.02.1`, in sync.
- `skype_adversarial_test.ts`: every BUG #3-#9 pin now asserts the FIXED
  behavior; two new tests for BUG #4's paging (a `maxNotesPerResource: 2` split
  and an empty-export page-0 guarantee) plus a default-budget byte-identical
  guard, a BUG #5 "successful query still resolves, timer cleared" test
  (backstopped by Deno's own leaked-timer sanitizer), and three BUG #9
  NUL-byte-rejection tests (the helper directly, plus
  `readConversation`/`searchByText` wiring). No benign/frozen contract, methods,
  coverage, or property assertion changed.
- `quality.yaml` and this file's header wording updated from "BYTE-FROZEN"/
  "pin" to reflect the real fix; re-measured ratchet, still 100/"Grade A".

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
