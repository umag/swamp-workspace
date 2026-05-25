import { assertEquals } from "jsr:@std/assert@1";
import { StlValidator } from "./stl_validator.ts";

// Helper: build a minimal valid binary STL with N triangles
function buildBinaryStl(triangleCount: number): Uint8Array {
  const size = 84 + triangleCount * 50;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  // 80-byte header (zeros)
  view.setUint32(80, triangleCount, true);

  for (let i = 0; i < triangleCount; i++) {
    const off = 84 + i * 50;
    // normal: [0, 0, 1]
    view.setFloat32(off, 0, true);
    view.setFloat32(off + 4, 0, true);
    view.setFloat32(off + 8, 1, true);
    // v1: [0, 0, 0]
    view.setFloat32(off + 12, 0, true);
    view.setFloat32(off + 16, 0, true);
    view.setFloat32(off + 20, 0, true);
    // v2: [1, 0, 0]
    view.setFloat32(off + 24, 1, true);
    view.setFloat32(off + 28, 0, true);
    view.setFloat32(off + 32, 0, true);
    // v3: [0, 1, 0]
    view.setFloat32(off + 36, 0, true);
    view.setFloat32(off + 40, 1, true);
    view.setFloat32(off + 44, 0, true);
    // attribute byte count
    view.setUint16(off + 48, 0, true);
  }

  return new Uint8Array(buf);
}

Deno.test("validate empty file", () => {
  const report = StlValidator.validate(new Uint8Array(0));
  assertEquals(report.valid, false);
  assertEquals(report.format, "empty");
  assertEquals(report.issues.length, 1);
});

Deno.test("validate valid binary STL", () => {
  const stl = buildBinaryStl(2);
  const report = StlValidator.validate(stl);
  assertEquals(report.valid, true);
  assertEquals(report.format, "binary");
  assertEquals(report.triangleCount, 2);
  assertEquals(report.expectedTriangleCount, 2);
  assertEquals(report.degenerateTriangles, 0);
  assertEquals(report.issues.length, 0);
  assertEquals(report.boundingBox !== null, true);
  assertEquals(report.boundingBox!.min, [0, 0, 0]);
  assertEquals(report.boundingBox!.max, [1, 1, 0]);
});

Deno.test("validate binary STL with size mismatch", () => {
  const stl = buildBinaryStl(2);
  // Truncate by 10 bytes
  const truncated = stl.slice(0, stl.length - 10);
  const report = StlValidator.validate(truncated);
  assertEquals(report.format, "binary");
  assertEquals(report.issues.some((i) => i.includes("Size mismatch")), true);
});

Deno.test("validate detects degenerate triangles", () => {
  const stl = buildBinaryStl(1);
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  // Make v2 = v1 (duplicate vertices → degenerate)
  view.setFloat32(84 + 24, 0, true); // v2.x = 0 (same as v1)
  view.setFloat32(84 + 28, 0, true); // v2.y = 0
  view.setFloat32(84 + 32, 0, true); // v2.z = 0
  const report = StlValidator.validate(stl);
  assertEquals(report.degenerateTriangles, 1);
});

Deno.test("validate all-zero binary file", () => {
  const stl = new Uint8Array(184); // 84 + 2*50 but all zeros
  const report = StlValidator.validate(stl);
  assertEquals(report.valid, false);
  assertEquals(report.issues.some((i) => i.includes("all zeros")), true);
});

Deno.test("validate valid ASCII STL", () => {
  const ascii = new TextEncoder().encode(
    `solid test
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid test`,
  );
  const report = StlValidator.validate(ascii);
  assertEquals(report.valid, true);
  assertEquals(report.format, "ascii");
  assertEquals(report.triangleCount, 1);
  assertEquals(report.boundingBox !== null, true);
});

Deno.test("validate ASCII STL missing endsolid", () => {
  const ascii = new TextEncoder().encode(
    `solid test
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet`,
  );
  const report = StlValidator.validate(ascii);
  assertEquals(report.valid, false);
  assertEquals(report.issues.some((i) => i.includes("endsolid")), true);
});

Deno.test("validate file too small for binary", () => {
  const stl = new Uint8Array(50); // < 84 bytes, not ASCII
  stl[0] = 0xff; // not "solid"
  const report = StlValidator.validate(stl);
  assertEquals(report.valid, false);
  assertEquals(report.format, "binary");
  assertEquals(report.issues.some((i) => i.includes("too small")), true);
});
