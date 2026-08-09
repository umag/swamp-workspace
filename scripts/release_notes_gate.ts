/**
 * The single implementation of "which manifests is this change publishing,
 * and are their release notes shippable". Both `release-notes-cap` (PR-time
 * guard) and `extension-publish`'s pre-flight (the job holding
 * `secrets.SWAMP_API_KEY`) call this — see plan v4 DESIGN DECISION 2. Before
 * this module the guard and the publisher each re-derived the selected set
 * and the byte measurement independently, which is how they drifted apart
 * (ci.yml:270 filtered PER manifest, ci.yml:596 tested the COMBINED diff,
 * ci.yml:604 then emitted EVERY changed manifest).
 *
 * SELECTION IS ON THE REGISTRY COORDINATE, NOT ON A DIFF LINE. The registry
 * addresses a release as name@version, so a manifest is being published
 * exactly when the `name` or the `version` it declares at HEAD differs from
 * what it declared at the base — or when it has no base at all (see
 * `selectPublishable`). A raw `git diff` line (`^\+version:`) is an artefact
 * of how git rendered a change: it fires on a reordered key, a bare rename,
 * or a `.gitattributes -diff` marker, and it MISSES an in-place re-scope
 * (`name:` changed, `version:` untouched) entirely. See cipg-plan-v4's
 * DESIGN DECISION 1 for the measured scenarios this rule is built from.
 *
 * `-z` ON THE GIT CALL IS PROPHYLACTIC, NOT DECORATIVE. `git diff
 * --name-status` C-quotes any path outside printable ASCII and always
 * escapes control characters; without `-z` a quoted literal (surrounding
 * double quotes included) becomes the path a naive parser hands to `git
 * show`, which then exits 128. `-z` also removes the "two paths on one line"
 * rename special case from the parser — `parseDiffStatus` below consumes a
 * FLAT NUL-terminated field sequence, never lines.
 *
 * ROOT RESOLUTION, one mechanism: derive the repo root from `import.meta.url`
 * the way `scripts/quality/extensions.ts` does. `--root` exists for tests
 * only (they build throwaway git repos in temp dirs) — the deno.json task and
 * the CI invocation both omit it.
 *
 * PERMISSIONS. `--allow-run=git,bash` is granted rather than narrowed to the
 * extractor's own absolute path, because a Deno allowlist entry must match
 * the command string exactly and that path varies per checkout; the
 * incremental surface is near zero since `scripts/deno.json`'s `test` task
 * already grants a blanket `--allow-run` and `compliance` runs it on every
 * PR. Deliberately NO `--allow-write`: the CLI has no flag that writes a
 * file, so the task that runs in the job holding the publish credential
 * never asks for write access at all.
 *
 * THE TSV CHANNEL BETWEEN `--mode list` AND THE PUBLISH LOOP HAS A WRITTEN
 * GRAMMAR, because it is the only thing feeding a credentialed publish loop
 * and both ends (this script's emitter, bash's `while IFS=$'\t' read`) must
 * agree on the split:
 *
 *   record  = path TAB version LF
 *   path    = segment "/manifest.yaml"      exactly one "/" in the record
 *   segment = one or more characters, none of them "/", TAB, LF or NUL
 *   version = one or more characters, none of them ASCII whitespace
 *
 * Nothing else may appear on `--mode list` stdout — no banner, no counts, no
 * null-base note, no blank line; every diagnostic goes to stderr. The grammar
 * is enforced at BOTH ends: the emitter (`selectPublishable`) validates every
 * record before it is selected, and the reader (`--manifests-from`) applies
 * the same shape check and splits with `indexOf("\t")` + `slice` rather than
 * `split("\t")`, so a line bearing a second TAB is a REJECTED line rather
 * than a silently truncated field.
 *
 * MESSAGE SAFETY. `classify().message` and every `::error` annotation this
 * module prints name only `<dir>`, `<version>`, `<bytes>` and the required
 * heading — NEVER any part of the extracted section body. A section body is
 * committer-authored multi-line text; echoing it into a `::error` line or a
 * `$GITHUB_OUTPUT` value is a workflow-command injection vector
 * (`::stop-commands::`, `::add-mask::`). The same guarantee covers PATHS:
 * a directory name is legally allowed to contain a raw newline or carriage
 * return, so every `::error` annotation that embeds a headPath/dir/version —
 * every `Violation.what` AND the classify-loop's per-record annotation in
 * `classifyRecords` alike — passes it through `sanitizeForAnnotation` first;
 * otherwise a second physical line would start at column 0 of the job log,
 * where GitHub Actions parses a leading `::` as a new workflow command.
 *
 * @module
 */
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { parseManifest } from "./registry_drift.ts";
import { listExtensions } from "./quality/extensions.ts";
import { sanitizeForAnnotation } from "./lib/annotation.ts";

