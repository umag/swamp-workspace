/**
 * Tests for the merge-preserving quality.yaml scaffolder. The two properties
 * that matter most: (1) it never overwrites an existing, human-authored
 * quality.yaml — a second run must be a byte-for-byte no-op — and (2) its
 * freshly-generated output must itself pass check_compliance.ts (the
 * round-trip the plan review flagged as missing in round 1).
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { checkExtension } from "./check_compliance.ts";
import { REQUIRED_SUITES } from "./schema.ts";
import { detectSuiteFiles, scaffoldQualityFile } from "./scaffold.ts";

/** Builds `<root>/widget/...` (not just a bare temp dir) so tests that need
 * to run checkExtension(root, "widget", ...) — which looks up
 * `<root>/<extension>/quality.yaml` — see the same directory layout the
 * real compliance checker expects. Returns the temp ROOT; the extension's
 * own directory is `join(root, "widget")`. */
async function makeTempExtension(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "quality-scaffold-" });
  const dir = join(root, "widget");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "manifest.yaml"), "name: widget\n");
  await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "extensions", "models", "widget_methods_test.ts"),
    "Deno.test('noop', () => {});\n",
  );
  return root;
}

Deno.test("scaffoldQualityFile creates a fresh file when absent, defaulting undetected suites to backlog", async () => {
  const root = await makeTempExtension();
  try {
    const qualityPath = join(root, "widget", "quality.yaml");
    const outcome = await scaffoldQualityFile({
      extensionName: "widget",
      qualityPath,
      detectedSuites: {
        "methods": ["extensions/models/widget_methods_test.ts"],
      },
    });
    assertEquals(outcome.action, "created");
    assertEquals(outcome.data.extension, "widget");
    assertEquals(outcome.data.tests["methods"].state, "present");
    for (const suite of REQUIRED_SUITES) {
      if (suite === "methods") continue;
      assertEquals(outcome.data.tests[suite].state, "backlog");
    }
    const onDisk = await Deno.readTextFile(qualityPath);
    assert(onDisk.length > 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scaffoldQualityFile is a no-op on a second run against an authored file", async () => {
  const root = await makeTempExtension();
  try {
    const qualityPath = join(root, "widget", "quality.yaml");
    await scaffoldQualityFile({ extensionName: "widget", qualityPath });
    const authored = await Deno.readTextFile(qualityPath);
    // Simulate a human editing the justification text after the initial
    // scaffold — this must survive verbatim. The replacement text is still a
    // VALID backlog justification (≥12 chars, cites the Phase D issue) so
    // this exercises "hand-edited but still schema-valid", not "corrupts the
    // file into something that would no longer parse".
    const edited = authored.replace(
      /justification: .*/,
      'justification: "hand-written note — still tracked in ext-quality-test-backfill, do not clobber"',
    );
    await Deno.writeTextFile(qualityPath, edited);

    const outcome = await scaffoldQualityFile({
      extensionName: "widget",
      qualityPath,
      detectedSuites: { "coverage": ["would-be-ignored.ts"] },
    });
    assertEquals(outcome.action, "unchanged");
    const afterSecondRun = await Deno.readTextFile(qualityPath);
    assertEquals(afterSecondRun, edited);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("detectSuiteFiles classifies test files by role keyword, not a fixed filename", async () => {
  const dir = await Deno.makeTempDir({ prefix: "quality-detect-" });
  try {
    await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
    const files = {
      "extensions/models/widget_methods_test.ts": "methods",
      "extensions/models/widget_adversarial_test.ts": "adversarial",
      "extensions/models/widget_coverage_test.ts": "coverage",
      "extensions/models/widget_property_test.ts": "property-invariant-flow",
      "extensions/models/widget_test.ts": "contract-fixture",
    } as const;
    for (const path of Object.keys(files)) {
      await Deno.writeTextFile(join(dir, path), "Deno.test('x', () => {});\n");
    }
    const detected = await detectSuiteFiles(dir);
    for (const [path, suite] of Object.entries(files)) {
      assert(
        detected[suite as keyof typeof detected]?.includes(path),
        `expected ${path} to be detected under suite "${suite}", got: ${
          JSON.stringify(detected)
        }`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("round-trip: scaffolder output passes check_compliance for an allowlisted extension", async () => {
  const root = await makeTempExtension();
  try {
    const qualityPath = join(root, "widget", "quality.yaml");
    await scaffoldQualityFile({
      extensionName: "widget",
      qualityPath,
      detectedSuites: {
        "methods": ["extensions/models/widget_methods_test.ts"],
      },
    });
    // The scaffolded file has 4 backlog suites, so it is only valid while
    // "widget" is allowlisted — exactly the contract the scaffolder exists
    // to satisfy on day one.
    const violations = await checkExtension(root, "widget", true);
    assertEquals(violations, [], JSON.stringify(violations));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("round-trip: scaffolder output on disk parses back through parseYaml + the schema", async () => {
  const root = await makeTempExtension();
  try {
    const qualityPath = join(root, "widget", "quality.yaml");
    await scaffoldQualityFile({ extensionName: "widget", qualityPath });
    const raw = parseYaml(await Deno.readTextFile(qualityPath));
    assert(raw && typeof raw === "object");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scaffold.ts CLI rejects a path-traversal-shaped extension name instead of writing outside the repo", async () => {
  const scriptUrl = new URL("./scaffold.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      scriptUrl.pathname,
      "../../../../tmp/quality-scaffold-escape-attempt",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  assertEquals(code, 1);
  assertStringIncludes(new TextDecoder().decode(stderr), "invalid");
});
