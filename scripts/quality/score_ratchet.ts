/**
 * ScoreRatchet domain service: compares an extension's live
 * `swamp extension quality <manifest> --json` score against its recorded
 * quality.yaml baseline, never regressing except across a deliberate rubric
 * version bump. The comparison logic (evaluateRatchet / parseScoreJson) is a
 * pure, offline, injectable-reader-friendly core so it is unit-testable
 * without shelling out to `swamp` or touching the network — the real CLI
 * subprocess call lives only in `readScoreViaSwamp` and the `main()` entry
 * point below.
 */
import { z } from "npm:zod@4";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { listExtensions } from "./extensions.ts";
import { QualityFileSchema } from "./schema.ts";

export interface ScoreSnapshot {
  rubricVersion: number;
  percentage: number;
}

export interface RatchetBaseline {
  rubricVersion: number;
  baselinePercentage: number;
}

export type RatchetOutcome =
  | { status: "pass" }
  | { status: "fail"; message: string }
  | { status: "rebaseline"; message: string };

/**
 * Compare a live score snapshot against a recorded baseline. A rubric
 * version change ALWAYS surfaces as "rebaseline", never "fail" — even if the
 * raw percentage also dropped — because a rubric bump changes what the
 * percentage means (see STANDARD.md "Why rubric-version-aware").
 */
export function evaluateRatchet(
  current: ScoreSnapshot,
  baseline: RatchetBaseline,
): RatchetOutcome {
  if (current.rubricVersion !== baseline.rubricVersion) {
    return {
      status: "rebaseline",
      message:
        `rubricVersion changed ${baseline.rubricVersion} -> ${current.rubricVersion}; ` +
        `rebaseline required (record a new baselinePercentage + rubricVersion), not a failure`,
    };
  }
  if (current.percentage < baseline.baselinePercentage) {
    return {
      status: "fail",
      message:
        `score dropped: baseline ${baseline.baselinePercentage}% -> current ${current.percentage}% ` +
        `(rubricVersion ${current.rubricVersion})`,
    };
  }
  return { status: "pass" };
}

// Deliberately NOT .strict(): the real payload carries many more fields
// (status, earnedPoints, factors, dependencyTrust, ...) that this module has
// no use for — only rubricVersion + percentage are read, so unknown keys are
// stripped rather than rejected.
const ScoreJsonSchema = z.object({
  rubricVersion: z.number().int().positive(),
  percentage: z.number().min(0).max(100),
});

export type ParseScoreResult =
  | { ok: true; data: ScoreSnapshot }
  | { ok: false; error: string };

/** Parse the raw stdout of `swamp extension quality <manifest> --json`.
 * Never throws — malformed JSON or a schema mismatch both come back as
 * `{ ok: false }` so a single bad extension cannot crash the whole ratchet
 * pass. */
export function parseScoreJson(raw: string): ParseScoreResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${String(err)}` };
  }
  const result = ScoreJsonSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => i.message).join("; "),
    };
  }
  return {
    ok: true,
    data: {
      rubricVersion: result.data.rubricVersion,
      percentage: result.data.percentage,
    },
  };
}

/** Real (non-test) score reader: shells out to `swamp extension quality` via
 * Deno.Command array args (never a shell string) so a crafted manifest path
 * can never become a command-injection vector. */
export async function readScoreViaSwamp(
  manifestPath: string,
  swampBin = "swamp",
): Promise<string> {
  const cmd = new Deno.Command(swampBin, {
    args: ["extension", "quality", manifestPath, "--json"],
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  if (!success) {
    throw new Error(
      `swamp extension quality ${manifestPath} --json failed: ${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
  return new TextDecoder().decode(stdout);
}

export interface RatchetReport {
  extension: string;
  outcome: RatchetOutcome | { status: "skipped"; reason: string };
}

/**
 * Run the ratchet across every extension with a quality.yaml, using
 * `reader` (defaults to the real `swamp` subprocess) to fetch each live
 * score. Extensions with no quality.yaml, or a ratchet block that fails to
 * parse, are reported as "skipped" (check_compliance.ts already reports
 * those as schema violations — this module only owns the score comparison).
 */
