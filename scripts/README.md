# scripts/

Deno tooling shared across the swamp-workspace monorepo — CI report generation,
promptfoo test generation, and the extension-quality-program generics
(release-watch, property-soak).

## Tasks

```bash
cd scripts
deno task fmt        # deno fmt
deno task fmt:check   # deno fmt --check
deno task lint        # deno lint
deno task check       # deno check over every script (incl. lib/)
deno task test        # deno test . (unit + property tests, network mocked)
```

## Extension quality program: watch declarations

Every published extension may declare upstream sources it should be watched
against in its own `<extension>/quality.yaml`, under a `watch:` key:

```yaml
watch:
  state: present # present | na
  issueLabel: my-ext-release-watch # required when state=present
  sources: # required (non-empty) when state=present
    - kind: npm
        ...
  justification: "..." # required when state=na; optional note otherwise
```

**Ownership split:** Phase A (`ext-quality-standard-ci-gate`) owns the rest of
`quality.yaml` (`schemaVersion`, `extension`, other CI-gate keys) and treats
`watch.sources[]` as an opaque passthrough. **This directory
(`scripts/lib/watch_schema.ts`) is the single executable contract for the
`watch:` block** — `loadQualityWatch()` parses the whole YAML document loosely
and validates only `watch:` strictly. There is **no standalone `watch.yaml`**
file.

An extension with nothing upstream to watch declares `state: na` with a
`justification` instead of an empty `sources: []` — this is enforced by the
schema, not left as an unvalidated convention.

### The four source kinds

`scripts/lib/watch_schema.ts` exports `WatchSourceSchema`, a Zod discriminated
union on `kind`. Every `http-fingerprint`/`openapi-hash` URL is **https-only and
SSRF-guarded** (`assertPublicHttpsUrl`): no plain `http://`, no
loopback/link-local/RFC-1918-private/cloud-metadata hosts, no
numeric-IP-obfuscation tricks. This is defense-in-depth over committer-trusted
YAML, not a hard security boundary — it cannot pin DNS resolution against a
rebind attack at the actual `fetch()` call.

#### `npm`

Compares a version **pinned in model source** against an **npm dist-tag**.

```yaml
- kind: npm
  package: mppx
  channel: latest # dist-tag to compare against (default "latest")
  channelFallback: beta # optional: used if `channel` isn't published
  pin:
    from: source # only supported strategy today
    file: extensions/models/stripe_mpp.ts # relative to the extension dir
    pattern: 'npm:mppx@([0-9][^/"]*)' # regex; capture group 1 = the pin
    required: true # false = an optional pin (missing => skipped, not an error)
```

The pin is read with `Deno.readTextFile` — **never** shelled out to `grep`. A
plain (non `-a`) `grep` silently treats a source file containing a stray control
byte + multibyte UTF-8 as binary and returns zero matches; this bit stripe-mpp's
own bespoke workflow on 2026-07-13. `release_watch_test.ts` regression-fixtures
the exact pathology (an injected NUL byte + em-dash) to lock this in.

#### `github-release`

Compares a recorded **baseline tag** against the latest published (or
highest-semver) GitHub release.

```yaml
- kind: github-release
  repo: pi-hole/FTL
  baseline: v6.0.0
  match: latest-published # latest-published | highest-semver
  includePrerelease: false
```

The common case (`match: latest-published`, `includePrerelease: false`) uses
`GET /repos/{repo}/releases/latest` — a single object that, by API contract,
already excludes prereleases/drafts, so there's no pagination concern at all.
`includePrerelease: true` or `match: highest-semver` fall back to the list
endpoint (`GET /repos/{repo}/releases`), paginated up to a **3-page / 300
release bound** — a pragmatic cap, not a completeness guarantee, for a repo with
an unusually long run of eligible releases ahead of the one being compared. Pass
`githubToken` (e.g. the workflow's own `GITHUB_TOKEN`) via the resolver's
options to raise the unauthenticated 60/hour rate limit to 5000/hour.

#### `http-fingerprint`

Compares a **baseline sha256** against a normalized, selector-scoped hash of a
scraped page (for extensions with no versioned upstream — scrapers).

```yaml
- kind: http-fingerprint
  url: https://example.com/pricing
  selector: "#plans" # optional: #id or .class; omit to hash the whole page
  baselineSha256: "<64 hex chars>"
```

If `selector` no longer matches the page (the site's structure changed),
resolution is `"unreachable"` — **not** `"drift"` — so a redesign never masks as
a false positive that then gets "fixed" by rebaselining blind.

#### `openapi-hash`

Schema-validated here; **the resolver is deferred to Phase C** (live-canary).
Shoko's OpenAPI spec, the motivating example, is only reachable from the private
homelab — not from a GitHub Actions runner. `resolveOpenapiHashSource` always
returns `status: "deferred"` and never fetches.

```yaml
- kind: openapi-hash
  specUrl: https://shoko.example/api/v3/openapi.json
  baselineSha256: "<64 hex chars>"
```

### Drift resolution semantics

Every upstream HTTP response is **untrusted input**: fetched with a bounded
`AbortSignal.timeout`, shape-validated before any field access, and any 5xx /
network failure / malformed body resolves to **`"unreachable"`** (warn, no
issue) — a transient outage must never be reported as drift. See
`scripts/release_watch.ts` and its test suite for the full resolver.

`buildDriftReports()` isolates failures **per extension**: a malformed
`quality.yaml` for one extension is recorded with a `loadError` and does **not**
abort the run for the other 47+ extensions; `release_watch.ts`'s CLI entrypoint
exits non-zero at the end if any load errors occurred, so they stay visible
without blocking drift detection for everyone else.

## Extension quality program: rotating property soak

`scripts/soak_schedule.ts` auto-discovers every
`<extension>/extensions/models/*_property_test.ts` file and partitions the
discovered set into 7 nightly buckets (one per day-of-week), sized so every
bucket holds at most `ceil(N/7)` files and every file is soaked at least once
per 7-night cycle. The partition is **recomputed fresh every run** — there is no
persisted cursor — so if the discovered file set changes mid-cycle, coverage for
that week may shift by one file; the next full cycle over the new, stable set is
exact again (documented, accepted trade-off).

Nights with fewer than 7 discovered files are **expected to have empty buckets
on some days** — `.github/workflows/property-soak.yml`'s soak matrix job is
gated on `needs.discover.outputs.files != '[]'`, mirroring the same empty-matrix
guard `ci.yml` uses for `skill-review` / `skill-trigger-eval`. An empty night is
a green no-op, never a red run.

```bash
deno run --allow-read scripts/soak_schedule.ts --root . --all         # every file, ignoring rotation
deno run --allow-read scripts/soak_schedule.ts --root . --target stripe-mpp
deno run --allow-read scripts/soak_schedule.ts --root .               # tonight's rotation window
```
