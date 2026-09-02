# Changelog

## 2026.09.02.1

Restores the `push` method and its `pushResult` resource.

`push` existed on the 2026.08.08.1 model — it POSTs Prometheus exposition text
to `/api/v1/import/prometheus` so a job can record its own outcome as a series
vmalert can alert on. It was **dropped when the model was rewritten** for the
11-bug fix batch and never made it into git, so every published version since
has been missing it while one deployed copy of the old file kept using it. The
gap surfaced on 2026-09-02: `swamp-fleet-update`'s `publish-metrics` step
succeeded on the server (still on the stale 2026.08.08.1 file) and failed
`swamp workflow validate` on the laptop with
`Method 'push' not found on model type '@victoriametrics/query'`. Syncing the
two copies in either direction would have silently killed the metrics.

- `push` — `lines` (exposition text, blank lines and `#` comments allowed) and
  optional `extraLabels` (comma-separated `key=value`) → `pushResult`.
- Three pure helpers are now **exported** so they can be property-tested
  directly: `sampleLines`, `metricNames`, `extraLabelParams`. Before this
  release the model exported no parsing helpers at all.
- A failed push writes `pushResult` with `ok:false` **before** throwing. A
  method that throws without writing leaves no record of what it tried to send,
  and the attempt that failed is the one worth keeping.
- A transport failure records `httpStatus: 0` rather than inventing a status,
  and a server error body is truncated to 300 characters so an unbounded
  response cannot become an unbounded resource.
- The success body is read even on VM's empty `204`, so the connection is not
  left dangling.

### One real defect found while writing the tests

`extraLabelParams` trimmed each whole `key=value` pair, which silently rewrote
any value with leading or trailing whitespace — `a=` was sent as `a=`, so the
label VictoriaMetrics stored differed from the one the caller passed. Property
`f2` (round-tripping arbitrary pairs back through `URLSearchParams`) shrank it
to `{key:"a", value:" "}`. Now only the **key** is trimmed, so
`"job=x,
instance=y"` still parses while a value keeps every character it was
given; the split is at the first `=`, so an `=` inside a value survives, and a
pair whose key is empty is dropped rather than sent malformed.

### Tests

15 new tests across four suites, all green (105 total):

- **methods** (5) — happy path pinning verb, endpoint, `text/plain` content type
  and the exact body; `extraLabels` → percent-encoded params; non-2xx and
  transport-failure paths asserting the resource is written _and_ the error
  thrown; empty-payload rejection before any request is made.
- **adversarial** (8) — HELP/TYPE and blank lines are not samples; a name ends
  at the first `{` or whitespace (a naive `split(" ")[0]` reports
  `a_metric{label="value`); malformed pairs dropped; an injected `&extra_label=`
  cannot break out of the query string; a 200-with-error-body is still success
  (VM signals import failure with a non-2xx — characterization, not a bug);
  300-char error truncation; the two whitespace/`=` regressions above.
- **coverage** (4) — the `port || 8428` fallback; no dangling `?` when there are
  no labels; exactly one trailing newline after trimming; the success-path body
  read (asserted via `bodyUsed`).
- **property** (2) — `metricNames` returns exactly the distinct emitted names in
  first-seen order and `sampleLines` counts exactly the emitted samples, both
  oracled from the generator's own record rather than a re-parse; every
  `extraLabels` pair round-trips as one param decoded by `URLSearchParams`.

No existing test changed. No existing resource schema changed; `pushResult` is
additive and the `upgrades[]` entry is an identity.

## 2026.08.30.1

`system-overview` now counts each physical disk **once**.

node_exporter exports every layer of the block stack. On Unraid an encrypted
array slot is `dm-N` -> `mdXp1` -> one physical `sdX`, so the disk view listed
the same spindle two or three times and a `dm-*`/`sd*` pair reporting the same
utilisation looked like two independent disks corroborating each other. On
Tower, 2026-08-30, `dm-3` and `sdl` were flagged together as a disk-saturation
watch item: `dm-3` = `md4p1` = `disk4` = `/dev/sdl`, one 14.6TB drive, and
neither layer was near saturation (7d mean 20%, peak 52%).

- `DISK_IO_QUERY` (new export) adds
  `{device!~"(dm-|md|loop|sr|zram|ram|nbd|drbd|zd).*"}` so VictoriaMetrics drops
  the virtual layers at query time.
