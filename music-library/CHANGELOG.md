# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4b of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `music_library.ts` is BYTE-FROZEN and the model `version` stays
`2026.07.17.1`; `manifest.yaml` is unchanged (no version bump).

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
