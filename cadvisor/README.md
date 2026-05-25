# @magistr/cadvisor

cAdvisor container metrics for [swamp](https://github.com/systeminit/swamp).
This model deploys a [cAdvisor](https://github.com/google/cadvisor) container on
a Docker host over SSH, registers it as a scrape target in a
[VictoriaMetrics](https://victoriametrics.com/) instance, and then lets you
query live and historical per-container resource usage (memory, CPU, network).

It is built for a homelab/single-host topology where cAdvisor and
VictoriaMetrics run via Docker Compose on the same machine: `deploy` runs the
container and appends a `cadvisor` scrape job to the prometheus scrape config,
`current-metrics` reads the cAdvisor `/api/v1.3/docker` API directly, and
`top-memory` runs a range query against the VictoriaMetrics API to rank the
biggest (and fastest-growing) memory consumers over a lookback window.

## Global arguments

| Argument         | Type   | Default                    | Description                                          |
| ---------------- | ------ | -------------------------- | ---------------------------------------------------- |
| `host`           | string | (required)                 | Docker host (IP or hostname) reached over SSH/HTTP   |
| `username`       | string | `root`                     | SSH username                                         |
| `cadvisorPort`   | number | `8080`                     | Host port that cAdvisor is published on              |
| `vmComposeDir`   | string | (required)                 | Path to the VictoriaMetrics docker-compose directory |
| `vmComposeFile`  | string | `compose-vl-single.yml`    | VictoriaMetrics compose file name                    |
| `vmScrapeConfig` | string | `prometheus-vl-single.yml` | Prometheus scrape config file name                   |

SSH is invoked with `BatchMode=yes`, so key-based auth to `host` must already be
configured for `username`. The VictoriaMetrics HTTP API is assumed to listen on
port `8428` on `host`.

## Instance configuration

```yaml
type: "@magistr/cadvisor"
typeVersion: "2026.05.25.1"
name: my-cadvisor
version: 1
globalArguments:
  host: "203.0.113.10"
  username: "root"
  cadvisorPort: 8080
  vmComposeDir: "/opt/victoriametrics"
  vmComposeFile: "compose-vl-single.yml"
  vmScrapeConfig: "prometheus-vl-single.yml"
methods: {}
```

## Usage

```bash
# Deploy cAdvisor + add the VictoriaMetrics scrape target (idempotent)
swamp model method run my-cadvisor deploy

# Check container + scrape-config status
swamp model method run my-cadvisor status

# Snapshot current per-container metrics straight from cAdvisor
swamp model method run my-cadvisor current-metrics

# Top 20 memory consumers over the last 12 hours from VictoriaMetrics
swamp model method run my-cadvisor top-memory --input hoursBack=12 --input topN=20

# Tear down the container and remove the scrape config
swamp model method run my-cadvisor remove
```

## Resources

- `status` — cAdvisor deployment status (running, container status, port, scrape
  configured, timestamp).
- `current` — current container metrics (per-container memory MB/percent, CPU
  percent, network RX/TX MB/s) plus totals.
- `topMemory` — top memory consumers over time (current/max/avg MB, growth MB
  and percent) for the requested lookback window.

## License

MIT — see [LICENSE.md](LICENSE.md).
