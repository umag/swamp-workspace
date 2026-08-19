# Changelog

## 2026.08.19.1

- Version bump and smoke test

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2a of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `shoko.ts` is unmodified and the model `version` stays `2026.07.16.2`.

- Added `extensions/models/shoko_test.ts` (contract-fixture),
  `shoko_methods_test.ts` (methods), `shoko_adversarial_test.ts` (adversarial),
  `shoko_coverage_test.ts` (coverage), `shoko_property_test.ts`
  (property-invariant-flow) — 0 tests before this change.
- Added `fixtures/` — pure doc-derived, synthetic Shoko REST v3 wire-shape
  fixtures (`auth`, `status`, `dashboard`, `series`, `files`,
  `missing-episodes`, `duplicate-files`, `import-folders`, `queue`,
  `queue-single`, `swagger`, `error`) plus `PROVENANCE.md`. No live call was
  made against the `my-shoko` instance and no `shoko-secrets` vault credential
  was read; every value is synthetic (RFC 5737 host, small sequential ids,
  placeholder series/episode/file names).
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (shoko bundles no
  Claude skill). Removed from `quality-allowlist.txt` in the same change.
- Characterizes (pins, does not fix) four pre-existing behaviors found during
  the backfill: `list-actions`'s `/Action/` prefix filter does not match Shoko's
  real `/api/v3/Action/...` swagger paths (fixture-observable only — no claim
  about the live spec); `list-series` (and the other `List`-keyed read methods)
  throw a `TypeError` on an empty-body 200 response; `queue-status` wraps a null
  body as `[null]` while `list-import-folders`/`search-series` map a null body
  to `[]`; and `search-series`'s `search-${query.slice(0,30)}` resource name
  clobbers across queries sharing the same 30-character prefix.

## 2026.07.16.2

Initial release: authenticate for a long-lived API key, then read server status,
dashboard stats, series (list/search), files (unrecognized, duplicate), episodes
(missing), import folders, and queue state, and trigger maintenance actions (run
import, rescan a folder, remove missing files, discover available actions from
the live OpenAPI spec) — 14 methods over the Shoko Server REST v3 API.