// ============================================================================
// Types
// ============================================================================

/** A problem found while selecting or emitting a manifest record — always
 * fatal, never a silent skip. */
export interface Violation {
  readonly rule: string;
  readonly what: string;
}

export type Status =
  | "ok"
  | "missing-file"
  | "missing-section"
  | "blank-section"
  | "duplicate-heading"
  | "over-cap"
  | "unknown-failure";

interface Coordinate {
  readonly name: string;
  readonly version: string;
}

interface DiffRecord {
  readonly status: string;
  readonly basePath: string | null;
  readonly headPath: string | null;
}

interface SelectionInput {
  readonly headPath: string;
  readonly head: Coordinate | null;
  readonly base: Coordinate | null;
}

interface SelectedManifest {
  readonly path: string;
  readonly version: string;
}

// ============================================================================
// Pure functions
// ============================================================================

const ZERO_SHA = "0".repeat(40);

/**
 * Resolves the base revision to diff against. `pull_request` always uses
 * `prBaseSha` (GitHub always populates it correctly for that event, no
 * reachability check needed) — deliberately NOT validated with
 * `commitExists` the way `pushBefore` and `HEAD~1` are, because
 * `extension-publish` is push-only and this branch can therefore never sit
 * in front of the credentialed job; a `pull_request` run is the
 * tokenless `release-notes-cap` guard, so if this claim is ever wrong an
 * unreachable `prBaseSha` fails LOUD instead of silent: `gitDiffNameStatus`
 * turns git's fatal into a named `diff-base-unreachable` violation and the
 * step exits 1, which is the correct direction for a PR-time check (see the
 * `resolveBase: pull_request returns prBaseSha even when unreachable`
 * pinning test — a reachability check here that instead exits 0 "nothing to
 * check" would make an unreachable PR base a SILENT skip of the guard,
 * which is the class of bug this whole module exists to close). `push`
 * prefers `pushBefore` when it is non-zero AND reachable — the all-zero sha
 * marks a brand-new branch/ref and an unreachable sha means a force-push
 * rewrote history out from under it, neither of which is a valid diff base.
 * Every other case (including an unrecognised event) falls through to
 * `HEAD~1`, itself validated the same way. Returns null only when NOTHING
 * resolves — the caller must treat that as "nothing to check", never as an
 * error: a fail-closed exit here would kill the detect step under
 * `set -eo pipefail` and drop every publish in the push, which is the worst
 * case this module exists to prevent.
 *
 * Takes no job identity — the same input always yields the same base
 * regardless of which CI job supplied it, which is what lets the guard and
 * the publisher agree on the selected set by construction.
 */
export function resolveBase(
  input: { event: string; prBaseSha: string; pushBefore: string },
  commitExists: (sha: string) => boolean,
): string | null {
  if (input.event === "pull_request") {
    return input.prBaseSha;
  }
  if (
    input.event === "push" && input.pushBefore !== "" &&
    input.pushBefore !== ZERO_SHA && commitExists(input.pushBefore)
  ) {
    return input.pushBefore;
  }
  return commitExists("HEAD~1") ? "HEAD~1" : null;
}

