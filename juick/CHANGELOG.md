# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave 2c, full build of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `juick.ts` is unmodified and the model `version` stays
`2026.07.16.2`.

**Scope correction during planning:** juick was originally triaged as an HTML
scraper (plan v1, modeled on the musicbrainz/Bandcamp recipe). Plan v1 was
rejected on adversarial review — juick has no `crawlFeed` method and no HTML
parsing at all; it is a JSON API client over `api.juick.com` (`getMessages`,
`getThread`, `getUser`, `getUserPosts`). Plan v2 re-scoped the entire suite set
to the porkbun JSON-wire recipe (synthetic `.json` fixtures + stubbed `fetch`),
which is what this change implements.

- Added `extensions/models/juick_test.ts` (contract-fixture),
  `juick_methods_test.ts` (methods), `juick_adversarial_test.ts` (adversarial),
  `juick_coverage_test.ts` (coverage), `juick_property_test.ts`
  (property-invariant-flow) — 0 tests before this change, 78 after.
- Added `fixtures/` — pure doc-derived, synthetic api.juick.com JSON wire-shape
  fixtures (`messages`, `thread`, `user`, `userposts-page1`, `userposts-page2`,
  `error-500`) plus `PROVENANCE.md`. No live call was made against
  `https://api.juick.com`; every username, message id, and body is synthetic.
  juick has no vault/credentials (unauthenticated public read API), so the
  fixtures-secret-scan is reframed to real-email/high-entropy/ bearer patterns
  rather than a vendor-key-shape scan.
- Every suite drives `model.methods.<m>.execute()` against a stubbed
  `globalThis.fetch` (cast `as unknown as typeof globalThis.fetch` — the deno
  2.8.3 toolchain pin) and a fake context, pinning already-shipped behavior —
  including several latent bugs, characterized rather than fixed. Filed to the
  LOCAL follow-up model `juick-latent-bugs` (triaged medium/security, never the
  Lab):
  - **SSRF** — `apiUrl` has no host allowlist; `z.string().url()` validates URL
    syntax only, so an instance whose `apiUrl` points at an internal or metadata
    address is fetched verbatim.
  - **YAML-frontmatter injection** — `getUserPosts`' Obsidian builder
    interpolates raw `uname` unescaped into `source:`/`author:` frontmatter
    lines (only `title` is quote-escaped); tags are only colon-replaced, so a
    newline or a leading `-` in a tag injects an extra frontmatter list item.
  - **Unbounded `while(true)` pagination** — no page cap; when the last message
    in a batch is missing `mid` (schema is `.passthrough()`) or a server ignores
    `before_mid`, the cursor never advances and the same page is requested
    forever.
  - **Unguarded `JSON.parse`** — a non-JSON 200 body throws a bare, unmapped
    `SyntaxError`.
  - **Three DISTINCT non-array/malformed-response failure shapes** —
    `getMessages` fails zod validation at `writeResource` (real schema, not
    porkbun's `z.any()`), `getThread` throws a `TypeError` from `items.slice(1)`
    before any write, `getUser` passes a non-array object through as-is (or
    `undefined` on an empty array) and would fail `UserSchema`.
  - **Unicode astral-plane title split** — `title.slice(0, 80)` can split a
    surrogate pair, leaking a lone surrogate into both `title` and
    `obsidianPath`.
  - **No `AbortSignal`/timeout anywhere; `Retry-After` never read** — a hung
    endpoint hangs the call forever; a 503 with `Retry-After` throws immediately
    with no retry.
  - **`getMessages` resource-name clobber** — the written resource name is
    `feed_${uname || tag || "all"}`, silently dropping `tag` from the name when
    `uname` is also present, even though the query itself includes both.
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak.
- `deno.lock`: added test-only dev deps `jsr:@std/assert@1` +
  `npm:fast-check@4.8.0`. Source dep `npm:zod@4` unchanged; deliberately no
  `@std/testing`/`FakeTime` — juick has no timers to fake.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (juick bundles no
  Claude skill); ratchet recorded at the measured score (rubricVersion 3, **100%
  Grade A**, via `swamp extension quality manifest.yaml --json`). Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: fetch feed messages (`getMessages`), full comment threads
(`getThread`), user profiles (`getUser`), and a full user post-history import
with comments rendered as Obsidian-ready markdown (`getUserPosts`) over Juick's
public read-only JSON API.
