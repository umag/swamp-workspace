/**
 * SoakTaskGenerator domain service: derives the canonical `test:soak` deno.json
 * task string for an extension from the EXACT SAME single source of truth the
 * nightly soak already uses (scripts/soak_schedule.ts's resolveDenoArgs, which
 * itself defers to scripts/lib/soak_permissions.ts's deriveSoakArgsFromTestTask
 * whenever no narrowed quality.yaml `soak:` override exists). Nothing in this
 * file re-derives a permission set, re-parses a test task's flags, or
 * re-implements the override-vs-derive precedence rule — every one of those is
 * imported. Writing a SECOND copy of that reasoning here would be exactly the
 * failure mode this whole PR (and fix/soak-talm-property-and-classification
 * before it) exists to eliminate: each extension's `deno.json` `test:soak`
 * task has hand-duplicated its `test` task's permission flags since the soak
 * pipeline was introduced, and that duplication had already silently drifted
 * for 5 of 52 extensions (a NotCapable failure the moment a developer actually
 * ran `deno task test:soak` locally) before this generator existed.
 *
 * The defect this closes is specifically the LOCAL entrypoint, not the
 * nightly one: scripts/soak_schedule.ts + scripts/run_soak.ts already resolve
 * the correct permission set for the unattended CI rotation, straight from
 * each extension's own `test` task, every night. `deno task test:soak` is a
 * SEPARATE, hand-authored copy of that same information meant for a developer
 * soaking one extension locally — and hand-authored copies drift. This
 * generator makes `test:soak` a DERIVED artifact instead: run in "check" mode
 * (the default) to report what would change, or `--write` to update
 * `deno.json` in place. scripts/quality/check_soak_parity.ts is the PR-time
 * gate that regenerates every extension's expected `test:soak` and fails the
 * build the moment a hand-edit (or a `test` task change with no matching
 * regeneration) makes the two disagree again.
 *
 * Four things this generator MUST get right — each already caused a real
 * defect in this pipeline before being fixed upstream, and each would
 * reappear here if this module tried to re-derive rather than reuse:
 *
 *   1. Runtime flags (--v8-flags=--expose-gc) carry through, because
 *      deriveSoakArgsFromTestTask (imported via resolveDenoArgs) carries them
 *      — see that module's own docblock for the seanime/seadex heap-pin
 *      regression-test coverage hole this fixes.
 *   2. Run counts are DECLARED, not inferred. `readSoakRuns` reads
 *      quality.yaml's `soak.runs` (see schema.ts) and falls back to
 *      DEFAULT_SOAK_RUNS — it never tries to recover "5000" by parsing an
 *      extension's PREVIOUS test:soak string, which would make a hand-tuned
 *      "this suite is slow" fact silently unrecoverable the moment the
 *      generated string changed for any other reason (e.g. a permission
 *      narrowing).
 *   3. A narrowed `quality.yaml` `soak: { state: present, denoArgs: [...] }`
 *      override (today: swamp-go-brr, stripe-mpp, jscad-cad) is used
 *      VERBATIM by resolveDenoArgs when present, in preference to the
 *      test-task derivation — so the generated `test:soak` matches what the
 *      nightly actually runs, never the extension's own broader `test`
 *      authority.
 *   4. Multiple property-test files (stripe-mpp: three) all pass to ONE
 *      `deno test` invocation, sorted exactly like
 *      scripts/soak_schedule.ts's own discoverPropertyTestFiles — the same
 *      determinism the nightly bucket relies on, and (see
 *      generate_soak_task.test.ts's live-subprocess test) verified to
 *      actually run every file, not just the first.
 */
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { listExtensions } from "./extensions.ts";
import { readTestTask } from "./check_soak.ts";
import {
  discoverPropertyTestFiles,
  resolveDenoArgs,
} from "../soak_schedule.ts";

/** The fast-check iteration count baked into a generated `test:soak` task
 * when neither `quality.yaml` nor its `soak.runs` field says otherwise. */
export const DEFAULT_SOAK_RUNS = 10000;

export interface GeneratedSoakTask {
  readonly extension: string;
  /** Discovered `*_property_test.ts` files, relative to the extension
   * directory, sorted (see discoverFilesByExtension). */
  readonly files: readonly string[];
  /** The resolved deno permission + runtime-flag argv (override or derived —
   * see resolveDenoArgs). */
  readonly denoArgs: readonly string[];
  /** The FC_NUM_RUNS value baked into `task` (declared via quality.yaml
   * `soak.runs`, or DEFAULT_SOAK_RUNS). */
  readonly runs: number;
  /** The full generated `test:soak` deno.json task value. */
  readonly task: string;
}

export type GenerateResult =
  | { readonly ok: true; readonly generated: GeneratedSoakTask }
  | { readonly ok: false; readonly extension: string; readonly reason: string };

