# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave 2b, full build
of the extension-quality backfill program, `ext-quality-test-backfill`). No
behavior change — `victorialogs.ts` is unmodified and the model `version`
stays `2026.07.16.2`.

- Added `extensions/models/victorialogs_test.ts` (contract-fixture),
  `victorialogs_methods_test.ts` (methods), `victorialogs_adversarial_test.ts`
  (adversarial), `victorialogs_coverage_test.ts` (coverage),
  `victorialogs_property_test.ts` (property-invariant-flow) — 0 tests before
  this change.
- Added `fixtures/` — pure doc-derived, synthetic VictoriaLogs LogsQL/NDJSON
  wire-shape fixtures (`query`, `stats`, `container-stats`, `error-lines`)
  plus `PROVENANCE.md`. No live call was made against the real `vlogs-unraid`
  instance; every container name, host, and IP is synthetic
  (`svc-alpha`/`svc-beta`/`svc-gamma`, `*.example.test`, RFC 5737 addresses).
- Every suite drives `model.methods.<m>.execute()` (and, in the
  contract-fixture suite, `model.resources.<r>.schema`) against a stubbed
  `fetch` (no `as typeof globalThis.fetch` cast) and a stubbed `Deno.Command`
  (for `container-log-status`), pinning already-shipped behavior — including
  several found bugs, characterized rather than fixed:
  - `container-log-status` never checks the ssh subprocess's `output.success`
    — an ssh failure is swallowed as a false all-clear.
  - `compare-periods` has real empty-window storms (an empty baseline
    classifies everything `NEW`; an empty comparison window classifies
    everything `GONE`) and a `Promise.all` all-or-nothing failure mode.
  - `error-summary`'s plain-object accumulator is vulnerable to prototype
    pollution via a `constructor` container name (pollutes the global
    `Object` constructor); a `__proto__` container name is verified SAFE on
    Deno specifically, since this runtime does not implement the legacy
    `Object.prototype.__proto__` accessor.
  - The `compare-periods` sort comparator's `order[status] || 9` falsy-
    collapses `GONE`'s priority value (`0`) to the unmapped-status fallback,
    so a `GONE` service — the most urgent alert — sorts LAST instead of
    first. Newly found during this backfill (not in the original plan), same
    bug class as the empty-window/NaN-total collapses above.
  - `query` reads `e.stream` while VictoriaLogs emits `_stream` — the stream
    label is always dropped.
  - No `AbortSignal.timeout` on any fetch call; plaintext `http://` target;
    `logsql`/`start`/`end` have no length bound.
  - These characterizations extend the sibling issue
    `victorialogs-false-allclear-bugs`'s tracked-bug list.
- `deno.json`: default `test` task stays network-less (no `--allow-net`) and
  subprocess-less (no `--allow-run`), scoped to `--allow-env=FC_NUM_RUNS`;
  added `test:soak` for the high-count nightly property soak.
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