export async function runRatchet(
  root: string,
  reader: (manifestPath: string) => Promise<string> = (p) =>
    readScoreViaSwamp(p),
): Promise<RatchetReport[]> {
  const extensions = await listExtensions({ root });
  const reports: RatchetReport[] = [];
  for (const ext of extensions) {
    const qualityPath = join(root, ext, "quality.yaml");
    let raw: unknown;
    try {
      raw = parseYaml(await Deno.readTextFile(qualityPath));
    } catch {
      reports.push({
        extension: ext,
        outcome: { status: "skipped", reason: "no readable quality.yaml" },
      });
      continue;
    }
    const parsed = QualityFileSchema.safeParse(raw);
    if (!parsed.success) {
      reports.push({
        extension: ext,
        outcome: { status: "skipped", reason: "quality.yaml fails schema" },
      });
      continue;
    }
    const manifestPath = join(root, ext, "manifest.yaml");
    let scoreRaw: string;
    try {
      scoreRaw = await reader(manifestPath);
    } catch (err) {
      reports.push({
        extension: ext,
        outcome: { status: "skipped", reason: `score read failed: ${err}` },
      });
      continue;
    }
    const score = parseScoreJson(scoreRaw);
    if (!score.ok) {
      reports.push({
        extension: ext,
        outcome: {
          status: "skipped",
          reason: `bad score JSON: ${score.error}`,
        },
      });
      continue;
    }
    reports.push({
      extension: ext,
      outcome: evaluateRatchet(score.data, {
        rubricVersion: parsed.data.ratchet.rubricVersion,
        baselinePercentage: parsed.data.ratchet.baselinePercentage,
      }),
    });
  }
  return reports;
}

function printHelp() {
  console.log(`score_ratchet.ts — never regress an extension's quality score

Usage:
  deno run --allow-read --allow-run=swamp scripts/quality/score_ratchet.ts [--help] [--json <path>]

Runs GLOBAL: every extension with a quality.yaml. For each, compares the
LIVE \`swamp extension quality <manifest> --json\` percentage against the
extension's recorded ratchet.baselinePercentage, within the same
ratchet.rubricVersion. A rubric-version change is reported as "rebaseline"
(informational), never a failure. Set QUALITY_REPO_ROOT to scan a tree
other than this script's own repo (used by its tests; CI never needs it).

--json <path>  also write {reports} as JSON to <path> (the sticky
               PR-comment report reads this — see scripts/build-ci-report.ts).

Exit codes:
  0  every extension passed or was skipped/rebaselined
  1  one or more extensions regressed below their recorded baseline
`);
}

if (import.meta.main) {
  const args = Deno.args;
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    Deno.exit(0);
  }
  const jsonFlagIndex = args.indexOf("--json");
  const jsonPath = jsonFlagIndex >= 0 ? args[jsonFlagIndex + 1] : undefined;
  const root = Deno.env.get("QUALITY_REPO_ROOT") ??
    join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const reports = await runRatchet(root);
  let failed = 0;
  for (const r of reports) {
    if (r.outcome.status === "pass") {
      console.log(`${r.extension}: pass`);
    } else if (r.outcome.status === "rebaseline") {
      console.log(`${r.extension}: rebaseline — ${r.outcome.message}`);
    } else if (r.outcome.status === "skipped") {
      console.log(`${r.extension}: skipped — ${r.outcome.reason}`);
    } else {
      failed++;
      console.log(`${r.extension}: FAIL — ${r.outcome.message}`);
      console.log(
        `::error file=${r.extension}/quality.yaml::${r.outcome.message}`,
      );
    }
  }
  if (jsonPath) {
    await Deno.writeTextFile(jsonPath, JSON.stringify({ reports }, null, 2));
  }
  if (failed > 0) {
    console.log(
      `\n${failed} extension(s) regressed below their ratchet baseline.`,
    );
    Deno.exit(1);
  }
  console.log("\nNo ratchet regressions.");
}