/**
 * Every discovered `*_property_test.ts` file, grouped by extension —
 * discoverPropertyTestFiles(root) called exactly ONCE and grouped in memory,
 * so a batch run across every extension (the `--write`-all-extensions CLI
 * path, and check_soak_parity.ts's own full-repo gate) does not re-walk the
 * whole repo tree once per extension. Values are already sorted (the same
 * (extension, file) sort discoverPropertyTestFiles itself applies), so no
 * extra sort is needed here.
 */
export async function discoverFilesByExtension(
  root: string,
): Promise<Map<string, string[]>> {
  const all = await discoverPropertyTestFiles(root);
  const byExtension = new Map<string, string[]>();
  for (const f of all) {
    if (!byExtension.has(f.extension)) byExtension.set(f.extension, []);
    byExtension.get(f.extension)!.push(f.file);
  }
  return byExtension;
}

/**
 * Best-effort read of `<ext>/quality.yaml`'s `soak.runs` field — present on
 * ANY soak state (present/na/backlog; see schema.ts's soak-specific state
 * variants). Falls back to DEFAULT_SOAK_RUNS when quality.yaml is
 * missing/unreadable/malformed, has no `soak:` block, or the block has no
 * `runs` (the common case — today only swamp-go-brr, herdr, jabber, and
 * jscad-stl-slicer declare a non-default value). Never throws: a missing
 * declared run count is a normal, expected outcome, not an error.
 */
export async function readSoakRuns(
  root: string,
  extension: string,
): Promise<number> {
  try {
    const raw = parseYaml(
      await Deno.readTextFile(join(root, extension, "quality.yaml")),
    );
    if (raw && typeof raw === "object") {
      const soak = (raw as Record<string, unknown>).soak;
      if (soak && typeof soak === "object") {
        const runs = (soak as Record<string, unknown>).runs;
        if (typeof runs === "number" && Number.isInteger(runs) && runs > 0) {
          return runs;
        }
      }
    }
  } catch {
    // no quality.yaml, or unreadable/malformed — fall back to the default.
  }
  return DEFAULT_SOAK_RUNS;
}

/** Assembles the final `test:soak` task string: `FC_NUM_RUNS=<runs> deno
 * test <denoArgs...> <files...>` — exactly the shape every hand-authored
 * test:soak task in this repo already uses (see STANDARD.md's `soak:` block
 * section), just generated instead of hand-copied. */
export function formatSoakTask(
  denoArgs: readonly string[],
  files: readonly string[],
  runs: number,
): string {
  return `FC_NUM_RUNS=${runs} deno test ${[...denoArgs, ...files].join(" ")}`;
}

/**
 * Computes the canonical `test:soak` task for `extension`. `filesByExtension`
 * is an optional pre-computed discoverFilesByExtension() result — pass it
 * when generating for many extensions in one process (batch CLI runs,
 * check_soak_parity.ts) to avoid re-walking the repo tree per extension;
 * omitted, this discovers fresh (a single-extension CLI invocation).
 *
 * Returns `{ok: false}`, never throws, for either of the two reasons this
 * generator cannot produce a task at all:
 *   - no `*_property_test.ts` file discovered for this extension (nothing to
 *     soak — not an error, just nothing to generate; see the CLI, which
 *     silently skips these rather than reporting them as violations)
 *   - no `test` task on this extension's own deno.json (a DIFFERENT,
 *     genuinely exceptional condition this gate cannot proceed past — every
 *     extension with a property test is expected to have a working `test`
 *     task already, enforced elsewhere; see check_property_harness.ts's own
 *     docblock for the same assumption)
 */
export async function generateSoakTask(
  root: string,
  extension: string,
  filesByExtension?: ReadonlyMap<string, readonly string[]>,
): Promise<GenerateResult> {
  const files = filesByExtension
    ? (filesByExtension.get(extension) ?? [])
    : ((await discoverFilesByExtension(root)).get(extension) ?? []);
  if (files.length === 0) {
    return {
      ok: false,
      extension,
      reason:
        `no *_property_test.ts file discovered under ${extension}/extensions/models/ ` +
        "— nothing to generate a test:soak task for",
    };
  }
  const testTask = await readTestTask(root, extension);
  if (testTask === null) {
    return {
      ok: false,
      extension,
      reason:
        `${extension}/deno.json has no "test" task — cannot derive a soak ` +
        "permission set without a source of authority",
    };
  }
  const denoArgs = await resolveDenoArgs(root, extension, testTask);
  const runs = await readSoakRuns(root, extension);
  return {
    ok: true,
    generated: {
      extension,
      files,
      denoArgs,
      runs,
      task: formatSoakTask(denoArgs, files, runs),
    },
  };
}