- `isPhysicalDiskDevice()` (new export) re-checks each returned series
  client-side, so a server that ignores the matcher still cannot double-count.
- Both derive from one `VIRTUAL_DISK_PREFIXES` list, so the PromQL string and
  the client-side check cannot drift apart. Tests import `DISK_IO_QUERY` instead
  of restating it.
- Unlabelled series still normalise to `"unknown"` and are kept — an
  unattributable series must not be silently dropped.

No resource schema change; identity `upgrades[]` entry appended.

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.1

Real fixes for all 11 latent bugs tracked in the LOCAL
`victoriametrics-latent-bugs` issue-lifecycle model (NEVER filed to the
swamp.club Lab — see CLAUDE.md's anti-bypass rule). `model.version` and
`manifest.yaml` both bump `2026.07.16.2` -> `2026.08.02.1`, with an identity
`upgrades[]` entry appended (no resource schema change).

- **VM2 (HIGH, multi-series collapse)**: `extractValues` now flatMaps EVERY
  series in `result.data.result`
  (`result.data.result.flatMap((s) => s.values ?? []).map(...)`) instead of
  reading only `result.data.result[0]`. `system-overview`'s CPU/memory/load
  stats now characterize the FULL set of series a range query returns, not just
  the first one. Single-series results are byte-identical (flatMap of one series
  equals that series). The flatten's inter-series timestamp boundary is a
  backward jump by construction and never trips the `>600s` forward-gap "Metric
  gap" reboot detector.
- **VM1 (MED, `health` has no notion of expected targets)**: `health` gains a
  new backward-compatible method argument, `expectedTargets` (default `[]`). Any
  name in that list not seen in the `up` vector is appended with
  `status:"unknown"` instead of being silently omitted. An empty/default list is
  a no-op — existing callers see no change.
- **VM3 (MED, absent metric indistinguishable from idle 0%)**: `system-overview`
  now pushes a distinct `"<CPU|Memory|Load> metric absent (no series returned)"`
  anomaly whenever a metric's range query returns zero series. The numeric
  fields still report `{0,0,0,0}` (unchanged) — only the anomalies array gains
  the flag.
- **VM4 (MED, boot-time epoch fallback)**: an empty `node_boot_time_seconds`
  result no longer falls back to `bootTs=0` (the 1970 epoch, with an enormous
  computed uptime). `uptime.bootTime` is now the string `"unknown"`,
  `uptime.uptimeMinutes` is `0`, and a `"Boot time unavailable"` anomaly is
  pushed. A real boot time is completely unaffected.
- **VM5 (MED, scalar query garbage-mapping)**: `query` now dispatches on
  `data.resultType`: a `"scalar"` result (`[ts, "<value>"]`) maps to a single
  `[{metric:{}, value:<parsed number>}]` row instead of the old two-row
  `[{metric:undefined,value:null},{metric:undefined,value:null}]` garbage.
  Vector results are unaffected (same `r.value ? parseFloat(r.value[1]) : null`
  mapping as before); a matrix body fed into `query` still maps every series to
  `value:null` (matrix support was never in scope for `query`, and stays a
  documented, intentional gap).
- **VM6 + VM11 (MED, uninspected `{status:"error"}` responses)**: a new shared
  `vmData(result)` helper is called by the three direct single-query methods
  (`query`, `query-range`, `health`) right after the HTTP round-trip. It throws
  `Error("VM query error: <result.error | 'response missing data'>")` when
  `result.status==="error"` or `result.data.result` isn't an array, instead of
  letting a partial/hostile 200 body crash several frames down with an uncaught
  `TypeError`. `system-overview` and `container-memory` deliberately do NOT go
  through `vmData` — they keep their existing lenient degrade-to-zero behavior
  on missing/empty data.
- **VM7 (MED, `query-range` vector-shaped-body crash)**: `query-range`'s series
  mapper now does `(r.values ?? []).map(...)` — a series missing `values` (e.g.
  a vector body mistakenly fed to `query-range`) degrades to `values:[]` instead
  of throwing.
- **VM8 (MED, unguarded inner `.values`/`.value` access)**: the disk loop,
  `container-memory`'s series loop, and `health`'s per-target status now all
  guard their inner access instead of crashing on a partial/hostile response:
  disk pre-filters series via `Array.isArray(r.values) && r.values.length>0`
  before mapping; `container-memory` uses `(r.values ?? [])` and
  `r.metric?.name`; `health` uses `r.value ? (...) : "unknown"`.
- **VM9 (MED, disk NaN/-Infinity)**: folds into the VM8 disk pre-filter — a
  series with `values:[]` (present, empty) is now dropped BEFORE the
  `Math.max`/`reduce` computation runs, instead of computing `NaN`/`-Infinity`
  and relying on the `>10` threshold filter to silently absorb it. The
  observable result (`disk:[]`) is unchanged.
- **VM10 (LOW, negative `topN`)**: `container-memory`'s `topN` is now clamped
  via `Math.max(0, args.topN)` before `.slice(0, ...)`. A negative `topN` now
  yields `[]` instead of `slice(0, -n)` silently dropping from the END of the
  already-desc-sorted array. `topN:0` is unaffected (`Math.max(0,0)===0`).
- **Tests**: all 11 latent-bug pins in `victoriametrics_adversarial_test.ts`
  flip from characterizing the bug (title prefixed `pin:`) to asserting the fix
  (title prefixed `fix (VMn):`), reusing the existing fixtures plus a handful of
  new inline hostile bodies. New adversarial coverage: two multi-series
  regressions for VM2 (a LOAD spike test proving `load.max` picks up series[1]
  while `load.min` still comes from series[0], and a CPU boundary-safety test
  proving the flatten's backward inter-series jump never fires "Metric gap"), a
  VM1 `expectedTargets` regression, and generic `{status:"error",error:"boom"}`
  / data-less-`{}` coverage for `vmData()` across all three direct single-query
  methods. `victoriametrics_coverage_test.ts` gains a two-series green
  complement (memory aggregates correctly across both series, not just
  series[0]) and `victoriametrics_methods_test.ts` gains a `query`
  scalar-resultType happy path. The contract-fixture and property-invariant-flow
  suites, and every existing methods-suite test, are UNCHANGED — none of the 11
  fixes touch the benign, single-series, well-formed inputs those suites drive.
- Added an identity `upgrades[]` entry (`2026.07.16.2 -> 2026.08.02.1`,
  `upgradeAttributes: (old) => old`, no resource schema change).
- `quality.yaml` ratchet re-stamped from a real `swamp extension quality` run.
- Test backfill to the STANDARD.md five-suite quality bar (wave-2b full build of
  the extension-quality backfill program, `ext-quality-test-backfill`) is
  carried forward from the prior scaffolding pass:
  - Added `extensions/models/victoriametrics_test.ts` (contract-fixture),
    `victoriametrics_methods_test.ts` (methods),
    `victoriametrics_adversarial_test.ts` (adversarial),
    `victoriametrics_coverage_test.ts` (coverage),
    `victoriametrics_property_test.ts` (property-invariant-flow).
  - Added `fixtures/` — pure doc-derived, synthetic VictoriaMetrics/Prometheus
    HTTP query API wire-shape fixtures (`query_vector`, `query_scalar`,
    `query_range_matrix`, `health_up`, `system_overview`, `container_memory`,
    `error`) plus `PROVENANCE.md`. No live call was made against the `vm-unraid`
    instance; every value is synthetic (job `demo-node`, instances
    `fixture-host-1:9100`/`fixture-host-2:9100`, devices `vda`/`vdb`, containers
    `web`/`cache`/`worker`, a fixed synthetic epoch).
  - `deno.json`: default `test` task stays network-less (no `--allow-net`),
    scoped to `--allow-env=FC_NUM_RUNS`; `test:soak` runs the high-count nightly
    property soak; `check` lists the model plus all five test files.
  - `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
    are `present`; `docs.skill` recorded `na` (victoriametrics bundles no Claude
    skill).
- Several real gaps found during the original test-backfill grounding pass
  (single-series collapse, unguarded inner `.values`/`.value` accesses,
  missing-metric silent zeros, `up==0`-vs-absent conflation, negative-`topN`
  end-slice, 200-with-`status:error` uninspected) are the exact 11 bugs
  (VM1-VM11 above) this release fixes.

## 2026.07.16.2

Initial release: instant PromQL query (`query`), range PromQL query
(`query-range`), scrape-target health from the `up` metric (`health`), a
node-exporter system overview with CPU/memory/load/disk/network stats and
anomaly detection (`system-overview`), and top-N container memory usage rankings
(`container-memory`) over a VictoriaMetrics (or Prometheus-compatible) HTTP
query API (`/api/v1/query`, `/api/v1/query_range`).
