---
issue: si-applied-resource-lifetime
date: 2026-06-16
kind: decision
---

# Bound retention of secret-bearing resources by purpose; scrub at write

## Context

Every resource across the four swamp-go-brr models declared
`lifetime: "infinite"`. The ones that persist scrubbed-but-possibly-secret text
(`source-integration` `workorder` = inlined file slices and `applied` = the jj
diff; `gobrr` `stepOutputs` = scrubbed diff/verify tails; `docker-verify`
`result` = verify stdout) therefore retained any secret the best-effort
[scrubber](../patterns/scrub-at-the-storage-boundary.md) misses **forever**.
`docker-verify.result.stdout` was additionally stored **raw** (unscrubbed).
swamp supports bounded lifetimes (`1h`/`24h`/`7d` are used elsewhere); only
these four models hardcoded `infinite`.

(The issue was filed against a stale "the comment says 24h but the code says
infinite" mismatch; that comment vanished when
[0003](0003-record-pruned-step-outputs.md) moved `scrubSecrets` into `lib/`. The
real, durable concern is the unbounded retention — re-scoped to include the
then-new `stepOutputs` resource.)

## Decision

Bound the secret-bearing resources by **purpose**, not uniformly:

- **Transient per-task inputs → 24h**: `workorder`, `applied`, `docker-verify`
  `result`. They are single-use within a run (wallclock cap 2h), so 24h safely
  outlives the run while limiting residual-secret exposure.
- **Durable audit log → 7d**: `gobrr` `stepOutputs`. It is read on completion
  AND on **post-halt inspection** (the dropped-block detector); co-expiring it
  with the transient inputs at 24h would destroy the audit trail for any run
  inspected a day later. 7d bounds it without losing realistic forensics.
- **Non-secret state → infinite**: `run` (authoritative aggregate / history),
  `summary`/`decision`/`config` (derived; `config` holds only a CEL vault
  _reference_, never a resolved token). Bounding `run` would drop run history.

Scrub the one raw field at its write boundary, with a pure testable helper:

```ts
export function boundedStdout(s: string): string {
  return scrubSecrets(s).slice(-8000);
}
```

The exit-code gate reads the **raw** stdout (`parseExitSentinel`) _before_
`boundedStdout` scrubs the stored copy, so store-side scrubbing can never weaken
the green gate. Secret-bearing string fields are marked
`.meta({ sensitive: true })`.

## Consequences

- **Scrubbing stays the PRIMARY control; the bounded TTL is defense-in-depth** —
  not a replacement. Both are kept at every boundary.
- **TTL by purpose, not uniformly.** "Secret-bearing" is necessary but not
  sufficient to pick the window — a durable audit artifact and a transient input
  warrant different retention even though both are secret-bearing.
- **Make the scrub testable.** Extracting `boundedStdout` as a pure helper
  turned a "verified at code review" promise into a real unit test (a forgotten
  scrub now fails RED) — the test-review loop rightly rejected the
  code-review-only plan.
- Changing `lifetime` bounds **future** writes; data already written under
  `infinite` ages out via the GC count, not retroactively.
