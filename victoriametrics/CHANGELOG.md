# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2b full build of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `victoriametrics.ts` is unmodified and the model `version`
stays `2026.07.16.2`.

- Added `extensions/models/victoriametrics_test.ts` (contract-fixture),
  `victoriametrics_methods_test.ts` (methods),
  `victoriametrics_adversarial_test.ts` (adversarial),
  `victoriametrics_coverage_test.ts` (coverage),
  `victoriametrics_property_test.ts` (property-invariant-flow) — 0 tests before
  this change.
- Added `fixtures/` — pure doc-derived, synthetic VictoriaMetrics/Prometheus
  HTTP query API wire-shape fixtures (`query_vector`, `query_scalar`,
  `query_range_matrix`, `health_up`, `system_overview`, `container_memory`,
  `error`) plus `PROVENANCE.md`. No live call was made against the `vm-unraid`
  instance; every value is synthetic (job `demo-node`, instances
  `fixture-host-1:9100`/`fixture-host-2:9100`, devices `vda`/`vdb`, containers
  `web`/`cache`/`worker`, a fixed synthetic epoch).
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak; `check` lists the model plus all five test files.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (victoriametrics
  bundles no Claude skill). Removed from `quality-allowlist.txt` in the same
  change. `ratchet.baselinePercentage` set to the live `swamp extension quality`
  score (100%, rubricVersion 3, "Grade A").
- Several real gaps in the already-shipped implementation were found during
  grounding and are PINNED as characterization tests (not fixed —
  `victoriametrics.ts` stays byte-frozen): `system-overview`'s `extractValues`
  reads only `result.data.result[0]`, so a multi-series mem/load range result
  silently collapses to the first series; the disk loop and `container-memory`
  (and, discovered during test review, `health`'s `up`-vector mapper) each have
  an unguarded inner `.values`/`.value` access that throws on a partial/hostile
  response instead of degrading gracefully; a missing metric is silently
  reported as 0% rather than flagged as absent; `health` conflates "target
  reported `up=0`" (down) with "target has no series at all" (simply omitted,
  not reported down); `container-memory`'s negative `topN` drops from the END of
  the already-sorted array via `slice(0, -n)`; and a 200 response carrying
  `{status:"error"}` with no `data` field is not inspected and crashes with an
  uncaught `TypeError` rather than a mapped error. Full list tracked in the
  issue `victoriametrics-latent-bugs`.

## 2026.07.16.2

Initial release: instant PromQL query (`query`), range PromQL query
(`query-range`), scrape-target health from the `up` metric (`health`), a
node-exporter system overview with CPU/memory/load/disk/network stats and
anomaly detection (`system-overview`), and top-N container memory usage rankings
(`container-memory`) over a VictoriaMetrics (or Prometheus-compatible) HTTP
query API (`/api/v1/query`, `/api/v1/query_range`).
