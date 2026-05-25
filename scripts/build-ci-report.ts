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

const artDir = Deno.args[0] ?? "artifacts";
const runUrl = Deno.env.get("RUN_URL") ?? "";
const runLine = runUrl ? ` · [run](${runUrl})` : "";

// Strip any non-JSON preamble (tessl prints "Downloading …" before the JSON).
function parseLoose(raw: string): J {
  const i = raw.indexOf("{");
  return asObj(JSON.parse(i >= 0 ? raw.slice(i) : raw));
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

const tessl = await buildTessl();
const promptfoo = await buildPromptfoo();
await Deno.writeTextFile("tessl-report.md", tessl);
await Deno.writeTextFile("promptfoo-report.md", promptfoo);
console.log(
  `tessl-report.md (${tessl.length} chars), promptfoo-report.md (${promptfoo.length} chars)`,
);
