/**
 * SoakTaskParityGuard domain service: the PR-time gate that keeps every
 * extension's hand-authored `deno.json` `test:soak` task from EVER drifting
 * from its generated, canonical form again.
 *
 * scripts/quality/generate_soak_task.ts computes what `test:soak` SHOULD be,
 * straight from the same single source of truth the nightly soak already
 * resolves permissions from (scripts/soak_schedule.ts's resolveDenoArgs /
 * scripts/lib/soak_permissions.ts's deriveSoakArgsFromTestTask). This module
 * imports that computation — never re-derives it — and, for every extension
 * that has at least one discovered `*_property_test.ts` file AND a `test`
 * task to derive from, compares the generated value against what
 * `deno.json` actually says. A mismatch is exactly the failure mode this
 * whole PR exists to close permanently: a `test` task changed (a new
 * `--allow-read` scope, a new runtime flag) with no matching update to
 * `test:soak`, so `deno task test:soak` NotCapable-fails the moment a
 * developer actually runs it locally — the same permission-starvation bug
 * fix/soak-permission-source-of-truth (PR #185) already fixed for the
 * NIGHTLY rotation, reintroduced here in the LOCAL entrypoint by hand-copy
 * drift alone.
 *
 * Deliberately skipped, never a violation (mirrors check_soak.ts's own
 * `if (!anchoredByExt.has(extension)) continue` — the same domain boundary,
 * restated here because this is a separate gate, not a re-export of that
 * one):
 *   - an extension with NO discovered property test file at all — nothing
 *     to soak, so "no test:soak task" is correct, not a violation.
 *   - an extension with a property test file but NO "test" task — a
 *     different, more fundamental problem (deno-check itself already
 *     requires a working test task) that this gate has no derivation to
 *     compare against; not this gate's problem to report a SECOND time.
 */
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { listExtensions } from "./extensions.ts";
import {
  discoverFilesByExtension,
  generateSoakTask,
  readActualSoakTask,
} from "./generate_soak_task.ts";

export interface Violation {
  extension: string;
  rule: string;
  what: string;
  why: string;
  fix: string;
}

export interface CheckSoakParityResult {
  checked: string[];
  violations: Violation[];
}

/**
 * Regenerates every extension's expected `test:soak` task (via
 * generateSoakTask, the SAME function generate_soak_task.ts's own CLI uses)
 * and compares it against `deno.json`'s actual value. Aggregates every
 * mismatch before returning — never aborts on the first offending
 * extension, matching every sibling gate in this directory.
 */
export async function checkSoakParity(
  root: string,
): Promise<CheckSoakParityResult> {
  const extensions = await listExtensions({ root });
  const filesByExtension = await discoverFilesByExtension(root);
  const violations: Violation[] = [];

  for (const extension of extensions) {
    // No discovered property test file at all — nothing to soak, not this
    // gate's problem (see the module docblock's "deliberately skipped"
    // note).
    if (!filesByExtension.has(extension)) continue;

    const generated = await generateSoakTask(root, extension, filesByExtension);
    if (!generated.ok) {
      // Only reachable when the property-file check above passed but
      // readTestTask still returned null (no "test" task) — a different,
      // more fundamental gate's problem, not this one's to report again.
      continue;
    }

    const { task: expected } = generated.generated;
    const actual = await readActualSoakTask(root, extension);

    if (actual === expected) continue;

    violations.push({
      extension,
      rule: "soak-task-parity-mismatch",
      what: actual === null
        ? `${extension}/deno.json has no "test:soak" task, but one can be ` +
          `generated: ${JSON.stringify(expected)}`
        : `${extension}/deno.json's "test:soak" task does not match its ` +
          `generated, canonical form — actual: ${JSON.stringify(actual)}, ` +
          `expected: ${JSON.stringify(expected)}`,
      why: "test:soak used to be hand-copied from the test task's " +
        "permission flags, and that hand-copy already silently drifted for " +
        "5 of 52 extensions (a NotCapable failure the first time a " +
        "developer actually ran `deno task test:soak` locally) before this " +
        "gate existed — test:soak must always be a GENERATED artifact of " +
        "the extension's own test task (and any narrowed quality.yaml " +
        "soak: override), never hand-maintained again",
      fix: "run `cd scripts && deno task quality:generate-soak -- " +
        `${extension} --write\` (or with no extension name to regenerate ` +
        "every extension at once), then commit the updated deno.json",
    });
  }

  return { checked: extensions, violations };
}

function printHelp() {
  console.log(
    `check_soak_parity.ts — PR-time gate: every extension's "test:soak" task must match its generated, canonical form

Usage:
  deno run --allow-read --allow-write scripts/quality/check_soak_parity.ts [--help] [--json <path>]

For every extension with at least one *_property_test.ts file and a "test"
task, regenerates the expected "test:soak" deno.json task (via
generate_soak_task.ts's generateSoakTask — the SAME derivation
scripts/soak_schedule.ts uses for the nightly rotation) and compares it
against what deno.json actually declares. A mismatch (missing, or present
but different) is a violation.

Set QUALITY_REPO_ROOT to scan a tree other than this script's own repo
(used by its tests; CI never needs it).

--json <path>  also write {checked, violations} as JSON to <path> (the
               sticky PR-comment report reads this — see
               scripts/build-ci-report.ts).

Exit codes:
  0  every checked extension's test:soak already matches its generated form
  1  one or more mismatches found (also emits a GitHub ::error annotation
     per violation when running in CI)
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
  const { checked, violations } = await checkSoakParity(root);
  console.log(`Checked ${checked.length} extension(s).`);
  for (const v of violations) {
    console.log(
      `${v.extension}: [${v.rule}] ${v.what}\n  WHY: ${v.why}\n  FIX: ${v.fix}`,
    );
    console.log(
      `::error file=${v.extension}/deno.json::${v.what} — ${v.fix}`,
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
  console.log("Every extension's test:soak task matches its generated form.");
}
