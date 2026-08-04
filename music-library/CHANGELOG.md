# Changelog

## 2026.08.04.1

Adds the **wanted derivation** — "what music do I want that I do not have" as a
derived, recomputable set rather than a stored status. Phase 1 of replacing the
unmaintained Headphones daemon. Additive only: two new methods, two new
resources, one new report, one new shared lib module; the `upgrades[]` entry is
identity (`upgradeAttributes: (old) => old`) because no stored resource is
reshaped.

The load-bearing design decision is that a want is a **value object**, not a row
with a status. `Wanted` is recomputed from scratch on every run, so it cannot
drift — in direct contrast to the system it replaces, whose mutable `Status`
column had drifted to 944 albums marked `Downloaded` against 703 actually
present on disk. There is deliberately no per-want `queued`/`snatched`/`done`
field; downstream acquisition state belongs to the acquisition context, keyed by
want identity, never written back onto the want.

- **New method `resolve-artists`** — builds a cached artist-name →
  MusicBrainz-ID map. Seeds free from the ~1,375 MB-keyed artists already in a
  headphones instance, then falls back to token-set MusicBrainz search for
  library artists the seed does not cover. Ambiguous and unresolved artists are
  **parked for human review, never guessed** — a name matching two distinct
  MBIDs is a legitimate ambiguous outcome, not something to resolve by picking
  the first candidate. `resolved`/`ambiguous`/`unresolved` are top-level
  counters on the written resource so a run that parked 300 artists is visibly
  different at the CLI from one that resolved them.
- **New method `wanted`** — a pure derivation (no network; the test task grants
  no `--allow-net`, which enforces it structurally) over the cached artist map,
  the MusicBrainz `browse` cache, and the existing gonic-sourced album cube.
  Emits `missing` albums and `upgrade` candidates (owned but below a target
  quality bucket). Entries are deliberately flat so a
  `swamp data query
  --select` expression reaches `artist`, `releaseGroupId`,
  `kind` and quality without traversing nested optionals — this repo queries
  with `--select`, not `jq`, so the field shape is a consumer contract and is
  pinned by a fixture test.
- **New shared lib `extensions/lib/artist_match.ts`** — order-independent
  token-set artist matching plus Lucene metacharacter escaping. The matcher
  exists because exact-string matching against MusicBrainz fails in BOTH
  directions: MB returns person names in sort form, so `Miles Davis` is wrongly
  rejected against `Davis, Miles`, while same-token artists are wrongly accepted
  at score 100 (`Bill Brown` → `James Brown`, `Two Worlds II` →
  `Oscar
  Hammerstein II`). Escaping matters because real artist names carry
  Lucene metacharacters — `AC/DC`, `Godspeed You! Black Emperor`,
  `[dunkelbunt]`, `Therapy?`, `Sunn O)))`, `+/-`; a property test asserts no
  unescaped metacharacter survives for arbitrary input.
- **New shared lib `extensions/lib/wanted.ts`** — the derivation itself. Title
  matching reuses `normDupeKey` rather than introducing a second normaliser.
  Certain/uncertain/miss is exact key equality / token-subset containment / no
  relation, and an uncertain match defaults to **present** so a fuzzy title
  never triggers a junk download; the bias is a documented method argument,
  tested in both directions.
- **New shared lib `extensions/lib/norm.ts`** — `normDupeKey` and `isNoiseGroup`
  extracted from `music_library.ts`. This breaks a genuine import cycle: `lib/`
  is the dependency-free pure-domain layer that models import FROM, and having
  `lib/wanted.ts` reach back into a 3,128-line model file inverted that. The
  model re-exports `normDupeKey`, so existing importers are unchanged. Pure
  move, no behaviour change.
- **New report `@magistr/music-wanted`** — renders the gap: totals, missing by
  artist, upgrade candidates grouped by current quality, and the artists parked
  as ambiguous/unresolved. That last section is the point of parking rather than
  guessing, so it is first-class output, not an appendix.
- **Fixed (pre-existing)** — `running`'s "no bpm analysis" error interpolated
  `context.modelName`, which is not a field on swamp's `MethodContext`, so users
  were told to run `swamp model method run undefined bpm`. Now
  `context.definition.name`. The bug survived a Grade-A five-suite test corpus
  because the existing assertion stopped at the static prefix and never
  inspected the interpolated value, and because the test fake invented a
  `modelName` field — so the double agreed with code the runtime disagreed with.
  The new regression test asserts the resolved instance name appears AND that
  the string `undefined` does not, and was verified to fail against the old code
  before being accepted.

## 2026.08.02.1

Real-fixes all 6 latent bugs characterized by the test-only backfill below
(tracked locally as `music-library-latent-bugs`, never filed to the Lab).
`music_library.ts` is no longer byte-frozen; the model `version` and
`manifest.yaml` both bump to `2026.08.02.1`, with an identity `upgrades[]` entry
(`upgradeAttributes: (old) => old` — no stored resource is reshaped, since every
change is either a defaulted global/method argument or an additive `BpmSchema`
field).

