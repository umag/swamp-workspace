/**
 * The runner property-soak.yml's `soak` job invokes IN PLACE of the old
 * hardcoded `deno test --allow-env=FC_NUM_RUNS "<file>"` line. Takes the
 * exact deno permission argv scripts/soak_schedule.ts computed for
 * tonight's bucket entry (via `--deno-args-json`) and actually runs it, so
 * the workflow YAML itself never has to embed permission logic.
 *
 * FLAGS ONLY, deliberately: --extension, --file, --deno-args-json, --runs,
 * --help. No ambient-env-driven inputs for the runner's OWN configuration —
 * a dual env+flag design (e.g. also honoring an FC_NUM_RUNS env var set by
 * the caller) would recreate exactly the kind of silent-override bug this
 * whole PR closes (the workflow's hardcoded command silently overriding
 * what each extension's own deno.json test task declares). The one place
 * FC_NUM_RUNS legitimately appears is as an OUTPUT: the runner sets it in
 * the CHILD `deno test` process's environment from `--runs`, for the
 * property test file's own `Deno.env.get("FC_NUM_RUNS")` read.
 *
 * This is the ONLY component in the property-soak permission pipeline that
 * throws — a last-moment backstop for a resolveArgv violation (e.g. an
 * unresolved $HOME) that somehow reaches execution despite check_soak.ts's
 * PR-time gate. Every other module in this pipeline (soak_permissions.ts,
 * soak_schedule.ts, check_soak.ts) RETURNS violations and never throws.
 */
import { join, normalize } from "jsr:@std/path@1";
import { expandHomeTokens, type Violation } from "./lib/soak_permissions.ts";

// ============================================================================
// parseCliArgs — FLAGS ONLY
// ============================================================================

export type ParsedCliArgs =
  | { help: true }
  | {
    help: false;
    extension: string;
    file: string;
    denoArgs: string[];
    /** Set iff --deno-args-json was present but failed to decode to a JSON
     * array (invalid JSON, or valid JSON that isn't an array) — the CLI
     * entrypoint below treats this as a hard argument error rather than
     * silently running with an empty (zero-permission) denoArgs, which used
     * to mask a mangled workflow input as an unrelated NotCapable failure. */
    denoArgsError?: string;
    runs: number;
  };

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }
  let extension = "";
  let file = "";
  let denoArgsJson = "[]";
  let runs = 0;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--extension":
        extension = args[++i] ?? "";
        break;
      case "--file":
        file = args[++i] ?? "";
        break;
      case "--deno-args-json":
        denoArgsJson = args[++i] ?? "[]";
        break;
      case "--runs":
        runs = Number(args[++i] ?? "0");
        break;
    }
  }
  let denoArgs: string[] = [];
  let denoArgsError: string | undefined;
  try {
    const parsedJson: unknown = JSON.parse(denoArgsJson);
    if (Array.isArray(parsedJson)) {
      denoArgs = parsedJson.filter((a): a is string => typeof a === "string");
    } else {
      denoArgsError =
        `must decode to a JSON array of strings, got: ${denoArgsJson}`;
    }
  } catch {
    denoArgsError = `is not valid JSON: ${denoArgsJson}`;
  }
  return { help: false, extension, file, denoArgs, denoArgsError, runs };
}

// ============================================================================
// resolveArgv — ${HOME}/$HOME expansion + appending the target file
// ============================================================================

export interface ResolveArgvResult {
  readonly argv: string[];
  readonly violations: Violation[];
}

/** Expands $HOME/${HOME} in every denoArgs token (the talm-cluster
 * regression: a --deny-write=$HOME/... guard must reach the child process
 * with $HOME actually resolved, never silently emptied) and appends `file`
 * as the final positional argument. */
export function resolveArgv(
  denoArgs: readonly string[],
  file: string,
  home: string | undefined,
): ResolveArgvResult {
  const { expanded, violations } = expandHomeTokens(denoArgs, home);
  return { argv: [...expanded, file], violations };
}

// ============================================================================
// validateWithinRepoRoot — --extension/--file must never escape the repo root
// ============================================================================

