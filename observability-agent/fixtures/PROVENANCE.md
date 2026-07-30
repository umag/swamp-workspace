# Fixture provenance

Every JSON file in this directory is **pure doc/source-derived synthetic data**,
hand-authored from the published `stdout` shapes `observability_agent.ts`'s own
remote bash scripts print (`echo "KEY=$(...)"` lines, the `===SECTION===`
markers `inventory` emits, and documented `ss -tulnpH` / `systemctl
is-active` /
`ps -eo comm=` column layouts) — **never captured from a live SSH call**. This
mirrors the `talos-node` and `victorialogs` backfill precedents (synthetic
fixtures, no live capture) and is a deliberate security decision, not an
oversight.

Each fixture is a `{success, stdout, stderr}` envelope — the exact shape
`sshScript()` in `../extensions/models/observability_agent.ts` receives back
from `Deno.Command("ssh", ...).spawn()` -> `child.output()` after `TextDecoder`
decoding. This is the natural wire boundary for an SSH-subprocess-wrapping model
(the `Deno.Command` boundary), the same boundary `talos-node`'s fixtures pin for
its `Deno.Command("talosctl")` boundary.

## What was NOT done (standing prohibition)

Real `@magistr/observability/agent` instances exist in this homelab (see
`reference_observability_agent_extension.md`), targeting real hosts over a real
WireGuard tunnel. **Live capture from any real target host, over any real SSH
connection, is FORBIDDEN** for this fixture corpus — not "not done this time",
but a standing rule for anyone regenerating these fixtures later:

- No `swamp model method run <instance> <install|configure|status|inventory>`
  call was made against any real `@magistr/observability/agent` instance while
  authoring these fixtures.
- No real `sshHost`, `bindAddress`, `logsEndpoint`, `hostLabel`, or
  `bindWaitUnit` value from any managed instance appears anywhere below or in
  the test suites that consume these fixtures.
- No real SSH key, host key, or `known_hosts` entry was read, exported, or
  otherwise touched.
- The destructive/mutating methods (`install`, `configure`) were never invoked
  against any real host — their fixture stdout shapes are transcribed from the
  literal `echo`/`printf` lines the source script prints, not observed side
  effects.

The fixtures-secret-scan test in
`../extensions/models/observability_agent_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place. Since these fixtures are
authored-synthetic KV/section stdout text (no cert/key material), the residual
leak risk the scan defends against is near-zero; do not treat the heuristic scan
as a guarantee that would also hold for genuinely captured data.

**Scope, explicitly:** the scan walks the already-imported `fixtures/*.json`
objects (`with { type: "json" }`) only — it does NOT also scan the `*_test.ts`
sources themselves (unlike the talm-cluster/talos-node precedent). This is
deliberate: source-scanning would require `Deno.readTextFile`/`Deno.readDir`,
which need `--allow-read`, a permission this extension's default
`deno task
test` intentionally omits (observability-agent does zero local
filesystem I/O of its own — everything is over SSH). A credential-shaped literal
pasted directly into a test body would not be caught by this scan; code review
is the control for that residual case.

## Every value is synthetic

- Exporter bind addresses: `192.0.2.10` / `192.0.2.11` — from the `TEST-NET-1`
  documentation range ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)).
  Never a real WireGuard tunnel IP.
- VictoriaLogs ingestion endpoint host: `198.51.100.20` — `TEST-NET-2`.
- The "hostile WireGuard tunnel" address used by the adversarial suite's
  `bindWaitUnit`/injection pins: `203.0.113.5` — `TEST-NET-3`.
- SSH target hostname: `host.example` — an IANA-reserved
  ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) example domain, never a
  real host in this homelab.
- Process IDs (`1234`, `1235`, `810`, `700`), package versions (node_exporter
  `1.7.0`, blackbox_exporter `0.25.0`, vector `0.46.1` — the model's own
  documented default `vectorVersion`), and service/process names are
  realistic-looking placeholders, not observed values.

## Per-file mapping to the documented command

| File                      | Documented remote script (method)                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `install.json`            | `install`'s `echo "NODE=..."`/`BLACKBOX=`/`VECTOR=` lines                                                   |
| `configure.json`          | `configure`'s post-restart `NODE=`/`BLACKBOX=`/`VECTOR=active` lines (logsEndpoint SET — vector configured) |
| `configure-novector.json` | Same, but `VECTOR=skipped` (logsEndpoint UNSET — vector not configured)                                     |
| `status.json`             | `status`'s `svc.*`/`lst.*` lines                                                                            |
| `inventory.json`          | `inventory`'s `===SERVICES===`/`===LISTENERS===`/`===PROCS===` layout                                       |
| `error.json`              | A generic non-zero-exit SSH/remote-script failure (any method)                                              |

## A documented output quirk this corpus deliberately preserves

`inventory.json`'s `===LISTENERS===` section uses single-token (no-space) values
in the `ss -tulnpH` local-address/process columns — this is the REALISTIC case,
since listen addresses and `users:(("name",...))` process names never
legitimately contain a space in that position. The adversarial suite's
hostile-input pins for `parseKv`/the section-parser use their OWN inline
synthetic lines (not this fixture) to characterize edge behavior on
malformed/hostile input — kept out of these contract fixtures so the contract
suite pins the well-formed, documented shape and the adversarial/ coverage
suites pin the malformed-input behavior separately.
