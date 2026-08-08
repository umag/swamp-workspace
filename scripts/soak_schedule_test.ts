// Failing-first (TDD RED) tests for scripts/soak_schedule.ts — the rotating
// nightly property-soak scheduler. Discovery is anchored to
// `*/extensions/models/*_property_test.ts`; the 7-night rotation partitions
// the discovered files so every file is soaked at least weekly, sized
// `ceil(N/7)` per night, and self-heals the following week if the discovered
// file set changes mid-cycle.
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  buildTonightsBucket,
  computeBucket,
  dayIndexFor,
  discoverPropertyTestFiles,
  serializeBucketForOutputFile,
  windowSize,
} from "./soak_schedule.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);

// ---------------------------------------------------------------------------
// windowSize
// ---------------------------------------------------------------------------

const WINDOW_CASES: Array<[number, number]> = [
  [0, 0],
  [1, 1],
  [3, 1],
  [7, 1],
  [8, 2],
  [10, 2],
  [14, 2],
  [15, 3],
  [49, 7],
  [50, 8],
];

for (const [n, expected] of WINDOW_CASES) {
  Deno.test(`windowSize(${n}) === ${expected} (ceil(N/7))`, () => {
    assertEquals(windowSize(n), expected);
  });
}

// ---------------------------------------------------------------------------
// computeBucket — deterministic 7-night partition
// ---------------------------------------------------------------------------

Deno.test("computeBucket: rejects an out-of-range day index", () => {
  let threw = false;
  try {
    computeBucket(["a"], 7);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("computeBucket: is deterministic for a fixed (files, day)", () => {
  const files = ["c", "a", "b"];
  const first = computeBucket(files, 2);
  const second = computeBucket(files, 2);
  assertEquals(first, second);
});

Deno.test("computeBucket: input-order independent (sorts internally)", () => {
  const a = computeBucket(["z", "a", "m"], 1);
  const b = computeBucket(["m", "z", "a"], 1);
  assertEquals(a, b);
});

Deno.test("computeBucket: N=3 files over a 7-night cycle — exactly 3 non-empty nights (the ci.yml empty-matrix scenario)", () => {
  const files = [
    "stripe_mpp_property_test.ts",
    "stripe_mpp_invariant_property_test.ts",
    "stripe_mpp_flow_property_test.ts",
  ];
  let nonEmpty = 0;
  const seen = new Set<string>();
  for (let d = 0; d < 7; d++) {
    const bucket = computeBucket(files, d);
    if (bucket.length > 0) nonEmpty++;
    for (const f of bucket) seen.add(f);
  }
  assertEquals(nonEmpty, 3);
  assertEquals(seen.size, 3);
});

Deno.test("computeBucket: property — every file selected exactly once per 7-night cycle, bucket <= ceil(N/7), coverage complete", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
        minLength: 0,
        maxLength: 200,
      }),
      (files) => {
        const n = files.length;
        const w = windowSize(n);
        const seen = new Map<string, number>();
        let total = 0;
        for (let d = 0; d < 7; d++) {
          const bucket = computeBucket(files, d);
          assert(
            bucket.length <= w,
            `bucket ${d} length ${bucket.length} > window ${w}`,
          );
          total += bucket.length;
          for (const f of bucket) {
            seen.set(f, (seen.get(f) ?? 0) + 1);
          }
        }
        if (total !== n) return false;
        for (const f of files) {
          if ((seen.get(f) ?? 0) !== 1) return false;
        }
        return true;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("computeBucket: property — every night is non-empty whenever N >= 7", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
        minLength: 7,
        maxLength: 200,
      }),
      (files) => {
        for (let d = 0; d < 7; d++) {
          if (computeBucket(files, d).length === 0) return false;
        }
        return true;
      },
    ),
    { numRuns: NIGHT(150) },
  );
});

Deno.test("computeBucket: property — for 0<N<7 exactly N nights are non-empty", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
        minLength: 1,
        maxLength: 6,
      }),
      (files) => {
        let nonEmpty = 0;
        for (let d = 0; d < 7; d++) {
          if (computeBucket(files, d).length > 0) nonEmpty++;
        }
        return nonEmpty === files.length;
      },
    ),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("computeBucket: N=0 — every night is empty (the workflow guard handles this as a green no-op)", () => {
  for (let d = 0; d < 7; d++) {
    assertEquals(computeBucket([], d), []);
  }
});

// ---------------------------------------------------------------------------
// dayIndexFor — deterministic UTC day-of-week (0=Sun..6=Sat)
// ---------------------------------------------------------------------------

