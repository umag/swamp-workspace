// Synthetic binary-STL fixture Factory for @magistr/jscad-stl-slicer
// characterization tests.
//
// This is the INVERSE of the shipped parser (extensions/models/jscad/stl_slicer.ts):
// it encodes triangles into the exact byte layout `StlSlicer` reads via
// `DataView` — 80-byte header, `uint32` triangle count at offset 80 (LE), then
// per facet (50 bytes): 12-byte normal (unused by the parser, kept for
// byte-accuracy) + 3 x 12-byte vertex (x,y,z float32 LE) + 2-byte attribute
// byte count (unused). Binary-STL ONLY — the parser has no ASCII-STL path;
// `asciiStlText` below exists solely to build the ADVERSARIAL misparse
// fixture (feeding ASCII text through the binary reader), never a valid
// input.
//
// All geometry is procedurally generated (boxes, prisms, single triangles).
// No real-world STL files, 3D scans, or third-party model assets are
// embedded anywhere in this repo — see fixtures/PROVENANCE.md.

export type Vec3 = [number, number, number];
export type Facet = { normal: Vec3; v1: Vec3; v2: Vec3; v3: Vec3 };

const HEADER_BYTES = 80;
const FACET_BYTES = 50;

function faceNormalOf(_a: Vec3, _b: Vec3, _c: Vec3): Vec3 {
  // The parser never reads the normal (only vertex data at facet offsets
  // 12..47), so an exact cross-product normal is not required for any test
  // in this repo. A fixed placeholder keeps the fixture builders simple.
  return [0, 0, 0];
}

/** Encode a list of facets into a byte-accurate binary-STL buffer. */
export function encodeBinaryStl(
  facets: Facet[],
  header = "synthetic fixture — see fixtures/PROVENANCE.md",
): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES + 4 + facets.length * FACET_BYTES);
  const view = new DataView(buf.buffer);
  const headerBytes = new TextEncoder().encode(header).slice(0, HEADER_BYTES);
  buf.set(headerBytes, 0);
  view.setUint32(80, facets.length, true);

  let off = 84;
  for (const f of facets) {
    view.setFloat32(off + 0, f.normal[0], true);
    view.setFloat32(off + 4, f.normal[1], true);
    view.setFloat32(off + 8, f.normal[2], true);
    view.setFloat32(off + 12, f.v1[0], true);
    view.setFloat32(off + 16, f.v1[1], true);
    view.setFloat32(off + 20, f.v1[2], true);
    view.setFloat32(off + 24, f.v2[0], true);
    view.setFloat32(off + 28, f.v2[1], true);
    view.setFloat32(off + 32, f.v2[2], true);
    view.setFloat32(off + 36, f.v3[0], true);
    view.setFloat32(off + 40, f.v3[1], true);
    view.setFloat32(off + 44, f.v3[2], true);
    view.setUint16(off + 48, 0, true);
    off += FACET_BYTES;
  }
  return buf;
}

/** One synthetic facet from three explicit vertices. */
export function facet(v1: Vec3, v2: Vec3, v3: Vec3): Facet {
  return { normal: faceNormalOf(v1, v2, v3), v1, v2, v3 };
}

/**
 * Axis-aligned box, 12 triangles (2 per face), centered at `center` with
 * half-extents `half = [hx, hy, hz]`. Winding is not significant — the
 * parser never reads facet normals or uses winding for anything (no
 * back-face culling anywhere in stl_slicer.ts).
 */
