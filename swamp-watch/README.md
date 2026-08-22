# @magistr/swamp-watch

Per-workflow observability for a swamp repo's own scheduled work.

## Why

`swamp serve`'s scheduler is only observable in aggregate. A rule that asks "did
_any_ scheduled workflow fire in the last 6h" is satisfied forever by a single
two-minute workflow, so a workflow that dies — or was never deployed to the
server at all — produces no signal whatsoever. Alerting on log text does not
close the gap either: a rule that needs two identical failures inside 2h is
structurally blind to every daily and weekly schedule.

This model publishes the two facts an alert actually needs, per workflow:

|             |                                               |
| ----------- | --------------------------------------------- |
| **intent**  | what the repo declares via `trigger.schedule` |
| **reality** | when that workflow last actually succeeded    |

## Methods

### `scan`

Reads every workflow declaring a `trigger.schedule`, then its run history, in
one execution. Emits Prometheus exposition on the `scan` resource's `lines`
attribute, ready for `@magistr/victoriametrics` `push`.

| Series                                                         | Meaning                                     |
| -------------------------------------------------------------- | ------------------------------------------- |
| `swamp_workflow_declared{workflow,repo,schedule}`              | this repo declares the schedule             |
| `swamp_workflow_expected_period_seconds{workflow,repo}`        | longest legal gap between two fires         |
| `swamp_workflow_stale_after_seconds{workflow,repo}`            | age at which a missing success should alert |
| `swamp_workflow_last_success_timestamp_seconds{workflow,repo}` | last success seen, `0` if none              |
| `swamp_workflow_last_run_timestamp_seconds{workflow,repo}`     | last run of any status                      |
| `swamp_workflow_runs{workflow,repo,status}`                    | runs by status in retained history          |
| `swamp_watch_scan_timestamp_seconds{repo}`                     | when this scan completed                    |

### `drift`

Probes `server` for every workflow the repo declares and reports which are
missing. This catches a workflow that carries a schedule locally but was never
deployed — something no scheduler-side check can detect, because the server
cannot report the absence of a job it does not have.

Emits `swamp_workflow_present_on_server{workflow,repo,server}` (`1`/`0`) and
`swamp_watch_drift_missing{repo,server}`.

## Alerting

Because run history is retained for only about a day, this model keeps **no**
last-success state. Each scan pushes what it can see (`0` when it sees nothing)
and the alert reads it back through `max_over_time`, so the time-series database
is the memory — and a scan that stops running cannot erase what it already
reported.

```yaml
- alert: SwampWorkflowStale
  expr: |
    (
      time() - max_over_time(swamp_workflow_last_success_timestamp_seconds{repo="serve"}[30d])
        > max_over_time(swamp_workflow_stale_after_seconds{repo="serve"}[30d])
    )
    and
    (
      time() - min_over_time(swamp_watch_observed_timestamp_seconds{repo="serve"}[30d])
        > max_over_time(swamp_workflow_stale_after_seconds{repo="serve"}[30d])
    )
  for: 5m

- alert: SwampWorkflowNotDeployed
  expr: swamp_workflow_present_on_server == 0
  for: 10m
```

## Design notes

**Staleness budgets come from the longest gap a cron can produce, not its
average.** `0 9,20 * * *` fires twice a day but legally goes 13h between fires;
a budget built on 12h pages every single night.

**History is read per workflow, not from one global search.** The global history
response is capped, and a two-minute workflow emits enough records to push every
daily and weekly run out of the window.

**Intent can only be read from a repo directory.** `swamp workflow list` accepts
no `--server`, and `workflow get --server` omits the `trigger` field, so a
server's registered schedules are not obtainable over the wire. That asymmetry
is why `scan` takes a `repoDir` even when history comes from a server, and why
`drift` exists at all.

**A failed history read does not drop the workflow.** Dropping it would take its
series with it and silence the very alert this model exists to raise; the error
is recorded on the workflow's entry instead.

### Why the alert has two halves

The first half is "no success within the budget". The second is "we have been
watching this workflow for longer than the budget".

Both are needed because run history is retained for about a day, so on the very
first scan a perfectly healthy _weekly_ workflow has no visible success — its
last one was evicted days ago. Without the second half every weekly and monthly
schedule would page the moment this model was switched on, which is precisely
the kind of alert people learn to ignore.

