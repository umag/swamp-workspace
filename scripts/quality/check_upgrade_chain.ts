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
 * DISCOVERY ITSELF FAILS CLOSED, one layer above checkModelFile's five
 * rules: a missing/unparseable manifest, a non-list/non-string-list
 * `models:` key, a manifest entry that escapes the extension directory
 * (`../../../etc/hosts`), and a listed path that does not resolve to a
 * readable file all raise `manifest-models-unreadable` rather than
 * silently shrinking the file set while the extension still counts as
 * checked — see readManifestModels() and isContainedIn() below. The ONE
 * legitimate no-models shape is a datastore-, vault- or report-only
 * extension (swamp-mongodb-datastore declares `datastores:` and nothing
 * else): it has no model files to drop, so it contributes zero paths and
 * zero violations. A manifest declaring NO content of any kind still fails
 * closed.
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
import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { listExtensions } from "./extensions.ts";
import { scanModelDeclarations } from "./model_declarations.ts";
import { sanitizeForAnnotation } from "../lib/annotation.ts";

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

/** Aggregate counts across every scanned file — printed on the CLI summary
 * line and included in `--json` output, so a healthy run and a run that
 * silently discovered nothing are no longer indistinguishable at a glance
 * FOR SOMEONE READING THE RAW JOB LOG OR ARTIFACT DIRECTLY; the counts do
 * NOT reach the sticky PR comment — build-ci-report.ts reads only
 * `violations` (and `checked` from compliance-summary.json) from every
 * `*-summary.json`, this file's `counts` field included. Never asserted on
 * in tests, per plan v4: `model-declaration-unreadable` (and friends) are
 * the structural alarm; these are instrumentation, not a pinned contract. */
export interface Counts {
  modelFiles: number;
  declarations: number;
  versioned: number;
  chains: number;
  entries: number;
  emptyChains: number;
  noChain: number;
}

function emptyCounts(): Counts {
  return {
    modelFiles: 0,
    declarations: 0,
    versioned: 0,
    chains: 0,
    entries: 0,
    emptyChains: 0,
    noChain: 0,
  };
}

export interface CheckUpgradeChainResult {
  checked: string[];
  violations: Violation[];
  counts: Counts;
}

/** Result of one extension's manifest-driven model discovery: either a list
 * of `models:` paths to scan, or a single fail-closed violation explaining
 * why discovery itself could not proceed. */
interface ManifestModels {
  paths: string[];
  violation: Violation | null;
}

function manifestUnreadable(extension: string, why: string): ManifestModels {
  // Sanitise the untrusted extension-directory name ONCE, at the point
  // this violation is built, and use the sanitised form for every field —
  // `extension`, `what`, `fix`, `file` alike — rather than trusting each
  // interpolation site to remember. See sanitizeForAnnotation's docblock
  // and this module's checkModelFile()/checkUpgradeChain() for the same
  // rule applied at their own construction sites.
  const safeExtension = sanitizeForAnnotation(extension);
  const manifestRelPath = join(safeExtension, "manifest.yaml");
  return {
    paths: [],
    violation: {
      extension: safeExtension,
      rule: "manifest-models-unreadable",
      what: `${manifestRelPath}: ${why}`,
      why: "discovery is the layer every fail-closed rule in " +
        "checkModelFile sits on top of — a manifest this gate cannot read " +
        "as a 'models: [...]' list of file paths must not silently drop " +
        "the extension's model files from coverage while the extension " +
        "still counts as checked",
      fix: `fix ${manifestRelPath} so its 'models:' key is a non-empty ` +
        "YAML list of string paths to this extension's model files",
      file: manifestRelPath,
    },
  };
}

/** Reads `<root>/<extension>/manifest.yaml`'s `models:` list — the ONLY
 * source of "which files does this extension ship as models", per
 * scripts/quality/model_declarations.ts's caller contract and
 * check_upgrade_chain.test.ts's "manifest-driven, not glob-driven" pin.
 * FAILS CLOSED: a missing/unparseable manifest, an absent/non-list/
 * non-string-list `models:` key, or an empty list all return a
 * `manifest-models-unreadable` violation rather than a silent `[]` — five
 * shapes (no `models:`, a list of mappings, a scalar, invalid YAML, and —
 * checked by the caller once it tries to read each path — a path typo)
 * previously left a broken chain unreported while the extension still
 * counted as checked, defeating the fail-closed guarantee every rule in
 * checkModelFile provides. Manifest-vs-model version PARITY (the values
 * matching) is still a different gate's job — ci.yml's "Check model
 * version matches manifest" step; this only asserts the manifest is
 * readable enough to name files at all. */
