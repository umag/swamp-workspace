# Changelog

## 2026.08.19.1

- Version bump and smoke test

## 2026.08.02.1

Real-fixes the four remaining latent bugs (LB2–LB5) tracked in the LOCAL
`jscad-stl-validator-latent-bugs` issue-lifecycle model (NEVER a swamp.club Lab
issue). LB1 (path traversal, fixed in `2026.08.01.1`) is untouched. The pure
domain service `extensions/models/jscad/stl_validator.ts` — previously declared
BYTE-FROZEN — is deliberately un-frozen for these fixes; every benign contract
pin in the test suites stays byte-identical.

**Behavior changes:**

- **LB2 (format misdetection, MEDIUM) — FIXED.** A binary buffer whose 80-byte
  header happens to spell `"solid"` AND whose claimed (offset-80) triangle count
  does NOT match the actual buffer size is now correctly classified as
  **binary** (restoring the real "Size mismatch" diagnosis and the actual
  triangle data), instead of falling through to the ASCII parser. The
  discriminator: when the claimed count is `> 0` but the size doesn't match
  exactly, the buffer's decoded text is checked for ASCII geometry keywords
  (`facet normal` / `endsolid`); only a buffer that genuinely looks like ASCII
  text keeps the ASCII path. The existing positive/negative reclassification
  pins (exact-size-match → binary; claimed-count-0 → ASCII) are unaffected.
- **LB3 (unbounded read + issues[] amplification, MEDIUM) — FIXED**, in two
  independent halves:
  - _Domain half:_ `issues[]` no longer grows linearly with a hostile triangle
    count. At most 10 individual
    `Triangle i: contains NaN or
    Infinity values` strings are pushed; beyond
    that, one `(<k> further triangle issue(s) suppressed)` note is added, and
    the existing `<n> degenerate triangle(s) found ...` summary is always kept.
    The bounding box is now computed with incremental `min`/`max` accumulators
    instead of retaining a `Triangle[]` array — memory is O(1) in triangle
    count. Output is byte-identical for triangle counts at or below the cap
    (single-NaN/single-Infinity pins unaffected).
  - _Application half:_ added a new **defaulted** global argument `maxFileBytes`
    (default `268435456`, 256 MiB). `validateFile` now `Deno.stat`s the resolved
    path and rejects with
    `Refusing to read "<path>": file exceeds maxFileBytes (<size> > <cap>)`
    BEFORE calling `Deno.readFile`, so an oversized file is never buffered into
    memory. Read only from `context.globalArgs` (never per-call arguments),
    mirroring the `allowedRoots` trust-boundary convention. Order is
    `resolveStlPath` (policy) → `Deno.stat` size check → `Deno.readFile`,
    preserving the LB1 traversal pin, the missing-file pin (stat NotFound →
    `Cannot read`), and the directory pin (stat ok + small size → `readFile`
    EISDIR → `Cannot read`).
- **LB4 (weak ASCII validation, LOW) — FIXED.** ASCII validation now parses
  facets into triangles (grouping vertices in consecutive triples) and runs the
  SAME degenerate-triangle check as binary (duplicate-vertex OR near-zero
  cross-product area), via a shared, non-exported `isDegenerateTri` helper. A
  fully degenerate (duplicate-vertex) ASCII facet is now reported
  `valid: false`, `degenerateTriangles: 1`, with the same
  `<n> degenerate triangle(s) found ...` summary as binary, and excluded from
  the bounding box. Malformed vertex remainders (count not a multiple of 3) are
  ignored for the geometry check. The canonical (non-degenerate, finite) ASCII
  contract pins in `jscad/stl_validator_test.ts` are byte-identical.
- **LB5 (NaN/Infinity asymmetry, binary vs ASCII, LOW) — FIXED.** Folded into
  the LB4 rewrite: ASCII vertices now run the SAME `isFinite`/`isNaN` guard as
  binary, via a shared, non-exported `isFiniteCoords` helper. A non-finite ASCII
  triangle is flagged with a `Triangle i: contains NaN or Infinity
  values`
  issue (subject to the LB3 cap), counted as degenerate, and EXCLUDED from the
  bounding box — so an Infinity-valued coordinate can no longer poison the
  bounding box's max/min, and an all-NaN facet can no longer produce the
  nonsensical inverted `min:[Infinity,...]`/`max:[-Infinity,...]` box. Binary
  and ASCII now classify an identical NaN vertex equivalently.
- `extensions/models/jscad_stl_validator.ts`: model `version` bumped to
  `2026.08.02.1`. Added an identity `upgrades[]` entry (the model previously had
  none) — the only `globalArguments` change is the new defaulted `maxFileBytes`
  field, so existing instances re-parse cleanly with zod filling the default;
  the upgrade transform is `(old) => old`.
- `manifest.yaml` version bumped to `2026.08.02.1` in sync.
- Test suites: flipped the four buggy pins in
  `jscad_stl_validator_adversarial_test.ts` (LB2, LB3, LB4, two LB5 cases) to
  assert the corrected behavior (relabelled `pin:` → `fix:`). Added: a
  corrupt-but-textual coverage case locking the LB2 discriminator on the ASCII
  side (`jscad_stl_validator_coverage_test.ts`); ASCII duplicate-vertex and
  colinear-near-zero-area degenerate coverage cases, parity with the existing
  binary coverage cases; a binary-vs-ASCII NaN symmetry test; and, in
  `jscad_stl_validator_methods_test.ts`, `validateFile` accept/reject tests for
  a small `maxFileBytes` global arg plus a "smuggled per-call `maxFileBytes` has
  no effect" test mirroring the existing `allowedRoots` smuggle test. Verified
  the property suite at `FC_NUM_RUNS=5000` with no flakes before landing.
  Reworded the now-false "BYTE-FROZEN" docstrings in all five test-suite headers
  and the `quality.yaml` header comment.
