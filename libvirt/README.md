# @bad-at-naming/libvirt

Comprehensive [libvirt](https://libvirt.org/)/`virsh` management for
[swamp](https://github.com/systeminit/swamp) — virtual machines, networks,
storage pools, volumes, snapshots, and hypervisor host info. Drive your KVM/QEMU
homelab or workstation declaratively, **over SSH or locally via a connection
URI**.

## Models

| Model                            | What it manages                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bad-at-naming/libvirt/vm`      | Domain lifecycle (start/stop/define/undefine/snapshot), CPU/memory tuning, disk/NIC hotplug, block/net/CPU/memory stats, guest-agent queries, serial console capture |
| `@bad-at-naming/libvirt/network` | Virtual network lifecycle (list/get/define/start/stop/autostart) and DHCP lease inspection                                                                           |
| `@bad-at-naming/libvirt/storage` | Storage pool and volume management (create/build/resize/clone/delete)                                                                                                |
| `@bad-at-naming/libvirt/host`    | Hypervisor host info, capabilities, SMBIOS sysinfo, node CPU/memory stats, device list, static routes                                                                |

## Connection modes

Each model instance picks its transport from `globalArguments`:

- **SSH mode** — set `host` (and optionally `user`, default `root`). `virsh`
  runs on the remote hypervisor over ssh; no local libvirt client is required.
- **Local / URI mode** — omit `host`. `virsh` runs on the swamp host and
  connects via `-c <uri>` (`uri` defaults to `qemu:///system`). Works with any
  libvirt URI, including `qemu+ssh://user@host/system`, `qemu+tls://…`, and
  `qemu:///session`.

In both modes the optional `uri` argument selects the libvirt connection.

### SSH settings

All optional, SSH mode only (setting one in local mode is an error — put ssh
settings in `~/.ssh/config` or the `qemu+ssh://` URI there instead):

| Argument       | Default | Effect                                                                      |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `port`         |         | ssh `-p`                                                                    |
| `identityFile` |         | ssh `-i <file>` with `IdentitiesOnly=yes`                                   |
| `jumpHost`     |         | ssh `-J`, e.g. `ops@bastion:2222`                                           |
| `sshConfig`    |         | Extra `-o Key=Value` settings, e.g. `{ServerAliveInterval: "15"}`           |
| `become`       | `false` | Run virsh and other remote commands under `sudo -n` (passwordless sudo)     |
| `multiplex`    | `true`  | Share one ssh connection across a run's calls (ControlMaster, 30 s persist) |

`sshConfig` takes only connection-tuning keys: `AddressFamily`, `Ciphers`,
`Compression`, `ConnectionAttempts`, `HostKeyAlgorithms`, `IPQoS`,
`KexAlgorithms`, `LogLevel`, `MACs`, `PubkeyAcceptedAlgorithms`,
`ServerAliveCountMax`, `ServerAliveInterval`, `TCPKeepAlive`. Other keys could
get past strict host-key pinning (`VerifyHostKeyDNS`, `HostKeyAlias`), run local
commands (`ProxyCommand`, `LocalCommand`) or change what runs (`RemoteCommand`,
`SessionType`), so they are refused. The host-key options always come first on
the ssh command line, and ssh keeps the first value it sees. `host` and `user`
may not start with `-`, and `--` separates the options from the destination.
With `jumpHost`, the bastion hop uses the runner's `~/.ssh/config` and
`known_hosts`, not `hostKeyPolicy`; the hypervisor's key is still checked end to
end.

With `multiplex` on, the first call opens a master connection and later calls
reuse it (about 300 ms per call down to about 50 ms against a LAN hypervisor).
Sockets live in a 0700 directory under `/tmp`, checked (owner, mode, not a
symlink) before every call and replaced if the check fails. It is removed at
normal process exit; a serve or worker stopped with SIGTERM leaves one empty
directory. An idle master exits after 30 s, and `ServerAliveInterval=5` /
`ServerAliveCountMax=2` make a call on a master whose link died fail in about 10
s. Each socket is named by a hash of the target AND its security settings, so a
`hostKeyPolicy: strict` call never reuses a connection opened under `accept-new`
or with other pinned keys.

If ssh exits 255 (unreachable, auth refused, host key rejected, connection
dropped, or the remote command killed by a signal) the method throws
`SshConnectionError` and writes nothing. A transport failure is never read as a
virsh answer such as "domain not found".

## Prerequisites

- **SSH mode**: ssh access to the hypervisor; `virsh` installed there.
- **Local/URI mode**: `libvirt-client` (provides `virsh`) installed on the swamp
  host, and a reachable libvirt daemon.

## Quick start

Remote hypervisor over SSH:

```bash
swamp model create @bad-at-naming/libvirt/vm vms --input host=10.0.0.5 --input user=root
swamp model method run vms list
swamp model method run vms start --input name=web
swamp model method run vms snapshotCreate --input name=web --input snapshotName=pre-upgrade
```

Local hypervisor (or any URI) — no `host`:

```bash
swamp model create @bad-at-naming/libvirt/host local-hv
swamp model method run local-hv info

# explicit URI (e.g. the user session, or a remote libvirt over its own ssh transport)
swamp model create @bad-at-naming/libvirt/network nets --input uri=qemu+ssh://root@10.0.0.5/system
swamp model method run nets list
```

## Idempotency

Several methods are safe to re-run:

- `vm.start` / `vm.stop` / `vm.forceStop` — a no-op if the domain is already in
  the target state.
- `vm.define` — undefines an existing domain of the same name, then redefines.
- `vm.undefine` / `vm.detachDisk` — succeed if the target is already gone.
- `storage.poolStart` / `storage.poolDefine` / `storage.volCreate` — succeed if
  the pool/volume already exists or is already active.
- `storage.volClone` — a no-op if the target `newName` already exists in the
  pool (checked with `vol-info` first; it never clones over an existing volume —
  `volDelete` it first for a fresh copy). The `actionResult` records
  `idempotent` plus the target's `format` and `capacityBytes` from
  `vol-dumpxml`. This covers zfs pools (zvol golden images) too.

Idempotency is detected by matching anchored substrings in `virsh` stderr (see
`lib/connection.ts` `IDEMPOTENT_ERRORS`); unrelated failures still raise.

## Provisioning VMs from cloud images

`vm.provision` creates a VM from a cloud image in one call. It needs only
`qemu-img`, `curl`, `sha256sum` (or `sha512sum`) and `sh` on the hypervisor — no
`virt-install`, ISO tool or libvirt storage pool, so it works on Unraid.

```bash
swamp model method run vms provision --input-file web1.yaml
```

```yaml
# web1.yaml
name: web1
storageDir: /mnt/user/domains # gets web1/web1.qcow2 + web1-cidata.iso
image:
  url: https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  # checksum: sha256:<hex>             # pin it; otherwise SHA256SUMS beside the image
diskSizeGb: 20
memoryMiB: 2048
vcpus: 2
network: { type: bridge, source: br0 } # or { type: network, source: default }
cloudInit:
  user: ops # passwordless sudo; omit to use the image's default user
  sshAuthorizedKeys: ["ssh-ed25519 AAAA… me@laptop"]
  packages: [htop]
  # staticIp: { address: 192.0.2.10/24, gateway: 192.0.2.1, nameservers: [192.0.2.53] }
```

What it does:

1. Claims `<storageDir>/<name>/` with a plain `mkdir`: if the folder already
   exists (a leftover, or another provision of the same name running now) it
   fails and touches nothing.
2. Downloads the image once into `cacheDir` (default
   `<storageDir>/.swamp-image-cache`), to a temporary `.part` file that is kept
   only if its checksum matches, then made read-only (0444). A cached file is
   checked again before each use, and must be the declared format with **no
   backing file** (a qcow2 can name any host file, such as `/dev/sda`, as its
   backing file). Debian publishes only `SHA512SUMS`, so set
   `image.checksumsUrl` for it. An `http://` image or checksum file needs a
   pinned `image.checksum`.
3. Copies it into `<storageDir>/<name>/<name>.qcow2` (mode 0600) and grows it to
   `diskSizeGb`, which may not be smaller than the image (`diskMode:
   overlay`
   makes a qcow2 backed by the cached file instead).
4. Builds the cloud-init NoCloud seed ISO in TypeScript and writes it beside the
   disk. It is attached as a read-only **virtio disk**, not a CD-ROM, because
   virtio-only kernels (Ubuntu's minimal images) have no CD-ROM driver. The
   user-data installs and starts `qemu-guest-agent` (`guestAgent: false` to
   skip) and turns SSH password logins off.
5. Defines the domain (q35, virtio disk/NIC, serial console, guest-agent
   channel, a MAC derived from the name) with swamp metadata, then starts it.
6. Waits up to `waitForIpSeconds` (default 600) for the guest agent to report an
   address and stores it as `connection/<name>`. A DHCP lease is used only if
   the agent does not answer in time: a lease left by an earlier boot with the
   same MAC can name an address the new guest never gets. With raw `userData`
   (which may not install the agent) leases are accepted after 60 s.

It is idempotent: an existing swamp-created domain is never rebuilt, only
started (or resumed); a same-named domain that swamp did not create is an error.
If a step fails after the folder claim, the domain, the files and the folder
from that run are removed again. In local mode the files are written on the
swamp host, so a remote `uri` (`qemu+ssh://…`) is refused: use `host` instead.

`vm.connection` re-reads the addresses at any time. The `connection` resource
(`ip`, `mac`, `addresses`, `source`, `sshUser`, `hostname`) is meant for later
steps, e.g. `data.latest("vms", "web1").attributes.ip` in a workflow.

### Desired state: `vm.plan` and `vm.sync`

Both take `vms`: a list of the same fields plus `state` (`running`, `stopped` or
`absent`; `image` is needed only to create). `plan` stores what would happen in
`plan/current` and changes nothing; `sync` does it:

| Observed          | Desired `running` | Desired `stopped` | Desired `absent`               |
| ----------------- | ----------------- | ----------------- | ------------------------------ |
| missing           | create + start    | create            | none                           |
| shut off          | start             | none              | delete (swamp-created only)    |
| running           | none              | stop (ACPI)       | delete (swamp-created only)    |
| paused            | resume            | stop (ACPI)       | delete (swamp-created only)    |
| not swamp-created | as above          | as above          | **refuse** — delete it by hand |

- `delete` runs only with `allowDelete: true`
  (`virsh undefine --nvram
  --snapshots-metadata`). `deleteStorage: true` also
  removes the disk and seed ISO — only when the domain's own XML points at
  exactly `<storageDir>/<name>/<name>.qcow2` and `<name>-cidata.iso` — and then
  the folder with `rmdir`, which fails if anything else is in it. Never
  `rm -rf`; the image cache is kept. A wrong `storageDir` fails that VM and
  removes nothing.
- `stop` is an ACPI shutdown; `forceStopAfterWait: true` forces it off after
  `stopWaitSeconds` instead of failing.
- A domain counts as swamp-created only if its XML carries the swamp metadata
  that `vm.provision` writes.
- Memory and vCPU differences are reported as `drift`, not changed.
- Every VM is attempted. The stored plan records each `result`
  (`done`/`failed`/`skipped`), and `sync` fails at the end if any failed.

## Serial console capture

`vm.consoleCapture` captures a domain's serial console for a bounded time. It is
useful when a guest hangs before it reaches the network (bad kernel cmdline,
cloud-init failure, missing disk, firmware prompt), where
`guestInfo`/`interfaceAddresses` have nothing to show:

```bash
swamp model method run vms consoleCapture --input name=web --input timeoutSeconds=30
# a domain with several consoles
swamp model method run vms consoleCapture --input name=web --input device=serial1 --input timeoutSeconds=10
```

- `timeoutSeconds` is required (1-300). The capture always ends by then. In SSH
  mode it is bounded on the hypervisor by `timeout`, with a local kill timer as
  a backstop. In local mode the local kill timer bounds it.
- It is read-only. No input is sent to the console. `force` (default `true`)
  passes `virsh console --force`, which disconnects an existing console session
  such as an operator's. Set `force: false` to fail instead.
- `virsh console` needs a TTY, so it runs under `script`. SSH mode needs
  `timeout` (coreutils) and `script` (util-linux) on the hypervisor. Local mode
  needs `script` on the swamp host (Linux, macOS or BSD; not Windows).
- Terminal control sequences are stripped, and the last 256 KiB of text is kept.
  The result is the `console` resource (`ended` is `deadline` or `exited`, plus
  `bytes`, `truncated` and `text`). Boot output can include credentials or
  tokens, so `text` is a **sensitive** field: swamp stores it in a vault, and
  the method never logs it.

## Strict host-key pinning (SSH mode)

By default the first connection to a hypervisor is trust-on-first-use. To pin
the expected key in the definition instead, set `hostKeyPolicy: strict` and
supply the hypervisor's OpenSSH known_hosts line(s) in `knownHosts`:

```bash
# get the key, then check its fingerprint against the hypervisor's console
# (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the host) before trusting it
ssh-keyscan -t ed25519 10.0.0.5 2>/dev/null | tee hv.known_hosts
ssh-keygen -lf hv.known_hosts
```

```yaml
# model definition (excerpt)
globalArguments:
  host: 10.0.0.5
  user: root
  hostKeyPolicy: strict
  knownHosts:
    - "10.0.0.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
```

With `strict`, each ssh call writes those lines to its own temp file (mode 0600,
removed afterwards, also on error) and runs ssh with
`StrictHostKeyChecking=yes`, `UserKnownHostsFile=<that file>`,
`GlobalKnownHostsFile=/dev/null` and `UpdateHostKeys=no`. Only the supplied keys
are trusted. An unknown or changed key fails with
`Host key verification failed.`, and the runner's `~/.ssh/known_hosts` is
neither read nor written, so it need not be writable. `knownHosts` can also come
from another model's output through a CEL expression.

These cases fail closed before anything runs:

- `strict` without `knownHosts`.
- `strict` in local/URI mode. The libvirt URI transport (`qemu+ssh://`,
  `qemu+libssh2://`, ...) does not use these options; configure host keys for it
  in the runner's ssh config, or with the `known_hosts=` URI parameter of the
  libssh/libssh2 transports.
- `knownHosts` without `strict`, because the keys would be ignored.
- An entry that is not exactly one known_hosts line, such as a line with an
  embedded newline or other control character, a comment, or a bad key type or
  key.

## Security notes

- On the SSH path every argument is shell-quoted, so VM/network/volume names and
  other inputs cannot inject shell commands. In local mode arguments are passed
  directly to the process (no shell at all).
- **SSH host keys** default to `StrictHostKeyChecking=accept-new`
  (`hostKeyPolicy: accept-new`): the hypervisor's key is pinned to your default
  `known_hosts` on first connect (trust-on-first-use) and a later **changed**
  key is refused. This requires a writable `~/.ssh/known_hosts`; if you
  rotate/rebuild a hypervisor, clear its stale `known_hosts` entry. To close the
  first-use gap, pre-seed the key out of band
  (`ssh-keyscan -H <host> >> ~/.ssh/known_hosts`), or pin it in the definition
  with `hostKeyPolicy: strict` (see
  [Strict host-key pinning](#strict-host-key-pinning-ssh-mode)). `BatchMode=yes`
  makes auth failures fail fast instead of hanging on a prompt.
- `vm.setUserPassword` passes the password as a `virsh` argument; while it runs
  it is visible in the hypervisor's process list (`ps`). Avoid it on shared
  hosts where this matters.
- Logged XML dumps (`dumpxml`, `snapshotDumpxml`, `net-dumpxml`) have graphics
  (VNC/SPICE) **passwords redacted** (`passwd='***'`). This covers graphics
  passwords only — storage-auth secrets (iSCSI/RBD/CHAP, `<secret>`) and guest
  PII are **not** redacted yet.
- The **stored** `dumpxml`/`snapshotDumpxml` data artifacts keep the raw XML (so
  you can redefine from them) and may therefore contain those secrets. Treat
  these model data artifacts as sensitive, especially in a shared datastore.

## Credit

This extension derives from the original SSH-only `@magistr/libvirt`. Local/URI
connection support is merged from **@evrardjp**'s fork
[`swamp-local-libvirt`](https://github.com/evrardjp/swamp-local-libvirt), which
adapted that SSH-only original for non-SSH (local / custom URI) connections.
This release unifies both transports in one extension. Thanks to @evrardjp for
the contribution.

## License

MIT — see [LICENSE.md](LICENSE.md).
