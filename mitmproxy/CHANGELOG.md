# Changelog

## 2026.10.21.2

### Fixed

- Option keys must start with a letter. `__proto__` was accepted, then silently
  dropped. Keys containing digits, such as `http2`, are now accepted.

## 2026.10.21.1

### Added

- Initial release: `install`, `status`, `start`, `stop`, `flows`, `clear_flows`
  and `trust_ca` for a local mitmproxy.