Deno.test("dayIndexFor: matches Date.UTC getUTCDay for known dates", () => {
  // 2026-07-27 is a Monday.
  assertEquals(dayIndexFor(new Date("2026-07-27T03:37:00Z")), 1);
  // 2026-07-25 is a Saturday.
  assertEquals(dayIndexFor(new Date("2026-07-25T03:37:00Z")), 6);
  // 2026-01-01 is a Thursday.
  assertEquals(dayIndexFor(new Date("2026-01-01T03:37:00Z")), 4);
});

// ---------------------------------------------------------------------------
// discoverPropertyTestFiles — anchored to */extensions/models/*_property_test.ts
// ---------------------------------------------------------------------------

Deno.test("discoverPropertyTestFiles: matches only the anchored glob shape", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/ext-a/extensions/models`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-a/extensions/models/foo_property_test.ts`,
      "",
    );
    await Deno.writeTextFile(`${root}/ext-a/extensions/models/foo_test.ts`, ""); // not a property test
    await Deno.mkdir(`${root}/ext-b/extensions/models`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-b/extensions/models/bar_property_test.ts`,
      "",
    );
    // wrong depth: not under <ext>/extensions/models/
    await Deno.writeTextFile(`${root}/root_property_test.ts`, "");
    await Deno.mkdir(`${root}/ext-c/other`, { recursive: true });
    await Deno.writeTextFile(`${root}/ext-c/other/deep_property_test.ts`, "");

    const found = await discoverPropertyTestFiles(root);
    const rel = found.map((f) => `${f.extension}/${f.file}`).sort();
    assertEquals(rel, [
      "ext-a/extensions/models/foo_property_test.ts",
      "ext-b/extensions/models/bar_property_test.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("discoverPropertyTestFiles: finds today's 3 stripe-mpp property test files in the real repo", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const found = await discoverPropertyTestFiles(root);
  const stripeFiles = found.filter((f) => f.extension === "stripe-mpp").map((
    f,
  ) => f.file).sort();
  assertEquals(stripeFiles, [
    "extensions/models/stripe_mpp_flow_property_test.ts",
    "extensions/models/stripe_mpp_invariant_property_test.ts",
    "extensions/models/stripe_mpp_property_test.ts",
  ]);
});

// ---------------------------------------------------------------------------
// buildTonightsBucket — CLI-facing orchestration (discovery + rotation)
// ---------------------------------------------------------------------------

Deno.test("buildTonightsBucket: --all returns every discovered file regardless of rotation", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/ext-a/extensions/models`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-a/extensions/models/a_property_test.ts`,
      "",
    );
    await Deno.mkdir(`${root}/ext-b/extensions/models`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-b/extensions/models/b_property_test.ts`,
      "",
    );
    const bucket = await buildTonightsBucket(root, {
      all: true,
      now: new Date(),
    });
    assertEquals(bucket.length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildTonightsBucket: --target restricts to one extension's files, ignoring rotation", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/ext-a/extensions/models`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-a/extensions/models/a_property_test.ts`,
      "",
    );
    await Deno.mkdir(`${root}/ext-b/extensions/models`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-b/extensions/models/b_property_test.ts`,
      "",
    );
    const bucket = await buildTonightsBucket(root, {
      target: "ext-a",
      now: new Date(),
    });
    assertEquals(bucket.length, 1);
    assertEquals(bucket[0].extension, "ext-a");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildTonightsBucket: default mode uses today's rotation window", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/ext-a/extensions/models`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext-a/extensions/models/a_property_test.ts`,
      "",
    );
    const bucket = await buildTonightsBucket(root, {
      now: new Date("2026-07-27T03:37:00Z"),
    });
    assert(Array.isArray(bucket));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// serializeBucketForOutputFile — the --out file feeds a $GITHUB_OUTPUT
// heredoc in property-soak.yml; a missing trailing newline would glue the
// closing "EOF" delimiter onto the JSON line and break Actions' parser.
// ---------------------------------------------------------------------------

Deno.test("serializeBucketForOutputFile: ends with a trailing newline", () => {
  const out = serializeBucketForOutputFile([
    { extension: "stripe-mpp", file: "extensions/models/a_property_test.ts" },
  ]);
  assert(
    out.endsWith("\n"),
    `expected a trailing newline, got ${JSON.stringify(out)}`,
  );
  assertEquals(JSON.parse(out.trimEnd()), [
    { extension: "stripe-mpp", file: "extensions/models/a_property_test.ts" },
  ]);
});

Deno.test("serializeBucketForOutputFile: empty bucket still ends with a trailing newline", () => {
  const out = serializeBucketForOutputFile([]);
  assertEquals(out, "[]\n");
});

// ---------------------------------------------------------------------------
// Self-heal documentation: rotation is recomputed fresh every run from the
// CURRENT discovered set (no persisted cursor) — if the set changes mid-week,
// coverage for that week may skip/duplicate a file, but the next full cycle
// (computed from the new stable set) is exact again. See scripts/README.md.
// ---------------------------------------------------------------------------

Deno.test("computeBucket: mid-week set change can shift day-index membership (accepted, documented self-heal)", () => {
  const before = ["a", "b", "c"];
  const after = ["a", "b", "c", "d"]; // a file lands mid-week
  const dayIndex = 2;
  const bucketBefore = computeBucket(before, dayIndex);
  const bucketAfter = computeBucket(after, dayIndex);
  // Not asserting equality either way — the point is both are independently
  // well-formed complete partitions computed fresh from whatever set is live
  // TODAY; the next full 7-night cycle over the stable new set is exact.
  assert(bucketBefore.length <= windowSize(before.length));
  assert(bucketAfter.length <= windowSize(after.length));
});

// ---------------------------------------------------------------------------
// discoverPropertyTestFiles — RECURSIVE discovery under extensions/models/
//
// The defect: discovery currently reads only the DIRECT entries of
// `<ext>/extensions/models/`, one level deep. jscad-cad's real property test
// suite lives one level deeper, at
// `jscad-cad/extensions/models/jscad/jscad_cad_property_test.ts` — it has
// therefore NEVER been picked up by any night's bucket, and has never
// actually been soaked. Discovery must walk extensions/models/ recursively.
// ---------------------------------------------------------------------------

Deno.test("discoverPropertyTestFiles: finds a property test file NESTED one level deeper than extensions/models/ (jscad-cad's real shape)", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/jscad-cad/extensions/models/jscad`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${root}/jscad-cad/extensions/models/jscad/jscad_cad_property_test.ts`,
      "",
    );
    const found = await discoverPropertyTestFiles(root);
    const rel = found.map((f) => `${f.extension}/${f.file}`);
    assertEquals(rel, [
      "jscad-cad/extensions/models/jscad/jscad_cad_property_test.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("discoverPropertyTestFiles: finds jscad-cad's REAL nested property test file in the actual repo (currently invisible — non-recursive discovery bug)", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const found = await discoverPropertyTestFiles(root);
  const jscadFiles = found.filter((f) => f.extension === "jscad-cad").map((
    f,
  ) => f.file);
  assertEquals(jscadFiles, [
    "extensions/models/jscad/jscad_cad_property_test.ts",
  ]);
});

// ---------------------------------------------------------------------------
// denoArgsJson — every emitted bucket entry must carry the exact deno
// permission flags to run its property file with, derived from the
// extension's own `test` task (scripts/lib/soak_permissions.ts), as a
// JSON-encoded STRING (never a bare array) so it can travel through a single
// GITHUB_OUTPUT matrix field and be JSON.parse'd back into an argv array by
// scripts/run_soak.ts.
// ---------------------------------------------------------------------------

async function writeMinimalExtension(
  root: string,
  extension: string,
  testTask: string,
  propertyFile = `${extension.replaceAll("-", "_")}_property_test.ts`,
): Promise<void> {
  await Deno.mkdir(`${root}/${extension}/extensions/models`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${root}/${extension}/extensions/models/${propertyFile}`,
    "",
  );
  await Deno.writeTextFile(
    `${root}/${extension}/deno.json`,
    JSON.stringify({ tasks: { test: testTask } }),
  );
}

