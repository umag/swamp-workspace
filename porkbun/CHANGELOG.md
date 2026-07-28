# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-1 pilot of the
extension-quality backfill program, `ext-quality-test-backfill`). No behavior
change — `porkbun.ts` is unmodified and the model `version` stays
`2026.07.16.2`.

- Added `extensions/models/porkbun_methods_test.ts` (methods), `porkbun_test.ts`
  (contract-fixture), `porkbun_adversarial_test.ts` (adversarial),
  `porkbun_coverage_test.ts` (coverage), `porkbun_property_test.ts`
  (property-invariant-flow) — 0 tests before this change.
- Added `fixtures/` — pure doc-derived, synthetic Porkbun API v3 wire-shape
  fixtures (`ping`, `retrieve`, `retrieveByNameType`, `create`, `edit`,
  `delete`, `error`) plus `PROVENANCE.md`. No live call was made against any
  Porkbun account; every value is synthetic (`example.com`, RFC 5737 addresses,
  synthetic record ids).
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak.
- `quality.yaml`: all five required suites plus `docs.readme`/`docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (porkbun bundles
  no Claude skill). Removed from `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: full DNS CRUD (`ping`, `list`, `get`, `create`, `update`,
`delete`, `deleteByNameType`) over the Porkbun DNS API v3 for every common
record type (`A`, `AAAA`, `MX`, `CNAME`, `ALIAS`, `TXT`, `NS`, `SRV`, `TLSA`,
`CAA`, `HTTPS`, `SVCB`, `SSHFP`).
