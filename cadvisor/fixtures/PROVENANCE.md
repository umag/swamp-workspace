# Fixture provenance

Every file in this directory is **pure doc-derived** — hand-authored from the
published [cAdvisor `/api/v1.3/docker` API](https://github.com/google/cadvisor)
response shape, the
[VictoriaMetrics `/api/v1/query_range` API](https://docs.victoriametrics.com/#prometheus-querying-api-usage)
(Prometheus-compatible range-query format), and a representative Prometheus/VM
scrape-config YAML layout — never captured from a live call. This mirrors the
`porkbun`/`talos-node` precedent (synthetic fixtures, no live capture) and is a
deliberate security decision, not an oversight.

## What was NOT done (standing prohibition, BOTH boundaries)

`@magistr/cadvisor` is a **dual-boundary** model — SSH (`Deno.Command("ssh")`,
via `runSsh`) AND HTTP (`fetch`, via `vmQuery` and the direct cAdvisor call in
`current-metrics`) — so the capture ban covers both paths, not just one. A live
cAdvisor deployment (`unraid-cadvisor`, type `@cadvisor/metrics`) and a live
VictoriaMetrics instance (`vm-unraid`, type `@victoriametrics/query`) **do
exist** in this homelab (confirmed via `swamp model search cadvisor` /
`swamp model search victoriametrics` — read-only listing only, no method was run
against either). No `@magistr/cadvisor` instance itself exists at the time of
writing, but the underlying host/API surface these fixtures describe is real.
**Live capture from any of them is FORBIDDEN** for this fixture corpus — not
"not done this time", but a standing rule for anyone regenerating these fixtures
later:

- No
  `swamp model method run <instance> current-metrics|top-memory|status|deploy|remove`
  call was made against `unraid-cadvisor`, `vm-unraid`, or any other real
  `@magistr/cadvisor`/`@cadvisor/metrics`/`@victoriametrics/query` instance
  while authoring these fixtures.
- No SSH session was opened to any real Docker/VictoriaMetrics host, and no real
  host's `docker inspect` output or prometheus scrape-config file was `cat`-ed,
  copied, or otherwise read.
- No real hostname, IP address, container name, or scrape-target address from
  this homelab appears anywhere below.
- The destructive operations (`deploy`'s `docker run`/config-append/VM restart,
  `remove`'s stop/rm/sed-edit/VM restart) were never invoked against any real
  host — every fixture shape is transcribed from the documented API response
  schema or a representative scrape-config layout, not an observed side effect.

## Why this is a data-disclosure risk, not a credential-leak risk

`@magistr/cadvisor` uses key-based SSH (`BatchMode=yes`) and **no vault** — the
model's `globalArguments` carry no secret fields at all (no API key, no
password). The residual risk a live capture would create is therefore
**operational-data disclosure** (real hostnames, real container/service names,
real memory/CPU profiles, real scrape-target IPs), not credential leakage. That
is still a real exposure — a captured prometheus scrape config or a real
`current-metrics` snapshot would reveal this homelab's container topology and
resource footprint — which is exactly why the ban above is explicit and
standing, even though there is no secret-shaped string for a mechanical scanner
to catch.

The fixtures-secret-scan test in
`../extensions/models/cadvisor_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place. Since these fixtures are
authored-synthetic rather than captured-and-redacted, the residual leak risk the
scan defends against is near-zero; do not treat the heuristic scan as a
guarantee that would also hold for genuinely captured data.

A second, structural backstop exists beyond the fixtures themselves:
`deno.json`'s default `test` task grants neither `--allow-net` nor
`--allow-run`. If a test ever forgot to install the fetch/Deno.Command stub, the
resulting call would hard-fail with a `PermissionDenied` error rather than
silently reaching a real cAdvisor/VictoriaMetrics host or spawning a real `ssh`
process — mirroring `talos-node`'s explicit callout of the same reasoning for
its own `--allow-run` omission.

## Every value is synthetic

- Container cgroup paths (`/docker/1111aaaa...`, `/docker/2222bbbb...`, etc.) —
  64-hex-character repeating-pattern placeholders, not real Docker container IDs
  (which are opaque SHA-256-derived hex strings from a real daemon).
- Container aliases: `web-frontend`, `postgres-db`, `idle-empty-stats`,
  `missing-stats-field` — generic, descriptive service-role names, never a real
  container/service name from this homelab.
- Host/target address: `host.example.com` —
  [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserved example domain,
  never a real host.
- Byte counts (`memory.usage`, `spec.memory.limit`,
  `network.rx_bytes`/`tx_bytes`, `cpu.usage.total`) — round synthetic values
  chosen so the MB/percent/rate transform arithmetic is hand-verifiable, not
  observed measurements from any real container.
- The `spec.memory.limit: 9223372036854771712` value on the `postgres-db`
  fixture container is the well-known, publicly documented cAdvisor **"no memory
  limit"** sentinel (`math.MaxInt64` rounded down to the host page size) — a
  real constant from the cAdvisor source, not a measurement from any live
  container.
- VictoriaMetrics `values` timestamps (`1751370000`, `1751370300`, `1751370600`)
  — synthetic sequential Unix timestamps 300s apart (matching `top-memory`'s
  `step=300` query parameter), not from any real query.
- Prometheus scrape-config targets (`localhost:8428`, `host.example.com:9100`,
  `host.example.com:8080`) — a representative VictoriaMetrics + node-exporter +
  cAdvisor layout using the reserved example domain and this model's own
  documented default ports, not a real scrape config.

## Per-file mapping to the documented endpoint/shape

| File                       | Documented source                                                  |
| -------------------------- | ------------------------------------------------------------------ |
| `cadvisor-docker.json`     | `GET /api/v1.3/docker` (cAdvisor container info + stats)           |
| `vm-query-range.json`      | `GET /api/v1/query_range` (VictoriaMetrics/Prometheus range query) |
| `scrape-config-before.txt` | Prometheus/VM scrape-config YAML, before `deploy` adds `cadvisor`  |
| `scrape-config-after.txt`  | Same file, after `deploy` appends the `cadvisor` scrape job        |

## A documented API quirk this corpus deliberately preserves

VictoriaMetrics' `/api/v1/query_range` response (like upstream Prometheus)
serializes each sample as a `[timestamp, value]` pair where the **timestamp is a
wire NUMBER but the value is a wire STRING** (e.g. `[1751370000,
"104857600"]`),
even though the value is numeric in nature. `top-memory`'s `parseFloat(v[1])`
call exists precisely because of this quirk — the contract-fixture suite pins
this asymmetry as the drift sentinel, mirroring `porkbun`'s string-typed
`ttl`/`prio` fixture precedent: a future `vm-query-range.json` regeneration that
"helpfully" emits numeric values would silently stop testing what `top-memory`
actually has to handle.

## Container shapes deliberately included (contract vs. adversarial split)

`cadvisor-docker.json` includes containers exercising the **well-formed,
documented** shape variations `current-metrics` must handle in normal operation:
a two-sample container (delta/rate math has a previous sample), the real
cAdvisor "no limit" sentinel, an empty (but present) `aliases` array, a
container with no `aliases` field at all, an empty `stats` array, and a
container with no `stats` field at all. Hostile/malformed inputs (negative
counter-reset deltas, non-JSON bodies, missing VM metric names) are deliberately
**not** in this fixture — those live as inline synthetic payloads in
`cadvisor_adversarial_test.ts`/`cadvisor_coverage_test.ts`, keeping this
contract corpus limited to the documented, well-formed wire shape (the same
split `talos-node`'s fixtures use for its tabular-parser edge cases).
