# Changelog

## 2026.08.01.1

Two changes land together in this release: the wave 2c test backfill to the
STANDARD.md five-suite quality bar (`ext-quality-test-backfill`), and — folded
in on top of it — fixes for the two HIGH findings the backfill's own adversarial
suite had characterized. Both fixes live in `fetchStatistics`
(extensions/models/homeassistant.ts), reached via `get-statistics` and
`backfill-to-vm`, and are tracked in the local `homeassistant-latent-bugs`
issue-lifecycle model (never a Lab issue — see
`swamp model get homeassistant-latent-bugs --json`):

- **WS clean-close hang (HIGH):** `fetchStatistics` now registers a
  `ws.addEventListener("close", ...)` handler. Previously, if the server closed
  the connection cleanly without ever sending a `result` message (no error, no
  `auth_invalid`), the call hung until the hardcoded 60s timeout. It now clears
  the timer and rejects immediately with "WebSocket closed before result". A
  `done` boolean guard (set in every terminal branch — `result`, `auth_invalid`,
  `error`, timeout) makes the promise's settle-once semantics explicit, since
  the model's own `ws.close()` after a successful result also fires this same
  listener.
- **WS result id-non-correlation (HIGH, defense-in-depth):** the command id sent
  in the `recorder/statistics_during_period` frame is now captured in a
  `requestId` const and the `result` branch is gated on `msg.id ===
  requestId`
  — a `type: "result"` frame carrying any other id is ignored (the call keeps
  waiting) instead of settling on the first result regardless of id. Harmless
  today (one command per socket, no multiplexing), but this closes the latent
  gap if the protocol usage ever adds concurrent in-flight commands on the same
  socket.
- Both fixes are behavior-preserving for legitimate single-command fetches —
  every existing `id:1` happy-path pin across all five suites stays green.
- Test flips in `homeassistant_adversarial_test.ts`: the former "NO msg.id
  correlation" pin is flipped to prove correlation (a foreign `id:999` result is
  ignored; the following matching `id:1` result resolves); the mid-sequence-drop
  pin's `closeListenerCount` assertion flips from `0` to `1` (a listener is now
  always registered, it just never fires for a silent drop with no close event);
  a new close-before-result fast-reject pin is added (real microtask, no
  `FakeTime`). The malformed-frame and `{kind:"none"}` silent-drop 60s-timeout
  pins are unchanged — neither scenario fires a close event, so both still
  legitimately hang to the timeout.
- `quality.yaml`: refreshed the stale "homeassistant.ts is unmodified" comment.

The rest of this release is the test backfill itself, unchanged from the prior
draft:

- Added `extensions/models/homeassistant_test.ts` (contract-fixture),
  `homeassistant_methods_test.ts` (methods), `homeassistant_adversarial_test.ts`
  (adversarial), `homeassistant_coverage_test.ts` (coverage),
  `homeassistant_property_test.ts` (property-invariant-flow) — 0 tests before
  this change.
- Added `fixtures/` — pure doc-derived, synthetic Home Assistant REST/WebSocket
  wire-shape fixtures (`states`, `services`, `automation-config`, `history`,
  `statistics-result`, `error`) plus `PROVENANCE.md`. No live call was made
  against any real Home Assistant instance; the long-lived access token used
  across every test file is a clearly-fake, deliberately non-JWT-shaped sentinel
  string, never the real `HA_TOKEN` vault value.
- Introduced a novel `FakeWebSocket` + `withWebSocketStub` test seam — the first
  WebSocket-in-test harness in this workspace — for `homeassistant.ts`'s one WS
  path (`fetchStatistics`, reached via `get-statistics` and `backfill-to-vm`). A
  scripted responder defers its first frame via `queueMicrotask` (the model
  calls `new WebSocket()` and only THEN attaches listeners), and every
  subsequent frame is delivered in response to the model's `send()`. Every
  global swap (`fetch` and `WebSocket`) uses the no-cast
  `(globalThis as any).X = stub` idiom, never an
  `as typeof globalThis.fetch`-style cast.
- Every suite drives `model.methods.<m>.execute()` against the stubbed
  `fetch`/`WebSocket` and a fake context, pinning already-shipped behavior —
  including several found bugs, characterized rather than fixed at the time
  (tracked in the local `homeassistant-latent-bugs` issue-lifecycle model, never
  the Lab). Two of them — id-non-correlation and the close-hang — are now FIXED
  above; the rest remain pinned as characterized:
  - ~~`fetchStatistics` performs NO `msg.id` correlation — it resolves on the
    first `type: "result"` message regardless of the id it sent, a latent gap if
    the protocol ever multiplexed concurrent commands.~~ Fixed above.
  - ~~No `close` event listener is ever registered on the WebSocket — a clean
    server-side close is exactly as invisible to the client as a silent
    connection drop; both hang until the hardcoded 60s timeout.~~ Fixed above.
  - A malformed (non-JSON) WS frame is silently swallowed (`catch { return; }`)
    rather than surfaced as a fast, actionable error.
  - Server-controlled strings are interpolated verbatim into thrown errors on
    both the WS path (`Auth invalid: ${msg.message}`) and the REST path (a
    401/404 response body) — a hostile or compromised HA instance echoing the
    caller's own token back would leak it, unredacted.
  - `get-state`, `call-service`, `get-automation-config`, and
    `update-automation` interpolate their path parameters raw (no
    `encodeURIComponent`), unlike `get-history`, which does encode.
  - `backfill-to-vm` has an error-semantics asymmetry: a per-entity `/states`
    REST failure is caught and swallowed to `{}`, while a per-entity WS
    `fetchStatistics` rejection is unguarded and tears down the entire fan-out
    across every entity.
  - `(msg.result && msg.result[statisticId]) || []` masks a
    success-but-missing-key response identically to a legitimately empty range.
  - The WS timeout (60000ms) is hardcoded, and every `ws.close()` call site is
    wrapped in a silently-swallowing `try/catch`.
  - `InputSchema.token` is a plain `z.string()`, never marked
    `.meta({ sensitive: true })`.
  - The CSV builders in `get-history`/`get-statistics` escape double-quotes but
    not commas — a comma-containing wire value corrupts the column count. Newly
    found during this backfill (not in the original plan's 9-item list), same
    bug class as the other unescaped-output gaps above.
- `deno.json`: default `test` task stays network-less (no `--allow-net` — the
  WS + fetch seams mean nothing ever reaches the network) and scoped to
  `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (homeassistant
  bundles no Claude skill). Ratchet re-measured via
  `swamp extension quality manifest.yaml --json`: 100% (rubricVersion 3, Grade
  A). Removed from `quality-allowlist.txt` in the same change.
- See also the local `homeassistant-port-registry-methods` issue-lifecycle
  model: the homelab's newer local variant of this extension additionally
  exposes `render-template`/`list-registry`/`assign-rooms` over the HA WebSocket
  registry API, absent from this published source — tracked as a follow-up port,
  out of scope for this test-only backfill.

## 2026.07.16.2

Initial release: entity/service/automation REST CRUD (`list-entities`,
`get-state`, `call-service`, `list-services`, `list-automations`,
`get-automation-config`, `update-automation`), historical state points
(`get-history`, JSON + CSV), long-term WebSocket statistics (`get-statistics`),
and bulk VictoriaMetrics backfill (`backfill-to-vm`) against a Home Assistant
instance.
