// Tests for build-ci-report.ts's compliance report, driven end-to-end via
// its actual CLI entrypoint (the same way .github/workflows/ci.yml invokes
// it: `deno run ... build-ci-report.ts <artifacts-dir>`), so this test makes
// no assumption about internal refactoring (export, parameterization, an
// import.meta.main guard) that hasn't happened yet — it only pins observable
// behavior of the script as it is actually used.
//
// The defect: buildCompliance() hardcodes exactly three summary filenames
// (compliance-summary.json, allowlist-summary.json, ratchet-summary.json,
// scripts/build-ci-report.ts:245-248) read from
// `${artifacts-dir}/compliance-summary/`. Any OTHER *-summary.json file
// dropped into that directory by a future validator (e.g. the
// check_property_harness.ts gate this same plan adds in PR A) is silently
// ignored — never rendered into compliance-report.md, never counted toward
// the pass/fail header. This test drops a FOURTH summary file next to the
// three hardcoded ones and asserts its content survives into the rendered
// report. It must fail today.

import { assert } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";

const FOURTH_SUMMARY_MARKER = "FOURTH_SUMMARY_NOT_HARDCODED_MARKER_9f3a1c";

Deno.test("build-ci-report.ts's compliance report renders an ARBITRARY-LENGTH list of summaries — a fourth summary's content must not be silently dropped", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "build-ci-report-" });
  try {
    const summaryDir = join(workDir, "artifacts", "compliance-summary");
    await Deno.mkdir(summaryDir, { recursive: true });

    // The three filenames buildCompliance() currently hardcodes — present
    // and empty, so the "no artifact found" early-return doesn't fire and
    // the header renders the normal "all compliant" path.
    await Deno.writeTextFile(
      join(summaryDir, "compliance-summary.json"),
      JSON.stringify({ checked: [], violations: [] }),
    );
    await Deno.writeTextFile(
      join(summaryDir, "allowlist-summary.json"),
      JSON.stringify({ violations: [] }),
    );
    await Deno.writeTextFile(
      join(summaryDir, "ratchet-summary.json"),
      JSON.stringify({ reports: [] }),
    );

    // A FOURTH summary file — exactly the shape a new validator (e.g.
    // check_property_harness.ts) would drop alongside the other three.
    // buildCompliance() has no fourth hardcoded name, so today this is
    // never read at all.
    await Deno.writeTextFile(
      join(summaryDir, "property-harness-summary.json"),
      JSON.stringify({
        violations: [{
          rule: "property-test-clone-leak",
          what: FOURTH_SUMMARY_MARKER,
          why: "req.clone() leaks ~6KB per stubbed fetch call",
          fix: "snapshot the request eagerly instead of cloning it",
        }],
      }),
    );

    const scriptUrl = new URL("./build-ci-report.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        scriptUrl.pathname,
        "artifacts",
      ],
      cwd: workDir,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    assert(
      code === 0,
      `build-ci-report.ts exited ${code}: ${new TextDecoder().decode(stderr)}`,
    );

    const report = await Deno.readTextFile(
      join(workDir, "compliance-report.md"),
    );
    assert(
      report.includes(FOURTH_SUMMARY_MARKER),
      "compliance-report.md dropped the fourth (non-hardcoded) summary's " +
        "content — buildCompliance() only reads its three hardcoded " +
        "filenames instead of an arbitrary-length list of summaries",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

async function runBuildCiReport(workDir: string): Promise<void> {
  const scriptUrl = new URL("./build-ci-report.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      scriptUrl.pathname,
      "artifacts",
    ],
    cwd: workDir,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  assert(
    code === 0,
    `build-ci-report.ts exited ${code}: ${new TextDecoder().decode(stderr)}`,
  );
}

// The defect: when every `*-summary.json` file present in the compliance
// job's artifact directory exists but fails to parse (corrupted upload,
// truncated write, a validator crash that leaves a partial file), the
// per-file try/catch used to silently skip each one, leaving the
// downstream computation defaulted to zero violations everywhere — the
// report then rendered a green "✅ all 0 extensions compliant..." header,
// a false all-clear that masks a total compliance-pipeline failure. The
// OLD (pre-generic-summary) code didn't have this failure mode: its
// `if (!compliance && !allowlist && !ratchet)` guard checked the PARSED
// values (all null on a parse failure) and fell through to the neutral
// "No compliance-summary artifact found" message instead. A parse failure
// must never read the same as a genuine zero-violation pass.

Deno.test("build-ci-report.ts's compliance report does NOT render a green all-clear when every present summary file fails to parse — it surfaces the parse failure explicitly", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "build-ci-report-" });
  try {
    const summaryDir = join(workDir, "artifacts", "compliance-summary");
    await Deno.mkdir(summaryDir, { recursive: true });

    // Both files present (so the "no artifact found" early-return does not
    // fire) but neither parses as JSON.
    await Deno.writeTextFile(
      join(summaryDir, "compliance-summary.json"),
      "{ not: valid json,,,",
    );
    await Deno.writeTextFile(
      join(summaryDir, "allowlist-summary.json"),
      "also not json at all",
    );

    await runBuildCiReport(workDir);

    const report = await Deno.readTextFile(
      join(workDir, "compliance-report.md"),
    );
    assert(
      !report.includes("✅ all 0 extensions compliant"),
      "compliance-report.md rendered a green all-clear even though every " +
        "present summary file failed to parse — a parse failure must " +
        `never read as success. Report:\n${report}`,
    );
    assert(
      report.includes("compliance-summary.json") &&
        report.includes("allowlist-summary.json"),
      "compliance-report.md must name the specific unreadable summary " +
        `file(s) rather than silencing the failure. Report:\n${report}`,
    );
    assert(
      report.includes("❌"),
      `expected an explicit ❌ problem marker, got:\n${report}`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// --- Shape validation: valid JSON, wrong shape, must never render green ---
//
// The round-1/round-2 fix only guarded JSON.parse THROWING. Valid JSON of
// the wrong shape (null, an array, an object missing `violations`, or
// `violations` explicitly null) used to coerce silently via asObj/asArr
// into `{violations: []}` -- a false green "all compliant" render,
// indistinguishable from a genuine clean pass. These scenarios pin that a
// wrong-shaped summary is now treated exactly like an unparseable one.

async function writeComplianceSummaries(
  workDir: string,
  files: Record<string, string>,
): Promise<void> {
  const summaryDir = join(workDir, "artifacts", "compliance-summary");
  await Deno.mkdir(summaryDir, { recursive: true });
  for (const [fname, content] of Object.entries(files)) {
    await Deno.writeTextFile(join(summaryDir, fname), content);
  }
}

const WRONG_SHAPE_SCENARIOS: ReadonlyArray<readonly [string, string]> = [
  ["a literal JSON `null`", "null"],
  ["a top-level empty JSON array `[]`", "[]"],
  [
    "a valid object missing the `violations` key entirely",
    JSON.stringify({ checked: ["a", "b"] }),
  ],
  [
    "a valid object whose `violations` field is explicitly `null`",
    JSON.stringify({ checked: ["a"], violations: null }),
  ],
];

for (const [name, content] of WRONG_SHAPE_SCENARIOS) {
  Deno.test(`build-ci-report.ts's compliance report treats a compliance-summary.json that is ${name} as UNVERIFIED, not a green pass`, async () => {
    const workDir = await Deno.makeTempDir({ prefix: "build-ci-report-" });
    try {
      await writeComplianceSummaries(workDir, {
        "compliance-summary.json": content,
      });
      await runBuildCiReport(workDir);
      const report = await Deno.readTextFile(
        join(workDir, "compliance-report.md"),
      );
      assert(
        !report.includes("✅ all"),
        `a wrong-shaped compliance-summary.json must never render a green ` +
          `all-clear header. Report:\n${report}`,
      );
      assert(
        report.includes("❌") && report.includes("compliance-summary.json"),
        `expected an explicit ❌ marker naming compliance-summary.json as ` +
          `unreadable. Report:\n${report}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
}

Deno.test("build-ci-report.ts's compliance report does not let a wrong-shaped sibling summary vanish silently next to a real violation", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "build-ci-report-" });
  try {
    await writeComplianceSummaries(workDir, {
      "compliance-summary.json": JSON.stringify({
        checked: ["a"],
        violations: [{
          rule: "x",
          what: "real finding",
          why: "y",
          fix: "z",
        }],
      }),
      "property-harness-summary.json": "null",
    });
    await runBuildCiReport(workDir);
    const report = await Deno.readTextFile(
      join(workDir, "compliance-report.md"),
    );
    assert(
      report.includes("real finding"),
      `the real violation must still render. Report:\n${report}`,
    );
    assert(
      report.includes("property-harness-summary.json"),
      "the null-shaped sibling summary must be named in the unreadable " +
        `section, not silently vanish. Report:\n${report}`,
    );
    assert(
      !report.includes("✅"),
      `a run with an unreadable sibling summary must never render a green ` +
        `marker anywhere in the header. Report:\n${report}`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// The defect: listComplianceSummaryFiles() sorts filenames alphabetically,
// so violationSections (built in filename order) rendered "Allowlist
// violations" BEFORE "Compliance violations" ("allowlist-summary.json" <
// "compliance-summary.json" alphabetically) — the reverse of the
// historically hardcoded Compliance-then-Allowlist order. This pins the
// restored order and confirms a brand-new gate (property-harness-summary
// .json, alphabetically last of the three) is appended AFTER both, not
// interleaved.

Deno.test("build-ci-report.ts's compliance report keeps Compliance before Allowlist (historical order), with a new gate appended after both", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "build-ci-report-" });
  try {
    const summaryDir = join(workDir, "artifacts", "compliance-summary");
    await Deno.mkdir(summaryDir, { recursive: true });

    await Deno.writeTextFile(
      join(summaryDir, "allowlist-summary.json"),
      JSON.stringify({ violations: [] }),
    );
    await Deno.writeTextFile(
      join(summaryDir, "compliance-summary.json"),
      JSON.stringify({ checked: [], violations: [] }),
    );
    await Deno.writeTextFile(
      join(summaryDir, "property-harness-summary.json"),
      JSON.stringify({ violations: [] }),
    );

    await runBuildCiReport(workDir);

    const report = await Deno.readTextFile(
      join(workDir, "compliance-report.md"),
    );
    const complianceIdx = report.indexOf("### Compliance violations");
    const allowlistIdx = report.indexOf("### Allowlist violations");
    const propertyHarnessIdx = report.indexOf(
      "### Property harness violations",
    );
    assert(
      complianceIdx >= 0 && allowlistIdx >= 0 && propertyHarnessIdx >= 0,
      `expected all three section headings to be present. Report:\n${report}`,
    );
    assert(
      complianceIdx < allowlistIdx,
      "Compliance violations must render before Allowlist violations " +
        `(historical order), got Compliance@${complianceIdx} ` +
        `Allowlist@${allowlistIdx}. Report:\n${report}`,
    );
    assert(
      allowlistIdx < propertyHarnessIdx,
      "a new gate's section must render AFTER both Compliance and " +
        `Allowlist, got Allowlist@${allowlistIdx} ` +
        `PropertyHarness@${propertyHarnessIdx}. Report:\n${report}`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
