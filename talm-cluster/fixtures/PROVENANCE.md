# Fixture provenance

Every file in this directory is **pure doc-derived / hand-authored**, never
captured from a live call or a live cluster. This mirrors the `porkbun`
precedent (`ext-quality-bf-porkbun`) and is a deliberate security decision, not
an oversight.

## What was NOT done (standing prohibition)

A **real homelab Talos cluster managed by talm exists**. **Live capture from
that cluster — or from any real talm/talosctl invocation — is FORBIDDEN** for
this fixture corpus, now and for anyone regenerating these fixtures later:

- No `swamp model method run <talm-cluster-instance> <method>` call was made
  while authoring these fixtures.
- No `talm` or `talosctl` binary was invoked against a real cluster directory.
- `talosconfig`, `kubeconfig`, and `secrets.yaml` were never read, copied, or
  exported from the real cluster directory — the model itself never parses their
  content either (see "Why credential-file content is safe" below), so the test
  suites only ever need **content-free existence markers** for these three
  filenames, created fresh in a temp dir at test time, never committed here.
- The node-config YAML fixtures (`templateNode.*.yaml`) are hand-authored from
  the public
  [Talos machine config reference](https://www.talos.dev/latest/reference/configuration/)
  shape, not exported from any real node.
- No vault credential was read, exported, or otherwise touched.

The fixtures-secret-scan test in
`../extensions/models/talm_cluster_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place.

## Why credential-file content is safe to leave content-free

`talm_cluster.ts` never reads the _content_ of `talosconfig`, `kubeconfig`, or
`secrets.yaml` into JS. It only:

- `Deno.stat`s them to report presence/absence (`getClusterState`), which never
  touches file bytes, or
- passes their _path_ as a `--talosconfig <path>` CLI argument to a (stubbed, in
  these tests) `talosctl`/`talm` subprocess.

So a test never needs realistic credential bytes in these three files to
exercise real behavior — an empty placeholder is indistinguishable from the real
thing to every code path under test. Fixtures for the two dedicated node-config
variants below _do_ carry Talos-shaped fields (they're what the `templateNode`
output looks like), so those get the low-entropy fake treatment instead.

## Every value is synthetic and low-entropy on purpose

- IP addresses: `192.0.2.0/24` — `TEST-NET-1`, and endpoint/VIP examples on
  `192.0.2.10` / `192.0.2.20` — all from
  [RFC 5737](https://www.rfc-editor.org/rfc/rfc5737) documentation ranges, never
  a real homelab address.
- Cluster id / secret / bootstrap & join tokens: literal strings like
  `fake.talm.token.do.not.use` and `FAKE-CLUSTER-ID-DO-NOT-USE` — obviously
  fake, human-readable, and _not_ base64.
- `ca.crt` / `ca.key` fields: short, plainly-fake, hyphenated placeholder
  strings (`FAKE-CA-CRT-NOT-REAL`, `FAKE-CLUSTER-CA-CRT-NOTREAL`, …) —
  deliberately NOT base64 and deliberately kept under 32 characters. Talos's
  real `machine.ca.crt` / `cluster.ca.crt` fields are base64 PEM/DER blobs, so
  an entropy-based secret scanner over a _realistic-length_ base64 fake could
  either false-positive on an intentionally fake value, or — worse — force a
  value-specific allowlist entry that would then also suppress a genuinely
  leaked high-entropy blob. Staying short and non-base64-shaped keeps these
  values below the scan's high-entropy length threshold with no allowlist needed
  at all.
- Container image refs (`ghcr.io/siderolabs/installer:v1.7.0`) — the public,
  documented Sidero Labs installer image, not a private registry.
- `init.stdout.txt` / `bootstrap.stdout.txt` / `health.stdout.txt` — generic,
  documentation-style CLI transcript lines; no real cluster name, node identity,
  or timing data.
- `transient-errors.json` — the transient-error substring vocabulary is
  transcribed directly from `talm_cluster.ts`'s own retry classifiers (one list
  per retrying method); it contains no secret material, only string literals
  already present in the (public, MIT-licensed) source.

## Talos/k8s secret-shape list the scan enforces

Adapted from `porkbun`'s API-key-shaped scan to this domain's actual credential
shapes (talosconfig/kubeconfig/secrets.yaml are the highest-secret-density
artifacts in this repo — they embed admin CA material plus client cert/key
pairs):

- PEM markers: `-----BEGIN ... PRIVATE KEY-----` /
  `-----BEGIN CERTIFICATE-----`, anywhere in the raw file text — applies to BOTH
  fixture data files AND `*_test.ts` sources (real code never legitimately
  contains a literal PEM block, so there is no ambiguity).
- Generic high-entropy rule: any whitespace/punctuation-delimited TOKEN that is
  ENTIRELY 32+ standard-base64-alphabet characters (`[A-Za-z0-9+/=]` — no
  `-`/`_`, so base64url and hyphen/underscore-joined identifiers like a
  `// ---...---` section divider or `cluster-dir-exists` split apart at every
  hyphen instead of forming one long, zero-actual-entropy false positive) with
  no separators. Applies ONLY to fixture DATA files (`.yaml`/`.yml`/`.txt`/
  `.json` — pure data, no prose). It deliberately does NOT apply to `*_test.ts`
  sources: source files are full of natural-language comments and
  slash/dot-joined identifiers (e.g. `templateNode/apply/bootstrap/health`) that
  a length+charset heuristic cannot distinguish from a genuine credential blob,
  so extending it there produced exactly the kind of noisy false positive that
  erodes trust in a secret scanner (caught and fixed during this suite's own
  authoring). This is deliberately field-name-agnostic — kubeconfig's
  `client-key-data` / `client-certificate-data` / `certificate-authority-data`
  and talosconfig/Talos machine-config's `ca.crt` / `ca.key` / `token` are all
  real-world instances of "a credential field whose VALUE is a long contiguous
  base64 blob"; catching the value shape catches all of them without hardcoding
  field names (and without needing to parse YAML — the scan reads every fixture
  file as raw text). None of the low-entropy fake values in this corpus (see
  previous section) match this shape.
