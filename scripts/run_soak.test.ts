/**
 * Failing-first (TDD RED) tests for scripts/run_soak.ts (does not exist
 * yet) — the runner property-soak.yml's `soak` job invokes IN PLACE of
 * today's hardcoded `deno test --allow-env=FC_NUM_RUNS "<file>"` line. Takes
 * the exact deno permission argv scripts/soak_schedule.ts computed for
 * tonight's bucket (via `--deno-args-json`) and actually runs it, so the
 * workflow YAML itself never has to embed permission logic.
 *
 * FLAGS ONLY, deliberately: --extension, --file, --deno-args-json, --runs,
 * --help. No ambient-env-driven inputs for the runner's OWN configuration —
 * a dual env+flag design (e.g. also honoring an FC_NUM_RUNS env var set by
 * the caller) would recreate exactly the kind of silent-override bug this
 * whole PR exists to close (the workflow's hardcoded command silently
 * overriding what each extension's own deno.json test task declares). The
 * one place FC_NUM_RUNS legitimately appears is as an OUTPUT: the runner
 * sets it in the CHILD `deno test` process's environment from `--runs`, for
 * the property test file's own `Deno.env.get("FC_NUM_RUNS")` read.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  classifyFailure,
  executeSoak,
  formatEffectiveCommand,
  formatFailureAnnotation,
  parseCliArgs,
  resolveArgv,
  validateWithinRepoRoot,
} from "./run_soak.ts";

// ============================================================================
// parseCliArgs — FLAGS ONLY
// ============================================================================

Deno.test("parseCliArgs: --help is recognized regardless of other flags", () => {
  const parsed = parseCliArgs(["--help"]);
  assertEquals(parsed, { help: true });
});

Deno.test("parseCliArgs: parses --extension/--file/--deno-args-json/--runs into a structured, typed result", () => {
  const parsed = parseCliArgs([
    "--extension",
    "stripe-mpp",
    "--file",
    "extensions/models/stripe_mpp_property_test.ts",
    "--deno-args-json",
    '["--allow-net","--allow-env"]',
    "--runs",
    "1000000",
  ]);
  assert(!parsed.help);
  if (!parsed.help) {
    assertEquals(parsed.extension, "stripe-mpp");
    assertEquals(parsed.file, "extensions/models/stripe_mpp_property_test.ts");
    assertEquals(parsed.denoArgs, ["--allow-net", "--allow-env"]);
    assertEquals(parsed.runs, 1000000);
    assertEquals(parsed.denoArgsError, undefined);
  }
});

Deno.test("parseCliArgs: invalid JSON --deno-args-json is surfaced as denoArgsError, not silently swallowed into an empty array", () => {
  const parsed = parseCliArgs(["--deno-args-json", "not-json"]);
  assert(!parsed.help);
  if (!parsed.help) {
    assertEquals(parsed.denoArgs, []);
    assert(
      typeof parsed.denoArgsError === "string" &&
        parsed.denoArgsError.length > 0,
      `expected a denoArgsError, got: ${JSON.stringify(parsed)}`,
    );
  }
});

Deno.test("parseCliArgs: valid JSON that isn't an array is also surfaced as denoArgsError", () => {
  const parsed = parseCliArgs(["--deno-args-json", '{"not":"an array"}']);
  assert(!parsed.help);
  if (!parsed.help) {
    assertEquals(parsed.denoArgs, []);
    assert(
      typeof parsed.denoArgsError === "string" &&
        parsed.denoArgsError.length > 0,
      `expected a denoArgsError, got: ${JSON.stringify(parsed)}`,
    );
  }
});

Deno.test("parseCliArgs: omitted --deno-args-json defaults to an empty array with NO denoArgsError (default '[]' is valid JSON)", () => {
  const parsed = parseCliArgs(["--extension", "widget"]);
  assert(!parsed.help);
  if (!parsed.help) {
    assertEquals(parsed.denoArgs, []);
    assertEquals(parsed.denoArgsError, undefined);
  }
});

// ============================================================================
// resolveArgv — ${HOME}/$HOME expansion in argv (the talm-cluster
// regression) + appending the target file as the final positional argument.
// ============================================================================

Deno.test("resolveArgv: expands $HOME and \${HOME} in argv verbatim (the talm-cluster regression)", () => {
  const result = resolveArgv(
    [
      "--allow-read",
      "--allow-write",
      "--deny-write=$HOME/.talos,${HOME}/.config/swamp",
      "--allow-env=FC_NUM_RUNS",
    ],
    "extensions/models/talm_cluster_property_test.ts",
    "/Users/mag1",
  );
  assertEquals(result.violations, []);
  assertEquals(result.argv, [
    "--allow-read",
    "--allow-write",
    "--deny-write=/Users/mag1/.talos,/Users/mag1/.config/swamp",
    "--allow-env=FC_NUM_RUNS",
    "extensions/models/talm_cluster_property_test.ts",
  ]);
});

Deno.test("resolveArgv: unset HOME with a $HOME-bearing token is a violation, not a silent empty substitution", () => {
  const result = resolveArgv(
    ["--deny-write=$HOME/.talos"],
    "extensions/models/talm_cluster_property_test.ts",
    undefined,
  );
  assert(result.violations.length > 0, JSON.stringify(result));
});

// ============================================================================
// validateWithinRepoRoot — --extension/--file must never escape the repo root
// ============================================================================

Deno.test("validateWithinRepoRoot: accepts an ordinary in-repo relative path", () => {
  const result = validateWithinRepoRoot("/repo", "stripe-mpp");
  assertEquals(result.ok, true);
});

Deno.test("validateWithinRepoRoot: rejects a path escaping the repo root via ../..", () => {
  const result = validateWithinRepoRoot("/repo", "../../etc/passwd");
  assertEquals(result.ok, false);
});

Deno.test("validateWithinRepoRoot: rejects a path that RESOLVES outside the repo root even without a leading ..", () => {
  const result = validateWithinRepoRoot("/repo", "stripe-mpp/../../../etc");
  assertEquals(result.ok, false);
});

// ============================================================================
// classifyFailure — 133 -> OOM; AssertionError -> assertion; NotCapable ->
// permission denied; anything else -> unknown
//
// UNIT-LEVEL ONLY: these pin classifyFailure's pure string-matching logic
// against a hand-built text blob shaped like deno's REAL diagnostic-line
// output ("error: <ClassName>: <message>", the shape verified live — see
// classifyFailure's docblock). They do NOT prove executeSoak/run_soak.ts
// actually feeds classifyFailure the right STREAM — deno test writes
// NotCapable/AssertionError detail to stdout, not stderr, and a test that
// only ever hand-places the string into whichever param it likes can never
// catch a regression there. See the "REAL `deno test` subprocess
// classification" section further down (run_soak.ts CLI: a REAL
// NotCapable/AssertionError/generic failure ... tests) for the end-to-end
// coverage that actually exercises deno test's real stdout/stderr split.
// ============================================================================

Deno.test("classifyFailure: a real NotCapable diagnostic line in the combined output classifies as 'permission denied'", () => {
  assertEquals(
    classifyFailure(
      1,
      'error: NotCapable: Requires read access to "bots/snake_bot.ts", run again with the --allow-read flag',
    ),
    "permission denied",
  );
});

Deno.test("classifyFailure: exit code 133 classifies as 'out of memory'", () => {
  assertEquals(classifyFailure(133, ""), "out of memory");
});

Deno.test("classifyFailure: a real AssertionError diagnostic line in the combined output classifies as 'assertion'", () => {
  assertEquals(
    classifyFailure(1, "error: AssertionError: Values are not equal."),
    "assertion",
  );
});

// Text shaped exactly like a real fast-check-falsified-property's combined
// output (verified live against the real fast-check@4.8.0 binary — see the
// REAL-subprocess version further down): fast-check throws a bare `Error`
// whose message starts "Property failed after <N> tests", followed by its
// seed/path/Counterexample/Shrunk detail on subsequent lines. This is the
// exact shape the 2026-08-08 nightly emitted for talm-cluster's "-e"
// counterexample (Counterexample: ["-e"], after 87,042 cases) that used to
// fall through classifyFailure to "unknown".
Deno.test("classifyFailure: a real fast-check 'Property failed after N tests' diagnostic line in the combined output classifies as 'property falsified'", () => {
  const text = `error: Error: Property failed after 87042 tests
{ seed: -712593897, path: "87041:9", endOnFailure: true }
Counterexample: ["-e"]
Shrunk 1 time(s)
`;
  assertEquals(classifyFailure(1, text), "property falsified");
});

// The rationale documented on classifyFailure's docblock, pinned as a unit
// test: a property whose predicate calls `assertEquals` internally (common
// in this repo — the property test IS the assertion) fails with BOTH
// fast-check's own "Property failed after <N> tests" top-line AND the
// underlying AssertionError surfaced via Deno's "Caused by:" cause-chain
// rendering (verified live — see fc.assert(fc.property(..., (n) => {
// assertEquals(...) })), the real-subprocess version further down).
// "property falsified" must win — it is the more specific and more
// actionable of the two.
Deno.test("classifyFailure: a falsified property whose predicate uses assertEquals internally (both markers present) still classifies as 'property falsified', never 'assertion'", () => {
  const text = `error: Error: Property failed after 1 tests
{ seed: 2081012751, path: "0:0", endOnFailure: true }
Counterexample: [0]
Shrunk 1 time(s)

Caused by: AssertionError: Values are not equal.


    [Diff] Actual / Expected


-   0
+   1
`;
  assertEquals(classifyFailure(1, text), "property falsified");
});

// The negative case: a property test that legitimately ASSERTS on the
// literal string "Property failed after 1 tests" (a plausible golden-output
// test pinning fast-check's own error message) must NOT be misclassified as
// a falsified property just because that text appears somewhere in the
// combined output. It shows up only inside an ordinary AssertionError diff
// line, never preceded by "error: ...Error:" on the same line (verified
// live — see the REAL-subprocess version of this same scenario further
// down: "run_soak.ts CLI: a REAL AssertionError failure whose diff contains
// the literal string 'Property failed after 1 tests' ...").
Deno.test("classifyFailure: an AssertionError diff containing the literal string 'Property failed after 1 tests' still classifies as 'assertion', never 'property falsified'", () => {
  const text = `error: AssertionError: Values are not equal.


    [Diff] Actual / Expected


-   unrelated
+   Property failed after 1 tests
`;
  assertEquals(classifyFailure(1, text), "assertion");
});

Deno.test("classifyFailure: anything else classifies as 'unknown'", () => {
  assertEquals(
    classifyFailure(1, "some unrelated junk in the output"),
    "unknown",
  );
});

// The MEDIUM finding this pins: a bare `.includes("NotCapable")` check (the
// prior implementation) misclassifies an ORDINARY assertion failure whose
// diff happens to contain the literal string "NotCapable" — a plausible
// shape for a property test asserting on a sentinel/enum value (e.g.
// `assertEquals(actual, "NotCapable")`) — as a permission failure, even
// though the SAME combined output also contains the real
// "error: AssertionError:" diagnostic line. Text shaped exactly like a real
// `deno test` assertEquals(actual, "NotCapable") failure's diff (verified
// live — see the REAL-subprocess version of this same scenario further
// down: "run_soak.ts CLI: a REAL AssertionError failure whose diff contains
// the literal string 'NotCapable' ...").
Deno.test("classifyFailure: an AssertionError diff containing the literal string 'NotCapable' still classifies as 'assertion', never 'permission denied'", () => {
  const text = `error: AssertionError: Values are not equal.


    [Diff] Actual / Expected


-   Capable
+   NotCapable


  throw new AssertionError(message);
`;
  assertEquals(classifyFailure(1, text), "assertion");
});

Deno.test("classifyFailure: strips ANSI color codes before matching a diagnostic line (deno emits color even into a piped, non-tty subprocess)", () => {
  const text =
    '\x1b[1m\x1b[31merror\x1b[0m: NotCapable: Requires read access to "/etc/hosts", run again with the --allow-read flag';
  assertEquals(classifyFailure(1, text), "permission denied");
});

// ============================================================================
// formatEffectiveCommand — pins the copy-paste-affordance format exactly
// ============================================================================

Deno.test("formatEffectiveCommand: EXACT format — 'cd <ext> && FC_NUM_RUNS=<n> deno test <argv...>'", () => {
  const formatted = formatEffectiveCommand({
    cwd: "stripe-mpp",
    env: { FC_NUM_RUNS: "1000000" },
    argv: [
      "--allow-net",
      "--allow-env",
      "extensions/models/stripe_mpp_property_test.ts",
    ],
  });
  assertEquals(
    formatted,
    "cd stripe-mpp && FC_NUM_RUNS=1000000 deno test --allow-net --allow-env " +
      "extensions/models/stripe_mpp_property_test.ts",
  );
});

// ============================================================================
// formatFailureAnnotation — the exact ::error title=soak-failure:: line
// ============================================================================

Deno.test("formatFailureAnnotation: EXACT format — '::error title=soak-failure::<ext> <file>: <class>'", () => {
  const formatted = formatFailureAnnotation(
    "flipper-zero",
    "extensions/models/flipper_zero_property_test.ts",
    "permission denied",
  );
  assertEquals(
    formatted,
    "::error title=soak-failure::flipper-zero " +
      "extensions/models/flipper_zero_property_test.ts: permission denied",
  );
});

// ============================================================================
// executeSoak — injectable CommandRunner (offline, no real subprocess),
// mirroring score_ratchet.ts's readScoreViaSwamp injection pattern.
// ============================================================================

/** Local, test-owned shape of the injectable runner — kept independent of
 * run_soak.ts's own (not-yet-existing) CommandRunner export so these
 * callback params can be explicitly typed (never implicit `any`, per this
 * repo's ban) regardless of whether run_soak.ts's own type exports match
 * this exactly; executeSoak's real signature is free to use a structurally
 * compatible type. */
