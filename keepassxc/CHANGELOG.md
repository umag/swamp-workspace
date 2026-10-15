# Changelog

## 2026.10.15.9

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.8

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.7

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.6

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.5

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.4

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.3

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.1

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.14.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.09.30.1

### Added

- Initial release. `@magistr/keepassxc` vault backed by a running KeePassXC
  through the Browser Integration protocol (`keepassxc-proxy`, NaCl box,
  native-messaging framing).
- `get` / `put` / `list` over entries `swamp://<namespace>/<key>` (username =
  key, password = value) in a configurable group, created on first write.
- One-time association via KeePassXC's GUI dialog; key stored at
  `~/.config/swamp/keepassxc/<vault>.json` (mode 0600).
- Locked database: `triggerUnlock` shows KeePassXC's unlock dialog and the call
  is retried for `unlockWaitSeconds`.
- Idempotent `put`: an unchanged value sends no update (no GUI prompt).
- Reply nonces are verified to be the incremented request nonce; ciphertext
  failing the MAC is rejected.
- Wire-format fixtures captured from a live KeePassXC 2.7.11.