`swamp_watch_observed_timestamp_seconds` is pushed on every scan;
`min_over_time` over the window recovers when observation actually began. A
never-deployed daily workflow still alerts, just one budget later — and `drift`
catches that case immediately anyway, without waiting.

## Usage

Define an instance pointing at the repo whose declared schedules you want to
publish. `repoLabel` becomes the `repo` label on every series, so a laptop and a
server can both report without colliding.

```yaml
# models/@magistr/swamp-watch/watch-serve.yaml
type: "@magistr/swamp-watch"
typeVersion: 2026.08.21.1
name: watch-serve
globalArguments:
  repoDir: /workspace
  repoLabel: serve
  swampBinary: swamp
methods: {}
```

To publish from a laptop while reading the _server's_ run history, add `server`
(and `token` if the server requires one):

```yaml
globalArguments:
  repoDir: /Users/you/repo
  repoLabel: mac
  server: https://swamp.example.com
```

Run the two methods and ship what they produce:

```bash
swamp model method run watch-serve scan
swamp model method run watch-serve drift

swamp data get watch-serve scan-current  --json | jq -r '.content.lines'
swamp data get watch-serve drift-current --json | jq -r '.content.missing'
```

### Wiring it to VictoriaMetrics

`scan` and `drift` do not push. They write exposition to their resource's
`lines` attribute, and a workflow step hands that to `@magistr/victoriametrics`
`push` — so the push endpoint stays configured in one place rather than
duplicated here.

```yaml
jobs:
  - name: publish
    dependsOn: []
    weight: 0
    steps:
      - name: scan
        dependsOn: []
        weight: 0
        task:
          type: model_method
          modelIdOrName: watch-serve
          methodName: scan
          inputs: {}
      - name: push
        dependsOn:
          - step: scan
            condition:
              type: succeeded
        weight: 0
        task:
          type: model_method
          modelIdOrName: vm-unraid
          methodName: push
          inputs:
            lines: ${{ data.latest("watch-serve", "scan-current").attributes.lines }}
```

Run it at least as often as your shortest staleness budget allows — for a
two-minute workflow that budget is 32 minutes, so a 10-minute cadence leaves
plenty of room.

### Reading the output

```
$ swamp model method run watch-mac scan
13 scheduled workflows
  fleet-health         */2 * * * *     period    120s   budget   1920s
  daily-health         0 9,20 * * *    period  46800s   budget  70200s
  eod-steward-monthly  30 19 1 * *     period 2678400s  budget 4017600s
pushed: 106 lines, 9 metric families, HTTP 204
```

`daily-health` fires twice a day, and its period is 46800s — 13 hours, the
longer of its two legs — not the 43200s a naive "twice daily" reading gives.

## Global arguments

| Argument          | Default  | Purpose                                                   |
| ----------------- | -------- | --------------------------------------------------------- |
| `repoDir`         | `.`      | repository to read declared workflows from                |
| `repoLabel`       | `local`  | value of the `repo` label on every series                 |
| `swampBinary`     | `swamp`  | path to the swamp CLI                                     |
| `server`          | —        | serve URL to read run history from; omit for a local read |
| `token`           | —        | server token, used only with `server`                     |
| `graceFactor`     | `0.5`    | extra budget as a fraction of the longest gap             |
| `minGraceSeconds` | `1800`   | floor on the extra budget                                 |
| `concurrency`     | `2`      | concurrent server probes during `drift`                   |
| `retryBackoffMs`  | `1500`   | pause before re-probing after a non-404 failure           |
| `timeoutMs`       | `120000` | per-CLI-call timeout                                      |

## Limitations

- **`drift` costs one server round trip per declared workflow.** There is no
  bulk endpoint, because `workflow list` takes no `--server`. Against 84
  workflows at concurrency 2 that is roughly a minute.
- **Only 5-field cron expressions are supported.** Nicknames like `@daily` are
  reported as having no budget rather than guessed at — a wrong budget either
  pages constantly or never pages at all, and both are worse than none.
- **`scan` reports what run history still holds.** It does not reconstruct
  history that swamp has already evicted; the alert's `max_over_time` window is
  what carries a success forward.