type TestCommandRunner = (
  cmd: string,
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

Deno.test("executeSoak: a non-zero child exit propagates as executeSoak's own non-zero result code", async () => {
  const result = await executeSoak(
    {
      extension: "widget",
      file: "extensions/models/widget_property_test.ts",
      denoArgs: ["--allow-env=FC_NUM_RUNS"],
      runs: 10000,
    },
    {
      repoRoot: "/repo",
      home: "/Users/mag1",
      run: (() =>
        Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "boom",
        })) satisfies TestCommandRunner,
    },
  );
  assertEquals(result.code, 1);
});

Deno.test("executeSoak: exit 0 propagates as code 0 with a null classification", async () => {
  const result = await executeSoak(
    {
      extension: "widget",
      file: "extensions/models/widget_property_test.ts",
      denoArgs: ["--allow-env=FC_NUM_RUNS"],
      runs: 10000,
    },
    {
      repoRoot: "/repo",
      home: "/Users/mag1",
      run: (() =>
        Promise.resolve({
          code: 0,
          stdout: "",
          stderr: "",
        })) satisfies TestCommandRunner,
    },
  );
  assertEquals(result.code, 0);
  assertEquals(result.classification, null);
});

Deno.test("executeSoak: --runs reaches the child's FC_NUM_RUNS env var INTACT — 1000000 arrives as 1000000, not truncated/coerced", async () => {
  let capturedEnv: Record<string, string> | undefined;
  await executeSoak(
    {
      extension: "stripe-mpp",
      file: "extensions/models/stripe_mpp_property_test.ts",
      denoArgs: ["--allow-net", "--allow-env"],
      runs: 1000000,
    },
    {
      repoRoot: "/repo",
      home: "/Users/mag1",
      run: ((
        _cmd: string,
        _argv: string[],
        opts: { cwd: string; env: Record<string, string> },
      ) => {
        capturedEnv = opts.env;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }) satisfies TestCommandRunner,
    },
  );
  assert(capturedEnv, "run() was never invoked");
  assertEquals(capturedEnv!.FC_NUM_RUNS, "1000000");
});

