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
# set globalArguments: sshHost do.aopab.art, bindAddress 192.168.100.4,
#   logsEndpoint http://192.168.88.242:9428/insert/elasticsearch/
swamp model method run do-observability install
swamp model method run do-observability configure
swamp model method run do-observability status
```
