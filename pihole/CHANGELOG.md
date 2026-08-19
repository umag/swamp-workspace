# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.07.16.2 (test backfill, no version bump)

Quality backfill (`ext-quality-test-backfill`, wave 1 gap-check): brought
`@magistr/pihole` to full five-suite compliance per `STANDARD.md`, weighted to
the destructive paths (`delete-record`, `sync --deleteExtras`, `sync-clean`). No
runtime behavior change — `pihole.ts` / `lib/*.ts` are unmodified.

- `pihole_methods_test.ts` — all six methods driven against a stubbed
  `globalThis.fetch`: session lifecycle (auth then logout, always), exact
  `PUT`/`DELETE` verbs and paths, idempotency, `writeResource` spec/name per
  method, per-record failure aggregation.
- `pihole_adversarial_test.ts` — destructive-safety focus: an empty desired list
  refuses to run rather than wiping the zone; a rejected or partial/truncated
  `list()` fetch NEVER deletes a record outside what was actually fetched
  (exercised through both `sync --deleteExtras` and `sync-clean`); transport
  faults are captured, not swallowed; the password and session tokens never leak
  into a thrown error, even from a hostile upstream.
- `pihole_coverage_test.ts` — reviewer-found guard regressions: the FTL session
  is released (and the HTTP client closed) even when the session callback throws
  unexpectedly; an empty/absent `records` field refuses before any HTTP call;
  `deleteExtras` defaults to `false`; `parseHostsEntries` correctly skips a
  malformed host-file line instead of mis-parsing it.
- `pihole_property_test.ts` (`fast-check`) — the reconciliation invariants hold
  for arbitrary record sets: converging twice is a no-op, `deleteExtras=false`
  never deletes, `deleted ⊆ existing` (no phantom delete) under any partial
  view, `added`/`unchanged` exactly partition the desired set, and secret
  redaction is total, idempotent, and length-capped. Overridable via
  `FC_NUM_RUNS` for a larger nightly soak.
- `pihole_test.ts` — enriches the wire-format contract with hand-authored,
  **synthetic** fixtures (`pihole/fixtures/`, RFC-5737 documentation IPs and
  `.example.test` hostnames only — no real host or credential, no real session
  token). A real sanitized capture from the homelab instance is expected later
  via the `ext-canary-fixtures` workflow, run from a WireGuard-connected host,
  never from this repo's CI or a developer laptop.
- `pihole_live_test.ts` — an opt-in (`LIVE_PIHOLE=1`), read-only suite against a
  real instance; off by default, and asserted to stay off by default.
