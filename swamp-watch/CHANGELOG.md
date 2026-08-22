# Changelog

## 2026.08.21.1 — first release

Initial model. Makes a swamp repo's own scheduled work observable per workflow
rather than in aggregate.

- `scan` — reads every workflow declaring a `trigger.schedule` plus each one's
  run history in a single execution, and emits nine metric families as
  Prometheus exposition for `@magistr/victoriametrics` `push`.
- `drift` — probes a `swamp serve` for every workflow the repo declares and
  reports which are missing, separating genuine absence from a failed probe.

Design decisions worth keeping:

- **Budgets come from the longest legal gap, not the average.** `0 9,20 * * *`
  fires twice daily but can go 13h between fires; a 12h budget pages nightly.
- **Day-of-month and day-of-week are ORed** when both are restricted, per
  Vixie-cron. ANDing them makes `0 0 1 * 0` look monthly and inflates its budget
  roughly thirtyfold.
- **No last-success state is kept.** swamp retains run history for about a day,
  so a weekly workflow's last success is already evicted. Each scan pushes what
  it can see (`0` for none) and the alert reads it back with `max_over_time`,
  making the time-series database the memory.
- **A per-workflow observation timestamp is emitted** so the alert can require
  "we have been watching longer than the budget". Without it every weekly and
  monthly schedule pages the moment the model is switched on — verified against
  live data: the un-guarded rule matched four workflows, three of them healthy.
- **History is read per workflow, by name.** The global history response is
  capped, and a two-minute workflow emits enough records to evict every daily
  and weekly run from the window.
- **A failed history read does not drop the workflow** from the scan. Dropping
  it would take its series with it and silence the alert this model exists to
  raise.
- **Only "not found" counts as drift.** Auth failures and timeouts are the probe
  breaking; reporting those as missing manufactures a deploy-drift alert out of
  a flaky connection. Non-404 failures are retried once with backoff, and a 404
  is not retried — retrying it doubles load on a server already refusing.
