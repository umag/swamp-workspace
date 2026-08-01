# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar
(`ext-quality-bf-obsidian-vault`, the LAST entry on `quality-allowlist.txt` —
this backfill takes the Phase D compliance program to 100%). No behavior change
— `obsidian_vault.ts` and `manifest.yaml` are byte-for-byte unchanged and the
model `version` stays `2026.07.27.1`.

- Added `extensions/models/obsidian_vault_methods_test.ts` (methods — all 24
  methods exercised at least once, mechanically verified by a final
  method-coverage assertion; the 11 CLI-only methods driven through a stubbed
  `Deno.Command` asserting argv plus response parsing; `properties` and
  `propertyRemove` get their first-ever `.execute()` coverage),
  `obsidian_vault_adversarial_test.ts` (adversarial — organized by the seven
  review-adversarial dimensions plus a dedicated filesystem-attack-surface
  section: path-confinement and symlink-refusal hold across all 13 fs methods,
  YAML/frontmatter-injection is prevented, the `maxBodyChars=0` privacy default
  holds; pins seven known-but-deferred bugs plus one discovered while writing
  this suite), `obsidian_vault_coverage_test.ts` (coverage — digest name-filter
  branches, a dotfile extension edge, propertyRemove's no-frontmatter/no-op
  paths, empty-query search, the `path` folder alias, `selectBackend`'s
  no-headless- alternative message shape, `propertyTypeHint(0)`; pins the newly
  discovered #8), `obsidian_vault_property_test.ts` (property-invariant-flow —
  `npm:fast-check@4.8.0`, gated by `FC_NUM_RUNS`, with domain-restricted
  arbitraries so merge-idempotence, readback fidelity, `splitFrontmatter`
  round-trip, a multi-step setProperties flow, and list-determinism all hold
  without flaking against the CRLF/YAML-escaping-needing domains; verified
  convergent at `FC_NUM_RUNS=5000`) — 0 tests before this change across these
  four files, 179 total across all five suites after.
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
  `deno
  fmt` cannot silently corrupt the three byte-precise adversarial
  fixtures above (verified: without the exclude, `deno fmt` normalized the CRLF
  fixture's line endings and merged the unterminated fixture's two property
  lines into one paragraph). `deno.lock` gained the `npm:fast-check@4.8.0` entry
  the property suite resolves.
- Filed eight latent bugs in the LOCAL `obsidian-vault-latent-bugs`
  issue-lifecycle model (never the swamp.club Lab — this is our own extension):
  #1 HIGH (CRLF-frontmatter notes are silently misread and then corrupted with a
  duplicate frontmatter block on write — seeds a future real-fix), #2 MED (the
  ReDoS guard misses alternation-based catastrophic patterns), #3 MED (backslash
  path segments are not traversal-checked — a Windows-only vector), #4 MED (no
  per-file size bound on `digest`/`search` reads; `signalHits` unbounded in
  memory before a 500-entry output slice), #5 LOW (`digest` silently ignores an
  explicit `backend=cli`), #6 LOW (`inferDate` accepts impossible calendar
  dates), #7 LOW (`delete`'s trash path silently overwrites an earlier trashed
  copy of a recreated same-named note), #8 MED (`setProperties`/`propertyRemove`
  report a hardcoded `action:"updated"` regardless of the real write outcome,
  discovered while writing the methods/coverage suites). All eight are pinned by
  characterization tests, none are fixed — `obsidian_vault.ts` stays byte-frozen
  for this change.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (no
  `.claude/skills/obsidian-vault/SKILL.md` exists). `ratchet` set to
  `rubricVersion: 3, baselinePercentage: 100, label: "Grade A"` —
  `swamp
  extension quality obsidian-vault/manifest.yaml --json` scores 100%
  offline and the model's upgrade chain is continuous and terminates at
  `model.version` (`2026.07.27.1`), so this is an honest SCORABLE ratchet, not
  the seanime-precedent UNSCORABLE path.
- Removed `obsidian-vault` from `quality-allowlist.txt` in the same change
  (shrink-only guard — `quality-offenders.baseline.txt` is untouched,
  write-once) — the file is now header-only and the Phase D backfill program is
  complete (48/48 extensions, allowlist 0 entries).

## 2026.07.27.1

Added the headless filesystem backend, bulk frontmatter merge (`setProperties`),
and the corpus digest (`digest`) alongside the original Obsidian CLI backend
(notes, search, tags, links, daily notes, frontmatter).
