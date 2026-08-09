/**
 * UpgradeChainGuard domain service: the repo-wide PR-time gate over every
 * model's `upgrades[]` migration chain (mirroring check_compliance.ts /
 * check_allowlist.ts / check_soak.ts / check_property_harness.ts's shape —
 * runs GLOBAL, on every PR and push, not diff-scoped, per STANDARD.md's
 * "Why the compliance job runs GLOBAL, not diff-scoped").
 *
 * THE RULE, taken from swamp's own push-time error text: for every model
 * DECLARATION (scripts/quality/model_declarations.ts) in every
 * manifest-listed model file, if the declaration has a NON-EMPTY literal
 * `upgrades[]`, the LAST entry's `toVersion` must equal that declaration's
 * `version`. Evaluated per declaration, not per file — a file with N
 * declarations produces N independent verdicts.
 *
 * DISCOVERY IS MANIFEST-DRIVEN, not glob-driven: listExtensions() gives the
 * extension set, and each extension's manifest.yaml `models:` list gives
 * exactly the files to scan. Measured on the real tree: this differs from a
 * naive glob over `<ext>/extensions/models/*.ts` by exactly one file
 * (telegram-import's `*_test_helpers.ts`, shipped by no manifest) — scanning
 * that file would be scanning something swamp itself never reads as a model.
 *
 * THREAT MODEL. This gate exists because a broken chain is otherwise
 * invisible everywhere except swamp's own client-side push validator: fmt,
 * lint, and `deno check` all pass a broken terminus. Two shapes were
 * measured (against a scratch copy of seanime, swamp
 * 20260807.031228.0-sha.9a36314e) that ship a broken chain with ZERO signal
 * anywhere, including from swamp itself:
 *   (a) a QUOTED `"upgrades"` key — fmt-stable, type-clean, and
 *       `swamp extension push --dry-run` reports success, because it never
 *       finds a chain to validate at all;
 *   (b) an object SPREAD on the model itself
 *       (`export const model = { ...CHAIN_BASE, version: "…" }`) — same
 *       three clean results, and no span-scoped raw cross-check can ever
 *       see it, because the chain lives OUTSIDE the declaration's own text.
 * Both are why this gate carries `model-declaration-indirect` and the
 * quoted-key branch in the parser rather than trusting swamp's own
 * validator as a backstop: swamp is blind to (b) permanently (it operates
 * on the deployed object, not the source text), and to (a) unless the
 * dry-run is actually run, which CI's compliance job does not do (that is
 * `extension-publish`'s job, and only for a manifest that changed).
 *
 * FIVE FAIL-CLOSED RULES so no single parse error produces a silent pass,
 * plus three policy verdicts on top of a resolved literal chain — see each
 * rule's own violation-construction site below for its exact trigger.
 *
 * THREE THINGS THIS GATE DELIBERATELY DOES NOT DO: require a chain to
 * exist (28 of 59 real declarations have none, and every one is published
 * and healthy); require the chain to be contiguous (swamp accepts a gapped
 * chain); re-check manifest-vs-model version parity (ci.yml's "Check model
 * version matches manifest" step owns that already).
 */
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { listExtensions } from "./extensions.ts";
import { scanModelDeclarations } from "./model_declarations.ts";

export interface Violation {
  extension: string;
  rule: string;
  what: string;
  why: string;
  fix: string;
  /** repo-relative path (from root) of the offending model file — always
   * set; every violation here has a concrete file to point a `::error
   * file=` annotation at. */
  file: string;
}

export interface CheckUpgradeChainResult {
  checked: string[];
  violations: Violation[];
}

/** Reads `<root>/<extension>/manifest.yaml`'s `models:` list — the ONLY
 * source of "which files does this extension ship as models", per
 * scripts/quality/model_declarations.ts's caller contract and
 * check_upgrade_chain.test.ts's "manifest-driven, not glob-driven" pin.
 * Returns [] when the manifest is missing/unreadable/has no `models:` list
 * — that shape is a different gate's problem (manifest-vs-model version
 * parity, ci.yml:187-210), not this one's. */