/** Exported for the discovery tests: the no-models shapes this gate accepts
 * versus the ones it must still fail closed on. */
export async function readManifestModels(
  root: string,
  extension: string,
): Promise<ManifestModels> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(
      join(root, extension, "manifest.yaml"),
    );
  } catch {
    return manifestUnreadable(extension, "manifest.yaml could not be read");
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return manifestUnreadable(extension, "manifest.yaml is not valid YAML");
  }
  if (!parsed || typeof parsed !== "object") {
    return manifestUnreadable(
      extension,
      "manifest.yaml does not parse to a mapping",
    );
  }
  const models = (parsed as Record<string, unknown>).models;
  if (models === undefined) {
    // A datastore-, vault- or report-only extension ships no models at all —
    // swamp-mongodb-datastore declares `datastores:` and nothing else. That is
    // a legitimate manifest shape with nothing for THIS gate to check, not an
    // unreadable one, and there are no model files to silently drop.
    //
    // Still fail closed when the manifest declares no content of any kind:
    // that manifest really is broken, and treating it as "no models" would be
    // exactly the silent-shrink this gate exists to prevent.
    const OTHER_CONTENT_KEYS = [
      "datastores",
      "vaults",
      "reports",
      "workflows",
    ];
    const declaresOtherContent = OTHER_CONTENT_KEYS.some((key) => {
      const value = (parsed as Record<string, unknown>)[key];
      return Array.isArray(value) && value.length > 0;
    });
    if (declaresOtherContent) return { paths: [], violation: null };
    return manifestUnreadable(
      extension,
      "manifest declares no content at all: no 'models:', and no non-empty " +
        "'datastores:', 'vaults:', 'reports:' or 'workflows:' either",
    );
  }
  if (!Array.isArray(models) || models.length === 0) {
    return manifestUnreadable(
      extension,
      "'models:' is missing, empty, or not a list",
    );
  }
  if (!models.every((m): m is string => typeof m === "string")) {
    return manifestUnreadable(
      extension,
      "'models:' contains an entry that is not a plain string path",
    );
  }
  return { paths: models, violation: null };
}

/** True when `candidate` (already `resolve()`d) stays under `base`
 * (already `resolve()`d) — used to reject a manifest `models:` entry like
 * `"../../../../etc/hosts"` that would otherwise escape the extension
 * directory once joined and read. Matches check_property_harness.ts's /
 * check_soak.ts's own `relative()`-based containment check: a `relative`
 * path that starts with `..` climbed out of `base`. */