- README.md: bumped the example `typeVersion`; documented `maxFileBytes` beside
  `allowedRoots`; noted that ASCII validation now performs the same
  degenerate/finite checks as binary.
- `quality.yaml`: re-stamped from a real
  `swamp extension quality
  manifest.yaml --json` run; unchanged Grade A (no
  new dependencies).

## 2026.08.01.1

Fixes the HIGH-severity path-traversal / arbitrary-file-read finding (LB1) in
`validateFile`, tracked in the LOCAL `jscad-stl-validator-latent-bugs`
issue-lifecycle model (NEVER a swamp.club Lab issue). `validateFile` is an
operator-supplied-absolute-path method by design; this fix is defense in depth
for any future less-trusted exposure.

**Behavior change:** `validateFile` now rejects any `filePath` that is not
absolute, and any `filePath` containing a literal `.` or `..` path segment —
previously such a path (e.g. a traversal-shaped path) was read verbatim with no
confinement at all. The traversal/absolute-path check runs BEFORE any filesystem
access, so a traversal attempt against a nonexistent target is still refused as
a policy violation, never silently masked by a "file not found" error.
Legitimate callers passing a clean absolute path (as shown in this README's
examples) are unaffected.

- Added `extensions/models/jscad/safe_path.ts` — a new infrastructure guard,
  `resolveStlPath`, implementing the always-on checks above plus
  canonicalization via `Deno.realPath`. The pure domain service
  `jscad/stl_validator.ts` stays BYTE-FROZEN; path safety is an infrastructure
  concern, kept out of the domain service.
- Added an OPT-IN `allowedRoots` global argument (default `[]`, read via
  `context.globalArgs` — never the per-call arguments) that confines
  `validateFile` to one or more operator-set root directories, using
  canonicalized (`Deno.realPath`'d) separator-boundary prefix matching so a
  sibling directory sharing a name prefix (`/rootFOO` vs. `/root`) or a
  symlinked root cannot be mistaken for containment. Empty `allowedRoots` (the
  default) preserves the historical unconfined contract.
- `extensions/models/jscad_stl_validator.ts`: `validateFile` now resolves
  `args.filePath` through `resolveStlPath` before calling `Deno.readFile`. Error
  messages still key to the ORIGINAL `args.filePath` (not the canonicalized
  path), so the existing missing-file/directory-path `Cannot read "<path>"`
  throw-tests stay green; policy violations get a distinct
  `Refusing to read "<path>": ...` message. Model `version` bumped to
  `2026.08.01.1`.
- `manifest.yaml` version bumped to `2026.08.01.1` in sync; added
  `extensions/models/jscad/safe_path_test.ts` to `additionalFiles`.
  `deno.json`'s `check` task extended to typecheck `jscad/safe_path.ts` +
  `jscad/safe_path_test.ts`.
- Test suite: added `extensions/models/jscad/safe_path_test.ts` (11 unit tests
  covering reject-relative, reject-`.`/`..`-segment including the
  nonexistent-traversal-target ordering guarantee, accept-clean-absolute,
  `allowedRoots` accept/reject, separator-boundary `/rootFOO`-vs-`/root`,
  symlink-escape rejection, and root/target canonicalization). Flipped the LB1
  "`../` traversal path read verbatim" pin in
  `jscad_stl_validator_adversarial_test.ts` to assert rejection; relabeled the
  "no base dir, two unrelated roots both succeed" pin from a HIGH bug-pin to a
  `regression:`-prefixed default-contract test (still asserts both calls succeed
  — that is the intended behavior when `allowedRoots` is not configured). Added
  `allowedRoots` accept/deny cases plus a test proving a smuggled per-call
  `args.allowedRoots` has no effect to `jscad_stl_validator_methods_test.ts`.
  All prior binary/ASCII happy paths and the missing-file/directory-path
  throw-path tests are unchanged and still green.
- README.md: documented the `validateFile` operator-trust boundary and the
  opt-in `allowedRoots` confinement, including the residual "report reflects
  file bytes" oracle risk to keep in mind when narrowing `allowedRoots`.
- LB2/LB3/LB4/LB5 were, at the time of this release, pinned as characterized
  (not fixed) latent bugs — out of scope for this fix, tracked in the same
  issue-lifecycle model. **All four were subsequently fixed in `2026.08.02.1`**
  (see above). The sibling `jscad-stl-slicer` extension shares the same
  unconfined-path pattern; deliberately NOT fixed here — tracked as its own
  follow-up.

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
- 5 already-shipped latent bugs were PINNED at the time of this release
  (characterized as then-CURRENT behavior, not fixed) and tracked in the LOCAL
  `jscad-stl-validator-latent-bugs` issue-lifecycle model (NEVER filed to the
  swamp.club Lab). **LB1 was fixed in `2026.08.01.1`; LB2–LB5 were fixed in
  `2026.08.02.1`** — none remain latent:
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
