// Build the full tessl + promptfoo CI reports as sticky PR-comment markdown.
//
// Usage: deno run --allow-read --allow-write --allow-env \
//          scripts/build-ci-report.ts <artifacts-dir>
//
// Reads the artifacts uploaded by the skill-review (tessl-<skill>/<skill>.json)
// and skill-trigger-eval (promptfoo-results/promptfoo-results.json) jobs, and
// writes two markdown files to the cwd:
//   tessl-report.md      (marker <!-- ci-report:tessl -->)
//   promptfoo-report.md  (marker <!-- ci-report:promptfoo -->)
// The leading HTML-comment markers let the workflow upsert (edit-in-place) one
// sticky comment per report rather than stacking a new one on every push.

type J = Record<string, unknown>;
const asObj = (v: unknown): J => (v && typeof v === "object" ? v as J : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string => (v == null ? "" : String(v));
const asNum = (v: unknown): number =>
  typeof v === "number" ? v : Number(v) || 0;
const isPlainObject = (v: unknown): v is J =>
  v !== null && typeof v === "object" && !Array.isArray(v);
// Human-readable name for a value's JSON shape, for error messages only.
const describeJsonShape = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "an array" : typeof v;

const artDir = Deno.args[0] ?? "artifacts";
const runUrl = Deno.env.get("RUN_URL") ?? "";
const runLine = runUrl ? ` · [run](${runUrl})` : "";

// Strip any non-JSON preamble (tessl prints "Downloading …" before the JSON).
function stripJsonPreamble(raw: string): string {
  const i = raw.indexOf("{");
  return i >= 0 ? raw.slice(i) : raw;
}

function parseLoose(raw: string): J {
  return asObj(JSON.parse(stripJsonPreamble(raw)));
}

// Like parseLoose, but returns the RAW parsed value instead of silently
// coercing it through asObj — buildCompliance's summary loop below needs to
// tell "parsed to `{}` because the file legitimately contained `{}`" apart
// from "parsed to `null`/an array/a primitive that asObj would have quietly
// turned into `{}`", so it can validate the actual shape instead of trusting
// a coercion that papers over the difference.
function parseJsonRaw(raw: string): unknown {
  return JSON.parse(stripJsonPreamble(raw));
}

async function readArtifact(dir: string): Promise<J | null> {
  try {
    for await (const e of Deno.readDir(`${artDir}/${dir}`)) {
      if (e.isFile && e.name.endsWith(".json")) {
        return parseLoose(
          await Deno.readTextFile(`${artDir}/${dir}/${e.name}`),
        );
      }
    }
  } catch {
    // artifact dir missing (job skipped/failed before upload)
  }
  return null;
}

async function listArtifactDirs(prefix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(artDir)) {
    if (e.isDirectory && e.name.startsWith(prefix)) out.push(e.name);
  }
  return out.sort();
}

function judgeSection(title: string, judge: J): string {
  const evalu = asObj(judge.evaluation);
  const scores = asObj(evalu.scores);
  const norm = asNum(judge.normalizedScore);
  const lines: string[] = [
    `**${title}** — normalized ${(norm * 100).toFixed(0)}%`,
    "",
  ];
  for (const [cat, raw] of Object.entries(scores)) {
    const s = asObj(raw);
    lines.push(`- \`${cat}\`: **${asNum(s.score)}/3** — ${asStr(s.reasoning)}`);
  }
  const assessment = asStr(evalu.overall_assessment);
  if (assessment) lines.push("", `> ${assessment}`);
  const suggestions = asArr(evalu.suggestions).map(asStr);
  lines.push(
    "",
    suggestions.length
      ? `Suggestions:\n${suggestions.map((x) => `- ${x}`).join("\n")}`
      : "Suggestions: _none_",
  );
  return lines.join("\n");
}

