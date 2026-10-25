# Changelog

## 2026.10.25.5

### Added

- `vm.provision`: create a VM from a cloud image with only `qemu-img`, `curl`,
  `sha256sum`/`sha512sum` and `sh` on the hypervisor (no `virt-install`, ISO
  tool or storage pool; works on Unraid). It downloads and verifies the image
  (pinned `checksum`, or SHA256SUMS/SHA512SUMS) into a cache, copies or overlays
  it into `<storageDir>/<name>/`, builds the cloud-init NoCloud seed ISO in
  TypeScript, defines a q35 domain with swamp metadata and a name-derived MAC,
  starts it, and waits for the guest agent's address. Idempotent; never
  overwrites a leftover disk; cleans up its own files if a step fails.
- Review fixes before release: storage delete removes only the two files the
  domain's XML names (then `rmdir`, never `rm -rf`); an atomic `mkdir` claim of
  the VM folder blocks concurrent or leftover provisions; images with a backing
  file or the wrong format are refused; the cache file is 0444; disk size below
  the image size is refused; http sources need a pinned checksum; local mode
  with a remote `uri` is refused for file steps; `paused` is resumed; provision
  refuses a same-named non-swamp domain; `sync` gains `forceStopAfterWait` and
  undefines with `--snapshots-metadata`.
- `vm.connection` and the `connection` resource: ip, mac, addresses, source
  (`agent`/`lease`/`arp`/`none`), sshUser and hostname for later steps.
- `vm.plan` / `vm.sync` and the `plan` resource: a desired VM list (`running` /
  `stopped` / `absent`) is turned into create / start / stop / delete / refuse /
  none actions. Delete needs `allowDelete` and applies only to domains with
  swamp metadata; memory/vCPU drift is reported, not changed.
- `runOnHost` (SSH or local) with text or byte stdin, used for the file steps.

### Notes

- Found in the live test on Unraid: the seed must be a virtio disk, not a SATA
  CD-ROM. Ubuntu's minimal cloud images boot `linux-kvm`, which has no CD-ROM
  driver, so cloud-init never saw the seed.
- Found in the live test too: a DHCP lease from an earlier boot with the same
  MAC named the wrong address (`.244` while the guest had `.245`). With the
  guest agent enabled, only the agent is trusted while waiting; the lease is a
  logged fallback at the deadline.
- `makeNoCloudIso` is adapted from `@evrardjp/cloud-init-nocloud` (Apache
  License 2.0); see LICENSE.md and LICENSE-APACHE-2.0.txt. The plan/sync shape
  follows `@evrardjp/libvirt-vm-pool`, and the checksum handling follows
  `@taylor/libvirt` (ideas only).

## 2026.10.25.4

### Added

- SSH connection sharing: `multiplex` (default `true`) runs ssh with
  `ControlMaster=auto` and `ControlPersist=30`, so a run's virsh calls reuse one
  connection. Measured against Unraid: about 300 ms per call without it, about
  50 ms with it. Sockets are in a per-process 0700 directory under `/tmp`
  (removed at exit). Each is named by 16 hex chars of a SHA-256 over the target
  (user, host, port, jump host) and the security settings (host-key policy,
  pinned keys, identity file, `sshConfig`), so a `strict` call never reuses an
  `accept-new` master. ssh's `%C` is not used: with the 17-char suffix ssh adds
  while binding, it overflows the ~104-byte socket path limit on macOS. If the
  path would still be too long, sharing is skipped.
- SSH settings `port` (`-p`), `identityFile` (`-i`, `IdentitiesOnly=yes`),
  `jumpHost` (`-J`; no hop may start with `-`), `sshConfig` (extra
  `-o Key=Value` from an allowlist of connection-tuning keys; see README) and
  `become` (default `false`: remote commands run under `sudo -n`). They apply in
  SSH mode only; setting one in local mode throws before any process starts.
- With `multiplex`, `ServerAliveInterval=5` and `ServerAliveCountMax=2` (after
  `sshConfig`, so a user value wins): a reused connection skips
  `ConnectTimeout`, so keepalives bound a call on a dead master to ~10 s. The
  socket directory is checked (owner, 0700, not a symlink) before every call and
  replaced if the check fails.
- `SshConnectionError`: ssh exit 255 now throws, naming `user@host` and ssh's
  stderr, from `virshTry`, `virsh`, `runSshRaw`, `defineXml` and
  `vm.consoleCapture`. Before, `virshTry` returned the result, and a caller
  matching virsh stderr for idempotency could act on a transport failure.

