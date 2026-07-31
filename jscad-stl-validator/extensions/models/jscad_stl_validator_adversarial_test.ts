/**
 * Adversarial suite: hostile/malformed inputs, pinning CURRENT behavior.
 * `jscad_stl_validator.ts` / `jscad/stl_validator.ts` are BYTE-FROZEN —
 * nothing here is a proposed fix, every test asserts what the shipped code
 * ACTUALLY does today. Bug pins are labelled "pin:" and are recorded to the
 * LOCAL `jscad-stl-validator-latent-bugs` issue-lifecycle model, never a
 * swamp.club Lab issue.
 *
 * All fixture content is synthetic — see fixtures/PROVENANCE.md.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./jscad_stl_validator.ts";
import { StlValidator } from "./jscad/stl_validator.ts";
import {
  encodeAsciiStl,
  encodeBinaryStl,
  nTriangles,
  withTempStlFile,
} from "./fixtures/stl_builders.ts";

// ---------------------------------------------------------------------------
// Harness (validateFile only needs writeResource — no repositories)
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// pin: LB1 — validateFile arbitrary-file-read / path traversal (HIGH)
// filePath is Deno.readFile'd verbatim — no allow-list, no confinement to
// any base directory, no realpath check. A traversal-shaped path (or any
// absolute path) is honored exactly. Escape target stays INSIDE the
// per-test temp tree — no real system file is ever touched.
// ---------------------------------------------------------------------------

Deno.test("pin: validateFile has no path confinement — a '../' traversal path outside the intended directory is read verbatim (LB1, HIGH)", async () => {
  const root = await Deno.makeTempDir({ prefix: "jscad-stl-validator-trav-" });
  try {
    const allowedDir = `${root}/allowed`;
    await Deno.mkdir(allowedDir, { recursive: true });
    // The "secret" file lives OUTSIDE the intended `allowedDir`, but still
    // inside `root` (the per-test temp tree) — never a real system path.
    const secretBytes = encodeAsciiStl({
      solidName: "secret",
      facets: [{ v1: [0, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
    });
    await Deno.writeFile(`${root}/secret.stl`, secretBytes);

    const { ctx, written } = makeCtx();
    const traversalPath = `${allowedDir}/../secret.stl`;
    await run("validateFile", { filePath: traversalPath }, ctx);

    // The method happily parsed the secret file outside `allowedDir` — no
    // boundary was enforced anywhere in `validateFile`.
    assertEquals(written[0].payload.format, "ascii");
    assertEquals(written[0].payload.triangleCount, 1);
    assertEquals(written[0].payload.valid, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("pin: validateFile has no notion of an 'expected' base directory at all — two calls against files in TWO entirely unrelated temp roots both succeed identically (LB1, HIGH)", async () => {
  // Two independent `Deno.makeTempDir()` roots, standing in for "two
  // unrelated locations on disk" — neither is configured anywhere as THE
  // expected directory. If `validateFile` enforced any confinement, one of
  // these would need to be rejected; the shipped code has no such concept,
  // so both succeed identically.
  await withTempStlFile(
    encodeBinaryStl({ triangles: nTriangles(1) }),
    async (filePathA) => {
      await withTempStlFile(
        encodeBinaryStl({ triangles: nTriangles(2) }),
        async (filePathB) => {
          const { ctx: ctxA, written: writtenA } = makeCtx();
          await run("validateFile", { filePath: filePathA }, ctxA);
          const { ctx: ctxB, written: writtenB } = makeCtx();
          await run("validateFile", { filePath: filePathB }, ctxB);
          assertEquals(writtenA[0].payload.triangleCount, 1);
          assertEquals(writtenB[0].payload.triangleCount, 2);
        },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Safe-behavior regression pin: the binary read loop is bounded by the
// ACTUAL buffer size, not the attacker-controlled claimed count at offset
// 80 — a huge claimed count does not cause an out-of-bounds read, a crash,
// or a hang. (Not one of LB1-5 — an explicit "this is fine" pin.)
// ---------------------------------------------------------------------------

Deno.test("safe: a huge claimed triangle count at offset 80 does NOT cause an OOB read or a crash — the loop is bounded by actual buffer size", () => {
  const stl = encodeBinaryStl({
    claimedTriangleCount: 0xfffffffe, // ~4.29 billion, near uint32 max
    triangles: nTriangles(1),
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.format, "binary");
  assertEquals(report.triangleCount, 1); // actual, computed from real length
  assertEquals(report.expectedTriangleCount, 0xfffffffe); // raw header value, untrusted
  assertEquals(report.valid, false);
  assertEquals(
    report.issues.some((i) => i.includes("Size mismatch")),
    true,
  );
});

// ---------------------------------------------------------------------------
// pin: truncation — a valid file cut short mid-triangle (no throw)
// ---------------------------------------------------------------------------

Deno.test("pin: a binary STL truncated mid-triangle reports a size mismatch, computed from the ACTUAL truncated length, without throwing", () => {
  const full = encodeBinaryStl({ triangles: nTriangles(3) }); // 84 + 150 = 234
  const truncated = full.slice(0, full.length - 10); // 224 bytes
  const report = StlValidator.validate(truncated);
  assertEquals(report.format, "binary");
  assertEquals(report.triangleCount, Math.floor((truncated.length - 84) / 50));
  assertEquals(report.triangleCount, 2);
  assertEquals(report.expectedTriangleCount, 3);
  assertEquals(
    report.issues.some((i) => i.includes("Size mismatch")),
    true,
  );
});

// ---------------------------------------------------------------------------
// pin: NaN / Infinity in binary triangle coordinates
// ---------------------------------------------------------------------------

Deno.test("pin: a NaN coordinate in a binary triangle is flagged as degenerate with a dedicated issue, without throwing", () => {
  const stl = encodeBinaryStl({
    triangles: [{ v1: [NaN, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.format, "binary");
  assertEquals(report.degenerateTriangles, 1);
  assertEquals(
    report.issues.some((i) =>
      i.includes("Triangle 0: contains NaN or Infinity")
    ),
    true,
  );
});

Deno.test("pin: an Infinity coordinate in a binary triangle is flagged as degenerate with a dedicated issue, without throwing", () => {
  const stl = encodeBinaryStl({
    triangles: [{ v1: [Infinity, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.format, "binary");
  assertEquals(report.degenerateTriangles, 1);
  assertEquals(
    report.issues.some((i) =>
      i.includes("Triangle 0: contains NaN or Infinity")
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// pin: LB3 — issues[] amplification under multiple bad triangles (modest N)
// ---------------------------------------------------------------------------

Deno.test("pin: one issue string is pushed PER bad triangle — issues[] grows linearly with the (modest) triangle count (LB3, MEDIUM)", () => {
  const N = 200; // modest — enough to demonstrate amplification, not a DoS-scale fixture
  const stl = encodeBinaryStl({
    triangles: Array.from({ length: N }, () => ({
      v1: [NaN, 0, 0] as [number, number, number],
      v2: [1, 0, 0] as [number, number, number],
      v3: [0, 1, 0] as [number, number, number],
    })),
  });
  const report = StlValidator.validate(stl);
  assertEquals(report.triangleCount, N);
  assertEquals(report.degenerateTriangles, N);
  // N "contains NaN or Infinity" issues + 1 trailing "N degenerate triangle(s)" summary issue.
  assertEquals(report.issues.length, N + 1);
  assertEquals(
    report.issues.filter((i) => i.includes("contains NaN or Infinity")).length,
    N,
  );
});

// ---------------------------------------------------------------------------
// pin: LB2 — corrupt-binary-vs-ASCII misdetection (MEDIUM)
// A binary buffer whose 80-byte header happens to spell "solid" AND whose
// claimed/actual triangle counts DISAGREE falls through the reclassification
// guard entirely and gets parsed as ASCII — losing the real binary
// diagnosis (size mismatch) and the actual triangle data.
// ---------------------------------------------------------------------------

Deno.test("pin: a binary buffer with a 'solid'-looking header AND a mismatched claimed count is misdetected as ASCII, losing the real diagnosis (LB2, MEDIUM)", () => {
  const stl = encodeBinaryStl({
    header: "solid",
    claimedTriangleCount: 3, // does NOT match the actual 2 triangles below
    triangles: nTriangles(2), // actual size: 84 + 100 = 184; 84+3*50=234 != 184
  });
  const report = StlValidator.validate(stl);
  // Misdetected as ASCII: the real "Size mismatch" binary diagnosis, and the
  // two real triangles, are both lost.
  assertEquals(report, {
    valid: false,
    format: "ascii",
    triangleCount: 0,
    expectedTriangleCount: null,
    degenerateTriangles: 0,
    issues: [
      "No facets found in ASCII STL",
      "Missing 'endsolid' terminator",
    ],
    boundingBox: null,
  });
});

// ---------------------------------------------------------------------------
// pin: LB4 — weak ASCII validation accepts malformed geometry as "valid"
// ---------------------------------------------------------------------------

Deno.test("pin: an ASCII STL with a fully degenerate (duplicate-vertex) facet is reported valid — no geometry check exists on the ASCII path (LB4, LOW)", () => {
  const ascii = encodeAsciiStl({
    facets: [{ v1: [0, 0, 0], v2: [0, 0, 0], v3: [0, 0, 0] }], // zero-area, all vertices identical
  });
  const report = StlValidator.validate(ascii);
  assertEquals(report.format, "ascii");
  assertEquals(report.valid, true); // no degenerate check on the ASCII path
  assertEquals(report.degenerateTriangles, 0); // hardcoded, never computed for ASCII
  assertEquals(report.issues.length, 0);
});

// ---------------------------------------------------------------------------
// pin: LB5 — NaN/Infinity handling asymmetry, binary vs ASCII
// ---------------------------------------------------------------------------

Deno.test("pin: an ASCII facet with every coordinate NaN-shaped ('.') is silently accepted, producing an inverted Infinity/-Infinity bounding box — no isFinite/isNaN check exists on the ASCII path (LB5, LOW)", () => {
  // "." matches the parser's vertex regex character class `[-\d.eE+]+` but
  // is not a valid parseFloat numeral, so it decodes to NaN. Every NaN<x
  // and NaN>x comparison in computeBoundingBoxFromVerts evaluates false, so
  // the min/max accumulators never advance past their Infinity/-Infinity
  // seed values — the ASCII path has no isFinite/isNaN guard to catch this.
  const ascii = encodeAsciiStl({
    facets: [{
      v1: [".", ".", "."],
      v2: [".", ".", "."],
      v3: [".", ".", "."],
    }],
  });
  const report = StlValidator.validate(ascii);
  assertEquals(report.format, "ascii");
  assertEquals(report.valid, true); // no issue raised
  assertEquals(report.degenerateTriangles, 0); // never incremented on the ASCII path
  assertEquals(report.boundingBox, {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    size: [-Infinity, -Infinity, -Infinity],
  });
});

Deno.test("pin: an overflowing exponent ('1e400') decodes to Infinity in an ASCII vertex and is silently accepted (LB5, LOW)", () => {
  const ascii = encodeAsciiStl({
    facets: [{ v1: ["1e400", 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
  });
  const report = StlValidator.validate(ascii);
  assertEquals(report.format, "ascii");
  assertEquals(report.valid, true); // no issue raised
  assertEquals(report.boundingBox!.max[0], Infinity); // Infinity silently poisons the bounding box
});

// ---------------------------------------------------------------------------
// pin: validateFile rejects a directory path with the path in the message
// ---------------------------------------------------------------------------

Deno.test("pin: validateFile's wrapped error names the offending path for a directory target", async () => {
  const root = await Deno.makeTempDir({ prefix: "jscad-stl-validator-dir-" });
  try {
    const { ctx } = makeCtx();
    await assertRejects(
      () => run("validateFile", { filePath: root }, ctx),
      Error,
      `Cannot read "${root}"`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
