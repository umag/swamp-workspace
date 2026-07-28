# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-1 child of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `cozystack_linstor.ts` is unmodified and the model `version` stays
`2026.07.16.2`.

- Added `extensions/models/cozystack_linstor_test.ts` (contract-fixture),
  `cozystack_linstor_methods_test.ts` (methods),
  `cozystack_linstor_adversarial_test.ts` (adversarial),
  `cozystack_linstor_coverage_test.ts` (coverage),
  `cozystack_linstor_property_test.ts` (property-invariant-flow) — 0 tests
  before this change, 87 after.
- Added `fixtures/` — pure doc-derived, synthetic LINSTOR machine-readable
  (`-m`) and Kubernetes `Deployment` wire-shape fixtures (`node-list`,
  `storage-pool-list`, `deploy-ready`, `deploy-notready`) plus `PROVENANCE.md`.
  No live call was made against the real Cozystack cluster or its kubeconfig;
  every value is synthetic (`worker-0..2`, `/dev/vdb`, RFC 5737 addresses).
- Boundary is `Deno.Command` (not `fetch`) — a reassignable fake stub captures
  every `{command, args}` invocation and returns a queued
  `{success, stdout, stderr}`, with `@std/testing` `FakeTime` collapsing the
  model's one-at-a-time 5s retry delays for the retry-exhaustion tests.
- The two live pre-flight checks (`cluster-reachable`,
  `linstor-controller-ready`) are exercised directly via
  `model.checks[<name>].execute()`, not just the 6 methods — closing a round-1
  review HIGH finding that the destructive-op guards themselves were untested.
- `createZfsPool`'s idempotency-key guard (`node` + `storagePool` NAME only,
  never `device`) is pinned in both fail-open directions: a different
  storagePool name on the same device still issues the destructive
  create-device-pool call (wipe), and — per a review fold-in — the same
  storagePool name with a _different_ requested device is silently suppressed as
  "already exists" without ever provisioning the requested device. Neither is
  fixed here; both are tracked as `cozystack-linstor-fail-open-guards`.
- The `linstor-controller-ready` check's `parseInt(stdout) < 1` comparison is
  pinned as fail-open on a non-numeric `stdout` (`parseInt("abc")` is `NaN`, and
  `NaN < 1` is `false`) — a review fold-in, also tracked separately.
- `deno.json`: default `test` task stays network-less (no `--allow-net`,
  `--allow-run`, or `--allow-read` — `Deno.Command` is stubbed and fixtures are
  static imports), scoped to `--allow-env=FC_NUM_RUNS`; added `test:soak` for
  the high-count nightly property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na`
  (cozystack-linstor bundles no Claude skill). Ratchet baseline set to the
  measured `swamp extension quality` score. Removed from `quality-allowlist.txt`
  in the same change.

## 2026.07.16.2

Initial release: Linstor distributed storage management for Cozystack —
`getLinstorControllerStatus`, `listNodes`, `listStoragePools`, `createZfsPool`
(idempotent ZFS pool creation), `setZfsFailmode`, and `applyStorageClasses`,
gated by live `cluster-reachable` and `linstor-controller-ready` pre-flight
checks before any destructive operation.
