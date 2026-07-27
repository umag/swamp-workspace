/**
 * Scaffolder domain service: a merge-preserving quality.yaml generator. Two
 * jobs, never confused:
 *
 *  1. No quality.yaml exists yet -> generate one from on-disk suite
 *     detection (role-keyword heuristic over test file names) plus the
 *     extension name, defaulting any suite it cannot find evidence for to
 *     "backlog" — the extension is, by construction, an offender the day
 *     this lands (see STANDARD.md "Seeding the baseline").
 *  2. A quality.yaml already exists -> return it UNCHANGED, byte for byte.
 *     Scaffolding never overwrites a human-authored file, so na/backlog
 *     justifications survive forever once written (the round-1 plan-review
 *     HIGH finding this module exists to close).
 */
import { dirname, fromFileUrl, join, relative } from "jsr:@std/path@1";
import { walk } from "jsr:@std/fs@1/walk";
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "jsr:@std/yaml@1.0.10";
import {
  BACKLOG_TRACKING_ISSUE,
  type QualityFile,
  QualityFileSchema,
  REQUIRED_SUITES,
  SCHEMA_VERSION,
  type SuiteName,
} from "./schema.ts";

export interface ScaffoldInput {
  extensionName: string;
  /** Path to the extension's quality.yaml (may not exist yet). */
  qualityPath: string;
  /** Suite name -> declared test files already known to exist for this
   * extension. Suites absent from this map default to "backlog". When
   * omitted, `scaffoldQualityFile` runs `detectSuiteFiles` against the
   * extension's own directory (derived from `qualityPath`). */
  detectedSuites?: Partial<Record<SuiteName, string[]>>;
}

export type ScaffoldOutcome =
  | { action: "created"; content: string; data: QualityFile }
  | { action: "unchanged"; content: string; data: QualityFile };

const DEFAULT_BACKLOG_JUSTIFICATION =
  `seeded offender at CI-gate rollout — backfill tracked in ${BACKLOG_TRACKING_ISSUE}`;

/** Keyword -> suite classification, checked against the file's basename.
 * Order matters: more specific keywords are checked before the generic
 * fallback below. */
const ROLE_KEYWORDS: Array<{ suite: SuiteName; keywords: string[] }> = [
  { suite: "adversarial", keywords: ["adversarial"] },
  { suite: "coverage", keywords: ["coverage"] },
  {
    suite: "property-invariant-flow",
    keywords: ["property", "invariant", "flow"],
  },
  { suite: "methods", keywords: ["methods"] },
  { suite: "contract-fixture", keywords: ["contract", "fixture"] },
];

/** Splits a filename into delimiter-bounded tokens (on `_`, `.`, `-`) so a
 * keyword must match a WHOLE token, never a bare substring — otherwise
 * "workflow_patch.test.ts" would false-positive-match "flow" (it contains
 * the substring but is not a flow test) and misclassify the file. */
function tokensOf(basename: string): string[] {
  return basename.toLowerCase().split(/[_.\-]+/).filter(Boolean);
}

function classifyByKeyword(basename: string): SuiteName | undefined {
  const tokens = tokensOf(basename);
  for (const { suite, keywords } of ROLE_KEYWORDS) {
    if (keywords.some((k) => tokens.includes(k))) return suite;
  }
  return undefined;
}

/**
 * Scan `extensionDir` for test files (`*_test.ts` / `*.test.ts`) and
 * classify each by ROLE keyword in its filename. A single unclassified test
 * file (no role keyword at all) is treated as the extension's basic
 * contract/fixture test — the lowest-common-denominator role every
 * extension with at least one test file satisfies.
 */
