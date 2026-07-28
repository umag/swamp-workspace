/**
 * ComplianceChecker domain service: validates every extension's quality.yaml
 * against schema.ts, verifies every "present" suite/docs-item actually has
 * its declared files on disk, and aggregates EVERY violation across EVERY
 * extension before exiting — never aborts on the first bad file (a
 * fail-fast checker would force a fix-run-fix cycle across 48 extensions,
 * one at a time). Runs GLOBAL: every extension in the repo, every run,
 * regardless of which files a given PR touched (see STANDARD.md
 * "Why global").
 */
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { listExtensions } from "./extensions.ts";
import { parseQualityFile, REQUIRED_SUITES } from "./schema.ts";
import { readAllowlist } from "./check_allowlist.ts";

export interface Violation {
  extension: string;
  rule: string;
  what: string;
  why: string;
  fix: string;
}

export interface ComplianceResult {
  checked: string[];
  violations: Violation[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function checkDeclaredFiles(
  extDir: string,
  label: string,
  files: string[],
  violations: Violation[],
  extension: string,
): Promise<void> {
  for (const file of files) {
    const full = join(extDir, file);
    if (!(await fileExists(full))) {
      violations.push({
        extension,
        rule: `${label}-file-missing`,
        what: `${label} declares "${file}" but it does not exist`,
        why:
          'a suite/doc marked "present" must be backed by a real file so the ' +
          "standard cannot be gamed by declaring files that were never written",
        fix:
          `create ${file}, or change ${label}'s state to "na"/"backlog" with a ` +
          "justification",
      });
    }
  }
}

/** Validate a single extension: schema + declared-file existence. Never
 * throws on a bad/missing quality.yaml — reports a violation instead, so the
 * caller can keep aggregating across the rest of the tree. */
export async function checkExtension(
  root: string,
  extension: string,
  isAllowlisted: boolean,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  const extDir = join(root, extension);
  const qualityPath = join(extDir, "quality.yaml");

  let raw: unknown;
  try {
    raw = parseYaml(await Deno.readTextFile(qualityPath));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      violations.push({
        extension,
        rule: "missing-quality-yaml",
        what: "no quality.yaml found",
        why:
          "every extension must declare its suite/docs/watch/canary/ratchet " +
          "state so the compliance gate has something to check",
        fix:
          `run: deno run --allow-read --allow-write scripts/quality/scaffold.ts ${extension}`,
      });
      return violations;
    }
    violations.push({
      extension,
      rule: "quality-yaml-unreadable",
      what: `quality.yaml could not be parsed as YAML: ${String(err)}`,
      why:
        "a malformed file silently disables the whole gate for this extension",
      fix: `fix the YAML syntax in ${extension}/quality.yaml`,
    });
    return violations;
  }

  const parsed = parseQualityFile(raw, {
    expectedExtension: extension,
    isAllowlisted,
  });
  if (!parsed.ok) {
    for (const message of parsed.errors) {
      violations.push({
        extension,
        rule: "schema-violation",
        what: message,
        why:
          "quality.yaml must satisfy the schema in scripts/quality/schema.ts",
        fix: `edit ${extension}/quality.yaml to satisfy: ${message}`,
      });
    }
    return violations;
  }

  const data = parsed.data;
  for (const suite of REQUIRED_SUITES) {
    const entry = data.tests[suite];
    if (entry.state === "present") {
      await checkDeclaredFiles(
        extDir,
        `tests.${suite}`,
        entry.files,
        violations,
        extension,
      );
    }
  }
  for (const key of ["readme", "changelog", "skill"] as const) {
    const entry = data.docs[key];
    if (entry.state === "present") {
      await checkDeclaredFiles(
        extDir,
        `docs.${key}`,
        entry.files,
        violations,
        extension,
      );
    }
  }
  if (data.watch.state === "present" && data.watch.sources.length === 0) {
    violations.push({
      extension,
      rule: "watch-empty-sources",
      what: 'watch is "present" but declares zero sources',
      why: "a present watch block must actually watch something",
      fix: "add at least one entry to watch.sources[], or set watch.state to " +
        '"na"/"backlog"',
    });
  }
  return violations;
}

/** Run the checker across every extension under `root` (or just `only`,
 * for a scoped local run), aggregating ALL violations before returning. */
export async function checkCompliance(
  root: string,
  only?: string,
): Promise<ComplianceResult> {
  const allExtensions = await listExtensions({ root });
  const targets = only
    ? allExtensions.filter((e) => e === only)
    : allExtensions;
  const allowlist = await readAllowlist(join(root, "quality-allowlist.txt"));

  const violations: Violation[] = [];
  for (const ext of targets) {
    violations.push(...(await checkExtension(root, ext, allowlist.has(ext))));
  }
  return { checked: targets, violations };
}

function printHelp() {
  console.log(`check_compliance.ts — validate every extension's quality.yaml

Usage:
  deno run --allow-read scripts/quality/check_compliance.ts [--help] [--json <path>] [<extension-name>]

Runs GLOBAL by default (every extension with a manifest.yaml). Pass an
extension name to scope a local run to just that one directory. Set
QUALITY_REPO_ROOT to scan a tree other than this script's own repo (used by
its tests; CI never needs it).

--json <path>  also write {checked, violations} as JSON to <path> (the
               sticky PR-comment report reads this — see
               scripts/build-ci-report.ts).

Exit codes:
  0  every checked extension is compliant
  1  one or more violations found (also emits a GitHub ::error annotation
     per violation when running in CI)
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
  const only = args.find((a, i) =>
    !a.startsWith("-") && i !== jsonFlagIndex + 1
  );
  const root = Deno.env.get("QUALITY_REPO_ROOT") ??
    join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  const { checked, violations } = await checkCompliance(root, only);
  console.log(`Checked ${checked.length} extension(s).`);
  for (const v of violations) {
    console.log(
      `${v.extension}: [${v.rule}] ${v.what}\n  WHY: ${v.why}\n  FIX: ${v.fix}`,
    );
    console.log(
      `::error file=${v.extension}/quality.yaml::${v.what} — ${v.fix}`,
    );
  }
  if (jsonPath) {
    await Deno.writeTextFile(
      jsonPath,
      JSON.stringify({ checked, violations }, null, 2),
    );
  }
  if (violations.length > 0) {
    console.log(
      `\n${violations.length} violation(s) across ${checked.length} extension(s).`,
    );
    Deno.exit(1);
  }
  console.log("All checked extensions are compliant.");
}
