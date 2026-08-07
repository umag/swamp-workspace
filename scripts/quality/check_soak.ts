/**
 * SoakPermissionGuard domain service: the PR-time compliance gate for the
 * property-soak permission pipeline (mirroring check_compliance.ts /
 * check_allowlist.ts / check_property_harness.ts — runs on every PR).
 *
 * Two independent checks, aggregated across every extension before
 * returning (never aborts on the first bad extension):
 *
 *   1. Orphaned property files — a `*_property_test.ts` file that lives
 *      anywhere under `<extension>/extensions/` but structurally escapes
 *      scripts/soak_schedule.ts's anchored (extensions/models/, recursive)
 *      discovery. jscad-cad's nested file was one instance of this (fixed
 *      by making discovery recursive); a file living in a DIFFERENT
 *      extensions/ subtree entirely (extensions/reports/, extensions/lib/,
 *      …) stays orphaned regardless, since discovery is anchored
 *      specifically to extensions/models/.
 *
 *   2. Every scripts/lib/soak_permissions.ts violation class: unsafe
 *      tokens/paths (checked on BOTH the quality.yaml `soak:` override, when
 *      present, AND the argv derived straight from the test task — the
 *      48/51-extension default path), a `soak:` override that EXCEEDS its
 *      own `test` task's authority, a `soak:` override repeating
 *      --allow-net/--allow-env/--allow-run/--allow-sys (deno hard-rejects a
 *      second occurrence of any of these), a `soak:` override combining
 *      --allow-all/-A with any other --allow-X flag (a separate deno
 *      hard-reject class), inadequate FC_NUM_RUNS coverage (also checked on
 *      BOTH paths), and a BROAD test-task grant (--allow-all / unscoped
 *      --allow-run/--allow-net/--allow-ffi/--allow-sys) with no narrowed
 *      override at all.
 */
import { dirname, fromFileUrl, join, relative } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { listExtensions } from "./extensions.ts";
import { discoverPropertyTestFiles } from "../soak_schedule.ts";
import {
  checkSoakAuthority,
  isBroadGrant,
  parsePermissionSet,
  permissionSetToArgs,
  validateNoAllowAllWithOtherAllowFlags,
  validateNoDuplicateHardRejectFlags,
  validatePropertyFilePath,
  validateSoakAdequacy,
  validateTokenSafety,
} from "../lib/soak_permissions.ts";

export interface Violation {
  extension: string;
  rule: string;
  what: string;
  why: string;
  fix: string;
  /** Set only for a violation whose real offending artifact is a file OTHER
   * than quality.yaml (orphaned-property-file, unsafe-property-file-path) —
   * a repo-relative path (relative to the extension directory) the CLI
   * annotation should point `::error file=` at instead of the default
   * `<extension>/quality.yaml`. */
  file?: string;
}

export interface CheckSoakResult {
  checked: string[];
  violations: Violation[];
}

/** Best-effort read of `<ext>/deno.json`'s `tasks.test` string. `null` when
 * missing/unreadable/no test task — this gate has nothing to check for such
 * an extension (deno-check itself already enforces every extension has a
 * working test task). */
async function readTestTask(
  root: string,
  extension: string,
): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(join(root, extension, "deno.json"));
    const json = JSON.parse(raw) as { tasks?: { test?: string } };
    return json.tasks?.test ?? null;
  } catch {
    return null;
  }
}

interface SoakBlock {
  state: "present" | "na" | "backlog";
  denoArgs?: unknown;
}

/** Best-effort read of `<ext>/quality.yaml`'s `soak:` key, loosely (this
 * module only cares whether it's present/na/backlog and, if present, its
 * denoArgs — full schema enforcement is scripts/quality/schema.ts's job via
 * check_compliance.ts). `null` when missing/unreadable/malformed/absent. */
async function readSoakBlock(
  root: string,
  extension: string,
): Promise<SoakBlock | null> {
  try {
    const raw = parseYaml(
      await Deno.readTextFile(join(root, extension, "quality.yaml")),
    );
    if (!raw || typeof raw !== "object") return null;
    const soak = (raw as Record<string, unknown>).soak;
    if (!soak || typeof soak !== "object") return null;
    const state = (soak as Record<string, unknown>).state;
    if (state !== "present" && state !== "na" && state !== "backlog") {
      return null;
    }
    return soak as SoakBlock;
  } catch {
    return null;
  }
}

/** Every `*_property_test.ts` file found ANYWHERE under
 * `<extDir>/extensions/` (recursively, unanchored) — used to detect a file
 * that escapes soak_schedule.ts's anchored (extensions/models/) discovery
 * entirely. */