Deno.test("executeSoak: FC_NUM_RUNS in the child env comes ONLY from --runs, never from the parent's own ambient environment", async () => {
  const previous = Deno.env.get("FC_NUM_RUNS");
  Deno.env.set("FC_NUM_RUNS", "42"); // a decoy ambient value --runs must NOT leak through
  try {
    let capturedEnv: Record<string, string> | undefined;
    await executeSoak(
      {
        extension: "stripe-mpp",
        file: "extensions/models/stripe_mpp_property_test.ts",
        denoArgs: ["--allow-net", "--allow-env"],
        runs: 1000000,
      },
      {
        repoRoot: "/repo",
        home: "/Users/mag1",
        run: ((
          _cmd: string,
          _argv: string[],
          opts: { cwd: string; env: Record<string, string> },
        ) => {
          capturedEnv = opts.env;
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }) satisfies TestCommandRunner,
      },
    );
    assertEquals(capturedEnv!.FC_NUM_RUNS, "1000000");
  } finally {
    if (previous === undefined) Deno.env.delete("FC_NUM_RUNS");
    else Deno.env.set("FC_NUM_RUNS", previous);
  }
});

Deno.test("executeSoak: wires classifyFailure's result into the returned classification on a NotCapable failure", async () => {
  const result = await executeSoak(
    {
      extension: "flipper-zero",
      file: "extensions/models/flipper_zero_property_test.ts",
      denoArgs: ["--allow-env=FC_NUM_RUNS"],
      runs: 10000,
    },
    {
      repoRoot: "/repo",
      home: "/Users/mag1",
      run: (() =>
        Promise.resolve({
          code: 1,
          stdout: "",
          stderr:
            'error: NotCapable: Requires read access to "bots/snake_bot.ts"',
        })) satisfies TestCommandRunner,
    },
  );
  assertEquals(result.code, 1);
  assertEquals(result.classification, "permission denied");
});

