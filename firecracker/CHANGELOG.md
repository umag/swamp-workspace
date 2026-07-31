# Changelog

All notable changes to `@magistr/firecracker`. Versions are CalVer
(`YYYY.MM.DD.MICRO`).

## Unreleased — test/docs-only: five-suite quality backfill (Grade A)

### Added

- `extensions/models/firecracker_methods_test.ts`,
  `firecracker_adversarial_test.ts`, `firecracker_coverage_test.ts`, and
  `firecracker_property_test.ts` — the model now has full five-suite coverage
  (contract-fixture, methods, adversarial, coverage, property-invariant-flow),
  characterizing all 27 methods + both pre-flight checks against a stubbed
  `Deno.Command` (SSH boundary). No behavior change — `firecracker.ts` and
  `lib/ssh.ts` are byte-identical (frozen source; ext-quality-bf-firecracker).
- Six known issues pinned as characterization tests, tracked in the LOCAL
  `firecracker-latent-bugs` issue-lifecycle bug model (never the Lab): BUG-1
  (HIGH) — unvalidated `arch` in `install_firecracker` reaches a double-quoted
  `python3 -c` block where bash still expands `$(...)` before python ever runs;
  BUG-2 (MED) — the fabric OAuth token appears in cleartext in the local `ssh`
  subprocess's argv (`buildDeployFabricCmd`); BUG-3 (MED) — the two
  internet-facing binary downloads (`install_firecracker`,
  `install_guest_kernel`) carry no `--max-time`/`--connect-timeout`; BUG-4 (LOW)
  — `install_guest_kernel`'s `sed "s|@@ARCH@@|$ARCH|g"` corrupts on a
  pipe-containing `arch`; BUG-5 (LOW/info) — only `stop` prechecks VM state
  before acting, unlike `start`/`pause`/`resume`/`send_ctrl_alt_del`; BUG-6
  (CRITICAL, newly found by this backfill) — `build_ubuntu_rootfs` and
  `update_agent_script` call plain `btoa(AGENT_SCRIPT)` and AGENT_SCRIPT's own
  source contains a non-Latin1 em-dash, so BOTH methods throw unconditionally,
  before any ssh call — a total, unconditional loss of function for 2 of the 27
  methods. **BUG-1 and BUG-6 were real, fixable defects (not accepted latent
  bugs) and are FIXED in `2026.07.31.1` below; BUG-2/3/4/5 remain open, tracked
  latent bugs.**

## 2026.07.31.1 — fix: UTF-8-safe AGENT_SCRIPT base64 (BUG-6, CRITICAL) + arch allowlist (BUG-1, HIGH)

### Fixed

- **BUG-6 (CRITICAL, total loss of function).** `build_ubuntu_rootfs` and
  `update_agent_script` called plain `btoa(AGENT_SCRIPT)` as their first
  statement; `AGENT_SCRIPT`'s source contains a non-Latin1 em-dash ("captures
  stdout ONLY — NO 2>&1"), and `btoa` only handles Latin1, so both methods threw
  unconditionally, before any ssh call was ever attempted — 2 of the 27 methods
  were 100% broken for every caller. Both now route through the existing
  `utf8ToBase64` helper (already used elsewhere in this module, e.g. the fabric
  queue payload), so the guest-side `base64 -d` decode reproduces the exact
  UTF-8 bytes. No other behavior change.
- **BUG-1 (HIGH, command/argument injection).** `install_firecracker`'s `arch`
  argument had no schema validation (`z.string().optional()`) and was safely
  `shellEsc`'d in one place but raw-interpolated in another — directly into a
  bash double-quoted `python3 -c "..."` block, where bash expands
  `$(...)`/backticks before python ever runs, giving a hostile `arch` full
  remote command execution. Closed by adding a strict allowlist regex
  (`ARCH_RE = /^[A-Za-z0-9_-]+$/`) to the schema, rejecting any hostile value at
  `parse()` before it can reach either interpolation site.
  `install_guest_kernel`'s `arch` is intentionally left unchanged (out of scope;
  see the still-open BUG-4 above, a separate `sed`-delimiter issue on that same
  field).

Both defects were confirmed real, fixable bugs (not accepted latent bugs) and
are tracked end-to-end in the LOCAL `firecracker-realfix` issue-lifecycle model
— never the swamp.club Lab, per this repo's tracking convention.

## 2026.06.19.2 — maintenance: CI republish

No code change. `2026.06.19.1` was published manually, which collided with the
CI publish-on-push for the same version ("version already exists"). This release
is cut by CI, with per-version release notes now sourced from this CHANGELOG.

## 2026.06.19.1 — docs: task-oriented README

### Changed

- README rewritten in a task-oriented shape (Tutorial → How-to → Reference →
  Explanation), folding in the `submit … outputFormat=json` opt-in and keeping
  the netns-isolation, fabric-semantics, and security detail. Docs-only — no
  behaviour/schema change.

## 2026.06.18.1 — opt-in JSON leaf output (fabric)

### Added

- `submit` accepts an optional `outputFormat` (`text` default | `json`). In
  `json` mode the warm-worker runner runs `claude --print --output-format json`
  capturing stdout ONLY (no `2>&1`) and WITHOUT the `ERROR:` prefix, so the JSON
  stays valid; `is_error` is the failure signal. The default (text) path is
  byte-identical, so existing consumers are unaffected. Enables per-leaf
  usage/cost/time capture for `@magistr/swamp-go-brr` observability (issue
  `gobrr-observability`).

## 2026.06.17.1 — fabric default concurrency raised to 8

### Changed

- `fabric_up`, `fabric_recycle`, and `fabric_down` `concurrency` default `4 → 8`
  (still `min(1).max(64)`). Leaf worker VMs are I/O-bound on the model API and
  cost ≈512 MiB RAM each, so 8 ≈ 4 GiB fits an 8 GiB FC host. Above ~6–8,
  validate the warm pool with a probe task after `fabric_up` (the netns-uplink
  readiness gate) before trusting it.

## 2026.06.12.3 — fabric netns uplink readiness gate

### Fixed

- `fabric_up`/`fabric_recycle` no longer count a warm worker "ready" while its
  network namespace lacks the veth uplink, which intermittently left guests
  failing every task with `Unable to connect to API (ConnectionRefused)`. Three
  changes in `bringUpWorker`/`setup_tap`:
  - **Root cause:** `setup_tap` gated veth-pair (re)creation on the _root-side_
    veth while the failure manifests as a missing _ns-side_ `fcveth0`; a
    persisted/half-torn-down netns would short-circuit and never get repaired.
    The guard is now keyed on `fcveth0` inside the namespace (delete any stale
    root-side half, then rebuild the pair), so a half-built netns self-heals.
  - **Readiness gate:** `bringUpWorker` now runs a new `buildVerifyNetnsCmd`
    assertion (fcveth0 address + tap up + default route, inside the netns) after
    `setup_tap`, with a bounded retry (initial + 2), and throws if it never
    comes up — so a half-built worker is recorded as a failure, never a healthy
    pool member. The verify checks host↔netns wiring only, not in-guest routing.
  - **No-uplink fail-fast:** `setup_tap` now aborts loudly when the host has no
    default route instead of building an `-o ""` host MASQUERADE that the in-ns
    verify could not catch.
- No snapshot re-bake needed (host-side wiring only); the single-VM
  root-namespace `setup_tap` path is unchanged.

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
