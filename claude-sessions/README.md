# @magistr/claude-sessions

Read Claude Code's own session transcripts as swamp data.

Claude Code appends one JSONL transcript per session under
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. In practice that log is
write-only: there is no way to ask _"which of my sessions actually finished?"_
without hand-parsing raw JSON. This model turns those transcripts into queryable
resources, and joins them to the kanban cards created by the `mk-session-card`
hook.

## Install

```bash
swamp extension source add /path/to/claude-sessions   # local development
swamp extension pull @magistr/claude-sessions          # from the registry
```

## Configure

```yaml
type: "@magistr/claude-sessions"
typeVersion: "2026.07.19.1"
globalArguments:
  projectsDir: "~/.claude/projects"
  cardStateDir: "~/.claude/mk-session-cards"
  defaultProject: "-Users-me-dev-myrepo"
methods: {}
```

`defaultProject` is the encoded project directory name — the session's `cwd`
with every non-alphanumeric character replaced by `-`. Leave it empty to read
every project.

## Methods

| Method         | What it does                                                               |
| -------------- | -------------------------------------------------------------------------- |
| `index`        | Per-project session counts, bytes, last activity. Stats only — no parsing. |
| `listSessions` | One `session` resource per transcript, with counts, prompts and a verdict. |
| `search`       | Full-text search across transcripts, with snippets.                        |
| `triage`       | Joins sessions to mk cards and ranks them by completion verdict.           |

Every method fans out over all matching sessions in a single run, so a whole
history costs one method call and one model lock.

```bash
swamp model method run sessions index
swamp model method run sessions listSessions --arg since=2026-07-12
swamp model method run sessions search --arg q="clickhouse"
swamp model method run sessions triage --arg since=2026-07-12
```

## What a session resource holds

Metadata (`title` from Claude's own ai-title, `cwd`, `gitBranch`, `cliVersion`,
`models`), activity (`startedAt`, `lastActivityAt`, `spanHours`, `staleDays`),
volume (`lines`, `userTurns`, `assistantTurns`, `toolCalls`, `topTools`), and
narrative (`firstUserPrompt`, `lastUserPrompt`, `closingText`).

Query it like any other swamp data:

```bash
swamp data query 'modelName == "sessions" && name.startsWith("session-") &&
  isLatest && attributes.verdict == "likely-complete"' \
  --select 'attributes.title'
```

## The completion verdict

`triage` reads each session's **last assistant message** — which by the
`mk-session-card` hook's convention is a recap of what was done and what is left
— and assigns one of:

| Verdict           | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `likely-complete` | Reports completion with no open follow-ups.                |
| `likely-open`     | Names next steps, blockers, or remaining work.             |
| `hook-noise`      | Session ended on mk card bookkeeping, not on a work recap. |
| `unclear`         | Final message carries neither signal.                      |

This is a **ranking aid, not a judgment**. Every row carries `closingText` as
evidence so a human — or an agent reading the resource — makes the actual call.
`hook-noise` exists because a session that ends on `/mk-card` tells you nothing
about the work: the real recap is further up the transcript.

Sidechain (subagent) turns are excluded from parsing, so a chatty subagent never
becomes the session's last word. Truncated tail lines — normal for a session
still being written — are skipped rather than failing the read.

## Triage worklist

The `triage` resource holds `rows` sorted `likely-complete` → `hook-noise` →
`unclear` → `likely-open`, then by staleness. It also reports
`sessionsWithoutCard` (sessions the hook never tracked) and
`cardsWithoutSession` (cards whose transcript is gone) — both are gaps that need
a human look rather than a verdict.

## License

MIT