// ============================================================================
// CLI-level, real-subprocess tests — the things only a real Deno.Command
// invocation can prove: argv reaches the child as an ARRAY (never a shell
// string), the effective command is printed before executing, and a failure
// classification actually produces an ::error annotation in real stdout.
//
// A single flexible `deno` shim (on PATH, ahead of the real binary) is
// controlled entirely via env vars passed through Deno.Command's `env` —
// never spliced into a shell string — so these tests stay just as immune to
// injection as the rest of this repo's fake-binary CLI tests
// (score_ratchet.test.ts's fake `swamp` shim is the precedent).
// ============================================================================

async function writeDenoShim(binDir: string): Promise<void> {
  const shimPath = join(binDir, "deno");
  await Deno.writeTextFile(
    shimPath,
    `#!/bin/sh
if [ -n "$CAPTURE_ARGV_FILE" ]; then
  : > "$CAPTURE_ARGV_FILE"
  for a in "$@"; do printf '%s\\n' "$a" >> "$CAPTURE_ARGV_FILE"; done
fi
if [ -n "$SHIM_STDERR" ]; then
  printf '%s' "$SHIM_STDERR" >&2
fi
exit "\${SHIM_EXIT_CODE:-0}"
`,
  );
  await Deno.chmod(shimPath, 0o755);
}

