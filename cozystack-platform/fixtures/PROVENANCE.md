# Fixture provenance

Every JSON file in this directory is **pure doc-derived** — hand-authored from
the [Cozystack](https://cozystack.io) documentation and the standard Kubernetes
API object shapes (`Deployment`, `Secret`, custom resources under
`cozystack.io`/`apps.cozystack.io`/`helm.toolkit.fluxcd.io`), never captured
from a live call. This mirrors the `porkbun` precedent (synthetic fixtures, no
live capture) and is a deliberate security decision, not an oversight.

## What was NOT done (explicit, standing prohibition)

A live Cozystack management cluster and kubeconfig **exist** in this homelab.
**Live capture from that cluster is FORBIDDEN** for this fixture corpus — not
"not done this time", but a standing rule for anyone regenerating these fixtures
later:

- No `swamp model method run cozystack <method>` call was made against a real
  cluster while authoring these fixtures.
- `getAppSecret` and `getTenantKubeconfig` were never run against a live
  instance, and no real Kubernetes `Secret` object, kubeconfig file, or
  vault-stored credential was read, exported, or otherwise touched to produce
  `secret.json` / `tenant_secret.json`.
- No real node name, namespace, tenant, application spec, HelmRelease, or
  PodCIDR from any cluster this account manages appears anywhere below.
- The destructive/mutating endpoints (`apply -f -` for `createApp`/
  `createTenant`/`updateApp`/`applyPackage`, `kubectl delete`, `kubectl patch`,
  `helm upgrade --install`) were never invoked against a live API — every
  fixture shape is transcribed from the Kubernetes/Cozystack API object shapes
  in the docs, not observed side effects.

The fixtures-secret-scan test in
`../extensions/models/cozystack_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place.

### The backstop is weak for base64 `.data` — read this before regenerating

`secret.json` and `tenant_secret.json` **must** carry valid base64 in every
`.data` value (`getAppSecret` and `getTenantKubeconfig` call `atob()` on these
fields unconditionally — invalid base64 throws `InvalidCharacterError` and would
crash the happy-path characterization tests). This puts the fixture author in
structural tension with the secret-scan's high-entropy heuristic: a **short,
obviously-fake plaintext** (`fakepw123`, `faketoken1`, `fakecacertdata`, ...),
once base64-encoded, is indistinguishable in _shape_ from a real short-lived
credential also encoded as base64 — the scan cannot tell "deliberately fake and
short" from "real and unfortunately short" by looking at the ciphertext alone. A
**real** Cozystack secret value (a Postgres-generated password, a
service-account JWT, a PEM certificate) is long enough to trip the scan's
high-entropy/PEM/JWT markers; a short hand-authored placeholder, by
construction, is not guaranteed to. Do not treat a clean scan result as a
guarantee that would also hold for genuinely captured data — it holds here only
because every value below is provably synthetic by construction (see the
security review's residual LOW finding on plan v2). Anyone regenerating these
fixtures must keep every plaintext short, obviously-fake, and free of
PEM/JWT/kubeconfig-shaped content — never "realistic-looking" — precisely
because the scan cannot compensate for that choice.

## Every value is synthetic

- Namespaces: `cozy-system`, `cozy-fluxcd`, `cozy-ingress`, `tenant-root`,
  `tenant-myteam` — Cozystack's own documented system namespaces plus synthetic
  tenant namespaces, never a namespace from a real workload.
- Host: `cluster.example` — IANA's reserved `.example` TLD
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)), never a real domain.
- IP addresses used in test bodies (not committed to these fixtures, but used in
  the suites that import them): `192.0.2.0/24` (`TEST-NET-1`) and
  `203.0.113.0/24` (`TEST-NET-3`) from
  [RFC 5737](https://www.rfc-editor.org/rfc/rfc5737).
- Pod/service/join CIDRs (`10.244.0.0/16`, `10.96.0.0/16`, `100.64.0.0/16`): the
  documented Cozystack/Cilium defaults, not observed from any real cluster's
  live allocation.
- Node names (`node-1`, `node-2`): synthetic placeholders.
- Secret plaintext (after base64 decode): `fakepw123`, `fakeuser`, `faketoken1`,
  `tenant-myteam`, `fakecacertdata` — obviously-fake, short, human-readable
  strings. None is a real password, token, or certificate.
- Timestamps (`2026-07-01T00:00:00Z`): a fixed synthetic instant, not any real
  object's creation time.

## Per-file mapping to the documented kubectl invocation

| File                       | Models the invocation                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `deploy_operator.json`     | `kubectl get deploy/cozystack-operator -n cozy-system -o json`                         |
| `deploy_flux_tenants.json` | `kubectl get deploy/flux-tenants -n cozy-fluxcd -o json`                               |
| `nodes.json`               | `kubectl get nodes -o json`                                                            |
| `platform_package.json`    | `kubectl get packages.cozystack.io cozystack.cozystack-platform -o json`               |
| `app_definitions.json`     | `kubectl get applicationdefinitions.cozystack.io -o json`                              |
| `apps.json`                | `kubectl get <kind>.apps.cozystack.io -n <namespace> -o json`                          |
| `tenants.json`             | `kubectl get tenants.apps.cozystack.io -n <namespace> -o json`                         |
| `packages.json`            | `kubectl get packages.cozystack.io -A -o json`                                         |
| `workloads.json`           | `kubectl get workloads.cozystack.io -A -o json`                                        |
| `helmreleases.json`        | `kubectl get helmreleases.helm.toolkit.fluxcd.io -A -o json`                           |
| `secret.json`              | `kubectl get secret <name> -n <namespace> -o json` (`getAppSecret`)                    |
| `tenant_secret.json`       | `kubectl get secret <tenantName> -n <tenantNamespace> -o json` (`getTenantKubeconfig`) |

Text-only kubectl/helm outputs — `api-resources -o name` (`listApps`'s
resource-discovery call), `cluster-info` (the `cluster-reachable` check),
`helm version --short` (the `helm-available` check), `rollout status`
(`waitReady`), `config view -o jsonpath=...` (`getTenantKubeconfig`'s server
lookup), and every `apply`/`patch`/`helm upgrade --install` confirmation stdout
— are routed by the stateful command fake directly in each test file, not as
committed fixture files, since they are plain strings rather than JSON
documents.

## A documented API shape this corpus deliberately preserves

`getAppSecret` decodes **every** key in `secret.data` via `atob()`, while
`getTenantKubeconfig` decodes only `token` and `namespace` and passes `ca.crt`
through **undecoded** (it is written verbatim into the assembled kubeconfig's
`certificate-authority-data` field, which is itself expected to be base64 PEM).
`tenant_secret.json`'s `ca.crt` value is therefore valid base64 by convention
(so a future decode-everything refactor wouldn't crash), but `cozystack.ts`
today never decodes it — the contract-fixture and methods suites pin this
asymmetry explicitly so a refactor cannot silently change either side without a
test going red.
