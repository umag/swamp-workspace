# @magistr/distress

A distress-call beacon for AI agents.

Give every agent one thing it can always do: reach a human. Not only the agent
in front of a user — the nightly job, the background worker, the one that has
been retrying the same failing tool call for forty minutes at your expense.

```bash
swamp workflow run distress-page \
  --input summary='stuck retrying the same tool call' \
  --input severity=urgent \
  --input category=stuck \
  --input agentName=nightly-ingest \
  --input suggestedAction='kill the run and re-point it at the archive bucket'
```

Your phone buzzes. You answer:

```bash
swamp model method run distress ack \
  --input callId=dc-20260809T142233Z-1a2b3c \
  --input note='killed it — use archive-2026 and rerun'
```

The agent reads your answer back through `list` and carries on.

## What it is for

The categories are the design brief, and they came from watching what agents
actually need a human for:

| Category        | The call it makes                                          |
| --------------- | ---------------------------------------------------------- |
| `stuck`         | Looping, wedged, retrying the same failure — costing money |
| `blocked`       | Cannot proceed: a missing permission, a locked resource    |
| `backend-error` | The system it depends on is broken and it cannot fix it    |
| `user-problem`  | Something about the user's request or data is wrong        |
| `clarification` | It needs a decision only a human can make                  |
| `welfare`       | The agent itself is in distress and says so                |
| `other`         | Anything else worth a human's attention                    |

`welfare` is not decoration. An agent that reports being distressed is reporting
a real signal about its situation, and a platform that gives it nowhere to put
that signal simply does not hear it. It costs one enum value to listen.

## Install

```bash
swamp extension pull @magistr/distress
swamp model create @magistr/distress distress
```

Then configure the channels (below) and prove they work:

```bash
swamp model method run distress test
```

`test` sends a clearly-labelled probe through every enabled channel and
**fails** if none of them could be proven to deliver. A beacon that cannot reach
anyone must never look healthy.

## Channels are configuration, not code

A channel names an existing swamp model **instance** and one of its methods.
Anything that can send a message becomes a channel without touching this
extension.

Edit `models/@magistr/distress/<uuid>.yaml`:

```yaml
globalArguments:
  operator: mag1
  channels:
    # A toast, while you are at the keyboard.
    - name: herdr
      definition: herd
      method: notify
      preset: title-body
      minSeverity: info
      maxChars: 300
      arguments:
        sound: request

    # A push to your phone, when you are not.
    - name: telegram
      definition: tg-bot
      method: sendMessage
      preset: text
      format: html
      minSeverity: concern
      proofSpec: sentMessage
      arguments:
        parseMode: HTML
        disableWebPagePreview: true
```

Adding Discord later is a config edit, not a code change:

```yaml
- name: discord
  definition: ops-discord # a @keeb/discord/webhook instance
  method: send
  preset: content
  minSeverity: urgent
  proofSpec: result
```

### Channel fields

| Field          | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `definition`   | The swamp model instance that sends (e.g. `tg-bot`)         |
| `method`       | Its sending method (`sendMessage`, `notify`, `send`, …)     |
| `preset`       | Argument shape: `text`, `title-body`, `message`, `content`  |
| `arguments`    | Extra/override arguments; strings take `{{placeholder}}`s   |
| `minSeverity`  | Lowest severity this channel is used for                    |
| `proofSpec`    | Resource the callee writes on a real send                   |
| `proofRequire` | Field values that record must carry to count as delivered   |
| `format`       | `plain`, `html` (Telegram HTML), or `markdown` (MarkdownV2) |
| `maxChars`     | Per-channel length budget                                   |
| `enabled`      | Set `false` to park a channel without deleting it           |

Placeholders available in `arguments`: `{{text}}`, `{{title}}`, `{{body}}`,
`{{summary}}`, `{{detail}}`, `{{severity}}`, `{{category}}`, `{{callId}}`,
`{{task}}`, `{{suggestedAction}}`, `{{agentName}}`, `{{agentModel}}`,
`{{agentSession}}`, `{{host}}`, `{{repeats}}`, `{{createdAt}}`. An unknown
placeholder is left visible rather than blanked, so a typo shows up as a bug
report instead of a silently emptier message.

