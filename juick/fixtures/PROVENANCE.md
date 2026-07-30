# Fixture provenance

Every JSON file in this directory is **pure doc-derived / hand-authored**
synthetic data modeled on api.juick.com's documented JSON response shapes (as
reflected in `juick.ts`'s `MessageSchema`/`ReplySchema`/`UserSchema` and the
package README) — never captured from a live call. This mirrors the
`porkbun`/`musicbrainz` precedent (synthetic fixtures, no live capture) and is a
deliberate security decision, not an oversight.

## juick has NO vault and NO credentials — this corpus has a different threat model

Unlike `porkbun` (API key + secret API key) or `stripe-mpp` (live secret keys),
`@magistr/juick` wraps a **public, unauthenticated, read-only** JSON API. Its
only global argument is `apiUrl` (a base URL, defaulted to
`https://api.juick.com`) — there is no vault instance, no API key, no bearer
token, nothing secret to redact. Consequently:

- No redaction step exists or is needed for these fixtures — there is no
  credential material to redact in the first place.
- The fixtures-secret-scan test in
  `../extensions/models/juick_adversarial_test.ts` is therefore **reframed**
  away from porkbun's `pk1_`/`sk1_`-shaped key scan (which does not apply here)
  toward real-email, high-entropy-token, and bearer/authorization keyword
  patterns — the same reframing `musicbrainz` uses for its own credential-less
  corpus.

## What was NOT done (explicit prohibition)

**No live call was ever made against `https://api.juick.com`** while authoring
these fixtures, and none should be made to regenerate them later:

- No `swamp model method run <juick-instance> <method>` call was made while
  authoring this corpus.
- No real Juick username, message id, avatar, or post/comment body appears
  anywhere below — every `uname`, `mid`, `uid`, image URL, and body string is a
  synthetic placeholder invented for this test suite.
- The pagination fixtures (`userposts-page1.json`, `userposts-page2.json`) are
  hand-sequenced to exercise the `before_mid` cursor path deterministically —
  they do not reflect any real account's post history.

## The fixtures-secret-scan is a mechanical backstop, not the primary control

The primary control is this prohibition plus never running a live call in the
first place. Since these fixtures are **authored-synthetic** rather than
**captured-and-redacted**, the residual leak risk the scan defends against is
near-zero for THIS corpus; do not treat the heuristic scan as a guarantee that
would also hold for genuinely captured data from a real Juick account (see the
security review's residual LOW finding on plan v2, and the porkbun precedent
this note mirrors).

## Every value is synthetic

- Usernames: `fixture-feed-user`, `fixture-thread-author`,
  `fixture-replier-one`/`-two`, `fixture-profile-user`, etc. — none correspond
  to a real juick.com account.
- Message/reply ids (`mid`, `rid`) and user ids (`uid`): synthetic numeric
  placeholders in dedicated ranges per fixture file (`400100x`, `400200x`,
  `400300x`, `600x`) — not real Juick identifiers.
- Image URLs (`https://i.juick.com/photos-*.jpg`,
  `https://i.juick.com/avatars/*.png`): plausible-shaped but non-resolving
  synthetic URLs on Juick's real CDN hostname pattern — no image exists at these
  paths.
- Timestamps: synthetic `2026-06-*` dates in Juick's documented
  `YYYY-MM-DD HH:MM:SS` wire format.

## Per-file mapping to the documented endpoint

| File                   | Documented endpoint                                            |
| ---------------------- | -------------------------------------------------------------- |
| `messages.json`        | `GET /messages` (feed, optionally filtered)                    |
| `thread.json`          | `GET /thread?mid=<mid>`                                        |
| `user.json`            | `GET /users?uname=<uname>`                                     |
| `userposts-page1.json` | `GET /messages?uname=<uname>` (page 1)                         |
| `userposts-page2.json` | `GET /messages?uname=<uname>&before_mid=<mid>` (page 2, final) |
| `error-500.json`       | Generic non-2xx error body (any endpoint)                      |

## A documented API shape this corpus deliberately preserves

`MessageSchema`/`ReplySchema`/`UserSchema` in `juick.ts` are all
`.passthrough()` — permissive by design, so a real API drift (extra or missing
fields) would never fail zod validation on its own. The contract-fixture suite
therefore pins the concrete, **hardcoded** keyset from this documented shape
(independent of the passthrough schemas) so a real wire drift turns a test red
instead of silently passing through unchecked — see
`../extensions/models/juick_test.ts`.
