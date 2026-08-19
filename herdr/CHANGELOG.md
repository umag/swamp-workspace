# Changelog

## 2026.08.19.1

- Version bump and smoke test

All notable changes to `@magistr/herdr` are documented here.

## 2026.08.08.1

Server lifecycle, and an ssh transport so all of it works against a herdr on
another host.

### Added

- **SSH transport.** Setting `sshHost` points the whole model at a remote herdr
  server; every existing method works unchanged against it. New global
  arguments: `sshHost`, `sshUser`, `sshPort`, `sshIdentityFile`, `sshExtraArgs`,
  `remoteBinary`. `ssh` is invoked with `BatchMode=yes` and `ConnectTimeout=10`
  so an unattended run never blocks on a prompt; caller options are placed
  first, which is what makes them win.
- Eight server/session methods: `server-stop`, `server-reload-config`,
  `server-live-handoff`, `agent-manifests`, `update-agent-manifests`,
  `reload-agent-manifests`, `session-stop`, `session-delete`.
- New `manifests` resource — per-agent detection-manifest version, source
  (bundled vs remote), and any manifest herdr rejected with a warning.
- `status` now also reports `target` / `remote` (which server it talked to) and
  `configOk` / `configDetail` from herdr's own `config check`.

### Changed

- `update-agent-manifests` reads the current versions before updating, so its
  `changedAgents` names exactly which agents moved. herdr's own output reports
  only the post-update state, which cannot answer "did anything change?".
- `server-reload-config` refuses to reload a config.toml that fails validation,
  rather than pushing a broken config into a live fleet.

### Security

- Over ssh a remote shell is unavoidable, so every argument is POSIX
  single-quoted with no "looks safe, skip it" fast path. The quoting is proved
  by round-tripping through a real `/bin/sh` in the property suite — a
  hand-written decoder could share a blind spot with the encoder.
- **The self guard does not fire against a remote fleet.** `HERDR_PANE_ID` names
  a pane on the LOCAL server, and herdr numbers panes per session, so a local
  `w1:p4` and a remote `w1:p4` are unrelated panes that share a string. Matching
  there would refuse legitimate remote closes and silently skip legitimate
  remote prompts.
- `server-stop` refuses to stop a LOCAL server that hosts the pane running the
  method; `session-stop` / `session-delete` refuse the session in use.
  `session-delete` also refuses a still-running session unless forced.

## 2026.08.07.1

Initial release. Built and verified against herdr 0.8.0 (socket protocol 19).

### Added

- `@magistr/herdr` model type with 16 methods over the herdr CLI:
  - observe — `status`, `snapshot`, `read`
  - drive — `prompt`, `wait-agent`, `start-agent`, `send-keys`, `send-text`,
    `run-command`, `wait-output`
  - shape — `create-workspace`, `create-tab`, `split-pane`, `create-worktree`,
    `close`, `notify`
- Six resources: `status`, `fleet`, `agent`, `output`, `action`, `container`.
- Idempotency by state-read: `close` on a missing id is a recorded no-op;
  `create-workspace` / `create-tab` / `create-worktree` reuse a matching label
  or branch; `start-agent` leaves an occupied pane alone.
- Self-protection from `HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID`:
  `close` refuses to close the caller's own container, and `prompt` skips the
  caller's pane.
- Fan-out over `targets` with per-target error isolation, an optional
  `failFast`, and a hard failure (writing nothing) when every target fails.
- Captured terminal text bounded by `maxOutputBytes` without splitting a UTF-8
  code point.
- Five test suites: contract-fixture, methods, adversarial, coverage, and
  property/invariant/flow (fast-check, `FC_NUM_RUNS`-gated). None of them spawns
  a process or opens a socket.

### Notes

herdr's CLI emits three output shapes, all handled: a JSON envelope for
socket-backed subcommands, **no output at all** for `pane send-text` /
`send-keys` / `run`, and raw text for `pane read` / `agent read` / `status`.
Treating the silent-success case as a parse failure was the first defect this
extension's contract suite pinned.
