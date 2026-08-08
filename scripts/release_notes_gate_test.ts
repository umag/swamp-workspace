/**
 * Tests for scripts/release_notes_gate.ts — DOES NOT EXIST YET on this
 * branch. This file is the RED half of plan v4 PR A step 3/6: it pins the
 * contract the module must satisfy before a line of implementation exists,
 * so every test below is expected to fail with a module-resolution error
 * until that step lands.
 *
 * CONTRACT UNDER TEST, transcribed from plan v4 steps 3 and 6 so a reader
 * does not have to cross-reference the plan to follow these tests:
 *
 *   resolveBase(input: { event: string; prBaseSha: string; pushBefore: string },
 *               commitExists: (sha: string) => boolean): string | null
 *     pull_request -> prBaseSha; push with a non-zero, reachable pushBefore
 *     -> pushBefore; otherwise "HEAD~1"; null when even that does not
 *     resolve. Takes no job identity — same input always yields the same
 *     base regardless of which CI job supplied it.
 *
 *   parseDiffStatus(raw: string):
 *     Array<{ status: string; basePath: string | null; headPath: string | null }>
 *     Parses `git diff --name-status -M -z` output — a FLAT NUL-terminated
 *     field sequence, not lines. R.../C... consume TWO path fields (old,
 *     new); every other status consumes ONE. D yields headPath null; every
 *     OTHER status (including A) yields basePath === headPath at this raw
 *     layer — the "A has no base" domain rule is applied by the caller
 *     (manifestCoordinateAt naturally resolves to null for a path absent at
 *     the base revision), not by this parser.
 *
 *   selectPublishable(input: Array<{ headPath: string;
 *       head: { name: string; version: string } | null;
 *       base: { name: string; version: string } | null }>):
 *     { selected: Array<{ path: string; version: string }>; errors: Violation[] }
 *     Select iff base === null || base.name !== head.name ||
 *     base.version !== head.version. A null head is an ERROR
 *     (manifest-version-unreadable), never a silent skip. Also validates the
 *     TSV emission grammar this feeds: a headPath not shaped exactly
 *     `<segment>/manifest.yaml` is manifest-path-unsupported, and a version
 *     value containing ASCII whitespace is manifest-version-unreadable —
 *     both reported rather than silently emitted, because this is the last
 *     point before a record reaches the TSV channel that a credentialed
 *     publish loop reads.
 *
 *   notesByteLength(stdout: string): number
 *     Strips ALL trailing "\n", then counts UTF-8 bytes — reproduces
 *     `printf '%s' "$(script)" | wc -c` exactly. Must not measure raw stdout.
 *
 *   classify(input: { code: number; stdout: string; cap: number }):
 *     { status: Status; bytes: number; message: string }
 *     Status = "ok" | "missing-file" | "missing-section" | "blank-section"
 *       | "duplicate-heading" | "over-cap" | "unknown-failure"
 *     ok only when code 0 AND bytes <= cap. unknown-failure is the
 *     mandatory default branch. message NEVER echoes its own stdout input —
 *     a section body is committer-authored text and must never reach a
 *     `::error` annotation or a $GITHUB_OUTPUT value (workflow-command
 *     injection).
 *
 *   selectPublishableManifests(base: string, root: string): Promise<string[]>
 *     The async orchestration used directly in plan v4 step 6(a)'s test
 *     table: runs gitDiffNameStatus + parseDiffStatus + manifestCoordinateAt
 *     + selectPublishable, intersects the selected set with
 *     `listExtensions({ root })` from scripts/quality/extensions.ts, and
 *     rejects (throws, naming the violation rule in its message) rather than
 *     resolving whenever ANY violation exists — including a selected
 *     manifest outside the extension set. Resolves to the selected manifest
 *     PATHS (e.g. "pkga/manifest.yaml") on success.
 *
 * CLI (spawned as a real subprocess below, exactly like
 * scripts/changelog_section_test.ts drives the real shell script — these
 * tests exercise the shipped artifact's argv/env/exit-code contract, not a
 * reimplementation):
 *   --mode list       prints one `<manifest>TAB<version>` record per
 *                      selected manifest, nothing else, exit 0 (including an
 *                      empty selection — prints nothing at all); non-zero on
 *                      any violation.
 *   --mode validate    select, extract, classify, annotate; exit 1 on any
 *                      non-ok verdict.
 *   --manifests-from <path|->  validate an EXPLICIT TSV list instead of
 *                      selecting from git; an EMPTY list is an ERROR (exit
 *                      non-zero); on success prints exactly one line,
 *                      `validated <N> manifests`.
 *   --cap <bytes>      REQUIRED in every mode that classifies; absent, empty,
 *                      or not a positive integer -> usage error, exit 2.
 *                      Never defaulted.
 *   --root <dir>       tests only.
 *   A null diff base (resolveBase returns null) makes BOTH modes exit 0 with
 *   NOTHING selected/printed on stdout — a fail-closed exit here would drop
 *   every publish in the push it fired for, which is the worst case this
 *   module exists to prevent.
 *   Base inputs come from env vars EVENT / PR_BASE_SHA / PUSH_BEFORE,
 *   deliberately not CLI flags, so no GitHub Actions expression is ever
 *   interpolated into a `run:` shell body.
 *
 * Git-backed fixtures follow scripts/quality/check_allowlist.ts's `git -C
 * <root> ...` shape. Every temp repo passes an explicit committer identity
 * via GIT_AUTHOR_* / GIT_COMMITTER_* env vars — a fresh temp repo inherits
 * no identity from `actions/checkout`, and these tests run GLOBAL in the
 * `compliance` job on every PR, so a runner-only "unable to auto-detect
 * email address" failure would be a recurring mystery.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import {
  classify,
  notesByteLength,
  parseDiffStatus,
  resolveBase,
  selectPublishable,
  selectPublishableManifests,
} from "./release_notes_gate.ts";
import { listExtensions } from "./quality/extensions.ts";

const HERE = dirname(fromFileUrl(import.meta.url));
const GATE_SCRIPT = join(HERE, "release_notes_gate.ts");
const CI_YML = join(HERE, "..", ".github", "workflows", "ci.yml");

// ============================================================================
// Git-backed fixture helpers
// ============================================================================

const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "ci",
  GIT_AUTHOR_EMAIL: "ci@example.com",
  GIT_COMMITTER_NAME: "ci",
  GIT_COMMITTER_EMAIL: "ci@example.com",
  // Isolate every fixture from the developer's/runner's global and system
  // git config — without this, a machine with e.g. core.quotePath=false set
  // globally silently disarms the café fixture's -z mutation (git no longer
  // C-quotes the non-ASCII path even without -z), making that pin decorative
  // on some machines and load-bearing on others.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(
  root: string,
  ...args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args: ["-C", root, ...args],
    env: GIT_IDENTITY,
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

async function initRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "release-notes-gate-" });
  const init = await git(root, "init", "-q", "-b", "main");
  if (!init.success) throw new Error(`git init failed: ${init.stderr}`);
  return root;
}

async function commitAll(root: string, message: string): Promise<void> {
  const add = await git(root, "add", "-A");
  if (!add.success) throw new Error(`git add failed: ${add.stderr}`);
  const commit = await git(root, "commit", "-q", "-m", message);
  if (!commit.success) throw new Error(`git commit failed: ${commit.stderr}`);
}

async function writeManifestFile(
  root: string,
  dir: string,
  name: string,
  version: string,
  label = "fixture",
): Promise<void> {
  const path = join(root, dir, "manifest.yaml");
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\n` +
      `models:\n  - extensions/models/model.ts\nlabels:\n  - ${label}\n`,
  );
}

async function writeManifestRaw(
  root: string,
  dir: string,
  content: string,
): Promise<void> {
  const path = join(root, dir, "manifest.yaml");
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

async function writeChangelogFile(
  root: string,
  dir: string,
  version: string,
  body: string,
): Promise<void> {
  const path = join(root, dir, "CHANGELOG.md");
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `# Changelog\n\n## ${version}\n\n${body}\n`);
}

/** pkga@2026.01.01.1 + pkgb@2026.02.02.1, one commit, matching CHANGELOG
 * sections. Every step-6(a) scenario starts from this and applies ONE
 * mutation on top, so each test builds its own fresh copy. */
async function makeTwoPackageRepo(): Promise<string> {
  const root = await initRepo();
  await writeManifestFile(root, "pkga", "@fixture/pkga", "2026.01.01.1");
  await writeManifestFile(root, "pkgb", "@fixture/pkgb", "2026.02.02.1");
  await commitAll(root, "seed pkga + pkgb");
  return root;
}

async function headSha(root: string): Promise<string> {
  const rev = await git(root, "rev-parse", "HEAD");
  return rev.stdout.trim();
}

async function cleanup(root: string): Promise<void> {
  await Deno.remove(root, { recursive: true });
}

// ============================================================================
// A. resolveBase — pure, no I/O
// ============================================================================

Deno.test("resolveBase: pull_request uses prBaseSha", () => {
  assertEquals(
    resolveBase(
      { event: "pull_request", prBaseSha: "abc123", pushBefore: "" },
      () => true,
    ),
    "abc123",
  );
});

Deno.test("resolveBase: push with a reachable, non-zero before uses pushBefore (mutation: special-case the push branch to always return 'HEAD~1' -> the reachable-before case reddens)", () => {
  assertEquals(
    resolveBase(
      { event: "push", prBaseSha: "", pushBefore: "deadbee" },
      (sha: string) => sha === "deadbee",
    ),
    "deadbee",
  );
});

Deno.test("resolveBase: push with the all-zero before falls through to HEAD~1", () => {
  const zero = "0".repeat(40);
  assertEquals(
    resolveBase({ event: "push", prBaseSha: "", pushBefore: zero }, () => true),
    "HEAD~1",
  );
});