- **LB1 (MEDIUM) fixed** — `verify`'s remote ffmpeg decode loop now wraps every
  file in the shell `timeout` command (sized from the new defaulted
  `ffmpegDecodeTimeoutSec` global arg, default 600s; 0 = no timeout), detected
  once per worker via `command -v timeout` so it degrades gracefully if the
  container lacks it — mirrors bpm's ANALYZE_PY `signal.alarm(timeout)`.
  `sshRun` also gained an optional client-side `AbortController` transport
  ceiling (timer always cleared in `finally`, never `AbortSignal.timeout()`) as
  a belt-and-suspenders guard sized generously per worker so it only fires if
  the remote `timeout` itself failed or ssh/network wedged.
- **LB2 (MEDIUM) fixed** — `verify`/`bpm`/`probe`'s single-`path` argument now
  resolves through two new shared, exported helpers — `normalizeSegments` (split
  on `/`/`\`, drop `.`/empty, pop on `..`, throw when `..` would escape the root
  — ported in spirit from obsidian-vault's segment guard) and
  `confineContainerPath` — instead of the old `replace(/^\/+/, "")` that
  stripped only leading slashes. A `../` traversal now throws
  `Error("Path escapes music root: …")` instead of resolving outside
  `containerMusicRoot`; a clean relative/absolute path still resolves
  identically to before.
- **LB3 (LOW) fixed** — `probe` now guards `JSON.parse` on the ffprobe output:
  empty stdout throws a clean `Error` naming the file instead of a raw
  `JSON.parse("")` `SyntaxError`, and unparseable non-empty stdout is caught and
  rethrown as a typed `Error` too (mirrors juick's `JSON.parse` → typed-error
  pattern).
- **LB4 (LOW) fixed** — `verify`'s US(0x1f)/RS(0x1e) record framing is now
  RS-safe: before splitting on `\x1f`, any `\x1e`-delimited fragment whose
  leading field is not a KNOWN cpath is treated as the tail of the previous
  record's ffmpeg output (which happened to contain a stray RS byte) and
  re-folded back onto it, rather than being parsed as an unmatchable orphan
  record. A corrupt file whose ffmpeg output embeds an RS byte is now correctly
  classified as `errors` instead of silently passing as `ok`.
- **LB5 (LOW) fixed** — `bpmMedian` now uses a proper median (new exported
  `median()` helper): an even-length bpm array averages the two middle sorted
  values instead of returning the upper one (`bpms[Math.floor(n / 2)]`).
- **LB6 (LOW) fixed** — `bpm` gained a `maxTracks` method arg (default
  **50000**, deliberately far higher than verify's 2000 — see below) plus
  `tracksTruncated`/`failuresTruncated` on `BpmSchema`. All stats (`bpmMedian`,
  `confidenceBands`, `bpmHistogram`) are computed over the FULL carried-over +
  newly-analyzed set BEFORE any truncation; only the STORED `tracks`/`failures`
  arrays are capped, mirroring verify's
  `problems: problemsTruncated ? problems.slice(0, 2000) : problems`. The
  default is high (not verify's 2000) because capping the stored array degrades
  bpm's resume carry-over (a library bigger than the cap would re-analyze the
  overflow every run) and the `running` method's input; pass `maxTracks: 0` for
  full resume fidelity on a very large library.
- Pin flips in `music_library_adversarial_test.ts`: all 6 `pin: KNOWN BUG` tests
  are now `fixed (music-library-latent-bugs LBn)` assertions of the corrected
  behavior (LB1 also gained a quick-mode variant, an
  AbortSignal-transport-ceiling check, and a `ffmpegDecodeTimeoutSec=0` disable
  check; LB2 gained a clean-relative-path anti-over-rejection positive; LB6
  gained a default-does-not-truncate companion test). The 2 regression-pinned
  positives (P1 static-SQL, P2 shQuote + control-byte filename filtering), the
  hostile host/sshUser safety test, and both fixtures-secret-scan tests are
  UNCHANGED (byte-identical). New direct unit tests for
  `normalizeSegments`/`confineContainerPath`/`median` were added to
  `music_library_coverage_test.ts`.

## Unreleased (superseded by 2026.08.02.1 above)

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4b of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change at the time — `music_library.ts` was BYTE-FROZEN and the model `version`
stayed `2026.07.17.1`; `manifest.yaml` was unchanged (no version bump). (The 6
latent bugs characterized here were real-fixed in `2026.08.02.1` above.)

- Added `extensions/models/music_library_methods_test.ts` (methods),
  `music_library_adversarial_test.ts` (adversarial),
  `music_library_coverage_test.ts` (coverage), and
  `music_library_property_test.ts` (property-invariant-flow). The
  contract-fixture suite (`music_library_test.ts` +
  `extensions/reports/verify_triage_test.ts`) was already present and is
  unchanged.
- Added `fixtures/` — pure hand-authored, synthetic `sqlite3 -json` row arrays
  (`tracks.json` for `TRACKS_SQL`, `genres.json` for `GENRES_SQL`,
  `verify_files.json` for `VERIFY_SQL`) plus a synthetic `ffprobe` JSON output
  (`probe.json`) and `PROVENANCE.md`. No live call was made against any real
  `@magistr/music-library` instance in this homelab; every artist/album/track
  name is an invented placeholder, and the SSH target hostname is the RFC 2606
  reserved `music.example`.
- Every suite drives `model.methods.<m>.execute()` against ONE stubbed
  `Deno.Command` seam — `sshRun`'s `.spawn()` -> `stdin.getWriter()` ->
  `write`/`close` -> `output()` boundary (the SAME dual shape as
  `observability-agent`'s stub, NOT `skype`'s `.output()`-only shape, since
  every method here funnels through the single `sshRun` helper) — reassigned via
  `(globalThis as any).Deno.Command =`, never a `as typeof Deno.Command` cast,
  restored in `finally`. The stub routes canned output by content- sniffing the
  captured argv's trailing command string and, for the `sqlite3` calls, the
  captured stdin SQL text — never by call order alone, since `scan` issues
  `TRACKS_SQL` then `GENRES_SQL` back to back against the identical
  `sqlite3 -json -readonly '<dbPath>'` argv. `running()` touches no ssh at all —
  it reads a stored `bpm` resource via a stubbed `context.readResource`.
- Pins 6 latent bugs plus 2 regression-pinned positives, characterized rather
  than fixed (source frozen). Filed against the LOCAL `@magistr/issue-lifecycle`
  model `music-library-latent-bugs` — never the Lab:
  1. **LB1 (MEDIUM)** — `verify`'s remote ffmpeg decode loop has NO per-file
     timeout, unlike `bpm`'s `ANALYZE_PY` (`signal.alarm(timeout)`); a single
     wedged/oversized file hangs the rest of that worker's chunk forever.
  2. **LB2 (MEDIUM)** — `verify`/`bpm`/`probe`'s `path` argument strips only
     LEADING slashes (`replace(/^\/+/, "")`), never `../` — a hostile `path`
     traverses outside `containerMusicRoot` verbatim.
  3. **LB3 (LOW)** — `probe` on an `ffprobe` call that exits 0 with empty stdout
     crashes with a raw, unwrapped `SyntaxError` from `JSON.parse("")` instead
     of a clean, actionable error.
  4. **LB4 (LOW)** — `verify`'s US(0x1f)/RS(0x1e) record framing is not RS-safe:
     the `safe` filter only screens INPUT filenames for control bytes, never
     ffmpeg's OWN captured stderr/stdout text — an embedded RS byte in that text
     can split one real record in two and silently MISCLASSIFY a corrupt file as
     `ok`.
  5. **LB5 (LOW)** — `bpmMedian` on an EVEN track count returns the UPPER of the
     two middle sorted values (`bpms[Math.floor(n / 2)]`) instead of averaging
     them.
  6. **LB6 (LOW)** — `bpm`'s carried-over `tracks`/`failures` arrays have NO
     size cap or truncation flag anywhere in `BpmSchema`, unlike `verify`'s
     explicit `problems.slice(0, 2000)` + `problemsTruncated`.
  7. **Positive** — `TRACKS_SQL`/`GENRES_SQL`/`VERIFY_SQL` are fully static
     constants; no method or global argument is ever concatenated into SQL text,
     so there is no SQL-injection surface at all. Regression-pinned.
  8. **Positive** — `shQuote`'s POSIX single-quote escaping is correct, and the
     `safe` control-byte filename filter runs before any path reaches the
     newline-delimited ssh stdin protocol — together these close off command
     injection via a hostile filename or `dbPath`. Regression-pinned.
- `deno.json`: `test` task stays subprocess-less and network-less
  (`--allow-env=FC_NUM_RUNS` only, no `--allow-run`/`--allow-net`/
  `--allow-read`) — a mis-stubbed test that constructs a real
  `Deno.Command("ssh")` fails `PermissionDenied` instead of SSHing a real host
  and running a destructive `verify`/`bpm`. Added the new suites to
  `check`/`test`; added `test:soak` for the high-count nightly property soak
  (`FC_NUM_RUNS=10000`).
- `deno.lock`: regenerated for the new dev-only test deps (`jsr:@std/assert@1`,
  `npm:fast-check@4.8.0`); the bundler inlines npm deps at bundle time, so the
  lockfile only covers local `deno
  test`/`deno check`, never the published
  extension bundle.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (music-library
  bundles no Claude skill — a gonic-index catalog model, nothing to document as
  a skill). Ratchet recorded at 100/"Grade A". Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.17.1

Initial release: multidimensional music library catalog built from a gonic scan
index over SSH — `scan` (album/artist/dimension/issues star schema), `dupes`
(duplicate album/track clusters), `verify` (playback-integrity check via
ffmpeg), `bpm` (tempo analysis via essentia), `running` (cadence-matched
playlist from a `bpm` resource), and `probe` (deep per-file ffprobe).
Tag-encoding recovery (cp1251/koi8-r/cp866/Shift-JIS/GBK mojibake,
double-encoded UTF-8) and directory/filename naming fallback for untagged
tracks.