/**
 * Parses `git diff --name-status -M -z <base> HEAD -- <pathspec>` output — a
 * FLAT sequence of NUL-terminated fields, never lines. A status beginning
 * with `R` or `C` (rename/copy) consumes TWO path fields (old then new);
 * every other status consumes ONE. `D` yields `headPath: null` (nothing to
 * publish for a deleted manifest); every other status yields
 * `basePath === headPath` at this raw layer — the "A has no base" domain
 * rule is applied by the caller (`manifestCoordinateAt` naturally resolves
 * to null for a path absent at the base revision), not by this parser. A
 * trailing NUL (real `-z` output always ends with one) never produces a
 * bogus extra record.
 */
export function parseDiffStatus(raw: string): DiffRecord[] {
  const fields = raw.split("\0");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  const out: DiffRecord[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i++];
    if (status === "") continue; // defensive: never observed with real -z output
    if (status[0] === "R" || status[0] === "C") {
      const basePath = fields[i++];
      const headPath = fields[i++];
      out.push({ status, basePath, headPath });
    } else if (status === "D") {
      const basePath = fields[i++];
      out.push({ status, basePath, headPath: null });
    } else {
      const path = fields[i++];
      out.push({ status, basePath: path, headPath: path });
    }
  }
  return out;
}

// Grammar from the module docblock: `segment` excludes "/", TAB, LF and NUL;
// `version` excludes ASCII whitespace entirely.
const MANIFEST_PATH_RE = /^[^/\t\n\0]+\/manifest\.yaml$/;

function isValidManifestPath(path: string): boolean {
  if (!MANIFEST_PATH_RE.test(path)) return false;
  // "." and ".." fit the grammar above (neither contains "/", TAB, LF or
  // NUL) but resolve OUTSIDE the extension directory once joined onto
  // `root` — reject them explicitly rather than trusting the character-class
  // grammar alone. Shared by both entry points: the git-diff selector can
  // never actually produce this (git rejects a literal "." or ".." path
  // component), but --manifests-from's TSV channel has no such constraint,
  // and a "../manifest.yaml" record there would make classifyRecords read a
  // CHANGELOG.md one directory above root.
  const segment = path.slice(0, path.indexOf("/"));
  return segment !== "." && segment !== "..";
}

function isValidVersion(version: string): boolean {
  return version.length > 0 && !/\s/.test(version);
}

/**
 * The selection rule from DESIGN DECISION 1, expressed with no I/O at all:
 * select iff `base === null || base.name !== head.name || base.version !==
 * head.version`. A null `head` is an ERROR (`manifest-version-unreadable`),
 * never a silent skip — the caller could not read the manifest at HEAD at
 * all, which is worse than a mismatch. The name is part of the key because
 * the registry coordinate is name@version; dropping it would miss an
 * in-place re-scope (`name:` changed, `version:` untouched), which today's
 * `^\+version:` rule misses too.
 *
 * Also validates the TSV emission grammar this feeds — a selected record
 * whose path or version does not fit the grammar in the module docblock is
 * reported (`manifest-path-unsupported` / `manifest-version-unreadable`)
 * rather than silently emitted onto a channel a credentialed publish loop
 * reads.
 */
export function selectPublishable(
  input: readonly SelectionInput[],
): { selected: SelectedManifest[]; errors: Violation[] } {
  const selected: SelectedManifest[] = [];
  const errors: Violation[] = [];
  for (const rec of input) {
    if (rec.head === null) {
      errors.push({
        rule: "manifest-version-unreadable",
        what: `${
          sanitizeForAnnotation(rec.headPath)
        }: could not read name:/version: at HEAD`,
      });
      continue;
    }
    const changed = rec.base === null ||
      rec.base.name !== rec.head.name ||
      rec.base.version !== rec.head.version;
    if (!changed) continue;
    if (!isValidManifestPath(rec.headPath)) {
      errors.push({
        rule: "manifest-path-unsupported",
        what: `${
          sanitizeForAnnotation(rec.headPath)
        }: selected manifest path is not exactly "<segment>/manifest.yaml"`,
      });
      continue;
    }
    if (!isValidVersion(rec.head.version)) {
      errors.push({
        rule: "manifest-version-unreadable",
        what: `${sanitizeForAnnotation(rec.headPath)}: version "${
          sanitizeForAnnotation(rec.head.version)
        }" is empty or contains ASCII whitespace`,
      });
      continue;
    }
    selected.push({ path: rec.headPath, version: rec.head.version });
  }
  return { selected, errors };
}