Deno.test("resolveBase: push with an unreachable before falls through to HEAD~1 (stub distinguishes the unreachable pushBefore from HEAD~1 itself, so the fall-through is observed without contradicting the all-zero/unreachable-both cases below, which require the SAME sha to be unresolvable)", () => {
  assertEquals(
    resolveBase(
      { event: "push", prBaseSha: "", pushBefore: "ghost" },
      (sha: string) => sha === "HEAD~1",
    ),
    "HEAD~1",
  );
});

Deno.test("resolveBase: push with an unreachable before AND an unresolvable HEAD~1 returns null — the fall-through does not invent a base that does not exist (mutation: return the unvalidated fallback 'HEAD~1' without checking commitExists -> this reddens; an unvalidated HEAD~1 here would make `git diff HEAD~1 HEAD` fail under set -eo pipefail and kill the detect step for the whole push, the worst case this module exists to prevent)", () => {
  assertEquals(
    resolveBase(
      { event: "push", prBaseSha: "", pushBefore: "ghost" },
      () => false,
    ),
    null,
  );
});

Deno.test("resolveBase: an unrecognised event also falls through to HEAD~1", () => {
  assertEquals(
    resolveBase(
      { event: "workflow_dispatch", prBaseSha: "", pushBefore: "" },
      () => true,
    ),
    "HEAD~1",
  );
});

Deno.test("resolveBase: returns null when even HEAD~1 does not resolve", () => {
  assertEquals(
    resolveBase({ event: "push", prBaseSha: "", pushBefore: "" }, () => false),
    null,
  );
});

Deno.test("resolveBase: pull_request returns prBaseSha even when commitExists is always false — deliberately UNCHECKED, unlike pushBefore and HEAD~1 above (mutation: add '&& commitExists(input.prBaseSha)' to the pull_request branch -> reddens; extension-publish is push-only so this branch can never sit in front of the credentialed job, and an unreachable prBaseSha still fails LOUD via gitDiffNameStatus's diff-base-unreachable violation rather than silently, so pre-validating it here would turn a real problem — a PR opened against an unreachable/force-pushed base — into a SILENT 'nothing to check' exit 0, the opposite of fail-closed)", () => {
  assertEquals(
    resolveBase(
      { event: "pull_request", prBaseSha: "ghost-pr-base", pushBefore: "" },
      () => false,
    ),
    "ghost-pr-base",
  );
});

// Deliberately no "same input yields the same base regardless of which job
// supplied it" test here: resolveBase takes no job-identity parameter at
// all, so `resolveBase(x, f) === resolveBase(x, f)` compares a value to
// itself and cannot fail under any implementation, correct or wrong. The
// point (no job identity in the signature) is already enforced by the type
// signature and by the branch tests above it.

// ============================================================================
// B. parseDiffStatus — pure, no I/O, no git repo needed
// ============================================================================

Deno.test("parseDiffStatus: an 'M' record's basePath equals headPath", () => {
  const raw = "M\0foo/manifest.yaml\0";
  assertEquals(parseDiffStatus(raw), [
    {
      status: "M",
      basePath: "foo/manifest.yaml",
      headPath: "foo/manifest.yaml",
    },
  ]);
});

Deno.test("parseDiffStatus: an 'A' record's basePath ALSO equals headPath at this raw layer — the null-base domain rule for A is applied by manifestCoordinateAt (a path absent at the base revision resolves to null there), not by this parser", () => {
  const raw = "A\0new/manifest.yaml\0";
  assertEquals(parseDiffStatus(raw), [
    {
      status: "A",
      basePath: "new/manifest.yaml",
      headPath: "new/manifest.yaml",
    },
  ]);
});

Deno.test("parseDiffStatus: a 'D' record yields headPath null (mutation: treat D like any other one-path status -> the delete fixture in the selection battery below reddens, because a deleted manifest would then be looked up at HEAD instead of skipped)", () => {
  const raw = "D\0gone/manifest.yaml\0";
  assertEquals(parseDiffStatus(raw), [
    { status: "D", basePath: "gone/manifest.yaml", headPath: null },
  ]);
});

Deno.test("parseDiffStatus: an 'R100' record consumes TWO path fields, old then new (mutation: consume only one path field for R/C statuses -> the rename fixtures in the selection battery redden)", () => {
  const raw = "R100\0old/manifest.yaml\0new/manifest.yaml\0";
  assertEquals(parseDiffStatus(raw), [
    {
      status: "R100",
      basePath: "old/manifest.yaml",
      headPath: "new/manifest.yaml",
    },
  ]);
});

Deno.test("parseDiffStatus: a 'C093' (copy) record ALSO consumes two path fields", () => {
  const raw = "C093\0src/manifest.yaml\0copy/manifest.yaml\0";
  assertEquals(parseDiffStatus(raw), [
    {
      status: "C093",
      basePath: "src/manifest.yaml",
      headPath: "copy/manifest.yaml",
    },
  ]);
});

Deno.test("parseDiffStatus: mixed-status records in one payload are consumed sequentially without desyncing field counts", () => {
  const raw = "A\0a/manifest.yaml\0" +
    "R100\0old/manifest.yaml\0new/manifest.yaml\0" +
    "D\0gone/manifest.yaml\0" +
    "M\0b/manifest.yaml\0";
  assertEquals(parseDiffStatus(raw), [
    { status: "A", basePath: "a/manifest.yaml", headPath: "a/manifest.yaml" },
    {
      status: "R100",
      basePath: "old/manifest.yaml",
      headPath: "new/manifest.yaml",
    },
    { status: "D", basePath: "gone/manifest.yaml", headPath: null },
    { status: "M", basePath: "b/manifest.yaml", headPath: "b/manifest.yaml" },
  ]);
});

Deno.test("parseDiffStatus: a trailing NUL (real `git diff -z` output always ends with one) does not produce a bogus extra record (mutation: parseDiffStatus/parseChangedManifests keeps the trailing empty field as if it were a new record -> this array-length assertion reddens)", () => {
  const raw = "M\0only/manifest.yaml\0"; // trailing NUL, as `-z` always emits
  assertEquals(parseDiffStatus(raw).length, 1);
});

Deno.test("parseDiffStatus: empty input yields no records", () => {
  assertEquals(parseDiffStatus(""), []);
});

// ============================================================================
// C. selectPublishable — pure, no I/O
// ============================================================================

Deno.test("selectPublishable: a null base selects unconditionally (a genuinely new package)", () => {
  const { selected, errors } = selectPublishable([
    {
      headPath: "pkgc/manifest.yaml",
      head: { name: "@fixture/pkgc", version: "1.0.0" },
      base: null,
    },
  ]);
  assertEquals(selected, [{ path: "pkgc/manifest.yaml", version: "1.0.0" }]);
  assertEquals(errors, []);
});

Deno.test("selectPublishable: identical name+version at base and head does not select (a reorder/reformat with no real change)", () => {
  const coord = { name: "@fixture/pkga", version: "1.0.0" };
  const { selected } = selectPublishable([
    { headPath: "pkga/manifest.yaml", head: coord, base: coord },
  ]);
  assertEquals(selected, []);
});

Deno.test("selectPublishable: a version-only change selects", () => {
  const { selected } = selectPublishable([
    {
      headPath: "pkga/manifest.yaml",
      head: { name: "@fixture/pkga", version: "1.0.1" },
      base: { name: "@fixture/pkga", version: "1.0.0" },
    },
  ]);
  assertEquals(selected, [{ path: "pkga/manifest.yaml", version: "1.0.1" }]);
});

Deno.test("selectPublishable: a name-only change (in-place re-scope) selects — the name is part of the registry coordinate (mutation: compare only the version and drop the name from the key -> this reddens; dropping the name is a defect that exists in today's rule too, not merely a regression risk)", () => {
  const { selected } = selectPublishable([
    {
      headPath: "pkga/manifest.yaml",
      head: { name: "@fixture/pkga-renamed", version: "1.0.0" },
      base: { name: "@fixture/pkga", version: "1.0.0" },
    },
  ]);
  assertEquals(selected, [{ path: "pkga/manifest.yaml", version: "1.0.0" }]);
});

Deno.test("selectPublishable: a null head is an ERROR (manifest-version-unreadable), never a silent skip", () => {
  const { selected, errors } = selectPublishable([
    { headPath: "broken/manifest.yaml", head: null, base: null },
  ]);
  assertEquals(selected, []);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].rule, "manifest-version-unreadable");
});

Deno.test("selectPublishable: a headPath that is not exactly '<segment>/manifest.yaml' is manifest-path-unsupported, never silently emitted onto the TSV channel (mutation: emit it anyway -> reddens)", () => {
  const { selected, errors } = selectPublishable([
    {
      headPath: "weird/nested/manifest.yaml",
      head: { name: "@fixture/weird", version: "1.0.0" },
      base: null,
    },
  ]);
  assertEquals(selected, []);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].rule, "manifest-path-unsupported");
});

Deno.test("selectPublishable: a version value containing ASCII whitespace (e.g. an embedded TAB) is manifest-version-unreadable, never silently emitted as a record that would grow a second TAB (mutation: drop the emitted-record grammar check -> the two ends of the TSV channel would disagree about the split)", () => {
  const { selected, errors } = selectPublishable([
    {
      headPath: "pkge/manifest.yaml",
      head: { name: "@fixture/pkge", version: "2026.01.01.1\tx" },
      base: null,
    },
  ]);
  assertEquals(selected, []);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].rule, "manifest-version-unreadable");
});

Deno.test("selectPublishable: a version value containing an embedded LF is manifest-version-unreadable (mutation: validate the version with version.includes('\\t') instead of a full whitespace/LF class -> this reddens; step 5(d)'s heredoc-safety claim — no emitted record can be a bare EOF line, because every record contains a TAB — rests specifically on LF being excluded from the version grammar, since a committed 'version: \"1.0.0\\nEOF\"' would otherwise split the record across two lines, the second a bare EOF that terminates the heredoc early inside the job holding the publish credential)", () => {
  const { selected, errors } = selectPublishable([
    {
      headPath: "pkgf/manifest.yaml",
      head: { name: "@fixture/pkgf", version: "2026.01.01.1\nEOF" },
      base: null,
    },
  ]);
  assertEquals(selected, []);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].rule, "manifest-version-unreadable");
});

