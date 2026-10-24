/**
 * Tests for the ScoreRatchet domain service. All tests here are OFFLINE — no
 * network, no `swamp` subprocess — via an injectable score reader, per the
 * plan's explicit requirement that this module be unit-testable in
 * isolation from the checker that shells out to `swamp extension quality`.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  evaluateRatchet,
  parseScoreJson,
  rewriteRatchetBaseline,
  runRatchet,
} from "./score_ratchet.ts";

Deno.test("evaluateRatchet passes when current percentage >= baseline, same rubric", () => {
  const outcome = evaluateRatchet(
    { rubricVersion: 3, percentage: 100 },
    { rubricVersion: 3, baselinePercentage: 100 },
  );
  assertEquals(outcome.status, "pass");
});

Deno.test("evaluateRatchet passes when current percentage EXCEEDS baseline", () => {
  const outcome = evaluateRatchet(
    { rubricVersion: 3, percentage: 100 },
    { rubricVersion: 3, baselinePercentage: 40 },
  );
  assertEquals(outcome.status, "pass");
});

Deno.test("evaluateRatchet fails when current percentage drops below baseline, same rubric", () => {
  const outcome = evaluateRatchet(
    { rubricVersion: 3, percentage: 30 },
    { rubricVersion: 3, baselinePercentage: 40 },
  );
  assertEquals(outcome.status, "fail");
  if (outcome.status === "fail") {
    assertEquals(outcome.message.includes("40"), true);
    assertEquals(outcome.message.includes("30"), true);
  }
});

Deno.test("evaluateRatchet surfaces 'rebaseline' (not a fail) when rubricVersion changed, even if percentage also dropped", () => {
  const outcome = evaluateRatchet(
    { rubricVersion: 4, percentage: 10 },
    { rubricVersion: 3, baselinePercentage: 100 },
  );
  assertEquals(outcome.status, "rebaseline");
});

Deno.test("parseScoreJson accepts a well-formed swamp extension quality --json payload", () => {
  const raw = JSON.stringify({
    status: "passed",
    rubricVersion: 3,
    earnedPoints: 14,
    maxEarnablePoints: 14,
    percentage: 100,
    allPassed: true,
    factors: [],
  });
  const result = parseScoreJson(raw);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.data.rubricVersion, 3);
    assertEquals(result.data.percentage, 100);
  }
});

Deno.test("parseScoreJson rejects malformed JSON via safeParse, without throwing", () => {
  const result = parseScoreJson("{ not valid json ,,, ");
  assertEquals(result.ok, false);
});

Deno.test("parseScoreJson rejects well-formed JSON missing required fields", () => {
  const result = parseScoreJson(JSON.stringify({ status: "passed" }));
  assertEquals(result.ok, false);
});

Deno.test("parseScoreJson rejects a percentage out of [0, 100] range", () => {
  const raw = JSON.stringify({
    rubricVersion: 3,
    percentage: 140,
  });
  const result = parseScoreJson(raw);
  assertEquals(result.ok, false);
});

Deno.test("parseScoreJson rejects a negative percentage", () => {
  const raw = JSON.stringify({ rubricVersion: 3, percentage: -5 });
  const result = parseScoreJson(raw);
  assertEquals(result.ok, false);
});

Deno.test("parseScoreJson rejects a negative rubricVersion", () => {
  const raw = JSON.stringify({ rubricVersion: -1, percentage: 50 });
  const result = parseScoreJson(raw);
  assertEquals(result.ok, false);
});

Deno.test("score_ratchet.ts --help exits 0 with non-empty usage output", async () => {
  const scriptUrl = new URL("./score_ratchet.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", scriptUrl.pathname, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  assert(new TextDecoder().decode(stdout).length > 0);
});

Deno.test("score_ratchet.ts --json <path> writes a machine-parseable summary using a fake swamp shim", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-ratchet-cli-" });
  const binDir = await Deno.makeTempDir({ prefix: "quality-ratchet-bin-" });
  try {
    // A fake `swamp` on PATH so this CLI-level test stays offline (no real
    // subprocess call, no network) — it always reports 100% at rubric 3,
    // matching the fixture's ratchet baseline exactly (a "pass").
    const shimPath = join(binDir, "swamp");
    await Deno.writeTextFile(
      shimPath,
      `#!/bin/sh\necho '{"rubricVersion":3,"percentage":100}'\n`,
    );
    await Deno.chmod(shimPath, 0o755);

    await Deno.mkdir(join(root, "widget"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "widget", "manifest.yaml"),
      "name: widget\n",
    );
    await Deno.writeTextFile(
      join(root, "widget", "quality-standard.yaml"),
      `
schemaVersion: 1
extension: widget
tests:
  contract-fixture: { state: present, files: ["a_test.ts"] }
  methods: { state: present, files: ["a_test.ts"] }
  adversarial: { state: present, files: ["a_test.ts"] }
  coverage: { state: present, files: ["a_test.ts"] }
  property-invariant-flow: { state: present, files: ["a_test.ts"] }
watch: { state: na, justification: "no external dependency to watch here" }
canary: { state: na, justification: "no live instance exists for this one" }
docs:
  readme: { state: present, files: ["README.md"] }
  changelog: { state: na, justification: "unreleased, no changelog yet" }
  skill: { state: na, justification: "bundles no Claude skill whatsoever" }
ratchet: { rubricVersion: 3, baselinePercentage: 100, label: "Grade A" }
`,
    );

    const jsonPath = join(root, "summary.json");
    const scriptUrl = new URL("./score_ratchet.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run=swamp",
        "--allow-env",
        scriptUrl.pathname,
        "--json",
        jsonPath,
      ],
      env: {
        QUALITY_REPO_ROOT: root,
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    const summary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(summary.reports.length, 1);
    assertEquals(summary.reports[0].extension, "widget");
    assertEquals(summary.reports[0].outcome.status, "pass");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(binDir, { recursive: true });
  }
});

// --- "unscorable" vs benign "skipped" -------------------------------------
//
// The defect this section pins: runRatchet used to report BOTH "the live
// score reader threw" and "this extension has no quality-standard.yaml at all" as
// the same undifferentiated "skipped" outcome, and main() never failed the
// gate on a skip — exactly how seanime's broken model-upgrade chain (which
// makes `swamp extension quality` itself error) stayed invisible in CI.
// These tests pin the split: a reader failure (or a malformed score) must
// surface as "unscorable" and fail the gate; a genuinely absent
// quality-standard.yaml must stay a benign "skipped" and must NOT fail the gate.

const WIDGET_QUALITY_YAML = `
schemaVersion: 1
extension: widget
tests:
  contract-fixture: { state: present, files: ["a_test.ts"] }
  methods: { state: present, files: ["a_test.ts"] }
  adversarial: { state: present, files: ["a_test.ts"] }
  coverage: { state: present, files: ["a_test.ts"] }
  property-invariant-flow: { state: present, files: ["a_test.ts"] }
watch: { state: na, justification: "no external dependency to watch here" }
canary: { state: na, justification: "no live instance exists for this one" }
docs:
  readme: { state: present, files: ["README.md"] }
  changelog: { state: na, justification: "unreleased, no changelog yet" }
  skill: { state: na, justification: "bundles no Claude skill whatsoever" }
ratchet: { rubricVersion: 3, baselinePercentage: 100, label: "Grade A" }
`;

async function makeWidgetWithQualityYaml(root: string): Promise<void> {
  await Deno.mkdir(join(root, "widget"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "widget", "manifest.yaml"),
    "name: widget\n",
  );
  await Deno.writeTextFile(
    join(root, "widget", "quality-standard.yaml"),
    WIDGET_QUALITY_YAML,
  );
}

Deno.test("runRatchet reports a thrown reader error as 'unscorable', not a benign 'skipped'", async () => {
  const root = await Deno.makeTempDir({
    prefix: "quality-ratchet-unscorable-",
  });
  try {
    await makeWidgetWithQualityYaml(root);
    const reports = await runRatchet(root, () => {
      return Promise.reject(
        new Error(
          "swamp extension quality widget/manifest.yaml --json failed: " +
            "Upgrade chain validation failed (push blocked)",
        ),
      );
    });
    assertEquals(reports.length, 1);
    assertEquals(reports[0].extension, "widget");
    assertEquals(reports[0].outcome.status, "unscorable");
    if (reports[0].outcome.status === "unscorable") {
      assert(reports[0].outcome.reason.includes("score read failed"));
      assert(reports[0].outcome.reason.includes("Upgrade chain validation"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runRatchet reports malformed score JSON from a successful reader as 'unscorable'", async () => {
  const root = await Deno.makeTempDir({
    prefix: "quality-ratchet-unscorable-",
  });
  try {
    await makeWidgetWithQualityYaml(root);
    // The reader "succeeded" (no throw) but the tool printed something
    // that does not parse as {rubricVersion, percentage} — e.g. a
    // truncated write or a CLI contract change. This must fail the gate
    // exactly like a thrown reader error, not read as a clean pass.
    const reports = await runRatchet(
      root,
      () => Promise.resolve("{ not valid json ,,, "),
    );
    assertEquals(reports.length, 1);
    assertEquals(reports[0].outcome.status, "unscorable");
    if (reports[0].outcome.status === "unscorable") {
      assert(reports[0].outcome.reason.includes("bad score JSON"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runRatchet reports a missing quality-standard.yaml as a benign 'skipped' and never calls the reader", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-ratchet-skipped-" });
  try {
    await Deno.mkdir(join(root, "widget"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "widget", "manifest.yaml"),
      "name: widget\n",
    );
    // No quality-standard.yaml written — this extension is legitimately outside the
    // ratchet's scope (check_compliance.ts is the gate that fails a
    // missing quality-standard.yaml). A reader that throws proves runRatchet never
    // even attempts to read a live score for it.
    const reports = await runRatchet(root, () => {
      return Promise.reject(
        new Error("reader must never be called for an out-of-scope extension"),
      );
    });
    assertEquals(reports.length, 1);
    assertEquals(reports[0].extension, "widget");
    assertEquals(reports[0].outcome.status, "skipped");
    if (reports[0].outcome.status === "skipped") {
      assertEquals(
        reports[0].outcome.reason,
        "no readable quality-standard.yaml",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("score_ratchet.ts's CLI exits 1 with a ::error annotation when the live score cannot be read (fail loud, not skip)", async () => {
  const root = await Deno.makeTempDir({
    prefix: "quality-ratchet-cli-unscorable-",
  });
  const binDir = await Deno.makeTempDir({ prefix: "quality-ratchet-bin-" });
  try {
    // A fake `swamp` that exits non-zero, exactly like the real CLI does
    // against a broken model upgrade chain (see seanime's "Upgrade chain
    // validation failed (push blocked)" diagnostic this PR fixes).
    const shimPath = join(binDir, "swamp");
    await Deno.writeTextFile(
      shimPath,
      `#!/bin/sh\necho "Upgrade chain validation failed (push blocked)" >&2\nexit 1\n`,
    );
    await Deno.chmod(shimPath, 0o755);

    await makeWidgetWithQualityYaml(root);

    const jsonPath = join(root, "summary.json");
    const scriptUrl = new URL("./score_ratchet.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run=swamp",
        "--allow-env",
        scriptUrl.pathname,
        "--json",
        jsonPath,
      ],
      env: {
        QUALITY_REPO_ROOT: root,
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    assertEquals(code, 1, out);
    assert(
      out.includes("::error file=widget/quality-standard.yaml::"),
      `expected a ::error annotation naming widget/quality-standard.yaml, got:\n${out}`,
    );
    assert(
      out.toUpperCase().includes("UNSCORABLE"),
      `expected the console line to call this out as UNSCORABLE, got:\n${out}`,
    );

    const summary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(summary.reports.length, 1);
    assertEquals(summary.reports[0].outcome.status, "unscorable");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(binDir, { recursive: true });
  }
});

Deno.test("score_ratchet.ts's CLI exits 0 when an extension has no quality-standard.yaml at all (benign, out of scope)", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-ratchet-cli-skip-" });
  try {
    await Deno.mkdir(join(root, "widget"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "widget", "manifest.yaml"),
      "name: widget\n",
    );
    // No quality-standard.yaml, and deliberately no `swamp` shim on PATH at all —
    // if runRatchet ever attempted to read a live score for this
    // extension the process would fail to spawn `swamp` and this test
    // would catch that regression too.
    const jsonPath = join(root, "summary.json");
    const scriptUrl = new URL("./score_ratchet.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run=swamp",
        "--allow-env",
        scriptUrl.pathname,
        "--json",
        jsonPath,
      ],
      env: { QUALITY_REPO_ROOT: root },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));

    const summary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(summary.reports.length, 1);
    assertEquals(summary.reports[0].outcome.status, "skipped");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- rebaseline: record a new baseline after a rubric bump ----------------

const BLOCK_FORM = `# hand-maintained comment that must survive
schemaVersion: 1
extension: widget
ratchet:
  rubricVersion: 3
  baselinePercentage: 100
  label: "Grade A"
`;

Deno.test("rewriteRatchetBaseline rewrites the block-form ratchet and keeps every other line byte-for-byte", () => {
  const out = rewriteRatchetBaseline(BLOCK_FORM, {
    rubricVersion: 4,
    percentage: 92,
  });
  assertEquals(
    out,
    BLOCK_FORM.replace("rubricVersion: 3", "rubricVersion: 4").replace(
      "baselinePercentage: 100",
      "baselinePercentage: 92",
    ),
  );
});

Deno.test("rewriteRatchetBaseline rewrites the flow-form ratchet", () => {
  const out = rewriteRatchetBaseline(WIDGET_QUALITY_YAML, {
    rubricVersion: 4,
    percentage: 84,
  });
  assert(
    out.includes(
      'ratchet: { rubricVersion: 4, baselinePercentage: 84, label: "Grade A" }',
    ),
  );
});

Deno.test("rewriteRatchetBaseline only touches keys inside the ratchet section", () => {
  const text = `notes:
  rubricVersion: 1
  baselinePercentage: 50
ratchet:
  rubricVersion: 3
  baselinePercentage: 0
`;
  const out = rewriteRatchetBaseline(text, {
    rubricVersion: 4,
    percentage: 77,
  });
  assertEquals(
    out,
    `notes:
  rubricVersion: 1
  baselinePercentage: 50
ratchet:
  rubricVersion: 4
  baselinePercentage: 77
`,
  );
});

Deno.test("rewriteRatchetBaseline throws when there is no ratchet section to rewrite", () => {
  let threw = false;
  try {
    rewriteRatchetBaseline("schemaVersion: 1\n", {
      rubricVersion: 4,
      percentage: 90,
    });
  } catch {
    threw = true;
  }
  assert(threw, "a file without a ratchet block must not be silently skipped");
});

Deno.test("runRatchet carries the live score on every scored report", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-ratchet-score-" });
  try {
    await makeWidgetWithQualityYaml(root);
    const reports = await runRatchet(
      root,
      () => Promise.resolve('{"rubricVersion":4,"percentage":92}'),
    );
    assertEquals(reports[0].outcome.status, "rebaseline");
    assertEquals(reports[0].score, { rubricVersion: 4, percentage: 92 });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("score_ratchet.ts --rebaseline writes the live score into quality-standard.yaml for rebaseline outcomes only", async () => {
  const root = await Deno.makeTempDir({ prefix: "quality-ratchet-rebase-" });
  const binDir = await Deno.makeTempDir({ prefix: "quality-ratchet-bin-" });
  try {
    const shimPath = join(binDir, "swamp");
    await Deno.writeTextFile(
      shimPath,
      `#!/bin/sh\necho '{"rubricVersion":4,"percentage":92}'\n`,
    );
    await Deno.chmod(shimPath, 0o755);
    await makeWidgetWithQualityYaml(root);

    const scriptUrl = new URL("./score_ratchet.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run=swamp",
        "--allow-env",
        scriptUrl.pathname,
        "--rebaseline",
      ],
      env: {
        QUALITY_REPO_ROOT: root,
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    assert(new TextDecoder().decode(stdout).includes("widget: rebaselined"));
    const written = await Deno.readTextFile(
      join(root, "widget", "quality-standard.yaml"),
    );
    assert(
      written.includes(
        'ratchet: { rubricVersion: 4, baselinePercentage: 92, label: "Grade A" }',
      ),
      written,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(binDir, { recursive: true });
  }
});