async function findAllPropertyTestFiles(extDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        await walk(full);
      } else if (e.isFile && e.name.endsWith("_property_test.ts")) {
        out.push(relative(extDir, full));
      }
    }
  }
  await walk(join(extDir, "extensions"));
  return out;
}

export async function checkSoak(root: string): Promise<CheckSoakResult> {
  const extensions = await listExtensions({ root });
  const violations: Violation[] = [];

  // The set soak_schedule.ts actually discovers (anchored, recursive).
  const anchored = await discoverPropertyTestFiles(root);
  const anchoredByExt = new Map<string, Set<string>>();
  for (const f of anchored) {
    if (!anchoredByExt.has(f.extension)) {
      anchoredByExt.set(f.extension, new Set());
    }
    anchoredByExt.get(f.extension)!.add(f.file);
  }

  for (const extension of extensions) {
    const extDir = join(root, extension);

    // 1. Orphaned property files + unsafe paths — checked for every
    // extension, regardless of whether it has any anchored file at all.
    const allFound = await findAllPropertyTestFiles(extDir);
    const anchoredSet = anchoredByExt.get(extension) ?? new Set<string>();
    for (const file of allFound) {
      if (!anchoredSet.has(file)) {
        violations.push({
          extension,
          file,
          rule: "orphaned-property-file",
          what: `${file} is a *_property_test.ts file that is not anchored ` +
            "under extensions/models/",
          why: "the nightly soak (scripts/soak_schedule.ts) only discovers " +
            "files anchored under <extension>/extensions/models/ — a " +
            "property file living anywhere else structurally escapes " +
            "discovery and is never soaked",
          fix:
            `move ${file} under ${extension}/extensions/models/, or delete ` +
            "it if it's dead code",
        });
      }
      for (const v of validatePropertyFilePath(file)) {
        violations.push({ extension, file, ...v });
      }
    }

    // 2. Permission authority — only meaningful for an extension that has
    // at least one anchored property file (the set actually soaked).
    if (!anchoredByExt.has(extension)) continue;

    const testTask = await readTestTask(root, extension);
    if (testTask === null) continue; // no deno.json/test task — not this gate's problem
    const testPermissions = parsePermissionSet(testTask);

    // Token safety applies to the DERIVED path too, not only a hand-authored
    // override: parsePermissionSet's scope capture is unconstrained, so an
    // unsafe deno.json test-task token round-trips through
    // permissionSetToArgs into the argv soak_schedule.ts derives by default
    // (the 48/51-extension common case) with its unsafe characters intact.
    // Checked for EVERY extension with an anchored property file, whether or
    // not it also has a quality.yaml soak: override.
    for (
      const v of validateTokenSafety(permissionSetToArgs(testPermissions))
    ) {
      violations.push({ extension, ...v });
    }

    const soakBlock = await readSoakBlock(root, extension);

    if (soakBlock === null || soakBlock.state !== "present") {
      // No narrowed override declared. Only a problem when the test task's
      // authority is BROAD (isBroadGrant) — an unattended nightly soak must
      // never silently inherit --allow-all / unscoped --allow-run /
      // unscoped --allow-net.
      if (isBroadGrant(testPermissions)) {
        violations.push({
          extension,
          rule: "soak-broad-grant-no-override",
          what:
            `${extension}'s test task grants broad authority (--allow-all, ` +
            "or unscoped --allow-run/--allow-net/--allow-ffi/--allow-sys) " +
            "with no narrowed quality.yaml soak: override",
          why: "an unattended nightly soak must never silently inherit a " +
            "broad permission grant — it needs a human-reviewed, narrowed " +
            "soak: override",
          fix: `add a soak: { state: present, denoArgs: [...] } block to ` +
            `${extension}/quality.yaml, narrowed to only what the property ` +
            "test actually needs",
        });
      }
      // Adequacy (FC_NUM_RUNS reachability) must ALSO be checked on this
      // DERIVED path — it is used verbatim by 48 of 51 extensions
      // (soak_schedule.ts's resolveDenoArgs fallback), not only when a
      // quality.yaml soak: override exists. Without this, an extension with
      // e.g. a scoped --allow-env that omits FC_NUM_RUNS passes this gate
      // clean and then silently runs its nightly soak at the small fallback
      // iteration count instead of the intended high count.
      for (const v of validateSoakAdequacy(testPermissions)) {
        violations.push({ extension, ...v });
      }
      continue;
    }

    const denoArgsRaw = soakBlock.denoArgs;
    if (
      !Array.isArray(denoArgsRaw) ||
      !denoArgsRaw.every((a) => typeof a === "string")
    ) {
      violations.push({
        extension,
        rule: "soak-invalid-denoargs",
        what:
          `${extension}'s quality.yaml soak.denoArgs is present but not an ` +
          "array of strings",
        why:
          "check_soak.ts can only validate a soak: override whose denoArgs " +
          "is a plain string array",
        fix:
          `fix ${extension}/quality.yaml's soak.denoArgs to be an array of ` +
          "deno permission flag strings",
      });
      continue;
    }
    const denoArgs = denoArgsRaw as string[];

    for (const v of validateTokenSafety(denoArgs)) {
      violations.push({ extension, ...v });
    }

    // A hand-authored override repeating --allow-net/--allow-env/--allow-run/
    // --allow-sys (the kinds deno's own CLI hard-rejects on a second
    // occurrence) parses "successfully" through parsePermissionSet's merge
    // logic below but would crash run_soak.ts's `deno test` invocation at
    // 3am — catch it here, at PR time, instead.
    for (const v of validateNoDuplicateHardRejectFlags(denoArgs)) {
      violations.push({ extension, ...v });
    }

    // A hand-authored override combining --allow-all/-A with any OTHER
    // --allow-X flag is a SEPARATE hard-reject class deno's CLI enforces
    // outright ("cannot be used with") — every validator up to this point
    // (checkSoakAuthority, validateSoakAdequacy, validateNoDuplicateHardRejectFlags)
    // approves this combination cleanly, since none of them look for an
    // --allow-all/--allow-X co-occurrence, so it would otherwise pass this
    // PR-time gate and only crash `deno test` at soak time.
    for (const v of validateNoAllowAllWithOtherAllowFlags(denoArgs)) {
      violations.push({ extension, ...v });
    }

    const soakPermissions = parsePermissionSet(denoArgs.join(" "));

    // Every checkSoakAuthority violation class (allow-all not granted,
    // widened scope, extra scope, a flag test lacks, a dropped/narrowed
    // deny) collapses to ONE canonical rule here: each is, from a
    // compliance standpoint, the same finding — the soak override claims
    // more effective authority than its own test task grants.
    for (const v of checkSoakAuthority(testPermissions, soakPermissions)) {
      violations.push({
        extension,
        rule: "soak-exceeds-test-authority",
        what: v.what,
        why: v.why,
        fix: v.fix,
      });
    }

    for (const v of validateSoakAdequacy(soakPermissions)) {
      violations.push({ extension, ...v });
    }
  }

  return { checked: extensions, violations };
}