Deno.test("selectPublishable: a headPath containing an embedded LF is manifest-path-unsupported, not merely 'more than one /' (mutation: validate the path by counting '/' characters instead of the full segment character set -> this reddens)", () => {
  const { selected, errors } = selectPublishable([
    {
      headPath: "pkgf\n/manifest.yaml",
      head: { name: "@fixture/pkgf", version: "2026.01.01.1" },
      base: null,
    },
  ]);
  assertEquals(selected, []);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].rule, "manifest-path-unsupported");
});

Deno.test("selectPublishable: manifest-version-unreadable's `what` ESCAPES an embedded LF rather than embedding it raw (mutation: replace sanitizeForAnnotation's body with the identity function -> reddens; the two tests above only assert `errors[0].rule`, never the content of `what`, which is why an identity-function mutant was previously invisible to the whole suite — an unescaped LF here would start a second physical line at column 0 of the `::error` annotation this feeds, which GitHub Actions would parse as a NEW workflow command)", () => {
  const { errors } = selectPublishable([
    {
      headPath: "pkgf/manifest.yaml",
      head: { name: "@fixture/pkgf", version: "2026.01.01.1\nEOF" },
      base: null,
    },
  ]);
  assertEquals(errors.length, 1);
  assert(
    !errors[0].what.includes("\n"),
    `expected the embedded LF to be escaped, not raw, in: ${
      JSON.stringify(errors[0].what)
    }`,
  );
  assert(
    errors[0].what.includes("\\n"),
    `expected the literal two-character text "\\n" in place of the raw LF, got: ${
      JSON.stringify(errors[0].what)
    }`,
  );
});

// ============================================================================
// D. notesByteLength — pure, no I/O
// ============================================================================

Deno.test("notesByteLength: strips ALL trailing newlines before counting UTF-8 bytes (mutation: measure raw stdout, skip the trailing-newline strip -> a section ending in extra newlines reddens on an exact byte count)", () => {
  // "## 2026.01.01.1" (15) + "\n\n" (2, internal — must count) + "Body." (5)
  // = 22, then TWO more trailing "\n" that must NOT be counted.
  assertEquals(notesByteLength("## 2026.01.01.1\n\nBody.\n\n"), 22);
});

Deno.test("notesByteLength: measures UTF-8 BYTES, not UTF-16 code units — a multi-byte character must count as more than one byte", () => {
  // 'é' is 2 bytes in UTF-8; "héllo" is 6 bytes even though .length is 5.
  assertEquals(notesByteLength("héllo"), 6);
});

Deno.test("notesByteLength: strips ONLY trailing newlines, not trailing spaces — distinguishes 'strip trailing newlines' from 'trim' (mutation: stdout.trim() instead of stripping trailing \\n -> reddens; measured against the bash reference `printf '%s' \"$(script)\" | wc -c`, which is 32 for this exact body, not 29)", () => {
  // Markdown hard-break trailing spaces before the final newline must count.
  assertEquals(
    notesByteLength("## 1.0.0\n\nline one  \nline two   \n"),
    32,
  );
});

// ============================================================================
// E. classify — pure, no I/O
// ============================================================================

Deno.test("classify: exit 0 within cap is 'ok'", () => {
  const r = classify({
    code: 0,
    stdout: "## 2026.01.01.1\n\nBody.\n",
    cap: 4900,
  });
  assertEquals(r.status, "ok");
});

Deno.test("classify: bytes exactly AT the cap is 'ok' (mutation: 'bytes <= cap' -> 'bytes < cap' -> the exactly-at-cap boundary case reddens on status === 'ok')", () => {
  const stdout = "x".repeat(10);
  const r = classify({ code: 0, stdout, cap: 10 });
  assertEquals(r.bytes, 10);
  assertEquals(r.status, "ok");
});

Deno.test("classify: bytes over cap is 'over-cap'", () => {
  const stdout = "x".repeat(11);
  const r = classify({ code: 0, stdout, cap: 10 });
  assertEquals(r.status, "over-cap");
});

Deno.test("classify: exit code 3 is 'missing-file'", () => {
  assertEquals(
    classify({ code: 3, stdout: "", cap: 4900 }).status,
    "missing-file",
  );
});

Deno.test("classify: exit code 4 is 'missing-section' (mutation: make classify return 'ok' for exit code 4 -> reddens)", () => {
  assertEquals(
    classify({ code: 4, stdout: "", cap: 4900 }).status,
    "missing-section",
  );
});

Deno.test("classify: exit code 5 is 'blank-section', kept distinct from 4 and 6", () => {
  assertEquals(
    classify({ code: 5, stdout: "", cap: 4900 }).status,
    "blank-section",
  );
});

Deno.test("classify: exit code 6 is 'duplicate-heading', kept distinct from 4 and 5", () => {
  assertEquals(
    classify({ code: 6, stdout: "", cap: 4900 }).status,
    "duplicate-heading",
  );
});

Deno.test("classify: unforeseen exit codes are 'unknown-failure', never a silent 'ok' (mutation: add a default: 'ok' branch -> {code:127} and {code:1} both redden on status === 'unknown-failure'; the step-1 extractor runs under set -uo pipefail, where a missing arg exits 1 and a missing awk/unreadable file exits 127/2)", () => {
  assertEquals(
    classify({ code: 127, stdout: "", cap: 4900 }).status,
    "unknown-failure",
  );
  assertEquals(
    classify({ code: 1, stdout: "", cap: 4900 }).status,
    "unknown-failure",
  );
});

Deno.test("classify: bytes measured through notesByteLength, not raw stdout — forces classify to route THROUGH notesByteLength rather than re-measuring stdout itself (mutation: classify computes bytes as new TextEncoder().encode(stdout).length directly -> this reddens; raw stdout here is 12 bytes (10 'x' plus two trailing newlines), which is OVER a cap of 10, so a raw-stdout classify would wrongly report 'over-cap' on a section that is actually exactly at cap once trailing newlines are stripped — a false red that, under plan step 5(a)'s needs: edge, drops every unrelated bump in the same push)", () => {
  const r = classify({ code: 0, stdout: "x".repeat(10) + "\n\n", cap: 10 });
  assertEquals(r.bytes, 10);
  assertEquals(r.status, "ok");
});

Deno.test("classify().message is a fixed-shape WHITELIST, not merely free of one specific substring — a TRUNCATED echo of the section body must also be rejected (mutation: message-prefix40, appending '— section begins: ' plus the first 40 bytes of stdout -> reddens; a 71-byte containment check alone lets a 40-byte prefix through, and 40 bytes is far more than the 17 an attacker needs for a complete '::stop-commands::x' workflow-command directive)", () => {
  // PROPERTY, not wording: hold code and cap fixed and vary only stdout's
  // CONTENT at an EQUAL byte length. A correct classify() derives message
  // solely from byte count and cap, so the two messages below must be
  // identical regardless of what the (equal-length) stdout actually
  // contains. This does not pin any particular wording — plan step 3(g)
  // leaves that open, including a message that names the dir/version/
  // heading — only that stdout content never leaks into it. message-prefix40
  // still reddens this: it echoes each stdout's own (differing) first 40
  // bytes, so the two messages stop matching.
  const hostileStdout =
    "SECTION BODY THAT MUST NEVER REACH A ::error ANNOTATION";
  const benignStdout = "A".repeat(hostileStdout.length);
  const hostile = classify({ code: 0, stdout: hostileStdout, cap: 4 });
  const benign = classify({ code: 0, stdout: benignStdout, cap: 4 });
  assertEquals(
    hostile.message,
    benign.message,
    `classify().message must depend only on byte count and cap, never on stdout content: hostile=${hostile.message} benign=${benign.message}`,
  );
});

Deno.test("classify().message never carries a workflow-command sigil or a newline, even when stdout is built ENTIRELY from repeated '::stop-commands::' directives (mutation: echo any part of stdout into message -> reddens; a repeated-directive body is the sharpest version of the injection this pin guards against, since a single leaked newline-terminated copy would be a complete, syntactically valid workflow command)", () => {
  const r = classify({
    code: 0,
    stdout: "::stop-commands::x\n".repeat(5),
    cap: 4,
  });
  assert(
    !r.message.includes("::"),
    `message must not contain '::', got: ${r.message}`,
  );
  assert(
    !r.message.includes("\n"),
    `message must not contain a newline, got: ${r.message}`,
  );
});

// ============================================================================
// F. selectPublishableManifests — async, over real temp git repos.
// Plan v4 step 6(a)'s twelve scenarios, one mutation each on top of the
// same two-package base repo.
// ============================================================================