/**
 * Reproduces `printf '%s' "$(script)" | wc -c` exactly: strip ALL trailing
 * "\n" (bash command substitution strips every trailing newline, not just
 * one), then count UTF-8 bytes — never UTF-16 code units. This is what
 * `classify` measures the cap against; measuring raw stdout would disagree
 * with what the publisher actually ships.
 */
export function notesByteLength(stdout: string): number {
  const stripped = stdout.replace(/\n+$/, "");
  return new TextEncoder().encode(stripped).length;
}

function messageFor(status: Status, bytes: number, cap: number): string {
  switch (status) {
    case "ok":
      return `release notes ok (${bytes} bytes, cap ${cap})`;
    case "missing-file":
      return "missing-file: no CHANGELOG.md exists for this extension. " +
        "Release notes are REQUIRED and cannot be added after publication " +
        "— create CHANGELOG.md with a '## <version>' heading before publishing.";
    case "missing-section":
      return "missing-section: CHANGELOG.md has no heading for this " +
        "version. Release notes are REQUIRED and cannot be added after " +
        "publication — add a '## <version>' heading to CHANGELOG.md.";
    case "blank-section":
      return "blank-section: the '## <version>' heading exists but its " +
        "body is entirely blank. Release notes are REQUIRED and cannot be " +
        "added after publication — write real content under the heading.";
    case "duplicate-heading":
      return "duplicate-heading: the '## <version>' heading appears more " +
        "than once in CHANGELOG.md. Remove the duplicate so the section " +
        "that ships is unambiguous.";
    case "over-cap": {
      const overBy = bytes - cap;
      return `over-cap: release notes are ${bytes} bytes, cap ${cap} ` +
        `(${overBy} over). Per-version release notes are IMMUTABLE once ` +
        "published — trim this section, putting breaking-change and " +
        "migration content FIRST.";
    }
    default:
      return "unknown-failure: the extractor exited in an unrecognised " +
        "way and cannot be classified as ok or a known failure.";
  }
}

/**
 * Turns `{ code, stdout, cap }` from `changelog-section.sh` into a verdict.
 * `ok` only when `code === 0 AND bytes <= cap`. `unknown-failure` is the
 * mandatory `default` branch: the extractor runs under `set -uo pipefail`,
 * where a missing positional argument exits 1 and a missing `awk` or
 * unreadable file exits 127/2 — a switch with no default would let a caller
 * inverting the check read an unforeseen exit code as a pass.
 *
 * `message` is derived SOLELY from `status`, `bytes` and `cap` — never from
 * `stdout`'s content — so a hostile section body (built entirely from
 * workflow-command sigils) can never reach a `::error` annotation.
 */
export function classify(
  input: { code: number; stdout: string; cap: number },
): { status: Status; bytes: number; message: string } {
  const bytes = notesByteLength(input.stdout);
  let status: Status;
  switch (input.code) {
    case 0:
      status = bytes <= input.cap ? "ok" : "over-cap";
      break;
    case 3:
      status = "missing-file";
      break;
    case 4:
      status = "missing-section";
      break;
    case 5:
      status = "blank-section";
      break;
    case 6:
      status = "duplicate-heading";
      break;
    default:
      status = "unknown-failure";
  }
  return { status, bytes, message: messageFor(status, bytes, input.cap) };
}

// ============================================================================
// Impure edges — kept thin and depth-anchored
// ============================================================================

function scriptDir(): string {
  return dirname(fromFileUrl(import.meta.url));
}

function defaultRoot(): string {
  return join(scriptDir(), "..");
}