function tesslSkillBlock(skill: string, d: J): string {
  const score = asNum(asObj(d.review).reviewScore);
  const ok = score >= 90;
  const v = asObj(d.validation);
  const checks = asArr(v.checks).map(asObj);
  const validationLines = checks.map((c) =>
    `- ${asStr(c.status) === "passed" ? "✓" : "✗"} \`${asStr(c.name)}\` — ${
      asStr(c.message)
    }`
  ).join("\n");
  return [
    `<details><summary><b>${skill}</b> — ${score}/100 ${
      ok ? "✅" : "❌"
    }</summary>`,
    "",
    `**Validation:** ${asNum(v.errorCount)} errors, ${
      asNum(v.warningCount)
    } warnings (${checks.length} checks)`,
    "",
    `<details><summary>validation checks</summary>`,
    "",
    validationLines || "_none_",
    "",
    `</details>`,
    "",
    judgeSection("Description judge", asObj(d.descriptionJudge)),
    "",
    judgeSection("Content judge", asObj(d.contentJudge)),
    "",
    `</details>`,
  ].join("\n");
}

async function buildTessl(): Promise<string> {
  const dirs = await listArtifactDirs("tessl-");
  const skills: Array<{ skill: string; score: number; d: J }> = [];
  for (const dir of dirs) {
    const d = await readArtifact(dir);
    if (!d) continue;
    skills.push({
      skill: dir.replace(/^tessl-/, ""),
      score: asNum(asObj(d.review).reviewScore),
      d,
    });
  }
  skills.sort((a, b) => b.score - a.score);
  const table = [
    "| Skill | Score (/100) | |",
    "|-------|------|---|",
    ...skills.map((s) =>
      `| ${s.skill} | ${s.score} | ${s.score >= 90 ? "✅" : "❌"} |`
    ),
  ].join("\n");
  const failing = skills.filter((s) => s.score < 90);
  const header = failing.length
    ? `❌ ${failing.length} skill(s) below the 90 threshold: ${
      failing.map((s) => `\`${s.skill}\``).join(", ")
    }`
    : `✅ all ${skills.length} skills pass the \`--threshold 90\` gate`;
  return [
    "<!-- ci-report:tessl -->",
    "## tessl skill-review — full report",
    "",
    `\`tessl@0.80.0 skill review --threshold 90\`${runLine}`,
    "",
    header,
    "",
    table,
    "",
    ...skills.map((s) => tesslSkillBlock(s.skill, s.d)),
    "",
  ].join("\n");
}

async function buildPromptfoo(): Promise<string> {
  const d = await readArtifact("promptfoo-results");
  if (!d) {
    return [
      "<!-- ci-report:promptfoo -->",
      "## promptfoo trigger-eval — full report",
      "",
      "_No promptfoo results artifact found for this run._",
      "",
    ].join("\n");
  }
  const results = asObj(d.results);
  const stats = asObj(results.stats);
  const ok = asNum(stats.successes);
  const fail = asNum(stats.failures);
  const errs = asNum(stats.errors);
  const total = ok + fail + errs;
  const rate = total ? (ok / total) * 100 : 0;
  const rows = asArr(results.results).map(asObj);

  const rowLine = (x: J): string => {
    const q = asStr(asObj(x.vars).query).replace(/\|/g, "\\|");
    const out = asStr(asObj(x.response).output).replace(/\|/g, "\\|");
    const mark = x.success ? "✅" : "❌";
    return `| ${mark} | ${q} | ${out} |`;
  };

  const failures = rows.filter((x) => !x.success);
  const failBlock = failures.length
    ? failures.map((x) => {
      const q = asStr(asObj(x.vars).query);
      const out = asStr(asObj(x.response).output);
      const reason = asStr(asObj(x.gradingResult).reason);
      return `- \`${q}\`\n  - routed → \`${out}\`\n  - ${reason}`;
    }).join("\n")
    : "_none_";

  const fullTable = [
    "| | Query | Routed to |",
    "|---|-------|-----------|",
    ...rows.map(rowLine),
  ].join("\n");

  return [
    "<!-- ci-report:promptfoo -->",
    "## promptfoo trigger-eval — full report",
    "",
    `\`promptfoo@0.121.12\` · model \`claude-sonnet-4-5\` · gate ≥90%${runLine}`,
    "",
    `${rate >= 90 ? "✅" : "❌"} **${ok}/${total} = ${
      rate.toFixed(1)
    }%** (${fail} failures, ${errs} errors)`,
    "",
    `### Failures (${failures.length})`,
    "",
    failBlock,
    "",
    `<details><summary>All ${rows.length} results</summary>`,
    "",
    fullTable,
    "",
    "</details>",
    "",
  ].join("\n");
}

