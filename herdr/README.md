# @magistr/herdr

Drive a [herdr](https://herdr.dev) terminal-agent runtime from swamp.

herdr is a terminal multiplexer built for AI coding agents. A background server
owns persistent workspaces → tabs → panes, recognises the agent running inside
each pane (Claude Code, Codex, opencode, …), tracks whether it is `idle` /
`working` / `blocked`, and exposes the whole tree over a local Unix socket.
Detach, close the laptop lid, reboot — the layout and the agents come back.

That state is exactly what you want in swamp: _which agents are running, what
are they doing, which one is stuck, and what should they do next._ This model
turns the fleet into queryable resources and re-runnable methods.

## Install

```bash
swamp extension pull @magistr/herdr
swamp model create @magistr/herdr fleet
swamp model method run fleet status
```

The `herdr` binary must be on `PATH` (or point `binary` at it). By default
everything runs against the local socket — no network, no API key, no vault. Set
`sshHost` to point the same model at a herdr server on another machine.

## Global arguments

| Argument          | Default  | Meaning                                                  |
| ----------------- | -------- | -------------------------------------------------------- |
| `binary`          | `herdr`  | Executable; a bare name is resolved on `PATH`            |
| `session`         | `""`     | Named session (`HERDR_SESSION`); empty = the default one |
| `socketPath`      | `""`     | Explicit socket (`HERDR_SOCKET_PATH`)                    |
| `timeoutMs`       | `30000`  | Wall-clock cap for a single herdr invocation             |
| `maxOutputBytes`  | `262144` | Cap on captured terminal text per read                   |
| `sshHost`         | `""`     | Drive a herdr on this host over ssh; empty = local       |
| `sshUser`         | `""`     | ssh user; empty lets ssh resolve it from ~/.ssh/config   |
| `sshPort`         | `0`      | ssh port; 0 uses ssh's default                           |
| `sshIdentityFile` | `""`     | Key for `ssh -i`; empty uses the agent/ssh config        |
| `sshExtraArgs`    | `[]`     | Extra ssh args, placed first so they take precedence     |
| `remoteBinary`    | `""`     | herdr executable on the remote host; empty reuses binary |

An empty `session` is never exported as an empty variable — herdr would read
that as a session literally named `""`.

## Methods

### Observe

| Method     | What it does                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`   | Client/server versions, protocol compatibility, socket, named sessions. A stopped server reports `serverRunning: false` rather than failing. |
| `snapshot` | The whole session in ONE socket round-trip → a `fleet` roll-up plus one `agent` resource per agent                                           |
| `read`     | Capture a pane's or agent's output — the visible screen, the scrollback tail, or the classifier's detection buffer                           |

### Drive

| Method        | What it does                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| `prompt`      | Submit a prompt to one or many agents, optionally waiting for each to settle    |
| `wait-agent`  | Block until agents reach a state (`idle`, `blocked`, `done`, …)                 |
| `start-agent` | Launch an agent of a given kind in a pane                                       |
| `send-keys`   | Key presses (`enter`, `esc`, `ctrl+c`, `shift+tab`, `f1`, …) to panes or agents |
| `send-text`   | Type literal text without submitting it                                         |
| `run-command` | Type a shell command and submit it with Enter                                   |
| `wait-output` | Block until a pane's output matches a literal string or a regex                 |

### Shape

| Method             | What it does                                                            |
| ------------------ | ----------------------------------------------------------------------- |
| `create-workspace` | A labelled workspace — reused if the label already exists               |
| `create-tab`       | A labelled tab in a workspace — reused if the label already exists      |
| `split-pane`       | Split a pane right or down, with an optional ratio, cwd and environment |
| `create-worktree`  | Cut a Git worktree and open it in its own workspace                     |
| `close`            | Close a workspace, tab or pane                                          |
| `notify`           | Raise a herdr toast on the attached client                              |

### Server and sessions

| Method                   | What it does                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- |
| `server-stop`            | Stop the server; already-stopped is a no-op                                  |
| `server-reload-config`   | Validate config.toml, then reload it in the running server                   |
| `server-live-handoff`    | Hand live panes to a freshly started server (the in-place upgrade mechanism) |
| `agent-manifests`        | Report the agent-detection manifests in force — read-only                    |
| `update-agent-manifests` | Fetch newer manifests and name exactly which agents moved                    |
| `reload-agent-manifests` | Reload manifests from disk, then read the state back                         |
| `session-stop`           | Stop a named session; unknown or already-stopped is a no-op                  |
| `session-delete`         | Delete a named session; a running one is refused unless forced               |

## Driving a herdr on another host

Set `sshHost` and the entire model — all 24 methods — targets that host's herdr
instead of the local one. Nothing else about the interface changes:

```bash
swamp model create @magistr/herdr build-box
# then set sshHost / sshUser in models/@magistr/herdr/<uuid>.yaml
swamp model method run build-box snapshot
swamp model method run build-box prompt \
  --args '{"targets":["w1:p2"],"text":"status?"}'
```

`ssh` runs with `BatchMode=yes` and `ConnectTimeout=10`, so an unattended swamp
run fails fast instead of hanging on a password prompt. Anything in
`sshExtraArgs` is placed _before_ those defaults — ssh keeps the first value it
obtains for an option, which is what lets you override them.

Two things worth understanding about the remote path:

**Quoting is load-bearing.** Locally, arguments reach herdr through argv and no
shell ever sees them. Over ssh there is always a login shell on the far side, so
every argument is POSIX single-quoted — with no "looks safe, skip it" fast path,
because that predicate is where quoting bugs live. The property suite proves the
round trip through a real `/bin/sh`.

**The self guard switches off.** `HERDR_PANE_ID` names a pane on the _local_
server, and herdr numbers panes per session — so a local `w1:p4` and a remote
`w1:p4` are unrelated panes that happen to share a string. Against a remote
target there is no "self": `close` will close `w1:p4` and `prompt` will prompt
it. The guards below apply to local instances only, which is exactly where the
danger is.

## Two properties worth knowing

**Every mutating method reads herdr's state first.** `close` on an id that is
already gone is a recorded no-op instead of `workspace_not_found`;
`create-workspace` / `create-tab` / `create-worktree` return the existing
container when the label or branch already matches; `start-agent` leaves a pane
that already hosts an agent running. Re-running a method is safe, which is what
makes these usable as workflow steps.

**It is safe to run from inside the fleet it manages.** swamp normally executes
in a herdr pane, so the model reads herdr's own `HERDR_PANE_ID` / `HERDR_TAB_ID`
/ `HERDR_WORKSPACE_ID`:

- `close` refuses to close the pane, tab or workspace hosting the caller
  (override with `force`);
- `prompt` skips the caller's own pane (override with `includeSelf`) — an agent
  that prompts itself waits on its own turn forever.

## Fan-out, not loops

Methods that address agents take a `targets` array and run in a single method
execution — one model lock, one `action` resource:

```bash
# Ask every agent in the fleet for a status line, in one run.
swamp model method run fleet prompt \
  --args '{"targets":["w1:p2","w1:p5","w2:p1"],"text":"one-line status?","wait":true,"until":["idle"]}'
```

A failing target does not abort the run: it becomes an `ok: false` row with
herdr's own error code in `detail`, and the surviving targets still execute. Set
`failFast` to abort instead. If _every_ target fails, the method throws and
writes nothing — a run where nothing succeeded must not leave data behind for
the next CEL expression to read.

## Typical use

Snapshot the fleet, then query it:

```bash
swamp model method run fleet snapshot
swamp data query 'modelName == "fleet" && specName == "agent" && attributes.status == "blocked"' \
  --select 'name + " " + attributes.terminalTitle' --json
```

Wire it together with CEL — nudge whatever is idle:

```yaml
steps:
  - name: snapshot
    model: fleet
    method: snapshot
    dependsOn: []
    weight: 0
  - name: nudge-idle
    model: fleet
    method: prompt
    dependsOn: [snapshot]
    weight: 0
    inputs:
      targets: ${{ data.latest("fleet", "fleet").attributes.agents.filter(a, a.status == "idle").map(a, a.paneId) }}
      text: "anything blocking you?"
```

Spin up an isolated branch with its own agent:

```bash
swamp model method run fleet create-worktree \
  --args '{"cwd":"/home/dev/project","branch":"fix/crash","base":"main","label":"fix-crash"}'
swamp model method run fleet start-agent \
  --args '{"pane":"w4:p1","kind":"claude","name":"crash-fix"}'
```

Both are idempotent: the worktree is opened rather than recreated, and the pane
keeps its existing agent.

## Resources

| Resource    | Written by                              | Holds                                                               |
| ----------- | --------------------------------------- | ------------------------------------------------------------------- |
| `status`    | `status`                                | Client/server health, protocol, socket, sessions, degradation notes |
| `fleet`     | `snapshot`                              | Workspaces, tabs, pane count, per-state agent histogram, agent rows |
| `agent`     | `snapshot`, `start-agent`               | One agent: kind, state, cwd, terminal title, its own session id     |
| `output`    | `read`, `wait-output`                   | Captured terminal text with its pane/tab/workspace ids              |
| `action`    | every fan-out method, `close`, `notify` | Per-target outcome: ok / changed / skipped / failed, with details   |
| `container` | `create-*`, `split-pane`                | A workspace, tab, pane or worktree that was created **or reused**   |
| `manifests` | `agent-manifests`, `*-agent-manifests`  | Per-agent detection-manifest version, source, and rejected copies   |

Each agent row carries `sessionId` — the agent's own session UUID as herdr
reports it — which is the join key back to an agent's transcript store (for
Claude Code, `@magistr/claude-sessions`).

## Safety

The transport is `Deno.Command`, never a shell, so labels, prompts and commands
travel as single literal argv elements: `; rm -rf /` typed into a pane is text,
not a command the model runs. Ids, agent names and key names that start with `-`
are refused before anything is sent, because herdr's own parser would read them
as flags. Captured output is bounded by `maxOutputBytes` so a runaway pane
cannot blow up a swamp run.

## Development

```bash
deno task check      # type-check
deno task test       # 185 tests; never runs herdr, never opens a socket
deno task test:soak  # property suite at a raised FC_NUM_RUNS
deno task lint
```

Wire-format fixtures captured from herdr 0.8.0 (socket protocol 19) live in
`fixtures/`; the contract suite fails there first if a herdr release renames or
moves a field.