// ============================================================================
// deno.json read/write — TEXT-LEVEL, never a JSON.parse/stringify
// round-trip. Every deno.json in this repo is hand-formatted (some inline
// single-line objects, e.g. stripe-mpp's `"imports": { "zod": "npm:zod@4" }`,
// others multi-line) and re-serializing the WHOLE file through
// JSON.stringify(obj, null, 2) would collapse/expand unrelated keys, produce
// a diff many times larger than the one line that actually changed, and risk
// disagreeing with `deno fmt`'s own JSON formatter (which preserves a
// human's original single-line-vs-multi-line choice per object) — turning a
// one-line permission fix into an unrelated repo-wide reformat. Instead this
// finds/replaces (or inserts, right after the "test" line) exactly the
// "test:soak" line's text, byte-identical everywhere else.
// ============================================================================

/** Matches a `"test:soak": "<value>"` line (any leading indent, optional
 * trailing comma) — group 1 is the indent, group 2 the trailing comma (or
 * ""). The value itself is re-derived via JSON.parse on the matched literal
 * rather than captured piecemeal, so real JSON string escaping (unlikely in
 * a permission-flag string, but never assumed) round-trips correctly. */
const TEST_SOAK_LINE = /^(\s*)"test:soak"\s*:\s*("(?:[^"\\]|\\.)*")(,?)\s*$/;

/** Matches the `"test"` task line ITSELF — not "test:soak", "test:live", or
 * any other test-prefixed key — so a missing test:soak entry is always
 * inserted directly after the real source-of-authority line. */
const TEST_LINE = /^(\s*)"test"\s*:\s*("(?:[^"\\]|\\.)*")(,?)\s*$/;

export interface UpsertResult {
  readonly content: string;
  /** The previous test:soak value, or `null` if the key did not exist at all
   * (an insertion, not a replacement). */
  readonly previous: string | null;
}

/**
 * Pure text transform: replaces an existing `"test:soak"` line's value, or —
 * if none exists — inserts a new `"test:soak": "<task>",` line immediately
 * after the `"test"` line, matching its indentation. Every other line is
 * returned byte-identical. Throws only if `raw` has no `"test"` line at all
 * AND no existing `"test:soak"` line to replace (callers only ever invoke
 * this after generateSoakTask has already confirmed a `test` task exists —
 * this is therefore an assertion of that precondition, not a normal runtime
 * outcome to handle gracefully).
 */
export function upsertTestSoakLine(raw: string, task: string): UpsertResult {
  const lines = raw.split("\n");
  const jsonValue = JSON.stringify(task);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TEST_SOAK_LINE);
    if (m) {
      const [, indent, oldValueLiteral, comma] = m;
      const previous = JSON.parse(oldValueLiteral) as string;
      lines[i] = `${indent}"test:soak": ${jsonValue}${comma}`;
      return { content: lines.join("\n"), previous };
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TEST_LINE);
    if (m) {
      const [, indent, , comma] = m;
      // The "test" line must itself already end with a comma (every current
      // deno.json in this repo has at least "fmt"/"lint" tasks after
      // "test") — if it somehow doesn't, add one so the inserted line
      // doesn't produce invalid JSON.
      if (!comma) lines[i] = `${lines[i]},`;
      lines.splice(i + 1, 0, `${indent}"test:soak": ${jsonValue},`);
      return { content: lines.join("\n"), previous: null };
    }
  }

  throw new Error(
    'upsertTestSoakLine: no "test" or "test:soak" line found in the given ' +
      'deno.json text — the caller must confirm a "test" task exists first',
  );
}

/** Best-effort read of `<ext>/deno.json`'s `tasks["test:soak"]` string,
 * PARSED (not text-level — used for comparison, never for writing). `null`
 * when missing/unreadable/absent. */
export async function readActualSoakTask(
  root: string,
  extension: string,
): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(join(root, extension, "deno.json"));
    const json = JSON.parse(raw) as { tasks?: Record<string, unknown> };
    const task = json.tasks?.["test:soak"];
    return typeof task === "string" ? task : null;
  } catch {
    return null;
  }
}

/** Applies `task` to `<ext>/deno.json` in place via upsertTestSoakLine.
 * Returns the previous value (null if the key did not exist). */
export async function writeGeneratedTask(
  root: string,
  extension: string,
  task: string,
): Promise<string | null> {
  const path = join(root, extension, "deno.json");
  const raw = await Deno.readTextFile(path);
  const { content, previous } = upsertTestSoakLine(raw, task);
  if (previous !== task) {
    await Deno.writeTextFile(path, content);
  }
  return previous;
}

// ============================================================================
// CLI entrypoint
// ============================================================================

