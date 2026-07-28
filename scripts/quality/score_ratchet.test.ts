/**
 * Tests for the ScoreRatchet domain service. All tests here are OFFLINE — no
 * network, no `swamp` subprocess — via an injectable score reader, per the
 * plan's explicit requirement that this module be unit-testable in
 * isolation from the checker that shells out to `swamp extension quality`.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { evaluateRatchet, parseScoreJson } from "./score_ratchet.ts";

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
      join(root, "widget", "quality.yaml"),
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