/**
 * `git -C root diff --name-status -M -z <base> HEAD -- ':(glob)*` +
 * `/manifest.yaml'` (see the actual argv below — split here only so this
 * comment does not itself contain a literal star-slash). The `:(glob)` magic
 * prefix is load-bearing, not decoration: without it the pathspec also
 * returns `nested/sub/manifest.yaml`, because a bare `*` + `/manifest.yaml`
 * pathspec is git wildmatch WITHOUT `WM_PATHNAME` and `*` crosses `/`. `-z`
 * is load-bearing for the reason in the module docblock.
 */
async function gitDiffNameStatus(base: string, root: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: [
      "-C",
      root,
      "diff",
      "--name-status",
      "-M",
      "-z",
      base,
      "HEAD",
      "--",
      ":(glob)*/manifest.yaml",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) {
    // Named rather than a bare re-throw of git's raw "fatal:" text, so the
    // caller's `::error::` annotation reads as a diagnosed violation instead
    // of an unexplained git failure — this is the one path an unreachable
    // `pull_request` base (resolveBase intentionally does not pre-validate
    // `prBaseSha`) or a corrupted checkout can still reach.
    throw new Error(
      `[diff-base-unreachable] git diff --name-status against "${base}" failed: ${
        new TextDecoder().decode(out.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

/**
 * `git show <rev>:<path>` fed to `parseManifest`. A non-zero exit means
 * "absent at that revision" (a genuinely new manifest, or a rename's old
 * path) and resolves to null rather than throwing — this is how the "A has
 * no base" domain rule is applied, without `parseDiffStatus` needing to know
 * about it.
 *
 * Argument injection is not reachable here: the argument is the single
 * token `<rev>:<path>`, so the repo-controlled part can never occupy an
 * option slot and can never begin with `-` on its own — `<rev>:<path>` is
 * an object spec, not a pathspec, so a directory literally named `:(glob)`
 * or `:!` resolves as a literal tree entry rather than magic.
 */
async function manifestCoordinateAt(
  rev: string,
  path: string,
  root: string,
): Promise<Coordinate | null> {
  const cmd = new Deno.Command("git", {
    args: ["-C", root, "show", `${rev}:${path}`],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) return null;
  return parseManifest(new TextDecoder().decode(out.stdout));
}

function commitExistsSync(sha: string, root: string): boolean {
  if (sha === "") return false;
  const cmd = new Deno.Command("git", {
    args: ["-C", root, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
    stdout: "piped",
    stderr: "piped",
  });
  return cmd.outputSync().success;
}

/** Runs the single extractor (`scripts/changelog-section.sh`), resolved from
 * `import.meta.url` — never from `--root`, which points at a throwaway git
 * repo in tests that has no `scripts/` directory of its own. */
async function runExtractor(
  dir: string,
  version: string,
  root: string,
): Promise<{ code: number; stdout: string }> {
  const scriptPath = join(scriptDir(), "changelog-section.sh");
  const changelogPath = join(root, dir, "CHANGELOG.md");
  const cmd = new Deno.Command("bash", {
    args: [scriptPath, changelogPath, version],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Runs the full selection pipeline over a real git repo: diff, parse,
 * resolve every coordinate, apply `selectPublishable`, then intersect with
 * `listExtensions()` — the ONE definition of "an extension" in this repo.
 * `:(glob)` alone is not sufficient: it also matches a dot-directory (e.g.
 * `.hidden/manifest.yaml`), while `listExtensions()` and the CI discover
 * job's bash glob both exclude dot-directories. Any selected manifest
 * outside that set is a violation (`manifest-outside-extension-set`), never
 * silently published and never silently dropped.
 *
 * Rejects (throws, naming every violation rule in its message) rather than
 * resolving whenever ANY violation exists.
 *
 * Also returns `touchedCount` — the number of manifest.yaml records the diff
 * actually walked (deletions excluded) — separately from `selected`, so a
 * caller can distinguish "nothing in this push touches a manifest" from "a
 * manifest was touched but its registry coordinate did not change" (a
 * relabel, a comment edit, ...): both yield an empty `selected`, but only
 * the second is worth a note.
 */
async function selectPublishableRecords(
  base: string,
  root: string,
): Promise<{ selected: SelectedManifest[]; touchedCount: number }> {
  const raw = await gitDiffNameStatus(base, root);
  const records = parseDiffStatus(raw);
  const inputs: SelectionInput[] = [];
  for (const rec of records) {
    if (rec.headPath === null) continue; // deleted manifest: nothing to publish
    // `rec.basePath` is typed `string | null` for symmetry with `headPath`,
    // but `parseDiffStatus` never actually produces null here (only a `D`
    // record does, and that was just filtered above) — narrow explicitly
    // rather than asserting it away, so a future change to either invariant
    // fails loudly instead of silently calling `git show <base>:null`.
    if (rec.basePath === null) {
      inputs.push({
        headPath: rec.headPath,
        head: await manifestCoordinateAt("HEAD", rec.headPath, root),
        base: null,
      });
      continue;
    }
    const [head, baseCoord] = await Promise.all([
      manifestCoordinateAt("HEAD", rec.headPath, root),
      manifestCoordinateAt(base, rec.basePath, root),
    ]);
    inputs.push({ headPath: rec.headPath, head, base: baseCoord });
  }
  const { selected, errors } = selectPublishable(inputs);

  const extensions = new Set(await listExtensions({ root }));
  const allErrors = [...errors];
  const inSet: SelectedManifest[] = [];
  for (const s of selected) {
    if (extensions.has(s.path.split("/")[0])) {
      inSet.push(s);
    } else {
      allErrors.push({
        rule: "manifest-outside-extension-set",
        what: `${
          sanitizeForAnnotation(s.path)
        }: selected for publish but its directory is not a recognised extension`,
      });
    }
  }

  if (allErrors.length > 0) {
    throw new Error(allErrors.map((e) => `[${e.rule}] ${e.what}`).join("; "));
  }
  return { selected: inSet, touchedCount: inputs.length };
}

/**
 * The async orchestration used directly in the selector test battery:
 * `gitDiffNameStatus` + `parseDiffStatus` + `manifestCoordinateAt` +
 * `selectPublishable`, intersected with `listExtensions()`. Resolves to the
 * selected manifest PATHS on success.
 */
export async function selectPublishableManifests(
  base: string,
  root: string,
): Promise<string[]> {
  const { selected } = await selectPublishableRecords(base, root);
  return selected.map((r) => r.path);
}

// ============================================================================
// --manifests-from: an EXPLICIT TSV list, no git at all
// ============================================================================

function parseManifestsFromText(
  text: string,
): { records: SelectedManifest[]; errors: Violation[] } {
  const records: SelectedManifest[] = [];
  const errors: Violation[] = [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.forEach((line, idx) => {
    if (line === "") return;
    const lineNo = idx + 1;
    const tab = line.indexOf("\t");
    if (tab === -1) {
      errors.push({
        rule: "manifest-line-malformed",
        what: `line ${lineNo}: no TAB separator found`,
      });
      return;
    }
    const path = line.slice(0, tab);
    const version = line.slice(tab + 1);
    if (!isValidManifestPath(path)) {
      errors.push({
        rule: "manifest-path-unsupported",
        what: `line ${lineNo}: "${
          sanitizeForAnnotation(path)
        }" is not "<segment>/manifest.yaml"`,
      });
      return;
    }
    if (!isValidVersion(version)) {
      errors.push({
        rule: "manifest-version-unreadable",
        what: `line ${lineNo} (${sanitizeForAnnotation(path)}): ` +
          "version is empty or contains ASCII whitespace " +
          "(a second TAB on the line lands here, since only the FIRST TAB splits the record)",
      });
      return;
    }
    records.push({ path, version });
  });
  if (errors.length === 0 && records.length === 0) {
    errors.push({
      rule: "manifests-from-empty",
      what: "no manifest records were provided on --manifests-from",
    });
  }
  return { records, errors };
}