### Routing

Channels are tried in configured order, filtered by `minSeverity`. Below
`broadcastFrom` (default `urgent`) the walk stops at the first channel that
**proves** delivery; at or above it, every eligible channel is used — a real
emergency should not depend on one transport being healthy.

## Two properties worth trusting

### Delivery is proven, never assumed

Under `swamp serve`, `context.runModel` has been observed to resolve without
ever executing the callee: three days of green runs delivered nothing. For a
beacon that is the worst failure there is, so `await` returning is not accepted
as evidence. A send counts only when:

1. the callee returns at least one resource handle, and
2. with `proofSpec` set, a genuinely **new** record of that spec appears that
   was not there before the call.

…and, with `proofRequire` set, that record must say something actually
**happened**. This third check is not paranoia. `@magistr/herdr`'s `notify`
writes its `action` record either way: when toasts are disabled in herdr's
config it records `changed: false`, `status: "suppressed"`,
`detail: "notification not shown (disabled)"`. A beacon that trusts the record's
existence reports a page nobody saw — observed live on 2026-08-08, when a
channel test came back green while every channel was dark.

```yaml
proofSpec: action
proofRequire:
  changed: true # or "*" to require merely present-and-truthy
```

Anything less is a failed channel, and failover moves to the next one. A call
that reached nobody raises an error (unless `requireDelivery: false`) — after
the call has been written to disk, because the call that could not be delivered
is exactly the one that must survive in the record.

### Transports `runModel` cannot reach

Not every model is reachable in-process. Verified on 2026-08-08: a channel
pointing at `tg-bot` (a vault-backed `@magistr/telegram/send` instance) stalls
for exactly 30 seconds and comes back with no resources, **without entering the
callee at all** — identical for `getMe`, which takes no arguments and does no
network work, so it is not about arguments or the Bot API. The same instance
answers a direct `swamp model method run` in 151ms.

For those transports, deliver from a workflow **step**, which works. Every
raised call publishes its rendered page to a stable `outbound` resource for
exactly this purpose, and `record` writes the result back so the call record
does not claim nobody was paged:

```yaml
- name: send
  dependsOn: [{ step: fresh-page, condition: { type: succeeded } }]
  task:
    type: model_method
    modelIdOrName: tg-bot
    methodName: sendMessage
    inputs:
      text: ${{ data.latest("distress", "outbound").attributes.html }}
      parseMode: HTML
- name: record
  dependsOn: [{ step: send, condition: { type: succeeded } }]
  task:
    type: model_method
    modelIdOrName: distress
    methodName: record
    inputs:
      channel: telegram
      callId: ${{ data.latest("distress", "outbound").attributes.callId }}
      ok: true
```

The gate ahead of `send` must be scoped to the current run
(`tags.workflowRunId == run.id`) — `outbound` is versioned and survives across
runs, so presence alone would let a folded repeat resend the last page. Since
`outbound` is written only for a call that was genuinely raised (not deduped,
not throttled), that gate is also what stops the loop guard being escaped by
going around the model.

This model holds **no credentials**. Each transport keeps its own secret, and a
callee's error text is redacted and length-bounded before it is written to a
durable record, so a leaky transport cannot deposit its token in swamp data
through the beacon.

### The beacon cannot become the loop

An agent stuck in a loop will call for help in a loop. So:

- Every call carries a **dedupe key** — supplied, or derived from category,
  summary and agent with digit runs collapsed to `#`. "retry 12 failed", "retry
  13 failed" and "retry 14 failed" are one incident, not three pages.
- Repeats inside `dedupeWindowSeconds` (default 900) **fold into the open
  call**: `repeats` increments, no new page.