export function boxFacets(half: Vec3, center: Vec3 = [0, 0, 0]): Facet[] {
  const [cx, cy, cz] = center;
  const [hx, hy, hz] = half;
  const p = (sx: -1 | 1, sy: -1 | 1, sz: -1 | 1): Vec3 => [
    cx + sx * hx,
    cy + sy * hy,
    cz + sz * hz,
  ];
  const p000 = p(-1, -1, -1), p001 = p(-1, -1, 1);
  const p010 = p(-1, 1, -1), p011 = p(-1, 1, 1);
  const p100 = p(1, -1, -1), p101 = p(1, -1, 1);
  const p110 = p(1, 1, -1), p111 = p(1, 1, 1);

  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Facet[] => [
    facet(a, b, c),
    facet(a, c, d),
  ];

  return [
    ...quad(p000, p010, p011, p001), // -X
    ...quad(p100, p101, p111, p110), // +X
    ...quad(p000, p001, p101, p100), // -Y
    ...quad(p010, p110, p111, p011), // +Y
    ...quad(p000, p100, p110, p010), // -Z
    ...quad(p001, p011, p111, p101), // +Z
  ];
}

/**
 * A regular N-sided prism standing along the Z axis (approximates a
 * cylinder): `segments` side quads (2 tris each) + fan-triangulated top and
 * bottom caps. Rotationally near-symmetric about Z for PCA/symmetry
 * fixtures.
 */
export function prismFacets(
  radius: number,
  height: number,
  segments: number,
  center: Vec3 = [0, 0, 0],
): Facet[] {
  const [cx, cy, cz] = center;
  const zBot = cz - height / 2;
  const zTop = cz + height / 2;
  const ring = (z: number): Vec3[] =>
    Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2;
      return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, z] as Vec3;
    });
  const bot = ring(zBot);
  const top = ring(zTop);
  const facets: Facet[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    facets.push(facet(bot[i], bot[j], top[j]));
    facets.push(facet(bot[i], top[j], top[i]));
  }
  const botCenter: Vec3 = [cx, cy, zBot];
  const topCenter: Vec3 = [cx, cy, zTop];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    facets.push(facet(botCenter, bot[j], bot[i]));
    facets.push(facet(topCenter, top[i], top[j]));
  }
  return facets;
}

/**
 * A regular N-sided prism, subdivided into `rings` height segments (so
 * vertices exist at `rings + 1` distinct Z levels, not just top+bottom).
 * `slice`/`extractProfile`/`analyzeSymmetry`/`multiSlice` all bin by
 * discrete VERTEX height rather than continuous surface intersection, so a
 * plain 2-level `prismFacets` starves them of data between the two rings;
 * this variant gives those height-binned functions enough samples to
 * produce a meaningful (non-degenerate) profile/symmetry score.
 */
export function stackedPrismFacets(
  radius: number,
  height: number,
  segments: number,
  rings: number,
  center: Vec3 = [0, 0, 0],
): Facet[] {
  const [cx, cy, cz] = center;
  const zBot = cz - height / 2;
  const zStep = height / rings;
  const ringAt = (z: number): Vec3[] =>
    Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2;
      return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, z] as Vec3;
    });
  const levels = Array.from(
    { length: rings + 1 },
    (_, i) => ringAt(zBot + i * zStep),
  );
  const facets: Facet[] = [];
  for (let r = 0; r < rings; r++) {
    const bot = levels[r], top = levels[r + 1];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      facets.push(facet(bot[i], bot[j], top[j]));
      facets.push(facet(bot[i], top[j], top[i]));
    }
  }
  const botCenter: Vec3 = [cx, cy, zBot];
  const topCenter: Vec3 = [cx, cy, zBot + rings * zStep];
  const botRing = levels[0], topRing = levels[rings];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    facets.push(facet(botCenter, botRing[j], botRing[i]));
    facets.push(facet(topCenter, topRing[i], topRing[j]));
  }
  return facets;
}

/**
 * An axis-aligned box whose 4 side walls are subdivided into `zLevels`
 * height segments (real intermediate vertices at each level), not just the
 * 8 corners `boxFacets` produces. `slice`/`extractProfile`/`analyzeSymmetry`/
 * `multiSlice`/`detectFeatures`/`decompose` all bin by discrete VERTEX
 * height, so a plain corner-only box only ever has data at its top/bottom Z
 * — this variant gives those functions real data at intermediate heights.
 * Top/bottom caps stay flat (2 triangles each); only the side walls need
 * the extra levels for this purpose.
 */
