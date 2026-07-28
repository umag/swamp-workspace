# Changelog

All notable changes to `@bad-at-naming/libvirt`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## Unreleased — test-backfill to the five-suite quality standard

Wave-1 gap-check child of `ext-quality-test-backfill`, following the pihole PR
#66 recipe. **Tests and tooling only — no runtime code or manifest version
changed.**

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
- No `libvirt_vm.ts` / `libvirt_network.ts` / `libvirt_storage.ts` /
  `libvirt_host.ts` / `lib/connection.ts` / `lib/parse.ts` runtime source was
  touched, and `manifest.yaml`'s version is unchanged.

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