export interface RepoRootCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Rejects an absolute path outright, and rejects any relative path that
 * RESOLVES outside `repoRoot` (via `..` segments, with or without a
 * leading `..`) — never trusts the caller's own path shape. */
export function validateWithinRepoRoot(
  repoRoot: string,
  candidate: string,
): RepoRootCheck {
  if (candidate.startsWith("/")) {
    return {
      ok: false,
      reason: `"${candidate}" is an absolute path, not repo-relative`,
    };
  }
  const normalizedRoot = normalize(repoRoot);
  const resolved = normalize(join(repoRoot, candidate));
  if (
    resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + "/")
  ) {
    return {
      ok: false,
      reason: `"${candidate}" resolves outside the repo root (${resolved})`,
    };
  }
  return { ok: true };
}

// ============================================================================
// classifyFailure — 133 -> OOM; AssertionError -> assertion; NotCapable ->
// permission denied; anything else -> unknown
// ============================================================================

// Strips ANSI/VT100 color escape sequences (e.g. "\x1b[31m",
// "\x1b[38;5;245m") — verified live that real `deno test` emits these even
// into a piped, non-tty subprocess (Deno.Command with stdout: "piped"), and
// they land BETWEEN "error" and its colon in deno's own diagnostic line
// (e.g. "error\x1b[0m: NotCapable: ..."), which would otherwise break a
// literal "error: NotCapable:" match. Matching is done against ANSI-stripped
// text so the diagnostic-line check below works whether or not deno emits
// color. \x1b (ESC) below is the literal ANSI escape-sequence lead byte this
// regex exists to strip, not an accident.
// deno-lint-ignore no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/**
 * TRUE iff `text` contains deno's own top-level diagnostic line for an error
 * whose class name is `className` — the line always has the shape
 * "error: <optional parenthetical annotation>ClassName: <message>".
 * Verified live against real `deno test` subprocesses for both the ordinary
 * shape ("error: NotCapable: Requires read access...") and the
 * uncaught/unawaited-promise shape ("error: (in promise) NotCapable:
 * Requires read access...") — hence the "no colon before ClassName" rule
 * (`[^:\n]*`) rather than requiring "error: " immediately followed by
 * ClassName. Matching this exact diagnostic-line shape — never a bare
 * substring anywhere in the combined output — is what lets a property test
 * that legitimately asserts on the string "NotCapable" (e.g.
 * `assertEquals(actual, "NotCapable")`) classify correctly: its failing
 * diff contains the bare word "NotCapable" (verified live: a real
 * assertEquals(actual, "NotCapable") failure's diff line reads
 * "+   NotCapable", never "error: NotCapable:") but its OWN diagnostic line
 * reads "error: AssertionError: Values are not equal." — matched by the
 * "AssertionError" call to this same helper instead. See run_soak.test.ts's
 * "asserts on the literal string NotCapable" tests for the live
 * verification.
 */
function hasDiagnosticLine(text: string, className: string): boolean {
  return new RegExp(`error: [^:\\n]*${className}:`).test(text);
}

/**
 * Classifies a non-zero `deno test` exit from the exit code plus its
 * COMBINED stdout+stderr output. `deno test` writes a failing test's actual
 * detail — the NotCapable permission trace, the AssertionError diff — to
 * STDOUT; only a generic "error: Test failed" summary line goes to stderr.
 * Verified live against a real `deno test` subprocess (see
 * run_soak.test.ts's real-subprocess classification tests): passing stderr
 * alone here misclassifies both a permission failure AND an assertion
 * failure as "unknown" — silently defeating this tool's whole purpose (a red
 * nightly that says why). `text` must therefore be stdout+stderr combined,
 * never stderr alone.
 *
 * Exit code is checked FIRST (133 is an unambiguous OOM-kill signal,
 * independent of any text). Then AssertionError's diagnostic line is
 * checked BEFORE NotCapable's: if the combined output happens to contain
 * both (e.g. multiple failing tests in one file, or — the defect this
 * ordering + the hasDiagnosticLine narrowing together fix — an assertion
 * whose own diff text contains the bare word "NotCapable"), a genuine
 * test-logic failure wins the reported classification. The prior
 * implementation checked a bare `.includes("NotCapable")` FIRST, against
 * the ENTIRE combined output, which misclassified an ordinary
 * `assertEquals(actual, "NotCapable")` failure as a permission failure —
 * exactly the misdiagnosis this whole tool exists to prevent (verified
 * live).
 */
export function classifyFailure(code: number, text: string): string {
  if (code === 133) return "out of memory";
  const stripped = text.replace(ANSI_ESCAPE, "");
  if (hasDiagnosticLine(stripped, "AssertionError")) return "assertion";
  if (hasDiagnosticLine(stripped, "NotCapable")) return "permission denied";
  return "unknown";
}

// ============================================================================
// formatEffectiveCommand — pins the copy-paste-affordance format exactly
// ============================================================================

export interface EffectiveCommandOpts {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly argv: string[];
}

export function formatEffectiveCommand(opts: EffectiveCommandOpts): string {
  const envPrefix = Object.entries(opts.env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `cd ${opts.cwd} && ${envPrefix} deno test ${opts.argv.join(" ")}`;
}

// ============================================================================
// formatFailureAnnotation — the exact ::error title=soak-failure:: line
// ============================================================================

export function formatFailureAnnotation(
  extension: string,
  file: string,
  classification: string,
): string {
  return `::error title=soak-failure::${extension} ${file}: ${classification}`;
}

// ============================================================================
// executeSoak — injectable CommandRunner (offline, no real subprocess),
// mirroring score_ratchet.ts's readScoreViaSwamp injection pattern.
// ============================================================================

export interface SoakTarget {
  readonly extension: string;
  readonly file: string;
  readonly denoArgs: string[];
  readonly runs: number;
}

export type CommandRunner = (
  cmd: string,
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SoakDeps {
  readonly repoRoot: string;
  readonly home: string | undefined;
  readonly run: CommandRunner;
}

export interface SoakExecutionResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly classification: string | null;
  readonly argv: string[];
  readonly effectiveCommand: string;
}

/** Resolves argv, prints the effective command, runs it via the injected
 * `run`, and classifies a non-zero exit. Throws ONLY when resolveArgv
 * itself reports a violation (an unresolved $HOME — see the module
 * docblock's "last-moment backstop" note); every other outcome, including a
 * failing child process, is returned, never thrown. */
export async function executeSoak(
  target: SoakTarget,
  deps: SoakDeps,
): Promise<SoakExecutionResult> {
  const { argv, violations } = resolveArgv(
    target.denoArgs,
    target.file,
    deps.home,
  );
  if (violations.length > 0) {
    throw new Error(
      `run_soak.ts: refusing to run — ${
        violations.map((v) => v.what).join("; ")
      }`,
    );
  }
  const env = { FC_NUM_RUNS: String(target.runs) };
  const cwd = join(deps.repoRoot, target.extension);
  const effectiveCommand = formatEffectiveCommand({
    cwd: target.extension,
    env,
    argv,
  });
  console.log(effectiveCommand);
  const { code, stdout, stderr } = await deps.run("deno", ["test", ...argv], {
    cwd,
    env,
  });
  // classifyFailure needs stdout+stderr COMBINED — deno test writes a
  // failing test's actual NotCapable/AssertionError detail to stdout, not
  // stderr (see classifyFailure's docblock).
  const classification = code === 0
    ? null
    : classifyFailure(code, `${stdout}\n${stderr}`);
  return { code, stdout, stderr, classification, argv, effectiveCommand };
}

// ============================================================================
// CLI entrypoint
// ============================================================================

async function realCommandRunner(
  cmd: string,
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(cmd, {
    args: argv,
    cwd: opts.cwd,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

function printHelp() {
  console.log(
    `run_soak.ts — run one property test file's nightly soak under its resolved deno permission set

Usage:
  deno run --allow-read --allow-write --allow-run --allow-env run_soak.ts \\
    --extension <name> --file <path> --deno-args-json <json> --runs <n> [--help]

FLAGS ONLY — no ambient-env-driven inputs for the runner's own
configuration (a workflow silently overriding what each extension's own
deno.json test task declares is exactly the bug this tool closes). The
only place FC_NUM_RUNS legitimately appears is as an OUTPUT: set in the
CHILD deno test process's environment from --runs.

Flags:
  --extension <name>     REQUIRED. Repo-relative extension directory name
                          (e.g. "stripe-mpp"). Must not escape the repo root.
  --file <path>           REQUIRED. Property test file path, relative to
                          <extension>/ (e.g.
                          "extensions/models/foo_property_test.ts"). Must
                          not escape the extension directory.
  --deno-args-json <json> REQUIRED. A JSON-encoded array of strings — the
                          exact deno permission flags to run the property
                          test with (soak_schedule.ts's denoArgsJson output
                          shape), e.g. '["--allow-read","--allow-env=FC_NUM_RUNS"]'.
                          Defaults to "[]" (no permissions) if omitted.
  --runs <n>              The fast-check iteration count — set as
                          FC_NUM_RUNS in the CHILD deno test process's
                          environment only, never read from this process's
                          own ambient environment. Defaults to 0 if omitted.
  --help, -h              Print this message and exit 0.

Prints the effective "cd <ext> && FC_NUM_RUNS=<n> deno test <argv...>"
command before executing it. Classifies a non-zero exit from the exit code
+ combined stdout/stderr (deno test writes a failing test's NotCapable/
AssertionError detail to STDOUT, not stderr — 133 -> "out of memory", an
AssertionError diagnostic line -> "assertion", a NotCapable diagnostic line
-> "permission denied" (checked in that order, so an assertion that merely
asserts on the string "NotCapable" is never misclassified as a permission
failure), else "unknown") and emits a matching
"::error title=soak-failure::<ext> <file>: <class>" annotation.

Rejects an --extension/--file that escapes the repo root (Deno.cwd() at
invocation time — run this from the repo root), that is missing/empty, or a
--deno-args-json that isn't a JSON-encoded array of strings.

Exit codes:
  0  the soaked deno test process exited 0
  1  a CLI/argument error (missing/empty --extension or --file, an
     --extension/--file that escapes the repo root, a malformed
     --deno-args-json, etc.)
  <n>  otherwise, the soaked deno test process's own exit code, propagated as-is
`,
  );
}

if (import.meta.main) {
  const parsed = parseCliArgs(Deno.args);
  if (parsed.help) {
    printHelp();
    Deno.exit(0);
  }

  if (!parsed.extension) {
    console.log(
      "::error::--extension is required (repo-relative extension directory name)",
    );
    Deno.exit(1);
  }
  if (!parsed.file) {
    console.log(
      "::error::--file is required (property test file path, relative to --extension)",
    );
    Deno.exit(1);
  }
  if (parsed.denoArgsError) {
    console.log(`::error::--deno-args-json ${parsed.denoArgsError}`);
    Deno.exit(1);
  }

  const repoRoot = Deno.cwd();

  const extCheck = validateWithinRepoRoot(repoRoot, parsed.extension);
  if (!extCheck.ok) {
    console.log(`::error::--extension ${extCheck.reason}`);
    Deno.exit(1);
  }
  const fileCheck = validateWithinRepoRoot(
    join(repoRoot, parsed.extension),
    parsed.file,
  );
  if (!fileCheck.ok) {
    console.log(`::error::--file ${fileCheck.reason}`);
    Deno.exit(1);
  }

  const result = await executeSoak(
    {
      extension: parsed.extension,
      file: parsed.file,
      denoArgs: parsed.denoArgs,
      runs: parsed.runs,
    },
    { repoRoot, home: Deno.env.get("HOME"), run: realCommandRunner },
  );

  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);

  if (result.code !== 0) {
    console.log(
      formatFailureAnnotation(
        parsed.extension,
        parsed.file,
        result.classification ?? "unknown",
      ),
    );
    Deno.exit(result.code);
  }
}
