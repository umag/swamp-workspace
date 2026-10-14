# Fixture provenance

These fixtures are **hand-authored** from the documented response shape of the
NS Reisinformatie API (apiportal.ns.nl) — `GET /v2/stations`, `GET /v3/trips`
and `GET /v3/disruptions` — restricted to the fields
`extensions/models/ns_international.ts` actually reads. They were not captured
from a live call and contain no subscription key or personal data.

- `stations.json` — `payload[]` of stations (`code`, `UICCode`, `namen`, `land`,
  `lat`, `lng`), including one row without `UICCode` that the model must drop.
- `trips.json` — `trips[]` with `legs[]`, `productFare`, `fares[]`, status and
  crowding; one direct and one transfer option.
- `disruptions.json` — top-level array of disruptions, one with a numeric `id`
  and one without a `phase`.
