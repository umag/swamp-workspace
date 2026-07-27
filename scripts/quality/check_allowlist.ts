/**
 * AllowlistGuard domain service: the shrink-only guard over
 * quality-allowlist.txt, cross-checked against the immutable
 * quality-offenders.baseline.txt and against every extension's quality.yaml
 * backlog states, so the two sources of truth (the allowlist FILE and the
 * quality.yaml backlog declarations) can never drift apart.
 */
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { listExtensions } from "./extensions.ts";
import { hasAnyBacklog, parseQualityFile } from "./schema.ts";

function parseListFile(content: string): Set<string> {
  const set = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    set.add(trimmed);
  }
  return set;
}

/** Read a newline-delimited allow/baseline list, skipping blank lines and
 * `#`-prefixed comments. Returns an empty set if the file does not exist. */
export async function readAllowlist(path: string): Promise<Set<string>> {
  try {
    return parseListFile(await Deno.readTextFile(path));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return new Set();
    throw err;
  }
}

/** Same line format as the allowlist. */
export async function readBaseline(path: string): Promise<Set<string>> {
  return await readAllowlist(path);
}

export interface AllowlistViolation {
  rule: string;
  what: string;
  why: string;
  fix: string;
}

async function git(
  root: string,
  ...args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args: ["-C", root, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    success: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/**
 * Baseline immutability: a bare subset check (allowlist ⊆ baseline) alone
 * does not stop someone editing the baseline to ADD entries, which would
 * re-open the exact growth path the guard exists to close (round-2 MEDIUM
 * finding). This diffs quality-offenders.baseline.txt against the
 * merge-base with `baseRef` and fails on any ADDED line — removing a line
 * (shrinking the baseline) is never flagged; only growth is. Degrades to
 * "no violation" (not a crash) when there is no git history to diff against
 * (e.g. a fresh checkout with no merge-base) — the caller still has the
 * plain subset check as a floor.
 */
export async function checkBaselineImmutable(
  root: string,
  baselineRelPath: string,
  baseRef = "origin/master",
): Promise<AllowlistViolation[]> {
  const violations: AllowlistViolation[] = [];
  const mergeBase = await git(root, "merge-base", baseRef, "HEAD");
  if (!mergeBase.success) return violations;
  const mergeBaseSha = mergeBase.stdout.trim();

  const diff = await git(
    root,
    "diff",
    `${mergeBaseSha}..HEAD`,
    "--",
    baselineRelPath,
  );
  if (!diff.success) return violations;

  const addedEntries = diff.stdout
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line && !line.startsWith("#"));

  if (addedEntries.length > 0) {
    violations.push({
      rule: "baseline-immutable",
      what:
        `${baselineRelPath} gained ${addedEntries.length} line(s) vs merge-base ` +
        `${mergeBaseSha.slice(0, 12)}: ${addedEntries.join(", ")}`,
      why:
        "the baseline is the write-once seed of allowed offenders; growing it " +
        "re-opens the exact regression path the allowlist guard exists to close",
      fix:
        `revert the added line(s) in ${baselineRelPath} — the baseline must never ` +
        "grow after its initial seed commit",
    });
  }
  return violations;
}

export interface AllowlistCheckResult {
  violations: AllowlistViolation[];
}

/**
 * Full allowlist guard: growth-vs-baseline (both the plain subset check and
 * the merge-base diff), plus the cross-check against every extension's
 * quality.yaml backlog declarations in BOTH directions — a backlog offender
 * missing from the allowlist, and a fully-compliant extension still
 * lingering on it.
 */
export async function checkAllowlist(
  root: string,
): Promise<AllowlistCheckResult> {
  const violations: AllowlistViolation[] = [];
  const allowlistPath = join(root, "quality-allowlist.txt");
  const baselinePath = join(root, "quality-offenders.baseline.txt");

  const allowlist = await readAllowlist(allowlistPath);
  const baseline = await readBaseline(baselinePath);

  for (const name of allowlist) {
    if (!baseline.has(name)) {
      violations.push({
        rule: "allowlist-growth",
        what:
          `"${name}" is on quality-allowlist.txt but not in quality-offenders.baseline.txt`,
        why:
          "the allowlist may only shrink from its seeded baseline — adding a new " +
          "offender that was never in the original seed is disallowed",
        fix:
          `remove "${name}" from quality-allowlist.txt (bring it to full compliance ` +
          "instead), or verify quality-offenders.baseline.txt was seeded correctly",
      });
    }
  }

  violations.push(
    ...(await checkBaselineImmutable(root, "quality-offenders.baseline.txt")),
  );

  const extensions = await listExtensions({ root });
  for (const ext of extensions) {
    let raw: unknown;
    try {
      raw = parseYaml(await Deno.readTextFile(join(root, ext, "quality.yaml")));
    } catch {
      continue; // check_compliance.ts already reports missing/unreadable files
    }
    // Parse leniently (isAllowlisted: true) purely to read the declared
    // suite states — this cross-check's whole JOB is to independently
    // verify whether a backlog-having extension IS allowlisted, so it must
    // not defer to parseQualityFile's own allowlist gate (that gate is what
    // check_compliance.ts enforces per-extension; here we need the raw
    // states regardless of current allowlist membership).
    const parsed = parseQualityFile(raw, {
      expectedExtension: ext,
      isAllowlisted: true,
    });
    if (!parsed.ok) continue; // check_compliance.ts already reports schema errors

    // hasAnyBacklog scans the SAME scope as parseQualityFile's own
    // backlog-requires-allowlisted gate (5 suites + docs — NOT watch/canary,
    // which Phase A only declares, never enforces) so this cross-check can
    // never diverge from the schema's own definition of "carries debt".
    const hasBacklog = hasAnyBacklog(parsed.data);
    if (hasBacklog && !allowlist.has(ext)) {
      violations.push({
        rule: "offender-not-allowlisted",
        what:
          `"${ext}" has >=1 backlog-state block (suite, watch, or docs item) but is ` +
          "not on quality-allowlist.txt",
        why:
          "backlog eligibility == allowlist membership — a backlog block outside " +
          "the allowlist is an unlogged regression",
        fix:
          `add "${ext}" to quality-allowlist.txt (only if this predates the ` +
          "baseline — see STANDARD.md), or complete the missing suite(s)",
      });
    }
    if (!hasBacklog && allowlist.has(ext)) {
      violations.push({
        rule: "allowlist-stale-entry",
        what:
          `"${ext}" is fully compliant (no backlog blocks) but is still on quality-allowlist.txt`,
        why:
          "the allowlist reflects real backlog only — a fully-compliant extension " +
          "left on it hides how much backfill actually remains",
        fix: `remove "${ext}" from quality-allowlist.txt`,
      });
    }
  }

  return { violations };
}

function printHelp() {
  console.log(
    `check_allowlist.ts — guard quality-allowlist.txt against growth and drift

Usage:
  deno run --allow-read --allow-run=git scripts/quality/check_allowlist.ts [--help] [--json <path>]

Checks, in one pass:
  - quality-allowlist.txt is a subset of quality-offenders.baseline.txt
  - quality-offenders.baseline.txt has gained no lines vs its merge-base
  - every backlog-suite extension is on the allowlist, and vice versa

Set QUALITY_REPO_ROOT to scan a tree other than this script's own repo
(used by its tests; CI never needs it).

--json <path>  also write {violations} as JSON to <path> (the sticky
               PR-comment report reads this — see scripts/build-ci-report.ts).

Exit codes:
  0  allowlist and baseline are consistent
  1  growth, baseline tampering, or allowlist/quality.yaml drift detected
`,
  );
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
  const { violations } = await checkAllowlist(root);
  for (const v of violations) {
    console.log(`[${v.rule}] ${v.what}\n  WHY: ${v.why}\n  FIX: ${v.fix}`);
    console.log(`::error file=quality-allowlist.txt::${v.what} — ${v.fix}`);
  }
  if (jsonPath) {
    await Deno.writeTextFile(
      jsonPath,
      JSON.stringify({ violations }, null, 2),
    );
  }
  if (violations.length > 0) {
    console.log(`\n${violations.length} allowlist violation(s).`);
    Deno.exit(1);
  }
  console.log("Allowlist is consistent.");
}
