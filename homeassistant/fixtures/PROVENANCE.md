# Fixture provenance

Every JSON file in this directory is **pure doc-derived synthetic data**,
hand-authored from the published
[Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
and [WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
documentation (including the `recorder/statistics_during_period` long-term
statistics command). No file here was captured from a live call. This mirrors
the `porkbun`/`victorialogs` precedent (synthetic fixtures, no live capture) and
is a deliberate security decision, not an oversight.

## What was NOT done (standing prohibition)

A live Home Assistant instance and a vault holding its long-lived access token
(`HA_TOKEN`) **do exist** in this homelab. **Live capture from that instance is
FORBIDDEN** for this fixture corpus — not "not done this time", but a standing
rule for anyone regenerating these fixtures later:

- No `swamp model method run <live-ha-instance> <method>` call was made while
  authoring these fixtures.
- No vault credential (the `HA_TOKEN` value) was read, exported, or otherwise
  touched.
- No real entity id, area name, automation id/alias, or device attribute from
  the real homelab HA instance appears anywhere below.
- The long-lived access token used across every test file is an explicit,
  clearly-fake **non-JWT sentinel string** (`FAKE_HA_TOKEN_never_a_real_jwt`),
  never a real Home Assistant JWT-shaped token, and never captured from the
  `HA_TOKEN` vault.

The fixtures-secret-scan test in
`../extensions/models/homeassistant_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place.

## Fixtures are RESPONSE bodies only — no request-side credential surface

Every file in this directory is a **server response body** the model would
receive over REST or WebSocket. None of them is a request, so none of them ever
carries an `Authorization` header, a WebSocket `auth` frame, or the access token
itself — the token-in-fixture leak surface is structurally zero. This mirrors
the security review's residual LOW finding on the porkbun/victorialogs
precedents: the fixtures-secret-scan is defense-in-depth over a corpus that has
no credential surface to begin with, not a guarantee that would also hold for
genuinely _captured_ (rather than hand-authored) data.

The WS handshake envelopes (`auth_required`, `auth_ok`, `auth_invalid`) are
likewise never committed as fixture files — they are tiny, protocol-level frames
built **inline** in each test file (and in the shared `FakeWebSocket` test
harness), not response payloads worth pinning as a corpus artifact.

## Every value is synthetic

- Host: `ha.example.test` — a subdomain of IANA's reserved `.test` TLD
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)), never the real homelab
  HA hostname.
- Entity ids: `light.example_lamp`, `switch.example_switch`,
  `sensor.example_temperature`, `binary_sensor.example_motion`,
  `automation.example_alarm` — all use the `example_` infix precisely so no
  fixture entity id can be confused with (or collide with) a real entity id from
  the live homelab HA instance.
- Automation id: `1700000000000` — a synthetic millisecond-epoch-shaped
  placeholder (matching the documented `attributes.id` format), not a real
  automation id.
- VictoriaMetrics backfill target: `203.0.113.10` — the `TEST-NET-3`
  documentation range ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)),
  which is also `homeassistant.ts`'s own hardcoded default `vmUrl`/`instance`
  placeholder — no coincidence, since the model's author already chose a
  documentation-only address for that default.
- Long-term statistics timestamps: `1735689600000` / `1735693200000` /
  `1735696800000` — synthetic epoch-millisecond values (2025-01-01 UTC and
  neighboring hours), not derived from any real recorder data.
- Long-lived access token used in every test file: the literal string
  `FAKE_HA_TOKEN_never_a_real_jwt` — deliberately NOT JWT-shaped (no `eyJ`
  prefix, no dot-separated segments) so it can never be mistaken for a real Home
  Assistant long-lived token, and so the fixtures-secret-scan's JWT pattern has
  a true negative to run against.

## Per-file mapping to the documented endpoint / wire shape

| File                     | Documented endpoint / command                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `states.json`            | `GET /api/states` — full entity-state array (backs `list-entities`, `list-automations`, and per-entity lookups in `get-state`/`backfill-to-vm`) |
| `services.json`          | `GET /api/services` — domain/service catalog (backs `list-services`)                                                                            |
| `automation-config.json` | `GET /api/config/automation/config/<id>` — full automation config (backs `get-automation-config`, `update-automation`)                          |
| `history.json`           | `GET /api/history/period/<start>` — array-of-arrays state history (backs `get-history`)                                                         |
| `statistics-result.json` | WS `recorder/statistics_during_period` result envelope (backs `get-statistics`, `backfill-to-vm`)                                               |
| `error.json`             | Generic Home Assistant REST error envelope (`{"message": "..."}`, any endpoint)                                                                 |

## A documented API quirk this corpus deliberately preserves

Home Assistant's `/api/states` sensor state values are wire **strings**
(`"state": "21.5"`), never JSON numbers, even for numeric sensors — the
consuming client is expected to parse them. `homeassistant.ts`'s resource
schemas use `z.any()`/`z.string()` for exactly these fields and never coerce
them; `statistics-result.json`'s aggregate fields (`mean`/`min`/`max`/ `sum`),
by contrast, are wire **numbers** in the WS statistics API, and
`last_reset`/`sum` are legitimately `null` for a sensor with no reset cycle
(matching a `state_class: measurement` sensor, as opposed to `total`/
`total_increasing`, which would carry a non-null `sum`). The contract-fixture
suite pins both of these asymmetric wire types so a future Home Assistant API
change — or a future `homeassistant.ts` refactor that "helpfully" tightens
either schema — turns a test red instead of passing silently.
