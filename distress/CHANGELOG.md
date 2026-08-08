# Changelog

All notable changes to `@magistr/distress` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are CalVer (`YYYY.MM.DD.N`) to match the swamp registry.

## [2026.08.09.1] — 2026-08-09

Initial release.

### Added

- `@magistr/distress` model — a distress-call beacon any AI agent can use to
  page a human, at any time, for any reason.
- **Six methods.** `call` (raise), `ack` (answer, readable by the agent),
  `resolve` (close), `list` (what is open and what was said), `test` (prove
  every channel can page you), `record` (write back a delivery made by a
  workflow step).
- **Pluggable channels.** A channel names an existing swamp model instance and
  one of its methods, so `@magistr/telegram/send`, `@magistr/herdr`,
  `@keeb/discord/webhook` and anything else that sends messages work with no
  code change. Four argument presets (`text`, `title-body`, `message`,
  `content`) plus `{{placeholder}}` templating cover the rest. The model holds
  no credentials of its own.
- **Severity routing.** Per-channel `minSeverity`, priority-ordered failover,
  and `broadcastFrom` (default `urgent`) above which every eligible channel is
  used rather than just the first.
- **Proven delivery.** A send counts only when the callee returns a resource
  handle and — with `proofSpec` set — writes a genuinely new record of that
  spec. Unproven sends fail over to the next channel; a call that reached nobody
  raises an error after being persisted. This exists because `context.runModel`
  under `swamp serve` has been observed to resolve without executing the callee,
  turning three days of green runs into zero deliveries.
- **Loop protection.** Dedupe keys derived with digit runs collapsed (so "retry
  12/13/14 failed" is one incident), folding of repeats into the open call,
  escalation after N repeats that only resets its counter on a proven send, and
  a rolling hourly delivery cap with a once-per-hour throttle notice. Suppressed
  calls are always still recorded.
- **Durable records.** Per-call `call` resources plus a `beacon` index with the
  rolling rate window and lifetime counters; `listing` and `channelTest`
  results.
- **Redaction.** A callee's error text is scrubbed of bearer tokens,
  `/bot<token>/` URL segments, `key=`/`token=` parameters and URL userinfo, then
  length-bounded, before it reaches a durable record.
- Bundled Claude skill (`.claude/skills/distress/`) teaching an agent when
  raising a call is the right move — and when it is not.
- 131 tests across the five suites required by `STANDARD.md`, with the property
  suite pinned by a callee-contract fixture captured from
  `swamp model type describe`.

- **`record` method** and the stable-named **`outbound` resource**, for
  transports `context.runModel` cannot reach in-process. Verified live: a
  channel pointing at a vault-backed `@magistr/telegram/send` instance stalls
  exactly 30s and returns no resources without entering the callee — the same
  for `getMe` (no arguments, no network) as for `sendMessage`, while a direct
  method run answers in 151ms. Those transports are driven from a workflow step
  that reads `outbound` and reports back through `record`.

### Fixed during development

Four defects caught before release — two by the test suites, two by running it
for real — all recorded because each is a failure mode this model exists to
prevent:

- **Call ids could collide.** The id was derived from (instant, dedupe key)
  only, so two distinct calls raised in the same millisecond with the same key
  produced the same id and the second silently overwrote the first's record — a
  distress call disappearing. The id now carries the beacon's monotonic
  raised-count, which never repeats on an instance.
- **The index could drop the row it had just written.** With the history limit
  reached and every retained row live, `upsertEntry` could prune the entry it
  was being asked to insert, leaving a call that `ack` and `resolve` could not
  find. The upserted row now always survives; live calls outrank resolved ones
  for the remaining slots.
- **A callee's recorded no-op counted as a delivery.** Proof was "a new record
  of `proofSpec` appeared", and `@magistr/herdr`'s `notify` writes its `action`
  record even when toasts are disabled in herdr's config — `changed: false`,
  `status: "suppressed"`, `detail: "notification not shown (disabled)"`. A live
  channel test came back green while every channel was dark. Channels now carry
  `proofRequire`, a set of field values the proof record must actually assert,
  and delivery is disbelieved without them.
- **Reserved data name.** `list` and `test` wrote their results as `latest`,
  which swamp reserves; both blew up on first real invocation. They now write
  `recent` and `channels`, with a regression test over every method's written
  resource names.
