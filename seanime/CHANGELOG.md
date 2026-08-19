# Changelog

## 2026.08.19.1

- Version bump and smoke test

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-2a, full build,
`ext-quality-bf-seanime`, child of `ext-quality-test-backfill`), plus a model
upgrade-chain repair. No behavior change to any method — `manifest.yaml` and the
model `version` (`2026.07.16.2`) are unchanged; `seanime.ts` only gains two
metadata-only `upgrades[]` entries (see below), no method/schema edits.

- Added `extensions/models/seanime_methods_test.ts` (methods — all 8 methods
  happy + error path, `X-Seanime-Token` header presence, credential-leak sweep,
  server-echo no-redaction pin), `seanime_test.ts` (contract-fixture — pins the
  `json.data` envelope unwrap and the `resp.ok` error mapping against the
  concrete `/api/v1` wire shapes), `seanime_adversarial_test.ts` (adversarial —
  partial-failure vs pre-loop-read-failure distinction, per-method re-run
  idempotency incl. the `set-planning-watching` same-list negative pin, hostile
  AniList payloads, title path-traversal, duplicate-mediaId double-POST,
  server-echoed-token persistence into `failed[].error`, fixtures-secret-scan),
  `seanime_coverage_test.ts` (coverage — both sides of every guard),
  `seanime_property_test.ts` (property-invariant-flow — fast-check, bulk
  partition invariant, re-run no-double-apply per bulk method, rule-request-body
  injectivity over the canonical non-collapsing subset, torrent/list round-trip)
  — 0 tests before this change, 90 after.
- Added `fixtures/` — pure doc-derived, synthetic Seanime `/api/v1` wire-shape
  fixtures (`status`, `library-collection`, `missing-episodes`, `torrent-list`,
  `anilist-collection`, `auto-downloader-rules`, `list-entry`, `error`) plus
  `PROVENANCE.md`. No live call was made against the homelab `my-seanime`
  instance and the `seanime` vault's `TOKEN` was never read; every value is
  synthetic (`seanime.example.com` per RFC 2606, fake AniList media ids/titles).
  `status.json`'s `settings` block deliberately omits any AniList OAuth token or
  torrent-client password field — the concrete reason live capture is forbidden
  for this corpus.
- `deno.json`: default `test` task stays network-less (no `--allow-net`), scoped
  to `--allow-env=FC_NUM_RUNS`; added `test:soak` for the high-count nightly
  property soak. `imports` map is unchanged (`{ zod }` only); test deps
  (`jsr:@std/assert@1`, `npm:fast-check@4.8.0`) are pinned direct specifiers in
  the test files themselves.
- **Upgrade-chain repair**: `model.upgrades[]` previously ended at
  `2026.04.05.2` while `model.version` was already `2026.07.16.2` (the
  registry's actual published lineage is `2026.05.25.1` -> `2026.07.16.2` — the
  `2026.04.05.x` versions predate publication and were never on the registry),
  so `swamp extension quality` errored on the broken chain instead of scoring
  the extension. Added two identity lineage-repair bridge entries
  (`2026.04.05.2 -> 2026.05.25.1 -> 2026.07.16.2`,
  `upgradeAttributes: (old)
  => old`) after diffing `GlobalArgsSchema`
  (`baseUrl`/`token`) across the commit that first packaged `seanime.ts` into
  this repo (`a82ecae`, model version `2026.05.25.1`) and the commit that last
  bumped `model.version` (`7eb5eec`, version-alignment only) — the schema is
  byte-identical across both hops, so identity is correct, not assumed. Both
  entries' descriptions name the real reason for each version bump (packaging
  into the workspace, then manifest-version alignment) instead of a bare "no
  changes". The chain now terminates at `model.version`, so
  `swamp extension push
  seanime/manifest.yaml --dry-run -y` and
  `swamp extension quality` both succeed from a cold cache.
- `quality.yaml`: all five required suites plus `docs.readme`/ `docs.changelog`
  flip from `backlog` to `present`; `docs.skill` recorded `na` (seanime bundles
  no Claude skill). `ratchet` is restamped from the now-real
  `swamp extension quality seanime/manifest.yaml --json` output:
  `baselinePercentage: 0` / UNSCORABLE -> `baselinePercentage: 100` / Grade A
  (14/14). Un-blocks `workspace-ratchet-scorer-blockers`.
- Removed from `quality-allowlist.txt` in the same change (shrink-only guard —
  `quality-offenders.baseline.txt` is untouched, write-once).

## 2026.07.16.2

Initial release: `status`, `library-collection`, `missing-episodes`,
`library-scan`, `torrent-list`, `auto-download` over the Seanime `/api/v1` REST
surface, plus AniList PLANNING-list bulk management (`sync-planning-rules`,
`set-planning-watching`).