function printHelp() {
  console.log(
    `check_soak.ts — PR-time gate for the property-soak permission pipeline

Usage:
  deno run --allow-read scripts/quality/check_soak.ts [--help] [--json <path>]

Checks, in one pass, across every extension:
  - orphaned property files (a *_property_test.ts file that structurally
    escapes soak_schedule.ts's anchored extensions/models/ discovery)
  - unsafe tokens/paths (shell metacharacters, non-ASCII, etc.) — on BOTH the
    quality.yaml soak: override (when present) AND the derived-from-test-task
    argv (always, the 48/51-extension default path)
  - a quality.yaml soak: override that EXCEEDS its own test task's authority
  - a soak: override repeating --allow-net/--allow-env/--allow-run/--allow-sys
    (deno's CLI hard-rejects a second occurrence of these outright)
  - a soak: override combining --allow-all/-A with any other --allow-X flag
    (a separate deno CLI hard-reject class)
  - inadequate FC_NUM_RUNS coverage — on BOTH the override (when present) AND
    the derived-from-test-task path (always)
  - a BROAD test-task grant (--allow-all / unscoped --allow-run/--allow-net/
    --allow-ffi/--allow-sys) with no narrowed quality.yaml soak: override

Set QUALITY_REPO_ROOT to scan a tree other than this script's own repo
(used by its tests; CI never needs it).

--json <path>  also write {checked, violations} as JSON to <path> (the
               sticky PR-comment report reads this — see
               scripts/build-ci-report.ts).

Exit codes:
  0  no violations found
  1  one or more violations found (also emits a GitHub ::error annotation
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
  const { checked, violations } = await checkSoak(root);
  console.log(`Checked ${checked.length} extension(s).`);
  for (const v of violations) {
    console.log(
      `${v.extension}: [${v.rule}] ${v.what}\n  WHY: ${v.why}\n  FIX: ${v.fix}`,
    );
    // orphaned-property-file / unsafe-property-file-path's real offending
    // artifact is the *_property_test.ts file itself, not quality.yaml (that
    // extension may not even have one) — point the annotation there so it
    // lands on the right file (and line, where GitHub can resolve one) in
    // the PR diff. Every other rule's offending artifact IS quality.yaml.
    const annotationFile = v.file
      ? `${v.extension}/${v.file}`
      : `${v.extension}/quality.yaml`;
    console.log(`::error file=${annotationFile}::${v.what} — ${v.fix}`);
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
  console.log("No soak-permission violations found.");
}
