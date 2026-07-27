/**
 * Tests for the ComplianceChecker orchestrator. The critical property under
 * test is AGGREGATION: with 48 real extensions on the line, a checker that
 * aborts on the first bad file forces a fix-run-fix cycle per extension.
 * These tests build small temp-dir fixture trees (cleaned up in finally) so
 * they never depend on the real repo's current compliance state.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "jsr:@std/path@1";
import { checkCompliance, checkExtension } from "./check_compliance.ts";

async function writeExtension(
  root: string,
  name: string,
  qualityYaml: string | undefined,
  extraFiles: Record<string, string> = {},
) {
  const dir = join(root, name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "manifest.yaml"), `name: ${name}\n`);
  if (qualityYaml !== undefined) {
    await Deno.writeTextFile(join(dir, "quality.yaml"), qualityYaml);
  }
  for (const [path, content] of Object.entries(extraFiles)) {
    const full = join(dir, path);
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
}

const FULLY_COMPLIANT_YAML = (name: string) => `
schemaVersion: 1
extension: ${name}
tests:
  contract-fixture: { state: present, files: ["a_test.ts"] }
  methods: { state: present, files: ["a_test.ts"] }
  adversarial: { state: present, files: ["a_test.ts"] }
  coverage: { state: present, files: ["a_test.ts"] }
  property-invariant-flow: { state: present, files: ["a_test.ts"] }
watch: { state: na, justification: "no external dependency to watch at all" }
canary: { state: na, justification: "no live instance exists for this one" }
docs:
  readme: { state: present, files: ["README.md"] }
  changelog: { state: na, justification: "unreleased, no changelog needed yet" }
  skill: { state: na, justification: "bundles no Claude skill whatsoever" }
ratchet: { rubricVersion: 3, baselinePercentage: 100, label: "Grade A" }
`;

const OFFENDER_YAML = (name: string) => `
schemaVersion: 1
extension: ${name}
tests:
  contract-fixture: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  methods: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  adversarial: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  coverage: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  property-invariant-flow: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
watch: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
canary: { state: na, justification: "no live instance exists for this one" }
docs:
  readme: { state: present, files: ["README.md"] }
  changelog: { state: backlog, justification: "seeded offender, tracked in ext-quality-test-backfill" }
  skill: { state: na, justification: "bundles no Claude skill whatsoever" }
ratchet: { rubricVersion: 3, baselinePercentage: 40, label: "Grade C" }
`;

Deno.test("checkExtension passes a fully compliant extension with real declared files", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    await writeExtension(root, "alpha", FULLY_COMPLIANT_YAML("alpha"), {
      "a_test.ts": "Deno.test('x', () => {});\n",
      "README.md": "# alpha\n",
    });
    const violations = await checkExtension(root, "alpha", false);
    assertEquals(violations, [], JSON.stringify(violations));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkExtension flags a present suite whose declared file does not exist on disk", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    await writeExtension(root, "alpha", FULLY_COMPLIANT_YAML("alpha"), {
      // a_test.ts deliberately NOT written — declared but missing.
      "README.md": "# alpha\n",
    });
    const violations = await checkExtension(root, "alpha", false);
    assert(violations.length > 0);
    assert(violations.some((v) => v.rule.includes("file-missing")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkExtension fails an extension with a missing quality.yaml", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    await writeExtension(root, "alpha", undefined);
    const violations = await checkExtension(root, "alpha", false);
    assert(violations.some((v) => v.rule === "missing-quality-yaml"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkExtension fails an offender (backlog suites) that is NOT allowlisted", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    await writeExtension(root, "beta", OFFENDER_YAML("beta"), {
      "README.md": "# beta\n",
    });
    const violations = await checkExtension(root, "beta", false);
    assert(violations.length > 0);
    assert(violations.some((v) => v.what.includes("allowlist")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkExtension passes the same offender when it IS allowlisted", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    await writeExtension(root, "beta", OFFENDER_YAML("beta"), {
      "README.md": "# beta\n",
    });
    const violations = await checkExtension(root, "beta", true);
    assertEquals(violations, [], JSON.stringify(violations));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkCompliance AGGREGATES violations across multiple extensions instead of stopping at the first", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    await writeExtension(root, "alpha", undefined); // missing quality.yaml
    await writeExtension(root, "beta", OFFENDER_YAML("beta"), { // not allowlisted
      "README.md": "# beta\n",
    });
    await writeExtension(root, "gamma", FULLY_COMPLIANT_YAML("gamma"), {
      "a_test.ts": "Deno.test('x', () => {});\n",
      "README.md": "# gamma\n",
    });
    await Deno.writeTextFile(join(root, "quality-allowlist.txt"), "");
    const result = await checkCompliance(root);
    assertEquals(result.checked.sort(), ["alpha", "beta", "gamma"]);
    const flaggedExtensions = new Set(
      result.violations.map((v) => v.extension),
    );
    assertEquals(flaggedExtensions.has("alpha"), true);
    assertEquals(flaggedExtensions.has("beta"), true);
    assertEquals(flaggedExtensions.has("gamma"), false);
    assert(
      result.violations.length >= 2,
      "expected violations from BOTH alpha and beta in a single pass",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkCompliance can be scoped to a single extension for local runs", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    await writeExtension(root, "alpha", undefined);
    await writeExtension(root, "beta", OFFENDER_YAML("beta"), {
      "README.md": "# beta\n",
    });
    await Deno.writeTextFile(join(root, "quality-allowlist.txt"), "");
    const result = await checkCompliance(root, "beta");
    assertEquals(result.checked, ["beta"]);
    assert(result.violations.every((v) => v.extension === "beta"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkExtension flags a quality.yaml whose extension: field disagrees with its directory name", async () => {
  // Wiring-level check: schema.test.ts already unit-tests parseQualityFile()
  // rejecting a name mismatch in isolation; this proves checkExtension() (the
  // orchestrator CI actually runs) surfaces the same rejection end to end,
  // not just the pure function.
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    // FULLY_COMPLIANT_YAML("this-is-not-alpha") declares `extension:
    // this-is-not-alpha` inside a directory actually named "alpha".
    await writeExtension(
      root,
      "alpha",
      FULLY_COMPLIANT_YAML("this-is-not-alpha"),
      {
        "a_test.ts": "Deno.test('x', () => {});\n",
        "README.md": "# alpha\n",
      },
    );
    const violations = await checkExtension(root, "alpha", false);
    assert(violations.length > 0);
    assert(
      violations.some((v) =>
        v.rule === "schema-violation" && v.what.includes("this-is-not-alpha")
      ),
      JSON.stringify(violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check_compliance.ts --help exits 0 with non-empty usage output", async () => {
  const scriptUrl = new URL("./check_compliance.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", scriptUrl.pathname, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  assert(new TextDecoder().decode(stdout).length > 0);
});

Deno.test("check_compliance.ts --json <path> writes a machine-parseable summary (CI reporting)", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-cli-" });
  try {
    await writeExtension(root, "alpha", FULLY_COMPLIANT_YAML("alpha"), {
      "a_test.ts": "Deno.test('x', () => {});\n",
      "README.md": "# alpha\n",
    });
    await Deno.writeTextFile(join(root, "quality-allowlist.txt"), "");
    const jsonPath = join(root, "summary.json");
    const scriptUrl = new URL("./check_compliance.ts", import.meta.url);
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
    const { code } = await cmd.output();
    assertEquals(code, 0);
    const summary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(summary.checked, ["alpha"]);
    assertEquals(summary.violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkExtension gives each violation a WHAT/WHY/FIX shape", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-compliance-" });
  try {
    await writeExtension(root, "alpha", undefined);
    const violations = await checkExtension(root, "alpha", false);
    assert(violations.length > 0);
    for (const v of violations) {
      assert(v.what.length > 0, "missing WHAT");
      assert(v.why.length > 0, "missing WHY");
      assert(v.fix.length > 0, "missing FIX");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
