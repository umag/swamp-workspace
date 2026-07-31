# Fixture provenance

Every byte produced by `stl_builders.ts`, and every literal coordinate value
passed into it from the five test suites, is **100% SYNTHETIC** — small,
hand-chosen numbers (`0`, `1`, `2`, integer translations, and a handful of
deliberately malformed tokens like `"."` or `"1e400"`) selected only to exercise
a specific branch of `jscad/stl_validator.ts`. This mirrors the
`fidonet-msgbase` and `porkbun` backfill precedent (synthetic fixtures, no live
capture).

## What was NOT done (explicit prohibition)

`jscad_stl_validator.ts`/`jscad/stl_validator.ts` validate STL geometry that
could, in principle, come from a real 3D model. That temptation is **forbidden**
here, standing for anyone regenerating these fixtures later:

- No real CAD model's exported STL — from `@magistr/jscad-cad`, a slicer, a
  printer, Thingiverse, or anywhere else — was read, copied, or transcribed into
  this corpus.
- No real filesystem path, username, or hostname appears in the
  arbitrary-file-read / path-traversal fixtures — the "secret" file the
  adversarial suite reads is itself a synthetic fixture written by the test into
  its own per-test `Deno.makeTempDir()`, never a real system file.

## Every value is synthetic

- **Geometry**: unit-scale triangles translated along an axis (`v1=[i,0,0]`,
  `v2=[i+1,0,0]`, `v3=[i,1,0]`) or simple duplicate/colinear vertex sets chosen
  purely to trip a specific `if` branch (duplicate-vertex degenerate,
  colinear-but-distinct near-zero-area degenerate, NaN/Infinity coordinate).
  None of it represents any real manufacturable part.
- **Headers**: either all-zero (the common real-world case) or the literal ASCII
  text `"solid"` — used deliberately to exercise the
  looks-like-ASCII-but-is-binary reclassification branch and its misdetection
  failure mode, not because any real binary STL header was observed to contain
  that text.
- **Malformed tokens**: `"."` (matches the vertex regex's character class but is
  not a valid `parseFloat` numeral → `NaN`) and `"1e400"` /`"-1e400"` (a
  syntactically valid, regex-matching exponent that `parseFloat` overflows to
  `±Infinity`) are synthetic probes chosen to reach the ASCII path's missing
  finite-value checks, not captured from any real file.

## Byte-level provenance: this is a Factory, not a fixture dump

`jscad_stl_validator.ts` has no external wire format to transcribe from a spec
document — `stl_builders.ts` is a **Factory**: `encodeBinaryStl` and
`encodeAsciiStl` assemble the exact byte/text layout `jscad/stl_validator.ts`'s
`StlValidator.validate()` expects, with offsets reverse-derived directly from
reading that file (see the module docstring in `stl_builders.ts` for the offset
table). `claimedTriangleCount` is exposed independently of the real triangle
array length specifically so the adversarial suite can characterize the
header-count-vs-actual-size mismatch paths without hand-crafting raw bytes per
test.

No new npm dependency was added for fixture generation — `stl_builders.ts` uses
only `Uint8Array`/`DataView`/`TextEncoder`, all Deno/JS built-ins.