// ============================================================================
// Shared classify-and-annotate loop
// ============================================================================

async function classifyRecords(
  records: readonly SelectedManifest[],
  cap: number,
  root: string,
): Promise<{ ok: boolean; annotations: string[] }> {
  const annotations: string[] = [];
  let ok = true;
  for (const rec of records) {
    const dir = rec.path.split("/")[0];
    const { code, stdout } = await runExtractor(dir, rec.version, root);
    const verdict = classify({ code, stdout, cap });
    if (verdict.status !== "ok") {
      ok = false;
      const safeDir = sanitizeForAnnotation(dir);
      const safeVersion = sanitizeForAnnotation(rec.version);
      annotations.push(
        `::error file=${safeDir}/CHANGELOG.md::[${verdict.status}] ${safeDir}@${safeVersion}: ${verdict.message}`,
      );
    }
  }
  return { ok, annotations };
}

// ============================================================================
// CLI
// ============================================================================

async function readAllStdin(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

function parseCap(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  return Number(raw);
}

interface Argv {
  mode: string | null;
  manifestsFrom: string | null;
  capRaw: string | undefined;
  root: string | null;
}

function parseArgv(argv: readonly string[]): Argv {
  let mode: string | null = null;
  let manifestsFrom: string | null = null;
  let capRaw: string | undefined;
  let root: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--mode":
        mode = argv[++i] ?? null;
        break;
      case "--manifests-from":
        manifestsFrom = argv[++i] ?? null;
        break;
      case "--cap":
        capRaw = argv[++i];
        break;
      case "--root":
        root = argv[++i] ?? null;
        break;
    }
  }
  return { mode, manifestsFrom, capRaw, root };
}

