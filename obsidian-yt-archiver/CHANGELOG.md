# Changelog

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