export async function detectSuiteFiles(
  extensionDir: string,
): Promise<Partial<Record<SuiteName, string[]>>> {
  const testFiles: string[] = [];
  for await (
    const entry of walk(extensionDir, {
      includeDirs: false,
      match: [/(_test|\.test)\.ts$/],
      skip: [/\/fixtures\//, /\/node_modules\//],
    })
  ) {
    testFiles.push(relative(extensionDir, entry.path));
  }

  const result: Partial<Record<SuiteName, string[]>> = {};
  const unclassified: string[] = [];
  for (const file of testFiles) {
    const suite = classifyByKeyword(file.split("/").pop() ?? file);
    if (suite) {
      (result[suite] ??= []).push(file);
    } else {
      unclassified.push(file);
    }
  }
  if (unclassified.length > 0) {
    (result["contract-fixture"] ??= []).push(...unclassified);
  }
  return result;
}

function buildDefaultQuality(
  extensionName: string,
  detected: Partial<Record<SuiteName, string[]>>,
): QualityFile {
  const tests = Object.fromEntries(
    REQUIRED_SUITES.map((suite) => {
      const files = detected[suite];
      if (files && files.length > 0) {
        return [suite, { state: "present", files } as const];
      }
      return [
        suite,
        {
          state: "backlog",
          justification: DEFAULT_BACKLOG_JUSTIFICATION,
        } as const,
      ];
    }),
  ) as QualityFile["tests"];

  return {
    schemaVersion: SCHEMA_VERSION,
    extension: extensionName,
    tests,
    watch: {
      state: "backlog",
      justification: DEFAULT_BACKLOG_JUSTIFICATION,
    },
    canary: {
      state: "backlog",
      justification: DEFAULT_BACKLOG_JUSTIFICATION,
    },
    docs: {
      readme: {
        state: "backlog",
        justification: DEFAULT_BACKLOG_JUSTIFICATION,
      },
      changelog: {
        state: "backlog",
        justification: DEFAULT_BACKLOG_JUSTIFICATION,
      },
      skill: { state: "backlog", justification: DEFAULT_BACKLOG_JUSTIFICATION },
    },
    // rubricVersion: 3 must track whatever rubric `swamp extension quality`
    // is currently live on (verified 2026-07: rubricVersion 3,
    // maxEarnablePoints 14) — score_ratchet.ts's evaluateRatchet() treats a
    // mismatch as "rebaseline", never a fail, so drifting this default is
    // self-correcting but should still be bumped deliberately alongside a
    // real rubric bump rather than left stale by accident.
    ratchet: { rubricVersion: 3, baselinePercentage: 0, label: "unscored" },
  };
}

/**
 * Generate-if-absent / merge-preserving: reads `qualityPath` if it exists
 * and returns it verbatim (parsed + validated, but the ORIGINAL file bytes
 * on disk are never touched); otherwise writes a fresh default file. Never
 * mutates an existing file's content — a second run on an authored file is
 * always a no-op.
 */
export async function scaffoldQualityFile(
  input: ScaffoldInput,
): Promise<ScaffoldOutcome> {
  let existing: string | undefined;
  try {
    existing = await Deno.readTextFile(input.qualityPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  if (existing !== undefined) {
    const parsed = QualityFileSchema.parse(parseYaml(existing));
    return { action: "unchanged", content: existing, data: parsed };
  }

  const detected = input.detectedSuites ??
    await detectSuiteFiles(dirname(input.qualityPath));
  const data = buildDefaultQuality(input.extensionName, detected);
  const banner =
    `# Generated by scripts/quality/scaffold.ts — see STANDARD.md.\n` +
    `# This file is then HAND-MAINTAINED: the scaffolder never overwrites an\n` +
    `# existing quality.yaml, so edits (justifications, suite states) persist.\n`;
  // lineWidth: -1 disables line-folding — every field stays on one line, so
  // a justification long enough to otherwise wrap never produces a
  // multi-line folded scalar a human hand-editing the file could corrupt.
  const content = banner +
    stringifyYaml(data as unknown as Record<string, unknown>, {
      lineWidth: -1,
    });
  await Deno.writeTextFile(input.qualityPath, content);
  return { action: "created", content, data };
}

function printHelp() {
  console.log(
    `scaffold.ts — generate a quality.yaml for one extension (if absent)

Usage:
  deno run --allow-read --allow-write scripts/quality/scaffold.ts [--help] <extension-name>

Never overwrites an existing quality.yaml — safe to re-run against every
extension; already-authored files are returned unchanged.
`,
  );
}

// Extension names are directory names on disk (see extensions.ts) — never
// accept anything else here. Without this, `deno run scaffold.ts
// ../../../../etc` would `join(root, name, "quality.yaml")` straight past
// the repo root and write to an arbitrary filesystem location.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

if (import.meta.main) {
  if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
    printHelp();
    Deno.exit(0);
  }
  const name = Deno.args.find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("error: missing <extension-name> argument (see --help)");
    Deno.exit(1);
  }
  if (!SAFE_NAME.test(name) || name === "." || name === "..") {
    console.error(
      `error: invalid <extension-name> "${name}" — must match ${SAFE_NAME} ` +
        `(a real extension directory name, no path separators or traversal)`,
    );
    Deno.exit(1);
  }
  const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const outcome = await scaffoldQualityFile({
    extensionName: name,
    qualityPath: join(root, name, "quality.yaml"),
  });
  console.log(`${name}: ${outcome.action}`);
}
