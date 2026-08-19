# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.1

Real-fixes the seven remaining MED/LOW findings (LB3–LB9) that the 2026.08.01.1
test backfill characterized but did not fix, in the local
`homeassistant-latent-bugs` issue-lifecycle model (never a Lab issue). Every
former "pinned-to-buggy" test is flipped to prove the corresponding fix; every
benign/frozen contract, methods, and property pin stays BYTE-IDENTICAL.

- **LB3 — non-JSON WS frame (MED):** `fetchStatistics`'s `message` handler no
  longer silently swallows a malformed frame (`catch { return; }`, waiting out
  the full 60s timeout). It now fast-rejects with a static
  `"WebSocket received a non-JSON frame"` error (never echoes the
  server-controlled `ev.data`, preserving the LB4 no-leak invariant).
- **LB4 — server-echoed token redaction (MED):** added `redactToken`/
  `redactedCause` helpers (value-based, telegram-send/headphones precedent).
  Applied at every server-echo throw site: WS `auth_invalid`, WS `error` event,
  WS `!success` result, `haFetch`'s non-ok response body AND a caught
  network-layer `fetch()` rejection (redacted `.message` + a fresh single-level
  redacted `cause` — never the raw error, since `Deno.inspect`/ console
  formatting walks `.cause` including its `.stack`), and the VM import non-ok
  error. Redaction is a strict no-op on any message that doesn't contain the
  token, so every benign error-path pin (auth_invalid with no token echo, native
  WS errors, the `error.json` contract body, all REST 404/500 pins) stays
  byte-identical.
- **LB5 — raw REST path interpolation (MED):** wrapped every interpolated path
  segment in `encodeURIComponent` — `get-state`, `call-service`,
  `get-automation-config`, `update-automation`, and the per-entity `/states`
  lookup inside `backfill-to-vm`. Identity for benign ids (letters, digits,
  dots, underscores are unreserved), so every frozen URL contract pin stays
  byte-identical; only a literal `/` (or other reserved char) is now escaped
  into one opaque `%2F` segment instead of injecting an extra path segment.
