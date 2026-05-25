# Changelog

All notable changes to `@bad-at-naming/libvirt`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.05.25.1 — idempotent network start/stop

Fixes [umag/swamp-workspace#1](https://github.com/umag/swamp-workspace/issues/1).

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
