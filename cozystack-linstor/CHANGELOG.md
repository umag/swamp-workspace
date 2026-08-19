# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.01.1

Fixes the HIGH device-reuse fail-open guard in `createZfsPool`
(`cozystack-linstor-fail-open-guards`, local model). The idempotency decision
was previously (node, storagePool NAME) only and never considered `device`:

- **Direction A (device wipe)**: reusing an already-provisioned device under a
  DIFFERENT storage-pool name fell through to the destructive
  `physical-storage create-device-pool` call — a device wipe. Now REFUSED
  (`success:false`).
- **Direction B (silent no-op)**: the SAME storage-pool name with a DIFFERENT
  requested device was silently suppressed as "already exists" (`success:true`)
  without ever provisioning the requested device. Now REFUSED (`success:false`)
  instead of silently discarding the request.

Fix is verify-before-destructive (CLAUDE.md Rule 5): `createZfsPool` now reads
LINSTOR's live `physical-storage list` inventory to establish
device-availability BEFORE any create decision, and folds it together with the
existing (node, storagePool) name match into a 4-way branch:

- `nameMatch && !deviceFree` -> idempotent no-op (unchanged, `success:true`)
- `nameMatch && deviceFree` -> Direction B, REFUSED (`success:false`)
- `!nameMatch && !deviceFree` -> Direction A, REFUSED (`success:false`)
- `!nameMatch && deviceFree` -> legit create (unchanged, `create-device-pool`
  argv stays byte-identical)

A device absent from the live inventory is conservatively treated as "in use"
(fail-closed), per the documented conservative bias in the plan.

- `extensions/models/cozystack_linstor.ts`: added the physical-storage inventory
  read + 4-way branch in `createZfsPool.execute`; `model.version` bumped to
  `2026.08.01.1`.
- `fixtures/physical-storage-list.json`: new synthetic fixture (doc-derived from
  LINBIT's `linstor-api-py` `PhysicalDevice`/`NodeStorageEntry` response
  classes, no live capture) plus a `fixtures/PROVENANCE.md` entry.
- `cozystack_linstor_adversarial_test.ts`: the two fail-open characterization
  pins are flipped to assert refusal (no `create-device-pool` call,
  `success:false`); `fixtures-secret-scan` FIXTURES map extended with the new
  fixture.
- `cozystack_linstor_methods_test.ts` / `cozystack_linstor_property_test.ts` /
  `cozystack_linstor_coverage_test.ts`: harness updates for the inserted
  physical-storage-list read and shifted invocation indices; the legit-create
  and genuine-idempotent-no-op paths stay green.

Also included in this release (previously unreleased): the test backfill to the
STANDARD.md five-suite quality bar (wave-1 child of the extension-quality
backfill program, `ext-quality-test-backfill`) — no behavior change of its own,
the model `version` stayed `2026.07.16.2` until this release's guard fix above.

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
  never `device`) was pinned in both fail-open directions at the time of this
  test backfill: a different storagePool name on the same device still issued
  the destructive create-device-pool call (wipe), and — per a review fold-in —
  the same storagePool name with a _different_ requested device was silently
  suppressed as "already exists" without ever provisioning the requested device.
  Both directions are FIXED by this same release (see above,
  `cozystack-linstor-fail-open-guards`).
- The `linstor-controller-ready` check's `parseInt(stdout) < 1` comparison is
  still pinned as fail-open on a non-numeric `stdout` (`parseInt("abc")` is
  `NaN`, and `NaN < 1` is `false`) — a review fold-in, tracked separately and
  NOT fixed by this release (out of scope for
  `cozystack-linstor-fail-open-guards` Bug 1; tracked as Bug 2).
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