async function readManifestModels(
  root: string,
  extension: string,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(
      join(root, extension, "manifest.yaml"),
    );
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const models = (parsed as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.filter((m): m is string => typeof m === "string");
}

// The belt-and-braces cross-check for `upgrade-chain-unreadable`: fires
// when a declaration's own raw span mentions "upgrades:" (bare, quoted, or
// under either quote style) but the parser resolved chain.kind === "none"
// — a mask bug that swallowed a real property would show up here even
// though the top-level scan found nothing. Deliberately RAW, depth- and
// comment-unaware — see check_upgrade_chain.test.ts's two enumerated
// false-positive fixtures (a nested unrelated `upgrades` field, and a bare
// comment mentioning "upgrades:") for why: a depth-aware or comment-aware
// backstop would trust the same mask a masking bug could have corrupted,
// which defeats the point of a cross-check.
const RAW_UPGRADES_MENTION_RE = /(^|[\s,{])["']?upgrades["']?\s*:/;

/** Runs every fail-closed and policy rule against one manifest-listed
 * model file's source text, pushing zero or more violations. */
function checkModelFile(
  extension: string,
  relPath: string,
  source: string,
): Violation[] {
  const violations: Violation[] = [];
  const fix = (file: string) =>
    `read ${file} — swamp's own push-time validator explains the exact ` +
    "shape it requires; fix the upgrades[] chain (or the version) there";

  let declarations;
  try {
    declarations = scanModelDeclarations(source);
  } catch (err) {
    violations.push({
      extension,
      rule: "model-source-unlexable",
      what: `${relPath} could not be lexed`,
      why: err instanceof Error ? err.message : String(err),
      fix: "simplify the file's structure so it can be tokenized (e.g. " +
        "an unterminated string/template/regex literal), or file a bug " +
        "against scripts/quality/model_declarations.ts if the file is " +
        "ordinary TypeScript",
      file: relPath,
    });
    return violations;
  }

  const versioned = declarations.filter((d) =>
    d.version !== null || d.versionError
  );
  if (versioned.length === 0) {
    violations.push({
      extension,
      rule: "model-declaration-unreadable",
      what:
        `${relPath} yields zero 'export const <ident> = { ... }' declarations carrying a version key`,
      why:
        "a manifest-listed model file must declare its model as a readable " +
        "object literal with a version key so the upgrade-chain rule can " +
        "evaluate it — a parse gap here is indistinguishable from a real " +
        "defect and must fail closed rather than pass silently",
      fix: `confirm ${relPath} exports its model as ` +
        "'export const <ident> = { version: \"…\", … }'",
      file: relPath,
    });
    return violations;
  }

  for (const decl of versioned) {
    if (decl.versionError) {
      violations.push({
        extension,
        rule: "model-version-unreadable",
        what:
          `${relPath}: declaration '${decl.name}' has more than one depth-1 ` +
          "'version' key, or its value is not a plain double-quoted string",
        why: "the chain terminus rule compares upgrades[]'s last toVersion " +
          "against this declaration's version — an ambiguous or malformed " +
          "version makes that comparison meaningless",
        fix: fix(relPath),
        file: relPath,
      });
    }

    if (decl.hasDepth1Spread) {
      violations.push({
        extension,
        rule: "model-declaration-indirect",
        what:
          `${relPath}: declaration '${decl.name}' carries a depth-1 object ` +
          "spread — the parser cannot know whether it contributes an " +
          "upgrades property",
        why: "a spread on the model object itself (bare identifier, call, " +
          "member access, or a parenthesised conditional — any shape) can " +
          "hide a chain OUTSIDE this declaration's own text; swamp's own " +
          "push-time validator is blind to this shape too, since it " +
          "operates on the deployed object, not the source text",
        fix: "inline the spread's contents directly into the declaration " +
          "so the upgrades[] chain (if any) is readable as a literal array",
        file: relPath,
      });
    }

    const rawSpan = source.slice(decl.span.start, decl.span.end);
    if (
      decl.chain.kind === "none" && RAW_UPGRADES_MENTION_RE.test(rawSpan)
    ) {
      violations.push({
        extension,
        rule: "upgrade-chain-unreadable",
        what: `${relPath}: declaration '${decl.name}' mentions "upgrades:" ` +
          "in its raw text but the parser resolved no depth-1 upgrades property",
        why: "belt-and-braces cross-check: a masking bug that swallowed a " +
          "real upgrades property would otherwise silently pass as " +
          "'no chain' — this also fires on an unrelated nested field or a " +
          'bare comment mentioning "upgrades:", which is an accepted cost',
        fix: fix(relPath),
        file: relPath,
      });
      continue;
    }

    switch (decl.chain.kind) {
      case "none":
      case "empty":
        break;
      case "indirect":
        violations.push({
          extension,
          rule: "upgrade-chain-indirect",
          what: `${relPath}: declaration '${decl.name}'s upgrades value ` +
            "is present but is not a readable array literal",
          why: "an identifier, call expression, member access, or a " +
            "spread array element cannot be checked for its terminus — " +
            "swamp's own client-side validator is blind to at least the " +
            "spread-element shape, so this gate is the only enforcement " +
            "that exists for it",
          fix: "write upgrades as a literal array of object literals " +
            "directly in the declaration",
          file: relPath,
        });
        break;
      case "unparseable":
        violations.push({
          extension,
          rule: "upgrade-chain-unparseable",
          what: `${relPath}: declaration '${decl.name}'s upgrades array ` +
            "has an element that is not a readable object literal",
          why: "every element of a literal upgrades[] chain must be an " +
            "object literal ('{ … }') so its toVersion can be read",
          fix: "make every upgrades[] element a plain object literal " +
            '(\'{ fromVersion: "…", toVersion: "…" }\')',
          file: relPath,
        });
        break;
      case "literal":
        if (decl.version !== null && decl.chain.terminus !== decl.version) {
          violations.push({
            extension,
            rule: "upgrade-chain-terminus",
            what:
              `${relPath}: declaration '${decl.name}' — last upgrades[].toVersion ` +
              `${JSON.stringify(decl.chain.terminus)} != model version ${
                JSON.stringify(decl.version)
              }`,
            why: "swamp requires a non-empty upgrades[] chain's last entry " +
              "to terminate at the model's own declared version — a " +
              "mismatch here ships (or blocks) inconsistently depending " +
              "on the shape, and is invisible to fmt/lint/deno check",
            fix: fix(relPath),
            file: relPath,
          });
        }
        break;
    }
  }

  return violations;
}

/** Scans every manifest-listed model file of every extension under `root`
 * for upgrade-chain violations. Aggregates across every extension and
 * every declaration — never aborts on the first bad file. `checked`
 * mirrors check_soak.ts's/check_property_harness.ts's Result shape: every
 * extension listExtensions() finds, whether or not it turned up any
 * violation (a missing/unreadable manifest is a different gate's problem
 * — check_compliance.ts / the "Check model version matches manifest" CI
 * step — so it is silently skipped here rather than reported). */
export async function checkUpgradeChain(
  root: string,
): Promise<CheckUpgradeChainResult> {
  const extensions = await listExtensions({ root });
  const violations: Violation[] = [];
  for (const extension of extensions) {
    const modelPaths = await readManifestModels(root, extension);
    for (const relModelPath of modelPaths) {
      let source: string;
      try {
        source = await Deno.readTextFile(
          join(root, extension, relModelPath),
        );
      } catch {
        continue;
      }
      const relPath = join(extension, relModelPath);
      violations.push(...checkModelFile(extension, relPath, source));
    }
  }
  return { checked: extensions, violations };
}

function printHelp() {
  console.log(
    `check_upgrade_chain.ts — every model's upgrades[] chain must terminate at its own version

Usage:
  deno run --allow-read scripts/quality/check_upgrade_chain.ts [--help] [--json <path>]

For every manifest-listed model file of every extension, checks that a
NON-EMPTY literal upgrades[] chain's last entry's toVersion equals the
declaration's own version. An absent or empty chain is legal (most
declarations have none); a gapped chain is legal (swamp accepts one); this
gate does not re-check manifest-vs-model version parity (a different,
existing gate owns that).

Set QUALITY_REPO_ROOT to scan a tree other than this script's own repo
(used by its tests; CI never needs it).

--json <path>  also write {checked, violations} as JSON to <path> (the
               sticky PR-comment report reads this — see
               scripts/build-ci-report.ts).

Exit codes:
  0  every manifest-listed model file's upgrade chain(s) are clean
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
  const { checked, violations } = await checkUpgradeChain(root);
  console.log(`Checked ${checked.length} extension(s).`);
  for (const v of violations) {
    console.log(
      `${v.extension}: [${v.rule}] ${v.what}\n  WHY: ${v.why}\n  FIX: ${v.fix}`,
    );
    console.log(`::error file=${v.file}::${v.what} — ${v.fix}`);
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
  console.log("No upgrade-chain violations found.");
}
