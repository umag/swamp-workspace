---
name: optchat
description: >
  Talk to a never-ending chat agent with tree memory via the @magistr/optchat
  swamp model (Victor Taelin's OptChat / UniiChat design): every message is
  logged forever, a cheap model compresses the log into a binary tree of
  512-byte lines, and each turn sees a 64-128 KB view of the whole chat and
  zooms into lines for detail. Send a turn, import notes, compact the tree,
  render the view, zoom into a line, read status and per-turn cost. Triggers on
  "optchat", "unii", "never-ending chat", "chat that never ends", "ask unii",
  "tell unii", "tree memory", "zoom the chat", "compact the chat", "chat view",
  "import notes into the chat". Do NOT use for Claude Code session transcripts
  (use claude-sessions) or for one-off LLM calls with no memory.
---

# OptChat

One chat that never ends. The `@magistr/optchat` model owns a chat directory
(`chatDir`): an append-only log (`main/*.jsonl`), the summary tree
(`tree/*.jsonl`) and the saved view (`view.json`). Turns and compactions run
through the local `claude -p`, so the machine needs an authenticated `claude`
and `deno` (for the zoom/date MCP server).

## Send a turn

Prefer the workflow (run record, provenance):

```bash
swamp workflow run optchat-turn --input message="What did we decide about the NAS?"
```

Bare form, for one-off diagnostics:

```bash
swamp model method run <instance> turn --input message="..."
```

Read the reply and what the turn cost:

```bash
swamp data query 'modelName == "<instance>" && name == "turn"' --select content
```

The record holds `reply`, `messageIds`, `toolCalls`, `costUsd`, `usage`
(`cache_read_input_tokens` shows the prefix cache working), `viewBytes`, and the
compactions before and after (`before`, `after`).

A turn first summarizes every earlier message (`before`), so the view has no
`(not summarized yet)` lines; after the reply it compacts the new messages
(`after`) unless `compactAfter=false`.

## Other methods

| Method    | Use                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `append`  | Log `text` with no model call. `kind`: `note` (memory from before the chat), `work` (a report, start it with `[Name]`), `user` |
| `compact` | Build every ready tree node (≤ `concurrency` calls at once). `maxCalls` caps a run. Failed nodes retry next run                |
| `view`    | The exact `<chat>…</chat>` view the next turn will see                                                                         |
| `zoom`    | `id`, `n`: the two halves of line `id+n`; `n=1` gives the message whole                                                        |
| `status`  | Messages, nodes, pending nodes, view bytes, lines per level, `merging`                                                         |

## Reading the view

Each line is `id+n|text`: the `n` messages from `id` on. `n` is a power of 2 and
`id` a multiple of `n`. Recent lines cover 1 message, older lines more. Zoom
into `id+n` with `zoom id=<id> n=<n>`; zoom with `n=1` for the raw message.

## Configuration (globalArguments)

- `chatDir` (required) — `~/` expands to `$HOME`.
- `agentName` (`Unii`), `userInstructions` (appended to the system prompt — put
  who the user is and how they work here, never in a message).
- `turnModel` (`opus`), `turnEffort`, `compactModel` (`haiku`), `compactEffort`
  (`xhigh`).
- `turnTools` — built-in Claude Code tools for the user's tasks (default
  read-only: Read, Glob, Grep, WebSearch, WebFetch). Add `Bash`, `Write`, `Edit`
  only on purpose. `workDir` sets the turn's working directory.
- View sizes: `viewHighBytes`/`viewLowBytes` (128000/64000),
  `compactHighBytes`/`compactLowBytes` (32000/16000).

## Gotchas

- One writer per chat: methods take a lock file `chatDir/.lock`. A crashed run
  leaves it; it is taken over after `lockStaleMinutes` (60), or delete it once
  nothing runs.
- Never edit or delete lines in `main/` or `tree/`, and never delete
  `view.json`: a rebuilt view differs from the live one and loses the cache. The
  model refuses a log with a gap in message ids.
- Not implemented from the gist: messages sent while a turn runs, subagents
  (`zoom("Name")`), images in zoom, explicit cache marks (Claude Code places its
  own under `claude -p`).
