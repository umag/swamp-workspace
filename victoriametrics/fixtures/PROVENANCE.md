# Fixture provenance

Every JSON file in this directory is **pure doc-derived** — hand-authored from
the published
[Prometheus HTTP API query format](https://prometheus.io/docs/prometheus/latest/querying/api/)
(VictoriaMetrics's `/api/v1/query` and `/api/v1/query_range` are wire-compatible
with it), never captured from a live call. This mirrors the `porkbun` precedent
(synthetic fixtures, no live capture) and is a deliberate security decision, not
an oversight.

## What was NOT done (explicit prohibition)

A live `vm-unraid` (`@magistr/victoriametrics`) model instance **does exist** in
this homelab (the canary seed for a future Phase C). **Live capture from that
instance is FORBIDDEN** for this fixture corpus — not "not done this time", but
a standing rule for anyone regenerating these fixtures later:

- No `swamp model method run vm-unraid <method>` call was made while authoring
  these fixtures.
- No real scrape-target `job`/`instance` label, container name, disk device
  name, or metric value observed from the live homelab appears anywhere below.
- No real hostname, homelab domain, or private/CGNAT IP address appears anywhere
  in this directory.

The fixtures-secret/real-infra scan test in
`../extensions/models/victoriametrics_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place. The scan enforces a CONCRETE
named denylist (not an illustrative example list):

- `aopab` — the homelab's real domain
- `unraid` — the real hypervisor host's product name
- `vm-unraid` — the real live instance name for this exact model
- `192.168.` — RFC 1918 private range used on the real homelab LAN
- `10.` — RFC 1918 private range
- `100.64.` — RFC 6598 CGNAT range used by the real homelab's WireGuard mesh

A poison test injects one of these banned substrings into a throwaway fixture
and asserts the scan flags it, so the guard cannot be vacuously green.

## Every value is synthetic

- `job` label: `demo-node` — a placeholder job name, never a real Prometheus
  scrape-job name from this homelab's config.
- `instance` labels: `fixture-host-1:9100` / `fixture-host-2:9100` — synthetic
  node-exporter targets; `9100` is node-exporter's well-known documented default
  port, not evidence of a real host.
- Disk devices: `vda` / `vdb` — generic virtio block-device names, the
  documented QEMU/KVM convention, not the real host's actual device names.
- Container names: `web` / `cache` / `worker` — generic role placeholders, not
  real container names from this homelab's compose stacks.
- `device="br0"` in the network-receive query string: this is **not** a choice
  made for these fixtures — `br0` is hardcoded verbatim inside
  `victoriametrics.ts` itself (the byte-frozen production source), so the
  fixture and router key must reproduce it exactly to route the request at all.
  It happens to also be a common bridge-interface name; no inference about any
  real host's network topology should be drawn from it.
- Timestamps: a single fixed synthetic epoch, `1700000000` (seconds) as "now",
  with a 12-hour lookback window (`1699956800`) and a synthetic boot time 5
  hours earlier (`1699982000`) — round, memorable, and unrelated to any real
  deployment's uptime.
- Numeric metric values (CPU/mem/load/disk/network/container-memory): small,
  round, plausible node-exporter-shaped numbers chosen only to keep every
  system-overview anomaly threshold on the non-alerting side for the "quiet"
  happy-path fixture (see the methods suite) — not observations of any real
  system.

## Per-file mapping to the documented endpoint

| File                      | Documented endpoint / query shape                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `query_vector.json`       | `GET /api/v1/query` — instant vector result                                                       |
| `query_scalar.json`       | `GET /api/v1/query` — instant **scalar** result (pins the garbage-mapping gap)                    |
| `query_range_matrix.json` | `GET /api/v1/query_range` — range matrix result                                                   |
| `health_up.json`          | `GET /api/v1/query?query=up` — scrape-target health vector                                        |
| `system_overview.json`    | Object keyed by the SIX exact PromQL strings `system-overview` issues (see below)                 |
| `container_memory.json`   | `GET /api/v1/query_range?query=container_memory_usage_bytes` — matrix                             |
| `error.json`              | The Prometheus/VictoriaMetrics error envelope (`{status:"error",...}`, HTTP 200, no `data` field) |

## `system_overview.json`'s six exact keys

`system-overview` fires six parallel queries through one `fetch` — five range
queries plus one instant query. The fixture is a single object keyed by the
**exact, verbatim** PromQL strings copied character-for-character from
`victoriametrics.ts` (including the label selectors), so the test harness's
router can dispatch on `new URL(url).searchParams.get("query")` without any
transformation:

1. `100-avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100`
2. `(1-node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)*100`
3. `node_load1`
4. `rate(node_disk_io_time_seconds_total{device!~"(dm-|md|loop|sr|zram|ram|nbd|drbd|zd).*"}[5m])*100`
5. `rate(node_network_receive_bytes_total{device="br0"}[5m])*8`
6. `node_boot_time_seconds`

If any one of these six strings drifts by even a single character from the
source, the router throws `unrouted` and every `system-overview` test using this
fixture fails immediately — which is the intended tripwire, not a bug.

The values in this fixture are deliberately a **quiet** baseline: every anomaly
threshold in `system-overview` (cpu.max>90, mem.max>90, mem.min>80, load.max>30,
disk>90, metric-gap>600s, memory-growth>5 over >10 samples) is on the
non-alerting side, so the happy-path methods test asserts `anomalies: []`.
Threshold-edge cases (values just at/over each cutoff) are constructed as
separate inline fixtures in the adversarial suite, not here.
