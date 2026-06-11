# Changelog

All notable changes to `@magistr/fc-task-server`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.06.12.1 — publish docs

### Changed

- The CHANGELOG is now bundled in the published archive (added to
  `additionalFiles`). No model behaviour change.

## 2026.06.11.3 — concurrency-safe control-plane paths

### Fixed

- The control-plane files (`/tmp/fc-task-*.json`, `/tmp/fc-result-*.txt`,
  `/tmp/fc-tap-server-*.{pid,py,log}`) were keyed by `tapPort` only. A network
  namespace does **not** isolate `/tmp`, and every guest pins port `8080`, so
  concurrent VMs shared one task/result file on the host — tasks could be
  consumed by the wrong VM's guest and results could clobber each other. The
  paths are now keyed by `netns` too (`netns-tapPort`) via a `controlPlanePaths`
  helper used by `deploy`/`inject_task`/`collect_result`/`stop`. With no `netns`
  the keys stay port-only, so the single-VM paths are unchanged.

## 2026.06.11.2 — network-namespace support

### Added

- A `netns` global argument. When set, `deploy` binds the task server **inside**
  the namespace (`ip netns exec`) so the isolated guest can reach it — pairs
  with `@magistr/firecracker`'s per-VM netns isolation. Omit for the single-VM
  path.

## 2026.06.09.3 — default reasoning effort to low

### Added

- An `effort` argument on `inject_task` (`low`/`medium`/`high`/`xhigh`/`max`,
  default `low`), written into the task JSON and passed to the guest's
  `claude --print --effort`.

## 2026.06.09.2 — relocated to the workspace monorepo (Grade A)

### Changed

- Repackaged into the `swamp-workspace` monorepo with README, MIT LICENSE,
  repository metadata, unit tests, and pre-flight checks. Quality 14/14 (Grade
  A).

## 2026.06.09.1 — initial release

- Host↔guest task/result control-plane server for Firecracker microVM agents
  (not an internet proxy). Deploys a small Python TCP HTTP server on the host
  TAP interface that serves the per-run job (prompt + model + OAuth token,
  injected at serve time) on `GET /task` and collects the agent's output on
  `POST
  /result`. Methods: `deploy`, `inject_task`, `collect_result`, `stop`.