Deno.test("buildTonightsBucket: every emitted entry carries denoArgsJson as a JSON-encoded STRING, not a bare array", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeMinimalExtension(
      root,
      "ext-a",
      "deno test --allow-env=FC_NUM_RUNS extensions/models/",
    );
    const bucket = await buildTonightsBucket(root, {
      all: true,
      now: new Date(),
    });
    assertEquals(bucket.length, 1);
    const entry = bucket[0] as unknown as {
      extension: string;
      file: string;
      denoArgsJson: unknown;
    };
    assertEquals(
      typeof entry.denoArgsJson,
      "string",
      `denoArgsJson must be a JSON-encoded string, got ${typeof entry
        .denoArgsJson}: ${JSON.stringify(entry.denoArgsJson)}`,
    );
    const parsedArgs = JSON.parse(entry.denoArgsJson as string);
    assert(
      Array.isArray(parsedArgs),
      "denoArgsJson must decode to an array, not an object or scalar",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildTonightsBucket: denoArgsJson round-trips through JSON.parse to the expected argv, derived from the extension's own test task", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeMinimalExtension(
      root,
      "ext-a",
      "deno test --allow-env=FC_NUM_RUNS extensions/models/",
    );
    const bucket = await buildTonightsBucket(root, {
      all: true,
      now: new Date(),
    });
    const entry = bucket[0] as unknown as { denoArgsJson: string };
    const parsedArgs = JSON.parse(entry.denoArgsJson);
    assertEquals(parsedArgs, ["--allow-env=FC_NUM_RUNS"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// A --v8-flags=... token on a `test` task (seanime's and seadex's real
// shape — required by their heap-pin regression tests, the guard for the
// req.clone() leak PR #182 fixed) used to vanish entirely from denoArgsJson:
// parsePermissionSet/permissionSetToArgs only ever round-trip --allow-*/
// --deny-* tokens, so `deno run --allow-read --allow-env
// scripts/soak_schedule.ts --all` emitted no "v8-flags" anywhere in its
// output. resolveDenoArgs now calls deriveSoakArgsFromTestTask, which
// carries a recognized runtime flag through ahead of the permission flags.
Deno.test("buildTonightsBucket: --v8-flags=--expose-gc on the test task (seanime/seadex's real shape) is carried into denoArgsJson, ordered BEFORE the permission flags", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeMinimalExtension(
      root,
      "ext-a",
      "deno test --v8-flags=--expose-gc --allow-env=FC_NUM_RUNS extensions/models/ --permit-no-files",
    );
    const bucket = await buildTonightsBucket(root, {
      all: true,
      now: new Date(),
    });
    const entry = bucket[0] as unknown as { denoArgsJson: string };
    const parsedArgs = JSON.parse(entry.denoArgsJson);
    assertEquals(parsedArgs, [
      "--v8-flags=--expose-gc",
      "--allow-env=FC_NUM_RUNS",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// CLI summary line — surfaces each entry's resolved permissions (the MEDIUM
// finding this pins): the human-readable summary used to list only
// extension/file, forcing an operator debugging a soak failure to open the
// raw JSON to see the permission argv. Default now includes the resolved
// flag COUNT (cheap, always-on); --verbose shows the full argv.
// ---------------------------------------------------------------------------

async function writeSummaryFixtureExtension(root: string): Promise<void> {
  await Deno.mkdir(`${root}/ext-a/extensions/models`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/ext-a/extensions/models/a_property_test.ts`,
    "",
  );
  await Deno.writeTextFile(
    `${root}/ext-a/deno.json`,
    JSON.stringify({
      tasks: {
        test:
          "deno test --allow-read --allow-env=FC_NUM_RUNS extensions/models/",
      },
    }),
  );
}

Deno.test("soak_schedule.ts CLI: default summary line includes each entry's resolved permission FLAG COUNT", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeSummaryFixtureExtension(root);
    const scriptUrl = new URL("./soak_schedule.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        scriptUrl.pathname,
        "--root",
        root,
        "--all",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes("ext-a/extensions/models/a_property_test.ts (2 flags)"),
      `expected the summary line to include the resolved flag count, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("soak_schedule.ts CLI: --verbose shows the full resolved argv per entry instead of just the count", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeSummaryFixtureExtension(root);
    const scriptUrl = new URL("./soak_schedule.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        scriptUrl.pathname,
        "--root",
        root,
        "--all",
        "--verbose",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes(
        "ext-a/extensions/models/a_property_test.ts [--allow-read --allow-env=FC_NUM_RUNS]",
      ),
      `expected the verbose summary line to include the full resolved argv, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildTonightsBucket: no emitted field on any bucket entry contains a raw newline (feeds a files<<EOF GITHUB_OUTPUT heredoc)", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeMinimalExtension(
      root,
      "ext-a",
      "deno test --allow-read=extensions,fixtures --allow-env=FC_NUM_RUNS,OTHER_VAR extensions/models/",
    );
    await writeMinimalExtension(
      root,
      "ext-b",
      "deno test --allow-all extensions/models/",
    );
    const bucket = await buildTonightsBucket(root, {
      all: true,
      now: new Date(),
    });
    assertEquals(bucket.length, 2);
    for (const raw of bucket) {
      const entry = raw as unknown as Record<string, unknown>;
      // denoArgsJson must actually be present (not just "no newline in
      // whatever happens to exist today") — otherwise this check is
      // vacuously true before the field is implemented at all.
      assertEquals(typeof entry.denoArgsJson, "string", JSON.stringify(entry));
      for (const [key, value] of Object.entries(entry)) {
        if (typeof value !== "string") continue;
        assert(
          !value.includes("\n"),
          `field "${key}" on bucket entry contains a raw newline: ${
            JSON.stringify(value)
          }`,
        );
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
