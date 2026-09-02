# @magistr/victoriametrics

VictoriaMetrics query API for [swamp](https://github.com/systeminit/swamp). Run
instant and range
[PromQL](https://prometheus.io/docs/prometheus/latest/querying/basics/) against
a [VictoriaMetrics](https://victoriametrics.com/) (or any Prometheus-compatible)
HTTP endpoint, check scrape-target health, build a node-exporter system
overview, and rank container memory usage — all written back as swamp data
resources you can wire downstream with CEL.

## Model

| Type                       | What it queries                                           |
| -------------------------- | --------------------------------------------------------- |
| `@magistr/victoriametrics` | A VictoriaMetrics / Prometheus HTTP query API (`/api/v1`) |

## globalArguments

| Field  | Required | Default | Description                                       |
| ------ | -------- | ------- | ------------------------------------------------- |
| `host` | yes      | —       | VictoriaMetrics host (IP or hostname, no scheme). |
| `port` | no       | `8428`  | VictoriaMetrics HTTP port.                        |

The model talks plain `http://<host>:<port>` to the query API.

## Methods

| Method             | Arguments                              | Description                                                            |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------- |
| `query`            | `promql`                               | Instant PromQL query → `queryResult` resource.                         |
| `query-range`      | `promql`, `hoursBack?`, `stepSeconds?` | Range PromQL over a time window → `queryResult` resource.              |
| `health`           | —                                      | Scrape-target up/down status from the `up` metric → `health` resource. |
| `system-overview`  | `hoursBack?`                           | CPU/memory/load/disk/network stats + anomaly detection → `overview`.   |
| `container-memory` | `hoursBack?`, `topN?`                  | Top-N container memory usage rankings → `containerMemory` resource.    |
| `push`             | `lines`, `extraLabels?`                | Import Prometheus exposition text → `pushResult` resource.             |

`push` is the one method that WRITES. It posts exposition text (one
`name{labels} value` per line) to `/api/v1/import/prometheus`, so a job can
record its own outcome as a series vmalert can alert on instead of a chat
message nobody diffs. VictoriaMetrics assigns the timestamps at ingest.

Two things to know before alerting on what you push. A one-shot push is a single
sample, and VM's default `-search.latencyOffset=30s` hides it for the first ~30s
— an instant query straight after a 204 legitimately returns `[]`. And a sample
goes stale after ~5 minutes, so a rule over a once-a-day push must read
`last_over_time(my_metric[26h])`; a bare instant selector can only match for
five minutes a day.

`system-overview` and `container-memory` assume a node-exporter / cAdvisor
metric set (`node_cpu_seconds_total`, `node_memory_*`, `node_load1`,
`container_memory_usage_bytes`, …). Adjust the PromQL in those methods if your
exporters differ.

## Setup

```yaml
# globalArguments for the model instance
globalArguments:
  host: "victoriametrics.example.com"
  port: 8428
```

```bash
# 1. Create and configure the model instance
swamp model create @magistr/victoriametrics my-vm --json
swamp model edit my-vm --json <<'EOF'
globalArguments:
  host: "victoriametrics.example.com"
  port: 8428
EOF

# 2. Run an instant query
swamp model method run my-vm query \
  --input promql='up' --json

# 3. Run a range query over the last 6 hours, 60s step
swamp model method run my-vm query-range \
  --input promql='node_load1' --input hoursBack=6 --input stepSeconds=60 --json

# 4. Health, overview and container memory
swamp model method run my-vm health --json
swamp model method run my-vm system-overview --input hoursBack=12 --json
swamp model method run my-vm container-memory --input hoursBack=12 --input topN=20 --json

# 5. Record a job's own outcome as an alertable series
swamp model method run my-vm push --json --input '{
  "lines": "my_job_ok 1\nmy_job_timestamp 1788371400",
  "extraLabels": "job=my-job,instance=unraid"
}'
```

## Resources produced

- `queryResult` — `{ query, resultType, results[], timestamp }`
- `health` — `{ targets: [{ name, status }], timestamp }`
- `overview` —
  `{ cpu, memory, load, disk[], network, uptime, anomalies[], timestamp }`
- `containerMemory` —
  `{ containers: [{ name, maxMB, startMB, endMB, growthPercent }], timestamp }`
- `pushResult` —
  `{ endpoint, lines, metrics[], httpStatus, ok, error, timestamp }`

A failed `push` writes `pushResult` with `ok:false` **and then** throws — the
attempt that failed is the one worth having a record of.

Reference results downstream with CEL, e.g.
`data.latest("my-vm", "overview").attributes.cpu.max`.

## License

[MIT](./LICENSE.md)
