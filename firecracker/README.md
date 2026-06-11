# @magistr/firecracker

Firecracker microVM lifecycle management for
[swamp](https://github.com/swamp-club/swamp), over SSH + the Firecracker
Unix-socket REST API. **One model instance = one microVM socket.**

The model drives the whole lifecycle of a Firecracker microVM on a remote KVM
host: it configures the machine, boot source, drives and network; starts, stops,
pauses and resumes the guest; snapshots and restores; precision-kills the VMM;
and bootstraps the host itself (install the Firecracker binary + guest kernel,
set up TAP networking, build an Ubuntu rootfs with a PID-1 agent).

It is built for running ephemeral, isolated **Claude Code agents** inside
microVMs: bake a warm snapshot once, then restore-and-run per task for
sub-second cold starts. Pair it with
[`@magistr/fc-task-server`](https://github.com/umag/swamp-workspace/tree/main/fc-task-server)
to feed prompts to the guest and collect results.

## Install

```bash
swamp extension pull @magistr/firecracker
```

## Model

Connection is per-instance via `globalArguments`:

| Argument     | Required | Default | Description                                     |
| ------------ | -------- | ------- | ----------------------------------------------- |
| `host`       | yes      | —       | SSH host/IP of the machine running Firecracker  |
| `user`       | no       | `root`  | SSH username                                    |
| `socketPath` | yes      | —       | Path to the Firecracker API Unix socket on host |

> Host key verification is disabled (`StrictHostKeyChecking=no`). Use on trusted
> networks only.

### Create an instance and inspect a VM

```bash
swamp model create @magistr/firecracker fc-agent-1
swamp model edit fc-agent-1 --json <<'EOF'
{ "host": "firecracker.example.com",
  "socketPath": "/tmp/fc-agent-1.socket" }
EOF

# Read VM + instance state
swamp model method run fc-agent-1 status
```

### Configure, boot, snapshot

```bash
swamp model method run fc-agent-1 configure --input vcpuCount=2 --input memSizeMib=1024
swamp model method run fc-agent-1 set_boot --input kernelImagePath=/opt/firecracker/vmlinux
swamp model method run fc-agent-1 set_drive --input driveId=rootfs --input pathOnHost=/opt/firecracker/rootfs.ext4
swamp model method run fc-agent-1 start
swamp model method run fc-agent-1 snapshot --input snapshotType=Full
```

## Methods

Lifecycle: `status`, `configure`, `set_boot`, `set_drive`, `set_network`,
`set_vsock`, `set_entropy_device`, `start`, `stop`, `pause`, `resume`,
`send_ctrl_alt_del`, `snapshot`, `restore`, `kill_vmm`, `start_vmm`,
`wait_serial`.

Host bootstrap: `install_firecracker`, `install_guest_kernel`, `setup_tap`,
`build_ubuntu_rootfs`, `update_agent_script`.

## Running multiple microVMs concurrently (network isolation)

Many clones of **one** base snapshot can run at the same time on one host
without IP/gateway/task-server overlap — by isolation, not by re-addressing the
guest. The guest image is unchanged (it keeps its baked `172.16.0.2` / gateway
`172.16.0.1`); each VM gets its own **network namespace** where that same
address is reused collision-free (the upstream Firecracker "network for clones"
pattern).

Set `netns` in `globalArguments` and use `setup_tap`'s netns mode per VM:

- `setup_tap --input netns=fc-1 --input vethSubnet=10.0.1.0/30` builds the tap +
  veth + scoped NAT **inside** namespace `fc-1`.
- With `netns` on the instance, `start_vmm` launches Firecracker via
  `ip netns exec`, and `kill_vmm` tears the namespace down.
- `vethSubnet` (the host↔namespace /30) **must be unique per concurrent VM** —
  derive it and the namespace name from the same per-VM index (e.g.
  `netns=fc-agent-3`, `vethSubnet=10.0.3.0/30`).

Leave `netns` empty (the default) for the single-VM root-namespace path, which
is unchanged. The `fc-run-agent` workflow exposes `netns` / `vethSubnet` inputs
for this.

## Workflows

- **`@magistr/fc-install-firecracker`** — download and install the latest
  Firecracker release binary on the host.
- **`@magistr/fc-bake-snapshot`** — update the rootfs agent script, boot a fresh
  VM, wait for the agent to reach the polling-for-task state, snapshot, then
  tear down. Leaves a warm `agent-snapshot.{snap,mem}` for fast restore.
- **`@magistr/fc-run-agent`** — run a Claude Code agent task inside a microVM
  (TAP + host NAT for egress), with a `type:always` cleanup job so the VMM and
  task server are always torn down. The guest runs
  `claude --print --model <model> --effort <effort>`, taking the model and
  effort from the injected task (effort defaults to `low` via
  `@magistr/fc-task-server`).

## Fast task fabric (warm worker pool + queue)

To run many agent tasks quickly without a per-task workflow, the model exposes a
factory + queue (one `swamp model method run` each, no workflow authoring):

- **`fabric_up --input concurrency=N`** — factory: fans out `N` warm worker VMs
  (each in its own netns, restored once, running the looping agent) that pull
  from a shared host queue. One call brings up the whole pool concurrently.
- **`submit`** — enqueue tasks (NON-BLOCKING, callable any time — including while
  tasks are running); returns task ids. The daemon injects the OAuth token at
  serve time, so it is never written to the queue.
- **`poll`** — collect completed results by id + the pending count (idempotent).
- **`fabric_recycle --input timeoutSeconds=…`** — liveness watchdog: re-queue
  tasks claimed longer than the timeout (a wedged worker) and restart the stuck
  workers, so a hung agent never permanently loses a pool slot. Call periodically.
- **`fabric_down`** — reap the whole pool (VMs, netns, NAT, daemons, queue).

Workers are reused across tasks (warm-VM reuse, no per-task restore). `submit`
and `poll` touch only the host queue — not the minutes-long agent run — so they
neither hold the swamp `__global__` lock for a task's duration nor require a
per-task workflow. The concurrency cap is the `concurrency` parameter
(configurable; ~512 MiB RAM per worker). **Note:** after changing the agent
script the warm snapshot must be re-baked (`@magistr/fc-bake-snapshot`) so the
pool boots the looping worker.

## Security notes

- SSH host-key checking is intentionally disabled — scope to trusted networks.
- Paths and interface names are validated against strict allowlists before being
  interpolated into remote shell commands.
- The microVM reaches the internet directly via TAP + host NAT; this model does
  not proxy guest traffic.

## License

MIT — see [LICENSE.md](LICENSE.md).
