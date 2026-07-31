# Fixture provenance

Every byte in every test fixture used by the `jscad-stl-slicer_*_test.ts` suites
is **synthetically generated** by `builders.ts` at test-run time. There is no
real-world STL file, 3D scan, CAD export, or third-party model asset embedded
anywhere in this extension or its tests.

## What `builders.ts` generates

- **Boxes** (`boxFacets`) — axis-aligned rectangular prisms built from 8
  procedurally computed corner points.
- **Prisms** (`prismFacets`) — regular N-gon prisms (cylinder approximation)
  built from `Math.cos`/`Math.sin` ring geometry.
- **Box-with-bump** (`boxWithBumpFacets`) — a body box plus a small box glued to
  one face, for asymmetric-feature fixtures.
- **Degenerate/coplanar/NaN/Infinity single triangles** — hand-specified
  3-vertex facets for adversarial coordinate fixtures.
- **ASCII-STL text** (`asciiStlText`) — a well-formed ASCII STL document
  generated from the same procedural facets, used only to demonstrate the binary
  parser's misparse of ASCII input (never a valid input to this parser).

All coordinates are small integers or simple procedural values (radii, heights,
offsets in the 1–100 range) chosen for readable, deterministic test assertions —
never sampled from or derived from any real captured geometry.

## Rule

Do not add real STL files (captured scans, downloaded models, exported CAD
parts) to this fixtures directory. If a test needs geometry not covered by the
existing builders, add a new procedural builder function to `builders.ts` rather
than checking in a binary `.stl` asset.
