# @magistr/fc-task-server

A host↔guest **task/result control-plane** for Claude Code agents running inside
[Firecracker](https://github.com/umag/swamp-workspace/tree/main/firecracker)
microVMs, for [swamp](https://github.com/swamp-club/swamp).

This is **not an internet proxy.** The guest reaches `api.anthropic.com`
directly via its TAP interface and host NAT. This model only moves the _job_ in
and the _result_ out: it deploys a tiny Python TCP HTTP server on the host's TAP
interface that

- serves the per-run job on `GET /task` — prompt, optional git repo, optional
  model id, and the `CLAUDE_CODE_OAUTH_TOKEN` (validated `sk-ant…` prefix and
  injected only at serve time, so it never sits in a file the guest can scrape),
  and
- collects the agent's stdout on `POST /result`.

The token is supplied via `globalArguments` (mark it sensitive / source it from
a vault) and is never written to the task file — it is merged into the response
body the moment the guest fetches `/task`.

## Install

```bash
swamp extension pull @magistr/fc-task-server
```

## Configure

| Argument     | Required | Default      | Description                                 |
| ------------ | -------- | ------------ | ------------------------------------------- |
| `host`       | yes      | —            | SSH host running Firecracker                |
| `user`       | no       | `root`       | SSH username                                |
| `tapIp`      | no       | `172.16.0.1` | Host IP on the TAP interface (server binds) |
| `tapPort`    | no       | `8080`       | TCP port for the task/result server         |
| `oauthToken` | yes      | —            | Claude Code OAuth token (`sk-ant…`)         |

```bash
swamp model create @magistr/fc-task-server fc-tasks
swamp model edit fc-tasks --json <<EOF
{ "host": "firecracker.example.com",
  "tapIp": "172.16.0.1",
  "tapPort": 8080,
  "oauthToken": "\${{ vault.get(claude, OAUTH_TOKEN) }}" }
EOF
```

## Run a task

```bash
# 1. Start the server on the host TAP interface
swamp model method run fc-tasks deploy

# 2. Queue a prompt (served on the next guest GET /task)
swamp model method run fc-tasks inject_task \
  --input prompt="Summarise the README in this repo" \
  --input model=claude-opus-4-8

# 3. Block until the guest POSTs its result (or times out)
swamp model method run fc-tasks collect_result --input timeoutSeconds=600

# 4. Tear the server down
swamp model method run fc-tasks stop
```

Typically driven by the `@magistr/fc-run-agent` workflow, which sequences
`deploy → restore snapshot → inject_task → collect_result` and always runs
`stop` in cleanup.

## Methods

- `deploy` — write `tap-server.py` to the host and start it; waits for the port
  to bind before returning.
- `inject_task` — queue the next job (`prompt`, optional `gitRepoUrl`, optional
  `model`).
- `collect_result` — poll for the guest's `POST /result`; blocks until a result
  arrives or `timeoutSeconds` elapses.
- `stop` — precision-kill the server via its PID sidecar.

## License

MIT — see [LICENSE.md](LICENSE.md).
