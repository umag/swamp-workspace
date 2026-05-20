# @magistr/libvirt

Comprehensive [libvirt](https://libvirt.org/)/`virsh` management for
[swamp](https://github.com/systeminit/swamp) — virtual machines, networks,
storage pools, volumes, snapshots, and hypervisor host info. Drive your
KVM/QEMU homelab or workstation declaratively, **over SSH or locally via a
connection URI**.

## Models

| Model | What it manages |
|-------|-----------------|
| `@magistr/libvirt/vm` | Domain lifecycle (start/stop/define/undefine/snapshot), CPU/memory tuning, disk/NIC hotplug, block/net/CPU/memory stats, guest-agent queries |
| `@magistr/libvirt/network` | Virtual network lifecycle (list/get/define/start/stop/autostart) and DHCP lease inspection |
| `@magistr/libvirt/storage` | Storage pool and volume management (create/build/resize/clone/delete) |
| `@magistr/libvirt/host` | Hypervisor host info, capabilities, SMBIOS sysinfo, node CPU/memory stats, device list, static routes |

## Connection modes

Each model instance picks its transport from `globalArguments`:

- **SSH mode** — set `host` (and optionally `user`, default `root`). `virsh`
  runs on the remote hypervisor over ssh; no local libvirt client is required.
- **Local / URI mode** — omit `host`. `virsh` runs on the swamp host and
  connects via `-c <uri>` (`uri` defaults to `qemu:///system`). Works with any
  libvirt URI, including `qemu+ssh://user@host/system`, `qemu+tls://…`, and
  `qemu:///session`.

In both modes the optional `uri` argument selects the libvirt connection.

## Prerequisites

- **SSH mode**: ssh access to the hypervisor; `virsh` installed there.
- **Local/URI mode**: `libvirt-client` (provides `virsh`) installed on the
  swamp host, and a reachable libvirt daemon.

## Quick start

Remote hypervisor over SSH:

```bash
swamp model create @magistr/libvirt/vm vms --input host=10.0.0.5 --input user=root
swamp model method run vms list
swamp model method run vms start --input name=web
swamp model method run vms snapshotCreate --input name=web --input snapshotName=pre-upgrade
```

Local hypervisor (or any URI) — no `host`:

```bash
swamp model create @magistr/libvirt/host local-hv
swamp model method run local-hv info

# explicit URI (e.g. the user session, or a remote libvirt over its own ssh transport)
swamp model create @magistr/libvirt/network nets --input uri=qemu+ssh://root@10.0.0.5/system
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

Idempotency is detected by matching anchored substrings in `virsh` stderr (see
`lib/connection.ts` `IDEMPOTENT_ERRORS`); unrelated failures still raise.

## Security notes

- On the SSH path every argument is shell-quoted, so VM/network/volume names
  and other inputs cannot inject shell commands. In local mode arguments are
  passed directly to the process (no shell at all).
- **SSH host keys** use `StrictHostKeyChecking=accept-new`: the hypervisor's key
  is pinned to your default `known_hosts` on first connect (trust-on-first-use)
  and a later **changed** key is refused. This requires a writable
  `~/.ssh/known_hosts`; if you rotate/rebuild a hypervisor, clear its stale
  `known_hosts` entry. To close the first-use gap, pre-seed the key out of band
  (`ssh-keyscan -H <host> >> ~/.ssh/known_hosts`). `BatchMode=yes` makes auth
  failures fail fast instead of hanging on a prompt.
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

Local/URI connection support is merged from **@evrardjp**'s fork
[`swamp-local-libvirt`](https://github.com/evrardjp/swamp-local-libvirt), which
adapted the original SSH-only `@magistr/libvirt` for non-SSH (local / custom
URI) connections. This release unifies both transports in one extension. Thanks
to @evrardjp for the contribution.

## License

MIT — see [LICENSE.md](LICENSE.md).
