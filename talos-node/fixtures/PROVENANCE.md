# Fixture provenance

Every JSON file in this directory is **pure doc/help-derived** — hand-authored
from the published [Talos Linux documentation](https://www.talos.dev/) and
`talosctl <command> --help` output shapes, never captured from a live call. This
mirrors the `porkbun` precedent (synthetic fixtures, no live capture) and is a
deliberate security decision, not an oversight.

Each fixture is a `{success, stdout, stderr}` envelope — the exact shape
`talosctl()` in `../extensions/models/talos.ts` receives back from
`Deno.Command(...).output()` after `TextDecoder` decoding. This is the natural
wire boundary for a subprocess-wrapping model (the Deno.Command boundary),
mirroring how `porkbun`'s fixtures pin the `fetch`-boundary JSON body.

## What was NOT done (standing prohibition)

A `talm-cluster` (`@magistr/talm-cluster`) extension manages a real Talos
cluster's lifecycle via `talm` in this homelab, and a real `@magistr/talos-node`
model type exists to wrap `talosctl` directly. **Live capture from any real
Talos node, cluster, or talosconfig is FORBIDDEN** for this fixture corpus — not
"not done this time", but a standing rule for anyone regenerating these fixtures
later:

- No `swamp model method run <instance> <method>` call was made against any real
  `@magistr/talos-node` or `@magistr/talm-cluster` instance while authoring
  these fixtures. No live `@magistr/talos-node` instance exists in this homelab
  at the time of writing (confirmed via `swamp model search
  talos`) — there
  was nothing to capture from even opportunistically.
- No real `talosconfig`, kubeconfig, client certificate, or client key from any
  managed cluster was read, exported, or otherwise touched.
- No real node IP, hostname, cluster name, or etcd member ID from any managed
  Talos cluster appears anywhere below.
- The destructive/mutating operations (`bootstrap`, `reset`, `upgrade`,
  `reboot`, `shutdown`, `applyConfig`, `patchConfig`) were never invoked against
  any real node — their fixture shapes are transcribed from documented CLI
  output, not observed side effects.

The fixtures-secret-scan test in
`../extensions/models/talos_adversarial_test.ts` is a **mechanical backstop**,
not the primary control — the primary control is this prohibition plus never
running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero; do not treat the heuristic scan as a
guarantee that would also hold for genuinely captured data.

## Every value is synthetic

- Node IPs: `192.0.2.10` / `192.0.2.11` / `192.0.2.12` — from the `TEST-NET-1`
  documentation range ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)).
- Cluster/context name: `fake-cluster` — never a real cluster name.
- etcd member IDs (`634a1dccd6e0d1e5`, `9f39a7b0c8d21a44`, `2b6e4f91a3c9d075`) —
  synthetic hex placeholders, not real etcd raft member IDs.
- Talos version (`v1.9.5`, sha `8f61e6dd`) — a real, publicly documented Talos
  release tag used only as a realistic version string; not tied to any specific
  deployed node.

## Kubeconfig sentinel decision (resolves the round-1 plan-review HIGH)

`kubeconfig.json`'s `certificate-authority-data` / `client-certificate-data` /
`client-key-data` fields are **SHORT fake sentinel blobs** — base64 of the
literal strings `fake-ca` (`ZmFrZS1jYQ==`, 12 chars), `fake-cert`
(`ZmFrZS1jZXJ0`, 12 chars), and `fake-key` (`ZmFrZS1rZXk=`, 12 chars). All three
are well under the 32-character threshold the adversarial suite's high-entropy
secret-scan rule uses (`^[A-Za-z0-9+/_=-]{32,}$`), so this fixture is
structurally a valid kubeconfig YAML document (parseable, right shape) while
never being long enough to look like a real base64-encoded certificate or key
(which typically run into the hundreds of characters). The scan additionally
allow-lists the kubeconfig cert/key **field names** from the high-entropy rule
specifically — but continues to run the real-credential patterns (PEM
`-----BEGIN`, JWT `eyJ`, Talos PKI markers) against every field, with a sanity
test proving an injected real PEM/JWT still trips the scan even inside the
allow-listed fields. See the security review's residual LOW finding on plan v2
for the reasoning that this heuristic scan is a backstop, not the primary
guarantee, given these fixtures are authored-synthetic in the first place.

## Per-file mapping to the documented command

| File                | Documented command                                     |
| ------------------- | ------------------------------------------------------ |
| `version.json`      | `talosctl version --json`                              |
| `services.json`     | `talosctl services`                                    |
| `etcd-members.json` | `talosctl etcd members`                                |
| `kubeconfig.json`   | `talosctl kubeconfig -`                                |
| `health.json`       | `talosctl health --wait-timeout <duration>`            |
| `apply-config.json` | `talosctl apply-config --file <file> --mode <mode>`    |
| `error.json`        | Generic non-transient `talosctl` failure (any command) |

## A documented output quirk this corpus deliberately preserves

`services.json` and `etcd-members.json` use single-token (no-space) values in
every whitespace-delimited column — this is the REALISTIC case, since Talos
service names, states, health values, hostnames, and etcd peer/client URLs never
legitimately contain a space. The adversarial suite's "pin" tests for
space-bearing table rows use their OWN inline synthetic row (not this fixture)
to characterize `talos.ts`'s `split(/\s+/)` mis-columning on the rare hostile or
malformed case — kept out of these contract fixtures so the contract suite pins
the well-formed, documented shape and the adversarial suite pins the
malformed-input behavior separately.
