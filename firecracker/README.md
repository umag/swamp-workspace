# @magistr/firecracker

Firecracker microVM lifecycle management for
[swamp](https://github.com/swamp-club/swamp), over SSH + the Firecracker
Unix-socket REST API. **One model instance = one microVM socket.**

The model drives the whole lifecycle of a Firecracker microVM on a remote KVM
host — configure machine/boot/drives/network, start/stop/pause/resume,
snapshot/restore, precision-kill the VMM — and can bootstrap the host itself
(install the Firecracker binary + guest kernel, set up TAP networking, build an
Ubuntu rootfs with a PID-1 agent). It is built for running ephemeral, isolated
**Claude Code agents** inside microVMs: bake a warm snapshot once, then
restore-and-run per task for sub-second cold starts.

---

## Tutorial — boot and snapshot your first microVM

> You need a remote KVM host reachable over SSH with the Firecracker binary and
> a guest kernel + rootfs in place (the `install_*`/`build_ubuntu_rootfs`
> methods, or the `@magistr/fc-install-firecracker` workflow, set that up).

```bash
# 1. One instance == one microVM socket.
swamp extension pull @magistr/firecracker
swamp model create @magistr/firecracker fc-agent-1
swamp model edit fc-agent-1 --json <<'EOF'
{ "host": "firecracker.example.com", "socketPath": "/tmp/fc-agent-1.socket" }
EOF

# 2. Configure, boot, and bake a warm snapshot for fast restore.
swamp model method run fc-agent-1 configure --input vcpuCount=2 --input memSizeMib=1024
swamp model method run fc-agent-1 set_boot  --input kernelImagePath=/opt/firecracker/vmlinux
swamp model method run fc-agent-1 set_drive --input driveId=rootfs --input pathOnHost=/opt/firecracker/rootfs.ext4
swamp model method run fc-agent-1 start
swamp model method run fc-agent-1 status                       # read VM + instance state
swamp model method run fc-agent-1 snapshot --input snapshotType=Full
```

`snapshot` leaves a warm `agent-snapshot.{snap,mem}` you can `restore` in well
under a second — the basis for the task fabric below.

---

## How-to guides

### Run many agent tasks over a warm pool

The task **fabric** is a factory + queue: one `swamp model method run` per step,
no workflow authoring. Workers are restored once and reused across tasks.

```bash
swamp model method run fab fabric_up --input concurrency=8 ...   # N warm workers, each in its own netns
# enqueue (non-blocking, callable any time). outputFormat=json makes the leaf run
# `claude --print --output-format json` so token usage + cost ride back in the result.
swamp model method run fab submit --input tasks='[{"prompt":"...","outputFormat":"json"}]'
swamp model method run fab poll                                 # collect results by id + pending count
swamp model method run fab fabric_recycle --input timeoutSeconds=900   # restart+requeue hung claims
swamp model method run fab fabric_down                          # reap the whole pool (discovered from host state)
```

`submit`/`poll` touch only the host queue (never the minutes-long agent run), so
they don't hold swamp's `__global__` lock for a task's duration. The default
`outputFormat` is `text` (unchanged); `json` is the opt-in that
`@magistr/swamp-go-brr` uses for per-leaf observability.

### Run multiple microVMs concurrently (network isolation)

Many clones of **one** base snapshot run at once on a single host without
IP/gateway overlap — by isolation, not re-addressing. The guest keeps its baked
`172.16.0.2` / gateway `172.16.0.1`; each VM gets its own **network namespace**
where that address is reused collision-free.

```bash
# per-VM: a UNIQUE /30 + matching netns name, derived from the same per-VM index
swamp model method run fc-agent-3 setup_tap --input netns=fc-agent-3 --input vethSubnet=10.0.3.0/30
```

Set `netns` in `globalArguments`; then `start_vmm` launches Firecracker via
`ip netns exec` and `kill_vmm` tears the namespace down. Leave `netns` empty for
the single-VM root-namespace path (unchanged).

### Bake / refresh the warm snapshot

Use `@magistr/fc-bake-snapshot` (updates the rootfs agent script, boots, waits
for the polling-for-task state, snapshots, tears down). **After changing the
agent script the snapshot must be re-baked** so the pool boots the looping
worker; daemon/queue changes need no re-bake (the daemon is deployed fresh on
each `fabric_up`).

---

## Reference

### `globalArguments`

| Argument     | Required | Default | Description                                          |
| ------------ | -------- | ------- | ---------------------------------------------------- |
| `host`       | yes      | —       | SSH host/IP of the machine running Firecracker       |
| `user`       | no       | `root`  | SSH username                                         |
| `socketPath` | yes      | —       | Path to the Firecracker API Unix socket on host      |
| `netns`      | no       | `""`    | Network namespace for concurrent clones (see how-to) |

### Methods

- **Lifecycle**: `status`, `configure`, `set_boot`, `set_drive`, `set_network`,
  `set_vsock`, `set_entropy_device`, `start`, `stop`, `pause`, `resume`,
  `send_ctrl_alt_del`, `snapshot`, `restore`, `kill_vmm`, `start_vmm`,
  `wait_serial`.
- **Host bootstrap**: `install_firecracker`, `install_guest_kernel`,
  `setup_tap`, `build_ubuntu_rootfs`, `update_agent_script`.
- **Task fabric**: `fabric_up`, `submit`, `poll`, `fabric_recycle`,
  `fabric_down`.

A `submit` task is `{ prompt, model?, effort?, gitRepoUrl?, outputFormat? }`
(`outputFormat`: `text` default | `json`).

### Workflows

- **`@magistr/fc-install-firecracker`** — install the latest Firecracker release
  binary on the host.
- **`@magistr/fc-bake-snapshot`** — bake a warm `agent-snapshot.{snap,mem}`.
- **`@magistr/fc-run-agent`** — run one Claude Code agent task in a microVM
  (TAP + host NAT egress) with a `type:always` cleanup job; exposes
  `netns`/`vethSubnet`.

---

## Explanation — how it fits together

**Warm-snapshot, restore-per-task.** Cold-booting a microVM is slow; restoring a
baked snapshot is sub-second. So you bake once (kernel + rootfs + a PID-1 agent
already polling for work) and restore a fresh clone per task — ephemeral and
isolated, with no cross-task state leak.

**Isolation by network namespace.** Cloning one snapshot N times would collide
on the baked guest IP. Instead each clone runs in its own netns where the same
address is reused safely (the upstream Firecracker "network for clones"
pattern); `vethSubnet` (the host↔namespace /30) is the only thing that must be
unique per VM.

**At-least-once fabric.** `fabric_recycle` reaps a worker by **claim age**, not
a liveness probe — so `timeoutSeconds` must exceed the longest expected task or
a slow task is killed and re-run. It is clobber-safe: the killed worker is dead
before its task is re-dispatched, and the daemon only accepts a result from the
worker still holding the live claim (a stale late result is dropped). A
malformed task is quarantined to `<queueRoot>/failed/` and never wedges a pool
slot; `fabric_down` discovers the live pool from host state so it can't leak on
a concurrency mismatch.

## Security notes

- SSH host-key checking is intentionally disabled (`StrictHostKeyChecking=no`) —
  scope to **trusted networks** only.
- Paths and interface names are validated against strict allowlists before being
  interpolated into remote shell commands.
- The microVM reaches the internet directly via TAP + host NAT; guest traffic is
  not proxied.
- Fabric task prompts are **trusted operator input**: they run with full tool
  access inside the VM and can read the OAuth token injected into that VM. The
  token is never written to the queue/claimed files or daemon logs, but it is
  reachable by the in-guest agent (and is passed to the daemon via an
  environment export, transiently visible in host process args). The queue lives
  under a predictable `/tmp` path — keep the host single-tenant. (Hardening
  tracked as a follow-up.)

## License

MIT — see [LICENSE.md](LICENSE.md). Changelog: [CHANGELOG.md](CHANGELOG.md).
