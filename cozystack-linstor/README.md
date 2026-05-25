# @magistr/cozystack-linstor

Linstor distributed storage management for [Cozystack](https://cozystack.io)
clusters. This swamp model wraps `kubectl` and the `linstor` controller CLI
(invoked via `kubectl exec` into the `linstor-controller` deployment in the
`cozy-linstor` namespace) to discover cluster nodes and storage pools, create
ZFS-backed Linstor storage pools, tune ZFS failmode, and apply storage-class
manifests. All mutating methods are idempotent, and live pre-flight checks
verify that the cluster is reachable and the Linstor controller is ready before
any write operation runs.

## Configuration

The model takes an optional `kubeconfig` path and an optional kubeconfig
`context`. When omitted, `kubectl` uses its ambient default configuration.

```yaml
type: "@magistr/cozystack-linstor"
typeVersion: 2026.03.13.1
name: cozystack-linstor
globalArguments:
  kubeconfig: /path/to/kubeconfig
  context: my-cluster
methods: {}
```

## Usage

Inspect the cluster, then provision storage:

```bash
# Check the linstor-controller deployment is ready
swamp model method run cozystack-linstor getLinstorControllerStatus

# Discover nodes and storage pools
swamp model method run cozystack-linstor listNodes
swamp model method run cozystack-linstor listStoragePools

# Create a ZFS storage pool on a node (idempotent)
swamp model method run cozystack-linstor createZfsPool \
  --input node=worker-1 --input device=/dev/vdb \
  --input poolName=data --input storagePool=data

# Set ZFS failmode=continue on a pool
swamp model method run cozystack-linstor setZfsFailmode \
  --input node=worker-1 --input poolName=data

# Apply a storage-class manifest (kubectl apply, idempotent)
swamp model method run cozystack-linstor applyStorageClasses \
  --input manifestPath=./storage-classes.yaml
```

## Methods

| Method                       | Description                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `getLinstorControllerStatus` | Report whether the `linstor-controller` deployment is ready                    |
| `listNodes`                  | List Linstor cluster nodes with addresses and state                            |
| `listStoragePools`           | List Linstor storage pools (capacity, free space, state) across all nodes      |
| `createZfsPool`              | Create a ZFS-backed Linstor storage pool on a node; skips if it already exists |
| `setZfsFailmode`             | Set `failmode=continue` on a node's ZFS pool                                   |
| `applyStorageClasses`        | Apply a storage-class YAML manifest via `kubectl apply`                        |

## License

MIT — see [LICENSE.md](LICENSE.md).