export function stackedBoxFacets(
  half: Vec3,
  zLevels: number,
  center: Vec3 = [0, 0, 0],
): Facet[] {
  const [cx, cy, cz] = center;
  const [hx, hy, hz] = half;
  const zBot = cz - hz, zTop = cz + hz;
  const zStep = (zTop - zBot) / zLevels;
  const ring = (z: number): Vec3[] => [
    [cx - hx, cy - hy, z],
    [cx + hx, cy - hy, z],
    [cx + hx, cy + hy, z],
    [cx - hx, cy + hy, z],
  ];
  const levels = Array.from(
    { length: zLevels + 1 },
    (_, i) => ring(zBot + i * zStep),
  );
  const facets: Facet[] = [];
  for (let r = 0; r < zLevels; r++) {
    const bot = levels[r], top = levels[r + 1];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      facets.push(facet(bot[i], bot[j], top[j]));
      facets.push(facet(bot[i], top[j], top[i]));
    }
  }
  const bot0 = levels[0], top0 = levels[zLevels];
  facets.push(facet(bot0[0], bot0[2], bot0[1]));
  facets.push(facet(bot0[0], bot0[3], bot0[2]));
  facets.push(facet(top0[0], top0[1], top0[2]));
  facets.push(facet(top0[0], top0[2], top0[3]));
  return facets;
}

/**
 * A body box with a small protruding "bump" box glued onto the +X face
 * within a height (Z) sub-range — an asymmetric feature for
 * detectFeatures/decompose/analyzeSymmetry fixtures.
 */
export function boxWithBumpFacets(
  bodyHalf: Vec3,
  bumpHalf: Vec3,
  bumpCenterZ: number,
  center: Vec3 = [0, 0, 0],
): Facet[] {
  const body = boxFacets(bodyHalf, center);
  const bumpCenter: Vec3 = [
    center[0] + bodyHalf[0] + bumpHalf[0],
    center[1],
    bumpCenterZ,
  ];
  const bump = boxFacets(bumpHalf, bumpCenter);
  return [...body, ...bump];
}

/**
 * Like `boxWithBumpFacets`, but both body and bump are `stackedBoxFacets`
 * (subdivided side walls), so height-binned functions (`multiSlice`,
 * `detectFeatures`, `decompose`) see the bump across several consecutive
 * slice bins instead of only its two end corners.
 */
export function stackedBoxWithBumpFacets(
  bodyHalf: Vec3,
  bumpHalf: Vec3,
  bumpCenterZ: number,
  bodyLevels: number,
  bumpLevels: number,
  center: Vec3 = [0, 0, 0],
): Facet[] {
  const body = stackedBoxFacets(bodyHalf, bodyLevels, center);
  const bumpCenter: Vec3 = [
    center[0] + bodyHalf[0] + bumpHalf[0],
    center[1],
    bumpCenterZ,
  ];
  const bump = stackedBoxFacets(bumpHalf, bumpLevels, bumpCenter);
  return [...body, ...bump];
}

/**
 * A regular octahedron (6 vertices at +/-r along each axis, 8 triangular
 * faces, one triangle per face — no shared-face diagonal-split weighting
 * bias). Each vertex touches exactly 4 faces, so the per-vertex-occurrence
 * covariance this parser computes is EXACTLY diagonal with EQUAL diagonal
 * entries: a genuinely (not just nominally) isotropic fixture for PCA
 * lability characterization (LOW-11), unlike an axis-aligned box (whose
 * a-b-c/a-c-d quad-diagonal triangulation weights two opposite corners
 * more heavily than the other six — see the contract-fixture suite).
 */
export function octahedronFacets(r: number, center: Vec3 = [0, 0, 0]): Facet[] {
  const [cx, cy, cz] = center;
  const px: Vec3 = [cx + r, cy, cz], nx: Vec3 = [cx - r, cy, cz];
  const py: Vec3 = [cx, cy + r, cz], ny: Vec3 = [cx, cy - r, cz];
  const pz: Vec3 = [cx, cy, cz + r], nz: Vec3 = [cx, cy, cz - r];
  return [
    facet(px, py, pz),
    facet(py, nx, pz),
    facet(nx, ny, pz),
    facet(ny, px, pz),
    facet(py, px, nz),
    facet(nx, py, nz),
    facet(ny, nx, nz),
    facet(px, ny, nz),
  ];
}