- **LB6 — token not marked sensitive (LOW):** `InputSchema.token` now carries
  `.meta({ sensitive: true })` (matches telegram-send's `botToken`).
- **LB7 — asymmetric backfill fan-out (LOW):** `backfill-to-vm`'s per-entity
  `fetchStatistics` call is now guarded exactly like the existing `/states`
  guard (headphones onboard-artists / seadex `summary.errors` precedent): a
  failure records a redacted `error` on that entity's `backfill-report` summary,
  logs a redacted warning, skips its samples, and the fan-out CONTINUES to the
  next entity instead of tearing down the whole method. Added an additive,
  optional `entities[].error` field to the `backfill-report` resource schema.
- **LB8 — statistics missing-key vs. empty-range (LOW):** replaced
  `(msg.result && msg.result[statisticId]) || []` with an explicit four-way
  branch: (1) the requested `statisticId` key is present → resolve it verbatim
  (including an explicit `[]`); (2) `result` is an object with ZERO keys →
  resolve `[]` — Home Assistant omits the key entirely for a **legitimately
  empty range**, so this is NOT an error; (3) `result` has OTHER keys but not
  ours → reject `"Statistics response omitted requested
  statistic '<id>'"`
  (anomalous — we only ever request one id); (4) `result` is falsy/not an object
  → reject `"Statistics response missing result
  payload"` (malformed). A new
  test pins the empty-object-is-legit-empty case explicitly so a future change
  can't accidentally make it throw.
- **LB9 — hardcoded WS timeout + swallowed close errors (LOW):** added a
  defaulted `wsTimeoutMs` global argument
  (`z.number().int().positive()
  .default(60000)`) threaded into
  `fetchStatistics`; both `get-statistics` and `backfill-to-vm` read
  `context.globalArgs.wsTimeoutMs ?? 60000`. The default renders the
  byte-identical `"WebSocket timeout after 60s"` message. Every
  `try { ws.close() } catch {/*ignore*/}` call site is replaced by a
  `closeQuietly` helper that still NEVER re-throws or changes the rejection
  reason, but now surfaces the (redacted) close failure via
  `context.logger.warning`.
- **Pin flips:** adversarial `:415` (malformed frame, drop FakeTime),
  `:475`/`:584` (WS/REST token echo → asserts redacted), `:499`/`:518`/`:533`
  (raw path injection → asserts `%2F`-escaped); coverage `:251`/`:269`
  (statistics wrong-key/falsy-result → asserts the new rejection messages) and
  `:767` (token meta → asserts `sensitive === true`); methods `:724` (backfill
  fan-out → asserts the method now RESOLVES with a per-entity `error`). New
  tests: statistics empty-object-is-legit-empty, a mid-handshake non-JSON frame,
  a custom `wsTimeoutMs` timeout, a surfaced-and-redacted close error, and two
  logs-never-leak-the-token tests (satisfying the methods suite's own "a change
  that starts logging must add its own leak test" pin contract).
- **Versioning:** `manifest.yaml`/`model.version` bumped to `2026.08.02.1`.
  Added a two-entry, identity `upgrades[]` array — the LB1/LB2 lineage-repair
  bridge from `2026.07.16.2` → `2026.08.01.1`, plus this release's
  `2026.08.01.1` → `2026.08.02.1` entry. Both are `(old) => old`: every schema
  change here is additive (optional `entities[].error`) or a defaulted global
  arg (`wsTimeoutMs`), so no stored resource data needs migrating.
- `quality.yaml`: re-stamped via
  `swamp extension quality manifest.yaml
  --json` — still 100% (rubricVersion
  3, Grade A), five suites present. The header comment's "characterized
  (pinned), not fixed" wording is dropped: LB3–LB9 are now real-fixed and every
  suite proves it.

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
  the Lab). As of 2026.08.02.1, ALL nine originally tracked items (LB1–LB9) are
  FIXED — see that section above for the real-fix details and pin flips:
  - ~~`fetchStatistics` performs NO `msg.id` correlation — it resolves on the
    first `type: "result"` message regardless of the id it sent, a latent gap if
    the protocol ever multiplexed concurrent commands.~~ Fixed (LB1,
    2026.08.01.1).
  - ~~No `close` event listener is ever registered on the WebSocket — a clean
    server-side close is exactly as invisible to the client as a silent
    connection drop; both hang until the hardcoded 60s timeout.~~ Fixed (LB2,
    2026.08.01.1).
  - ~~A malformed (non-JSON) WS frame is silently swallowed
    (`catch { return; }`) rather than surfaced as a fast, actionable error.~~
    Fixed (LB3, 2026.08.02.1).
  - ~~Server-controlled strings are interpolated verbatim into thrown errors on
    both the WS path (`Auth invalid: ${msg.message}`) and the REST path (a
    401/404 response body) — a hostile or compromised HA instance echoing the
    caller's own token back would leak it, unredacted.~~ Fixed (LB4,
    2026.08.02.1).
  - ~~`get-state`, `call-service`, `get-automation-config`, and
    `update-automation` interpolate their path parameters raw (no
    `encodeURIComponent`), unlike `get-history`, which does encode.~~ Fixed
    (LB5, 2026.08.02.1).
  - ~~`backfill-to-vm` has an error-semantics asymmetry: a per-entity `/states`
    REST failure is caught and swallowed to `{}`, while a per-entity WS
    `fetchStatistics` rejection is unguarded and tears down the entire fan-out
    across every entity.~~ Fixed (LB7, 2026.08.02.1).
  - ~~`(msg.result && msg.result[statisticId]) || []` masks a
    success-but-missing-key response identically to a legitimately empty
    range.~~ Fixed (LB8, 2026.08.02.1).
  - ~~The WS timeout (60000ms) is hardcoded, and every `ws.close()` call site is
    wrapped in a silently-swallowing `try/catch`.~~ Fixed (LB9, 2026.08.02.1).
  - ~~`InputSchema.token` is a plain `z.string()`, never marked
    `.meta({ sensitive: true })`.~~ Fixed (LB6, 2026.08.02.1).
  - The CSV builders in `get-history`/`get-statistics` escape double-quotes but
    not commas — a comma-containing wire value corrupts the column count. Newly
    found during this backfill (not in the original plan's 9-item list), same
    bug class as the other unescaped-output gaps above — still characterized
    (pinned), out of scope for the LB1–LB9 fix pass.
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
