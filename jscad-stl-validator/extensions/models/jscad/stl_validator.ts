// Domain Service: StlValidator
// Parses and validates a binary or ASCII STL file.
// Returns a structured validation report — no swamp knowledge.
//
// Behavior updated in 2026.08.02.1 (LB2/LB4/LB5 geometry+format fixes and the
// LB3 issues[]/bounding-box amplification fix); the benign contract pins in
// the test suites below remain byte-identical.

export type Triangle = {
  normal: [number, number, number];
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
};

export type BoundingBox = {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
};

export type StlValidationReport = {
  valid: boolean;
  format: "binary" | "ascii" | "empty" | "unknown";
  triangleCount: number;
  expectedTriangleCount: number | null; // from binary header
  degenerateTriangles: number; // zero-area triangles
  issues: string[];
  boundingBox: BoundingBox | null;
};

// LB3 (domain half): cap the number of individual per-triangle NaN/Infinity
// issue strings pushed into issues[], so a hostile file with many bad
// triangles cannot make issues[] grow linearly with the triangle count.
const MAX_TRIANGLE_ISSUES = 10;

export const StlValidator = {
  validate(bytes: Uint8Array): StlValidationReport {
    const issues: string[] = [];

    if (bytes.byteLength === 0) {
      return {
        valid: false,
        format: "empty",
        triangleCount: 0,
        expectedTriangleCount: null,
        degenerateTriangles: 0,
        issues: ["File is empty"],
        boundingBox: null,
      };
    }

    // Detect format: ASCII STL starts with "solid", but many binary STLs
    // also have "solid" in their 80-byte header. Check the binary triangle
    // count against file size to disambiguate.
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    const looksAscii = header.toLowerCase() === "solid";

    if (looksAscii && bytes.byteLength >= 84) {
      // Check if file size matches binary format: 84 + triCount * 50
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const triCount = view.getUint32(80, true);
      const expectedBinarySize = 84 + triCount * 50;
      if (triCount > 0) {
        // exact size match => definitively binary (unchanged behavior)
        if (bytes.byteLength === expectedBinarySize) {
          return StlValidator._validateBinary(bytes, issues);
        }
        // LB2 fix: count > 0 but size mismatch no longer falls straight
        // through to ASCII — a corrupt binary STL whose 80-byte header
        // happens to spell "solid" has float bytes after offset 84, not
        // ASCII geometry keywords. Only treat it as ASCII if the body
        // actually looks like ASCII text.
        if (!looksLikeAsciiBody(bytes)) {
          return StlValidator._validateBinary(bytes, issues);
        }
      }
    }

    if (looksAscii) {
      return StlValidator._validateAscii(bytes, issues);
    } else {
      return StlValidator._validateBinary(bytes, issues);
    }
  },

  _validateBinary(bytes: Uint8Array, issues: string[]): StlValidationReport {
    // Binary STL: 80-byte header + 4-byte uint32 triangle count + N * 50-byte triangles
    if (bytes.byteLength < 84) {
      issues.push(
        `File too small for binary STL: ${bytes.byteLength} bytes (minimum 84)`,
      );
      return {
        valid: false,
        format: "binary",
        triangleCount: 0,
        expectedTriangleCount: null,
        degenerateTriangles: 0,
        issues,
        boundingBox: null,
      };
    }

    // Check for all-zero content (blank file)
    const nonZero = bytes.some((b) => b !== 0);
    if (!nonZero) {
      issues.push(
        "File content is all zeros — geometry was not serialized correctly",
      );
      return {
        valid: false,
        format: "binary",
        triangleCount: 0,
        expectedTriangleCount: 0,
        degenerateTriangles: 0,
        issues,
        boundingBox: null,
      };
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expectedCount = view.getUint32(80, true); // little-endian
    const expectedSize = 84 + expectedCount * 50;

    if (bytes.byteLength !== expectedSize) {
      issues.push(
        `Size mismatch: header says ${expectedCount} triangles (expected ${expectedSize} bytes) but file is ${bytes.byteLength} bytes`,
      );
    }

    const actualCount = Math.floor((bytes.byteLength - 84) / 50);
    let degenerateCount = 0;
    let nanCount = 0;
    let nanIssuesPushed = 0;

    // LB3 (domain half): compute the bounding box incrementally instead of
    // retaining a `Triangle[]` array — memory becomes O(1) in triangle count.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let validCount = 0;

    for (let i = 0; i < actualCount; i++) {
      const off = 84 + i * 50;
      const nx = view.getFloat32(off, true);
      const ny = view.getFloat32(off + 4, true);
      const nz = view.getFloat32(off + 8, true);
      const v1: [number, number, number] = [
        view.getFloat32(off + 12, true),
        view.getFloat32(off + 16, true),
        view.getFloat32(off + 20, true),
      ];
      const v2: [number, number, number] = [
        view.getFloat32(off + 24, true),
        view.getFloat32(off + 28, true),
        view.getFloat32(off + 32, true),
      ];
      const v3: [number, number, number] = [
        view.getFloat32(off + 36, true),
        view.getFloat32(off + 40, true),
        view.getFloat32(off + 44, true),
      ];

      // Check for NaN/Infinity in any coordinate (normal included — keeps
      // this branch byte-identical to the pre-2026.08.02.1 binary output).
      if (!isFiniteCoords([nx, ny, nz, ...v1, ...v2, ...v3])) {
        degenerateCount++;
        nanCount++;
        if (nanIssuesPushed < MAX_TRIANGLE_ISSUES) {
          issues.push(`Triangle ${i}: contains NaN or Infinity values`);
          nanIssuesPushed++;
        }
        continue;
      }

      if (isDegenerateTri(v1, v2, v3)) {
        degenerateCount++;
        continue;
      }

      validCount++;
      for (const v of [v1, v2, v3]) {
        if (v[0] < minX) minX = v[0];
        if (v[1] < minY) minY = v[1];
        if (v[2] < minZ) minZ = v[2];
        if (v[0] > maxX) maxX = v[0];
        if (v[1] > maxY) maxY = v[1];
        if (v[2] > maxZ) maxZ = v[2];
      }
    }

    if (actualCount === 0) {
      issues.push("No triangles found in file");
    }
    if (nanCount > MAX_TRIANGLE_ISSUES) {
      issues.push(
        `(${
          nanCount - MAX_TRIANGLE_ISSUES
        } further triangle issue(s) suppressed)`,
      );
    }
    if (degenerateCount > 0) {
      issues.push(
        `${degenerateCount} degenerate triangle(s) found (zero area or duplicate vertices)`,
      );
    }

    const bbox = validCount > 0
      ? {
        min: [minX, minY, minZ] as [number, number, number],
        max: [maxX, maxY, maxZ] as [number, number, number],
        size: [maxX - minX, maxY - minY, maxZ - minZ] as [
          number,
          number,
          number,
        ],
      }
      : null;

    return {
      valid: issues.length === 0,
      format: "binary",
      triangleCount: actualCount,
      expectedTriangleCount: expectedCount,
      degenerateTriangles: degenerateCount,
      issues,
      boundingBox: bbox,
    };
  },

  _validateAscii(bytes: Uint8Array, issues: string[]): StlValidationReport {
    const text = new TextDecoder().decode(bytes);
    const facetMatches = text.match(/facet normal/g);
    const triangleCount = facetMatches ? facetMatches.length : 0;

    if (triangleCount === 0) {
      issues.push("No facets found in ASCII STL");
    }
    if (!text.includes("endsolid")) {
      issues.push("Missing 'endsolid' terminator");
    }

    // Parse vertices for the geometry check + bounding box. A well-formed
    // ASCII facet has exactly 3 consecutive `vertex` lines; group the flat
    // capture list into triples and run the SAME finite/degenerate checks
    // as the binary path (LB4/LB5 fix). Any malformed remainder (vertex
    // count not a multiple of 3) is ignored for the geometry check.
    const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    const vertices: [number, number, number][] = [];
    let m: RegExpExecArray | null;
    while ((m = vertexRe.exec(text)) !== null) {
      vertices.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    }

    let degenerateCount = 0;
    let nanCount = 0;
    let nanIssuesPushed = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let validCount = 0;

    const wellFormedCount = Math.floor(vertices.length / 3);
    for (let i = 0; i < wellFormedCount; i++) {
      const v1 = vertices[i * 3];
      const v2 = vertices[i * 3 + 1];
      const v3 = vertices[i * 3 + 2];

      if (!isFiniteCoords([...v1, ...v2, ...v3])) {
        degenerateCount++;
        nanCount++;
        if (nanIssuesPushed < MAX_TRIANGLE_ISSUES) {
          issues.push(`Triangle ${i}: contains NaN or Infinity values`);
          nanIssuesPushed++;
        }
        continue;
      }

      if (isDegenerateTri(v1, v2, v3)) {
        degenerateCount++;
        continue;
      }

      validCount++;
      for (const v of [v1, v2, v3]) {
        if (v[0] < minX) minX = v[0];
        if (v[1] < minY) minY = v[1];
        if (v[2] < minZ) minZ = v[2];
        if (v[0] > maxX) maxX = v[0];
        if (v[1] > maxY) maxY = v[1];
        if (v[2] > maxZ) maxZ = v[2];
      }
    }

    if (nanCount > MAX_TRIANGLE_ISSUES) {
      issues.push(
        `(${
          nanCount - MAX_TRIANGLE_ISSUES
        } further triangle issue(s) suppressed)`,
      );
    }
    if (degenerateCount > 0) {
      issues.push(
        `${degenerateCount} degenerate triangle(s) found (zero area or duplicate vertices)`,
      );
    }

    const bbox = validCount > 0
      ? {
        min: [minX, minY, minZ] as [number, number, number],
        max: [maxX, maxY, maxZ] as [number, number, number],
        size: [maxX - minX, maxY - minY, maxZ - minZ] as [
          number,
          number,
          number,
        ],
      }
      : null;

    return {
      valid: issues.length === 0,
      format: "ascii",
      triangleCount,
      expectedTriangleCount: null,
      degenerateTriangles: degenerateCount,
      issues,
      boundingBox: bbox,
    };
  },
};

/** True when every coordinate in `coords` is a finite number (not NaN/Infinity). */
function isFiniteCoords(coords: number[]): boolean {
  return coords.every((c) => Number.isFinite(c));
}

/**
 * True when the triangle formed by `v1`/`v2`/`v3` is degenerate: two or more
 * identical vertices, or a near-zero cross-product magnitude (colinear,
 * pairwise-distinct points). Shared by both the binary and ASCII paths.
 */
function isDegenerateTri(
  v1: [number, number, number],
  v2: [number, number, number],
  v3: [number, number, number],
): boolean {
  if (
    (v1[0] === v2[0] && v1[1] === v2[1] && v1[2] === v2[2]) ||
    (v1[0] === v3[0] && v1[1] === v3[1] && v1[2] === v3[2]) ||
    (v2[0] === v3[0] && v2[1] === v3[1] && v2[2] === v3[2])
  ) {
    return true;
  }

  const e1 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
  const e2 = [v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]];
  const cross = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const area2 = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
  return area2 < 1e-10;
}

/**
 * LB2 fix: does the buffer's decoded text look like ASCII STL geometry?
 * Used only to disambiguate a "solid"-headed buffer whose claimed (offset-80)
 * triangle count is > 0 but does NOT match the actual buffer size — a
 * genuine corrupt/truncated binary STL has float bytes after offset 84, not
 * these keywords, so it is routed to `_validateBinary`; a genuinely-text
 * ASCII file keeps its ASCII path.
 */
function looksLikeAsciiBody(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return /facet\s+normal/i.test(text) || text.includes("endsolid");
}
