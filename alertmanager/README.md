# @magistr/alertmanager

A swamp model for the
[Prometheus Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/)
v2 HTTP API. It reads what Alertmanager is notifying on right now, its groups
and silences, and manages silences without creating duplicates.

## Setup

```bash
swamp extension pull @magistr/alertmanager
swamp model create @magistr/alertmanager am \
  --global-arg url=http://alertmanager.example:9093
```

`url` may include a path prefix when Alertmanager sits behind a reverse proxy
(`https://example.com/alertmanager`). `timeoutMs` defaults to 15000.

## Methods

| Method           | API call                              | Writes         |
| ---------------- | ------------------------------------- | -------------- |
| `alerts`         | `GET /api/v2/alerts`                  | `alerts`       |
| `groups`         | `GET /api/v2/alerts/groups`           | `groups`       |
| `silences`       | `GET /api/v2/silences`                | `silences`     |
| `status`         | `GET /api/v2/status`                  | `status`       |
| `create-silence` | `GET` + `POST /api/v2/silences`       | `silence-<id>` |
| `expire-silence` | `GET` + `DELETE /api/v2/silence/{id}` | `silence-<id>` |

`alerts` and `groups` default to `active=true, silenced=false,
inhibited=false`,
which is the set of alerts that are notifying now. Pass `silenced: true` or
`inhibited: true` to include muted alerts. `filter` takes Alertmanager matcher
syntax: `alertname="X",severity=~"crit.*",job!="y"`.

```bash
swamp model method run am alerts
swamp model method run am alerts --input filter='severity="critical"'
swamp model method run am create-silence \
  --input matchers='alertname="DiskSpaceWarning",instance="host-a:9100"' \
  --input comment="disk swap scheduled" --input durationMinutes=240
```

Read the result with CEL:

```bash
swamp data query 'modelName == "am" && name == "alerts"' --select content
```

## Idempotency

- `create-silence` first lists silences. If an active or pending silence has the
  same matcher set (in any order) and the same comment, it is reused when it
  already ends at or after the requested end. It is extended in place (same id)
  when it would end sooner. Only otherwise is a new silence created. The written
  resource records `action: created | extended | unchanged`.
- `expire-silence` reads the silence first. An already-expired silence gets
  `action: unchanged` and no `DELETE`.

## Secrets

`GET /api/v2/status` returns the full running config, which can include receiver
credentials (Telegram bot tokens, Slack webhooks, SMTP passwords). The `status`
method stores only `configSha256`, so a config change is still visible as a hash
change without the config text being written to swamp data.

## License

MIT. See [LICENSE.md](LICENSE.md).
