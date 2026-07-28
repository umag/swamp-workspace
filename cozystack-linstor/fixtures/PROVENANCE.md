# Fixture provenance

Every JSON file in this directory is **pure doc-derived** — hand-authored from
the published
[LINSTOR](https://linbit.com/drbd-user-guide/linstor-guide-1_0-en/)
machine-readable (`-m`) CLI output shape and the standard Kubernetes
`Deployment` status/spec fields, never captured from a live call. This mirrors
the `porkbun`/`lastfm` precedent (synthetic fixtures, no live capture) and is a
deliberate security decision, not an oversight.

## What was NOT done (explicit prohibition)

A live Cozystack cluster with a real kubeconfig **exists** in this homelab.
**Live capture from that cluster/kubeconfig is FORBIDDEN** for this fixture
corpus — not "not done this time", but a standing rule for anyone regenerating
these fixtures later:

- No `kubectl` command was run against the real Cozystack cluster while
  authoring these fixtures.
- No `swamp model method run <cozystack-linstor instance> <method>` call was
  made.
- No real kubeconfig file (client certificates, tokens, API-server URL) was
  read, exported, pasted, or otherwise touched.
- No real LINSTOR node name, storage-pool name, or ZFS device path from any
  cluster this account manages appears anywhere below.
- The destructive endpoints (`createZfsPool`'s
  `physical-storage
  create-device-pool`, `setZfsFailmode`'s `zpool set`,
  `applyStorageClasses`'s `kubectl apply`) were never invoked against a live
  cluster — their fixture shapes are transcribed from LINSTOR's documented `-m`
  output format and the Kubernetes API's documented `Deployment` schema, not
  observed side effects.

## The concrete k8s/LINSTOR leak vectors this corpus never contains

A real `kubectl`/LINSTOR session is a notorious secret carrier. None of the
following ever appears in these fixtures, and anyone regenerating them must keep
it that way:

- kubeconfig `client-certificate-data` / `client-key-data` /
  `certificate-authority-data` (base64 PEM blobs)
- Bearer / ServiceAccount tokens (JWTs — the `eyJ...` prefix)
- The real API-server URL, or any real control-plane / node IP address
- Image-registry hostnames or credentials
- Container `env` values from a real `Deployment`/`Pod` spec
- `kubectl.kubernetes.io/last-applied-configuration` annotations (these embed
  the full previous manifest, including anything sensitive it carried)
- Real LINSTOR `node_name` / `stor_pool_name` identifiers, or any real device
  path in use on a live node

`deploy-ready.json` / `deploy-notready.json` are kept **minimal by design** —
only `.status.readyReplicas` and `.spec.replicas`, the two fields
`getLinstorControllerStatus` actually reads — rather than a realistic full
`Deployment` object, precisely so none of the vectors above has anywhere to
hide. A full captured `kubectl get deploy -o json` would carry namespace,
labels/annotations (including `last-applied-configuration`), image-registry
hosts, `nodeSelector`s, container `env`, and `uid`/`resourceVersion`/
`managedFields` — none of which this model reads or this corpus needs.

The fixtures-secret-scan test in
`../extensions/models/cozystack_linstor_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero; do not treat the heuristic scan as a
guarantee that would also hold for genuinely captured data.

## Every value is synthetic

- Node names: `worker-0`, `worker-1`, `worker-2` — generic synthetic hostnames,
  never a real node in this homelab's Cozystack cluster.
- IP addresses: `192.0.2.10`, `192.0.2.11`, `192.0.2.21` — from the `TEST-NET-1`
  documentation range ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)).
- Block device: `/dev/vdb` — a generic virtio-block device name used only as an
  argument in test code, not a fixture value; never a real device path from a
  live node.
- Storage pool / ZFS pool names: `data` — LINSTOR's own documented default pool
  name, not a real cluster's naming convention.
- `free_space`/`total_capacity` byte counts (`3221225472`, `10737418240`, `0`) —
  round synthetic numbers (3 GiB / 10 GiB / zero), not observed capacity from
  any real pool.

## Per-file mapping to the documented shape

| File                     | Documented shape                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `node-list.json`         | `linstor node list --output-version=v1 -m` (machine-readable node list)               |
| `storage-pool-list.json` | `linstor storage-pool list --output-version=v1 -m`                                    |
| `deploy-ready.json`      | `kubectl get deploy/linstor-controller -o json` — ready (`readyReplicas >= replicas`) |
| `deploy-notready.json`   | Same shape — not ready (`readyReplicas < replicas`)                                   |

## A documented shape quirk this corpus deliberately preserves

The LINSTOR `-m` (machine-readable) output wraps its payload in a **top-level
array** whose first element carries the actual `nodes`/`stor_pools` key
(`[{"nodes": [...]}]`, not a bare `{"nodes": [...]}`) — `cozystack_linstor.ts`
reads this via the `data[0]?.nodes || data.nodes || data || []` fallback chain
specifically because of that wrapping. `storage-pool-list.json` also
deliberately varies the third pool's shape: `worker-2`'s entry carries no
`provider_kind`, `props`, or `free_space` key at all, and the second pool's
`free_space.free_capacity` is exactly `0` (not absent) — both pin the model's
`!= null` (not truthy) numeric-zero handling and the `|| "unknown"` fallback
chain against a real doc-derived absence rather than a fabricated edge case.
