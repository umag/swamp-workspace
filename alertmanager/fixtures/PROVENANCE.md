# Fixture provenance

Every JSON file here is hand-authored from the published
[Alertmanager v2 OpenAPI spec](https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml)
(`gettableAlerts`, `alertGroups`, `gettableSilences`, `alertmanagerStatus`).
None was captured from a live Alertmanager: no real hostname, label value,
receiver name or config text appears in them.

`status.json` deliberately carries a fake `bot_token` in `config.original`. The
contract suite asserts that this string never reaches a stored resource — the
`status` method keeps only a SHA-256 of the config.