async function writeFixtureExtension(root: string): Promise<void> {
  await Deno.mkdir(`${root}/stripe-mpp/extensions/models`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${root}/stripe-mpp/extensions/models/stripe_mpp_property_test.ts`,
    "",
  );
}

Deno.test("run_soak.ts CLI: argv reaches the child Deno.Command as an ARRAY, never a shell string (a space-bearing token stays ONE element)", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-argv-" });
  const binDir = await Deno.makeTempDir({ prefix: "run-soak-bin-" });
  try {
    await writeFixtureExtension(root);
    await writeDenoShim(binDir);
    const captureFile = join(root, "argv.txt");
    const scriptUrl = new URL("./run_soak.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        scriptUrl.pathname,
        "--extension",
        "stripe-mpp",
        "--file",
        "extensions/models/stripe_mpp_property_test.ts",
        // A single token containing a raw space — if run_soak.ts ever built
        // a shell string instead of an argv array, a real shell would
        // re-split this into two arguments.
        "--deno-args-json",
        '["--allow-read=extensions models","--allow-env"]',
        "--runs",
        "10000",
      ],
      cwd: root,
      env: {
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
        CAPTURE_ARGV_FILE: captureFile,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { stderr } = await cmd.output();
    const captured = (await Deno.readTextFile(captureFile)).split("\n")
      .filter((l) => l.length > 0);
    assert(
      captured.includes("--allow-read=extensions models"),
      `space-bearing token was split by a shell: ${
        JSON.stringify(captured)
      } (stderr: ${new TextDecoder().decode(stderr)})`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(binDir, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: rejects an --extension that escapes the repo root", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-escape-" });
  try {
    await writeFixtureExtension(root);
    const scriptUrl = new URL("./run_soak.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        scriptUrl.pathname,
        "--extension",
        "../../../etc",
        "--file",
        "passwd",
        "--deno-args-json",
        "[]",
        "--runs",
        "10000",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    assert(code !== 0, "expected a non-zero exit for a repo-root escape");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: prints the effective 'deno test ...' command before executing", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-print-" });
  const binDir = await Deno.makeTempDir({ prefix: "run-soak-bin-" });
  try {
    await writeFixtureExtension(root);
    await writeDenoShim(binDir);
    const scriptUrl = new URL("./run_soak.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        scriptUrl.pathname,
        "--extension",
        "stripe-mpp",
        "--file",
        "extensions/models/stripe_mpp_property_test.ts",
        "--deno-args-json",
        '["--allow-net","--allow-env"]',
        "--runs",
        "10000",
      ],
      cwd: root,
      env: { PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}` },
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes(
        "cd stripe-mpp && FC_NUM_RUNS=10000 deno test --allow-net " +
          "--allow-env extensions/models/stripe_mpp_property_test.ts",
      ),
      `expected the effective command to be printed verbatim, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(binDir, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a NotCapable child failure exits non-zero and emits a matching ::error title=soak-failure:: annotation", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-fail-" });
  const binDir = await Deno.makeTempDir({ prefix: "run-soak-bin-" });
  try {
    await writeFixtureExtension(root);
    await writeDenoShim(binDir);
    const scriptUrl = new URL("./run_soak.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        scriptUrl.pathname,
        "--extension",
        "stripe-mpp",
        "--file",
        "extensions/models/stripe_mpp_property_test.ts",
        "--deno-args-json",
        '["--allow-env=FC_NUM_RUNS"]',
        "--runs",
        "10000",
      ],
      cwd: root,
      env: {
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
        SHIM_EXIT_CODE: "1",
        SHIM_STDERR:
          'error: NotCapable: Requires read access to "bots/snake_bot.ts", run again with the --allow-read flag',
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    assert(code !== 0);
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes(
        "::error title=soak-failure::stripe-mpp " +
          "extensions/models/stripe_mpp_property_test.ts: permission denied",
      ),
      `expected a matching ::error annotation, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(binDir, { recursive: true });
  }
});

