# @magistr/victorialogs

Query a [VictoriaLogs](https://docs.victoriametrics.com/victorialogs/) HTTP
endpoint from swamp. Run raw
[LogsQL](https://docs.victoriametrics.com/victorialogs/logsql/) queries,
field/stream statistics, and hits-over-time analytics, then persist the results
as swamp model data for downstream CEL wiring and reports.

## What it does

The `@magistr/victorialogs` model wraps the VictoriaLogs `/select/logsql/query`
API. It is read-only against the logs store; the `container-log-status` method
additionally runs `docker ps` over SSH (as `root@<host>`) to reconcile which
running containers are actually shipping logs.

### Methods

- **`query`** — run a LogsQL expression and return matching entries (time,
  container, message, stream). Args: `logsql` (default `*`), `start` (default
  `-24h`), optional `end`, `limit` (default `100`).
- **`stats`** — run a LogsQL query that contains a `| stats ...` pipe and return
  the aggregation rows. Args: `logsql`, `start`, optional `end`.
- **`container-log-status`** — compare currently running Docker containers
  against those emitting logs in the window, surfacing silent/broken pipelines.
  Args: `start` (default `-1h`), optional `end`.
- **`error-summary`** — collect error/fatal/panic/killed/OOM/exception lines and
  group them by container with sample messages. Args: `start` (default `-24h`),
  optional `end`.
- **`compare-periods`** — diff per-container log volume between a baseline and a
  comparison window, classifying each as `GONE`, `MOSTLY_SILENT`, `NEW`,
  `MUCH_MORE_ACTIVE`, or `NORMAL`. Args: `baseline_start`, `baseline_end`,
  `compare_start`, optional `compare_end`.

## Configuration

The model takes two global arguments:

- `host` — VictoriaLogs host (IP or hostname), required.
- `port` — VictoriaLogs HTTP port (default `9428`).

Create a model instance:

```yaml
type: "@magistr/victorialogs"
typeVersion: "2026.05.25.1"
name: victorialogs
version: 1
tags: {}
globalArguments:
  host: "victorialogs.example.com"
  port: 9428
methods: {}
```

## Usage

```bash
# Run a LogsQL query for the last hour
swamp model method run victorialogs query \
  --input logsql='_msg:error' --input start='-1h' --input limit=50

# Aggregate log counts by container
swamp model method run victorialogs stats \
  --input logsql='* | stats by (container_name) count() as total'

# Detect containers that are running but not logging
swamp model method run victorialogs container-log-status --input start='-1h'

# Summarize errors by container over the last day
swamp model method run victorialogs error-summary --input start='-24h'

# Compare a baseline window against the last two hours
swamp model method run victorialogs compare-periods \
  --input compare_start='-2h'
```

Each method writes a swamp data artifact. Read it back with `swamp data` or
reference it from other models via CEL, e.g.
`data.latest("victorialogs", "queryResult").attributes.entries`.