/** A single triangle lying exactly flat in the Z=z plane (coplanar, LOW-9). */
export function coplanarTriangleFacets(z: number, size = 10): Facet[] {
  return [facet([-size, -size, z], [size, -size, z], [0, size, z])];
}

/** A single degenerate (zero-area, coplanar) triangle: two vertices coincide. */
export function degenerateTriangleFacets(z = 0): Facet[] {
  return [facet([0, 0, z], [0, 0, z], [5, 5, z])];
}

/**
 * A degenerate (zero-area) triangle that is NOT coplanar with any single Z
 * value: two coincident vertices at `zBase`, the third at `zApex`. Isolates
 * "degenerate triangle" handling from "coplanar triangle" handling (LOW-9)
 * for coverage tests that slice between `zBase` and `zApex`.
 */
export function degenerateSpikeTriangleFacets(
  zBase: number,
  zApex: number,
): Facet[] {
  return [facet([0, 0, zBase], [0, 0, zBase], [5, 5, zApex])];
}

/** A facet whose vertices contain NaN coordinates (MED-5). */
export function nanFacets(): Facet[] {
  return [facet([0, 0, 0], [NaN, 1, 0], [1, 0, 0])];
}

/** A facet whose vertices contain +/-Infinity coordinates (MED-5). */
export function infFacets(): Facet[] {
  return [facet([0, 0, 0], [Infinity, 1, 0], [1, -Infinity, 0])];
}

/** Header + triCount=0, no facet bytes at all — a valid but empty mesh (MED-6). */
export function emptyMeshBytes(): Uint8Array {
  return encodeBinaryStl([]);
}

/**
 * Patch the triCount field (offset 80, uint32 LE) of an already-encoded
 * binary-STL buffer to an arbitrary value, WITHOUT touching the facet bytes
 * — for HIGH-2 (triCount unvalidated against byteLength) fixtures. Returns a
 * copy; does not mutate the input.
 */
export function withTriCount(bytes: Uint8Array, count: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint32(80, count, true);
  return copy;
}

/** Truncate a buffer to `length` bytes — for HIGH-2 short-file fixtures. */
export function truncate(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.slice(0, length);
}

/**
 * A well-formed ASCII-STL text document (NOT a valid input to this parser —
 * `StlSlicer` is binary-only). Used exclusively to build the MED-4 adversarial
 * fixture: feeding legitimate ASCII-STL bytes through the binary reader
 * misinterprets bytes [80,84) of the text as the triangle count.
 */
export function asciiStlText(
  facets: Facet[],
  solidName = "fixture",
): Uint8Array {
  const lines: string[] = [`solid ${solidName}`];
  for (const f of facets) {
    lines.push(`facet normal ${f.normal.join(" ")}`);
    lines.push("outer loop");
    lines.push(`vertex ${f.v1.join(" ")}`);
    lines.push(`vertex ${f.v2.join(" ")}`);
    lines.push(`vertex ${f.v3.join(" ")}`);
    lines.push("endloop");
    lines.push("endfacet");
  }
  lines.push(`endsolid ${solidName}`);
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

/**
 * Write `bytes` to a fresh file inside a per-call temp directory and return
 * both the file path and the temp dir (so a path-traversal characterization
 * test can construct an escape target that stays confined to that temp
 * tree — never a real filesystem path).
 */
export async function withTempStlFile<T>(
  bytes: Uint8Array,
  fileName: string,
  fn: (filePath: string, tempDir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "jscad-stl-slicer-fixture-" });
  try {
    const filePath = `${dir}/${fileName}`;
    await Deno.writeFile(filePath, bytes);
    return await fn(filePath, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
