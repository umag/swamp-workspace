# Changelog

## 2026.08.01.1

Security hardening: closes the HIGH bot-token credential-leak tracked below as a
"Known gap" in the `Unreleased` entry (filed and planned as the issue-lifecycle
model `telegram-send-hardening-richmessage-port`).

- Added a module-private `redactToken(message, token)` pure helper to
  `telegram_send.ts`. It replaces the live `/bot<token>/` URL segment with
  `/bot<redacted>/`, then applies a generic `/bot[^/]+/` regex backstop so any
  `/bot.../` path segment is scrubbed even if the token reaches the message
  reformatted (re-cased, percent-encoded, or otherwise transformed) rather than
  byte-for-byte. `message` is accepted as `unknown` and safely coerced to a
  string — a fetch rejection is not guaranteed to be an `Error` with a string
  `.message` (it may be a `DOMException`, a thrown string, or an arbitrary
  non-Error value) — so no unsanitized shape can pass through unredacted.
- `telegramJson` and `telegramMultipart` now wrap their `fetch()` call in
  try/catch: a network-layer rejection (DNS failure, TLS error, connection
  reset) is caught and rethrown with its message redacted via `redactToken`,
  preserving the original rejection as `cause` for downstream diagnostics. Only
  the `fetch()` call itself is wrapped — the `ok:false` API-error throw (never
  carries the token, pinned GREEN and covered by property test c) is untouched.
- Behavior-preserving otherwise: legitimate sends and the `ok:false` API-error
  path are unchanged.
- Tests: flipped the two adversarial suite's former "HONEST GAP pin" tests
  (`telegram_send_adversarial_test.ts`, `telegramJson`/`getMe` and
  `telegramMultipart`/`sendPhoto`) to assert the fetch-rejection message is now
  redacted (contains `/bot<redacted>/`, excludes the raw token, preserves
  `.cause`) instead of asserting verbatim propagation. Added direct
  `redactToken` unit tests: exact-token redaction, token-free passthrough, the
  generic backstop for a reformatted token, and non-Error/`DOMException`/
  thrown-string/plain-object coercion (including a case where a non-Error
  value's own string form embeds the token). All 72 suite tests green; property
  suite green at `FC_NUM_RUNS=5000`.
- `README.md`: updated the Security note — the token-in-URL fetch-rejection gap
  is now redacted rather than an open gap.
- `quality.yaml`: the byte-frozen-source justification no longer applies (source
  is modified); ratchet re-measured live.
- **Deferred, tracked separately**: porting `sendRichMessage` from the homelab
  dev copy is OUT OF SCOPE for this security fix (its homelab source-of-truth is
  not in this read-only snapshot, so folding it in would be a blind,
  unverifiable port). It remains tracked by the issue-lifecycle model
  `telegram-send-hardening-richmessage-port` as a follow-up.

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2a gap-check of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `telegram_send.ts` is unmodified and the model `version` stays
`2026.07.16.2`.

- Added `extensions/models/telegram_send_methods_test.ts` (methods),
  `extensions/models/telegram_send_adversarial_test.ts` (adversarial),
  `extensions/models/telegram_send_coverage_test.ts` (coverage),
  `extensions/models/telegram_send_property_test.ts` (property-invariant-flow).
  Extended the pre-existing `telegram_send_test.ts` (contract-fixture) with
  fixture-driven wire pins, keeping its original 6 pure-helper tests
  (`isLocalPath` x3, `resolveChatId` x3) and standardizing its assert import
  onto `jsr:@std/assert@1` (it previously imported from `deno.land/std@0.224.0`)
  — 6 tests before this change, 67 after.
- Added `fixtures/` — pure doc-derived, synthetic Telegram Bot API wire-shape
  fixtures (`getMe`, `sendMessage`, `sendPhoto`, `sendDocument`, `error`) plus
  `PROVENANCE.md`. No live call was made against either `tg-bot` or
  `tg-anilist`, and the `telegram` vault's `BOT_TOKEN` was never read — every
  value is synthetic (placeholder bot/chat ids, RFC-doc-style file_ids, generic
  text). The real homelab chat id (`154348275`) is explicitly denylisted by the
  adversarial suite's fixtures-secret-scan.
- **Scope correction vs. the original brief**: the frozen source
  (`telegram_send.ts` v2026.07.16.2) exposes only `getMe`, `sendMessage`,
  `sendPhoto`, `sendDocument` — there is no `sendRichMessage` method and no
  MarkdownV2/HTML escaping helper to test. `parseMode`-formatted text is
  characterized as verbatim pass-through (no escaping). Porting
  `sendRichMessage` from the homelab dev copy into this workspace's source is
  tracked separately by the follow-up issue
  `telegram-send-hardening-richmessage-port`.
- **Known gap, tracked, not fixed here at the time** (source was byte-frozen by
  this backfill change) — **RESOLVED in `2026.08.01.1` above**:
  `telegramJson`/`telegramMultipart` build the Bot API request URL as
  `${API_BASE}/bot<token>/<method>` — the bot token lives in the request URL
  path — and neither helper wraps its `fetch()` call in a try/catch. A
  well-formed `ok:false` API error response never leaks the token (pinned as a
  GREEN test), but a network-layer fetch _rejection_ (DNS failure, TLS error)
  propagates completely unredacted; Deno's own fetch-rejection error messages
  typically embed the request URL, which would carry the token into a thrown
  error. The adversarial suite pins the _mechanism_ honestly (a neutral sentinel
  error propagates unchanged, through both the JSON and multipart branches —
  never a self-fed token, which would prove nothing) and documents the
  URL-embeds-the-token fact in prose rather than asserting it. The fix (a
  redacting error mapper stripping `/bot<token>/` from any thrown message in
  both `telegramJson` and `telegramMultipart`) is tracked by the follow-up issue
  **`telegram-send-hardening-richmessage-port`** — filed via the issue-lifecycle
  model, referenced here and in `quality.yaml`'s frozen-source justification.
- `deno.json`: default `test` task stays network-less (no `--allow-net`) and
  file-permission-less (no `--allow-read`/`--allow-write` — the multipart
  branch's `Deno.readFile` is stubbed via an in-process reassignment bridge,
  verified reassignable locally under deno 2.7.13; CI runs deno 2.8.3), scoped
  to `--allow-env=FC_NUM_RUNS` and now covering the whole `extensions/models/`
  directory; added `test:soak` for the high-count nightly property soak
  (`FC_NUM_RUNS=10000`).
- `README.md`: added a one-line security caveat under "Limits" about the
  token-in-URL fetch-rejection gap above.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (telegram-send
  bundles no Claude skill); `watch`/`canary` stay `backlog` (exempt from the
  allowlist gate per STANDARD.md). Ratchet measured live via
  `swamp extension quality telegram-send/manifest.yaml --json`:
  `rubricVersion: 3`, `100%`, label `Grade A`. Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: `getMe` (bot identity smoke-test), `sendMessage` (text with
optional MarkdownV2/HTML formatting), `sendPhoto` and `sendDocument` (URL,
Telegram `file_id`, or local-path/multipart upload) over the Telegram Bot API.
