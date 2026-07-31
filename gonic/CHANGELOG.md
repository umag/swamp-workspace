# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave 2c, full build of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `gonic.ts` is BYTE-FROZEN and the model `version` stays
`2026.07.16.2`.

- Added `extensions/models/gonic_test.ts` (contract-fixture),
  `gonic_methods_test.ts` (methods), `gonic_adversarial_test.ts` (adversarial),
  `gonic_coverage_test.ts` (coverage), `gonic_property_test.ts`
  (property-invariant-flow) — 0 tests before this change.
- Added `fixtures/` — pure doc-derived, synthetic Subsonic REST API wire-shape
  fixtures (`ping`, `get-podcasts`, `scan-status`, `start-scan`,
  `get-playlists`, `error`) plus `PROVENANCE.md`. No live call was made against
  the real `my-gonic` instance; no `gonic` vault credential was read; every
  id/url/title is synthetic (`pd-`/`pe-`/`pl-` ids, `feeds.example.com`).
- Every suite drives `model.methods.<m>.execute()` against a stubbed `fetch`
  (the 9 Subsonic-REST methods) and a stubbed `Deno.Command` supporting both
  `.output()` and `.spawn()`+`stdin.getWriter()` (the 3 SSH/subprocess methods:
  `db-query`, `db-exec`, `ensure-podcast-dirs`), pinning already-shipped
  behavior — including several found bugs, characterized rather than fixed.
  Filed against the LOCAL `gonic-latent-bugs` issue-lifecycle model (never the
  Lab):
  - **Command injection** in `ensure-podcast-dirs` — the DB-sourced `root_dir`
    and the `docker inspect`-derived host mount are interpolated UNESCAPED into
    `mkdir -p '<hostDir>'`; a `root_dir` containing a `'` breaks out of the
    quoting.
  - **URL-query credential leak** — the Subsonic auth scheme sends
    `p=enc:<hex(password)>` as a URL query parameter over plaintext `http://`;
    hex is trivially reversible, so the credential is fully recoverable from the
    URL.
  - `db-query` is **not actually read-only** — no `-readonly` flag or
    `PRAGMA query_only` guard; a mutating statement is forwarded to sqlite3
    verbatim.
  - `db-exec`'s reported change-count is **structurally meaningless** —
    `SELECT changes()` runs on a fresh, separate ssh/sqlite3 connection,
    decoupled from the write; a brand-new connection's counter bears no relation
    to what the write actually affected.
  - **Network-error credential leak** (honest gap) — `gonicApi` has no try/catch
    around `fetch()`; any rejection propagates verbatim with no redaction,
    including a credential the underlying error message might embed.
  - `dbPath` is interpolated unescaped into the `sqlite3 '<dbPath>'` shell
    command (operator-controlled config, smaller blast radius than the root_dir
    injection above).
  - **Second-granular `dbResult` name clobber** — `ensure-podcast-dirs`,
    `db-query`, and `db-exec` all name their written resource with a
    millisecond-stripped timestamp (`.slice(0, 19)`); two calls within the same
    wall-clock second collide on the identical resource name.
  - `sshExecSql` **swallows warning-only failures** — a `success: false` result
    whose stderr contains ONLY SSH "Warning: Permanently added..." lines is
    silently treated as success (the warning-filtered `realErrors` string is
    empty, hence falsy).
  - README's instance example pins a stale `typeVersion` (doc drift, not a
    runtime bug) — noted but not fixed here.
  - Full detail: local `gonic-latent-bugs` issue-lifecycle model.
- Auth reality check — **CORRECTED** by `2026.08.01.1` below: gonic's server
  DOES support Subsonic TOKEN auth (`t=md5(password+salt)`, `s=salt`) — verified
  against `ctrlsubsonic/ctrl.go`'s `checkCredsToken`. The note originally here
  wrongly called `md5(password+salt)+salt` "a nonexistent salt scheme"; it is
  real, and the URL-query leak this backfill pinned (the `enc:<hex>` scheme
  gonic.ts SENT at the time) is exactly what `2026.08.01.1` replaces with that
  real token scheme.
- The auth-encoding property is split into (1) an ALWAYS-TRUE relation — the
  captured URL's `p` param always equals
  `"enc:" + lowercase-hex(
  TextEncoder.encode(password))`, for any input — and
  (2) full password RECOVERY, stated only over a BMP-safe canonical subset (no
  lone/unpaired UTF-16 surrogates — `TextEncoder` replaces those with U+FFFD,
  which is not invertible), per the porkbun canonical-subset precedent.
- The `db-exec` two-invocation pin routes DISTINCT stub outputs to the write and
  to the follow-up `SELECT changes()` call, and asserts exactly two separate
  `Deno.Command` instantiations occur — an anti-vacuity guard against a
  too-loose Command fake.
