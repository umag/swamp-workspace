# Changelog

## 2026.08.19.1

- Version bump and smoke test

All notable changes to `@bad-at-naming/libvirt`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.08.01.1 — vm.stop wait-for-shutdown guard + test-backfill to the five-suite quality standard

### Fixed

- **`@bad-at-naming/libvirt/vm` `stop` (HIGH, data-loss)**: `stop` now waits for
  the domain to actually reach `shut off` before returning, instead of reporting
  state immediately after issuing `virsh shutdown`. A new bounded `waitSeconds`
  argument (`min(0)`, `max(3600)`, default `120`; `0` = fire-and-forget) polls
  every 3s; if the domain is still not `shut off` when `waitSeconds` elapses,
  `stop` now throws instead of returning a data-losing false-success. This
  closes the same class of race that caused the 2026-07-13
  `qemu-img`-live-resize incident (a dependent operation ran against a qcow2
  image before the owning domain had actually released it). The fix was proven
  in the homelab dev copy (`vm` v2026.07.13.1) and is ported here adapted to
  this package's `conn` abstraction (SSH + local/URI) via
  `getDomDetail(conn, name)` — the dev copy is SSH-only and could not be copied
  verbatim. Tracked as the local swamp issue-lifecycle model
  `libvirt-port-stop-wait-guard` (never filed upstream as a Lab issue —
  `@bad-at-naming/libvirt` is not a `@swamp/*` package).
- Two existing `vm.stop` characterization tests (`libvirt_methods_test.ts`,
  `libvirt_coverage_test.ts`) are flipped from mocking `dominfo` as
  `"in shutdown"` to `"shut off"`, matching the new wait-then-return contract;
  the shutdown-verb and never-`destroy` assertions are unaffected. Three new
  wait-guard tests and one schema-boundary test are added
  (`libvirt_methods_test.ts`), using `deno.land/std@0.224.0/testing/time.ts`
  `FakeTime` to virtualize the 3s poll interval so the suite stays instant.
- `forceStop` (immediate `virsh destroy`) is unchanged — the wait guard only
  applies to the graceful path.

### Internal

- `@bad-at-naming/libvirt/network`, `/storage`, and `/host` model versions are
  bumped to `2026.08.01.1` in lockstep with `/vm` and `manifest.yaml` (version
  only — no behavior change) to satisfy this repo's CI invariant that every
  model's embedded `version` matches the manifest version.

Wave-1 gap-check child of `ext-quality-test-backfill`, following the pihole PR
#66 recipe, landed in this same release.

### Added

- `extensions/models/libvirt_methods_test.ts` — drives all 69 vm/network/
  storage/host methods' success and failure/idempotent paths against a stubbed
  `Deno.Command` subprocess boundary (no real virsh/ssh call).
- `extensions/models/libvirt_adversarial_test.ts` — hostile-input coverage:
  command-injection through the methods, the `setUserPassword` secret-leak
  guard, `dumpxml`/`snapshotDumpxml` log-redact-vs-store-raw pinning, and
  malformed-output handling.
- `extensions/models/libvirt_coverage_test.ts` — reviewer-guard regressions on
  the destructive lifecycle paths (VM stop-vs-destroy, `define`'s
  destroy/undefine gating, `undefine`'s three default-false flags,
  `snapshotDelete --children`, the storage/network destroy-verb mapping,
  `host.addRoute`), each paired with a positive control.
- `extensions/models/libvirt_property_test.ts` — `fast-check`-based invariants
  for `shellQuote`, `buildInvocation`, `redactSecrets`, `isIdempotent`, and the
  `parseVmList`/`parseKV` parsers, gated by `FC_NUM_RUNS` (`deno task test:soak`
  runs a 10000-iteration nightly soak).
- `quality.yaml`: all five required suites now `present`; `docs.readme` and
  `docs.changelog` `present`, `docs.skill` `na` (no bundled Claude skill);
  ratchet baseline set to the measured `100%` (Grade A, rubric v3).
- `libvirt` removed from the repo-root `quality-allowlist.txt` in this same
  change.

### Unchanged

- The three pre-existing test files (`libvirt_parse_test.ts`,
  `libvirt_connection_test.ts`, `libvirt_idempotency_test.ts`) are byte-for-byte
  unchanged — they remain the `contract-fixture` anchor.
- `lib/connection.ts` and `lib/parse.ts` runtime source is untouched.

## 2026.05.25.1 — idempotent network start/stop

Fixes
[umag/swamp-workspace#1](https://github.com/umag/swamp-workspace/issues/1).

### Fixed

- `@bad-at-naming/libvirt/network` `start` and `stop` are now **idempotent**,
  matching the VM model. `start` no longer throws when the network is already
  active (`net-start` → "network is already active"); `stop` no longer throws
  when the network is already inactive (`net-destroy` → "network 'x' is not
  active"). Both now log + write an `actionResult` no-op instead.
- A genuine failure (e.g. starting a non-existent network) still throws — the
  idempotency check is anchored to the specific virsh error substrings.

### Internal

- Added `networkAlreadyActive` and `networkNotActive` sets to the shared
  `IDEMPOTENT_ERRORS` policy in `lib/connection.ts`, pinned to real virsh
  strings by `libvirt_idempotency_test.ts`.
