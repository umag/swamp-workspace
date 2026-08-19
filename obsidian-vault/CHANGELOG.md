# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.1

Test backfill to the STANDARD.md five-suite quality bar
(`ext-quality-bf-obsidian-vault`, the LAST entry on `quality-allowlist.txt` —
this backfill took the Phase D compliance program to 100%), followed by a real
fix for all eight latent bugs the backfill's adversarial/coverage suites found
and originally pinned: CRLF-frontmatter data loss, a ReDoS alternation guard
gap, backslash path traversal, unbounded digest/search memory and per-file
reads, digest silently ignoring an explicit CLI backend, impossible calendar
dates, a trash-overwrite race, and hardcoded write-action reporting.
`obsidian_vault.ts` and `manifest.yaml` both move `version` from `2026.07.27.1`
to `2026.08.02.1`.

- Added `extensions/models/obsidian_vault_methods_test.ts` (methods — all 24
  methods exercised at least once, mechanically verified by a final
  method-coverage assertion; the 11 CLI-only methods driven through a stubbed
  `Deno.Command` asserting argv plus response parsing; `properties` and
  `propertyRemove` get their first-ever `.execute()` coverage),
  `obsidian_vault_adversarial_test.ts` (adversarial — organized by the seven
  review-adversarial dimensions plus a dedicated filesystem-attack-surface
  section: path-confinement and symlink-refusal hold across all 13 fs methods,
  YAML/frontmatter-injection is prevented, the `maxBodyChars=0` privacy default
  holds), `obsidian_vault_coverage_test.ts` (coverage — digest name-filter
  branches, a dotfile extension edge, propertyRemove's no-frontmatter/no-op
  paths, empty-query search, the `path` folder alias, `selectBackend`'s
  no-headless-alternative message shape, `propertyTypeHint(0)`),
  `obsidian_vault_property_test.ts` (property-invariant-flow —
  `npm:fast-check@4.8.0`, gated by `FC_NUM_RUNS`, with domain-restricted
  arbitraries so merge-idempotence, readback fidelity, `splitFrontmatter`
  round-trip, a multi-step setProperties flow, and list-determinism all hold
  without flaking against the CRLF/YAML-escaping-needing domains; verified
  convergent at `FC_NUM_RUNS=5000`) — 0 tests before this change across these
  four files, 188 total across all five suites after (179 from the backfill, 9
  net added by the real-fix pass below).
- Added `extensions/models/fixtures/PROVENANCE.md` (synthetic-only banner
  covering all nine fixtures, six pre-existing plus three new) and three new
  adversarial fixtures: `crlf-frontmatter.md` (real CRLF byte pairs, written via
  `printf` so they survive Git unmodified — this repo has no `.gitattributes`
  line-ending rule), `malformed-frontmatter.md` (a tab character used for
  frontmatter indentation — invalid YAML), and `unterminated-frontmatter.md` (an
  opening `---` fence that is never closed). No live vault was read to author
  any fixture — every value is an invented placeholder (see PROVENANCE.md for
  the full accounting).
- `deno.json`: added `fmt.exclude: ["extensions/models/fixtures/"]` so
  `deno fmt` cannot silently corrupt the three byte-precise adversarial fixtures
  above (verified: without the exclude, `deno fmt` normalized the CRLF fixture's
  line endings and merged the unterminated fixture's two property lines into one
  paragraph). `deno.lock` gained the `npm:fast-check@4.8.0` entry the property
  suite resolves.

Eight latent bugs found by the backfill's adversarial/coverage suites, filed in
the LOCAL `obsidian-vault-latent-bugs` issue-lifecycle model (never the
swamp.club Lab — this is our own extension), are now real-fixed:

- **#1 HIGH — CRLF frontmatter data loss.** `splitFrontmatter`'s opening-fence
  check only recognized `---\n`; a CRLF-line-ended note's real frontmatter was
  silently invisible to `readProperties`, and `setProperties`/`mergeProperties`
  corrupted it by prepending a second frontmatter block. Fixed by also accepting
  `---\r\n` — the existing closing-fence scan and body/raw slicing were already
  CRLF-tolerant. Added a non-vacuous end-to-end regression: write a CRLF note to
  a real temp vault, `setProperties`, read it back, and assert the original
  title survives alongside the new/changed properties, with exactly one
  frontmatter block (no duplication).
- **#2 MED — ReDoS alternation guard gap.** The nested-quantifier guard only
  matched a quantifier _inside_ a parenthesized group (`(a+)+`); an
  alternation-based group carrying its own quantifier (`(a|a)+`, `(a|ab)*`)
  passed through uncaught. Added a second guard, `ALTERNATION_QUANTIFIER`,
  rejecting any quantified alternation group. Accepted tradeoff: a
  non-catastrophic pattern like `(cat|dog)+` is now also conservatively
  rejected; a bare `(cat|dog)` with no trailing quantifier still compiles.