- Pagination: NOT APPLICABLE — every Subsonic endpoint gonic.ts wraps
  (`getPodcasts`, `getPlaylists`, `getScanStatus`, `ping`) returns a full set,
  with no paging parameters in the Subsonic REST API.
- `deno.json`: default `test` task stays network-less (no `--allow-net`) and
  subprocess-less (no `--allow-run`) — scoped to `--allow-env=FC_NUM_RUNS`,
  since both `fetch` and `Deno.Command` are stubbed; added `test:soak` for the
  high-count nightly property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (gonic bundles no
  Claude skill); a measured ratchet score recorded. Removed from
  `quality-allowlist.txt` in the same change.

## 2026.08.01.1

Fixes the two HIGH-severity findings tracked by the local `gonic-latent-bugs`
issue-lifecycle model (never filed against the Lab — see that model for full
detail and the deferred MED/LOW findings, which are unchanged and stay pinned).

- **HIGH — command injection, FIXED.** `ensure-podcast-dirs` now quotes the
  DB-sourced `root_dir`/host-mount path with a `shellEsc` helper (copied
  verbatim from `firecracker/extensions/models/firecracker.ts`: wrap in single
  quotes, escape each embedded `'` as `'\''`) before interpolating it into
  `mkdir -p <hostDir>`. Applied to `sshExecSql`'s `dbPath` interpolation in the
  same change (smaller blast radius — operator-controlled config, not live DB
  content — but trivially shared hardening). `mkdir` runs on the REMOTE gonic
  host over SSH, so `Deno.mkdir` is not a substitute for this fix.
- **HIGH — URL-query credential leak, FIXED.** `buildAuthParams` no longer sends
  `p=enc:<hex(password)>` (a trivially-reversible encoding) as a URL query
  parameter. It now generates a random per-request salt
  (`crypto.getRandomValues`), computes a Subsonic TOKEN
  `t = md5hex(password + salt)` via `jsr:@std/crypto` (MD5 is absent from Deno's
  native `WebCrypto subtle.digest`), and emits `u, t, s, v, c, f` — `p` is
  dropped entirely. gonic's server fully supports this scheme
  (`ctrlsubsonic/ctrl.go`'s `checkCredsToken`); see the corrected auth-reality
  note in Unreleased above. `buildAuthParams` is now `async`; `gonicApi` awaits
  it.
- Added `jsr:@std/crypto@1` to `deno.json` imports; regenerated `deno.lock`
  under deno 2.8.3.
- Model `version` and `manifest.yaml` bumped to `2026.08.01.1` (kept in sync).
- Test flips (characterization → fix-verification), all in `extensions/models/`:
  the enc-hex recovery pin and the mkdir-injection pin in
  `gonic_adversarial_test.ts` now assert the FIX (no `p` param / password not
  recoverable; the injected `'` is neutralized rather than breaking out); the
  `u`/`p` assertion in `gonic_methods_test.ts` now asserts `t`/`s` (the
  `u`/`v`/`c`/`f` assertions are unchanged); the three enc-hex
  relation/recovery/collapse properties in `gonic_property_test.ts` collapse
  into one token-auth invariant (`p` absent, `s` hex-shaped, `t` recomputed as
  `md5hex(password + the emitted per-request salt)` — necessarily derived from
  the captured salt, since the salt is random). Every other pinned
  characterization test (db-query not-read-only, db-exec change-count,
  fetch-rejection honest gap, domain-error non-leak, `dbResult` name clobber,
  `sshExecSql` warning-swallow, fixtures-secret-scan, and every quote-free
  happy-path `mkdir`/`sqlite3` command-line assertion) is unchanged and stays
  green — `shellEsc` on a quote-free input is byte-identical to the old bare
  single-quoting.
- Out of scope, deferred as before: `db-query`'s missing read-only guard,
  `db-exec`'s structurally-disconnected change-count, the fetch-rejection honest
  gap, the `dbResult` name clobber, `sshExecSql`'s warning-swallow, and the
  stale README `typeVersion`. Token auth over `http://` still permits passive
  replay of a captured `t`+`s` pair for that one salt — it does not expose the
  password; forcing `https://` is out of scope.

## 2026.07.16.2

Initial release: Subsonic REST API client (`ping`, podcast management —
`get-podcasts`, `refresh-podcasts`, `delete-podcast-channel`,
`delete-podcast-episode`, `download-podcast-episode` — library scan control via
`scan-status`/`start-scan`, and `get-playlists`), plus SSH-backed SQLite
maintenance helpers (`db-query`, `db-exec`, `ensure-podcast-dirs`) against the
underlying `gonic.db`.