function complianceViolationLines(
  violations: J[],
  fileField = "extension",
): string[] {
  if (violations.length === 0) return ["_none_"];
  return violations.map((v) => {
    const scope = asStr(v[fileField]);
    const prefix = scope ? `\`${scope}\`: ` : "";
    return `- ${prefix}**[${asStr(v.rule)}]** ${asStr(v.what)}\n  - WHY: ${
      asStr(v.why)
    }\n  - FIX: ${asStr(v.fix)}`;
  });
}

const RATCHET_SUMMARY_FILENAME = "ratchet-summary.json";
const COMPLIANCE_SUMMARY_FILENAME = "compliance-summary.json";
const ALLOWLIST_SUMMARY_FILENAME = "allowlist-summary.json";

/** Historical section order (Compliance, then Allowlist — the order these
 * two sections rendered in before any generic multi-summary support
 * existed). Any OTHER summary filename (a new validator, e.g.
 * check_property_harness.ts's property-harness-summary.json) sorts after
 * both, ordered alphabetically among itself so a repeat run is
 * deterministic. Score ratchet is not in this table — it's handled
 * separately and always rendered last, both before and after this file
 * gained generic summary support. */
const SECTION_ORDER = [COMPLIANCE_SUMMARY_FILENAME, ALLOWLIST_SUMMARY_FILENAME];

function sectionOrderKey(filename: string): number {
  const idx = SECTION_ORDER.indexOf(filename);
  return idx === -1 ? SECTION_ORDER.length : idx;
}

/** List every `*-summary.json` file dropped into the compliance job's
 * artifact directory, sorted for stable output. GENERIC by design: any
 * validator that writes its own `<name>-summary.json` next to
 * compliance-summary.json / allowlist-summary.json / ratchet-summary.json
 * (e.g. check_property_harness.ts's property-harness-summary.json) is
 * picked up automatically — buildCompliance() never hardcodes the count or
 * names of summary files. */
async function listComplianceSummaryFiles(): Promise<string[]> {
  const dir = `${artDir}/compliance-summary`;
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith("-summary.json")) out.push(e.name);
    }
  } catch {
    // artifact dir missing (job skipped/failed before upload)
  }
  return out.sort();
}

/** Human title for a summary's section heading, derived from its filename
 * (`property-harness-summary.json` -> "Property harness violations") so a
 * newly-added validator needs no code change here to get a labeled section. */
function summaryTitle(filename: string): string {
  const base = filename.replace(/-summary\.json$/, "").replace(/-/g, " ");
  const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
  return `${capitalized} violations`;
}

/** Which key on each violation identifies its scope (the file/extension it
 * belongs to), so the rendered line can prefix it — check_compliance.ts
 * violations carry `extension`, check_property_harness.ts violations carry
 * `file`, check_allowlist.ts violations carry neither (repo-wide). */
function violationScopeField(violations: J[]): string {
  if (violations.some((v) => "extension" in v)) return "extension";
  if (violations.some((v) => "file" in v)) return "file";
  return "";
}

