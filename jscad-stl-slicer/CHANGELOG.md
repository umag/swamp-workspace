# Changelog

## 2026.08.19.1

- Version bump and smoke test

## Unreleased

Test backfill to the STANDARD.md five-suite quality bar (wave-4 batch-4c
extension-quality backfill, `ext-quality-test-backfill`). No behavior change --
`extensions/models/jscad_stl_slicer.ts`,
`extensions/models/jscad/stl_slicer.ts`, and `manifest.yaml` are BYTE-FROZEN and
the model `version` stays `2026.07.16.2`.

- Added `extensions/models/jscad_stl_slicer_methods_test.ts` (methods, all 18
  methods via the zod-arg + `writeResource`/`createFileWriter` seam),
  `jscad_stl_slicer_contract_test.ts` (contract-fixture, exact pins on
  axis-aligned box/prism solids), `jscad_stl_slicer_adversarial_test.ts`
  (adversarial, hostile/malformed binary-STL bytes),
  `jscad_stl_slicer_coverage_test.ts` (coverage, axis permutations + branch
  gaps), and `jscad_stl_slicer_property_test.ts` (property-invariant-flow,
  `npm:fast-check@4.8.0`, honors `FC_NUM_RUNS`) -- 0 tests before this change.
- Added `extensions/models/fixtures/builders.ts` -- a byte-accurate synthetic
  fixture Factory that is the inverse of the shipped binary-STL parser: encodes
  procedurally-generated boxes/prisms/single-triangle facets into the exact
  `DataView` layout `StlSlicer` reads (80-byte header, `uint32` triangle count
  at offset 80 LE, 50 bytes/facet). Also added
  `extensions/models/fixtures/PROVENANCE.md` declaring the synthetic-only
  provenance (procedurally generated primitives; no real STL files, 3D scans, or
  third-party model assets anywhere).
- The parser is confirmed BINARY-ONLY: there is no ASCII-STL code path.
  `asciiStlText()` in `builders.ts` exists solely to build the adversarial
  misparse fixture (MED-4 below) -- it is never a valid input.
- The 3 methods that reach a named `@magistr/jscad-cad` model (`sixViews`,
  `compareModels`, `enhancedCompareModels`) are exercised against a faked
  `context.definitionRepository.findByNameGlobal` +
  `context.dataRepository.getContent(type, id, "output")`.
- 11 already-shipped latent bugs are PINNED (characterized as CURRENT behavior,
  not fixed) and tracked in the LOCAL `jscad-stl-slicer-latent-bugs`
  issue-lifecycle model (NEVER filed to the swamp.club Lab):
  1. **Unbounded O(sampleCount x triangleCount) `surfaceDistance`; dead spatial
     grid (HIGH)** -- `buildTriangleGrid`/`_closestDistanceToMesh` are built and
     computed but never consulted; every sample point is checked against every
     triangle in mesh B by brute force.
  2. **`triCount` at offset 80 is never validated against `byteLength` (HIGH)**
     -- an inflated count throws an unhelpful low-level `RangeError` instead of
     a clear "invalid STL" error; a deflated count silently truncates trailing
     facets with no error at all.
  3. **`Math.max(...array)` spread pattern (MEDIUM)** -- used repeatedly
     (`fitProfiles`, `compare`'s profile normalization, `decompose`'s height and
     base-width computation) is a stack-overflow risk at tens of thousands of
     elements; characterized structurally at a small, CI-safe N.
  4. **ASCII-STL text silently misparsed as binary (MEDIUM)** -- there is no
     format sniff anywhere; bytes [80,84) of ASCII text become the triangle
     count.
  5. **NaN/Infinity vertex coordinates propagate silently (MEDIUM)** -- no
     finiteness validation anywhere in the read path; a single non-finite
     coordinate poisons centroid/PCA output with no error.
  6. **An empty-but-structurally-valid mesh (triCount=0) silently yields NaN
     (MEDIUM)** -- `computeCentroid` divides by `verts.length === 0`, producing
     a `NaN` centroid with no thrown error.
  7. **The `surfaceDistance` method wrapper swallows any thrown error to an all
     -1 sentinel (MEDIUM)** -- `jscad_stl_slicer.ts`'s `surfaceDistance` method
     catches unconditionally and substitutes
     `{ meanDistance: -1, ..., sampleCount: 0 }`, silently succeeding.
  8. **`filePath`/`refPath`/`modelPath` go straight to `Deno.readFile` with zero
     validation (MEDIUM)** -- no confinement of any kind; a relative
     `..`-bearing path reads whatever file it resolves to.
  9. **A triangle exactly coplanar with the slice plane is silently dropped
     (LOW)** -- `intersectTriangleZ`'s edge-crossing test requires a strict
     `>`/`<=` straddle, so a coplanar triangle registers zero crossings.
  10. **Degree-15 Vandermonde (normal-equations) polynomial fit is numerically
      unstable (LOW)** -- `fitProfiles` returns the degree-15 fit
      unconditionally when no lower degree meets `targetError`, even though a
      lower degree may have fit at least as well.
  11. **Isotropic-mesh PCA primary-axis labeling is not a stable contract
      (LOW)** -- `sortedLengths` are correct, but which world axis is labeled
      primary/mid/short for a mesh with near-equal variance along multiple axes
      is not asserted as a specific vector, only characterized.
  - **SAFE NEGATIVE (informational)**: `generateScript`'s code-gen is
    numeric-only -- every geometry-derived value is `Math.round(...)`ed before
    string interpolation and axis letters come only from the closed `Axis` enum,
    so there is no reachable string- or code-injection surface.
- `deno.json`: `test` task scoped to
  `--allow-read --allow-write --allow-env=FC_NUM_RUNS` (read+write for
  `Deno.makeTempDir()` fixture files; no `--allow-net` -- this extension has
  none); `check` task extended to also typecheck
  `extensions/models/fixtures/builders.ts`; added `test:soak` for the high-count
  nightly property soak. `deno.lock` regenerated to lock the new TEST-ONLY dev
  dependencies (`jsr:@std/assert@1`, `npm:fast-check@4.8.0`) -- the source
  dependency (`npm:zod@4`) is unchanged.
- `quality.yaml`: all five required suites flip from `backlog` to `present`;
  `docs.readme`/`docs.changelog` flip to `present`; `docs.skill` recorded `na`
  (jscad-stl-slicer bundles no Claude skill -- a geometry slicer, nothing to
  document as a skill). `watch`/`canary` stay `backlog` (seeded offender at
  CI-gate rollout, tracked in `ext-quality-test-backfill`). `ratchet` set to the
  measured `swamp extension quality manifest.yaml --json` score: `100` /
  `"Grade A"`. Removed from `quality-allowlist.txt` in the same change.

## 2026.07.16.2

Initial release: geometric analysis of binary STL meshes without any external
CAD dependency at runtime. Z-plane slicing with SVG cross-sections, 6-view
orthographic engineering drawings, PCA-based principal-axis and proportion
analysis, per-axis mirror symmetry detection, directional profile extraction,
asymmetric feature detection, polynomial profile fitting, centerline skeleton
extraction, JSCAD script generation, and RMS/Hausdorff surface-distance and
proportion comparison between two meshes. Pairs with `@magistr/jscad-cad` for
the `sixViews`, `compareModels`, and `enhancedCompareModels` methods.
