# Changelog

All notable changes to `@magistr/firecracker`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## 2026.06.12.2 — UTF-8-safe fabric base64

### Fixed

- `submit` and `poll` now encode/decode the queue payload as UTF-8
  (`utf8ToBase64` + `TextDecoder`) instead of `btoa`/`atob`, which only handle
  Latin1 — `submit` threw "characters outside of the Latin1 range" and `poll`
  corrupted multibyte chars on any task prompt or result embedding non-ASCII
  file content (emoji, box-drawing, CJK). Adds a round-trip regression test. No
  other behaviour change.

## 2026.06.12.1 — publish docs

### Changed

- The CHANGELOG is now bundled in the published archive (added to
  `additionalFiles`), and the README's Methods list points at the task-fabric
  methods. No model behaviour change.

## 2026.06.11.7 — Fast task fabric (warm worker pool + queue)

### Added

- A factory + queue for running many agent tasks over a **warm worker pool**,
  with no per-task workflow authoring: `fabric_up` (fan out `N` warm worker VMs,
  each in its own netns, pulling from a shared host queue), `submit`
  (non-blocking enqueue, returns task ids), `poll` (collect results by id +
  pending count), `fabric_recycle` (liveness watchdog — restart a worker whose
  claimed task is older than a timeout and re-queue the task), and `fabric_down`
  (reap the whole pool, discovered from host state).
- Execution is **at-least-once** and clobber-safe: the daemon injects the OAuth
  token at serve time (never written to the queue), a malformed task is
  quarantined instead of wedging a slot, and a stale result from a recycled
  worker is dropped. See the README "Fast task fabric" section.

## 2026.06.11.4 — unattended agent

### Changed

- The baked PID-1 agent runs `claude --print --dangerously-skip-permissions`
  with `IS_SANDBOX=1` exported — the microVM is itself the sandbox, so the agent
  runs unattended without permission prompts (which would otherwise hang
  `--print`; `claude` also refuses skip-permissions as root without
  `IS_SANDBOX`). Requires a rootfs re-bake (`update_agent_script`) to take
  effect.

## 2026.06.11.2 — per-VM network-namespace isolation

### Added

- Run many clones of **one** base snapshot concurrently on one host without
  IP/gateway/task-server overlap, by isolation rather than re-addressing the
  guest (the upstream Firecracker "network for clones" pattern). The guest image
  is unchanged. `setup_tap` gains a `netns` mode (`netns` + `vethSubnet`)
  building the tap + veth + scoped double `MASQUERADE` inside a namespace;
  `start_vmm` launches Firecracker via `ip netns exec`; `restore` gains
  `network_overrides`; `kill_vmm` tears the namespace down and flushes its
  comment-tagged host rules. Empty `netns` keeps the single-VM path unchanged.

## 2026.06.09.20 — default agent effort to low

### Changed

- The in-guest agent runs `claude --print --effort <effort>`, taking the effort
  from the injected task (default `low`) to keep sandboxed runs fast and cheap.

## 2026.06.09.19 — relocated to the workspace monorepo (Grade A)

### Changed

- Repackaged into the `swamp-workspace` monorepo with README, MIT LICENSE,
  repository metadata, unit tests, and pre-flight checks (`valid-ssh-host`,
  `host-reachable`). Quality 14/14 (Grade A).

## 2026.06.09.18 — initial release

- Firecracker microVM lifecycle over SSH + the Unix-socket REST API: machine/
  boot/drive/network/vsock config, start/stop/pause/resume, snapshot/restore,
  precision `kill_vmm`, idempotent `start_vmm`, and host bootstrap
  (`install_firecracker`, `install_guest_kernel`, `setup_tap`,
  `build_ubuntu_rootfs`, `update_agent_script`). Ships the
  `fc-install-firecracker`, `fc-bake-snapshot`, and `fc-run-agent` workflows.
