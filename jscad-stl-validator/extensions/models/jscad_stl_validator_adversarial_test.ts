/**
 * Adversarial suite: hostile/malformed inputs. Most tests here pin CURRENT
 * behavior; five of them ("fix:"-labelled, formerly "pin:"-labelled LB2-LB5)
 * were REAL FIXES landed in 2026.08.02.1 — see CHANGELOG.md. The benign
 * contract pins in this file remain byte-identical. Bug (and former-bug)
 * tests are recorded to the LOCAL `jscad-stl-validator-latent-bugs`
 * issue-lifecycle model, never a swamp.club Lab issue.
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

function makeCtx(allowedRoots: string[] = []) {
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
      globalArgs: { allowedRoots },
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
// fix: LB1 — validateFile arbitrary-file-read / path traversal (HIGH), FIXED
// filePath now goes through jscad/safe_path.ts's resolveStlPath guard:
// non-absolute paths and any '.'/'..' traversal segment are rejected BEFORE
// any filesystem access; the target is then canonicalized via
// Deno.realPath. Escape target/allowed dirs stay INSIDE the per-test temp
// tree — no real system file is ever touched.
// ---------------------------------------------------------------------------

Deno.test("fix: validateFile now REJECTS a '../' traversal path — the secret file outside the intended directory is never read (was LB1, HIGH)", async () => {
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
    await assertRejects(
      () => run("validateFile", { filePath: traversalPath }, ctx),
      Error,
      "Refusing to read",
    );

    // The secret file outside `allowedDir` was never parsed — nothing
    // written, no boundary was crossed.
    assertEquals(written.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("regression: validateFile's default contract is preserved — with no allowedRoots configured, two calls against files in TWO entirely unrelated temp roots both still succeed identically", async () => {
  // Two independent `Deno.makeTempDir()` roots, standing in for "two
  // unrelated locations on disk" — neither is configured as an
  // `allowedRoots` entry. This is the intended DEFAULT contract (empty
  // allowedRoots = no confinement), not a bug: a caller that wants
  // confinement must opt in via the `allowedRoots` global argument.
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
// fix: LB3 (domain half) — issues[] amplification under multiple bad
// triangles is now CAPPED at MAX_TRIANGLE_ISSUES (10) individual strings,
// plus one suppression note, plus the existing degenerate summary.
// ---------------------------------------------------------------------------

Deno.test("fix: issues[] amplification under multiple bad triangles is now CAPPED — at most 10 individual issue strings, one suppression note, one degenerate summary (was LB3, MEDIUM)", () => {
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
  assertEquals(report.valid, false);
  // 10 individual "contains NaN or Infinity" issues + 1 suppression note +
  // 1 trailing "N degenerate triangle(s)" summary issue = 12, NOT N + 1.
  assertEquals(report.issues.length, 12);
  assertEquals(
    report.issues.filter((i) => i.includes("contains NaN or Infinity")).length,
    10,
  );
  assertEquals(
    report.issues.some((i) =>
      i.includes("further triangle issue(s) suppressed")
    ),
    true,
  );
  assertEquals(
    report.issues.some((i) => i.includes(`${N} degenerate triangle(s) found`)),
    true,
  );
});

// ---------------------------------------------------------------------------
// fix: LB2 — corrupt-binary-vs-ASCII misdetection (MEDIUM)
// A binary buffer whose 80-byte header happens to spell "solid" AND whose
// claimed/actual triangle counts DISAGREE is now correctly classified as
// binary — the real "Size mismatch" diagnosis and the actual triangle data
// are restored, because the buffer's body does NOT look like ASCII text.
// ---------------------------------------------------------------------------

Deno.test("fix: a binary buffer with a 'solid'-looking header AND a mismatched claimed count is now correctly classified as binary, restoring the real diagnosis (was LB2, MEDIUM)", () => {
  const stl = encodeBinaryStl({
    header: "solid",
    claimedTriangleCount: 3, // does NOT match the actual 2 triangles below
    triangles: nTriangles(2), // actual size: 84 + 100 = 184; 84+3*50=234 != 184
  });
  const report = StlValidator.validate(stl);
  // Correctly classified as binary: the real "Size mismatch" diagnosis and
  // the two real triangles are both restored.
  assertEquals(report, {
    valid: false,
    format: "binary",
    triangleCount: 2,
    expectedTriangleCount: 3,
    degenerateTriangles: 0,
    issues: [
      "Size mismatch: header says 3 triangles (expected 234 bytes) but file is 184 bytes",
    ],
    boundingBox: { min: [0, 0, 0], max: [2, 1, 0], size: [2, 1, 0] },
  });
});

Deno.test("coverage: a 'solid'-header buffer with a mismatched claimed count whose body IS ASCII text stays classified ASCII — locks the LB2 discriminator on the ASCII side too", () => {
  const header = new Uint8Array(80);
  header.set(new TextEncoder().encode("solid test"));
  const bodyText = [
    "facet normal 0 0 1",
    "  outer loop",
    "    vertex 0 0 0",
    "    vertex 1 0 0",
    "    vertex 0 1 0",
    "  endloop",
    "endfacet",
    "endsolid test",
  ].join("\n");
  const bodyBytes = new TextEncoder().encode(bodyText);
  const buf = new Uint8Array(84 + bodyBytes.length);
  buf.set(header, 0);
  const view = new DataView(buf.buffer);
  view.setUint32(80, 5, true); // claimed count > 0, but mismatches the actual buffer size
  buf.set(bodyBytes, 84);

  const report = StlValidator.validate(buf);
  assertEquals(report.format, "ascii");
  assertEquals(report.triangleCount, 1);
  assertEquals(report.valid, true);
});

// ---------------------------------------------------------------------------
// fix: LB4 — ASCII validation now runs the SAME degenerate-triangle check
// as the binary path.
// ---------------------------------------------------------------------------

Deno.test("fix: an ASCII STL with a fully degenerate (duplicate-vertex) facet is now correctly flagged, mirroring the binary geometry check (was LB4, LOW)", () => {
  const ascii = encodeAsciiStl({
    facets: [{ v1: [0, 0, 0], v2: [0, 0, 0], v3: [0, 0, 0] }], // zero-area, all vertices identical
  });
  const report = StlValidator.validate(ascii);
  assertEquals(report.format, "ascii");
  assertEquals(report.valid, false);
  assertEquals(report.degenerateTriangles, 1);
  assertEquals(report.issues, [
    "1 degenerate triangle(s) found (zero area or duplicate vertices)",
  ]);
  assertEquals(report.boundingBox, null); // sole triangle is degenerate -> no geometry
});

// ---------------------------------------------------------------------------
// fix: LB5 — NaN/Infinity handling asymmetry, binary vs ASCII. The ASCII
// path now runs the SAME isFinite/isNaN guard as binary (folded into the
// LB4 rewrite), so a non-finite triangle is flagged, counted as degenerate,
// and EXCLUDED from the bounding box on both paths.
// ---------------------------------------------------------------------------

Deno.test("fix: an ASCII facet with every coordinate NaN-shaped ('.') is now correctly flagged and excluded from the bounding box, mirroring the binary NaN/Infinity check (was LB5, LOW)", () => {
  // "." matches the parser's vertex regex character class `[-\d.eE+]+` but
  // is not a valid parseFloat numeral, so it decodes to NaN.
  const ascii = encodeAsciiStl({
    facets: [{
      v1: [".", ".", "."],
      v2: [".", ".", "."],
      v3: [".", ".", "."],
    }],
  });
  const report = StlValidator.validate(ascii);
  assertEquals(report.format, "ascii");
  assertEquals(report.valid, false);
  assertEquals(report.degenerateTriangles, 1);
  assertEquals(
    report.issues.some((i) =>
      i.includes("Triangle 0: contains NaN or Infinity")
    ),
    true,
  );
  assertEquals(report.boundingBox, null);
});

Deno.test("fix: an overflowing exponent ('1e400') decoding to Infinity in an ASCII vertex is now correctly flagged and excluded from the bounding box (was LB5, LOW)", () => {
  const ascii = encodeAsciiStl({
    facets: [{ v1: ["1e400", 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
  });
  const report = StlValidator.validate(ascii);
  assertEquals(report.format, "ascii");
  assertEquals(report.valid, false);
  assertEquals(
    report.issues.some((i) =>
      i.includes("Triangle 0: contains NaN or Infinity")
    ),
    true,
  );
  // The single facet is non-finite -> excluded -> no valid geometry, so
  // Infinity can no longer poison the bounding box (it's null, not Infinity).
  assertEquals(report.boundingBox, null);
});

Deno.test("fix: a NaN vertex fed as binary vs ASCII now yields equivalent classification — no asymmetry remains (was LB5, LOW)", () => {
  const binary = encodeBinaryStl({
    triangles: [{ v1: [NaN, 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
  });
  const ascii = encodeAsciiStl({
    facets: [{ v1: [".", 0, 0], v2: [1, 0, 0], v3: [0, 1, 0] }],
  });

  const binReport = StlValidator.validate(binary);
  const asciiReport = StlValidator.validate(ascii);

  assertEquals(binReport.degenerateTriangles, 1);
  assertEquals(asciiReport.degenerateTriangles, 1);
  assertEquals(
    binReport.issues.some((i) =>
      i.includes("Triangle 0: contains NaN or Infinity")
    ),
    true,
  );
  assertEquals(
    asciiReport.issues.some((i) =>
      i.includes("Triangle 0: contains NaN or Infinity")
    ),
    true,
  );
  assertEquals(binReport.boundingBox, null);
  assertEquals(asciiReport.boundingBox, null);
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
