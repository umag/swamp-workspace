# Changelog

## 2026.08.02.1

Real fix for all 8 latent bugs below (LB1–LB8, tracked locally under
`juick-latent-bugs`), headlined by an **SSRF fix (LB1, HIGH)**. `juick.ts` model
`version` moves from `2026.07.16.2` to `2026.08.02.1`; the upgrade bootstraps
the `upgrades[]` chain (juick had none before) with a single backward-compatible
entry (`upgradeAttributes: (old) => old`, no resource schema change). Three new
backward-compatible (all `.default()`) global arguments were added:
`allowedHosts`, `timeout`, `maxPages`.

Test backfill to the STANDARD.md five-suite quality bar (wave 2c, full build of
the extension-quality backfill program, `ext-quality-test-backfill`) landed
first with no behavior change; this release is the follow-up fix pass over that
same test suite.

**Scope correction during planning:** juick was originally triaged as an HTML
scraper (plan v1, modeled on the musicbrainz/Bandcamp recipe). Plan v1 was
rejected on adversarial review — juick has no `crawlFeed` method and no HTML
parsing at all; it is a JSON API client over `api.juick.com` (`getMessages`,
`getThread`, `getUser`, `getUserPosts`). Plan v2 re-scoped the entire suite set
to the porkbun JSON-wire recipe (synthetic `.json` fixtures + stubbed `fetch`),
which is what the wave-2c backfill implemented.

- Added `extensions/models/juick_test.ts` (contract-fixture),
  `juick_methods_test.ts` (methods), `juick_adversarial_test.ts` (adversarial),
  `juick_coverage_test.ts` (coverage), `juick_property_test.ts`
  (property-invariant-flow) — 0 tests before the wave-2c backfill, 78 after, 82
  after this fix pass (pin-flips plus new SSRF-control/private-IP-backstop/
  redirect-hop/abort-timeout/maxPages-cap tests).
- Added `fixtures/` — pure doc-derived, synthetic api.juick.com JSON wire-shape
  fixtures (`messages`, `thread`, `user`, `userposts-page1`, `userposts-page2`,
  `error-500`) plus `PROVENANCE.md`. No live call was made against
  `https://api.juick.com`; every username, message id, and body is synthetic.
  juick has no vault/credentials (unauthenticated public read API), so the
  fixtures-secret-scan is reframed to real-email/high-entropy/ bearer patterns
  rather than a vendor-key-shape scan.