function printHelp() {
  console.log(
    `generate_soak_task.ts — generate the canonical "test:soak" deno.json task

Usage:
  deno run --allow-read --allow-write scripts/quality/generate_soak_task.ts \\
    [--help] [--json <path>] [--write] [<extension-name>]

Derives each extension's "test:soak" task from the SAME single source of
truth the nightly soak uses (scripts/soak_schedule.ts's resolveDenoArgs /
scripts/lib/soak_permissions.ts's deriveSoakArgsFromTestTask) — runtime
flags (--v8-flags=...) carried through, a narrowed quality.yaml soak:
override honored verbatim when present, multiple property-test files joined
into one deno test invocation, and the FC_NUM_RUNS count taken from
quality.yaml's soak.runs (default 10000).

With no <extension-name>, scans every extension (like the other quality:*
gates' default). Extensions with no *_property_test.ts file are silently
skipped (nothing to soak); an extension WITH a property test but no "test"
task is reported as an error.

Modes:
  (default)  CHECK mode — reports what would change, writes nothing.
  --write    WRITE mode — updates deno.json in place (a text-level
             find/insert of just the "test:soak" line; every other line is
             left byte-identical — see upsertTestSoakLine).

--json <path>  also write {checked, results} as JSON to <path>.

Exit codes:
  0  --write: every targeted extension was written or already matched.
     (default) check mode: every targeted extension already matches.
  1  --write: at least one targeted extension could not be generated (no
     "test" task). check mode: at least one targeted extension differs (or
     could not be generated).
`,
  );
}

interface CliResult {
  readonly extension: string;
  readonly status: "match" | "would-write" | "written" | "error";
  readonly expected?: string;
  readonly actual?: string | null;
  readonly reason?: string;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

if (import.meta.main) {
  const args = Deno.args;
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    Deno.exit(0);
  }
  const write = args.includes("--write");
  const jsonFlagIndex = args.indexOf("--json");
  const jsonPath = jsonFlagIndex >= 0 ? args[jsonFlagIndex + 1] : undefined;
  const only = args.find((a, i) =>
    !a.startsWith("-") && i !== jsonFlagIndex + 1
  );

  if (
    only !== undefined &&
    (!SAFE_NAME.test(only) || only === "." || only === "..")
  ) {
    console.error(
      `error: invalid <extension-name> "${only}" — must match ${SAFE_NAME} ` +
        "(a real extension directory name, no path separators or traversal)",
    );
    Deno.exit(1);
  }

  const root = Deno.env.get("QUALITY_REPO_ROOT") ??
    join(dirname(fromFileUrl(import.meta.url)), "..", "..");

  const targets = only ? [only] : await listExtensions({ root });
  const filesByExtension = await discoverFilesByExtension(root);

  const results: CliResult[] = [];
  let hadError = false;
  let hadDiff = false;

  for (const extension of targets) {
    const generated = await generateSoakTask(root, extension, filesByExtension);
    if (!generated.ok) {
      // Silently skip "nothing to soak" (no property test file) — that is
      // not this generator's problem. A missing "test" task IS reported.
      if (generated.reason.startsWith("no *_property_test.ts file")) continue;
      hadError = true;
      results.push({ extension, status: "error", reason: generated.reason });
      console.log(`${extension}: ERROR — ${generated.reason}`);
      console.log(`::error file=${extension}/deno.json::${generated.reason}`);
      continue;
    }

    const { task } = generated.generated;
    const actual = await readActualSoakTask(root, extension);

    if (actual === task) {
      results.push({ extension, status: "match", expected: task, actual });
      continue;
    }

    hadDiff = true;
    if (write) {
      const previous = await writeGeneratedTask(root, extension, task);
      results.push({
        extension,
        status: "written",
        expected: task,
        actual: previous,
      });
      console.log(
        previous === null
          ? `${extension}: created test:soak`
          : `${extension}: updated test:soak`,
      );
      console.log(`  - ${previous ?? "(none)"}`);
      console.log(`  + ${task}`);
    } else {
      results.push({
        extension,
        status: "would-write",
        expected: task,
        actual,
      });
      console.log(`${extension}: DIFFERS`);
      console.log(`  - ${actual ?? "(none)"}`);
      console.log(`  + ${task}`);
    }
  }

  if (jsonPath) {
    await Deno.writeTextFile(
      jsonPath,
      JSON.stringify({ checked: targets, results }, null, 2),
    );
  }

  const counts = {
    match: results.filter((r) => r.status === "match").length,
    written: results.filter((r) => r.status === "written").length,
    wouldWrite: results.filter((r) => r.status === "would-write").length,
    error: results.filter((r) => r.status === "error").length,
  };
  console.log(
    write
      ? `\n${counts.written} task(s) written, ${counts.match} already ` +
        `matched, ${counts.error} error(s).`
      : `\n${counts.wouldWrite} task(s) differ, ${counts.match} already ` +
        `match, ${counts.error} error(s).`,
  );

  if (hadError || (!write && hadDiff)) {
    Deno.exit(1);
  }
}
