# @magistr/observability-agent

Install and configure a host-native metrics + logs agent on a remote
Debian/Ubuntu host over SSH, for a **VictoriaMetrics** (pull) + **VictoriaLogs**
(push via Vector) backend.

One model, three methods. No agent daemon or compose stack on the swamp host —
everything runs over SSH.

## Model: `@magistr/observability/agent`

### Global arguments

| Field           | Default   | Description                                                                                                  |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `sshHost`       | —         | SSH hostname/IP of the target host                                                                           |
| `sshUser`       | `root`    | SSH user                                                                                                     |
| `sshPort`       | `22`      | SSH port                                                                                                     |
| `bindAddress`   | `0.0.0.0` | Address the exporters listen on. **Set to a WireGuard tunnel IP** to keep them off the public interface.     |
| `nodePort`      | `9100`    | node_exporter port                                                                                           |
| `blackboxPort`  | `9115`    | blackbox port                                                                                                |
| `logsEndpoint`  | — (opt)   | VictoriaLogs ES-bulk endpoint, e.g. `http://10.0.0.1:9428/insert/elasticsearch/`. Unset → Vector is skipped. |
| `hostLabel`     | `sshHost` | `host` label on shipped logs                                                                                 |
| `vectorVersion` | `0.46.1`  | Vector `.deb` version from packages.timber.io                                                                |

### Methods

| Method      | Arguments  | What it does                                                                                                                                                                                                                   |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `install`   | —          | apt-installs node-exporter + blackbox-exporter, installs vector from the pinned `.deb`. Idempotent.                                                                                                                            |
| `configure` | `logFiles` | Writes exporter defaults (bound to `bindAddress`), blackbox modules (`http_2xx`/`http_public`/`icmp`), grants blackbox `CAP_NET_RAW`, configures Vector → VictoriaLogs, adds `vector` to `adm`, enables + restarts everything. |
| `status`    | —          | systemd state of all three services + whether each exporter answers on its bound address.                                                                                                                                      |

### Blackbox modules

- `http_2xx` — internal services behind a redirect (accepts 200/204/3xx/401/403,
  no redirect follow).
- `http_public` — end-to-end public probe (follows redirects, must be TLS, wants
  2xx).
- `icmp` — reachability probe (used e.g. agent → home-LAN over a tunnel).

## Home wiring

The home VictoriaMetrics scrapes `bindAddress:9100` and, with the blackbox
relabel pattern, `bindAddress:9115` over the tunnel. Vector pushes logs to
VictoriaLogs. Pair with `@magistr/victoriametrics` for querying and vmalert for
alerting.

## Example

```bash
swamp model create @magistr/observability/agent do-observability
# set globalArguments: sshHost observability-target.example.com, bindAddress 192.0.2.4,
#   logsEndpoint http://192.0.2.42:9428/insert/elasticsearch/
swamp model method run do-observability install
swamp model method run do-observability configure
swamp model method run do-observability status
```

### Instance definition

`bindAddress` is the field worth thinking about: it is what the exporters listen
on, so pointing it at a tunnel address is what keeps them off the public
interface. `logsEndpoint` is optional — leave it unset and `configure` skips
Vector entirely, installing metrics only.

```yaml
type: "@magistr/observability/agent"
typeVersion: "2026.08.01.1"
id: 00000000-0000-0000-0000-000000000000
name: do-observability
version: 1
tags: {}
globalArguments:
  sshHost: observability-target.example.com
  sshUser: root
  bindAddress: 192.0.2.4 # WireGuard tunnel IP, not the public NIC
  logsEndpoint: "http://192.0.2.42:9428/insert/elasticsearch/"
  hostLabel: do-edge
methods: {}
```

`configure` takes the log files to ship, so a re-run with a different list is
how you add or drop a source:

```bash
swamp model method run do-observability configure \
  --input logFiles='["/var/log/syslog","/var/log/nginx/access.log"]'

# then confirm all three services are up and answering
swamp model method run do-observability status --json
```
