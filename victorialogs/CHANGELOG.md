# Changelog

## 2026.08.01.1

Two HIGH monitoring blind-spots (both false all-clears/storms) are now FIXED,
plus a trivial same-method sort fold-in. Tracked end-to-end in the LOCAL
`victorialogs-false-allclear-bugs` issue-lifecycle model — never a Lab issue,
since this is a `@magistr/*` extension.

1. **P4 — ssh failure swallowed as a false all-clear (HIGH), FIXED** —
   `getRunningContainers` never checked the ssh subprocess's `output.success`;
   an ssh FAILURE (e.g. connection refused, host key mismatch) yielded empty
   stdout, which was decoded unconditionally into `running = []`, so
   `container-log-status` reported `notLogging: []` — identical to "every
   running container is logging" even though the check never actually ran. Fixed
   by checking `output.success` and throwing a distinct ssh-failure error
   carrying the HOST and EXIT CODE only — never raw stderr, which can leak
   internal topology (host-key/gateway names).
2. **P6 — compare-periods empty-window/NaN alarm storm (HIGH), FIXED** —
   `compare-periods` had no guard for an empty baseline or comparison window: an
   empty baseline classified every container as `NEW`, an empty comparison
   window classified every container as `GONE` (a fleet-wide false-alarm storm).
   Separately, `parseInt(e.total)` with no radix silently produced `NaN` for a
   garbled `total` value, which the `|| 0` fallback collapsed to 0 — masking
   what should read as "this container had SOME volume" and silently landing a
   real disappearance on `NORMAL` instead of an alertable `GONE`. Fixed by
   throwing distinct errors when either window is empty (checked immediately
   after the `Promise.all` fetch, so both fetches still complete before either
   guard fires) and by detecting `Number.isNaN` at the baseline/comparison map
   ingest (now with explicit radix 10) and throwing instead of silently
   collapsing to 0.
3. **P13 — sort comparator falsy-collapse (fold-in, same method/bug class)** —
   the `compare-periods` sort comparator's
   `(order[a.status] || 9) -
   (order[b.status] || 9)` treated `GONE`'s
   priority value of `0` as falsy, collapsing it to the unmapped-status fallback
   of `9` — the most urgent alert (a service went silent) sorted LAST instead of
   first. Found during the wave-2b review, outside the original P4/P6 scope but
   trivial and on the same edited lines; fixed by switching to `?? 9` (nullish
   coalescing), which only substitutes on `null`/`undefined`, not on `0`.

- `model.version` (`extensions/models/victorialogs.ts`) and `manifest.yaml` both
  bump to `2026.08.01.1`, in sync.
- Flipped ~15 characterization pins across the three affected suites
  (`victorialogs_methods_test.ts`, `victorialogs_adversarial_test.ts`,
  `victorialogs_coverage_test.ts`, `victorialogs_property_test.ts`) from pinning
  the buggy behavior to asserting the fixed rejection/ordering; constrained the
  property suite's non-degenerate `arbWindow` to `minKeys: 1` and fed the
  methods suite's default-window test non-empty bodies so neither trips the new
  empty-window guard. Every other pin (P1/P2/P3/P5/P7/P8/P9/ P10/P11/P12, and
  all legit-path happy/failure characterizations) is unchanged.

## Test backfill (prior to 2026.08.01.1, no version bump at the time)

Test backfill to the STANDARD.md five-suite quality bar (wave 2b, full build of
the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change at the time — `victorialogs.ts` was unmodified and the model
`version` stayed `2026.07.16.2`; `manifest.yaml` was unchanged. The
`2026.08.01.1` fixes above build directly on this test suite.

- Added `extensions/models/victorialogs_test.ts` (contract-fixture),
  `victorialogs_methods_test.ts` (methods), `victorialogs_adversarial_test.ts`
  (adversarial), `victorialogs_coverage_test.ts` (coverage),
  `victorialogs_property_test.ts` (property-invariant-flow) — 0 tests before
  this change.
- Added `fixtures/` — pure doc-derived, synthetic VictoriaLogs LogsQL/NDJSON
  wire-shape fixtures (`query`, `stats`, `container-stats`, `error-lines`) plus
  `PROVENANCE.md`. No live call was made against the real `vlogs-unraid`
  instance; every container name, host, and IP is synthetic
  (`svc-alpha`/`svc-beta`/`svc-gamma`, `*.example.test`, RFC 5737 addresses).
- Every suite drives `model.methods.<m>.execute()` (and, in the contract-fixture
  suite, `model.resources.<r>.schema`) against a stubbed `fetch` (no
  `as typeof globalThis.fetch` cast) and a stubbed `Deno.Command` (for
  `container-log-status`), pinning already-shipped behavior — including several
  found bugs, characterized rather than fixed:
  - `container-log-status` never checks the ssh subprocess's `output.success` —
    an ssh failure is swallowed as a false all-clear.
  - `compare-periods` has real empty-window storms (an empty baseline classifies
    everything `NEW`; an empty comparison window classifies everything `GONE`)
    and a `Promise.all` all-or-nothing failure mode.
  - `error-summary`'s plain-object accumulator is vulnerable to prototype
    pollution via a `constructor` container name (pollutes the global `Object`
    constructor); a `__proto__` container name is verified SAFE on Deno
    specifically, since this runtime does not implement the legacy
    `Object.prototype.__proto__` accessor.
  - The `compare-periods` sort comparator's `order[status] || 9` falsy-
    collapses `GONE`'s priority value (`0`) to the unmapped-status fallback, so
    a `GONE` service — the most urgent alert — sorts LAST instead of first.
    Newly found during this backfill (not in the original plan), same bug class
    as the empty-window/NaN-total collapses above.
  - `query` reads `e.stream` while VictoriaLogs emits `_stream` — the stream
    label is always dropped.
  - No `AbortSignal.timeout` on any fetch call; plaintext `http://` target;
    `logsql`/`start`/`end` have no length bound.
  - These characterizations extend the sibling issue
    `victorialogs-false-allclear-bugs`'s tracked-bug list.
- `deno.json`: default `test` task stays network-less (no `--allow-net`) and
  subprocess-less (no `--allow-run`), scoped to `--allow-env=FC_NUM_RUNS`; added
  `test:soak` for the high-count nightly property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (victorialogs
  bundles no Claude skill); a measured ratchet score recorded. Removed from
  `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: LogsQL query (`query`), stats aggregation (`stats`),
running-vs-logging container reconciliation (`container-log-status`),
error/fatal/panic/OOM summarization (`error-summary`), and baseline-vs-
comparison volume diffing (`compare-periods`) against a VictoriaLogs HTTP
endpoint.
