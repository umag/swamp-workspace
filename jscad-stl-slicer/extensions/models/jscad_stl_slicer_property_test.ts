/**
 * Property-based tests (fast-check) for @magistr/jscad-stl-slicer.
 *
 * Every property drives `StlSlicer.<fn>(bytes, ...)` directly against a
 * byte-accurate synthetic mesh built from an arbitrary list of facets
 * (`fixtures/builders.ts` `encodeBinaryStl`), honoring `FC_NUM_RUNS` for the
 * nightly soak (`deno task test:soak`). `stl_slicer.ts` is BYTE-FROZEN.
 *
 * Arbitraries generate FINITE, moderate-magnitude coordinates only (the
 * "happy path" invariants below are about a well-formed byte layout with
 * arbitrary geometry, not malformed bytes) -- NaN/Infinity/huge-triCount/
 * ASCII/empty-mesh adversarial cases live in the adversarial suite, never
 * here, so this suite cannot flake on an over-strong invariant.
 *
 * Invariants:
 *  (a) the parser never throws across slice/principalAxes/analyzeSymmetry/
 *      multiSlice/detectFeatures/decompose/sixViews, for ANY arbitrary
 *      finite-coordinate mesh (0-20 facets).
 *  (b) slice() is internally consistent: trianglesIntersected ===
 *      segments.length, and never exceeds the facet count.
 *  (c) multiSlice()'s slice heights are always in non-decreasing order
 *      (layer z-ordering), for any generated mesh/axis/sliceCount.
 *  (d) sixViews()'s reported AABB conserves every input vertex: no vertex
 *      coordinate (after the float32 round-trip through the STL encoding)
 *      falls outside the reported [min,max] bounds on its axis.
 */
import fc from "npm:fast-check@4.8.0";
import { type Axis, StlSlicer } from "./jscad/stl_slicer.ts";
import { encodeBinaryStl, facet, type Vec3 } from "./fixtures/builders.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(100) };

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbCoord = fc.float({
  min: -1000,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});
const arbVec3: fc.Arbitrary<Vec3> = fc.tuple(arbCoord, arbCoord, arbCoord);
const arbFacetT = fc.tuple(arbVec3, arbVec3, arbVec3).map((
  [v1, v2, v3],
) => facet(v1, v2, v3));
const arbMesh = fc.array(arbFacetT, { minLength: 0, maxLength: 20 });
const arbAxis: fc.Arbitrary<Axis> = fc.constantFrom("X", "Y", "Z");
const arbZ = fc.float({
  min: -1000,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});
const arbSliceCount = fc.integer({ min: 1, max: 20 });

function others(axis: Axis): [Axis, Axis] {
  return (["X", "Y", "Z"] as Axis[]).filter((a) => a !== axis) as [
    Axis,
    Axis,
  ];
}

// ---------------------------------------------------------------------------
// (a) never throws on arbitrary finite-coordinate meshes
// ---------------------------------------------------------------------------

Deno.test("property: the parser never throws across slice/principalAxes/analyzeSymmetry/multiSlice/detectFeatures/decompose/sixViews, for any arbitrary finite-coordinate mesh", () => {
  fc.assert(
    fc.property(arbMesh, arbZ, arbAxis, (facets, z, axis) => {
      const bytes = encodeBinaryStl(facets);
      const [w, d] = others(axis);
      StlSlicer.slice(bytes, z);
      StlSlicer.principalAxes(bytes);
      StlSlicer.analyzeSymmetry(bytes);
      StlSlicer.multiSlice(bytes, axis, w, d, 5);
      StlSlicer.detectFeatures(bytes, axis, 5);
      StlSlicer.decompose(bytes, axis, 5);
      StlSlicer.sixViews(bytes);
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) slice() internal consistency
// ---------------------------------------------------------------------------

Deno.test("property: slice()'s trianglesIntersected always equals segments.length and never exceeds the facet count", () => {
  fc.assert(
    fc.property(arbMesh, arbZ, (facets, z) => {
      const bytes = encodeBinaryStl(facets);
      const result = StlSlicer.slice(bytes, z);
      if (result.trianglesIntersected !== result.segments.length) return false;
      return result.trianglesIntersected <= facets.length;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) layer z-ordering
// ---------------------------------------------------------------------------

Deno.test("property: multiSlice()'s slice heights are always in non-decreasing order", () => {
  fc.assert(
    fc.property(
      arbMesh.filter((f) => f.length > 0),
      arbAxis,
      arbSliceCount,
      (facets, axis, sliceCount) => {
        const bytes = encodeBinaryStl(facets);
        const [w, d] = others(axis);
        const result = StlSlicer.multiSlice(bytes, axis, w, d, sliceCount);
        for (let i = 1; i < result.slices.length; i++) {
          const prev = result.slices[i - 1].height;
          const curr = result.slices[i].height;
          if (Number.isNaN(prev) || Number.isNaN(curr)) continue;
          if (curr < prev) return false;
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) bounding-box conservation
// ---------------------------------------------------------------------------

Deno.test("property: sixViews()'s reported AABB conserves every input vertex (after the float32 round-trip), on every axis", () => {
  fc.assert(
    fc.property(
      arbMesh.filter((f) => f.length > 0),
      (facets) => {
        const bytes = encodeBinaryStl(facets);
        const { bounds } = StlSlicer.sixViews(bytes);
        const eps = 1e-3;
        for (const f of facets) {
          for (const v of [f.v1, f.v2, f.v3]) {
            const [x, y, z] = [
              Math.fround(v[0]),
              Math.fround(v[1]),
              Math.fround(v[2]),
            ];
            if (x < bounds.minX - eps || x > bounds.maxX + eps) return false;
            if (y < bounds.minY - eps || y > bounds.maxY + eps) return false;
            if (z < bounds.minZ - eps || z > bounds.maxZ + eps) return false;
          }
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});