- Scope: every file under `fixtures/` PLUS every `*_test.ts` source under
  `../extensions/models/` — a credential-shaped literal asserted inline in a
  test body (not just a committed fixture file) is caught too.
- A self-poison positive control keeps the scan test from passing vacuously (see
  the adversarial suite's "sanity" test).

## Per-file mapping

| File                                | What it stands in for                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `templateNode.controlplane.yaml`    | happy-path `talm template` stdout — sr0 disk + interface directly followed by `vip:` (both post-processing regexes fire) |
| `templateNode.multi-disk.yaml`      | a second `disk: /dev/srN`-shaped text occurrence — pins the disk-rewrite regex's missing `g` flag (first match only)     |
| `templateNode.no-sr.yaml`           | `install.disk` already a real block device — disk regex is a no-op                                                       |
| `templateNode.iface-no-routes.yaml` | interface entry followed by `addresses:`, not `routes:`/`vip:` — dhcp-injection regex is a no-op                         |
| `init.stdout.txt`                   | `talm init` stdout transcript                                                                                            |
| `bootstrap.stdout.txt`              | `talosctl bootstrap` stdout transcript                                                                                   |
| `health.stdout.txt`                 | `talosctl health` stdout transcript                                                                                      |
| `transient-errors.json`             | per-method transient-error substring vocabulary, transcribed from source                                                 |

## A documented behavior this corpus deliberately preserves (pin, not fix)

`templateNode`'s install-disk rewrite
(`config.replace(/disk: \/dev\/sr\d+/,
...)`, no `g` flag) rewrites only the
**first** `disk: /dev/srN` occurrence in the generated config.
`templateNode.multi-disk.yaml` exists specifically to prove this — a real latent
gap in already-shipped behavior, pinned by the contract-fixture suite rather
than "fixed" here (`talm_cluster.ts` is unmodified by this change; see
`CHANGELOG.md`).