Deno.test("selectPublishableManifests: bump pkga only + edit pkgb's labels only -> selects exactly pkga (mutation: select on /^\\+version:/ over the per-manifest diff instead of comparing parsed coordinates -> this and the next several fixtures all redden; without the coordinate rule, a rename or a reformat can drop an UNRELATED package's publish permanently)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2026.01.02.1");
    await writeManifestFile(
      root,
      "pkgb",
      "@fixture/pkgb",
      "2026.02.02.1",
      "renamed-label",
    );
    await commitAll(root, "bump pkga, relabel pkgb");
    assertEquals(await selectPublishableManifests("HEAD~1", root), [
      "pkga/manifest.yaml",
    ]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: moving pkga's version: line without changing its value selects NOTHING (mutation: select on /^\\+version:/ -> this reddens, because moving the line produces a -/+ pair even though the value is untouched)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestRaw(
      root,
      "pkga",
      `manifestVersion: 1\nname: "@fixture/pkga"\nlabels:\n  - fixture\n` +
        `version: "2026.01.01.1"\nmodels:\n  - extensions/models/model.ts\n`,
    );
    await commitAll(root, "reorder pkga's version key");
    assertEquals(await selectPublishableManifests("HEAD~1", root), []);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: bare 'git mv pkga pkga-legacy' with no version change selects NOTHING", async () => {
  const root = await makeTwoPackageRepo();
  try {
    const mv = await git(root, "mv", "pkga", "pkga-legacy");
    assert(mv.success, mv.stderr);
    await commitAll(root, "rename pkga -> pkga-legacy, no version change");
    assertEquals(await selectPublishableManifests("HEAD~1", root), []);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: 'git mv pkga pkga-legacy' PLUS a real version bump selects pkga-legacy (mutation: disable rename detection — '--no-renames', or 'diff.renames=false' in config — so git reports D+A instead of an R record; this fixture reddens because the new path then looks like a brand-new package with no base. NOT '-M': rename detection has been git's default since 2.9, so dropping the flag alone is inert on any default-configured runner — measured directly)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    const mv = await git(root, "mv", "pkga", "pkga-legacy");
    assert(mv.success, mv.stderr);
    await writeManifestFile(
      root,
      "pkga-legacy",
      "@fixture/pkga",
      "2026.01.02.1",
    );
    await commitAll(root, "rename pkga -> pkga-legacy AND bump it");
    assertEquals(await selectPublishableManifests("HEAD~1", root), [
      "pkga-legacy/manifest.yaml",
    ]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: 'git rm -r pkgb' selects NOTHING (mutation: treat status D as selectable -> this reddens, because a deleted manifest publishes nothing)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    const rm = await git(root, "rm", "-r", "-q", "pkgb");
    assert(rm.success, rm.stderr);
    await commitAll(root, "delete pkgb");
    assertEquals(await selectPublishableManifests("HEAD~1", root), []);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: adding a brand-new pkgc with a version and a section selects pkgc", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestFile(root, "pkgc", "@fixture/pkgc", "2026.03.01.1");
    await commitAll(root, "add pkgc");
    assertEquals(await selectPublishableManifests("HEAD~1", root), [
      "pkgc/manifest.yaml",
    ]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: bumping pkgb AND renaming pkga in ONE commit selects exactly pkgb (mutation: the guard and the publisher computing two different sets over the same combined diff is the historical defect this design closes — both must agree on exactly {pkgb})", async () => {
  const root = await makeTwoPackageRepo();
  try {
    const mv = await git(root, "mv", "pkga", "pkga-legacy");
    assert(mv.success, mv.stderr);
    await writeManifestFile(root, "pkgb", "@fixture/pkgb", "2026.02.03.1");
    await commitAll(root, "bump pkgb, rename pkga (no version change)");
    assertEquals(await selectPublishableManifests("HEAD~1", root), [
      "pkgb/manifest.yaml",
    ]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: a bumped nested pkga/sub/manifest.yaml selects NOTHING — depth matters (mutation: drop the :(glob) pathspec prefix -> the nested fixture reddens, because '*/manifest.yaml' without WM_PATHNAME crosses '/')", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestFile(
      root,
      join("pkga", "sub"),
      "@fixture/pkga-sub",
      "2026.01.01.1",
    );
    await commitAll(root, "add a nested manifest under pkga/sub");
    assertEquals(await selectPublishableManifests("HEAD~1", root), []);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: changing pkga's name: IN PLACE with version unchanged selects pkga (mutation: compare only the version and drop the name from the key -> this in-place re-scope fixture stops selecting)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestFile(
      root,
      "pkga",
      "@fixture/pkga-renamed",
      "2026.01.01.1",
    );
    await commitAll(root, "re-scope pkga's name in place");
    assertEquals(await selectPublishableManifests("HEAD~1", root), [
      "pkga/manifest.yaml",
    ]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: 'git mv pkga pkga-ng' PLUS changing its name:, version unchanged, selects pkga-ng (mutation: compare only the version and drop the name from the key -> this rename-plus-re-scope fixture stops selecting)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    const mv = await git(root, "mv", "pkga", "pkga-ng");
    assert(mv.success, mv.stderr);
    await writeManifestFile(
      root,
      "pkga-ng",
      "@fixture/pkga-renamed",
      "2026.01.01.1",
    );
    await commitAll(root, "rename pkga -> pkga-ng AND re-scope its name");
    assertEquals(await selectPublishableManifests("HEAD~1", root), [
      "pkga-ng/manifest.yaml",
    ]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: rewriting pkga's version scalar from double- to single-quotes selects NOTHING (mutation: leave unquote double-quote-only -> this fixture selects pkga spuriously and would emit a version with the quotes still attached)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestRaw(
      root,
      "pkga",
      `manifestVersion: 1\nname: "@fixture/pkga"\nversion: '2026.01.01.1'\n` +
        `models:\n  - extensions/models/model.ts\nlabels:\n  - fixture\n`,
    );
    await commitAll(root, "requote pkga's version scalar");
    assertEquals(await selectPublishableManifests("HEAD~1", root), []);
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: a bumped package directory whose name is non-ASCII (café/manifest.yaml) selects café (mutation: drop -z from the name-status call -> this fixture reddens with manifest-version-unreadable, because git C-quotes the path and the subsequent 'git show' exits 128)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestFile(root, "café", "@fixture/cafe", "2026.01.01.1");
    await commitAll(root, "add café package");
    assertEquals(await selectPublishableManifests("HEAD~1", root), [
      "café/manifest.yaml",
    ]);
  } finally {
    await cleanup(root);
  }
});

// --- depth subset: intersection with listExtensions() -----------------

Deno.test("selectPublishableManifests: a bumped .hidden/manifest.yaml is reported as manifest-outside-extension-set, not silently returned (mutation: drop the listExtensions() intersection -> the .hidden fixture is returned instead of reported; git's :(glob) pathspec DOES match dot-directories even though listExtensions() and the bash discover glob both exclude them)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestFile(root, ".hidden", "@fixture/hidden", "2026.01.01.1");
    await commitAll(root, "add .hidden package");
    await assertRejects(
      () => selectPublishableManifests("HEAD~1", root),
      Error,
      "manifest-outside-extension-set",
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("selectPublishableManifests: the selected set is always a SUBSET of listExtensions({ root }) for an ordinary, non-violating bump — checked against the REAL listExtensions() output, not a hard-coded expectation (sanity/regression coverage on the invariant itself, NOT a mutation-killing test: this fixture never adds a package outside the extension set, so dropping the listExtensions() intersection does not redden it — that mutation is caught by the '.hidden' test immediately above, via assertRejects, and by the '--mode list exits non-zero on manifest-outside-extension-set' CLI test further down this file)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2026.01.02.1");
    await commitAll(root, "bump pkga");
    const selected = await selectPublishableManifests("HEAD~1", root);
    assertEquals(selected, ["pkga/manifest.yaml"]);
    const exts = await listExtensions({ root });
    assert(
      selected.every((p: string) => exts.includes(p.split("/")[0])),
      `every selected manifest's directory must be a recognised extension: selected=${
        JSON.stringify(selected)
      } extensions=${JSON.stringify(exts)}`,
    );
  } finally {
    await cleanup(root);
  }
});

// ============================================================================
// G. CLI contract — spawned as a real subprocess (the shipped artifact).
// ============================================================================

interface GateRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGate(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Promise<GateRun> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run=git,bash",
      "--allow-env=EVENT,PR_BASE_SHA,PUSH_BEFORE",
      GATE_SCRIPT,
      ...args,
    ],
    env: opts.env ?? {},
    stdin: opts.stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  if (opts.stdin !== undefined) {
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
    const out = await child.output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  }
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test('CLI: --cap absent exits 2 (mutation: default it via `Number(x) || 4900` -> reddens; Number("") is 0, and this idiom would silently disarm the only cap enforcement left after truncation is deleted)', async () => {
  const { code } = await runGate(["--manifests-from", "-"], { stdin: "" });
  assertEquals(code, 2);
});

Deno.test("CLI: --cap notanumber exits 2", async () => {
  const { code } = await runGate(
    ["--manifests-from", "-", "--cap", "notanumber"],
    { stdin: "" },
  );
  assertEquals(code, 2);
});

Deno.test("CLI: --manifests-from - with empty stdin exits non-zero (mutation: allow an empty list to exit 0 -> reddens; the only caller is gated on changed=='true', so an empty read there is broken plumbing, and passing vacuously would hand a credentialed push a set nothing validated)", async () => {
  const { code } = await runGate(["--manifests-from", "-", "--cap", "4900"], {
    stdin: "",
  });
  assert(code !== 0);
});

Deno.test('CLI: --manifests-from REJECTS a line bearing two TABs rather than silently truncating the version to its first field (mutation: parse with split("\\t") instead of indexOf+slice -> the malformed record would validate successfully against a real, healthy package instead of being rejected)', async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkgd", "@fixture/pkgd", "2026.01.01.1");
    await writeChangelogFile(
      root,
      "pkgd",
      "2026.01.01.1",
      "Healthy release notes.",
    );
    await commitAll(root, "seed pkgd");
    const { code, stdout } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "pkgd/manifest.yaml\t2026.01.01.1\tEXTRA\n" },
    );
    assert(
      code !== 0,
      "a record with a second TAB must be rejected, not silently accepted",
    );
    assert(
      !stdout.includes("validated"),
      `a rejected batch must never print the success line, got stdout: ${stdout}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: a record whose leading path segment is '..' is REJECTED as manifest-path-unsupported rather than resolved outside --root (mutation: drop the '.'/'..' segment check from isValidManifestPath -> reddens; MANIFEST_PATH_RE alone accepts '..' as a valid <segment>, since it contains none of '/', TAB, LF or NUL — measured on the shipped code before this fix, '../manifest.yaml\\t1.0.0' made classifyRecords read a CHANGELOG.md one directory ABOVE --root and exit 0. --manifests-from has no listExtensions() intersection the way the git path does at selectPublishableRecords, so this check is the only thing standing between this TSV channel — the pre-flight in the credentialed extension-publish job — and a read outside the intended root)", async () => {
  const parent = await Deno.makeTempDir({
    prefix: "release-notes-gate-traversal-",
  });
  const root = join(parent, "root");
  await Deno.mkdir(root, { recursive: true });
  // The sentinel a "../manifest.yaml" record would let the extractor read
  // if the ".."-segment check were missing or dropped.
  await Deno.writeTextFile(
    join(parent, "CHANGELOG.md"),
    "# Changelog\n\n## 1.0.0\n\nEscaped the root.\n",
  );
  try {
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "../manifest.yaml\t1.0.0\n" },
    );
    assert(
      code !== 0,
      "a leading '..' path segment must be rejected, not resolved outside --root",
    );
    assert(
      !stdout.includes("validated"),
      `a rejected batch must never print the success line, got stdout: ${stdout}`,
    );
    assert(
      stderr.includes("::error") &&
        stderr.includes("manifest-path-unsupported"),
      `expected an ::error naming manifest-path-unsupported, got: ${stderr}`,
    );
  } finally {
    await cleanup(parent);
  }
});

Deno.test('CLI: a genuinely null diff base makes --mode list write ZERO BYTES to stdout and exit 0, with the note on STDERR (mutation: print the null-base note with console.log in --mode list -> reddens on stdout.length; that mutation would make ci.yml\'s `[ -z "$manifests" ]` test false and hand an English sentence to the credentialed pre-flight as a manifest path; mutation: emit the note nowhere at all -> reddens on the stderr assertion below, since that would make the null-base path a SILENT gate — exit 0 having checked nothing and said nothing in the job log)', async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "solo", "@fixture/solo", "2026.01.01.1");
    await commitAll(root, "only commit — HEAD~1 does not resolve");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "list", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PR_BASE_SHA: "", PUSH_BEFORE: "" } },
    );
    assertEquals(code, 0);
    assertEquals(
      stdout.length,
      0,
      `expected zero bytes on stdout for a null base, got: ${
        JSON.stringify(stdout)
      }`,
    );
    assert(
      stderr.includes("No usable diff base"),
      `expected the null-base note on stderr, got: ${JSON.stringify(stderr)}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI: a genuinely null diff base makes --mode validate ALSO exit 0 with nothing selected, with the note on STDERR (mutation: make a null base exit 1 -> reddens for BOTH modes; that is the mutation that would drop every publish in the push it fired for)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "solo", "@fixture/solo", "2026.01.01.1");
    await commitAll(root, "only commit — HEAD~1 does not resolve");
    const { code, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PR_BASE_SHA: "", PUSH_BEFORE: "" } },
    );
    assertEquals(code, 0);
    assert(
      stderr.includes("No usable diff base"),
      `expected the null-base note on stderr, got: ${JSON.stringify(stderr)}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI: an unreachable PR_BASE_SHA makes --mode list exit non-zero with a diff-base-unreachable annotation, NOT a silent empty selection (mutation: in gitDiffNameStatus, replace the throw block with `if (!out.success) return \"\";` -> reddens; that mutant turns an unreachable diff base into a vacuous 'nothing to publish' — zero bytes on stdout, exit 0 — indistinguishable from the genuine null-base case above, and defeats resolveBase's own docblock justification for deliberately NOT pre-validating prBaseSha with commitExists: \"an unreachable prBaseSha fails LOUD ... turns git's fatal into a named diff-base-unreachable violation\")", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2026.01.01.1");
    await commitAll(root, "seed pkga");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "list", "--root", root, "--cap", "4900"],
      {
        env: {
          EVENT: "pull_request",
          PR_BASE_SHA: "a".repeat(40), // well-formed sha, unreachable in this repo
          PUSH_BEFORE: "",
        },
      },
    );
    assert(
      code !== 0,
      "an unreachable PR base must fail closed, not silently select nothing",
    );
    assertEquals(
      stdout.length,
      0,
      `an unreachable base must never reach the TSV channel, got: ${
        JSON.stringify(stdout)
      }`,
    );
    assert(
      stderr.includes("diff-base-unreachable"),
      `expected a diff-base-unreachable annotation on stderr, got: ${
        JSON.stringify(stderr)
      }`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI: an unreachable PR_BASE_SHA also makes --mode validate exit non-zero with a diff-base-unreachable annotation (same mutant as above: swallowing the git failure into an empty diff would make the release-notes-cap guard PASS VACUOUSLY on an unreachable base)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2026.01.01.1");
    await commitAll(root, "seed pkga");
    const { code, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      {
        env: {
          EVENT: "pull_request",
          PR_BASE_SHA: "a".repeat(40),
          PUSH_BEFORE: "",
        },
      },
    );
    assert(code !== 0, "an unreachable PR base must fail closed");
    assert(
      stderr.includes("diff-base-unreachable"),
      `expected a diff-base-unreachable annotation on stderr, got: ${
        JSON.stringify(stderr)
      }`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI: --mode list exits non-zero when the selector reports manifest-outside-extension-set, not just --mode validate (mutation: make --mode list exit 0 unconditionally -> the .hidden fixture would pass in list mode while still failing in validate mode, so the two modes would disagree about whether a violation is fatal)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    const base = await headSha(root);
    await writeManifestFile(root, ".hidden", "@fixture/hidden", "2026.01.01.1");
    await commitAll(root, "add .hidden package");
    const env = { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" };
    const listRun = await runGate(
      ["--mode", "list", "--root", root, "--cap", "4900"],
      { env },
    );
    const validateRun = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env },
    );
    assert(
      listRun.code !== 0,
      "list mode must also fail closed on a manifest-outside-extension-set violation",
    );
    assert(validateRun.code !== 0, "validate mode must fail closed too");
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI: manifest-outside-extension-set sanitizes a raw CR embedded in the directory name rather than emitting it verbatim (mutation: drop the sanitizeForAnnotation call on s.path in selectPublishableRecords -> reddens; MANIFEST_PATH_RE excludes '/', TAB, LF and NUL but NOT CR, and a raw CR is a line terminator to the Actions runner — an unescaped one here would split the ::error line into a second physical line starting at column 0, where a leading '::' is parsed as a NEW workflow command)", async () => {
  const root = await makeTwoPackageRepo();
  try {
    const base = await headSha(root);
    // A dot-directory so it lands on manifest-outside-extension-set (git's
    // :(glob) pathspec matches dot-directories; listExtensions() excludes
    // them), with a raw CR embedded in the directory name.
    await writeManifestFile(
      root,
      ".ev\ril",
      "@fixture/hidden",
      "2026.01.01.1",
    );
    await commitAll(root, "add a CR-named dot-directory package");
    const { code, stderr } = await runGate(
      ["--mode", "list", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assert(
      code !== 0,
      "a manifest outside the extension set must still fail closed",
    );
    assert(
      !/\r/.test(stderr),
      `expected no raw CR byte on stderr, got: ${JSON.stringify(stderr)}`,
    );
    assert(
      stderr.includes("manifest-outside-extension-set"),
      `expected the manifest-outside-extension-set rule on stderr, got: ${
        JSON.stringify(stderr)
      }`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: classifyRecords' ::error annotation sanitizes a raw CR embedded in the directory name rather than emitting it verbatim (mutation: drop either sanitizeForAnnotation call added to classifyRecords -> reddens; this is the ONLY annotation the ordinary --manifests-from failure path emits, and MANIFEST_PATH_RE's grammar permits a raw CR in a path segment — a directory literally named 'crext<CR>::stop-commands::zz' would otherwise split the pre-flight's own ::error into a syntactically valid ::stop-commands:: directive inside the job that later authenticates swamp)", async () => {
  const root = await Deno.makeTempDir({ prefix: "release-notes-gate-cr-" });
  try {
    const { code, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "ev\ril/manifest.yaml\t1.0.0\n" },
    );
    assert(
      code !== 0,
      "a directory with no CHANGELOG.md must fail closed (missing-file)",
    );
    assert(
      !/\r/.test(stderr),
      `expected no raw CR byte on stderr, got: ${JSON.stringify(stderr)}`,
    );
    assert(
      stderr.includes("\\r"),
      `expected the CR escaped as the literal text \\r, got: ${
        JSON.stringify(stderr)
      }`,
    );
    assert(
      stderr.includes("missing-file"),
      `expected the missing-file rule on stderr, got: ${
        JSON.stringify(stderr)
      }`,
    );
  } finally {
    await cleanup(root);
  }
});

// --- the TSV emitter, pinned byte-for-byte on a SUCCESSFUL selection ------
// (previously only the negative side — zero bytes on a null base — and the
// reader side (--manifests-from) were pinned; the producing end that
// actually feeds the credentialed publish loop had no positive assertion.)

Deno.test("CLI: --mode list prints EXACTLY one \"<path>TAB<HEAD version>\" record per selected manifest, byte-for-byte, for a two-package bump (mutation: list-no-version, printing just the path -> reddens; mutation: list-base-version, emitting the BASE coordinate's version instead of HEAD's -> reddens — that mutant would make the publish loop ship pkga's 1.0.0 CHANGELOG section as pkga's 2.0.0 release notes, permanently, since registry notes are immutable)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2026.01.01.1");
    await writeManifestFile(root, "pkgb", "@fixture/pkgb", "2026.02.02.1");
    await commitAll(root, "seed pkga + pkgb");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2026.01.02.1");
    await writeManifestFile(root, "pkgb", "@fixture/pkgb", "2026.02.03.1");
    await commitAll(root, "bump both");
    const { code, stdout } = await runGate(
      ["--mode", "list", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 0);
    assertEquals(
      stdout,
      "pkga/manifest.yaml\t2026.01.02.1\npkgb/manifest.yaml\t2026.02.03.1\n",
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI: --mode list works with NO --cap at all, exactly as ci.yml's detect step actually invokes it (mutation: require --cap in every mode, not just the modes that classify -> reddens; ci.yml:step-5(d) runs `deno task --quiet release-notes-gate --mode list` with no --cap, and under set -eo pipefail a spurious 'required' usage error there kills the detect step and drops every publish in the push)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await commitAll(root, "seed");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2.0.0");
    await commitAll(root, "bump");
    const { code, stdout } = await runGate(
      ["--mode", "list", "--root", root],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 0);
    assertEquals(stdout, "pkga/manifest.yaml\t2.0.0\n");
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI: --mode list exits 0 with ZERO BYTES on a REAL (non-null) base when nothing was actually bumped — distinct from the null-base case above, over a genuine resolvable diff (mutation: list-empty-nonzero, treating an empty selection as an error -> reddens; that mutant would fail extension-publish's detect step on every master push that touches a manifest without bumping it, which is most pushes)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await commitAll(root, "seed");
    const base = await headSha(root);
    await writeManifestFile(
      root,
      "pkga",
      "@fixture/pkga",
      "1.0.0",
      "relabeled-only",
    );
    await commitAll(root, "relabel only, no version or name change");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "list", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 0);
    assertEquals(stdout, "");
    assert(
      stderr.includes(
        "Manifest touched but its version value is unchanged",
      ),
      `expected the touched-but-unselected note on stderr (nothing on stdout explains a silent no-op relabel push), got: ${
        JSON.stringify(stderr)
      }`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --mode validate: a manifest touched with NO version/name change ALSO prints the touched-but-unselected note on stderr and exits 0 clean (mutation: emit the note only from --mode list -> reddens; both modes select via the same collectGitRecords path, so a developer running --mode validate locally must see the same explanation --mode list gives in CI)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await commitAll(root, "seed");
    const base = await headSha(root);
    await writeManifestFile(
      root,
      "pkga",
      "@fixture/pkga",
      "1.0.0",
      "relabeled-only",
    );
    await commitAll(root, "relabel only, no version or name change");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 0);
    assertEquals(stdout, "");
    assert(
      stderr.includes(
        "Manifest touched but its version value is unchanged",
      ),
      `expected the touched-but-unselected note on stderr, got: ${
        JSON.stringify(stderr)
      }`,
    );
  } finally {
    await cleanup(root);
  }
});

// --- THE HEADLINE DEFECT: a non-ok classify verdict must fail closed at ---
// --- the CLI layer, for BOTH --mode validate and --manifests-from --------
//
// Every non-zero CLI assertion above this point is a USAGE error, an
// EMPTY-LIST error, a TSV GRAMMAR rejection, or a SELECTOR violation —
// every one of which fails BEFORE any CHANGELOG section is ever extracted.
// None of them drives the gate over a manifest whose section is missing,
// blank, duplicated, or over cap. That is the exact shape of the warn-and-
// continue defect this whole plan exists to close (ci.yml:277-279 today),
// and a suite without these tests cannot see it: a reference implementation
// that classifies every verdict correctly and then exits 0 regardless
// passes everything above.

Deno.test("CLI --mode validate: a bumped manifest with NO CHANGELOG section for the new version exits 1 with an ::error naming missing-section (THE WARN->ERROR FLIP — mutation: classify a non-ok verdict but never set the exit code -> reddens; this is ci.yml:277-279's literal warn-and-continue regression, verbatim)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Initial release.");
    await commitAll(root, "seed pkga@1.0.0");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2.0.0");
    // no CHANGELOG.md edit at all: the file still has no "## 2.0.0" heading
    await commitAll(root, "bump pkga to 2.0.0, no changelog section added");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 1);
    assert(
      stdout.length === 0,
      `stdout must stay empty on failure, got: ${stdout}`,
    );
    assert(
      stderr.includes("::error") && stderr.includes("pkga") &&
        stderr.includes("2.0.0") && stderr.includes("missing-section"),
      `expected an ::error naming pkga, 2.0.0 and missing-section, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --mode validate: a bumped manifest whose new section is entirely BLANK exits 1 with an ::error naming blank-section", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Initial release.");
    await commitAll(root, "seed pkga@1.0.0");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2.0.0");
    await Deno.writeTextFile(
      join(root, "pkga", "CHANGELOG.md"),
      "# Changelog\n\n## 2.0.0\n\n   \n\n## 1.0.0\n\nInitial release.\n",
    );
    await commitAll(root, "bump pkga to 2.0.0, blank section");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 1);
    assert(stdout.length === 0);
    assert(
      stderr.includes("::error") && stderr.includes("blank-section"),
      `expected an ::error naming blank-section, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --mode validate: a bumped manifest whose new heading appears TWICE exits 1 with an ::error naming duplicate-heading", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Initial release.");
    await commitAll(root, "seed pkga@1.0.0");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2.0.0");
    await Deno.writeTextFile(
      join(root, "pkga", "CHANGELOG.md"),
      "# Changelog\n\n## 2.0.0\n\n- first\n\n## 2.0.0\n\n- second\n",
    );
    await commitAll(root, "bump pkga to 2.0.0, duplicate heading");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 1);
    assert(stdout.length === 0);
    assert(
      stderr.includes("::error") && stderr.includes("duplicate-heading"),
      `expected an ::error naming duplicate-heading, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --mode validate: a bumped manifest whose new section exceeds --cap exits 1 with an ::error naming over-cap and the byte count, and the annotation NEVER echoes any part of the section body (mutation: append a section-body excerpt to the ::error line for 'developer context' -> reddens; the fixture body is built entirely from a workflow-command sigil precisely because a leaked copy of it would take effect in the runner log, and every OTHER failure fixture in this file is a benign body, so only a negative assertion on a hostile body can catch this)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Initial release.");
    await commitAll(root, "seed pkga@1.0.0");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2.0.0");
    await writeChangelogFile(
      root,
      "pkga",
      "2.0.0",
      "::stop-commands::x\n".repeat(300),
    );
    await commitAll(root, "bump pkga to 2.0.0, oversized hostile section");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 1);
    assert(stdout.length === 0);
    assert(
      stderr.includes("::error") && stderr.includes("over-cap") &&
        stderr.includes("cap 4900"),
      `expected an ::error naming over-cap and the cap, got: ${
        JSON.stringify(stderr)
      }`,
    );
    assert(
      !stderr.includes("::stop-commands"),
      `the ::error annotation must never echo the section body, got stderr: ${
        JSON.stringify(stderr)
      }`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --mode validate: a bumped manifest whose extension has NO CHANGELOG.md at all exits 1 with an ::error naming missing-file", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Initial release.");
    await commitAll(root, "seed pkga@1.0.0");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2.0.0");
    await Deno.remove(join(root, "pkga", "CHANGELOG.md"));
    await commitAll(root, "bump pkga to 2.0.0, delete CHANGELOG.md entirely");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 1);
    assert(stdout.length === 0);
    assert(
      stderr.includes("::error") && stderr.includes("missing-file"),
      `expected an ::error naming missing-file, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --mode validate: a bumped manifest with a healthy, in-cap section exits 0 with nothing on stdout or stderr (the positive contract the five failure cases above are measured against)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Initial release.");
    await commitAll(root, "seed pkga@1.0.0");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2.0.0");
    await writeChangelogFile(root, "pkga", "2.0.0", "Healthy release notes.");
    await commitAll(root, "bump pkga to 2.0.0, healthy section");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 0);
    assertEquals(stdout, "");
    assertEquals(stderr, "");
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --mode validate: TWO bumped manifests where the SECOND is broken exits 1 naming the second record, not just the first (mutation: first-record-only, classifying only selected[0] and exiting 0 once it is 'ok' -> reddens; a multi-package master push is the normal case here, not a hypothesis — the CI-concurrency incident this plan traces back to shipped 18 publishes in one push, and the only existing multi-record fixture in this file was the all-healthy pair, which cannot distinguish 'classifies every record' from 'classifies only the first')", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Initial release.");
    await writeManifestFile(root, "pkgb", "@fixture/pkgb", "1.0.0");
    await writeChangelogFile(root, "pkgb", "1.0.0", "Initial release.");
    await commitAll(root, "seed pkga@1.0.0 + pkgb@1.0.0");
    const base = await headSha(root);
    await writeManifestFile(root, "pkga", "@fixture/pkga", "2.0.0");
    await writeChangelogFile(root, "pkga", "2.0.0", "Healthy release notes.");
    await writeManifestFile(root, "pkgb", "@fixture/pkgb", "2.0.0");
    // no CHANGELOG.md edit for pkgb: it still has no "## 2.0.0" heading
    await commitAll(root, "bump pkga (healthy) and pkgb (broken) to 2.0.0");
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 1);
    assert(
      stdout.length === 0,
      `stdout must stay empty when any record in the batch fails, got: ${stdout}`,
    );
    assert(
      stderr.includes("::error") && stderr.includes("pkgb") &&
        stderr.includes("2.0.0") && stderr.includes("missing-section"),
      `expected an ::error naming pkgb, 2.0.0 and missing-section, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --mode validate: THREE bumped manifests where the LAST TWO are broken in DIFFERENT ways exits 1 naming BOTH, not just the first one hit (mutation: classify-first-record-only — insert `break;` immediately after the `annotations.push(...)` call in classifyRecords's loop -> reddens on the annotation COUNT; that mutant still exits 1 (the `ok` flag is set before the break) and still SURVIVES the two-record 'second is broken' fixture above, because breaking after the last record in a batch loses nothing — this fixture has a broken record AFTER the first broken one, so the break drops the second annotation while the exit code stays wrong-for-the-right-reason)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "aaa", "@fixture/aaa", "1.0.0");
    await writeChangelogFile(root, "aaa", "1.0.0", "Initial release.");
    await writeManifestFile(root, "bbb", "@fixture/bbb", "1.0.0");
    await writeChangelogFile(root, "bbb", "1.0.0", "Initial release.");
    await writeManifestFile(root, "ccc", "@fixture/ccc", "1.0.0");
    await writeChangelogFile(root, "ccc", "1.0.0", "Initial release.");
    await commitAll(root, "seed aaa + bbb + ccc @1.0.0");
    const base = await headSha(root);
    await writeManifestFile(root, "aaa", "@fixture/aaa", "2.0.0");
    await writeChangelogFile(root, "aaa", "2.0.0", "Healthy release notes.");
    await writeManifestFile(root, "bbb", "@fixture/bbb", "2.0.0");
    // no CHANGELOG.md edit for bbb: no "## 2.0.0" heading -> missing-section
    await writeManifestFile(root, "ccc", "@fixture/ccc", "2.0.0");
    await Deno.writeTextFile(
      join(root, "ccc", "CHANGELOG.md"),
      "# Changelog\n\n## 2.0.0\n\n   \n\n## 1.0.0\n\nInitial release.\n",
    ); // blank-section
    await commitAll(
      root,
      "bump aaa (healthy), bbb (missing-section), ccc (blank-section) to 2.0.0",
    );
    const { code, stdout, stderr } = await runGate(
      ["--mode", "validate", "--root", root, "--cap", "4900"],
      { env: { EVENT: "push", PUSH_BEFORE: base, PR_BASE_SHA: "" } },
    );
    assertEquals(code, 1);
    assert(stdout.length === 0);
    const errorCount = (stderr.match(/::error/g) ?? []).length;
    assertEquals(
      errorCount,
      2,
      `expected exactly 2 ::error annotations (bbb + ccc), got ${errorCount}: ${
        JSON.stringify(stderr)
      }`,
    );
    assert(
      stderr.includes("bbb") && stderr.includes("missing-section"),
      `expected an ::error naming bbb and missing-section, got: ${stderr}`,
    );
    assert(
      stderr.includes("ccc") && stderr.includes("blank-section"),
      `expected an ::error naming ccc and blank-section, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

// --- the same five verdicts, through --manifests-from (the publish job's --
// --- pre-flight — no git at all, just the TSV list the detect step made) --

Deno.test("CLI --manifests-from: a record whose section is missing exits non-zero, WITHOUT printing the 'validated' success line (mutation: classify but never set the exit code -> reddens; mutation: print 'validated N manifests' alongside the ::error -> reddens on the stdout assertion, since that would let step 5(e)'s count parse succeed over an unvalidated set)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkge", "@fixture/pkge", "2026.01.01.1");
    await writeChangelogFile(root, "pkge", "0.9.0", "Old section only.");
    await commitAll(root, "seed pkge — CHANGELOG has no 2026.01.01.1 section");
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "pkge/manifest.yaml\t2026.01.01.1\n" },
    );
    assert(code !== 0, "a manifest with a missing section must fail closed");
    assert(
      !stdout.includes("validated"),
      `a failed pre-flight must never print the success line, got stdout: ${stdout}`,
    );
    assert(
      stderr.includes("::error") && stderr.includes("missing-section"),
      `expected an ::error naming missing-section, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: a record whose section is over cap exits non-zero, WITHOUT printing the 'validated' success line, and the ::error annotation never echoes the section body (mutation: append a section-body excerpt to the ::error line -> reddens; twin of the --mode validate over-cap fixture above, over the credentialed --manifests-from path)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkgd", "@fixture/pkgd", "2026.01.01.1");
    await writeChangelogFile(
      root,
      "pkgd",
      "2026.01.01.1",
      "::stop-commands::x\n".repeat(300),
    );
    await commitAll(root, "seed pkgd with an oversized hostile section");
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "pkgd/manifest.yaml\t2026.01.01.1\n" },
    );
    assert(code !== 0, "an over-cap manifest must fail closed");
    assert(
      !stdout.includes("validated"),
      `a failed pre-flight must never print the success line, got stdout: ${stdout}`,
    );
    assert(stderr.includes("::error") && stderr.includes("over-cap"));
    assert(
      !stderr.includes("::stop-commands"),
      `the ::error annotation must never echo the section body, got stderr: ${
        JSON.stringify(stderr)
      }`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: a record whose section is blank exits non-zero, WITHOUT printing the 'validated' success line", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkgd", "@fixture/pkgd", "2026.01.01.1");
    await Deno.writeTextFile(
      join(root, "pkgd", "CHANGELOG.md"),
      "# Changelog\n\n## 2026.01.01.1\n\n   \n",
    );
    await commitAll(root, "seed pkgd with a blank section");
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "pkgd/manifest.yaml\t2026.01.01.1\n" },
    );
    assert(code !== 0, "a blank-section manifest must fail closed");
    assert(!stdout.includes("validated"));
    assert(stderr.includes("::error") && stderr.includes("blank-section"));
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: a record whose heading is duplicated exits non-zero, WITHOUT printing the 'validated' success line", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkgd", "@fixture/pkgd", "2026.01.01.1");
    await Deno.writeTextFile(
      join(root, "pkgd", "CHANGELOG.md"),
      "# Changelog\n\n## 2026.01.01.1\n\n- first\n\n## 2026.01.01.1\n\n- second\n",
    );
    await commitAll(root, "seed pkgd with a duplicated heading");
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "pkgd/manifest.yaml\t2026.01.01.1\n" },
    );
    assert(code !== 0, "a duplicate-heading manifest must fail closed");
    assert(!stdout.includes("validated"));
    assert(stderr.includes("::error") && stderr.includes("duplicate-heading"));
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: a record whose extension has NO CHANGELOG.md exits non-zero, WITHOUT printing the 'validated' success line", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkgd", "@fixture/pkgd", "2026.01.01.1");
    // deliberately no writeChangelogFile call — CHANGELOG.md never exists
    await commitAll(root, "seed pkgd with no CHANGELOG.md at all");
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "pkgd/manifest.yaml\t2026.01.01.1\n" },
    );
    assert(code !== 0, "a missing-file manifest must fail closed");
    assert(!stdout.includes("validated"));
    assert(stderr.includes("::error") && stderr.includes("missing-file"));
  } finally {
    await cleanup(root);
  }
});

Deno.test('CLI --manifests-from: a healthy record prints EXACTLY "validated 1 manifests\\n" on stdout and exits 0 (step 5(e)\'s wire contract — parsed with a strict line-1-only sed, so the wording and the count must be exact)', async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkgd", "@fixture/pkgd", "2026.01.01.1");
    await writeChangelogFile(
      root,
      "pkgd",
      "2026.01.01.1",
      "Healthy release notes.",
    );
    await commitAll(root, "seed pkgd");
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "pkgd/manifest.yaml\t2026.01.01.1\n" },
    );
    assertEquals(code, 0);
    assertEquals(stdout, "validated 1 manifests\n");
    assertEquals(stderr, "");
  } finally {
    await cleanup(root);
  }
});

Deno.test('CLI --manifests-from: TWO healthy records print EXACTLY "validated 2 manifests\\n" — pins the count, not just the singular wording', async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Notes A.");
    await writeManifestFile(root, "pkgb", "@fixture/pkgb", "2.0.0");
    await writeChangelogFile(root, "pkgb", "2.0.0", "Notes B.");
    await commitAll(root, "seed pkga + pkgb");
    const { code, stdout } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      { stdin: "pkga/manifest.yaml\t1.0.0\npkgb/manifest.yaml\t2.0.0\n" },
    );
    assertEquals(code, 0);
    assertEquals(stdout, "validated 2 manifests\n");
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: TWO records where the SECOND is broken exits non-zero naming the second record, not just the first (mutation: first-record-only, classifying only selected[0] and then printing 'validated N manifests' regardless -> reddens; a multi-record TSV is the normal shape of step 5(e)'s pre-flight, not a hypothesis, and the only existing multi-record fixture in this file was the all-healthy pair above, byte-identical between a correct implementation and this mutant)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkgd", "@fixture/pkgd", "2026.01.01.1");
    await writeChangelogFile(
      root,
      "pkgd",
      "2026.01.01.1",
      "Healthy release notes.",
    );
    await writeManifestFile(root, "pkge", "@fixture/pkge", "2026.01.01.1");
    await writeChangelogFile(root, "pkge", "0.9.0", "Old section only.");
    await commitAll(
      root,
      "seed pkgd (healthy) and pkge — CHANGELOG has no 2026.01.01.1 section",
    );
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      {
        stdin:
          "pkgd/manifest.yaml\t2026.01.01.1\npkge/manifest.yaml\t2026.01.01.1\n",
      },
    );
    assert(
      code !== 0,
      "a batch with the SECOND record broken must fail closed",
    );
    assert(
      !stdout.includes("validated"),
      `a failed pre-flight must never print the success line, got stdout: ${stdout}`,
    );
    assert(
      stderr.includes("::error") && stderr.includes("pkge") &&
        stderr.includes("missing-section"),
      `expected an ::error naming pkge and missing-section, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: THREE records with the BROKEN one in the MIDDLE exits non-zero naming it, not just first-or-last (mutation: first-record-only -> reddens for the same reason as the two-record case above, plus rules out a narrower 'only the first and last are ever classified' variant)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "pkga", "@fixture/pkga", "1.0.0");
    await writeChangelogFile(root, "pkga", "1.0.0", "Notes A.");
    await writeManifestFile(root, "pkgb", "@fixture/pkgb", "1.0.0");
    // deliberately no writeChangelogFile call for pkgb — no CHANGELOG.md at all
    await writeManifestFile(root, "pkgc", "@fixture/pkgc", "1.0.0");
    await writeChangelogFile(root, "pkgc", "1.0.0", "Notes C.");
    await commitAll(root, "seed pkga + pkgb (no changelog) + pkgc");
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      {
        stdin:
          "pkga/manifest.yaml\t1.0.0\npkgb/manifest.yaml\t1.0.0\npkgc/manifest.yaml\t1.0.0\n",
      },
    );
    assert(
      code !== 0,
      "a batch with the MIDDLE record broken must fail closed",
    );
    assert(!stdout.includes("validated"));
    assert(
      stderr.includes("::error") && stderr.includes("pkgb") &&
        stderr.includes("missing-file"),
      `expected an ::error naming pkgb and missing-file, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("CLI --manifests-from: THREE records where the LAST TWO are broken in DIFFERENT ways exits non-zero naming BOTH, not just the first one hit (mutation: classify-first-record-only — insert `break;` immediately after the `annotations.push(...)` call in classifyRecords's loop -> reddens on the annotation COUNT; this is --manifests-from's own version of the --mode validate fixture above — the pre-flight in the credentialed extension-publish job is exactly where a silently-dropped second violation matters most, since the job's own `ok` flag would still (correctly) fail closed while under-reporting which packages actually broke)", async () => {
  const root = await initRepo();
  try {
    await writeManifestFile(root, "aaa", "@fixture/aaa", "1.0.0");
    await writeChangelogFile(root, "aaa", "1.0.0", "Notes A.");
    await writeManifestFile(root, "bbb", "@fixture/bbb", "1.0.0");
    // deliberately no writeChangelogFile call for bbb -> missing-file
    await writeManifestFile(root, "ccc", "@fixture/ccc", "1.0.0");
    await Deno.writeTextFile(
      join(root, "ccc", "CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0\n\n   \n",
    ); // blank-section
    await commitAll(
      root,
      "seed aaa + bbb (no changelog) + ccc (blank section)",
    );
    const { code, stdout, stderr } = await runGate(
      ["--manifests-from", "-", "--cap", "4900", "--root", root],
      {
        stdin:
          "aaa/manifest.yaml\t1.0.0\nbbb/manifest.yaml\t1.0.0\nccc/manifest.yaml\t1.0.0\n",
      },
    );
    assert(
      code !== 0,
      "a batch with the LAST TWO records broken must fail closed",
    );
    assert(!stdout.includes("validated"));
    const errorCount = (stderr.match(/::error/g) ?? []).length;
    assertEquals(
      errorCount,
      2,
      `expected exactly 2 ::error annotations (bbb + ccc), got ${errorCount}: ${
        JSON.stringify(stderr)
      }`,
    );
    assert(
      stderr.includes("bbb") && stderr.includes("missing-file"),
      `expected an ::error naming bbb and missing-file, got: ${stderr}`,
    );
    assert(
      stderr.includes("ccc") && stderr.includes("blank-section"),
      `expected an ::error naming ccc and blank-section, got: ${stderr}`,
    );
  } finally {
    await cleanup(root);
  }
});

// ============================================================================
// H. ci.yml PARITY — reads the REAL ci.yml, in the style of
// scripts/quality/extensions.test.ts:59, which already re-derives the
// discover job's bash glob from disk and asserts equality with the TS
// function. Every baseline count below was re-measured on the worktree at
// 3fa5947 (plan v4 summary + step 6(c)/13(l)).
// ============================================================================

function dropCommentLines(text: string): string[] {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("#"));
}

function leadingSpaces(line: string): number {
  const m = /^ */.exec(line);
  return m ? m[0].length : 0;
}

/**
 * Every line living inside a `run:` shell body, block or inline, over an
 * already comment-stripped line array — mirrors plan v4 step 6(c)'s extent
 * rule EXACTLY: a `run:` key whose value begins with `|` or `>` opens a
 * BLOCK body that ends at the first non-blank line whose indentation is AT
 * OR BELOW the `run:` key's own indentation (blank lines never end it); a
 * `run:` key with an INLINE value is itself a one-line shell body. Ending a
 * block at "the next `- ` list item" instead is WRONG and would swallow the
 * FOLLOWING step's `env:` lines, which legitimately hold Actions-expression
 * sigils after plan v4 step 5 — see the synthetic regression test below.
 */
function runBodyLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  const runKey = /^(\s*)run:\s?(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = runKey.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const value = m[2];
    const isBlock = /^[|>][+-]?\s*$/.test(value);
    if (!isBlock) {
      out.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() !== "" && leadingSpaces(line) <= indent) break;
      out.push(line);
      j++;
    }
  }
  return out;
}

function countNeedle(lines: readonly string[], needle: string): number {
  return lines.filter((l) => l.includes(needle)).length;
}

function jobBodyLines(lines: readonly string[], jobKey: string): string[] {
  const startIdx = lines.findIndex((l) => l === `  ${jobKey}:`);
  if (startIdx === -1) {
    throw new Error(`job '${jobKey}:' not found in ci.yml`);
  }
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break; // next top-level job key
    out.push(lines[i]);
  }
  return out;
}

Deno.test("runBodyLines extent rule (synthetic): a BLOCK run: body ends at the next line whose indentation is at or below the run: key's own — it must NOT swallow the FOLLOWING step's env: block, and it must catch a single-line INLINE run: sigil too", () => {
  const yaml = [
    "      - name: step one",
    "        run: |",
    "          echo hello",
    "          echo world",
    "      - name: step two",
    "        env:",
    "          X: ${{ secrets.SOMETHING }}",
    '        run: deno fmt --check "${{ matrix.pair.skill }}"',
  ];
  const body = runBodyLines(yaml);
  assert(body.includes("          echo hello"));
  assert(body.includes("          echo world"));
  assert(
    !body.some((l) => l.includes("X: ${{ secrets.SOMETHING }}")),
    "the block body must not swallow the FOLLOWING step's env: line",
  );
  assert(
    body.some((l) =>
      l.includes('run: deno fmt --check "${{ matrix.pair.skill }}"')
    ),
    "a single-line INLINE run: is itself a one-line shell body and must be included",
  );
});

Deno.test("ci.yml PARITY: '+version:' appears ZERO times outside comments (mutation: reintroduce a bash grep -qE '^\\+version:' in either job -> reddens; measured baseline today: 2, at ci.yml:270 and :596 — a raw grep over the whole file returns 3 because the concurrency docblock at :14 mentions it in prose, which dropCommentLines excludes)", async () => {
  const lines = dropCommentLines(await Deno.readTextFile(CI_YML));
  assertEquals(countNeedle(lines, "+version:"), 0);
});

Deno.test("ci.yml PARITY: 'changelog-section.sh' appears exactly ONCE as code — the publish loop's --release-notes extraction; the guard now calls the shared gate instead of the extractor directly (measured baseline today: 2 code occurrences at :275 and :664, plus one inside a comment at :658 which dropCommentLines excludes)", async () => {
  const lines = dropCommentLines(await Deno.readTextFile(CI_YML));
  assertEquals(countNeedle(lines, "changelog-section.sh"), 1);
});

Deno.test("ci.yml PARITY: 'wc -c' appears ZERO times — the guard's own byte count now lives in release_notes_gate.ts (measured baseline today: 1, at ci.yml:280)", async () => {
  const lines = dropCommentLines(await Deno.readTextFile(CI_YML));
  assertEquals(countNeedle(lines, "wc -c"), 0);
});

Deno.test("ci.yml PARITY: 'head -c' appears ZERO times — nothing truncates release notes anymore (measured baseline today: 2, at ci.yml:650 and :665)", async () => {
  const lines = dropCommentLines(await Deno.readTextFile(CI_YML));
  assertEquals(countNeedle(lines, "head -c"), 0);
});

Deno.test("ci.yml PARITY: the exact needle grep -m1 '^version:' \"$manifest\" appears ZERO times — the SECOND manifest-version reader is gone, not the surviving one at ci.yml:191 which reads a literal manifest.yaml path (measured baseline today: 2, at :272 and :655)", async () => {
  const lines = dropCommentLines(await Deno.readTextFile(CI_YML));
  assertEquals(countNeedle(lines, `grep -m1 '^version:' "$manifest"`), 0);
});

Deno.test("ci.yml PARITY: 'release-notes-gate' appears inside the RUN: BODY of the release-notes-cap job, and BOTH the '--mode list' and '--manifests-from' invocations appear inside the RUN: BODY of the extension-publish job — scoped with runBodyLines(jobBodyLines(...)), not the raw job body, so a reworded step name: or env: line can never satisfy this on its own (measured baseline today: cap job's run: body carries 'release-notes-gate' once at ci.yml:247 [inline run:]; publish job's run: bodies carry '--mode list' once at ci.yml:564 and '--manifests-from' once at ci.yml:582, both inside literal block run: | bodies. Two needles, not one, so reverting EITHER call alone — e.g. only the detect step back to the old `git diff --name-only HEAD~1 HEAD` selector, leaving the pre-flight call untouched — cannot hide behind the other call still being present; mutation: strip all three real invocations while adding the hyphenated needle to unrelated step name: lines -> reddens, since name: lines are outside runBodyLines' scan; mutation: revert only ci.yml:564's detect step to the old HEAD~1 selector -> reddens on the '--mode list' needle even though '--manifests-from' at :582 is untouched)", async () => {
  const lines = dropCommentLines(await Deno.readTextFile(CI_YML));
  const capRunBody = runBodyLines(jobBodyLines(lines, "release-notes-cap"));
  const publishRunBody = runBodyLines(jobBodyLines(lines, "extension-publish"));
  assert(
    countNeedle(capRunBody, "release-notes-gate") >= 1,
    "release-notes-cap job's run: body must invoke release-notes-gate",
  );
  assert(
    countNeedle(publishRunBody, "release-notes-gate --mode list") >= 1,
    "extension-publish job's run: body must invoke release-notes-gate --mode list (the detect step)",
  );
  assert(
    countNeedle(publishRunBody, "release-notes-gate --manifests-from") >= 1,
    "extension-publish job's run: body must invoke release-notes-gate --manifests-from (the pre-flight step)",
  );
});

Deno.test("ci.yml PARITY: NO line of any run: SHELL BODY contains an Actions-expression sigil, over the WHOLE file (mutation: put an expression back into a block run: body -> reddens; mutation: add a single-line run: carrying a sigil -> reddens — both required, since ci.yml:419 is the one INLINE site and a block-only scan would miss it; measured baseline today: 4 sites / 5 lines — 204, 419, 439, 440, 690)", async () => {
  const lines = dropCommentLines(await Deno.readTextFile(CI_YML));
  const body = runBodyLines(lines);
  const offending = body.filter((l) => l.includes("${{"));
  assertEquals(
    offending,
    [],
    `Actions expression sigil found inside a run: shell body: ${
      JSON.stringify(offending)
    }`,
  );
});
