# Changelog

## 2026.08.19.1

- Version bump and smoke test

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-1 full-build child
of `ext-quality-test-backfill`, mirroring the `ext-quality-bf-porkbun` pilot
recipe from PR #65). No behavior change — `cozystack.ts` is unmodified and the
model `version` stays `2026.07.16.2`.

- Added `extensions/models/cozystack_test.ts` (contract-fixture),
  `cozystack_methods_test.ts` (methods), `cozystack_adversarial_test.ts`
  (adversarial), `cozystack_coverage_test.ts` (coverage),
  `cozystack_property_test.ts` (property-invariant-flow) — 0 tests before this
  change, 133 tests after.
- Added `fixtures/` — 12 pure doc-derived, synthetic Kubernetes/Cozystack
  wire-shape fixtures (Deployment, Package, ApplicationDefinition, app instance,
  Tenant, workload, HelmRelease, and two Secret fixtures with valid-base64
  `.data` decoding to obviously-fake plaintext) plus `PROVENANCE.md`. No live
  call was made against any Cozystack cluster or kubeconfig; every value is
  synthetic (`cluster.example`, RFC 5737 addresses, documented Cilium/Cozystack
  CIDR defaults).
- Every suite drives both the model's 23 methods and its 2 pre-flight checks
  (`cluster-reachable`, `helm-available`) against a stateful, call-count/
  queue-scripted `Deno.Command` fake covering both invocation styles (buffered
  `.output()` and `.spawn()`+stdin for the `apply -f -` manifest-capture path).
- `deno.json`: default `test` task stays network-less and run-less (no
  `--allow-net`, no `--allow-run` — `Deno.Command` is fully stubbed), scoped to
  `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na`
  (cozystack-platform bundles no Claude skill). `watch`/`canary` stay `backlog`
  (allowlist-exempt per STANDARD.md — tracked for Phase B/C). Ratchet measured
  live via `swamp extension quality manifest.yaml --json`: 100% (rubricVersion
  3, Grade A). Removed from `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: install the Cozystack operator via Helm, apply the platform
Package CR, bootstrap CNI networking (PodCIDR assignment and `flux-tenants`
patching), manage applications and tenants, and report platform health
(operator, flux-tenants, platform-package, HelmRelease, workload, and
node-PodCIDR status). Wraps `kubectl` and `helm` against a Cozystack management
cluster.
