# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2b full build of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `headphones.ts` is unmodified and the model `version` stays
`2026.07.27.1`.

- Added `extensions/models/headphones_test.ts` (contract-fixture, 12 tests),
  `extensions/models/headphones_methods_test.ts` (methods, 69 tests),
  `extensions/models/headphones_adversarial_test.ts` (adversarial, 15 tests),
  `extensions/models/headphones_coverage_test.ts` (coverage, 34 tests),
  `extensions/models/headphones_property_test.ts` (property-invariant-flow, 6
  tests) — 136 tests total, 0 before this change. Every one of the 29 methods is
  exercised (enumerated, not sampled).
- Added `fixtures/` — doc/source-derived synthetic Headphones API wire-shape
  fixtures (`getVersion`, `getIndex`, `getArtist`, `getArtist.loading`,
  `findArtist`, `getAlbum`, `getWanted`, `getHistory`, `getLogs`, `error.html`,
  `audit.rows`) plus `PROVENANCE.md`. No live call was made against the
  `headphones` instance, and the `HEADPHONES_API_KEY` vault entry was never read
  — every value is synthetic (`.example`/`.test` placeholder hosts, synthetic
  MusicBrainz-shaped ids, RFC-reserved-style placeholders). The real homelab
  host (`headphones.aopab.art`) is explicitly denylisted by the adversarial
  suite's fixtures-secret-scan.
- **Wire-shape finding (resolved via upstream source, not live capture)**:
  reading `rembo10/headphones`'s `headphones/api.py` directly (public GitHub)
  confirms `getArtist`'s `artist` key — and, by the identical `_dic_from_query`
  mechanism, `getAlbum`'s `album` key — are single-element **arrays** on the
  wire, not objects. `getArtist.json`/`getAlbum.json` are fixtured to this real
  shape, and the contract/methods suites pin `get-artist`/`get-album`'s
  non-unwrapping `artist: data.artist || data` / `album: data.album || data` as
  a documented latent bug (get-artist was the round-1 adversarial HIGH;
  get-album is the same defect class, found by extending the same
  source-diligence to a structurally identical method).
- **Filed the follow-up hardening issue `headphones-apikey-hardening`** (triaged
  high/security) tracking: the apikey-in-URL-query leak through an unwrapped
  `fetch()` rejection (27/29 methods, no try/catch in `api()`/ `webUi()`); the
  get-artist/get-album non-unwrap latent bug above; the `unqueue-album` →
  `onboard-artists` Skipped-requeue clobber (pinned as an explicit flow test in
  the property suite); and `audit-library`'s unvalidated `maxDepth` (no
  `.int()`/`.min()`). The adversarial suite's credential honest-gap test and
  this file both reference the real issue id (telegram-send precedent), not a
  dangling "to be filed" placeholder.
- `deno.json`: default `test` task stays network-less (no `--allow-net`),
  run-less (`Deno.Command` stubbed, no `--allow-run`), and file-permission-less
  (no `--allow-read`; the HTML fixture is duplicated as a byte-identical string
  literal in-source rather than read at runtime), scoped to
  `--allow-env=FC_NUM_RUNS`; added `test:soak` (`FC_NUM_RUNS=10000`) for the
  high-count nightly property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (headphones
  bundles no Claude skill); `watch`/`canary` stay `backlog` (Phase B/C not
  shipped yet; allowlist-exempt per STANDARD.md). Ratchet measured live via
  `swamp extension quality headphones/manifest.yaml
  --json`:
  `rubricVersion: 3`, `100%`, label `Grade A`. Removed `headphones` from
  `quality-allowlist.txt` in the same change.
- **Known gap, noted not fixed** (source is byte-frozen by this change):
  `README.md`'s example instance definition shows
  `typeVersion:
  "2026.05.25.1"` while `manifest.yaml` is `2026.07.27.1` —
  stale doc drift, LOW, out of scope for a test-only backfill.

## 2026.07.27.1

Added bulk onboarding: `set-extras` (enable extra release types for an artist
via the web-UI `getExtras` form — the only surface Headphones exposes for it)
and `onboard-artists` (idempotent fan-out: add artist, enable extras, wait for
the MusicBrainz import to settle, queue every not-yet-active release).

## 2026.05.25.1

Initial release: artist CRUD (`get-index`, `get-artist`, `find-artist`,
`add-artist`, `del-artist`, `pause-artist`, `resume-artist`, `refresh-artist`),
album operations (`get-album`, `add-album`, `find-album`, `queue-album`,
`unqueue-album`), list views (`get-wanted`, `get-snatched`, `get-upcoming`,
`get-history`), system actions (`force-search`, `force-process`,
`force-active-artists-update`, `get-version`, `check-github`, `get-logs`,
`clear-logs`, `restart`, `update`), and an SSH-backed `audit-library`
cross-check.
