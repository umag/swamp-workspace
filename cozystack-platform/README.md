# @magistr/cozystack-platform

A swamp model for managing a [Cozystack](https://cozystack.io) platform on top
of Kubernetes. It wraps `kubectl` and `helm` against a Cozystack management
cluster to install the operator, apply the platform Package CR, bootstrap CNI
networking (PodCIDR assignment and `flux-tenants` patching), and manage
applications and tenants. Read-only methods report operator, flux-tenants,
platform-package, HelmRelease, workload, and node-PodCIDR health, while write
methods create/update/delete apps, create tenants, and fetch app credentials or
per-tenant kubeconfigs. Both `kubectl` and `helm` must be on `PATH`; pre-flight
checks verify cluster reachability and the helm binary before mutating methods
run.

## Configuration

Global arguments select which cluster to operate on. Both fields are optional;
omit them to use your ambient kubeconfig and current context.

```yaml
type: "@magistr/cozystack-platform"
typeVersion: "2026.03.13.1"
name: cozystack
globalArguments:
  kubeconfig: /path/to/kubeconfig # optional
  context: my-cluster # optional
methods: {}
```

## Usage

Install the operator, apply the platform Package CR, then inspect health:

```bash
# 1. Install the Cozystack operator via Helm + apply platform ConfigMap
swamp model method run cozystack install \
  --input version=0.31.0 \
  --input platformConfigPath=./cozystack-platform.yaml \
  --input variant=talos

# 2. Wait for the operator rollout, then trigger full platform deployment
swamp model method run cozystack waitReady
swamp model method run cozystack applyPackage \
  --input host=cluster.example \
  --input apiServerEndpoint=https://192.0.2.10:6443

# 3. Inspect platform health
swamp model method run cozystack getOperatorStatus
swamp model method run cozystack listPackages
swamp model method run cozystack listHelmReleases --input notReadyOnly=true
```

Manage applications and tenants:

```bash
# Create a tenant, then deploy a Postgres app into it
swamp model method run cozystack createTenant --input name=myteam
swamp model method run cozystack createApp \
  --input namespace=tenant-myteam \
  --input kind=Postgres \
  --input name=db \
  --input specJson='{"replicas":2,"size":"10Gi"}'

# Fetch the app credentials secret (marked sensitive)
swamp model method run cozystack getAppSecret \
  --input namespace=tenant-myteam --input name=db
```

## Methods

- `install` / `waitReady` — install the operator via Helm and wait for rollout.
- `applyPackage` / `getPlatformPackage` — manage the platform Package CR.
- `configurePlatform` — toggle ingress, monitoring, and etcd on the root tenant.
- `patchFluxTenants` / `assignPodCIDRs` / `getNodePodCIDRs` — CNI bootstrap.
- `createApp` / `getApp` / `listApps` / `updateApp` / `deleteApp` — app CRUD.
- `createTenant` / `listTenants` — tenant management.
- `listAppDefinitions` / `listPackages` / `listWorkloads` — discovery.
- `getOperatorStatus` / `getFluxTenantsStatus` / `listHelmReleases` — health.
- `getAppSecret` / `getTenantKubeconfig` — credential retrieval (sensitive).

## License

MIT — see [LICENSE.md](LICENSE.md).
