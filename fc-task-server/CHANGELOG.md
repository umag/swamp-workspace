# Changelog

All notable changes to `@magistr/fc-task-server`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## Unreleased — five-suite test backfill (ext-quality-bf-fc-task-server)

### Added

Test-only / docs-only change — `fc_task_server.ts`, `lib/ssh.ts`, and
`manifest.yaml` are byte-identical to `2026.07.16.2` (no version bump). Brings
the extension to five-suite + docs Grade-A quality compliance by CHARACTERIZING
the frozen source:

- `fc_task_server_test.ts` (contract-fixture) extended with `@std/testing`
  FakeTime exact-output resource pins for all 4 methods against a stubbed
  `Deno.Command` SSH boundary.
- `fc_task_server_methods_test.ts` (new) — every method's happy + failure path,
  plus the `host-reachable` check's both branches, plus an OAuth-token non-leak
  spot check.
- `fc_task_server_adversarial_test.ts` (new) — hostile schema inputs, a
  mechanical OAuth-token secret-scan, and pins for three latent bugs found
  during this backfill (tracked in the LOCAL `fc-task-server-latent-bugs`
  issue-lifecycle model, never the swamp.club Lab):
  - **B1** (MEDIUM, guest-side) — the deployed tap-server's `inject` command
    unlinks any existing, uncollected result file BEFORE writing the new task,
    silently discarding it. String/structure-pinned only — the guest-side python
    never executes in this suite.
  - **B2** (LOW) — `tapIp` is escaped with `shellEsc` (bash single-quote
    escaping) but then embedded inside a bash DOUBLE-quoted
    `python3 -c
    "..."` argument in `deploy`'s port-probe command. Single
    quotes have no special meaning to bash inside a double-quoted string, so a
    hostile `tapIp` containing `$(...)`/backticks still achieves command
    substitution on the host before python3 ever runs.
  - **B4** (LOW) — `inject_task`/`collect_result`/`stop` never check that a
    server was actually `deploy()`-ed first; they issue their ssh command
    unconditionally.
- `fc_task_server_coverage_test.ts` (new) — `netns`/`gitRepoUrl`/`model`/
  `effort` branch sweep across all 4 methods, plus **B3** (LOW) — a leading
  non-digit line in `deploy`'s pid-echo stdout defeats `parseInt` and writes
  `NaN` as the pid with no validation.
- `fc_task_server_property_test.ts` (new) — `npm:fast-check@4.8.0` property
  tests (honoring `FC_NUM_RUNS`): a POSITIVE proof that `controlPlanePaths`'
  `${netns}-${tapPort}` key is injective (confirming the 2026.06.11.3
  netns-keying fix is sound), and `inject_task`'s task-JSON round-trip
  invariant. **B5** (LOW/info, grouped concurrency/resource edge) — `deploy`'s
  kill-old-pid sequence is fire-and-forget, with no check that the old process
  actually died before the replacement starts — noted in the adversarial suite
  alongside B1/B2/B4.
- `quality.yaml` rewritten: all 5 test suites `present`; `docs.readme` /
  `docs.changelog` present; `docs.skill` `na` (bundles no Claude skill);
  `watch`/`canary` stay `backlog` (seeded CI-gate offenders, tracked in
  `ext-quality-test-backfill`); `ratchet` 100%, "Grade A".
- Removed from the repo-root `quality-allowlist.txt`.

## 2026.07.16.2 — version alignment

### Changed

- No functional change. `extensions/models/fc_task_server.ts`'s `version:`
  field is brought back in line with the manifest version (part of a
  repo-wide maintenance release across the `@magistr` extensions, commit
  `7eb5eec`), so the published model type version and the package version no
  longer drift — the "Check model version matches manifest" CI gate enforces
  this equality and this package had drifted from it.

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
