# Changelog

## 2026.10.15.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.10.15.1

### Added

- **`applyRecords`: reconcile DNS to a desired state in one run.** Records are
  grouped by (subdomain, type); only named groups are touched. Within a group,
  records not desired are deleted and missing ones created; matching is by
  normalised content (case, trailing dot) and MX/SRV priority. Running it twice
  changes nothing. `dryRun` reports the plan without writing. Writes a
  `dns-reconciled` resource with per-group created/deleted/kept.
- **`checkDomains`: availability and price for one or more domains**, including
  registry premium, renewal and transfer price and first-year promo. Checks are
  paced (`delayMs`, default 10.5 s) to stay under Porkbun's 1-per-10s limit. One
  `domain-check` resource per domain; a failed check records its `error` and
  leaves `available` null rather than reporting a false "no".

### Fixed before release

- `applyRecords` aborts when the read of existing records fails. Before, any
  error (auth, network, rate limit) was read as "no records", so the plan
  re-created records that already existed. Only an explicit not-found answer
  counts as an empty group.
- `checkDomains` rejects anything that is not a domain name, so a value such as
  `../dns/delete/x` cannot change the API path.

## 2026.10.14.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.09.19.2

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.09.17.1

### Changed

- Repo-wide maintenance release: version bump to republish the current source.
  No schema change.

## 2026.08.19.1

- Version bump and smoke test

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
