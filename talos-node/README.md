# @magistr/talos-node

A [swamp](https://github.com/systeminit/swamp) model that manages
[Talos Linux](https://www.talos.dev/) nodes by wrapping the `talosctl` CLI. It
covers the full node lifecycle: querying version and service status, listing
etcd members, retrieving the cluster kubeconfig, applying and patching machine
configuration (including insecure maintenance-mode bootstrap), bootstrapping the
first control-plane node, rebooting, shutting down, resetting, upgrading Talos,
and waiting on cluster health. Long-running and connection-sensitive operations
(apply, patch, bootstrap, health) retry automatically on transient gRPC errors
such as `connection refused` and `deadline exceeded`.

The `talosctl` binary must be available in `PATH`. Two checks gate the mutating
methods: `talosctl-available` (binary present) and `talosconfig-exists` (the
configured `talosconfig` path resolves when set).

## Configuration

Each model instance points at a single Talos node endpoint.

`globalArguments`:

- `endpoint` (string, required) — Talos node endpoint, an IP or hostname.
- `talosconfig` (string, optional) — path to a `talosconfig` file. Defaults to
  `~/.talos/config` when omitted.
- `insecure` (boolean, default `false`) — pass `--insecure` to skip TLS
  verification, used for nodes still in maintenance mode.

```yaml
type: "@magistr/talos-node"
typeVersion: 2026.03.13.1
name: cp1
version: 1
globalArguments:
  endpoint: "192.0.2.10"
  talosconfig: "/home/alice/.talos/config"
  insecure: false
methods: {}
```

## Usage

Run methods with `swamp model method run <instance> <method>`:

```bash
# Read-only inspection
swamp model method run cp1 version
swamp model method run cp1 services
swamp model method run cp1 etcdMembers
swamp model method run cp1 kubeconfig

# Apply a generated machine config in maintenance mode
swamp model method run cp1 applyConfig \
  --input configFile=./controlplane.yaml \
  --input mode=auto \
  --input insecure=true

# Bootstrap the cluster on the first control-plane node only
swamp model method run cp1 bootstrap

# Patch a running node's config (reboots by default)
swamp model method run cp1 patchConfig \
  --input patchFile=./patch.yaml \
  --input mode=auto

# Upgrade Talos to a specific installer image
swamp model method run cp1 upgrade \
  --input image=ghcr.io/siderolabs/installer:v1.9.5 \
  --input preserve=false

# Lifecycle control
swamp model method run cp1 reboot --input mode=default
swamp model method run cp1 shutdown --input force=false
swamp model method run cp1 reset --input graceful=true

# Wait for the cluster to report healthy
swamp model method run cp1 health --input waitTimeout=2m
```

## Methods

| Method        | Purpose                                                             |
| ------------- | ------------------------------------------------------------------- |
| `version`     | Get Talos version info for the node.                                |
| `services`    | List all node services (factory output, one per service).           |
| `etcdMembers` | List etcd cluster members.                                          |
| `kubeconfig`  | Retrieve the cluster kubeconfig (stored as sensitive output).       |
| `applyConfig` | Apply a machine config YAML (`auto`/`reboot`/`no-reboot`/`staged`). |
| `bootstrap`   | Bootstrap the cluster — first control-plane node only.              |
| `reboot`      | Reboot the node (`default` or `powercycle`).                        |
| `shutdown`    | Shut down the node, optionally forced.                              |
| `reset`       | Reset the node and wipe state (graceful by default).                |
| `upgrade`     | Upgrade Talos to a given installer image.                           |
| `patchConfig` | Patch the machine config with a YAML patch file.                    |
| `health`      | Wait for and report cluster health.                                 |

## License

MIT — see [LICENSE.md](LICENSE.md).