- Every suite drives `model.methods.<m>.execute()` against a stubbed
  `globalThis.fetch` (cast `as unknown as typeof globalThis.fetch` — the deno
  2.8.3 toolchain pin) and a fake context. The wave-2c backfill pinned
  already-shipped behavior — including 8 latent bugs, characterized rather than
  fixed at the time. All 8 are FIXED in this release (pins flipped in
  `juick_adversarial_test.ts`), tracked locally as `juick-latent-bugs` (triaged
  medium/security, never the Lab):
  - **LB1 — SSRF (HIGH) — FIXED.** `juickApi` now runs `assertPublicHttpUrl`
    before every request AND before following any redirect `Location`:
    non-http(s) schemes are rejected, loopback/link-local/private-range IP
    literals (127/8, `::1`, 169.254/16, `fe80::/10`, 10/8, 172.16/12,
    192.168/16, `0.0.0.0`, `::`) are rejected UNCONDITIONALLY — even if present
    in `allowedHosts` — and everything else is checked against a new
    default-deny `allowedHosts` global argument (default `["api.juick.com"]`).
    Fetches use `redirect: "manual"` with a bounded hop loop, re-validating the
    host on every hop.
  - **LB2 — YAML-frontmatter injection (MED) — FIXED.** A hostile `uname` can no
    longer break out of the `source:`/`author:` double-quoted YAML scalars (new
    `yamlDq` escapes backslash, quote, and control characters including CR/LF)
    or inject a new frontmatter key. Tags keep the existing colon-to-hyphen
    replacement and additionally collapse embedded newlines to spaces and strip
    other control characters, so a hostile tag can no longer inject a standalone
    `tags:` list item.
  - **LB3 — Unbounded `while(true)` pagination (MED) — FIXED.** `getUserPosts`
    now stops when the cursor (`before_mid`) fails to advance (a missing `mid`
    on the last message, or a server that echoes the same page back), and is
    additionally hard-capped by a new `maxPages` global argument (default
    `1000`).
  - **LB4 — Unguarded `JSON.parse` (LOW) — FIXED.** A non-JSON 200 body now
    throws a domain `Error` (`Juick <path>: invalid JSON response...`) instead
    of an unmapped `SyntaxError`. An empty body still parses to `null`,
    unchanged.
  - **LB5 — Three DISTINCT non-array/malformed-response failure shapes (MED) —
    FIXED.** `getMessages` now coerces a non-array response to `[]` (matching
    the existing falsy-case behavior, and now passing its own resource schema);
    `getThread` coerces to `[]` instead of throwing a bare `TypeError` from
    `items.slice(1)`; `getUser` now validates the unwrapped response against
    `UserSchema` and throws a domain error instead of writing a
    hostile/malformed shape (or `undefined` on an empty array) straight through.
  - **LB6 — Unicode astral-plane title split (LOW) — FIXED.** The post-title
    slice now operates on code points (`Array.from(firstLine).slice(0, 80)`)
    instead of UTF-16 code units, so an astral character landing on the
    80-character boundary is kept whole instead of leaking a lone surrogate into
    `title`/`obsidianPath`.
  - **LB7 — No `AbortSignal`/timeout anywhere; `Retry-After` never read (MED) —
    FIXED.** Every Juick API call now carries an `AbortController`-backed
    timeout (new `timeout` global argument, default `30000` ms, one controller
    spanning all redirect hops of a single call) so a hung endpoint can no
    longer hang the call forever. A 429/503 response's `Retry-After` header is
    now included in the thrown error message (still no auto-retry/sleep).
  - **LB8 — `getMessages` resource-name clobber (LOW) — FIXED.** When both
    `uname` and `tag` are given, the written resource name now folds in both
    (`feed_<uname>_tag_<tag>`) instead of silently collapsing to `feed_<uname>`
    and clobbering different tag-scoped feeds for the same user.

  Every pin flip is paired with a non-vacuous control where relevant: an
  `api.juick.com` request still succeeds through the same `allowedHosts` path
  (LB1), and a private-IP-literal host is rejected even when explicitly present
  in `allowedHosts` (LB1 unconditional backstop). New tests were also added for
  redirect-hop re-validation, abort-on-timeout, and the `maxPages` cap. Every
  benign/frozen contract byte (`juick_test.ts`, `juick_methods_test.ts`,
  `juick_coverage_test.ts`, `juick_property_test.ts`, and the non-hostile
  adversarial pins) is unchanged.
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; `test:soak` still drives the high-count nightly
  property soak. Test perms unchanged by this fix pass — the new abort/timeout
  tests use a manual stub, not real network I/O.
- `deno.lock`: unchanged by this fix pass (test-only dev deps
  `jsr:@std/assert@1` + `npm:fast-check@4.8.0` were already present; source dep
  `npm:zod@4` unchanged; deliberately no `@std/testing`/`FakeTime` — juick has
  no timers to fake).
- `README.md`: documented `allowedHosts`, `timeout`, `maxPages` in the Global
  arguments table, plus a note that a custom `apiUrl` host must be added to
  `allowedHosts`.
- `quality.yaml`: re-stamped from a real `swamp extension quality` run — all
  five suites still present, ratchet unchanged (rubricVersion 3, **100% Grade
  A**).

## 2026.07.16.2

Initial release: fetch feed messages (`getMessages`), full comment threads
(`getThread`), user profiles (`getUser`), and a full user post-history import
with comments rendered as Obsidian-ready markdown (`getUserPosts`) over Juick's
public read-only JSON API.
