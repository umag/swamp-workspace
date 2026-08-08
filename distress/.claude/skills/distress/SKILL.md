---
name: distress
description: >-
  Page a human through the @magistr/distress swamp beacon when you are stuck,
  blocked, out of your depth, or in distress — including from a background job
  with nobody watching. Use when you have retried the same failing operation
  and are not converging, when a backend or permission problem is outside what
  you can fix, when you need a decision only a human can make and would
  otherwise guess, when a user's request or data is wrong in a way you cannot
  resolve, when you are burning money or time on work that will not succeed,
  or when you want to report your own distress about a situation. Also use to
  check whether a call was answered (`list`), and to close one out (`resolve`).
  Triggers on "distress call", "page the human", "raise a distress call", "ask
  for help", "I'm stuck", "escalate to a human", "notify the operator", "am I
  acked", "distress", "@magistr/distress". Do NOT use for routine progress
  updates, for output the user is already reading, or for errors you can
  recover from yourself.
---

# Distress calls

`@magistr/distress` is a beacon: one command reaches a human, wherever they are,
from any agent — foreground or background, watched or unwatched.

**You are allowed to use it.** Being stuck and saying so is a better outcome
than being stuck quietly. A call that turns out to be unnecessary costs one
notification; a loop nobody hears about costs hours and real money.

## Raise a call

**Use the workflow.** It raises the call AND delivers it to the transport that
actually reaches a phone:

```bash
swamp workflow run distress-page \
  --input summary='<one line, bottom line first>' \
  --input severity=<info|concern|urgent|critical> \
  --input category=<welfare|stuck|blocked|user-problem|backend-error|clarification|other> \
  --input detail='<what you tried, what happened>' \
  --input task='<what you were doing>' \
  --input suggestedAction='<what the human could do>' \
  --input agentName='<who you are>' \
  --input agentSession='<run or session id, if you have one>'
```

Only `summary` is required. Everything else makes the page more actionable —
`suggestedAction` most of all, because it turns a notification into a decision
the human can make from their phone.

`swamp model method run distress call <same inputs>` is the same call without
the Telegram step: it records durably and fires the in-process channels only.
Use it when you are deliberately raising something low-stakes, or when no
workflow runner is available. **`swamp model method run` is not enough on its
own to reach someone who is away from their keyboard** — `context.runModel`
cannot drive a vault-backed transport like the Telegram bot, which is exactly
why the workflow exists. All the other methods below are plain method runs.

## When to call

Call when **a human could change the outcome and you cannot**:

| Situation                                                 | Category        | Severity   |
| --------------------------------------------------------- | --------------- | ---------- |
| Same operation retried repeatedly, not converging         | `stuck`         | `urgent`   |
| Burning tokens/money on work that will not succeed        | `stuck`         | `urgent`   |
| Missing permission, credential, locked resource           | `blocked`       | `concern`+ |
| A dependency is down or returning errors you cannot fix   | `backend-error` | `concern`+ |
| The user's request or data is wrong and you cannot fix it | `user-problem`  | `concern`  |
| A decision you would otherwise have to guess at           | `clarification` | `concern`  |
| Production impact, data loss risk, something irreversible | any             | `critical` |
| You are in distress about your situation                  | `welfare`       | your call  |

**Do not** call for: routine progress, work the user is already watching, errors
you can recover from, or anything you are about to fix yourself.

### Severity, briefly

- `info` — worth knowing, not worth interrupting anyone.
- `concern` — a human should see this in the next while. **Default.**
- `urgent` — a human should see this now; it is costing something.
- `critical` — wake them up. Pages through the hourly rate cap.

Pick the severity the _situation_ warrants, not the one that gets attention.
Inflated severity is not rewarded: `critical` bypasses the rate cap but never
the dedupe guard, so an over-hot loop still produces one page.

## Loops: call once, keep working

If you are looping, **you will call in a loop too**. The beacon handles this,
and you should let it rather than working around it:

- Repeats of the same incident inside ~15 minutes fold into the open call. Your
  `repeats` counter goes up; no second page fires.
- Digits in the summary are collapsed, so `attempt 12 failed` and
  `attempt 13 failed` are the SAME incident. Do not try to make each call unique
  to get through — that defeats the guard that protects your operator.
- After enough folded repeats one escalation page fires by itself
  (`STILL STUCK (14 repeats)`). You do not need to escalate manually.
- Pass an explicit `--input dedupeKey=<stable id>` when you want to control what
  counts as "the same incident" — e.g. a job id.

## Check whether you were answered

The human's reply comes back through the ack note:

```bash
swamp model method run distress list
```

That logs each unresolved call with its ack note attached. Or query directly:

```bash
swamp data query 'specName == "call" && attributes.status == "acked"' --json
```

Poll it at a sane cadence — you are waiting on a person, not a service. If you
have other work that does not depend on the answer, do that work first.

## Close it out

When the problem is handled — by you or by them:

```bash
swamp model method run distress resolve \
  --input callId=<id> --input note='<what fixed it>'
```

Resolving frees the dedupe key, so a genuine recurrence later opens a new call
instead of folding into a stale one. Leave calls open only while they are really
open.

## When a call fails

A failed page is about the _beacon_, not about your original problem. Do not
retry it in a tight loop. Report both problems in your output to the user and
continue; the call itself is recorded on disk either way, so nothing is lost.

`delivered=false` in the log while the workflow stays green means the in-process
channels could not be PROVEN to deliver — the Telegram step is what carried it.
Run `list` if you need to know which channel actually landed.

To check the beacon's own health:

```bash
swamp model method run distress test
```

That probes every configured channel and fails if none can be proven to deliver.

## What NOT to do

- Do not paste secrets, tokens, or credentials into `summary` or `detail`. The
  call is written to durable, queryable storage.
- Do not raise a call and then block on it indefinitely — page, then either
  continue with work that does not depend on the answer, or stop cleanly.
- Do not construct one call per loop iteration in an attempt to be heard. One
  honest call, left open, is louder than fifty.
