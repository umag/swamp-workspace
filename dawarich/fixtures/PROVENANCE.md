# Fixture provenance

Every JSON file in this directory is **pure doc-derived** — hand-authored from
the [Dawarich](https://dawarich.app) OpenAPI spec (`swagger/v1/swagger.yaml` in
[Freika/dawarich](https://github.com/Freika/dawarich)) and, where the spec was
thin, the actual Rails controller/serializer source in that repository — **never
captured from a live call**. This mirrors the `porkbun`/`tubearchivist`
precedent (synthetic fixtures, no live capture) and is a deliberate security
decision, not an oversight.

## Location data gets a DOUBLED control, not the standard one

Every other extension's fixture corpus in this repo defends secrets (API keys,
tokens). This one ALSO carries **personal location history** — GPS coordinates,
visit timestamps, place names. A leaked real coordinate does not just leak a
credential; it can reveal a home address, workplace, or daily routine. Two
independent, layered controls exist because of this:

1. **PRIMARY control — exact-value coordinate allowlist.** Every `latitude` /
   `longitude` (and `lat` / `lng` / `lon`) leaf value anywhere in this fixture
   corpus MUST be an exact member of the `SYNTHETIC_COORDS` set defined once in
   `../extensions/models/dawarich_test.ts` and re-used (imported, never
   redefined) by the coordinate scan in
   `../extensions/models/dawarich_adversarial_test.ts`. This is **equality
   membership against a small, enumerated set** — never a bounding box or region
   — because a wide "synthetic-looking" region could still silently admit a real
   place. `SYNTHETIC_COORDS` holds exactly five famous, globally documented
   public landmarks, each about as far from the Netherlands/Italy as the globe
   allows: the Sydney Opera House, Christ the Redeemer (Rio de Janeiro), the
   Mount Everest summit, Uluru/Ayers Rock, and Ushuaia (Argentina, the world's
   southernmost city). None of these is anyone's home, workplace, or private
   routine — they are tourist landmarks with Wikipedia-published coordinates.
2. **SECONDARY tripwire — coarse country-level denylist.** The adversarial suite
   additionally checks every scanned coordinate against a COARSE Netherlands
   bounding box (whole-country granularity, `50.75–53.7°N,
   3.2–7.22°E` —
   public knowledge, not a precise location). This is a defense-in-depth
   backstop only; the exact-value allowlist above is the real control. The
   denylist box is deliberately kept at country granularity so that the file
   defending against a leaked precise coordinate never itself becomes a
   repository of one.

The coordinate scan walks fixture objects and inspects values **only under
coordinate-shaped field names** (`latitude`, `longitude`, `lat`, `lng`, `lon`) —
it does not treat every numeric leaf as a candidate coordinate, so
`year`/`month`/`count`/pagination integers elsewhere in these fixtures are never
false-flagged (round-1 plan-review LOW finding, folded in).

## What was NOT done (explicit prohibition)

A live `my-atlas` (`@magistr/atlas`, Dawarich-compatible) instance **does
exist** in this homelab, tracking the user's own real location history. **Live
capture from ANY Dawarich instance — this one or any other — is FORBIDDEN** for
this fixture corpus. This is not "not done this time"; it is a standing rule for
anyone regenerating these fixtures later, because the data these endpoints
return is the user's real personal location history:

- No `swamp model method run my-atlas <method>` (or any other Dawarich instance)
  call was made while authoring these fixtures.
- No vault credential (the Dawarich API `api_key`) was read, exported, or
  otherwise touched.
- No real point, visit, track, or photo from any location history this or any
  other instance manages appears anywhere below.
- The one mutating endpoint (`update-settings` / `PATCH /api/v1/settings`) was
  never invoked against a live API — its fixture shape is transcribed from the
  controller source, not an observed side effect.

The fixtures-secret-scan and coordinate-allowlist-scan tests in
`../extensions/models/dawarich_adversarial_test.ts` are **mechanical
backstops**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place, plus the exact-value
allowlist above. Since these fixtures are authored-synthetic rather than
captured-and-redacted, the residual leak risk the scans defend against is
near-zero; do not treat the heuristic scans as a guarantee that would also hold
for genuinely captured data.

## Every value is synthetic

- Coordinates: exclusively the five `SYNTHETIC_COORDS` landmark pairs (Sydney
  Opera House `-33.8568, 151.2153`; Christ the Redeemer `-22.9519, -43.2105`;
  Mount Everest summit `27.9881, 86.9250`; Uluru/Ayers Rock
  `-25.3444,
  131.0369`; Ushuaia `-54.8019, -68.3030`) — public, published,
  non-personal.
- Base URL: none appears inside the fixture JSON itself (supplied by the test
  harness `GLOBAL_ARGS`, always `https://dawarich.example.com` — IANA's reserved
  example domain, [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)).
- `api_key`: never a fixture value — it is a global argument supplied only by
  the test harness (`dw_test_stub_do_not_log`, plus a distinct
  `dw_trust_boundary_sentinel_0001` for the hostile-echo pin), never committed
  JSON.
- Point/track/photo ids: small synthetic integers (`1001`, `9001`, …) or
  synthetic string ids (`synphoto-0001`) — never a real Dawarich record id.
- Place/city/country names: the landmarks' actual public city/country
  (`Sydney`/`Australia`, `Rio de Janeiro`/`Brazil`) — public geographic facts
  about a tourist landmark, not anyone's private location.
- Timestamps: `2026-01-15T09:00:00Z` and similar — synthetic placeholders in the
  repo's current working year, not observed data.

## Per-file mapping to the documented endpoint

| File                  | Documented endpoint                           | Consumed by                   |
| --------------------- | --------------------------------------------- | ----------------------------- |
| `health.json`         | `GET /api/v1/health`                          | `health`                      |
| `stats.json`          | `GET /api/v1/stats`                           | `stats`                       |
| `points.json`         | `GET /api/v1/points`                          | `points`                      |
| `tracked-months.json` | `GET /api/v1/points/tracked_months`           | `tracked-months`              |
| `visits.json`         | `GET /api/v1/visits`                          | `visits`                      |
| `tracks.json`         | `GET /api/v1/tracks` (simplified — see below) | `tracks`                      |
| `settings.json`       | `GET /api/v1/settings`                        | `settings`, `update-settings` |
| `digests.json`        | `GET /api/v1/digests`                         | `digests`                     |
| `photos.json`         | `GET /api/v1/photos`                          | `photos`                      |

## Documented API quirks this corpus deliberately preserves — and one it deliberately does NOT

**`settings.json` / `digests.json` preserve a real double-wrap.** The live
Dawarich `GET/PATCH /api/v1/settings` endpoint wraps its payload as
`{"settings": {...}, "status": "success"}` (confirmed from
`app/controllers/api/v1/settings_controller.rb`), and `GET /api/v1/digests`
wraps as `{"digests": [...], "availableYears": [...]}` (confirmed from
`app/controllers/api/v1/digests_controller.rb`). `dawarich.ts`'s `settings` /
`update-settings` / `digests` methods store `result.data` **verbatim** — the
whole wrapped envelope — under their own `settings` / `digests` resource field,
producing a double-nested shape (e.g. `resource.settings.settings.timezone`,
`resource.digests.digests[]`) rather than unwrapping to the inner object. These
fixtures are authored as the REAL wrapped shape specifically so the
contract-fixture suite pins this double-nesting rather than a
convenient-but-wrong flattened guess. Filed as an informational (LOW) item on
the local `dawarich-hardening` bug.

**`tracks.json` deliberately does NOT reproduce the real GeoJSON envelope — and
that gap is itself the finding.** The live Dawarich `GET /api/v1/tracks`
endpoint's serializer (`app/serializers/tracks/geojson_serializer.rb`) returns a
GeoJSON `FeatureCollection` **object** —
`{"type": "FeatureCollection", "features":
[...]}` — never a bare array.
`dawarich.ts`'s `tracks` method guards with
`Array.isArray(result.data) ? result.data : []`, which is **always false**
against that real shape, so the `tracks` method silently and permanently returns
an empty list against the actual shipped Dawarich API today — not a hypothetical
hostile-input scenario, a confirmed always-on defect. `tracks.json` here is
authored as a simplified, doc-plausible flattened array (matching the uniform
recipe every other array-based fixture in this corpus follows, and exercising
the method's intended "happy" branch) so the contract-fixture suite stays
consistent with its siblings; the REAL GeoJSON shape is instead exercised via a
small inline literal in `../extensions/models/dawarich_adversarial_test.ts` (not
a separate committed fixture file — this is edge-case-shaped, mirroring how
tubearchivist's adversarial suite covers alternate response branches with inline
literals rather than additional fixtures) that proves the real-shape response
collapses to `tracks: [], count: 0`. Filed as the escalated (MEDIUM) item on the
local `dawarich-hardening` bug, since it is confirmed rather than merely
possible.

**`stats.json` / `digests.json` also preserve a real scoping quirk.** The live
`stats`/`digests` controllers accept `year`/`month`/`period_type` query params
but never read them (confirmed from the controller source) — the response is
always the full multi-year history regardless of what was requested.
`dawarich.ts` still names its own resource instance after `args.year`/
`args.month`, implying a server-side scoping that does not actually happen. Not
pinned as a dedicated test (no observable difference in the _response body_ to
characterize — the gap is that the request params are ignored server-side), but
noted here and on the local bug for anyone regenerating these fixtures against a
real instance later.