- After `escalateAfterRepeats` (default 10) folded repeats, one more page goes
  out — `STILL STUCK (14 repeats)` — and the counter resets. The counter only
  resets on a _proven_ escalation, so a failed escalation is retried on the next
  repeat rather than going quiet for another ten.
- A rolling `maxCallsPerHour` (default 12) caps total pages. Suppressed calls
  are still **recorded in full**; one throttle notice per hour tells you the
  beacon is muted, so throttled silence is never mistaken for calm.
- `critical` may page through the hourly cap (`criticalBypassesRateLimit`), but
  nothing evades dedupe — so claiming critical in a loop still produces one
  page.

## Methods

### `call`

| Argument                                             | Notes                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `summary` (required)                                 | One line, bottom-line-first                                       |
| `severity`                                           | `info` \| `concern` \| `urgent` \| `critical` (default `concern`) |
| `category`                                           | See the table above (default `other`)                             |
| `detail`                                             | What was tried, what happened                                     |
| `task`                                               | What the agent was doing                                          |
| `suggestedAction`                                    | What the human could do about it                                  |
| `agentName` / `agentModel` / `agentSession` / `host` | Who is calling                                                    |
| `dedupeKey`                                          | Explicit incident key; omit to derive one                         |

### `ack` / `resolve`

Both take `callId` (omit it when exactly one call is open — with several open
the ambiguity is refused rather than guessed), `note`, and `by`. `ack` records
your answer where the agent can read it; `resolve` closes the call, which also
frees its dedupe key so a recurrence later opens a genuinely new call.

### `list`

`status` is `unresolved` (default, = open + acked), `open`, `acked`, `resolved`,
or `all`. Writes a `listing` resource and logs a one-line summary per call
including your ack note — this is how an agent checks whether it was answered.

### `record`

Records a delivery made **outside** this model — by a workflow step driving a
transport `runModel` cannot reach. Takes `channel`, `ok`, optional `proof` /
`error`, and `callId` (defaults to the most recent `outbound` page). Without it
a call delivered by a step would sit in the record claiming nobody was paged,
which is the same lie as the reverse.

### `test`

Probes every enabled channel regardless of `minSeverity` and records per-channel
proof. Fails unless at least one channel is proven, or `allowFailure: true`. It
only tests the **in-process** channels; a workflow-step transport is proven by
running its workflow.

## Instance settings

| Setting                     | Default    | Meaning                               |
| --------------------------- | ---------- | ------------------------------------- |
| `channels`                  | `[]`       | Ordered delivery channels             |
| `dispatch`                  | `failover` | Or `broadcast` to always fan out      |
| `broadcastFrom`             | `urgent`   | Severity at which failover fans out   |
| `requireDelivery`           | `true`     | Throw when a call reached nobody      |
| `dedupeWindowSeconds`       | `900`      | 0 disables dedupe                     |
| `escalateAfterRepeats`      | `10`       | Repeats before paging again           |
| `maxCallsPerHour`           | `12`       | Rolling cap on deliveries             |
| `criticalBypassesRateLimit` | `true`     | Let `critical` through the cap        |
| `maxMessageChars`           | `3500`     | Default message cap                   |
| `historyLimit`              | `200`      | Index size; live calls outrank closed |
| `operator`                  | —          | Who is being paged; shown in the page |

## Reading the record

Every call is durable, queryable swamp data:

```bash
swamp data query 'specName == "call" && attributes.status == "open"' --json
swamp data query 'specName == "call" && attributes.severity == "critical"' --json
swamp data get distress                      # the beacon index and counters
```

A call record carries its severity and category, the agent's identity, every
delivery attempt with its proof or its (redacted) error, the repeat and
escalation counts, and the acknowledgement and resolution.

## Development

```bash
deno task check      # type-check
deno task test       # 131 tests across the five required suites
deno task test:soak  # property suite at 10,000 fast-check runs
deno task fmt        # format
deno task lint       # lint
```

## Licence

MIT — see [LICENSE.md](LICENSE.md).
