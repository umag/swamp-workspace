/**
 * Tests for scripts/quality/check_soak_parity.ts — the PR-time gate that
 * fails the build when an extension's hand-authored `deno.json` "test:soak"
 * task no longer matches its generated, canonical form (as computed by
 * generate_soak_task.ts's generateSoakTask — imported here, never
 * re-derived).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "jsr:@std/path@1";
import { checkSoakParity, type Violation } from "./check_soak_parity.ts";

async function writeExtension(
  root: string,
  name: string,
  opts: {
    testTask?: string;
    propertyFiles?: string[];
    qualityYaml?: string;
    existingSoakTask?: string;
    noPropertyFile?: boolean;
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
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ tasks }, null, 2) + "\n",
  );

  if (!opts.noPropertyFile) {
    const propertyFiles = opts.propertyFiles ??
      [`extensions/models/${name.replaceAll("-", "_")}_property_test.ts`];
    for (const pf of propertyFiles) {
      const full = join(dir, pf);
      await Deno.mkdir(dirname(full), { recursive: true });
      await Deno.writeTextFile(full, "");
    }
  }

  if (opts.qualityYaml !== undefined) {
    await Deno.writeTextFile(join(dir, "quality.yaml"), opts.qualityYaml);
  }
}

Deno.test("checkSoakParity: a test:soak that already matches its generated form produces no violation", async () => {
  const root = await Deno.makeTempDir({ prefix: "soak-parity-match-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      existingSoakTask:
        "FC_NUM_RUNS=10000 deno test --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",
    });
    const { violations, checked } = await checkSoakParity(root);
    assertEquals(checked, ["widget"]);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoakParity: a test:soak MISSING a permission the test task grants (the 5-extension real defect) is flagged", async () => {
  const root = await Deno.makeTempDir({ prefix: "soak-parity-drift-" });
  try {
    // lastfm's real shape: test:soak dropped --allow-read=extensions/models,fixtures.
    await writeExtension(root, "lastfm", {
      testTask:
        "deno test --allow-env --allow-read=extensions/models,fixtures extensions/ --permit-no-files",
      existingSoakTask:
        "FC_NUM_RUNS=10000 deno test --allow-env extensions/models/lastfm_property_test.ts",
    });
    const { violations } = await checkSoakParity(root);
    assertEquals(violations.length, 1);
    const v: Violation = violations[0];
    assertEquals(v.extension, "lastfm");
    assertEquals(v.rule, "soak-task-parity-mismatch");
    assert(v.what.includes("does not match"), v.what);
    assert(v.fix.includes("quality:generate-soak"), v.fix);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoakParity: a test:soak that is entirely ABSENT (the 3-extension real defect) is flagged, naming the generated task", async () => {
  const root = await Deno.makeTempDir({ prefix: "soak-parity-missing-" });
  try {
    await writeExtension(root, "jscad-cad", {
      testTask:
        "deno test extensions/models/ --permit-no-files --allow-read --allow-write --allow-run --allow-env --allow-net",
      qualityYaml:
        `soak:\n  state: present\n  denoArgs: ["--allow-read", "--allow-write", "--allow-env=FC_NUM_RUNS"]\n`,
      // no existingSoakTask at all
    });
    const { violations } = await checkSoakParity(root);
    assertEquals(violations.length, 1);
    assert(violations[0].what.includes("has no"), violations[0].what);
    assert(
      violations[0].what.includes(
        "--allow-read --allow-write --allow-env=FC_NUM_RUNS",
      ),
      violations[0].what,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoakParity: a quality.yaml soak: override applied correctly (matching the narrowed args) produces no violation", async () => {
  const root = await Deno.makeTempDir({ prefix: "soak-parity-override-ok-" });
  try {
    await writeExtension(root, "stripe-mpp", {
      testTask:
        "deno test --allow-net --allow-env extensions/models/ --permit-no-files",
      qualityYaml: `soak:\n  state: present\n  denoArgs: ["--allow-env"]\n`,
      existingSoakTask:
        "FC_NUM_RUNS=10000 deno test --allow-env extensions/models/stripe_mpp_property_test.ts",
    });
    const { violations } = await checkSoakParity(root);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoakParity: a test:soak that STILL grants the test task's broader authority (override not applied) is flagged", async () => {
  const root = await Deno.makeTempDir({
    prefix: "soak-parity-override-not-applied-",
  });
  try {
    // swamp-go-brr's real pre-fix shape: test:soak used --allow-all (the
    // test task's own broad grant) instead of the narrowed override.
    await writeExtension(root, "swamp-go-brr", {
      testTask: "deno test --permit-no-files --allow-all extensions/models/",
      qualityYaml:
        `soak:\n  state: present\n  denoArgs: ["--allow-env=FC_NUM_RUNS"]\n`,
      existingSoakTask:
        "FC_NUM_RUNS=5000 deno test --permit-no-files --allow-all extensions/models/swamp_go_brr_property_test.ts",
    });
    const { violations } = await checkSoakParity(root);
    assertEquals(violations.length, 1);
    assertEquals(violations[0].extension, "swamp-go-brr");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoakParity: an extension with NO property test file at all is skipped, not violated", async () => {
  const root = await Deno.makeTempDir({ prefix: "soak-parity-no-property-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test",
      noPropertyFile: true,
    });
    const { violations, checked } = await checkSoakParity(root);
    assertEquals(checked, ["widget"]);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoakParity: an extension with a property file but NO test task is skipped (a different gate's problem)", async () => {
  const root = await Deno.makeTempDir({ prefix: "soak-parity-no-test-task-" });
  try {
    await writeExtension(root, "widget", {}); // no testTask at all
    const { violations } = await checkSoakParity(root);
    assertEquals(violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoakParity: aggregates violations across MULTIPLE extensions, never aborting on the first", async () => {
  const root = await Deno.makeTempDir({ prefix: "soak-parity-multi-" });
  try {
    await writeExtension(root, "alpha", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      existingSoakTask: "FC_NUM_RUNS=10000 deno test",
    });
    await writeExtension(root, "beta", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      existingSoakTask: "FC_NUM_RUNS=10000 deno test",
    });
    await writeExtension(root, "gamma", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      existingSoakTask:
        "FC_NUM_RUNS=10000 deno test --allow-env=FC_NUM_RUNS extensions/models/gamma_property_test.ts",
    });
    const { violations, checked } = await checkSoakParity(root);
    assertEquals(checked.sort(), ["alpha", "beta", "gamma"]);
    assertEquals(violations.map((v) => v.extension).sort(), ["alpha", "beta"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

Deno.test("check_soak_parity.ts --help exits 0 with non-empty usage output", async () => {
  const scriptUrl = new URL("./check_soak_parity.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", scriptUrl.pathname, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  assert(new TextDecoder().decode(stdout).length > 0);
});

Deno.test("check_soak_parity.ts CLI: exits 0 with no violations, exits 1 with a violation, and --json writes a summary", async () => {
  const root = await Deno.makeTempDir({ prefix: "soak-parity-cli-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      existingSoakTask:
        "FC_NUM_RUNS=10000 deno test --allow-env=FC_NUM_RUNS extensions/models/widget_property_test.ts",
    });
    const scriptUrl = new URL("./check_soak_parity.ts", import.meta.url);
    const jsonPath = join(root, "summary.json");
    const okCmd = new Deno.Command(Deno.execPath(), {
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
    const okResult = await okCmd.output();
    assertEquals(okResult.code, 0);
    const okSummary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(okSummary.checked, ["widget"]);
    assertEquals(okSummary.violations, []);

    // Hand-edit the deno.json to introduce drift, then confirm the gate bites.
    const denoJsonPath = join(root, "widget", "deno.json");
    const drifted = JSON.parse(await Deno.readTextFile(denoJsonPath));
    drifted.tasks["test:soak"] = "FC_NUM_RUNS=10000 deno test";
    await Deno.writeTextFile(denoJsonPath, JSON.stringify(drifted, null, 2));

    const failCmd = new Deno.Command(Deno.execPath(), {
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
    const failResult = await failCmd.output();
    assertEquals(failResult.code, 1);
    const failSummary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(failSummary.violations.length, 1);
    assertEquals(failSummary.violations[0].extension, "widget");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