function isContainedIn(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel !== ".." && !/^\.\.[/\\]/.test(rel);
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
  counts: Counts,
): Violation[] {
  const violations: Violation[] = [];
  counts.modelFiles++;
  // Sanitise the untrusted extension-directory name and manifest-derived
  // relative path ONCE, here, rather than at each of this function's many
  // Violation-construction sites below — `source` was already read using
  // the original (unsanitised) `relPath` before this function was ever
  // called, so shadowing the parameters now is safe: every remaining use
  // of either is in a 'what'/'fix'/'file'/'extension' field of a
  // Violation, never a filesystem path. Matches manifestUnreadable()'s and
  // checkUpgradeChain()'s own construction-time sanitisation and
  // release_notes_gate.ts's rule of escaping untrusted text where the
  // Violation is built, not at print time — see sanitizeForAnnotation's
  // docblock for the workflow-command-injection hole this closes.
  extension = sanitizeForAnnotation(extension);
  relPath = sanitizeForAnnotation(relPath);
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

  // Model identity is "carries a depth-1 `type` key whose value reads as
  // `@vendor/name`" (`hasModelType`) — the one thing every real model
  // declaration has and an unrelated helper object (`export const
  // schemaInfo = { version: 3, strict: true }`, or even `export const
  // inputSchema = { type: "object", … }`) does not. Filtering on "has a
  // version key" alone (an earlier version of this test) treated ANY
  // exported object literal with a `version` field as a model — a global
  // false positive. Filtering on "has a `type` key" alone (a later, still
  // broken version) is itself evadable: hiding `type` behind a depth-1
  // spread, a computed key, or an accessor drops the declaration out of
  // `versioned` and every rule inside the loop below along with it — a
  // model whose identity the parser cannot read must fail CLOSED, not be
  // treated as absent. So a declaration is included when it is KNOWN to be
  // a model (`hasModelType`) OR its identity is UNREADABLE
  // (`hasDepth1Spread`/`hasUnreadableProperty` — either could be hiding
  // the real `type` key); only a declaration with none of the three is
  // safely not a model.
  counts.declarations += declarations.length;
  const versioned = declarations.filter((d) =>
    d.hasModelType || d.hasDepth1Spread || d.hasUnreadableProperty
  );
  counts.versioned += versioned.length;
  if (versioned.length === 0) {
    violations.push({
      extension,
      rule: "model-declaration-unreadable",
      what:
        `${relPath} yields zero 'export const <ident> = { ... }' declarations carrying a depth-1 'type' key`,
      why:
        "a manifest-listed model file must declare its model as a readable " +
        "object literal with a 'type' key (swamp's own model-identity " +
        "discriminator) so the upgrade-chain rule can find and evaluate it " +
        "— a parse gap here is indistinguishable from a real defect and " +
        "must fail closed rather than pass silently",
      fix: `confirm ${relPath} exports its model as ` +
        '\'export const <ident> = { type: "@…", version: "…", … }\'',
      file: relPath,
    });
    return violations;
  }

  for (const decl of versioned) {
    if (decl.versionError || decl.version === null) {
      violations.push({
        extension,
        rule: "model-version-unreadable",
        what: `${relPath}: declaration '${decl.name}' has no depth-1 ` +
          "'version' key, has more than one, or its value is not a plain " +
          "double-quoted string",
        why: "the chain terminus rule compares upgrades[]'s last toVersion " +
          "against this declaration's version — a missing, ambiguous, or " +
          "malformed version makes that comparison meaningless (and, left " +
          "unflagged, would silently skip the terminus check entirely)",
        fix: fix(relPath),
        file: relPath,
      });
    }

    if (decl.hasUnreadableProperty) {
      violations.push({
        extension,
        rule: "model-declaration-indirect",
        what: `${relPath}: declaration '${decl.name}' carries a depth-1 ` +
          "property whose key could not be read (numeric, computed, or " +
          "an accessor/modifier shape) — the parser cannot know whether " +
          "it contributes an upgrades property",
        why: "a computed key ('[\"upgrades\"]'), a numeric key, or an " +
          "accessor ('get upgrades() {…}') names the same property to " +
          "TypeScript as a plain 'upgrades:' but is invisible to both the " +
          "structural scan and the raw cross-check, so it must fail " +
          "closed rather than silently drop the property",
        fix: "give the property a plain bare or quoted string key " +
          "readable at depth 1 ('upgrades: […]' or '\"upgrades\": […]')",
        file: relPath,
      });
    }

    if (decl.hasDuplicateUpgrades) {
      violations.push({
        extension,
        rule: "model-declaration-indirect",
        what: `${relPath}: declaration '${decl.name}' has more than one ` +
          "depth-1 'upgrades' key",
        why: "JavaScript resolves a duplicate key to the LAST one, but " +
          "reading only the first (as if it were authoritative) can " +
          "evaluate a chain that will never actually ship",
        fix: "remove the duplicate 'upgrades' key, keeping only the one " +
          "that should ship",
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
          "real upgrades property would otherwise silently pass as 'no " +
          "chain' — this also fires on three benign shapes, which is an " +
          "accepted cost: an unrelated nested field, a bare comment " +
          'mentioning "upgrades:", or a plain STRING value (e.g. a `note` ' +
          "or `description` field) that happens to contain the text " +
          '"upgrades:"',
        fix: "either the parser missed a real upgrades property (file a " +
          "bug against scripts/quality/model_declarations.ts) or the " +
          'text is benign — the cross-check fired on "upgrades:" ' +
          "appearing somewhere in this declaration's raw source (an " +
          "unrelated field, a comment, or prose inside a string value). " +
          "If benign, rename the field, reword the text, or add a real " +
          "'upgrades' property if one was intended",
        file: relPath,
      });
      continue;
    }

    switch (decl.chain.kind) {
      case "none":
        counts.noChain++;
        break;
      case "empty":
        counts.emptyChains++;
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
        counts.chains++;
        counts.entries += decl.chain.entries.length;
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
 * violation. Discovery itself fails CLOSED (readManifestModels /
 * isContainedIn below) rather than silently skipping an extension whose
 * manifest can't be read as a `models:` list, or reading a manifest entry
 * that escapes the extension directory. */
export async function checkUpgradeChain(
  root: string,
): Promise<CheckUpgradeChainResult> {
  const extensions = await listExtensions({ root });
  const violations: Violation[] = [];
  const counts = emptyCounts();
  for (const extension of extensions) {
    const { paths: modelPaths, violation: discoveryViolation } =
      await readManifestModels(root, extension);
    if (discoveryViolation) {
      violations.push(discoveryViolation);
      continue;
    }
    const extDir = resolve(join(root, extension));
    // `isContainedIn` below is purely lexical (per its own doc) and never
    // follows a symlink, so it is re-checked against the REAL,
    // symlink-resolved directory too — see the containment re-check
    // inside the loop for why. A realPath failure here (the extension
    // directory itself missing/unreadable) is not this gate's problem to
    // diagnose — listExtensions() already found it on disk — so it just
    // falls back to the lexical `extDir`, leaving today's behaviour
    // unchanged in that edge case.
    const realExtDir = await Deno.realPath(extDir).catch(() => extDir);
    for (const relModelPath of modelPaths) {
      const relPath = join(extension, relModelPath);
      const target = resolve(join(root, extension, relModelPath));
      if (!isContainedIn(extDir, target)) {
        // Sanitise at construction, matching manifestUnreadable() and
        // checkModelFile() — `extension` (a directory name) and `relPath`
        // (built from a manifest `models:` entry) are both untrusted text,
        // and are LOOP variables here (reused across iterations/
        // extensions), so they are sanitised into fresh locals rather than
        // reassigned in place.
        const safeExtension = sanitizeForAnnotation(extension);
        const safeRelPath = sanitizeForAnnotation(relPath);
        violations.push({
          extension: safeExtension,
          rule: "manifest-models-unreadable",
          what:
            `${safeRelPath}: manifest 'models:' entry escapes the extension directory`,
          why: "a manifest-listed model path is joined onto the extension " +
            "directory and read under this task's bare --allow-read — an " +
            "unresolved '..' segment can steer that read at any file on " +
            "the runner, so it must be rejected rather than silently " +
            "followed",
          fix: `fix the offending 'models:' entry in ${
            sanitizeForAnnotation(join(extension, "manifest.yaml"))
          } so it names a path that stays inside ${safeExtension}/`,
          file: safeRelPath,
        });
        continue;
      }
      // `resolve()` is lexical, so a manifest entry that stays lexically
      // under `extDir` can still, once every symlink component is
      // followed, point OUTSIDE the repo entirely — either a symlinked
      // INTERMEDIATE directory (`<ext>/escape -> <outside>`, entry
      // `escape/sentinel.ts`) or the listed file itself being a symlink
      // (an ordinary-looking entry whose target is a symlink to
      // `<outside>/secret.ts`). Re-validate containment against the REAL
      // path. A realPath failure (broken link, ENOENT, permission) is NOT
      // pushed as this violation — it falls through to the ordinary
      // Deno.readTextFile() attempt below, which raises the existing
      // 'manifest-listed model file could not be read' violation, so
      // fail-closed coverage is unchanged either way.
      let realTarget: string | null;
      try {
        realTarget = await Deno.realPath(target);
      } catch {
        realTarget = null;
      }
      if (realTarget !== null && !isContainedIn(realExtDir, realTarget)) {
        const safeExtension = sanitizeForAnnotation(extension);
        const safeRelPath = sanitizeForAnnotation(relPath);
        violations.push({
          extension: safeExtension,
          rule: "manifest-models-unreadable",
          what: `${safeRelPath}: manifest 'models:' entry resolves ` +
            "(through a symlink) outside the extension directory",
          why: "isContainedIn() is a lexical check and 'resolve()' never " +
            "follows a symlink — a symlinked intermediate directory, or " +
            "the listed file itself being a symlink, can steer this " +
            "task's bare --allow-read at any file on the runner even " +
            "though the unresolved path stays lexically inside the " +
            "extension directory, so it must be rejected too rather than " +
            "silently followed",
          fix: `remove the symlink at (or beneath) ${safeRelPath}, or ` +
            "replace it with a real file inside the extension directory",
          file: safeRelPath,
        });
        continue;
      }
      let source: string;
      try {
        source = await Deno.readTextFile(target);
      } catch {
        // Same construction-time sanitisation as the containment-escape
        // violation just above — `extension`/`relModelPath`/`relPath` are
        // all loop variables reused by later iterations.
        const safeExtension = sanitizeForAnnotation(extension);
        const safeRelPath = sanitizeForAnnotation(relPath);
        const safeRelModelPath = sanitizeForAnnotation(relModelPath);
        violations.push({
          extension: safeExtension,
          rule: "manifest-models-unreadable",
          what: `${safeRelPath}: manifest-listed model file could not be read`,
          why: "discovery must fail closed — a manifest entry naming a " +
            "file that does not exist (or cannot be read) must not " +
            "silently vanish from coverage",
          fix:
            `fix the 'models:' entry in ${
              sanitizeForAnnotation(join(extension, "manifest.yaml"))
            } so it names a real, readable file, or remove it if ` +
            `${safeRelModelPath} was renamed or deleted`,
          file: safeRelPath,
        });
        continue;
      }
      violations.push(...checkModelFile(extension, relPath, source, counts));
    }
  }
  return { checked: extensions, violations, counts };
}

function printHelp() {
  console.log(
    `check_upgrade_chain.ts — every model's upgrades[] chain must terminate at its own version

Usage:
  deno run --allow-read scripts/quality/check_upgrade_chain.ts [--help]
  deno run --allow-read --allow-write=<path> scripts/quality/check_upgrade_chain.ts --json <path>
    (--allow-write is only needed with --json, and only needs to cover <path>)

For every manifest-listed model file of every extension, checks that a
NON-EMPTY literal upgrades[] chain's last entry's toVersion equals the
declaration's own version. An absent or empty chain is legal (most
declarations have none); a gapped chain is legal (swamp accepts one); this
gate does not re-check manifest-vs-model version parity (a different,
existing gate owns that).

Set QUALITY_REPO_ROOT to scan a tree other than this script's own repo
(used by its tests; CI never needs it).

--json <path>  also write {checked, violations, counts} as JSON to <path>
               (the sticky PR-comment report reads 'violations' from this —
               see scripts/build-ci-report.ts — 'counts' is instrumentation
               for someone reading the artifact or job log directly).

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
  const { checked, violations, counts } = await checkUpgradeChain(root);
  console.log(
    `Checked ${checked.length} extension(s), ${counts.modelFiles} model ` +
      `file(s), ${counts.declarations} declaration(s) (${counts.versioned} ` +
      `versioned): ${counts.chains} chain(s)/${counts.entries} entrie(s), ` +
      `${counts.emptyChains} empty, ${counts.noChain} with no chain.`,
  );
  for (const v of violations) {
    console.log(
      `${v.extension}: [${v.rule}] ${v.what}\n  WHY: ${v.why}\n  FIX: ${v.fix}`,
    );
    // `v.extension`, `v.what`, `v.fix`, and `v.file` are ALL sanitised
    // already, at the point each Violation was constructed (see
    // manifestUnreadable(), checkModelFile(), and checkUpgradeChain()'s
    // own two manifest-models-unreadable pushes) — every field of a
    // Violation can carry untrusted text (a manifest `models:` entry or
    // extension directory name), not just `file`, so the sanitisation
    // rule lives at construction time and covers `what/fix` interpolated
    // above in the human-readable line too. sanitizeForAnnotation is
    // idempotent (it only rewrites raw control bytes, and its own output
    // contains none), so re-wrapping `v.file` here is belt-and-braces, not
    // load-bearing; see scripts/lib/annotation.ts's docblock for the
    // workflow-command-injection hole this closes.
    console.log(
      `::error file=${sanitizeForAnnotation(v.file)}::${v.what} — ${v.fix}`,
    );
  }
  if (jsonPath) {
    await Deno.writeTextFile(
      jsonPath,
      JSON.stringify({ checked, violations, counts }, null, 2),
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