- **#3 MED — backslash path traversal.** `normalizeSegments` split only on `/`,
  so a backslash-separated traversal string (`..\..\etc\passwd`) was treated as
  one literal in-bounds filename instead of two `..` segments. Fixed by
  splitting on `[/\\]`, matching `dataName`'s existing separator handling; a
  mixed forward/backslash string (`a\..\..\escape.md`) is now rejected too.
- **#4 MED — unbounded digest/search resource use.** Neither `digest` nor
  `search` bounded a single file's read size, and `digest`'s `signalHits` array
  grew without bound before being sliced to 500 entries in the output only.
  Added a module-level `MAX_SCAN_FILE_BYTES` (2,000,000), checked via
  `Deno.stat` before `Deno.readTextFile` in both methods (an oversized file is
  skipped and `truncated=true` is set), and a `MAX_SIGNAL_HITS` (500) cap
  applied at push time in `digest`, with true per-keyword counts and file lists
  now tracked independently via counter maps so the reported rollup totals stay
  accurate even once the output array is capped. A normal-sized file is still
  fully read in both methods.
- **#5 LOW — digest ignored an explicit CLI backend.** `digest` called
  `selectBackend` but discarded its return value, always running the filesystem
  walk even when the caller explicitly passed `backend=cli`. Fixed by checking
  the resolved backend and throwing when it resolves to `cli`, explaining that
  `digest` needs `vaultRoot`, not Obsidian's index; `backend=auto` with
  `vaultRoot` set still digests normally.
- **#6 LOW — impossible calendar dates.** `inferDate` range-checked month/day
  independently (1-12, 1-31), accepting nonexistent dates like `2026-02-31` or
  `2026-04-31`. Fixed by round-tripping the parsed date through `Date.UTC` and
  rejecting anything that rolled into a different month/day; a leap-year Feb 29
  (`2024-02-29`) is still accepted, a non-leap Feb 29 (`2026-02-29`) is now
  rejected.
- **#7 LOW — trash overwrite.** Deleting a note, recreating it at the same path,
  and deleting it again silently overwrote the first trashed copy via
  `Deno.rename`. Fixed with a new `uniqueTrashPath` helper that detects a
  collision and appends a UUID suffix before the extension (looped until a free
  name is found) — both copies are now independently recoverable from `.trash`.
- **#8 MED — hardcoded `action`.** `setProperties` and `propertyRemove` both
  reported a fixed `action:"updated"` in their `operationResult` regardless of
  the real write outcome, misleading a caller that branches on `action` to skip
  downstream work on a true no-op. Fixed by hoisting a `let action` before each
  backend branch and assigning the real `classifyWrite(...)` result on the
  filesystem path; the CLI branches, which have no local before/after state to
  compare, keep the `"updated"` literal.

- Every test in the adversarial and coverage suites that used to pin one of
  these eight bugs as characterized-but-accepted behavior is now a regression
  test asserting the fixed behavior, plus new tests per bug covering the
  adjacent cases called out above. The three other suites
  (`obsidian_vault_test.ts`, `obsidian_vault_methods_test.ts`,
  `obsidian_vault_property_test.ts`) are untouched by this change.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  are `present`; `docs.skill` recorded `na` (no
  `.claude/skills/obsidian-vault/SKILL.md` exists). `ratchet` re-stamped from a
  real `swamp extension quality obsidian-vault/manifest.yaml --json` run against
  `2026.08.02.1`: `rubricVersion: 3`, 14/14 earned points (100%),
  `allPassed: true`, label `"Grade A"` — the model's upgrade chain is continuous
  and terminates at `model.version` (`2026.08.02.1`), so this is an honest
  SCORABLE ratchet. The pre-existing `yaml@2.6.1` MEDIUM advisory
  (GHSA-48c2-rrv3-qjmp) is unchanged by this fix and still passes
  dependency-trust — out of scope here.
- Removed `obsidian-vault` from `quality-allowlist.txt` in the same change
  (shrink-only guard — `quality-offenders.baseline.txt` is untouched,
  write-once) — the file is now header-only and the Phase D backfill program is
  complete (48/48 extensions, allowlist 0 entries).

## 2026.07.27.1

Added the headless filesystem backend, bulk frontmatter merge (`setProperties`),
and the corpus digest (`digest`) alongside the original Obsidian CLI backend
(notes, search, tags, links, daily notes, frontmatter).
