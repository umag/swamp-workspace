# Changelog

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4c
extension-quality backfill, `ext-quality-test-backfill`). No behavior change --
`extensions/models/jscad_stl_validator.ts`,
`extensions/models/jscad/stl_validator.ts`, and `manifest.yaml` are BYTE-FROZEN
and the model `version` stays `2026.07.16.2`.

- Extended `extensions/models/jscad/stl_validator_test.ts` (contract-fixture) in
  place with exact full-report-object pins for a canonical binary STL, a
  canonical ASCII STL, an empty file, an ASCII STL missing `endsolid`, and an
  all-zero binary buffer.
- Added `extensions/models/jscad_stl_validator_methods_test.ts` (methods) --
  happy-path and throw-path coverage of both `validate` (model-not-found,
  no-stored-output with/without a pinned version) and `validateFile`
  (missing-file and directory-path read errors), against a fake
  `definitionRepository`/`dataRepository`/`writeResource` context for `validate`
  and a real `Deno.readFile` over a per-test `Deno.makeTempDir()` fixture for
  `validateFile`.
- Added `extensions/models/jscad_stl_validator_adversarial_test.ts`
  (adversarial) -- hostile/malformed inputs pinning CURRENT behavior: truncation
  mid-triangle, a huge attacker-claimed triangle count (safe -- bounded by
  actual buffer size, no OOB), NaN/Infinity binary coordinates, `issues[]`
  amplification under repeated bad triangles, the binary-vs-ASCII misdetection
  failure mode, weak ASCII geometry validation, the binary-vs-ASCII NaN/Infinity
  handling asymmetry, and `validateFile`'s complete lack of path confinement.
- Added `extensions/models/jscad_stl_validator_coverage_test.ts` (coverage) --
  the remaining branches: each of the three duplicate-vertex degenerate
  conditions individually, the near-zero-cross-product (colinear, distinct
  vertices) degenerate branch, both the positive and guard-clause-failure paths
  of the "solid"-header reclassification logic, and `validate`'s `version`
  argument passthrough (specified vs. omitted).
- Added `extensions/models/jscad_stl_validator_property_test.ts`
  (property-invariant-flow, `npm:fast-check@4.8.0`, honors `FC_NUM_RUNS`) --
  `validate()` never throws for any byte buffer; the result always matches the
  model's own `resources.report.schema`; `valid === (issues.length ===
  0)`
  universally; and `triangleCount === floor((byteLength-84)/50)` for any
  guaranteed-binary, non-all-zero buffer of length >= 84. Verified locally at
  `FC_NUM_RUNS=5000` with no flakes before landing.
- Added `extensions/models/fixtures/stl_builders.ts` -- a byte-accurate
  synthetic fixture Factory that is the inverse of the shipped parser:
  `encodeBinaryStl` (80-byte header + `claimedTriangleCount` uint32 LE @80 +
  50-byte-per-triangle records) and `encodeAsciiStl`
  (`solid`/`facet
  normal`/`outer loop`/`vertex`/`endloop`/`endfacet`/`endsolid`
  text, accepting `string | number` per coordinate so malformed-but-regex-legal
  tokens like `"."` and `"1e400"` can be injected). Also added
  `extensions/models/fixtures/PROVENANCE.md` declaring the synthetic-only
  provenance.
- 5 already-shipped latent bugs are PINNED (characterized as CURRENT behavior,
  not fixed) and tracked in the LOCAL `jscad-stl-validator-latent-bugs`
  issue-lifecycle model (NEVER filed to the swamp.club Lab):
  1. **`validateFile` arbitrary-file-read / path traversal (HIGH)** --
     `filePath` is passed to `Deno.readFile` verbatim, with no allow-list, no
     confinement to any base directory, and no realpath check. Any absolute
     path, or a path containing `../` traversal segments, is honored exactly.
  2. **Corrupt-binary-vs-ASCII misdetection (MEDIUM)** -- a binary buffer whose
     80-byte header happens to decode its first 5 bytes as `"solid"` AND whose
     claimed (offset-80) triangle count does not match the actual buffer size
     falls through the reclassification guard and is parsed as ASCII instead of
     binary, losing the real "Size mismatch" diagnosis and the actual triangle
     data entirely.
  3. **Unbounded read + O(n) arrays + `issues[]` amplification (MEDIUM)** --
     `Deno.readFile` buffers the whole file into memory with no size cap; every
     valid triangle is retained in an in-memory array, and one issue string is
     pushed PER bad (NaN/Infinity) triangle, so `issues.length` grows linearly
     with a hostile triangle count.
  4. **Weak ASCII validation accepts malformed geometry as "valid" (LOW)** --
     the ASCII path only checks that at least one `facet normal` token exists
     and that `endsolid` is present; it performs no degenerate-triangle check,
     so a fully degenerate (duplicate-vertex, zero-area) facet is reported
     `valid: true` with `degenerateTriangles: 0`.
  5. **NaN/Infinity handling asymmetry, binary vs. ASCII (LOW)** -- the binary
     path explicitly checks every coordinate with `isFinite`/`isNaN` and flags
     the triangle as degenerate with a dedicated issue; the ASCII path has no
     equivalent check at all. An Infinity-valued vertex coordinate silently
     poisons the computed bounding box's max (or min, for `-Infinity`); an
     all-NaN facet produces a nonsensical inverted `min:[Infinity,...]` /
     `max:[-Infinity,...]` box (NaN comparisons always evaluate false, so the
     min/max accumulators never advance past their sentinel seed values) --
     either way, no issue is raised and `valid` stays `true`. Also
     regression-pinned as SAFE (not a bug): the binary triangle-read loop is
     bounded by `Math.floor((byteLength-84)/50)` -- the ACTUAL buffer size --
     never by the attacker-controlled claimed count at offset 80, so an
     arbitrarily huge claimed count cannot cause an out-of-bounds read or a
     hang.
- `deno.json`: `test` task scoped to
  `--allow-read --allow-write
  --allow-env=FC_NUM_RUNS` (read+write for
  `Deno.makeTempDir()` fixture files; no `--allow-net` -- this extension has
  none); `check` task extended to also typecheck `jscad/stl_validator.ts`, the
  four new suite files, and `fixtures/stl_builders.ts`. `deno.lock` regenerated
  to lock the new TEST-ONLY dev dependencies (`jsr:@std/assert@1`,
  `npm:fast-check@4.8.0`) -- the source dependency (`npm:zod@4`) is unchanged.
- `quality.yaml`: all five required suites flip from `backlog` to `present`;
  `docs.readme`/`docs.changelog` flip to `present`; `docs.skill` recorded `na`
  (jscad-stl-validator bundles no Claude skill -- a geometry validator, nothing
  to document as a skill). `watch`/`canary` stay `backlog` (seeded offender at
  CI-gate rollout, tracked in `ext-quality-test-backfill`). `ratchet` set to the
  measured `swamp extension quality manifest.yaml
  --json` score: `100` /
  `"Grade A"`. Removed from `quality-allowlist.txt` in the same change.
