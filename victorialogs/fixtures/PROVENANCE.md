# Fixture provenance

Every JSON file in this directory is **pure doc-derived synthetic data**,
hand-authored from the published
[VictoriaLogs LogsQL / HTTP query API documentation](https://docs.victoriametrics.com/victorialogs/querying/)
and the shapes `victorialogs.ts` already maps (`_time`, `_msg`,
`container_name`, `_stream`). No file here was captured from a live call. This
mirrors the `porkbun`/`pihole` precedent (synthetic fixtures, no live capture)
and is a deliberate security decision, not an oversight.

## What was NOT done (standing prohibition)

A live `vlogs-unraid` (`@magistr/victorialogs`) model instance **does exist** in
this homelab (the canary seed for the eventual Phase C `canary:` workflow).
**Live capture from that instance is FORBIDDEN** for this fixture corpus — not
"not done this time", but a standing rule for anyone regenerating these fixtures
later:

- No `swamp model method run vlogs-unraid <method>` call was made while
  authoring these fixtures.
- No real homelab container name, hostname, or IP address appears anywhere below
  — not in a structured `container_name` field, and not embedded inside a
  free-text `_msg` message body either (log messages are free text, so the leak
  surface here is larger than a structured API like porkbun's DNS records; see
  "Fixture-leak discipline" below).
- The `docker ps` / ssh output consumed by `container-log-status` in the test
  suites (`getRunningContainers`'s stdout) is likewise entirely synthesized
  inline in the test files, never captured from the real `root@<unraid-host>`
  session.

The fixtures-secret-scan test in
`../extensions/models/victorialogs_adversarial_test.ts` is a **mechanical
backstop**, not the primary control — the primary control is this prohibition
plus never running a live call in the first place.

## Fixture-leak discipline (doubled — this is a LOGS extension)

Unlike a structured DNS/API response, a log line's `_msg` field is arbitrary
free text, so a real container or hostname could leak through a message body
even if the structured `container_name` field is clean. This corpus enforces
**two** independent controls, both exercised by the fixtures-secret-scan:

1. **Synthetic-name ALLOWLIST (primary).** Every container name used anywhere in
   these fixtures — structured `container_name` fields AND any name-shaped token
   inside a `_msg` string — matches the strict pattern
   `^svc-(alpha|beta|gamma|delta)$`. Hostnames used anywhere match
   `*.example.test` (RFC 2606) or are RFC 5737 documentation IP addresses
   (`192.0.2.0/24` TEST-NET-1, `198.51.100.0/24` TEST-NET-2, `203.0.113.0/24`
   TEST-NET-3).
2. **Real-homelab-name DENYLIST (defense-in-depth).** The scan additionally
   greps every string leaf (via a recursive walk, mirroring porkbun's
   `collectStrings`) against a curated list of real container/extension/host
   names from this homelab (`gonic`, `immich`, `traefik`, `transmission`,
   `headphones`, `dawarich`, `homeassistant`, `pihole`, `grafana`, `prometheus`,
   `victoriametrics`, `vmalert`, `mongodb`, `mikrotik`, `unifi`, `kaiten`,
   `kandev`, `.aopab.art`, `192.168.88.`, ...) plus a sanity anti-vacuity test
   proving the scanner actually flags an injected real name / secret shape (a
   scan that can never fail is worthless).

Only synthetic values appear below:

- Container names: `svc-alpha`, `svc-beta`, `svc-gamma` (the fourth allowlist
  slot, `svc-delta`, is reserved for adversarial-suite hostile-input tests that
  are not committed as fixture files).
- Hosts: `vlogs.example.test` (the `GLOBAL_ARGS.host` used across every test
  file), `db.example.test` (embedded in one `_msg` line to exercise a
  hostname-shaped token inside free text).
- IPs: `203.0.113.5` — TEST-NET-3 (RFC 5737), embedded in one `_msg` line to
  exercise an IP-shaped token inside free text.
- Timestamps: `2026-06-01T00:0X:XX.XXXZ` — synthetic, sequential, no correlation
  to any real incident.

## Per-file mapping to the method / wire shape it pins

| File                   | Pins                                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query.json`           | Raw VictoriaLogs NDJSON rows for `query` — pins the `_time`/`_msg`/`container_name` mapping and the `_stream` (not `stream`) drop (P7).                                                                                                      |
| `stats.json`           | Generic `                                                                                                                                                                                                                                    |
| `container-stats.json` | `stats by (container_name) count() as total` rows shared by `container-log-status`'s logging-set query and `compare-periods`'s baseline/comparison windows. `total` is a wire STRING, pinning the `parseInt()` conversion.                   |
| `error-lines.json`     | Raw log rows for `error-summary`: 6 `svc-alpha` entries (pins the 5-sample cap while `count` stays 6), one `svc-beta`, one `svc-gamma`, and one row with neither `container_name` nor a compose-service label (pins the `"unknown"` bucket). |

## A documented API quirk this corpus deliberately preserves

VictoriaLogs' `| stats ...` pipe serializes aggregate values (e.g. `total`) as
**wire strings** (`"total": "1024"`), not JSON numbers. `victorialogs.ts` calls
`parseInt(e.total)` at the two call sites that surface a count
(`container-log-status`'s `logging[].count`, `compare-periods`'s
baseline/comparison maps) — this corpus's `container-stats.json` keeps `total`
as a string specifically so the contract-fixture suite can pin that conversion,
and so a fixture that "helpfully" pre-converts `total` to a number never masks a
real wire-format assumption.