function printHelp(): void {
  console.log(
    `release_notes_gate.ts — select which manifests this change publishes,
and validate the CHANGELOG.md section their published version will ship
with. The SINGLE implementation both 'release-notes-cap' and
'extension-publish''s pre-flight call — see the module docblock.

Usage:
  deno run --allow-read --allow-run=git,bash \\
    --allow-env=EVENT,PR_BASE_SHA,PUSH_BEFORE \\
    release_notes_gate.ts --mode list   [--root <dir>]
  deno run ... release_notes_gate.ts --mode validate --cap <bytes> [--root <dir>]
  deno run ... release_notes_gate.ts --manifests-from <path|-> --cap <bytes> [--root <dir>]

  --mode list       select from git, print one "<path>TAB<version>" record
                     per selected manifest on stdout, nothing else, exit 0
                     (including an empty selection — prints nothing at all).
                     Exits non-zero on any selection violation. --cap is
                     accepted but ignored (this mode never classifies).
  --mode validate    select from git, extract, classify, annotate every
                     non-ok verdict on stderr with an "::error"; exit 1 on
                     any. --cap is REQUIRED.
  --manifests-from <path|->
                     validate an EXPLICIT "<path>TAB<version>" list (read
                     from a file, or "-" for stdin) instead of selecting
                     from git — this is the publish job's pre-flight; it
                     needs no git at all. An empty list is an error. On
                     success prints exactly one line, "validated <N>
                     manifests". --cap is REQUIRED.
  --cap <bytes>      the registry release-notes cap. Never defaulted:
                     absent, empty, or not a positive integer is a usage
                     error (exit 2).
  --root <dir>       repo root to operate on. Tests only — the deno.json
                     task and CI both omit it, resolving the real checkout
                     from import.meta.url.

Base resolution reads EVENT / PR_BASE_SHA / PUSH_BEFORE from the
environment, deliberately not CLI flags, so no GitHub Actions expression is
ever interpolated into a run: shell body. When no usable diff base resolves,
both modes print "No usable diff base — nothing to check." on stderr and
exit 0 with nothing selected — a fail-closed exit there would drop every
publish in the push it fired for.

Exit codes: 0 clean, 1 a violation was found, 2 usage error.
`,
  );
}

/** The one message shared by both git-backed modes, printed on stderr when
 * the diff walked at least one manifest.yaml but its registry coordinate
 * (name@version) did not change — a relabel, a comment edit, a rename with
 * no bump. Distinct from "nothing was touched at all", which stays silent:
 * that is the overwhelming majority of ordinary pushes and would otherwise
 * turn the job log into noise. */