### Changed

- `host` and `user` may not start with `-` or contain whitespace, `@` or control
  characters, and ssh gets `--` before the destination (a `user` such as
  `-oProxyCommand=…` used to reach ssh as an option).
- `buildInvocation`, `buildSshRaw`, `sshOptions` and `buildConsoleInvocation`
  take an `SshCallContext` (`{ knownHostsFile?, controlPath? }`) in place of the
  bare `knownHostsFile` string. `withHostKeys` is now `withSsh`.

Ideas from `@taylor/libvirt` (connection sharing, the ssh settings and the
exit-255 rule); no code was copied (it is AGPL-3.0).

## 2026.10.25.3

### Added

- `vm.consoleCapture` (#262): a bounded, read-only capture of a domain's serial
  console, for diagnosing guests that hang before they reach the network.
  - Arguments: `name`, optional `device` (`--devname`, for domains with more
    than one console), required `timeoutSeconds` (1-300), and `force` (default
    true: passes `--force`, which disconnects an existing console session).
  - SSH mode runs
    `env SHELL=/bin/sh timeout -k 5 <n> script -qec '<virsh console …>' /dev/null`
    on the hypervisor (needs coreutils `timeout` and util-linux `script` there),
    with a Deno-side kill timer on the ssh process as a backstop. Local mode
    runs `script` on the swamp host (`-qec` on Linux, `script -q /dev/null …` on
    macOS/BSD) under a Deno-side kill timer (SIGTERM at the deadline, SIGKILL 3
    s later).
  - Read-only: the process's stdin is held open and never written, so no input
    reaches the guest console.
  - Terminal control sequences are stripped. The last 256 KiB of text is kept
    (`truncated` flags a cut).
  - Stored in the new `console` resource (instance `<name>` or
    `<name>-<device>`) with `ended: deadline | exited`, `bytes`, and `text`.
    `text` is marked sensitive (`.meta({ sensitive: true })`), so swamp stores
    it in a vault. It is never logged. A virsh/ssh failure throws with only the
    `error:` lines and stderr, never console content.
  - Domain names may not start with `-` or contain control characters. Device
    aliases must match `[A-Za-z0-9][A-Za-z0-9_.-]*`. In SSH mode the inner
    command is shell-quoted for both shells it passes through.

## 2026.10.25.2

### Added

- Optional strict / pinned SSH host-key policy (#260), as two new global
  arguments on every model:
  - `hostKeyPolicy: "accept-new" | "strict"` (default `accept-new`, so existing
    definitions behave exactly as before).
  - `knownHosts: string[]`: OpenSSH known_hosts lines for the hypervisor.
- With `strict`, every ssh call writes the `knownHosts` lines to its own temp
  file (created with `Deno.makeTempFile`, chmod 0600 before the keys are
  written, removed afterwards even on error) and runs ssh with
  `StrictHostKeyChecking=yes`, `UserKnownHostsFile=<that file>`,
  `GlobalKnownHostsFile=/dev/null` and `UpdateHostKeys=no`. An unknown or
  changed host key fails closed, and the runner's `~/.ssh/known_hosts` is
  neither read nor written in this mode.
- Misconfiguration fails closed before any file or process is created: `strict`
  without `knownHosts`, `strict` in local/URI mode (virsh's own `qemu+ssh://`
  transport is not governed by these options), and `knownHosts` without `strict`
  (the keys would be ignored) are errors.
- Each `knownHosts` entry must be exactly one known_hosts line
  (`[@cert-authority|@revoked] <hosts> <key-type> <base64-key> [comment]`). A
  line with a newline or any other control character is rejected, both at
  definition time (zod) and per call.

## 2026.10.25.1

### Changed

- `storage.volClone` is now idempotent by target name (#261). It first checks
  the target with `virsh vol-info <newName> --pool <pool>`; if the volume
  already exists the call is a no-op success
  (`message: "<pool>/<newName> already exists (idempotent)"`) and `vol-clone` is
  never issued, so a re-run never clones over an existing volume (run
  `volDelete` first for a fresh copy). A target that appears between the check
  and the clone is caught by the shared `alreadyExists` matcher. Works for any
  pool driver, including zfs pools whose golden image is a zvol.

### Added

- `storage.volClone`'s `actionResult` now records `idempotent` (true when the
  target already existed) and, read best-effort from `vol-dumpxml`, the target's
  `format` and `capacityBytes`. The fields are optional on the shared
  `actionResult` schema, so existing records stay valid.

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

## 2026.09.19.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.09.17.1

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

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
