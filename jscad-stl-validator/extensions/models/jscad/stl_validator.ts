// Domain Service: StlValidator
// Parses and validates a binary or ASCII STL file.
// Returns a structured validation report — no swamp knowledge.

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
      if (triCount > 0 && bytes.byteLength === expectedBinarySize) {
        return StlValidator._validateBinary(bytes, issues);
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
    const triangles: Triangle[] = [];
    let degenerateCount = 0;

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

      // Check for NaN/Infinity in any coordinate
      const coords = [nx, ny, nz, ...v1, ...v2, ...v3];
      if (coords.some((c) => !isFinite(c) || isNaN(c))) {
        issues.push(`Triangle ${i}: contains NaN or Infinity values`);
        degenerateCount++;
        continue;
      }

      // Check for degenerate triangle (zero area — two or more identical vertices)
      if (
        (v1[0] === v2[0] && v1[1] === v2[1] && v1[2] === v2[2]) ||
        (v1[0] === v3[0] && v1[1] === v3[1] && v1[2] === v3[2]) ||
        (v2[0] === v3[0] && v2[1] === v3[1] && v2[2] === v3[2])
      ) {
        degenerateCount++;
        continue;
      }

      // Check cross product for zero-area via near-zero normal magnitude
      const e1 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
      const e2 = [v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]];
      const cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const area2 = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
      if (area2 < 1e-10) {
        degenerateCount++;
        continue;
      }

      triangles.push({ normal: [nx, ny, nz], v1, v2, v3 });
    }

    if (actualCount === 0) {
      issues.push("No triangles found in file");
    }
    if (degenerateCount > 0) {
      issues.push(
        `${degenerateCount} degenerate triangle(s) found (zero area or duplicate vertices)`,
      );
    }

    const bbox = triangles.length > 0 ? computeBoundingBox(triangles) : null;

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

    // Parse vertices for bounding box
    const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    const vertices: [number, number, number][] = [];
    let m: RegExpExecArray | null;
    while ((m = vertexRe.exec(text)) !== null) {
      vertices.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    }

    const bbox = vertices.length > 0
      ? computeBoundingBoxFromVerts(vertices)
      : null;

    return {
      valid: issues.length === 0,
      format: "ascii",
      triangleCount,
      expectedTriangleCount: null,
      degenerateTriangles: 0,
      issues,
      boundingBox: bbox,
    };
  },
};

function computeBoundingBox(triangles: Triangle[]): BoundingBox {
  const verts = triangles.flatMap((t) => [t.v1, t.v2, t.v3]);
  return computeBoundingBoxFromVerts(verts);
}

function computeBoundingBoxFromVerts(
  verts: [number, number, number][],
): BoundingBox {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of verts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}
