/**
 * Synthetic fixture Factory for `@magistr/jscad-stl-validator` — the inverse
 * of `jscad/stl_validator.ts`'s parsers. Builds byte-accurate binary and
 * ASCII STL buffers so the test suites can drive `StlValidator.validate()`
 * (and the swamp methods that wrap it) over REAL bytes, no stubbing of the
 * parser itself.
 *
 * Binary STL layout (matches `jscad/stl_validator.ts` exactly, byte-frozen):
 *   - offset 0..79   : 80-byte header (arbitrary content)
 *   - offset 80..83  : uint32 LE — claimed triangle count
 *   - offset 84 + i*50, for i in [0, actualCount): one 50-byte triangle:
 *       +0  normal.x   float32 LE       +24 v2.x  float32 LE
 *       +4  normal.y   float32 LE       +28 v2.y  float32 LE
 *       +8  normal.z   float32 LE       +32 v2.z  float32 LE
 *       +12 v1.x       float32 LE       +36 v3.x  float32 LE
 *       +16 v1.y       float32 LE       +40 v3.y  float32 LE
 *       +20 v1.z       float32 LE       +44 v3.z  float32 LE
 *       +48 attribute byte count, uint16 LE (unused by the parser)
 *   `actualCount = Math.floor((byteLength - 84) / 50)` is what the parser's
 *   read loop is actually bounded by — NOT the claimed count at offset 80.
 *   `encodeBinaryStl` lets a test set the claimed count independently of the
 *   real triangle array length, to characterize that mismatch.
 *
 * ASCII STL is a plain text format (`solid <name>` ... `facet normal ...` /
 * `outer loop` / `vertex x y z` * 3 / `endloop` / `endfacet` ... `endsolid`).
 * `encodeAsciiStl` accepts `string | number` per coordinate so a test can
 * inject a regex-matching-but-not-a-number token (e.g. `"."`, which matches
 * the parser's `[-\d.eE+]+` vertex-capture character class but is not a
 * valid `parseFloat` numeral, so it decodes to `NaN`) without needing the
 * literal words "NaN"/"Infinity" (those words don't match the parser's
 * vertex regex character class at all, since it has no letters other than
 * `e`/`E` — an overflowing exponent like `"1e400"` is the regex-legal way to
 * inject `Infinity`).
 *
 * All fixture content below and in every test file that calls these builders
 * is 100% SYNTHETIC — see fixtures/PROVENANCE.md.
 */

export type TriangleSpec = {
  normal?: [number, number, number];
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
};

export const DEFAULT_TRIANGLE: TriangleSpec = {
  normal: [0, 0, 1],
  v1: [0, 0, 0],
  v2: [1, 0, 0],
  v3: [0, 1, 0],
};

export type BinaryStlSpec = {
  /** Up to 80 bytes; string is ASCII-encoded. Rest of the header is zero. */
  header?: Uint8Array | string;
  /** Value written at offset 80 (defaults to `triangles.length`). */
  claimedTriangleCount?: number;
  triangles: TriangleSpec[];
};

/** Builds a byte-accurate binary STL buffer per the layout above. */
export function encodeBinaryStl(spec: BinaryStlSpec): Uint8Array {
  const { header, triangles } = spec;
  const claimed = spec.claimedTriangleCount ?? triangles.length;
  const size = 84 + triangles.length * 50;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  if (header instanceof Uint8Array) {
    bytes.set(header.subarray(0, Math.min(80, header.length)), 0);
  } else if (typeof header === "string") {
    const enc = new TextEncoder().encode(header);
    bytes.set(enc.subarray(0, Math.min(80, enc.length)), 0);
  }

  view.setUint32(80, claimed >>> 0, true);

  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const off = 84 + i * 50;
    const [nx, ny, nz] = t.normal ?? [0, 0, 1];
    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    view.setFloat32(off + 12, t.v1[0], true);
    view.setFloat32(off + 16, t.v1[1], true);
    view.setFloat32(off + 20, t.v1[2], true);
    view.setFloat32(off + 24, t.v2[0], true);
    view.setFloat32(off + 28, t.v2[1], true);
    view.setFloat32(off + 32, t.v2[2], true);
    view.setFloat32(off + 36, t.v3[0], true);
    view.setFloat32(off + 40, t.v3[1], true);
    view.setFloat32(off + 44, t.v3[2], true);
    view.setUint16(off + 48, 0, true);
  }

  return bytes;
}

/** Convenience: N valid, non-degenerate, distinct triangles (translated along x). */
export function nTriangles(count: number): TriangleSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    normal: [0, 0, 1],
    v1: [i, 0, 0],
    v2: [i + 1, 0, 0],
    v3: [i, 1, 0],
  }));
}

export type Coord = number | string;

export type FacetSpec = {
  normal?: [Coord, Coord, Coord];
  v1: [Coord, Coord, Coord];
  v2: [Coord, Coord, Coord];
  v3: [Coord, Coord, Coord];
};

export type AsciiStlSpec = {
  solidName?: string;
  facets: FacetSpec[];
  /** default true */
  includeEndsolid?: boolean;
};

function fmt(n: Coord): string {
  return typeof n === "string" ? n : String(n);
}

/** Builds an ASCII STL text buffer matching the parser's expected tokens. */
export function encodeAsciiStl(spec: AsciiStlSpec): Uint8Array {
  const name = spec.solidName ?? "test";
  const includeEndsolid = spec.includeEndsolid ?? true;
  const lines: string[] = [`solid ${name}`];
  for (const f of spec.facets) {
    const [nx, ny, nz] = f.normal ?? [0, 0, 1];
    lines.push(`facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
    lines.push("  outer loop");
    for (const v of [f.v1, f.v2, f.v3]) {
      lines.push(`    vertex ${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`);
    }
    lines.push("  endloop");
    lines.push("endfacet");
  }
  if (includeEndsolid) {
    lines.push(`endsolid ${name}`);
  }
  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * Writes `bytes` to a fresh per-test temp directory as `<name>` (default
 * `model.stl`), invokes `fn` with the absolute file path, then always
 * removes the temp directory — even if `fn` throws/rejects.
 */
export async function withTempStlFile(
  bytes: Uint8Array,
  fn: (filePath: string, root: string) => Promise<void>,
  name = "model.stl",
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "jscad-stl-validator-" });
  try {
    const filePath = `${root}/${name}`;
    await Deno.writeFile(filePath, bytes);
    await fn(filePath, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
