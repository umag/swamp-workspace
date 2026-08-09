/**
 * Tests for scripts/quality/generate_soak_task.ts — the "test:soak" deno.json
 * task generator. Focused on the four load-bearing behaviors the module
 * docblock calls out (runtime flags carry, runs is DECLARED not inferred, a
 * narrowed quality.yaml soak: override applies verbatim, multiple
 * property-test files join into one task), the text-level deno.json
 * find/insert (never a JSON.parse/stringify round-trip — see
 * upsertTestSoakLine's own docblock for why), and the CLI's check/write mode
 * contract.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { dirname, join } from "jsr:@std/path@1";
import {
  DEFAULT_SOAK_RUNS,
  discoverFilesByExtension,
  formatSoakTask,
  generateSoakTask,
  readActualSoakTask,
  readSoakRuns,
  upsertTestSoakLine,
  writeGeneratedTask,
} from "./generate_soak_task.ts";

async function writeExtension(
  root: string,
  name: string,
  opts: {
    testTask?: string;
    denoJsonExtra?: string; // raw extra tasks/keys injected verbatim
    propertyFiles?: string[]; // relative to <ext>/, defaults to one anchored file
    qualityYaml?: string;
    existingSoakTask?: string; // pre-existing "test:soak" line value
  } = {},
): Promise<void> {
  const dir = join(root, name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "manifest.yaml"), `name: ${name}\n`);

  const tasks: Record<string, string> = {};
  if (opts.testTask !== undefined) tasks.test = opts.testTask;
  if (opts.existingSoakTask !== undefined) {
    tasks["test:soak"] = opts.existingSoakTask;
  }
  tasks.fmt = "deno fmt";
  tasks.lint = "deno lint";
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ tasks }, null, 2) + "\n",
  );

  const propertyFiles = opts.propertyFiles ??
    [`extensions/models/${name.replaceAll("-", "_")}_property_test.ts`];
  for (const pf of propertyFiles) {
    const full = join(dir, pf);
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, "");
  }

  if (opts.qualityYaml !== undefined) {
    await Deno.writeTextFile(join(dir, "quality.yaml"), opts.qualityYaml);
  }
}

// ---------------------------------------------------------------------------
// formatSoakTask
// ---------------------------------------------------------------------------

Deno.test("formatSoakTask: assembles FC_NUM_RUNS=<runs> deno test <denoArgs...> <files...>", () => {
  const task = formatSoakTask(
    ["--allow-env=FC_NUM_RUNS"],
    ["extensions/models/widget_property_test.ts"],
    10000,
  );
  assertEquals(
    task,
    "FC_NUM_RUNS=10000 deno test --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",
  );
});

// ---------------------------------------------------------------------------
// readSoakRuns — runs is DECLARED config, never inferred
// ---------------------------------------------------------------------------

Deno.test("readSoakRuns: DEFAULT_SOAK_RUNS when there is no quality.yaml at all", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-runs-" });
  try {
    await writeExtension(root, "widget", { testTask: "deno test" });
    assertEquals(await readSoakRuns(root, "widget"), DEFAULT_SOAK_RUNS);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readSoakRuns: reads soak.runs from an 'na' state block (herdr/jabber's real shape)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-runs-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test",
      qualityYaml:
        `soak:\n  state: na\n  justification: "no narrowing needed, twelve chars"\n  runs: 2000\n`,
    });
    assertEquals(await readSoakRuns(root, "widget"), 2000);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readSoakRuns: reads soak.runs from a 'present' state block (swamp-go-brr's real shape)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-runs-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test",
      qualityYaml:
        `soak:\n  state: present\n  denoArgs: ["--allow-env=FC_NUM_RUNS"]\n  runs: 5000\n`,
    });
    assertEquals(await readSoakRuns(root, "widget"), 5000);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readSoakRuns: falls back to DEFAULT_SOAK_RUNS for a non-positive or non-integer runs", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-runs-" });
  try {
    await writeExtension(root, "zero", {
      testTask: "deno test",
      qualityYaml:
        `soak:\n  state: na\n  justification: "twelve+ characters here"\n  runs: 0\n`,
    });
    await writeExtension(root, "fractional", {
      testTask: "deno test",
      qualityYaml:
        `soak:\n  state: na\n  justification: "twelve+ characters here"\n  runs: 2.5\n`,
    });
    assertEquals(await readSoakRuns(root, "zero"), DEFAULT_SOAK_RUNS);
    assertEquals(await readSoakRuns(root, "fractional"), DEFAULT_SOAK_RUNS);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// discoverFilesByExtension
// ---------------------------------------------------------------------------

Deno.test("discoverFilesByExtension: groups discovered *_property_test.ts files by extension", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-discover-" });
  try {
    await writeExtension(root, "alpha", { testTask: "deno test" });
    await writeExtension(root, "beta", {
      testTask: "deno test",
      propertyFiles: [
        "extensions/models/beta_a_property_test.ts",
        "extensions/models/beta_b_property_test.ts",
      ],
    });
    const byExt = await discoverFilesByExtension(root);
    assertEquals(byExt.get("alpha"), [
      "extensions/models/alpha_property_test.ts",
    ]);
    assertEquals(byExt.get("beta"), [
      "extensions/models/beta_a_property_test.ts",
      "extensions/models/beta_b_property_test.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// generateSoakTask — the four load-bearing behaviors
// ---------------------------------------------------------------------------

Deno.test("generateSoakTask: common case reuses deriveSoakArgsFromTestTask (no quality.yaml override)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-common-" });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --allow-env=FC_NUM_RUNS extensions/models/ --permit-no-files",
    });
    const result = await generateSoakTask(root, "widget");
    assert(result.ok, JSON.stringify(result));
    assertEquals(
      result.generated.task,
      "FC_NUM_RUNS=10000 deno test --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generateSoakTask: --v8-flags=--expose-gc carries through (the seanime/seadex regression)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-v8-" });
  try {
    await writeExtension(root, "seanime", {
      testTask:
        "deno test --v8-flags=--expose-gc --allow-env=FC_NUM_RUNS extensions/models/ --permit-no-files",
    });
    const result = await generateSoakTask(root, "seanime");
    assert(result.ok, JSON.stringify(result));
    assertEquals(
      result.generated.task,
      "FC_NUM_RUNS=10000 deno test --v8-flags=--expose-gc --allow-env=FC_NUM_RUNS extensions/models/seanime_property_test.ts",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generateSoakTask: a narrowed quality.yaml soak: override applies VERBATIM, dropping a flag the test task grants", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-override-" });
  try {
    await writeExtension(root, "stripe-mpp", {
      testTask:
        "deno test --allow-net --allow-env extensions/models/ --permit-no-files",
      qualityYaml: `soak:\n  state: present\n  denoArgs: ["--allow-env"]\n`,
    });
    const result = await generateSoakTask(root, "stripe-mpp");
    assert(result.ok, JSON.stringify(result));
    // --allow-net (the test task's broader grant) must NOT appear — the
    // override is used in place of the derivation entirely.
    assert(
      !result.generated.task.includes("--allow-net"),
      result.generated.task,
    );
    assert(
      result.generated.task.includes("--allow-env"),
      result.generated.task,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generateSoakTask: multiple property-test files (stripe-mpp's real shape) join into ONE task, sorted", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-multi-" });
  try {
    await writeExtension(root, "stripe-mpp", {
      testTask: "deno test --allow-env extensions/models/ --permit-no-files",
      propertyFiles: [
        "extensions/models/stripe_mpp_property_test.ts",
        "extensions/models/stripe_mpp_invariant_property_test.ts",
        "extensions/models/stripe_mpp_flow_property_test.ts",
      ],
    });
    const result = await generateSoakTask(root, "stripe-mpp");
    assert(result.ok, JSON.stringify(result));
    assertEquals(result.generated.files, [
      "extensions/models/stripe_mpp_flow_property_test.ts",
      "extensions/models/stripe_mpp_invariant_property_test.ts",
      "extensions/models/stripe_mpp_property_test.ts",
    ]);
    assertEquals(
      result.generated.task,
      "FC_NUM_RUNS=10000 deno test --allow-env " +
        "extensions/models/stripe_mpp_flow_property_test.ts " +
        "extensions/models/stripe_mpp_invariant_property_test.ts " +
        "extensions/models/stripe_mpp_property_test.ts",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generateSoakTask: declared runs (not the default) is baked into the FC_NUM_RUNS prefix", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-runs-inline-" });
  try {
    await writeExtension(root, "herdr", {
      testTask:
        "deno test --allow-read=fixtures --allow-env=FC_NUM_RUNS --allow-run=sh extensions/models/",
      qualityYaml:
        `soak:\n  state: na\n  justification: "no narrowing needed here"\n  runs: 2000\n`,
    });
    const result = await generateSoakTask(root, "herdr");
    assert(result.ok, JSON.stringify(result));
    assertEquals(result.generated.runs, 2000);
    assert(
      result.generated.task.startsWith("FC_NUM_RUNS=2000 "),
      result.generated.task,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generateSoakTask: reports an error (not a garbage task) when the extension has no test task at all", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-no-test-" });
  try {
    const dir = join(root, "widget");
    await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(join(dir, "manifest.yaml"), "name: widget\n");
    await Deno.writeTextFile(
      join(dir, "extensions", "models", "widget_property_test.ts"),
      "",
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ tasks: { fmt: "deno fmt" } }),
    );
    const result = await generateSoakTask(root, "widget");
    assert(!result.ok, JSON.stringify(result));
    assert(result.reason.includes('no "test" task'), result.reason);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generateSoakTask: reports an error (not a false violation) when there is no property test file at all", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-no-property-" });
  try {
    const dir = join(root, "widget");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "manifest.yaml"), "name: widget\n");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    const result = await generateSoakTask(root, "widget");
    assert(!result.ok, JSON.stringify(result));
    assert(result.reason.includes("no *_property_test.ts file"), result.reason);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// upsertTestSoakLine — text-level, never a JSON round-trip
// ---------------------------------------------------------------------------

Deno.test("upsertTestSoakLine: replaces an existing test:soak line, leaving every other line byte-identical", () => {
  const raw = [
    "{",
    '  "tasks": {',
    '    "check": "deno check extensions/models/widget.ts",',
    '    "test": "deno test --allow-env=FC_NUM_RUNS extensions/models/",',
    '    "test:soak": "FC_NUM_RUNS=10000 deno test --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",',
    '    "fmt": "deno fmt"',
    "  }",
    "}",
    "",
  ].join("\n");
  const { content, previous } = upsertTestSoakLine(
    raw,
    "FC_NUM_RUNS=10000 deno test --allow-read --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",
  );
  assertEquals(
    previous,
    "FC_NUM_RUNS=10000 deno test --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",
  );
  const lines = content.split("\n");
  assertEquals(
    lines[4],
    '    "test:soak": "FC_NUM_RUNS=10000 deno test --allow-read --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",',
  );
  // Every other line unchanged.
  assertEquals(lines[0], "{");
  assertEquals(lines[1], '  "tasks": {');
  assertEquals(
    lines[2],
    '    "check": "deno check extensions/models/widget.ts",',
  );
  assertEquals(
    lines[3],
    '    "test": "deno test --allow-env=FC_NUM_RUNS extensions/models/",',
  );
  assertEquals(lines[5], '    "fmt": "deno fmt"');
});

Deno.test("upsertTestSoakLine: inserts a new test:soak line right after 'test' when absent, matching its indentation", () => {
  const raw = [
    "{",
    '  "tasks": {',
    '    "test": "deno test extensions/models/ --permit-no-files --allow-read --allow-write --allow-run --allow-env --allow-net",',
    '    "fmt": "deno fmt"',
    "  }",
    "}",
    "",
  ].join("\n");
  const { content, previous } = upsertTestSoakLine(
    raw,
    "FC_NUM_RUNS=10000 deno test --allow-read --allow-write --allow-env=FC_NUM_RUNS extensions/models/jscad/jscad_cad_property_test.ts",
  );
  assertEquals(previous, null);
  const lines = content.split("\n");
  assertEquals(
    lines[3],
    '    "test:soak": "FC_NUM_RUNS=10000 deno test --allow-read --allow-write --allow-env=FC_NUM_RUNS extensions/models/jscad/jscad_cad_property_test.ts",',
  );
  // The original "test" and "fmt" lines are untouched, just shifted down one.
  assertEquals(
    lines[2],
    '    "test": "deno test extensions/models/ --permit-no-files --allow-read --allow-write --allow-run --allow-env --allow-net",',
  );
  assertEquals(lines[4], '    "fmt": "deno fmt"');
});

Deno.test("upsertTestSoakLine: no-op-shaped call (same value) still returns the SAME task, so the caller can skip a write", () => {
  const raw = [
    "{",
    '  "tasks": {',
    '    "test": "deno test",',
    '    "test:soak": "FC_NUM_RUNS=10000 deno test",',
    '    "fmt": "deno fmt"',
    "  }",
    "}",
    "",
  ].join("\n");
  const { previous } = upsertTestSoakLine(raw, "FC_NUM_RUNS=10000 deno test");
  assertEquals(previous, "FC_NUM_RUNS=10000 deno test");
});

Deno.test("upsertTestSoakLine: throws when the deno.json text has neither a test nor test:soak line (asserted precondition)", () => {
  assertThrows(() =>
    upsertTestSoakLine('{\n  "tasks": {\n    "fmt": "deno fmt"\n  }\n}\n', "x")
  );
});

// ---------------------------------------------------------------------------
// readActualSoakTask / writeGeneratedTask — end-to-end file round-trip
// ---------------------------------------------------------------------------

Deno.test("writeGeneratedTask + readActualSoakTask: round-trips a newly-inserted test:soak task", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-write-" });
  try {
    await writeExtension(root, "jscad-cad", {
      testTask:
        "deno test extensions/models/ --permit-no-files --allow-read --allow-write --allow-run --allow-env --allow-net",
    });
    assertEquals(await readActualSoakTask(root, "jscad-cad"), null);
    const task =
      "FC_NUM_RUNS=10000 deno test --allow-read --allow-write --allow-env=FC_NUM_RUNS extensions/models/jscad_cad_property_test.ts";
    const previous = await writeGeneratedTask(root, "jscad-cad", task);
    assertEquals(previous, null);
    assertEquals(await readActualSoakTask(root, "jscad-cad"), task);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("writeGeneratedTask: a second write with the SAME task does not rewrite the file (mtime-stable no-op)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-noop-" });
  try {
    await writeExtension(root, "widget", { testTask: "deno test" });
    const task = "FC_NUM_RUNS=10000 deno test";
    await writeGeneratedTask(root, "widget", task);
    const path = join(root, "widget", "deno.json");
    const before = await Deno.stat(path);
    await new Promise((r) => setTimeout(r, 20));
    await writeGeneratedTask(root, "widget", task);
    const after = await Deno.stat(path);
    assertEquals(before.mtime?.getTime(), after.mtime?.getTime());
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

Deno.test("generate_soak_task.ts --help exits 0 with non-empty usage output", async () => {
  const scriptUrl = new URL("./generate_soak_task.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", scriptUrl.pathname, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  assert(new TextDecoder().decode(stdout).length > 0);
});

Deno.test("generate_soak_task.ts CLI: check mode (no --write) reports a diff, exits 1, and writes nothing", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-cli-check-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      existingSoakTask: "FC_NUM_RUNS=10000 deno test",
    });
    const before = await Deno.readTextFile(join(root, "widget", "deno.json"));
    const scriptUrl = new URL("./generate_soak_task.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        scriptUrl.pathname,
      ],
      env: { QUALITY_REPO_ROOT: root },
      stdout: "piped",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    assertEquals(code, 1);
    const after = await Deno.readTextFile(join(root, "widget", "deno.json"));
    assertEquals(after, before, "check mode must never write");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generate_soak_task.ts CLI: --write updates deno.json in place and then exits 0 on the next check", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-cli-write-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
    });
    const scriptUrl = new URL("./generate_soak_task.ts", import.meta.url);
    const writeCmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        scriptUrl.pathname,
        "--write",
        "widget",
      ],
      env: { QUALITY_REPO_ROOT: root },
      stdout: "piped",
      stderr: "piped",
    });
    const writeResult = await writeCmd.output();
    assertEquals(writeResult.code, 0);
    assertEquals(
      await readActualSoakTask(root, "widget"),
      "FC_NUM_RUNS=10000 deno test --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",
    );

    const checkCmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        scriptUrl.pathname,
      ],
      env: { QUALITY_REPO_ROOT: root },
      stdout: "piped",
      stderr: "piped",
    });
    const checkResult = await checkCmd.output();
    assertEquals(checkResult.code, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generate_soak_task.ts CLI: --json <path> writes a machine-parseable {checked, results} summary", async () => {
  const root = await Deno.makeTempDir({ prefix: "gen-soak-cli-json-" });
  try {
    await writeExtension(root, "widget", { testTask: "deno test" });
    const jsonPath = join(root, "summary.json");
    const scriptUrl = new URL("./generate_soak_task.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        scriptUrl.pathname,
        "--json",
        jsonPath,
      ],
      env: { QUALITY_REPO_ROOT: root },
      stdout: "piped",
      stderr: "piped",
    });
    await cmd.output();
    const summary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(summary.checked, ["widget"]);
    assertEquals(summary.results.length, 1);
    assertEquals(summary.results[0].status, "would-write");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
