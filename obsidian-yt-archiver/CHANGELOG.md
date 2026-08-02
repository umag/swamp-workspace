# Changelog

## 2026.08.02.1

Fixes the remaining seven latent bugs -- LB1, LB3, LB4, LB5, LB6, LB7, LB8 --
tracked in the LOCAL `obsidian-yt-archiver-latent-bugs` issue-lifecycle model
(NEVER filed to the swamp.club Lab -- see CLAUDE.md's anti-bypass rule). LB2 was
already fixed in 2026.08.01.1 and is untouched here. No new npm/jsr dependency
was added (`jsr:@std/path@1` remains the only non-builtin import; `deno.lock` is
unchanged) and no resource schema or `globalArguments` shape changed -- the
version bump is a pure identity upgrade.

- **LB1 (MEDIUM, path traversal / request-forgery via `videoIds`):** added a
  shared `taVideoPath(id)` helper (`encodeURIComponent`) used at all three
  GET-path build sites (archive/resolve/sync). A `../`-laden or
  absolute-URL-shaped id is now percent-encoded into ONE opaque
  `/api/video/<id>/` path segment instead of reaching a different TA endpoint on
  the same host. Identity for every benign id used across the suites
  (`[A-Za-z0-9_-]`) -- every byte-frozen contract/methods URL pin stays
  unchanged.
- **LB3 (MEDIUM, conflated error handling -> mass re-queue):** `taApi` now
  throws a typed `TaHttpError` carrying `.status` on any non-2xx/redirect/
  non-JSON response. A shared `isNotArchived(e)` predicate treats ONLY a genuine
  404 as "not archived" (queue/unresolved); every other failure
  (401/403/500/502/503/timeout/network/redirect/non-JSON) is re-thrown and
  surfaces instead of being silently re-queued alongside real not-archived ids.
- **LB4 (MEDIUM, no fetch timeout):** every `taApi` call now passes an
  `AbortController`-backed `signal` with a 30s default timeout
  (`DEFAULT_REQUEST_TIMEOUT_MS`), cleared in a single `finally` so no timer ever
  leaks (satisfies Deno's op-sanitizer on every code path: success,
  redirect-throw, `!ok`-throw, non-JSON-throw, network-throw).
- **LB5 (LOW-MED, unbounded sequential per-id fetch):** a shared
  `assertVideoIdCap(ids)` REJECTS (never silently slices/drops) any id list
  longer than `MAX_VIDEO_IDS = 500`, checked once per method immediately after
  the id list is resolved (archive/resolve/sync), before any fetch fires.
  Sequential per-id execution order is unchanged -- no batching/concurrency was
  introduced.
- **LB6 (LOW, error body truncated to 200 raw chars):** replaced the raw
  200-char slice with `redactBody()` -- collapses whitespace runs and caps the
  result at 120 chars (plus an ellipsis) before it is interpolated into any
  thrown message. The auth token was already header-only and remains never part
  of this text.
- **LB7 (LOW, default `redirect:"follow"`):** `taApi` now passes
  `redirect: "manual"` on every call, plus an explicit guard that throws on any
  3xx status or an `"opaqueredirect"` response type (surfaced, never silently
  followed to a possibly-different host) and a defense-in-depth
  host-revalidation check against the operator-configured `tubearchivistUrl`.
- **LB8 (LOW, non-JSON 200 -> blank "archived" record):** `taApi` gained an
  `expectJson` parameter (default `true`). Every per-id metadata GET check now
  surfaces (throws) on a 2xx response whose content-type is not
  `application/json`, instead of silently returning `{}` and recording a blank
  `archived: true` entry. The two fire-and-forget POST calls (`/api/download/`,
  `download_pending`) pass `expectJson: false` and keep their existing
  `{}`-on-non-JSON behavior -- zero POST-shape regression.
- **Test suites:** flipped every LB1/LB3/LB4/LB5/LB6/LB7/LB8 characterization
  pin in `obsidian_yt_archiver_adversarial_test.ts` from "the bug is present" to
  `fixed (... FIXED)` (mostly `assertRejects`), added new cases (LB3's 401/500
  split, LB5's 501-id cap-reject, LB7's 302-reject), and flipped the coverage
  suite's no-content-type-header-200 test to `assertRejects` (LB8). Rewrote the
  property suite's `(b)`/`(b-resolve)` "archive()/ resolve() never throw for ANY
  status" properties -- directly contradicted by the LB3/LB7/LB8 fixes -- into a
  `(b1)` never-throws property scoped to {genuine JSON-200, genuine 404} and a
  NEW `(b2)` surfaces property scoped to {redirect, 4xx/5xx, non-JSON 200},
  partitioning every GET-check outcome the suite generates with no overlap.
  LB2's fix and every byte-frozen contract/methods pin stay green, unchanged.
- **Adversarial + security review follow-up:** added two coverage-closing tests
  the reviews flagged as untested claims -- a raw network-level failure
  (`fetch()` itself rejecting, not an HTTP error response) surfacing correctly
  through the LB3 catch/rethrow chain, and the LB7 host-revalidation
  defense-in-depth branch (previously unreachable by any stub, since a
  directly-constructed `Response` always leaves `url` empty -- now exercised via
  `Object.defineProperty` shadowing `res.url`).
- `manifest.yaml` and `model.version` bumped to `2026.08.02.1`.

## 2026.08.01.1

Fixes LB2 (HIGH, path traversal), tracked in the LOCAL
`obsidian-yt-archiver-latent-bugs` issue-lifecycle model (NEVER filed to the
swamp.club Lab -- see CLAUDE.md's anti-bypass rule). `scan`'s and `sync`'s
`folder` method-argument was concatenated directly into `vaultPath` with no
containment check, so `folder: "../outside"` (or a deeper/absolute escape)
walked arbitrary host directories via `walkMd` and read every non-hidden `.md`
file outside the vault.

- Added a shared pure guard, `assertFolderWithinVault(vaultPath, folder)`, using
  `jsr:@std/path@1`'s `resolve`/`relative`/`isAbsolute` -- LEXICAL only (never
  `Deno.realPath`, since the vault commonly lives under a symlinked temp root,
  e.g. macOS `/var` resolving to `/private/var`, and realPath would break every
  legitimate scan of such a vault). Rejects an absolute `folder`, or a
  vault-relative resolved path that is `..` or begins with `../`. Invoked
  identically at both `scan.execute` and `sync.execute`, before `walkMd` runs --
  one shared helper, no divergent inline re-check.
- Flipped the LB2 characterization pin in
  `obsidian_yt_archiver_adversarial_test.ts` from "the escape succeeds" to
  `assertRejects`, for both `scan` and `sync`, and added deeper rejection cases
  (`..`, `../..`, `notes/../../outside`, and an absolute path) for both methods.
  Every previously-green legit-subfolder test (`scan`/`sync`
  folder=notes/Clippings/Sub) and the does-not-exist -> `Deno.errors.NotFound`
  test stay green: a contained-but-nonexistent folder passes the guard and still
  fails at `readDir`, unchanged.
- Added the `jsr:@std/path@1` dependency; `deno.lock` regenerated on deno 2.8.3.
  No other runtime behavior changes -- LB1 and LB3-LB8 remain latent/tracked in
  the same local model, unaffected by this change.
- `manifest.yaml` and `model.version` bumped to `2026.08.01.1`.

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4b child
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change -- `obsidian_yt_archiver.ts` is byte-frozen and the model
`version` stays `2026.07.16.2` (`manifest.yaml` is also unchanged).

- Added `extensions/models/obsidian_yt_archiver_test.ts` (contract-fixture),
  `obsidian_yt_archiver_methods_test.ts` (methods),
  `obsidian_yt_archiver_adversarial_test.ts` (adversarial),
  `obsidian_yt_archiver_coverage_test.ts` (coverage), and
  `obsidian_yt_archiver_property_test.ts` (property-invariant-flow) -- 0 tests
  before this change, 63 after (9 contract-fixture / 16 methods / 17 adversarial
  / 14 coverage / 7 property).
- Added `fixtures/` -- a synthetic Obsidian vault subtree (`vault/`, plus a
  sibling `outside/` traversal target), synthetic TubeArchivist REST responses
  (`ta/`), and `PROVENANCE.md`. No
  `swamp model method run
  <instance> scan|archive|resolve|sync` call was ever
  made against a real vault or a real TubeArchivist instance while authoring
  these fixtures; every value is synthetic (RFC 2606 `.example.com` hosts,
  `fixture`-prefixed 11-character video ids, invented titles/channel
  names/tokens).
- Every test drives `model.methods.<m>.execute()` against a REAL temporary vault
  directory (`Deno.makeTempDir()`, populated from the committed `fixtures/vault`
  and `fixtures/outside` via a `setupVault()` helper in each file) and a stubbed
  `globalThis.fetch` for the TubeArchivist calls -- `extractYoutubeIds`,
  `taApi`, and `walkMd` are module-private, so the four methods
  (`scan`/`archive`/`resolve`/`sync`) are the only reachable seam. Per this
  backfill wave's CI-parity requirement, the fetch stub is typed directly as
  `const stub: typeof fetch = async (input, init) => {...}` at its declaration
  site -- this needs no `as unknown as typeof globalThis.fetch` cast at all
  (verified against deno 2.8.3; the cast pattern used by the
  `bandcamp`/`livejournal-import` precedent is intentionally NOT repeated here).
  `writeResource` captures each payload via `structuredClone` rather than
  holding a bare reference -- `sync()`'s `archive` and `resolved` resources
  share one JS array (`videos`) that is mutated further AFTER the `archive`
  resource is written, so a naive reference-holding fake would retroactively
  "leak" the later mutation into the earlier snapshot; a real `writeResource`
  serializes/persists at call time, and `structuredClone` reproduces that
  snapshot semantics rather than introducing a test-harness artifact.
- 8 already-shipped latent bugs are PINNED (characterized as CURRENT behavior,
  not fixed -- `obsidian_yt_archiver.ts` is byte-frozen by this change) and
  tracked in the LOCAL `obsidian-yt-archiver-latent-bugs` issue-lifecycle model
  (NEVER filed to the swamp.club Lab):
  1. **Path traversal via `folder` (HIGH)** -- `scan`/`sync`'s `folder` argument
     is concatenated directly into `vaultPath` with no `..`-segment guard;
     `folder: "../outside"` escapes the vault subtree and reads a sibling
     directory verbatim, carrying the literal `../` segment through into the
     `file` field (characterized against a synthetic `fixtures/outside` sibling
     only).
  2. **Request-forgery via arbitrary `videoIds` (MEDIUM)** -- `archive`/
     `resolve`'s `videoIds` argument is concatenated unsanitized into
     `/api/video/${id}/`; a `../`-laden id has its dot-segments normalized by
     the URL parser, landing the GET on a DIFFERENT TubeArchivist endpoint on
     the SAME host (never a different host -- the host comes only from the
     operator-fixed `tubearchivistUrl` global argument, so this is same-host
     path confusion, not SSRF).
  3. **Conflated error handling -- mass re-queue risk (MEDIUM)** -- the per-id
     GET check's `catch` treats a 401 (auth failure) and a 500 (server error)
     identically to a genuine 404; all three land in `toQueue` and get re-queued
     for download with no distinction.
  4. **No fetch timeout (MEDIUM)** -- none of the three TubeArchivist calls (GET
     check, POST `/api/download/`, POST the `download_pending` task) ever pass
     an `AbortSignal`/timeout.
  5. **Whole-file reads + sequential per-id fetch, no cap (LOW-MED)** --
     `walkMd` reads each `.md` file whole via `Deno.readTextFile`, and
     `archive`/`resolve`/`sync` check every video id with a fully sequential
     `for...of` + `await` loop (no concurrency, no batching, no upper bound on
     id count).
  6. **200-char error-body truncation (LOW, token never leaked)** -- a non-2xx
     TubeArchivist response's body is truncated to exactly 200 characters in the
     thrown `Error` message; the auth token never appears in it since only
     status + body text are ever interpolated.
  7. **Default `redirect: "follow"` (LOW)** -- `taApi` passes no explicit
     `redirect` option on any call, so the fetch spec's default (`"follow"`)
     silently applies to every TubeArchivist request.
  8. **Non-JSON 200 resolves to a blank "archived" record (LOW)** -- a 200 OK
     response whose `content-type` is not `application/json` makes `taApi`
     return `{}`; the video is still recorded `archived: true` with
     title/channel/published all blank -- a false-positive archived record.
  - Six risk classes are additionally pinned as REFUTED covered-negatives:
    credential leak (the token is header-only, `Token <token>`, never embedded
    in any URL or written resource), injection (the model never writes to the
    vault and never shells out -- no `Deno.Command` anywhere in the source,
    mechanically asserted), XXE (no XML/DOMParser is ever used -- a literal
    DOCTYPE/ENTITY payload is inert text under plain regex scanning), command
    injection (same no-`Deno.Command` mechanical check), symlink escape (a `.md`
    file OR directory that is a symlink is skipped by `walkMd` --
    `Deno.DirEntry.isFile`/`isDirectory` are both false for a symlink entry,
    verified empirically against deno 2.8.3), and cross-host SSRF (neither
    `videoIds` nor `folder` can change the request's host -- only its path; an
    absolute-URL-shaped `videoId` stays an inert opaque path segment on the
    fixed host).
- `deno.json`: `test` task widened to
  `--allow-read --allow-write
  --allow-env=FC_NUM_RUNS` -- the `--allow-write`
  grant (beyond this backfill wave's `--allow-read --allow-env=FC_NUM_RUNS`
  baseline) is required because every suite drives REAL filesystem reads against
  a `Deno.makeTempDir()` vault tree per the approved plan's test seam, and
  `Deno.makeTempDir`/ `Deno.symlink` both require write access; no `--allow-net`
  is granted -- the TubeArchivist boundary is always stubbed. Added `test:soak`
  for the high-count nightly property soak. `fmt.exclude` lists
  `fixtures/vault/notes/video-note.md`,
  `fixtures/vault/Clippings/clipped-video.md`, and
  `fixtures/outside/escape-note.md` -- each has specific `line` values pinned by
  tests, and `deno fmt`'s Markdown formatter can re-wrap prose and shift blank
  lines, which would silently change which line a link falls on.
- `deno.lock`: regenerated to lock the new TEST-ONLY dev dependencies
  (`jsr:@std/assert@1`, `npm:fast-check@4.8.0`). The source dependency
  (`npm:zod@4`) is unchanged -- the lock delta carries no runtime/behavior
  implication whatsoever.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na`
  (obsidian-yt-archiver bundles no Claude skill -- a read-only Obsidian-vault →
  TubeArchivist archival wrapper, nothing to document as a skill).
  `watch`/`canary` stay `backlog` (seeded offender at CI-gate rollout, tracked
  in `ext-quality-test-backfill`). `ratchet` set to `baselinePercentage: 100`,
  `label: "Grade A"`, `rubricVersion: 3` -- confirmed via
  `swamp extension quality manifest.yaml --json`. Removed from
  `quality-allowlist.txt` in the same change (five-suite presence graduates it).

## 2026.07.16.2

Initial release: scan an Obsidian vault for YouTube links (`watch`, `youtu.be`,
`embed`, and `shorts` URL forms), queue missing videos for download in a
self-hosted TubeArchivist instance, and resolve archived video metadata back
into vault-adjacent model data -- idempotently, so re-running only queues what
is not yet archived. Exposes `scan`, `archive`, `resolve`, and `sync` (scan +
archive + resolve in one pass).
