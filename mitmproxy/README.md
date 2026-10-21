# @magistr/mitmproxy

Install, run and inspect a local [mitmproxy](https://mitmproxy.org) from swamp.
The proxy runs in the background (headless `mitmdump` or the `mitmweb` browser
UI). Every flow is streamed to a capture file, and you query it with mitmproxy
filter expressions.

## Methods

| Method        | What it does                                                        |
| ------------- | ------------------------------------------------------------------- |
| `install`     | `uv tool install --no-build mitmproxy`: prebuilt wheels, no compile |
| `status`      | Installed version, pid, listener, mitmweb URL, CA fingerprint/trust |
| `start`       | Launch the proxy detached; no-op if it is already running           |
| `stop`        | SIGTERM, then SIGKILL after a grace period; no-op if stopped        |
| `flows`       | Summarise captured flows (method, URL, status, size, timing)        |
| `clear_flows` | Delete the capture file (proxy must be stopped)                     |
| `trust_ca`    | Trust the CA in the macOS login keychain (asks for your password)   |

## Setup

```bash
swamp extension pull @magistr/mitmproxy
swamp behavior create @magistr/mitmproxy mitm
swamp behavior run mitm install
swamp behavior run mitm start
```

Point a client at the proxy and read back what it captured:

```bash
curl -x http://127.0.0.1:8080 https://example.com/
swamp behavior run mitm flows --input filter='~d example.com' --input limit=20
swamp data query 'behavior("mitm") && name == "flows"' --select content
```

## Global arguments

| Argument     | Default           | Notes                                              |
| ------------ | ----------------- | -------------------------------------------------- |
| `listenHost` | `127.0.0.1`       | Proxy bind address                                 |
| `listenPort` | `8080`            | Proxy port                                         |
| `mode`       | `regular`         | `socks5`, `upstream:URL`, `reverse:URL`, …         |
| `ui`         | `dump`            | `web` runs mitmweb; the tokenised URL is in status |
| `webPort`    | `8081`            | mitmweb UI port                                    |
| `options`    | `{}`              | Extra `--set key=value`, e.g. `ignore_hosts`       |
| `confdir`    | `~/.mitmproxy`    | CA certificates                                    |
| `stateDir`   | `<confdir>/swamp` | pid, log and `flows.mitm`; one per instance        |
| `binDir`     | `~/.local/bin`    | Where `mitmdump`/`mitmweb` live (else `PATH`)      |

## HTTPS

mitmproxy creates its CA in `confdir` the first time it starts. Run `trust_ca`
to trust it system-wide on macOS. You can also pass
`--cacert ~/.mitmproxy/mitmproxy-ca-cert.pem` to a single client.

## Notes

- Restarts append to the capture file. Run `clear_flows` to start fresh.
- `flows` converts the capture to HAR with `mitmdump --set hardump=…`, so an
  invalid filter expression fails with mitmproxy's own error message.