// ============================================================================
// classifyFailure — REAL `deno test` subprocess classification (the HIGH
// finding this pins). `deno test` writes a failing test's actual detail —
// the NotCapable trace, the AssertionError diff, the fast-check
// counterexample — to STDOUT, not stderr; only a generic "error: Test
// failed" line goes to stderr (verified live, see the fixtures below).
// Every test ABOVE this section injects a stub
// CommandRunner or a shim that hand-places the classification string
// directly into a `stderr` field/env var — none of them can catch a
// regression in classifyFailure reading the wrong stream, because they never
// exercise deno test's REAL stdout/stderr split. These tests run the REAL
// `deno` binary (on PATH, no shim) as run_soak.ts's actual child process,
// against fixture property test files engineered to genuinely fail each
// way — one test per classification class.
// ============================================================================

async function writeRealPropertyTestFixture(
  root: string,
  extension: string,
  fileName: string,
  testBody: string,
): Promise<string> {
  const relFile = `extensions/models/${fileName}`;
  await Deno.mkdir(`${root}/${extension}/extensions/models`, {
    recursive: true,
  });
  await Deno.writeTextFile(`${root}/${extension}/${relFile}`, testBody);
  return relFile;
}

async function runRealSoakCli(
  root: string,
  extension: string,
  file: string,
  denoArgs: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scriptUrl = new URL("./run_soak.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run",
      "--allow-env",
      scriptUrl.pathname,
      "--extension",
      extension,
      "--file",
      file,
      "--deno-args-json",
      JSON.stringify(denoArgs),
      "--runs",
      "10",
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("run_soak.ts CLI: a REAL NotCapable failure (genuine deno test subprocess, zero permissions granted, no shim) classifies as 'permission denied'", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-real-notcap-" });
  try {
    const file = await writeRealPropertyTestFixture(
      root,
      "widget",
      "widget_property_test.ts",
      `Deno.test("reads a file without permission", async () => {
  await Deno.readTextFile("/etc/hosts");
});
`,
    );
    const { code, stdout } = await runRealSoakCli(root, "widget", file, []);
    assert(code !== 0, `expected a non-zero exit, got 0. stdout: ${stdout}`);
    assert(
      stdout.includes(
        `::error title=soak-failure::widget ${file}: permission denied`,
      ),
      `expected a REAL permission-denied classification (NotCapable lives on ` +
        `stdout, not stderr), got: ${stdout}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a REAL AssertionError failure (genuine deno test subprocess, no shim) classifies as 'assertion'", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-real-assert-" });
  try {
    const file = await writeRealPropertyTestFixture(
      root,
      "widget",
      "widget_property_test.ts",
      `import { assertEquals } from "jsr:@std/assert@1";
Deno.test("bad assertion", () => {
  assertEquals(1, 2);
});
`,
    );
    const { code, stdout } = await runRealSoakCli(root, "widget", file, []);
    assert(code !== 0, `expected a non-zero exit, got 0. stdout: ${stdout}`);
    assert(
      stdout.includes(
        `::error title=soak-failure::widget ${file}: assertion`,
      ),
      `expected a REAL assertion classification (AssertionError lives on ` +
        `stdout, not stderr), got: ${stdout}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a REAL AssertionError failure whose diff contains the literal string 'NotCapable' (genuine deno test subprocess, no shim) classifies as 'assertion', never 'permission denied'", async () => {
  // The MEDIUM finding this pins, verified end-to-end against the real
  // `deno` binary (not a hand-built text blob): a property test that
  // legitimately asserts on the sentinel string "NotCapable" — a plausible
  // shape for a property test asserting on an enum/sentinel value — must
  // NOT be misdiagnosed as a permission failure just because its failing
  // diff contains that bare word. The real deno test subprocess's own
  // top-level diagnostic line for this failure is "error: AssertionError:
  // Values are not equal.", never "error: NotCapable:" (see
  // classifyFailure's docblock for why that distinction is what fixes this).
  const root = await Deno.makeTempDir({
    prefix: "run-soak-real-assert-notcap-",
  });
  try {
    const file = await writeRealPropertyTestFixture(
      root,
      "widget",
      "widget_property_test.ts",
      `import { assertEquals } from "jsr:@std/assert@1";
Deno.test("asserts on the literal string NotCapable", () => {
  const actual = "Capable";
  assertEquals(actual, "NotCapable");
});
`,
    );
    const { code, stdout } = await runRealSoakCli(root, "widget", file, []);
    assert(code !== 0, `expected a non-zero exit, got 0. stdout: ${stdout}`);
    assert(
      stdout.includes(
        `::error title=soak-failure::widget ${file}: assertion`,
      ),
      `expected a REAL assertion classification even though the diff ` +
        `contains the literal word "NotCapable", got: ${stdout}`,
    );
    assert(
      !stdout.includes(
        `::error title=soak-failure::widget ${file}: permission denied`,
      ),
      `must NOT misclassify an ordinary assertEquals(actual, "NotCapable") ` +
        `failure as a permission failure, got: ${stdout}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a REAL falsified fast-check property (genuine deno test subprocess, no shim) classifies as 'property falsified'", async () => {
  // The exact defect the 2026-08-08 nightly hit: a genuine fast-check
  // counterexample fell through to "unknown" (see
  // "##[error]talm-cluster extensions/models/talm_cluster_property_test.ts:
  // unknown" in GH run 31239877383). This fixture is the minimal shape that
  // reproduces it — a property that always returns false, no assertEquals
  // involved.
  const root = await Deno.makeTempDir({ prefix: "run-soak-real-property-" });
  try {
    const file = await writeRealPropertyTestFixture(
      root,
      "widget",
      "widget_property_test.ts",
      `import fc from "npm:fast-check@4.8.0";
Deno.test("property that always fails", () => {
  fc.assert(fc.property(fc.integer(), () => false));
});
`,
    );
    const { code, stdout } = await runRealSoakCli(root, "widget", file, []);
    assert(code !== 0, `expected a non-zero exit, got 0. stdout: ${stdout}`);
    assert(
      stdout.includes(
        `::error title=soak-failure::widget ${file}: property falsified`,
      ),
      `expected a REAL property-falsified classification (fast-check's ` +
        `counterexample lives on stdout, not stderr), got: ${stdout}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a REAL falsified fast-check property whose predicate uses assertEquals internally (genuine deno test subprocess, no shim) still classifies as 'property falsified', never 'assertion'", async () => {
  // Real-subprocess version of the "both markers present" rationale in
  // classifyFailure's docblock: the property's OWN failure mechanism is an
  // internal assertEquals, so the combined output genuinely contains both
  // fast-check's "Property failed after <N> tests" top-line and an
  // underlying "Caused by: AssertionError: ..." line. "property falsified"
  // must win.
  const root = await Deno.makeTempDir({
    prefix: "run-soak-real-property-assert-",
  });
  try {
    const file = await writeRealPropertyTestFixture(
      root,
      "widget",
      "widget_property_test.ts",
      `import fc from "npm:fast-check@4.8.0";
import { assertEquals } from "jsr:@std/assert@1";
Deno.test("property with assertEquals inside", () => {
  fc.assert(fc.property(fc.integer(), (n) => {
    assertEquals(n, n + 1);
  }));
});
`,
    );
    const { code, stdout } = await runRealSoakCli(root, "widget", file, []);
    assert(code !== 0, `expected a non-zero exit, got 0. stdout: ${stdout}`);
    assert(
      stdout.includes(
        `::error title=soak-failure::widget ${file}: property falsified`,
      ),
      `expected a REAL property-falsified classification even though the ` +
        `property's own predicate throws via assertEquals, got: ${stdout}`,
    );
    assert(
      !stdout.includes(
        `::error title=soak-failure::widget ${file}: assertion`,
      ),
      `must NOT report the more generic 'assertion' when a more specific ` +
        `'property falsified' classification applies, got: ${stdout}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a REAL AssertionError failure whose diff contains the literal string 'Property failed after 1 tests' (genuine deno test subprocess, no shim) classifies as 'assertion', never 'property falsified'", async () => {
  // The negative case: an ordinary (non-property) test that legitimately
  // asserts on fast-check's own error-message wording must not be
  // misdiagnosed as a falsified property just because that text appears
  // somewhere in the combined output.
  const root = await Deno.makeTempDir({
    prefix: "run-soak-real-assert-propstr-",
  });
  try {
    const file = await writeRealPropertyTestFixture(
      root,
      "widget",
      "widget_property_test.ts",
      `import { assertEquals } from "jsr:@std/assert@1";
Deno.test("asserts on the literal string 'Property failed after 1 tests'", () => {
  const actual = "unrelated";
  assertEquals(actual, "Property failed after 1 tests");
});
`,
    );
    const { code, stdout } = await runRealSoakCli(root, "widget", file, []);
    assert(code !== 0, `expected a non-zero exit, got 0. stdout: ${stdout}`);
    assert(
      stdout.includes(
        `::error title=soak-failure::widget ${file}: assertion`,
      ),
      `expected a REAL assertion classification even though the diff ` +
        `contains the literal phrase "Property failed after 1 tests", got: ${stdout}`,
    );
    assert(
      !stdout.includes(
        `::error title=soak-failure::widget ${file}: property falsified`,
      ),
      `must NOT misclassify an ordinary assertEquals(actual, "Property ` +
        `failed after 1 tests") failure as a falsified property, got: ${stdout}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a REAL generic failure (neither NotCapable nor AssertionError, genuine deno test subprocess) classifies as 'unknown'", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-real-unknown-" });
  try {
    const file = await writeRealPropertyTestFixture(
      root,
      "widget",
      "widget_property_test.ts",
      `Deno.test("generic failure", () => {
  throw new Error("boom, an unrelated failure");
});
`,
    );
    const { code, stdout } = await runRealSoakCli(root, "widget", file, []);
    assert(code !== 0, `expected a non-zero exit, got 0. stdout: ${stdout}`);
    assert(
      stdout.includes(`::error title=soak-failure::widget ${file}: unknown`),
      `expected an 'unknown' classification, got: ${stdout}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: exit code 133 (real subprocess, real exit code — a genuine OOM-kill isn't portably reproducible in a test) classifies as 'out of memory' from the code alone", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-real-oom-" });
  const binDir = await Deno.makeTempDir({ prefix: "run-soak-oom-bin-" });
  try {
    await writeFixtureExtension(root);
    await writeDenoShim(binDir);
    const scriptUrl = new URL("./run_soak.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        scriptUrl.pathname,
        "--extension",
        "stripe-mpp",
        "--file",
        "extensions/models/stripe_mpp_property_test.ts",
        "--deno-args-json",
        '["--allow-env=FC_NUM_RUNS"]',
        "--runs",
        "10000",
      ],
      cwd: root,
      env: {
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
        SHIM_EXIT_CODE: "133",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    assert(code !== 0);
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes(
        "::error title=soak-failure::stripe-mpp " +
          "extensions/models/stripe_mpp_property_test.ts: out of memory",
      ),
      `expected a real-subprocess out-of-memory classification, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(binDir, { recursive: true });
  }
});

// ============================================================================
// CLI usage errors — missing --extension/--file, malformed --deno-args-json
// (the MEDIUM findings this pins): these used to fail silently/confusingly
// (an empty --extension resolved "" to the repo root itself; a malformed
// --deno-args-json silently fell back to an empty, zero-permission argv)
// instead of a clear, actionable CLI error.
// ============================================================================

Deno.test("run_soak.ts CLI: a missing --extension is a clear CLI/argument error, not a silent resolve-to-repo-root", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-noext-" });
  try {
    await writeFixtureExtension(root);
    const scriptUrl = new URL("./run_soak.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-run",
        "--allow-env",
        scriptUrl.pathname,
        "--file",
        "extensions/models/stripe_mpp_property_test.ts",
        "--deno-args-json",
        "[]",
        "--runs",
        "10",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    assert(code !== 0, "expected a non-zero exit for a missing --extension");
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes("::error::--extension"),
      `expected a clear --extension-is-required error, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a missing --file is a clear CLI/argument error", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-nofile-" });
  try {
    await writeFixtureExtension(root);
    const scriptUrl = new URL("./run_soak.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-run",
        "--allow-env",
        scriptUrl.pathname,
        "--extension",
        "stripe-mpp",
        "--deno-args-json",
        "[]",
        "--runs",
        "10",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    assert(code !== 0, "expected a non-zero exit for a missing --file");
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes("::error::--file"),
      `expected a clear --file-is-required error, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts CLI: a malformed --deno-args-json is a clear CLI/argument error, not a silent empty-permission fallback", async () => {
  const root = await Deno.makeTempDir({ prefix: "run-soak-badjson-" });
  try {
    await writeFixtureExtension(root);
    const scriptUrl = new URL("./run_soak.ts", import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-run",
        "--allow-env",
        scriptUrl.pathname,
        "--extension",
        "stripe-mpp",
        "--file",
        "extensions/models/stripe_mpp_property_test.ts",
        "--deno-args-json",
        "not-json",
        "--runs",
        "10",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    assert(
      code !== 0,
      "expected a non-zero exit for a malformed --deno-args-json",
    );
    const out = new TextDecoder().decode(stdout);
    assert(
      out.includes("::error::--deno-args-json"),
      `expected a clear --deno-args-json error, got: ${out}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run_soak.ts --help exits 0 and prints the exit-code contract", async () => {
  const scriptUrl = new URL("./run_soak.ts", import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", scriptUrl.pathname, "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  const out = new TextDecoder().decode(stdout);
  assert(out.length > 0);
  assert(
    out.toLowerCase().includes("exit code"),
    `expected --help to document the exit-code contract, got: ${out}`,
  );
});
