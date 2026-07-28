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