function reportTouchedButUnselected(
  records: SelectedManifest[],
  touchedCount: number,
): void {
  if (records.length === 0 && touchedCount > 0) {
    console.error(
      "Manifest touched but its version value is unchanged — nothing to publish.",
    );
  }
}

/**
 * Resolves the diff base and selects records for it — the prefix shared by
 * `--mode list` and `--mode validate`. Exits directly (1) on a selection
 * violation, so callers only ever see two outcomes: `null` (no usable base —
 * already reported on stderr — nothing more to do) or a resolved selection.
 */
async function collectGitRecords(
  root: string,
): Promise<{ selected: SelectedManifest[]; touchedCount: number } | null> {
  const event = Deno.env.get("EVENT") ?? "";
  const prBaseSha = Deno.env.get("PR_BASE_SHA") ?? "";
  const pushBefore = Deno.env.get("PUSH_BEFORE") ?? "";
  const base = resolveBase(
    { event, prBaseSha, pushBefore },
    (sha) => commitExistsSync(sha, root),
  );
  if (base === null) {
    console.error("No usable diff base — nothing to check.");
    return null;
  }
  try {
    return await selectPublishableRecords(base, root);
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    return Deno.exit(1);
  }
}

async function runGitModeList(root: string): Promise<never> {
  const result = await collectGitRecords(root);
  if (result === null) return Deno.exit(0);
  const { selected, touchedCount } = result;
  reportTouchedButUnselected(selected, touchedCount);
  if (selected.length > 0) {
    const out = selected.map((r) => `${r.path}\t${r.version}`).join("\n") +
      "\n";
    await Deno.stdout.write(new TextEncoder().encode(out));
  }
  return Deno.exit(0);
}

async function runGitModeValidate(cap: number, root: string): Promise<never> {
  const result = await collectGitRecords(root);
  if (result === null) return Deno.exit(0);
  const { selected, touchedCount } = result;
  reportTouchedButUnselected(selected, touchedCount);
  const { ok, annotations } = await classifyRecords(selected, cap, root);
  if (!ok) {
    for (const a of annotations) console.error(a);
    return Deno.exit(1);
  }
  return Deno.exit(0);
}

async function runManifestsFrom(
  source: string,
  capRaw: string | undefined,
  root: string,
): Promise<never> {
  const cap = parseCap(capRaw);
  if (cap === null) {
    console.error(
      "usage error: --cap <bytes> is required and must be a positive integer",
    );
    printHelp();
    return Deno.exit(2);
  }
  const text = source === "-" ? await readAllStdin() : await Deno.readTextFile(
    source,
  );
  const { records, errors } = parseManifestsFromText(text);
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::[${e.rule}] ${e.what}`);
    return Deno.exit(1);
  }
  const { ok, annotations } = await classifyRecords(records, cap, root);
  if (!ok) {
    for (const a of annotations) console.error(a);
    return Deno.exit(1);
  }
  console.log(`validated ${records.length} manifests`);
  return Deno.exit(0);
}

async function main(): Promise<void> {
  const argv = Deno.args;
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    Deno.exit(0);
  }
  const { mode, manifestsFrom, capRaw, root: rootArg } = parseArgv(argv);
  const root = rootArg ?? defaultRoot();

  if (manifestsFrom !== null) {
    await runManifestsFrom(manifestsFrom, capRaw, root);
    return;
  }

  if (mode === "validate") {
    const cap = parseCap(capRaw);
    if (cap === null) {
      console.error(
        "usage error: --cap <bytes> is required for --mode validate and must be a positive integer",
      );
      printHelp();
      Deno.exit(2);
    }
    await runGitModeValidate(cap, root);
    return;
  }

  if (mode === "list") {
    await runGitModeList(root);
    return;
  }

  console.error(
    "usage error: one of --manifests-from <path|-> or --mode <list|validate> is required",
  );
  printHelp();
  Deno.exit(2);
}

if (import.meta.main) {
  await main();
}