async function buildCompliance(): Promise<string> {
  // check_compliance.ts / check_allowlist.ts / score_ratchet.ts / (any
  // future validator, e.g. check_property_harness.ts) each write their own
  // small --json summary directly to the artifact dir (no per-tool
  // subdirectory the way tessl/promptfoo use) — see the `compliance` job in
  // .github/workflows/ci.yml.
  const summaryFiles = await listComplianceSummaryFiles();

  if (summaryFiles.length === 0) {
    return [
      "<!-- ci-report:compliance -->",
      "## extension quality — compliance report",
      "",
      "_No compliance-summary artifact found for this run._",
      "",
    ].join("\n");
  }

  const summaries: Array<{ filename: string; data: J }> = [];
  // Filenames that existed but failed to parse, OR parsed fine as JSON but
  // not to the expected shape — kept SEPARATE from "no artifact found"
  // (summaryFiles.length === 0, handled above) and from "parsed with zero
  // violations" (a genuinely clean summary). Either kind of failure means
  // we have NO IDEA what that check found — it must never silently
  // collapse into the same 0-violation state a real pass produces (via
  // asObj/asArr quietly coercing `null`/an array/a missing field into
  // `{}`/`[]`), or a corrupted upload / a validator bug that omits
  // `violations` from its own output renders as a false green "all clear"
  // instead of the problem it actually is.
  const unparseableFiles: string[] = [];
  for (const filename of summaryFiles) {
    try {
      const raw = parseJsonRaw(
        await Deno.readTextFile(`${artDir}/compliance-summary/${filename}`),
      );
      if (!isPlainObject(raw)) {
        unparseableFiles.push(
          `${filename} — expected a JSON object, got ${describeJsonShape(raw)}`,
        );
        continue;
      }
      // ratchet-summary.json alone has the distinct {reports: [...]} shape
      // (see the comment on `reports` below); every other summary is
      // expected to be {violations: [...]}. An EMPTY array is a fine,
      // genuinely-clean result — only a missing, null, or non-array field
      // is a shape failure.
      const key = filename === RATCHET_SUMMARY_FILENAME
        ? "reports"
        : "violations";
      if (!Array.isArray(raw[key])) {
        unparseableFiles.push(
          `${filename} — missing or non-array \`${key}\` field`,
        );
        continue;
      }
      summaries.push({ filename, data: raw });
    } catch (err) {
      unparseableFiles.push(
        `${filename} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const complianceSummary = summaries.find((s) =>
    s.filename === COMPLIANCE_SUMMARY_FILENAME
  );
  const ratchetSummary = summaries.find((s) =>
    s.filename === RATCHET_SUMMARY_FILENAME
  );
  // Every summary EXCEPT ratchet is treated as a {violations: [...]} list —
  // ratchet alone has the different {reports: [...]} shape. Rendered in
  // SECTION_ORDER (historical Compliance-then-Allowlist order, any new
  // gate appended after, alphabetically among themselves) rather than
  // filename order, so a newly-added validator can't reshuffle the two
  // existing sections.
  const violationSummaries = summaries
    .filter((s) => s.filename !== RATCHET_SUMMARY_FILENAME)
    .sort((a, b) => {
      const ka = sectionOrderKey(a.filename);
      const kb = sectionOrderKey(b.filename);
      return ka !== kb ? ka - kb : a.filename.localeCompare(b.filename);
    });

  const checkedCount = asArr(complianceSummary?.data.checked).length;

  const reports = asArr(ratchetSummary?.data.reports).map(asObj);
  const ratchetFailures = reports.filter((r) =>
    asStr(asObj(r.outcome).status) === "fail"
  );
  const ratchetRebaselines = reports.filter((r) =>
    asStr(asObj(r.outcome).status) === "rebaseline"
  );
  // "unscorable" (score_ratchet.ts's hard-failure outcome for an extension
  // whose live score could not be obtained at all — the quality tool
  // errored, or printed a score of the wrong shape) is DISTINCT from a
  // benign "skipped" (out of the ratchet's scope) and must count toward
  // totalBlocking below exactly like a "fail" — otherwise this report would
  // render a green header for a run score_ratchet.ts itself exited 1 on,
  // which is precisely the fail-open shape this outcome exists to close.
  const ratchetUnscorable = reports.filter((r) =>
    asStr(asObj(r.outcome).status) === "unscorable"
  );

  let totalViolations = 0;
  const violationSections: string[] = [];
  for (const { filename, data } of violationSummaries) {
    const violations = asArr(data.violations).map(asObj);
    totalViolations += violations.length;
    violationSections.push(
      `### ${summaryTitle(filename)} (${violations.length})`,
      "",
      ...complianceViolationLines(violations, violationScopeField(violations)),
      "",
    );
  }

  const unreadableLines = unparseableFiles.length
    ? unparseableFiles.map((f) => `- \`${f}\``)
    : ["_none_"];

  const totalBlocking = totalViolations + ratchetFailures.length +
    ratchetUnscorable.length;
  const header = unparseableFiles.length > 0
    ? `❌ ${unparseableFiles.length} summary artifact(s) present but unreadable — ` +
      "this run is UNVERIFIED for those checks, do not trust a green result " +
      'below — see STANDARD.md "Running the compliance check locally" to ' +
      "reproduce the failing check and see its actual error" +
      (totalBlocking > 0
        ? ` (plus ${totalBlocking} blocking finding(s) from the checks that did parse)`
        : "")
    : totalBlocking > 0
    ? `❌ ${totalBlocking} blocking finding(s) — see STANDARD.md for the fix pattern`
    : `✅ all ${checkedCount} extensions compliant across ${violationSummaries.length} check(s), no score regressions`;

  const ratchetFailLines = ratchetFailures.length
    ? ratchetFailures.map((r) =>
      `- \`${asStr(r.extension)}\`: ${asStr(asObj(r.outcome).message)}`
    )
    : ["_none_"];
  const rebaselineLines = ratchetRebaselines.length
    ? ratchetRebaselines.map((r) =>
      `- \`${asStr(r.extension)}\`: ${asStr(asObj(r.outcome).message)}`
    )
    : ["_none_"];
  // "reason" (not "message") is unscorable's field name — see
  // RatchetReportOutcome in score_ratchet.ts.
  const unscorableLines = ratchetUnscorable.length
    ? ratchetUnscorable.map((r) =>
      `- \`${asStr(r.extension)}\`: ${asStr(asObj(r.outcome).reason)}`
    )
    : ["_none_"];

  return [
    "<!-- ci-report:compliance -->",
    "## extension quality — compliance report",
    "",
    `Runs GLOBAL (every extension, every run — see STANDARD.md "Why global").${runLine}`,
    "",
    header,
    "",
    `### Unreadable summary artifacts (${unparseableFiles.length})`,
    "",
    ...unreadableLines,
    "",
    ...violationSections,
    `### Score ratchet unscorable (${ratchetUnscorable.length})`,
    "",
    ...unscorableLines,
    "",
    `### Score ratchet failures (${ratchetFailures.length})`,
    "",
    ...ratchetFailLines,
    "",
    `<details><summary>Rubric-version rebaselines (${ratchetRebaselines.length}, informational)</summary>`,
    "",
    ...rebaselineLines,
    "",
    "</details>",
    "",
  ].join("\n");
}

const tessl = await buildTessl();
const promptfoo = await buildPromptfoo();
const compliance = await buildCompliance();
await Deno.writeTextFile("tessl-report.md", tessl);
await Deno.writeTextFile("promptfoo-report.md", promptfoo);
await Deno.writeTextFile("compliance-report.md", compliance);
console.log(
  `tessl-report.md (${tessl.length} chars), promptfoo-report.md (${promptfoo.length} chars), ` +
    `compliance-report.md (${compliance.length} chars)`,
);
