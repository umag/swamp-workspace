# @magistr/optchat

One chat that never ends —
[Victor Taelin's OptChat / UniiChat
design](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
as a swamp model.

- Every message is logged word for word, forever, in an append-only chat
  directory.
- A cheap model (Haiku at xhigh effort) compresses the log into a binary tree of
  one-line summaries of at most 512 bytes. Two adjacent lines merge into one,
  two of those merge again, and so on.
- Each turn is a fresh call that sees the **view**: lines covering the whole
  chat, fine when recent and coarse when old, 64-128 KB in all — then the new
  message.
- When a line is too vague, the agent **zooms**: it opens the line into the two
  lines it was made from, down to the message itself.

Turns and compactions run through the local `claude -p` (your Claude Code
subscription — no API key). The agent's `zoom` and `date` tools are served over
a bundled stdio MCP server.

## Quick start

```bash
swamp extension pull @magistr/optchat
swamp model create @magistr/optchat unii \
  --global-arg chatDir=~/.local/share/optchat/unii \
  --global-arg userInstructions="I am a DevOps engineer in Utrecht."

swamp model method run unii append --input kind=note \
  --input text="The NAS is an Unraid box at nas.example.lan."
swamp model method run unii turn --input message="Where is the NAS?"
swamp data query 'modelName == "unii" && name == "turn"' --select content
```

Requirements on the machine that runs the methods: an authenticated `claude` CLI
and `deno` on `PATH` (or set `claudeBin` / `denoBin`).

## Methods

| Method    | What it does                                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn`    | Summarizes every earlier message, calls the turn model with `[system] [view] [now] [message]` in a fresh conversation, logs each reply, tool call and tool result, then compacts. |
| `compact` | Builds every ready tree node, up to `concurrency` (8) calls at once. Idempotent: a node is built once; a failed node is retried on the next run.                                  |
| `append`  | Logs `note`, `work` or `user` text with no model call.                                                                                                                            |
| `view`    | Renders the view the next turn will see.                                                                                                                                          |
| `zoom`    | Opens line `id+n` into its two halves, or message `id` whole when `n = 1`.                                                                                                        |
| `status`  | Messages, built and pending nodes, view bytes, lines per level.                                                                                                                   |

## The chat directory

```
main/YYYY-MM-DD.jsonl   messages {i, kind, text, size, date}
tree/YYYY-MM-DD.jsonl   tree nodes {l, i, text, size}
view.json               {T, chat, compact, merging}, lines as [l, i]
.lock                   held by the one process that writes
```

Message kinds: `user`, the agent's name lowercased (`unii`) for its replies,
`tool` (name and JSON input), `echo` (tool results, clipped to 30,000 characters
head+tail), `work`, `note`. Thoughts are never logged. Any other long text is
never cut: it spans several messages in a row.

## How the view merges

Which lines merge comes from Taelin's rollback `push` (a binary counter). For
sibling lines `(l, i)` and `(l, i+1)` in a chat of `T` messages:

```
due = (T + 1) / 2^l - i        // (T - last) / 2^l, shifted by 2
```

The most due pair whose parent is built merges first, oldest first on ties. With
push's list length as the budget this reproduces push exactly — the property
suite checks it for t = 0..20,000. **When** they merge: each message appends one
line; once the view passes 128 KB one batch merges it down to 64 KB (continuing
at each message while parents are still unbuilt). Between batches the view only
grows at its end, so the previous call's view is a prefix of the next. A
3,000-message simulation gives a 64-128 KB sawtooth averaging 96.6 KB, about 20
lines per level, and about 2 rewritten lines per message.

Compactions see their own view, the chat's view merged further to 16-32 KB, up
to the node and only through built lines.

## Differences from the gist

- No messages handed to a running turn: each turn is one method run holding the
  chat lock.
- No subagents (`zoom("Name")`) and no images in zoom.
- Cache marks are Claude Code's own under `claude -p`; the system prompt and
  tools still never change, so the prefix stays cacheable. `turn` records
  `usage.cache_read_input_tokens` so you can measure it.
- Frame tags (`<chat>`, `<input>`) inside logged text are shown as `‹chat›` in
  the view and compaction inputs, so a message can't close the block it sits in.
  The log keeps the original.

## Safety

`turnTools` defaults to read-only tools (Read, Glob, Grep, WebSearch, WebFetch).
Adding `Bash`, `Write` or `Edit` lets the agent change files in `workDir`
without asking. Compactions get no tools. User settings, hooks and other MCP
servers are kept out of every call (`--setting-sources ""`,
`--strict-mcp-config`, `--no-session-persistence`).
