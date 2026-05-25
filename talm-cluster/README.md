# @magistr/talm-cluster

Talos cluster lifecycle management via [talm](https://github.com/cozystack/talm)
and `talosctl`. This swamp model wraps the full bring-up sequence for a
Talos-based Kubernetes cluster: initialize a cluster directory from a preset,
write `values.yaml`, template per-node machine configs, apply them, bootstrap
etcd, fetch the kubeconfig, and run health checks. Long-running steps
(`templateNode`, `apply`, `bootstrap`, `health`) automatically retry on the
transient connection errors that occur while nodes reboot into maintenance mode
or rejoin the control plane.

The model also post-processes templated node configs to fix two common talm
pitfalls: it rewrites the auto-discovered `/dev/sr0` CD-ROM install disk to a
real device and injects `dhcp: true` on interfaces so a node keeps an IP after
the install reboot.

## Requirements

- `talm` on `PATH` (used by `init`, `configure`, `templateNode`, `apply`)
- `talosctl` on `PATH` (used by `bootstrap`, `kubeconfig`, `health`)

## Configuration

The model takes a single global argument, `clusterDir`, the path to the talm
cluster working directory:

```yaml
type: "@magistr/talm-cluster"
typeVersion: "2026.03.13.1"
name: my-cluster
version: 1
tags: {}
globalArguments:
  clusterDir: ".talos/my-cluster"
methods: {}
```

## Methods

| Method            | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `getClusterState` | Report which of secrets/values/talosconfig/kubeconfig exist      |
| `init`            | `talm init --preset <preset> --name <name>` + regen talosconfig  |
| `configure`       | Write `values.yaml` (endpoint, floating IP, image, CIDRs)        |
| `templateNode`    | `talm template` a node config, fixing install disk + DHCP        |
| `apply`           | `talm apply -f <nodeFile>` (optional `--insecure` for maint.)    |
| `bootstrap`       | `talosctl bootstrap` etcd on a node endpoint                     |
| `kubeconfig`      | `talosctl kubeconfig` into the cluster dir                       |
| `health`          | `talosctl health --wait-timeout <t>` against a node              |

## Usage

Initialize a cluster directory, then configure the cluster values:

```bash
# Initialize the cluster directory from a preset
swamp model method run my-cluster init \
  --input name=my-cluster --input preset=cozystack

# Write values.yaml (endpoint, floating IP, install image, CIDRs)
swamp model method run my-cluster configure \
  --input endpoint=https://192.0.2.17:6443 \
  --input floatingIP=192.0.2.10 \
  --input image=ghcr.io/cozystack/cozystack/talos:v1.10.5

# Template, apply, then bootstrap a control-plane node
swamp model method run my-cluster templateNode \
  --input nodeIP=192.0.2.21 \
  --input outputFile=nodes/cp-1.yaml
swamp model method run my-cluster apply --input nodeFile=nodes/cp-1.yaml --input insecure=true
swamp model method run my-cluster bootstrap --input endpoint=192.0.2.21

# Fetch kubeconfig and wait for the cluster to report healthy
swamp model method run my-cluster kubeconfig --input endpoint=192.0.2.21
swamp model method run my-cluster health --input endpoint=192.0.2.21 --input waitTimeout=10m
```

## License

MIT — see [LICENSE.md](LICENSE.md).
