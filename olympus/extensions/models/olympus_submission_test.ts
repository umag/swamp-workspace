import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  countEffectiveLoc,
  hasErrors,
  isNonCountingLine,
  lintDockerfileText,
  lintProblemText,
  lintSolutionPatch,
  lintTestPatch,
  parseJUnit,
  parseRepoUrl,
  parseUnifiedDiff,
  type RunResult,
  scanLeaks,
  tail,
} from "./lib/checks.ts";
import {
  checkPatchesImpl,
  checkRepoImpl,
  evaluateGate,
  localReviewImpl,
  model,
  nextPhase,
  patchFingerprint,
  priorArtFingerprint,
  readRegularFile,
  reviewFingerprint,
  scanPriorArtImpl,
  SubmissionStateSchema,
} from "./olympus_submission.ts";
import {
  buildWorkspace,
  ctxFor,
  dataName,
  failResult,
  fakeCtx,
  jsonResult,
  type RunCall,
  scriptedRunner,
} from "./lib/test_support.ts";

/** Call a lifecycle method's execute directly against a Ctx double. */
// deno-lint-ignore no-explicit-any
function runMethod(name: string, args: any, ctx: any): Promise<unknown> {
  // deno-lint-ignore no-explicit-any
  const m = (model.methods as any)[name];
  return m.execute(args, ctx);
}

/** A scripted `gh api` that answers the repo-metadata and commit calls. */
function ghApi(
  repoMeta: Record<string, unknown>,
  commit: Record<string, unknown> = {
    sha: "d".repeat(40),
    commit: { committer: { date: "2020-01-01T00:00:00Z" } },
  },
) {
  return (call: RunCall) => {
    if (call.args.some((a) => a.includes("/commits/"))) {
      return jsonResult(commit);
    }
    if (call.args.some((a) => a.startsWith("repos/"))) {
      return jsonResult(repoMeta);
    }
    return undefined;
  };
}

/** Repo metadata that clears every eligibility bar except the field overridden. */
function eligibleRepo(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stargazers_count: 1000,
    // 30 days ago — always inside the 12-month window, whatever "now" is.
    pushed_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    archived: false,
    disabled: false,
    private: false,
    language: "Python",
    license: { spdx_id: "MIT" },
    default_branch: "main",
    ...overrides,
  };
}

// ---------- fixtures ---------------------------------------------------------

const GOOD_PROBLEM =
  `Add support for distinct aggregations to grouped queries. A count of distinct \
values counts how many different non-null values a group holds, a distinct sum \
adds each different value once, and a distinct average averages the different \
values. A value that appears in several rows, or in several partitions, counts \
only once. Today a distinct qualifier is ignored, so these behave like their \
plain counterparts, which is wrong whenever a value repeats.

Every one of these aggregations ignores null inputs. When a group has no \
contributing values the distinct count is zero and the other aggregations are \
null. All of them are reached through ordinary grouped SQL queries and must \
coexist with the existing aggregations, which keep working unchanged.`;

const GOOD_DOCKERFILE = `FROM public.ecr.aws/d3j8x8q7/olympus-base-go:latest

WORKDIR /app
COPY . .

RUN go mod download

ENV GOFLAGS="-mod=readonly"

RUN go build ./...

CMD ["/bin/bash"]
`;

const TEST_SH_BODY = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "cd /app",
  'OUTPUT_PATH=""',
  'if [ "${1:-}" = "--output_path" ]; then',
  '  OUTPUT_PATH="$2"',
  "  shift 2",
  "fi",
  'MODE="${1:-new}"',
  'case "$MODE" in',
  "  base) go test -count=1 -v ./query/... ;;",
  "  new) go test -count=1 -v -run '^TestHA_' ./internal/... ;;",
  "esac",
];

function diffNewFile(path: string, mode: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

const GOOD_TEST_PATCH = diffNewFile("test.sh", "100755", TEST_SH_BODY) +
  diffNewFile("internal/aggregation_distinct_test.go", "100644", [
    "package internal",
    "",
    "func TestHA_CountDistinct(t *testing.T) {",
    "\trequire.Equal(t, int64(2), got)",
    "}",
  ]);

const GOOD_SOLUTION_PATCH = [
  "diff --git a/query/aggregate.go b/query/aggregate.go",
  "index aaaaaaa..bbbbbbb 100644",
  "--- a/query/aggregate.go",
  "+++ b/query/aggregate.go",
  "@@ -10,6 +10,12 @@ func resolve() {",
  " \tctx := context.Background()",
  "+\tcase AggFuncCountDistinct:",
  "+\t\tseen := map[int64]struct{}{}",
  "+",
  "+\t\t// Each value contributes once, however the rows are partitioned.",
  "+\t\tfor _, v := range values {",
  "+\t\t\tseen[v] = struct{}{}",
  "+\t\t}",
  "-\tolder := true",
  " \treturn nil",
  "",
].join("\n");

function baseState(overrides: Record<string, unknown> = {}) {
  const now = "2026-07-18T00:00:00.000Z";
  return {
    slug: "frostdb-distinct",
    repoUrl: "https://github.com/polarsignals/frostdb",
    owner: "polarsignals",
    repo: "frostdb",
    commit: "abc123def456",
    phase: "repo",
    dir: "/tmp/ws/submissions/frostdb-distinct",
    createdAt: now,
    updatedAt: now,
    history: [],
    checks: {},
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

const NO_ARTIFACTS = {
  problem: null,
  testPatch: null,
  solutionPatch: null,
  dockerfile: null,
};

// ---------- parseRepoUrl -----------------------------------------------------

Deno.test("parseRepoUrl accepts the shapes people actually paste", () => {
  for (
    const url of [
      "https://github.com/polarsignals/frostdb",
      "https://github.com/polarsignals/frostdb.git",
      "https://github.com/polarsignals/frostdb/",
      "git@github.com:polarsignals/frostdb.git",
      "polarsignals/frostdb",
    ]
  ) {
    assertEquals(parseRepoUrl(url), {
      owner: "polarsignals",
      repo: "frostdb",
    }, url);
  }
});

Deno.test("parseRepoUrl rejects non-GitHub and malformed URLs", () => {
  for (
    const url of [
      "https://gitlab.com/foo/bar",
      "https://github.com/onlyowner",
      "not a url",
      "",
    ]
  ) {
    assertEquals(parseRepoUrl(url), null, url);
  }
});

// ---------- leak scanning ----------------------------------------------------

Deno.test("scanLeaks catches every quest-identifying word", () => {
  const text = [
    "this is the olympus runner",
    "part of the quest",
    "see shipd.ai",
    "the mars variant",
    "a challenge harness",
  ].join("\n");
  const rules = scanLeaks(text, "test.patch").map((f) => f.rule).sort();
  assertEquals(rules, [
    "leak/challenge",
    "leak/mars",
    "leak/olympus",
    "leak/quest",
    "leak/shipd",
  ]);
});

Deno.test("scanLeaks does not fire on innocent substrings", () => {
  // "marshalling" contains "mars", "requested" contains "quest" — word
  // boundaries must keep both quiet.
  const text = "marshalling the requested conquest is fine";
  const rules = scanLeaks(text, "solution.patch").map((f) => f.rule);
  assertEquals(rules.includes("leak/mars"), false);
  assertEquals(rules.includes("leak/olympus"), false);
  // "requested"/"conquest" embed quest; "conquest" also embeds no challenge but
  // guard both boundary-dependent patterns so dropping \b would be caught.
  assertEquals(rules.includes("leak/quest"), false);
  assertEquals(rules.includes("leak/challenge"), false);
});

Deno.test("scanLeaks softens challenge/quest when the repo owns the word", () => {
  const findings = scanLeaks("a challenge harness", "test.patch", true);
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, "warn");
});

// ---------- problem linter ---------------------------------------------------

Deno.test("lintProblemText passes a well-formed maintainer-style description", () => {
  const findings = lintProblemText(GOOD_PROBLEM);
  assertFalse(
    hasErrors(findings),
    `unexpected errors: ${JSON.stringify(findings, null, 2)}`,
  );
});

Deno.test("lintProblemText rejects spec-sheet formatting", () => {
  const rules = (text: string) =>
    lintProblemText(text).filter((f) => f.severity === "error").map((f) =>
      f.rule
    );

  assert(rules("## Requirements\n\nDo the thing.").includes("problem/heading"));
  assert(
    rules("Add X to Y.\n\n- must be fast\n- must be safe").includes(
      "problem/bullet-list",
    ),
  );
  assert(
    rules("Add X to Y.\n\n1. first\n2. second").includes(
      "problem/numbered-list",
    ),
  );
  assert(
    rules("Add X.\n\n```go\nfunc F() {}\n```").includes("problem/code-fence"),
  );
});

Deno.test("lintProblemText flags a quest word as an error", () => {
  const findings = lintProblemText(
    "Add distinct aggregations for this olympus task, covering the null cases and the multi-partition cases so the behaviour is well defined everywhere.",
  );
  assert(findings.some((f) => f.rule === "leak/olympus"));
  assert(hasErrors(findings));
});

Deno.test("lintProblemText warns, not errors, on style signals", () => {
  const findings = lintProblemText(
    "Currently the parser drops trailing commas, which is a problem for the many users who rely on it, and it has been that way for a long while now indeed.",
  );
  assert(findings.some((f) => f.rule === "problem/motivation-preamble"));
  assertFalse(hasErrors(findings));
});

Deno.test("lintProblemText warns when the description names a source file", () => {
  const findings = lintProblemText(
    `${GOOD_PROBLEM}\n\nThe change belongs in query/aggregate.go near the top.`,
  );
  assert(findings.some((f) => f.rule === "problem/leaks-file-path"));
  // Still a warning — the doc allows naming a detail that is part of the
  // contract, so this must never block on its own.
  assertFalse(hasErrors(findings));
});

// ---------- Dockerfile linter ------------------------------------------------

Deno.test("lintDockerfileText passes the approved-example Dockerfile", () => {
  const findings = lintDockerfileText(GOOD_DOCKERFILE);
  assertFalse(
    hasErrors(findings),
    `unexpected errors: ${JSON.stringify(findings, null, 2)}`,
  );
});

Deno.test("lintDockerfileText rejects an unapproved base image", () => {
  const findings = lintDockerfileText(
    GOOD_DOCKERFILE.replace(
      "public.ecr.aws/d3j8x8q7/olympus-base-go:latest",
      "golang:1.22",
    ),
  );
  assert(findings.some((f) => f.rule === "dockerfile/base-image"));
});

Deno.test("lintDockerfileText requires WORKDIR /app", () => {
  const findings = lintDockerfileText(
    GOOD_DOCKERFILE.replace("WORKDIR /app", "WORKDIR /src"),
  );
  assert(findings.some((f) => f.rule === "dockerfile/workdir"));
});

Deno.test("lintDockerfileText requires the bash CMD to come last", () => {
  const findings = lintDockerfileText(
    GOOD_DOCKERFILE.replace('CMD ["/bin/bash"]', 'ENTRYPOINT ["/app/run"]'),
  );
  assert(findings.some((f) => f.rule === "dockerfile/cmd"));
});

Deno.test("lintDockerfileText rejects tests run during the build", () => {
  const findings = lintDockerfileText(
    GOOD_DOCKERFILE.replace("RUN go build ./...", "RUN go test ./..."),
  );
  assert(findings.some((f) => f.rule === "dockerfile/tests-in-build"));
});

Deno.test("lintDockerfileText inspects continuation lines as one instruction", () => {
  const findings = lintDockerfileText(
    GOOD_DOCKERFILE.replace(
      "RUN go build ./...",
      "RUN go build ./... \\\n    && go test ./...",
    ),
  );
  assert(
    findings.some((f) => f.rule === "dockerfile/tests-in-build"),
    "a test hidden behind a line continuation must still be caught",
  );
});

Deno.test("lintDockerfileText does not confuse installing a runner with running it", () => {
  // `pip install pytest` names a test runner but runs nothing — installing it
  // at build time is exactly what an offline runtime container needs.
  for (
    const step of [
      "RUN pip install --no-cache-dir -e . && pip install --no-cache-dir pytest",
      "RUN npm install --save-dev jest",
      "RUN apt-get install -y ctest",
      "RUN go install gotest.tools/gotestsum@latest",
    ]
  ) {
    const findings = lintDockerfileText(
      GOOD_DOCKERFILE.replace("RUN go build ./...", step),
    );
    assertFalse(
      findings.some((f) => f.rule === "dockerfile/tests-in-build"),
      step,
    );
  }
});

Deno.test("lintDockerfileText still catches a test run chained after an install", () => {
  const findings = lintDockerfileText(
    GOOD_DOCKERFILE.replace(
      "RUN go build ./...",
      "RUN pip install pytest && pytest tests/",
    ),
  );
  assert(findings.some((f) => f.rule === "dockerfile/tests-in-build"));
});

Deno.test("lintDockerfileText warns when nothing is installed at build time", () => {
  const findings = lintDockerfileText(
    `FROM public.ecr.aws/d3j8x8q7/olympus-base-go:latest\nWORKDIR /app\nCOPY . .\nCMD ["/bin/bash"]\n`,
  );
  assert(findings.some((f) => f.rule === "dockerfile/no-install"));
  assertFalse(hasErrors(findings));
});

// ---------- diff parsing -----------------------------------------------------

Deno.test("parseUnifiedDiff extracts paths, modes and added lines", () => {
  const files = parseUnifiedDiff(GOOD_TEST_PATCH);
  assertEquals(files.map((f) => f.path), [
    "test.sh",
    "internal/aggregation_distinct_test.go",
  ]);
  assertEquals(files[0].isNew, true);
  assertEquals(files[0].mode, "100755");
  assertEquals(files[0].addedLines.length, TEST_SH_BODY.length);
});

Deno.test("parseUnifiedDiff does not count the +++ header as an added line", () => {
  const files = parseUnifiedDiff(GOOD_SOLUTION_PATCH);
  assertEquals(files.length, 1);
  assertEquals(files[0].removedCount, 1);
  assertFalse(
    files[0].addedLines.some((l) => l.startsWith("+ b/")),
    "the +++ b/<path> header must not be treated as content",
  );
});

// ---------- effective LOC ----------------------------------------------------

Deno.test("isNonCountingLine knows blanks and per-language comments", () => {
  assert(isNonCountingLine("a.go", ""));
  assert(isNonCountingLine("a.go", "   "));
  assert(isNonCountingLine("a.go", "// explain"));
  assert(isNonCountingLine("a.go", " * javadoc continuation"));
  assert(isNonCountingLine("a.py", "# explain"));
  assert(isNonCountingLine("a.sh", "# explain"));
  assertFalse(isNonCountingLine("a.go", "x := 1"));
  // A hash in Go is not a comment.
  assertFalse(isNonCountingLine("a.go", "#include <x>"));
  // Multiplication must not be read as a comment continuation.
  assertFalse(isNonCountingLine("a.go", "*= 2"));
});

Deno.test("countEffectiveLoc excludes blanks and comments", () => {
  const loc = countEffectiveLoc(GOOD_SOLUTION_PATCH);
  // 7 added lines: 1 blank + 1 comment do not count.
  assertEquals(loc.rawAdded, 7);
  assertEquals(loc.effective, 5);
});

Deno.test("countEffectiveLoc excludes Python docstrings", () => {
  const patch = diffNewFile("pkg/encoding.py", "100644", [
    "def is_base64(value):",
    '    """Check whether a value uses only the URL-safe alphabet.',
    "",
    "    Text is compared as ASCII.",
    '    """',
    "    return not set(value) - set(_alphabet)",
  ]);
  const loc = countEffectiveLoc(patch);
  assertEquals(loc.rawAdded, 6);
  // Only the def and the return implement anything.
  assertEquals(loc.effective, 2);
});

Deno.test("countEffectiveLoc counts a one-line Python docstring as documentation", () => {
  const loc = countEffectiveLoc(
    diffNewFile("pkg/a.py", "100644", [
      "def f():",
      '    """One liner."""',
      "    return 1",
    ]),
  );
  assertEquals(loc.effective, 2);
});

Deno.test("countEffectiveLoc does not treat docstring rules as applying to other languages", () => {
  const loc = countEffectiveLoc(
    diffNewFile("pkg/a.go", "100644", [
      "func F() string {",
      '\treturn """not a docstring"""',
      "}",
    ]),
  );
  assertEquals(loc.effective, 3);
});

Deno.test("countEffectiveLoc excludes test and generated files entirely", () => {
  const patch = GOOD_SOLUTION_PATCH +
    diffNewFile("internal/thing_test.go", "100644", [
      "package internal",
      "func TestThing(t *testing.T) {}",
    ]) +
    diffNewFile("go.sum", "100644", ["github.com/x/y v1.0.0 h1:abc="]);
  const loc = countEffectiveLoc(patch);
  assertEquals(loc.effective, 5, "only the real implementation lines count");
  const byPath = Object.fromEntries(loc.files.map((f) => [f.path, f]));
  assertEquals(byPath["internal/thing_test.go"].excluded, "test");
  assertEquals(byPath["go.sum"].excluded, "generated");
});

// ---------- test patch linter ------------------------------------------------

Deno.test("lintTestPatch passes a well-formed test patch", () => {
  const findings = lintTestPatch(GOOD_TEST_PATCH);
  assertFalse(
    hasErrors(findings),
    `unexpected errors: ${JSON.stringify(findings, null, 2)}`,
  );
});

Deno.test("lintTestPatch requires test.sh to be committed executable", () => {
  const findings = lintTestPatch(
    diffNewFile("test.sh", "100644", TEST_SH_BODY) +
      diffNewFile("tests/a_test.go", "100644", ["package a"]),
  );
  assert(findings.some((f) => f.rule === "tests/test-sh-not-executable"));
  assert(hasErrors(findings));
});

Deno.test("lintTestPatch requires test.sh at all", () => {
  const findings = lintTestPatch(
    diffNewFile("tests/a_test.go", "100644", ["package a"]),
  );
  assert(findings.some((f) => f.rule === "tests/no-test-sh"));
});

Deno.test("lintTestPatch requires both modes and --output_path", () => {
  const stripped = TEST_SH_BODY.filter((l) =>
    !l.includes("--output_path") &&
    !l.includes("MODE") && !l.includes("base)")
  );
  const findings = lintTestPatch(diffNewFile("test.sh", "100755", stripped));
  const rules = findings.map((f) => f.rule);
  assert(rules.includes("tests/output-path-missing"));
});

Deno.test("lintTestPatch rejects fail-fast flags", () => {
  const findings = lintTestPatch(
    diffNewFile(
      "test.sh",
      "100755",
      TEST_SH_BODY.map((l) =>
        l.includes("base)") ? "  base) pytest tests/ -x ;;" : l
      ),
    ),
  );
  assert(findings.some((f) => f.rule === "tests/fail-fast"));
});

Deno.test("lintTestPatch rejects a path that names the quest", () => {
  const findings = lintTestPatch(
    diffNewFile("test.sh", "100755", TEST_SH_BODY) +
      diffNewFile("challenge/holistic_test.go", "100644", [
        "package challenge",
      ]),
  );
  assert(findings.some((f) => f.rule === "leak/challenge-path"));
  assert(hasErrors(findings));
});

// ---------- solution patch linter --------------------------------------------

Deno.test("lintSolutionPatch passes a clean implementation diff", () => {
  assertFalse(hasErrors(lintSolutionPatch(GOOD_SOLUTION_PATCH)));
});

Deno.test("lintSolutionPatch warns when the solution edits the tests", () => {
  const findings = lintSolutionPatch(
    GOOD_SOLUTION_PATCH +
      diffNewFile("internal/thing_test.go", "100644", ["package internal"]),
  );
  assert(findings.some((f) => f.rule === "solution/touches-tests"));
});

// ---------- JUnit ------------------------------------------------------------

Deno.test("parseJUnit prefers the testsuites roll-up over summing suites", () => {
  const xml =
    `<?xml version="1.0"?><testsuites tests="10" failures="2" errors="1" skipped="0">` +
    `<testsuite tests="5" failures="1" errors="0" skipped="0"/>` +
    `<testsuite tests="5" failures="1" errors="1" skipped="0"/>` +
    `</testsuites>`;
  assertEquals(parseJUnit(xml), {
    tests: 10,
    failures: 2,
    errors: 1,
    skipped: 0,
    parsed: true,
  });
});

Deno.test("parseJUnit sums bare testsuite elements", () => {
  const xml = `<testsuite tests="3" failures="1" errors="0" skipped="1"/>` +
    `<testsuite tests="4" failures="0" errors="2" skipped="0"/>`;
  assertEquals(parseJUnit(xml), {
    tests: 7,
    failures: 1,
    errors: 2,
    skipped: 1,
    parsed: true,
  });
});

Deno.test("parseJUnit reads pytest's bare testsuites wrapper", () => {
  // pytest emits <testsuites name="pytest tests"> with no counters and puts
  // the numbers on the inner <testsuite>. Trusting the wrapper reports zero.
  const xml = `<?xml version="1.0" encoding="utf-8"?>` +
    `<testsuites name="pytest tests">` +
    `<testsuite name="pytest" errors="0" failures="1" skipped="0" tests="11" time="0.108">` +
    `<testcase classname="t" name="a" time="0.002" />` +
    `</testsuite></testsuites>`;
  assertEquals(parseJUnit(xml), {
    tests: 11,
    failures: 1,
    errors: 0,
    skipped: 0,
    parsed: true,
  });
});

Deno.test("parseJUnit reports unparsed rather than guessing", () => {
  assertEquals(parseJUnit("").parsed, false);
  assertEquals(parseJUnit("not xml at all").parsed, false);
});

// ---------- misc -------------------------------------------------------------

Deno.test("tail keeps the last lines", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const t = tail(text, 3);
  assertEquals(t, "line 97\nline 98\nline 99");
});

Deno.test("nextPhase walks the lifecycle and stops at the end", () => {
  assertEquals(nextPhase("repo"), "problem");
  assertEquals(nextPhase("dockerfile"), "review");
  assertEquals(nextPhase("review"), "ready");
  assertEquals(nextPhase("submitted"), undefined);
  assertEquals(nextPhase("abandoned"), undefined);
});

// ---------- gates ------------------------------------------------------------

Deno.test("repo gate blocks until eligibility and prior art are both recorded", async () => {
  const gate = await evaluateGate(baseState(), NO_ARTIFACTS);
  assertFalse(gate.satisfied);
  const rules = gate.blockers.map((b) => b.rule);
  assert(rules.includes("gate/repo-unchecked"));
  assert(rules.includes("gate/prior-art-unscanned"));
});

Deno.test("repo gate opens on eligibility plus a clear prior-art scan", async () => {
  const state = baseState({
    checks: {
      repo: { passed: true, ranAt: "2026-07-18T00:00:00.000Z" },
      // A clear scan: hitCount strictly 0, not truncated. No acknowledgement
      // needed — the state alone opens the gate.
      priorArt: {
        passed: true,
        ranAt: "2026-07-18T00:00:00.000Z",
        hitCount: 0,
        hitFingerprint: "clear",
        truncated: false,
      },
    },
  });
  const gate = await evaluateGate(state, NO_ARTIFACTS);
  assert(gate.satisfied, JSON.stringify(gate.blockers));
});

// The prior-art gate: only a strictly-numeric hitCount 0 opens it; a legacy
// record with undefined hitCount, unadjudicated hits, a stale acknowledgement
// and a truncated scan all HOLD it. These are the H5 fail-open regression tests.

function repoGate(priorArt: Record<string, unknown>) {
  return evaluateGate(
    baseState({
      checks: { repo: { passed: true, ranAt: "x" }, priorArt },
    }),
    NO_ARTIFACTS,
  );
}

Deno.test("prior-art gate holds on a legacy record with undefined hitCount", async () => {
  const gate = await repoGate({ passed: true, ranAt: "x" });
  assertFalse(gate.satisfied, "undefined hitCount must fail closed, not open");
  assert(gate.blockers.some((b) => b.rule === "gate/prior-art-unadjudicated"));
});

Deno.test("prior-art gate holds on unadjudicated hits", async () => {
  const gate = await repoGate({
    passed: false,
    ranAt: "x",
    hitCount: 2,
    hitFingerprint: "abc",
    truncated: false,
  });
  assertFalse(gate.satisfied);
  assert(gate.blockers.some((b) => b.rule === "gate/prior-art-unadjudicated"));
});

Deno.test("prior-art gate clears once hits are acknowledged with the matching fingerprint", async () => {
  const gate = await repoGate({
    passed: true,
    ranAt: "x",
    hitCount: 2,
    hitFingerprint: "abc",
    truncated: false,
    acknowledgement: {
      fingerprint: "abc",
      urls: ["https://github.com/acme/widget/pull/1"],
      acknowledgedAt: "x",
    },
  });
  assert(gate.satisfied, JSON.stringify(gate.blockers));
});

Deno.test("prior-art gate holds when the acknowledgement fingerprint is stale", async () => {
  const gate = await repoGate({
    passed: true,
    ranAt: "x",
    hitCount: 2,
    hitFingerprint: "abc",
    truncated: false,
    acknowledgement: { fingerprint: "STALE", urls: ["u"], acknowledgedAt: "x" },
  });
  assertFalse(gate.satisfied, "a fingerprint mismatch must reopen the gate");
  assert(gate.blockers.some((b) => b.rule === "gate/prior-art-unadjudicated"));
});

Deno.test("prior-art gate holds on a truncated scan even with zero hits", async () => {
  const gate = await repoGate({
    passed: true,
    ranAt: "x",
    hitCount: 0,
    hitFingerprint: "clear",
    truncated: true,
  });
  assertFalse(gate.satisfied, "a truncated scan cannot certify clear");
  assert(gate.blockers.some((b) => b.rule === "gate/prior-art-truncated"));
});

Deno.test("repo gate blocks when no commit is pinned", async () => {
  const state = baseState({
    commit: undefined,
    checks: {
      repo: { passed: true, ranAt: "x" },
      priorArt: { passed: true, ranAt: "x" },
    },
  });
  const gate = await evaluateGate(state, NO_ARTIFACTS);
  assert(gate.blockers.some((b) => b.rule === "gate/no-commit"));
});

Deno.test("problem gate runs the linter live off disk", async () => {
  const state = baseState({ phase: "problem" });
  const bad = await evaluateGate(state, {
    ...NO_ARTIFACTS,
    problem: "## Task\n\n- do the thing",
  });
  assertFalse(bad.satisfied);

  const good = await evaluateGate(state, {
    ...NO_ARTIFACTS,
    problem: GOOD_PROBLEM,
  });
  assert(good.satisfied, JSON.stringify(good.blockers));
});

Deno.test("tests gate requires a fresh checkPatches pass", async () => {
  const artifacts = {
    ...NO_ARTIFACTS,
    testPatch: GOOD_TEST_PATCH,
    solutionPatch: GOOD_SOLUTION_PATCH,
  };
  const unchecked = await evaluateGate(
    baseState({ phase: "tests" }),
    artifacts,
  );
  assert(unchecked.blockers.some((b) => b.rule === "gate/patches-unchecked"));

  const stale = await evaluateGate(
    baseState({
      phase: "tests",
      checks: {
        patches: {
          passed: true,
          ranAt: "x",
          fingerprint: "a-fingerprint-from-an-older-edit",
        },
      },
    }),
    artifacts,
  );
  assert(
    stale.blockers.some((b) => b.rule === "gate/patches-stale"),
    "a recorded pass against different artifacts must not satisfy the gate",
  );

  const fresh = await evaluateGate(
    baseState({
      phase: "tests",
      checks: {
        patches: {
          passed: true,
          ranAt: "x",
          fingerprint: await patchFingerprint(artifacts, "abc123def456"),
        },
      },
    }),
    artifacts,
  );
  assert(fresh.satisfied, JSON.stringify(fresh.blockers));
});

Deno.test("fingerprints separate the artifacts they cover", async () => {
  const a = {
    problem: null,
    testPatch: "ab",
    solutionPatch: "c",
    dockerfile: "D",
  };
  const b = {
    problem: null,
    testPatch: "a",
    solutionPatch: "bc",
    dockerfile: "D",
  };
  // Concatenation without a delimiter would make these two collide.
  assert(
    await patchFingerprint(a, "sha") !== await patchFingerprint(b, "sha"),
    "['ab','c'] and ['a','bc'] must not hash alike",
  );
  // The Dockerfile is part of the review fingerprint but not the patch one.
  assertEquals(
    await patchFingerprint(a, "sha"),
    await patchFingerprint({ ...a, dockerfile: "different" }, "sha"),
  );
  assert(
    await reviewFingerprint(a, "sha") !==
      await reviewFingerprint({ ...a, dockerfile: "different" }, "sha"),
  );
  // A missing artifact must not hash like an empty one.
  assert(
    await reviewFingerprint(a, "sha") !==
      await reviewFingerprint({ ...a, dockerfile: "" }, "sha"),
  );
  // And the pinned commit is part of both.
  assert(
    await reviewFingerprint(a, "sha") !== await reviewFingerprint(a, "other"),
  );
});

Deno.test("review gate goes stale when an artifact changes after a green run", async () => {
  const artifacts = {
    problem: GOOD_PROBLEM,
    testPatch: GOOD_TEST_PATCH,
    solutionPatch: GOOD_SOLUTION_PATCH,
    dockerfile: GOOD_DOCKERFILE,
  };
  // Use the model's own helper rather than reimplementing the digest here —
  // a second copy of the hashing can drift from the real one and hide exactly
  // the staleness bug this test exists to catch.
  const fp = await reviewFingerprint(artifacts, "abc123def456");

  const green = await evaluateGate(
    baseState({
      phase: "review",
      checks: { review: { passed: true, ranAt: "x", fingerprint: fp } },
    }),
    artifacts,
  );
  assert(green.satisfied, JSON.stringify(green.blockers));

  const edited = await evaluateGate(
    baseState({
      phase: "review",
      checks: { review: { passed: true, ranAt: "x", fingerprint: fp } },
    }),
    { ...artifacts, dockerfile: GOOD_DOCKERFILE + "\n# tweaked\n" },
  );
  assert(edited.blockers.some((b) => b.rule === "gate/review-stale"));
});

Deno.test("terminal phases have no blockers", async () => {
  for (const phase of ["ready", "submitted", "abandoned"]) {
    const gate = await evaluateGate(baseState({ phase }), NO_ARTIFACTS);
    assert(gate.satisfied, phase);
  }
});

// ---------- method impls (fake runner + Ctx double) --------------------------

Deno.test("checkPatchesImpl passes when both patches apply under a fake runner", async () => {
  const ws = await buildWorkspace({ slug: "wf-check", commit: "c".repeat(40) });
  const ctx = ctxFor(ws);
  // Default scripted runner answers every git call with exit 0, so the clone,
  // checkout, clean and both `git apply` calls succeed.
  const run = scriptedRunner();
  try {
    await checkPatchesImpl(run, { slug: ws.slug }, ctx);

    // The runner was actually threaded through prepareClone.
    assert(
      run.calls.some((c) => c.args[0] === "clone"),
      "expected a git clone through the injected runner",
    );
    // Both the patch resource and the state were persisted, passing.
    const patchWrite = ctx.writes.find((w) => w.spec === "patchCheck");
    assert(patchWrite, "checkPatchesImpl must write a patchCheck resource");
    assertEquals(patchWrite.name, dataName(ws.slug, "patches"));
    assertEquals(patchWrite.data.passed, true);
    const state = ctx.store.get(dataName(ws.slug, "state"));
    assert(state, "state must be persisted");
  } finally {
    await ws.cleanup();
  }
});

Deno.test("checkRepoImpl fails closed when pushed_at is an unparseable date", async () => {
  const ws = await buildWorkspace({ slug: "wf-repo-nan" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner(
    ghApi(eligibleRepo({ pushed_at: "not-a-real-date" })),
  );
  try {
    await checkRepoImpl(run, { slug: ws.slug }, ctx);
    const repoWrite = ctx.writes.find((w) => w.spec === "repoCheck");
    assert(repoWrite, "checkRepoImpl must write a repoCheck resource");

    // An unparseable date must NOT sail through the 12-month activity check.
    assertEquals(repoWrite.data.eligible, false);
    const findings = repoWrite.data.findings as Array<{ rule: string }>;
    assert(
      findings.some((f) => f.rule === "repo/inactive"),
      "a NaN activity age must raise repo/inactive, not pass silently",
    );

    // The persisted age must never be NaN/Infinity — that JSON-serialises to
    // null and would break RepoCheckSchema.parse on the next read.
    const age = repoWrite.data.monthsSinceLastPush;
    assert(
      age === null || (typeof age === "number" && Number.isFinite(age)),
      `monthsSinceLastPush must be finite or null, got ${age}`,
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("checkRepoImpl marks a recently-pushed, permissive repo eligible", async () => {
  const ws = await buildWorkspace({ slug: "wf-repo-ok" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner(ghApi(eligibleRepo()));
  try {
    await checkRepoImpl(run, { slug: ws.slug }, ctx);
    const repoWrite = ctx.writes.find((w) => w.spec === "repoCheck");
    assert(repoWrite);
    assertEquals(repoWrite.data.eligible, true);
    const age = repoWrite.data.monthsSinceLastPush;
    assert(typeof age === "number" && Number.isFinite(age));
  } finally {
    await ws.cleanup();
  }
});

// ---------- localReview ------------------------------------------------------

/**
 * A fake runner that drives a full green review: git and docker calls exit 0,
 * except new-before-solution (which must fail at the base commit). `overrides`
 * runs first, to invert one stage.
 */
function reviewRunner(
  overrides: (call: RunCall) => Partial<RunResult> | undefined = () =>
    undefined,
) {
  return scriptedRunner((call) => {
    const o = overrides(call);
    if (o) return o;
    if (call.args.some((a) => a.includes("new-before-solution"))) {
      return failResult(1, "new tests fail at the base commit");
    }
    return undefined;
  });
}

function reviewResultOf(ctx: ReturnType<typeof ctxFor>) {
  const w = ctx.writes.find((w) => w.spec === "reviewResult");
  assert(w, "localReview must write a reviewResult");
  return w.data;
}

const ranContainer = (run: ReturnType<typeof reviewRunner>) =>
  run.calls.filter((c) => c.args[0] === "run");
const removedImages = (run: ReturnType<typeof reviewRunner>) =>
  run.calls.filter((c) => c.args[0] === "image" && c.args[1] === "rm");

Deno.test("localReview passes when all six stages meet their expectation", async () => {
  const ws = await buildWorkspace({ slug: "lr-pass" });
  const ctx = ctxFor(ws);
  const run = reviewRunner();
  try {
    await localReviewImpl(run, { slug: ws.slug }, ctx);
    const rr = reviewResultOf(ctx);
    assertEquals(rr.verdict, "pass");
    assertEquals((rr.stages as unknown[]).length, 6);
    // Every container run is network-isolated (test.sh is untrusted).
    assert(
      ranContainer(run).every((c) => {
        const i = c.args.indexOf("--network");
        return i >= 0 && c.args[i + 1] === "none";
      }),
      "every container run must carry --network none",
    );
    // Containers run as the host uid:gid by default — but hostUserSpec() falls
    // back to null (no --user) without --allow-sys or on non-unix, which is the
    // documented-correct behaviour, so key the assertion on what was recorded.
    const ranAsUser = !String(rr.containerUser).startsWith("root");
    assertEquals(
      ranContainer(run).every((c) => c.args.includes("--user")),
      ranAsUser,
      "--user presence must match the recorded containerUser",
    );
    // Both image tags are reclaimed.
    assertEquals(removedImages(run).length, 2);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("localReview fails when a stage's expectation is inverted", async () => {
  const ws = await buildWorkspace({ slug: "lr-regress" });
  const ctx = ctxFor(ws);
  // base-before-solution should PASS; make it fail (a regression).
  const run = reviewRunner((call) =>
    call.args.some((a) => a.includes("base-before-solution"))
      ? failResult(1, "regression")
      : undefined
  );
  try {
    await localReviewImpl(run, { slug: ws.slug }, ctx);
    const rr = reviewResultOf(ctx);
    assertEquals(rr.verdict, "fail");
    assert((rr.failedStages as string[]).includes("base-before-solution"));
  } finally {
    await ws.cleanup();
  }
});

// Invert each run stage's expectation in turn — the verdict must fail and name
// exactly that stage. base/new-after run only past a clean solution build.
for (
  const label of [
    "base-before-solution",
    "new-before-solution",
    "base-after-solution",
    "new-after-solution",
  ]
) {
  Deno.test(`localReview fails when ${label} inverts its expectation`, async () => {
    // Slug stays label-free: the label appears in a clone/build path too, and
    // matching on it there would break prepareClone. Match the JUnit filename.
    const ws = await buildWorkspace({ slug: "lr-inv" });
    const ctx = ctxFor(ws);
    const run = reviewRunner((call) => {
      if (!call.args.some((a) => a.includes(`${label}.xml`))) return undefined;
      // new-before is expected to fail — invert it to a pass; the others are
      // expected to pass — invert them to a fail.
      return label === "new-before-solution"
        ? { code: 0 }
        : failResult(1, "inverted");
    });
    try {
      await localReviewImpl(run, { slug: ws.slug }, ctx);
      const rr = reviewResultOf(ctx);
      assertEquals(rr.verdict, "fail");
      assert((rr.failedStages as string[]).includes(label), label);
    } finally {
      await ws.cleanup();
    }
  });
}

Deno.test("localReview stops early and still reclaims images when the build fails", async () => {
  const ws = await buildWorkspace({ slug: "lr-build-fail" });
  const ctx = ctxFor(ws);
  const run = reviewRunner((call) =>
    call.args[0] === "build" ? failResult(1, "build broke") : undefined
  );
  try {
    await localReviewImpl(run, { slug: ws.slug }, ctx);
    const rr = reviewResultOf(ctx);
    assertEquals(rr.verdict, "fail");
    assertEquals((rr.stages as unknown[]).length, 1);
    assert(String(rr.note).includes("stopped early"));
    assertEquals(
      removedImages(run).length,
      2,
      "cleanup runs even on early exit",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("localReview reclaims images even when a stage throws mid-sequence", async () => {
  const ws = await buildWorkspace({ slug: "lr-throw" });
  const ctx = ctxFor(ws);
  // The runner itself throws on build — a docker-daemon-died class failure.
  const run = scriptedRunner((call) => {
    if (call.args[0] === "build") throw new Error("docker daemon died");
    return undefined;
  });
  try {
    let threw = false;
    try {
      await localReviewImpl(run, { slug: ws.slug }, ctx);
    } catch {
      threw = true;
    }
    assert(threw, "an exceptional docker failure must propagate");
    assertEquals(
      run.calls.filter((c) => c.args[0] === "image" && c.args[1] === "rm")
        .length,
      2,
      "the finally block must still attempt image cleanup",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("localReview records the --user opt-out on the result", async () => {
  const ws = await buildWorkspace({ slug: "lr-root" });
  const ctx = ctxFor(ws);
  const run = reviewRunner();
  try {
    await localReviewImpl(run, { slug: ws.slug, rootInContainer: true }, ctx);
    const rr = reviewResultOf(ctx);
    assertEquals(rr.containerUser, "root (rootInContainer opt-out)");
    assertFalse(
      ranContainer(run).some((c) => c.args.includes("--user")),
      "the opt-out must drop --user",
    );
    assert(String(rr.note).includes("container user"));
  } finally {
    await ws.cleanup();
  }
});

Deno.test("localReview does not credit a permission crash as the expected failure", async () => {
  const ws = await buildWorkspace({ slug: "lr-perm" });
  const ctx = ctxFor(ws);
  // new-before-solution "fails" — but with a permission crash, not a test fail.
  const run = reviewRunner((call) =>
    call.args.some((a) => a.includes("new-before-solution"))
      ? failResult(126, "bash: ./test.sh: Permission denied")
      : undefined
  );
  try {
    await localReviewImpl(run, { slug: ws.slug }, ctx);
    const rr = reviewResultOf(ctx);
    assertEquals(rr.verdict, "fail");
    assert(
      (rr.failedStages as string[]).includes("new-before-solution"),
      "a setup crash must not be credited as the expected non-zero exit",
    );
  } finally {
    await ws.cleanup();
  }
});

// ---------- scanPriorArt -----------------------------------------------------

/** Read back the priorArt check that scanPriorArt persisted onto state. */
function priorArtCheck(ctx: ReturnType<typeof ctxFor>, slug: string) {
  const raw = ctx.store.get(dataName(slug, "state"));
  assert(raw, "state must be persisted");
  return SubmissionStateSchema.parse(raw).checks.priorArt;
}

/** No hits from either the REST issue/PR search or the GraphQL discussions. */
function emptyPriorArtRunner() {
  return scriptedRunner((call) => {
    if (call.args.includes("graphql")) {
      return jsonResult({ data: { search: { nodes: [] } } });
    }
    if (call.args.includes("search/issues")) return jsonResult({ items: [] });
    return undefined;
  });
}

Deno.test("scanPriorArt records a clear scan as passed with hitCount 0", async () => {
  const ws = await buildWorkspace({ slug: "pa-clear" });
  const ctx = ctxFor(ws);
  try {
    await scanPriorArtImpl(
      emptyPriorArtRunner(),
      { slug: ws.slug, terms: ["distinct aggregate"] },
      ctx,
    );
    const pa = priorArtCheck(ctx, ws.slug);
    assertEquals(pa?.hitCount, 0);
    assertEquals(pa?.passed, true);
    assertEquals(pa?.truncated, false);
    assert(
      (pa?.hitFingerprint ?? "").length > 0,
      "clear scan still fingerprints",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("scanPriorArt records hits as not-passed and points at acknowledgePriorArt", async () => {
  const ws = await buildWorkspace({ slug: "pa-hits" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner((call) => {
    if (call.args.includes("graphql")) {
      return jsonResult({ data: { search: { nodes: [] } } });
    }
    if (call.args.some((a) => a.includes("is:pr"))) {
      return jsonResult({
        items: [{
          html_url: "https://github.com/acme/widget/pull/7",
          title: "add distinct aggregate",
          state: "closed",
          pull_request: {},
        }],
      });
    }
    if (call.args.includes("search/issues")) return jsonResult({ items: [] });
    return undefined;
  });
  try {
    await scanPriorArtImpl(run, { slug: ws.slug, terms: ["distinct"] }, ctx);
    const pa = priorArtCheck(ctx, ws.slug);
    assertEquals(pa?.hitCount, 1);
    assertEquals(pa?.passed, false);
    assert((pa?.hitFingerprint ?? "").length > 0);
    const paResource = ctx.writes.find((w) => w.spec === "priorArt");
    assert(paResource);
    assert(
      String(paResource.data.note).includes("acknowledgePriorArt"),
      "the hits note must name the adjudication method",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("scanPriorArt fails fatally when a search stays rate-limited", async () => {
  const ws = await buildWorkspace({ slug: "pa-403" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner(() =>
    failResult(403, "gh: API rate limit exceeded (HTTP 403)")
  );
  try {
    let threw = false;
    try {
      await scanPriorArtImpl(run, { slug: ws.slug, terms: ["x"] }, ctx, {
        sleep: () => Promise.resolve(),
        rateLimitBackoffMs: [0],
      });
    } catch {
      threw = true;
    }
    assert(threw, "a persistent 403 must fail the scan");
    assertFalse(
      ctx.writes.some((w) => w.spec === "priorArt"),
      "a fatal scan writes no priorArt state — re-run is the escape hatch",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("scanPriorArt treats an unclassifiable gh failure as fatal", async () => {
  const ws = await buildWorkspace({ slug: "pa-fatal" });
  const ctx = ctxFor(ws);
  // No `(HTTP nnn)` marker — a network error, say. Not retryable.
  const run = scriptedRunner(() => failResult(1, "fatal: network unreachable"));
  try {
    let threw = false;
    try {
      await scanPriorArtImpl(run, { slug: ws.slug, terms: ["x"] }, ctx, {
        sleep: () => Promise.resolve(),
        rateLimitBackoffMs: [0, 0],
      });
    } catch {
      threw = true;
    }
    assert(
      threw,
      "an unparseable marker is fatal, not retried into a clear scan",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("scanPriorArt flags truncation when a search fills the page", async () => {
  const ws = await buildWorkspace({ slug: "pa-trunc" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner((call) => {
    if (call.args.includes("graphql")) {
      return jsonResult({ data: { search: { nodes: [] } } });
    }
    if (call.args.some((a) => a.includes("is:pr"))) {
      return jsonResult({
        items: [
          { html_url: "https://github.com/acme/widget/pull/1", state: "open" },
          { html_url: "https://github.com/acme/widget/pull/2", state: "open" },
        ],
      });
    }
    if (call.args.includes("search/issues")) return jsonResult({ items: [] });
    return undefined;
  });
  try {
    await scanPriorArtImpl(
      run,
      { slug: ws.slug, terms: ["x"], perTerm: 2 },
      ctx,
    );
    const pa = priorArtCheck(ctx, ws.slug);
    assertEquals(pa?.truncated, true);
    assertEquals(pa?.hitCount, 2);
    assertEquals(pa?.passed, false);
  } finally {
    await ws.cleanup();
  }
});

// ---------- acknowledgePriorArt ----------------------------------------------

/** A one-hit PR scan, so the gate blocks until it is adjudicated. */
function oneHitRunner(url: string) {
  return scriptedRunner((call) => {
    if (call.args.includes("graphql")) {
      return jsonResult({ data: { search: { nodes: [] } } });
    }
    if (call.args.some((a) => a.includes("is:pr"))) {
      return jsonResult({
        items: [{ html_url: url, state: "closed", pull_request: {} }],
      });
    }
    if (call.args.includes("search/issues")) return jsonResult({ items: [] });
    return undefined;
  });
}

function gateOf(ctx: ReturnType<typeof ctxFor>, slug: string) {
  const st = SubmissionStateSchema.parse(
    ctx.store.get(dataName(slug, "state")),
  );
  return evaluateGate(st, NO_ARTIFACTS);
}

Deno.test("acknowledgePriorArt clears the gate and flips the record to passed", async () => {
  const url = "https://github.com/acme/widget/pull/7";
  const ws = await buildWorkspace({
    slug: "ack-flow",
    state: { phase: "repo", checks: { repo: { passed: true, ranAt: "x" } } },
  });
  const ctx = ctxFor(ws);
  try {
    await scanPriorArtImpl(oneHitRunner(url), {
      slug: ws.slug,
      terms: ["distinct"],
    }, ctx);

    // Before acknowledgement: the record is not passed and the gate blocks.
    assertEquals(priorArtCheck(ctx, ws.slug)?.passed, false);
    const before = await gateOf(ctx, ws.slug);
    assertFalse(before.satisfied);

    await runMethod("acknowledgePriorArt", { slug: ws.slug, urls: [url] }, ctx);

    // After: the record is passed and the gate opens through the fingerprint.
    assertEquals(priorArtCheck(ctx, ws.slug)?.passed, true);
    const after = await gateOf(ctx, ws.slug);
    assert(after.satisfied, JSON.stringify(after.blockers));
  } finally {
    await ws.cleanup();
  }
});

Deno.test("acknowledgePriorArt rejects a subset and names the missing URL", async () => {
  const url = "https://github.com/acme/widget/pull/7";
  const ws = await buildWorkspace({
    slug: "ack-subset",
    state: { phase: "repo", checks: { repo: { passed: true, ranAt: "x" } } },
  });
  const ctx = ctxFor(ws);
  try {
    await scanPriorArtImpl(oneHitRunner(url), {
      slug: ws.slug,
      terms: ["distinct"],
    }, ctx);
    let msg = "";
    try {
      await runMethod("acknowledgePriorArt", { slug: ws.slug, urls: [] }, ctx);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes(url), `rejection must name the missing URL: ${msg}`);
    // The gate is still shut.
    assertFalse((await gateOf(ctx, ws.slug)).satisfied);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("a fresh scan drops a prior acknowledgement so an identical re-scan re-blocks", async () => {
  const url = "https://github.com/acme/widget/pull/7";
  const ws = await buildWorkspace({
    slug: "ack-rescan",
    state: { phase: "repo", checks: { repo: { passed: true, ranAt: "x" } } },
  });
  const ctx = ctxFor(ws);
  try {
    // Scan, acknowledge → gate open.
    await scanPriorArtImpl(oneHitRunner(url), {
      slug: ws.slug,
      terms: ["distinct aggregate"],
    }, ctx);
    await runMethod("acknowledgePriorArt", { slug: ws.slug, urls: [url] }, ctx);
    assert((await gateOf(ctx, ws.slug)).satisfied);

    // Re-scan with the SAME terms and SAME hit, so the hit-set fingerprint is
    // unchanged. The ONLY thing that can re-block is scanPriorArt having dropped
    // the acknowledgement — this isolates the drop from a fingerprint mismatch,
    // which a different hit set would also cause (and would pass even if the
    // ack were carried forward).
    await scanPriorArtImpl(oneHitRunner(url), {
      slug: ws.slug,
      terms: ["distinct aggregate"],
    }, ctx);
    const g = await gateOf(ctx, ws.slug);
    assertFalse(
      g.satisfied,
      "an identical re-scan must still re-block — the ack was dropped, not carried",
    );
    assert(g.blockers.some((b) => b.rule === "gate/prior-art-unadjudicated"));
  } finally {
    await ws.cleanup();
  }
});

Deno.test("acknowledgePriorArt before any scan throws the named error", async () => {
  const ws = await buildWorkspace({
    slug: "ack-noscan",
    state: { phase: "repo" },
  });
  const ctx = ctxFor(ws);
  try {
    let msg = "";
    try {
      await runMethod("acknowledgePriorArt", { slug: ws.slug, urls: [] }, ctx);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("scanPriorArt"), msg);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("acknowledgePriorArt rejects an unexpected URL not in the scanned set", async () => {
  const url = "https://github.com/acme/widget/pull/7";
  const ws = await buildWorkspace({
    slug: "ack-extra",
    state: { phase: "repo", checks: { repo: { passed: true, ranAt: "x" } } },
  });
  const ctx = ctxFor(ws);
  try {
    await scanPriorArtImpl(oneHitRunner(url), {
      slug: ws.slug,
      terms: ["distinct"],
    }, ctx);
    const extra = "https://github.com/acme/widget/pull/999";
    let msg = "";
    try {
      // The scanned hit is present, but an extra URL that was never a hit is
      // supplied — the equality check must reject it, naming the unexpected URL.
      await runMethod("acknowledgePriorArt", {
        slug: ws.slug,
        urls: [url, extra],
      }, ctx);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(
      msg.includes(extra),
      `rejection must name the unexpected URL: ${msg}`,
    );
    assertFalse((await gateOf(ctx, ws.slug)).satisfied);
  } finally {
    await ws.cleanup();
  }
});

// ---------- prior-art record schema ------------------------------------------

// The priorArt check record carries fields the other four checks do not, and
// readState re-parses every stored blob through SubmissionStateSchema on every
// read. These lock the two zod behaviours that both bite: an unknown key is
// stripped silently (so an absent field must be in the schema, not just at the
// writer), and a present object missing a required inner field throws on parse
// (so every acknowledgement sub-field must be optional).

Deno.test("SubmissionStateSchema keeps the prior-art hit-count and fingerprint", () => {
  const state = {
    ...baseState(),
    checks: {
      priorArt: {
        passed: false,
        ranAt: "2026-07-18T00:00:00.000Z",
        hitCount: 2,
        hitFingerprint: "deadbeef",
        truncated: false,
      },
    },
  };
  const parsed = SubmissionStateSchema.parse(state);
  assertEquals(parsed.checks.priorArt?.hitCount, 2);
  assertEquals(parsed.checks.priorArt?.hitFingerprint, "deadbeef");
  assertEquals(parsed.checks.priorArt?.truncated, false);
});

Deno.test("SubmissionStateSchema keeps a fully populated acknowledgement", () => {
  const ack = {
    fingerprint: "deadbeef",
    urls: ["https://github.com/acme/widget/pull/1"],
    acknowledgedAt: "2026-07-18T00:00:00.000Z",
    note: "reviewed with the user; distinct enough",
  };
  const parsed = SubmissionStateSchema.parse({
    ...baseState(),
    checks: {
      priorArt: {
        passed: true,
        ranAt: "2026-07-18T00:00:00.000Z",
        hitCount: 1,
        hitFingerprint: "deadbeef",
        acknowledgement: ack,
      },
    },
  });
  assertEquals(parsed.checks.priorArt?.acknowledgement, ack);
});

Deno.test("SubmissionStateSchema parses a priorArt acknowledgement missing note", () => {
  const parsed = SubmissionStateSchema.parse({
    ...baseState(),
    checks: {
      priorArt: {
        passed: true,
        ranAt: "2026-07-18T00:00:00.000Z",
        hitCount: 1,
        hitFingerprint: "deadbeef",
        acknowledgement: {
          fingerprint: "deadbeef",
          urls: ["https://github.com/acme/widget/pull/1"],
          acknowledgedAt: "2026-07-18T00:00:00.000Z",
        },
      },
    },
  });
  assertEquals(parsed.checks.priorArt?.acknowledgement?.note, undefined);
  assertEquals(parsed.checks.priorArt?.acknowledgement?.urls?.length, 1);
});

Deno.test("SubmissionStateSchema still parses a legacy plain priorArt record", () => {
  const parsed = SubmissionStateSchema.parse({
    ...baseState(),
    checks: {
      priorArt: { passed: true, ranAt: "2026-07-18T00:00:00.000Z" },
    },
  });
  assertEquals(parsed.checks.priorArt?.passed, true);
  assertEquals(parsed.checks.priorArt?.hitCount, undefined);
});

// ---------- startSubmission idempotency --------------------------------------

Deno.test("startSubmission stores a canonical repo URL and is idempotent on re-run", async () => {
  const root = await Deno.makeTempDir({ prefix: "olympus-start-" });
  const ctx = fakeCtx({ globalArgs: { path: root } });
  try {
    // First create from a bare owner/repo — must be normalised on the way in.
    await runMethod(
      "startSubmission",
      { slug: "widget", repoUrl: "acme/widget" },
      ctx,
    );
    const first = ctx.store.get(dataName("widget", "state"))!;
    assertEquals(first.repoUrl, "https://github.com/acme/widget");
    assertEquals(first.phase, "repo");

    // Re-running the identical create must NOT throw — it returns the existing
    // submission. A .git-suffixed / full-URL spelling of the same repo is the
    // same submission.
    await runMethod(
      "startSubmission",
      { slug: "widget", repoUrl: "https://github.com/acme/widget.git" },
      ctx,
    );
    const again = ctx.store.get(dataName("widget", "state"))!;
    assertEquals(again.phase, "repo");
    assertEquals(again.repoUrl, "https://github.com/acme/widget");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("startSubmission rejects a re-run that changes the pinned commit", async () => {
  const root = await Deno.makeTempDir({ prefix: "olympus-start-" });
  const ctx = fakeCtx({ globalArgs: { path: root } });
  try {
    await runMethod(
      "startSubmission",
      { slug: "widget", repoUrl: "acme/widget", commit: "a".repeat(40) },
      ctx,
    );
    let threw = false;
    try {
      await runMethod(
        "startSubmission",
        { slug: "widget", repoUrl: "acme/widget", commit: "b".repeat(40) },
        ctx,
      );
    } catch {
      threw = true;
    }
    assert(threw, "a differing commit on an existing slug must be a conflict");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("checkRepoImpl flags each ineligibility reason", async () => {
  const cases = [
    { override: { private: true }, rule: "repo/private" },
    { override: { archived: true }, rule: "repo/archived" },
    { override: { stargazers_count: 10 }, rule: "repo/stars" },
    { override: { license: { spdx_id: "GPL-3.0" } }, rule: "repo/license" },
    { override: { language: "Haskell" }, rule: "repo/language" },
  ];
  for (const c of cases) {
    const ws = await buildWorkspace({ slug: "wf-inelig" });
    const ctx = ctxFor(ws);
    const run = scriptedRunner(ghApi(eligibleRepo(c.override)));
    try {
      await checkRepoImpl(run, { slug: ws.slug }, ctx);
      const rw = ctx.writes.find((w) => w.spec === "repoCheck");
      assert(rw);
      assertEquals(rw.data.eligible, false, c.rule);
      const findings = rw.data.findings as Array<{ rule: string }>;
      assert(findings.some((f) => f.rule === c.rule), c.rule);
    } finally {
      await ws.cleanup();
    }
  }
});

Deno.test("checkRepoImpl flags an unresolvable ref", async () => {
  const ws = await buildWorkspace({ slug: "wf-ref" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner((call) => {
    if (call.args.some((a) => a.includes("/commits/"))) {
      return failResult(1, "Not Found (HTTP 404)");
    }
    if (call.args.some((a) => a.startsWith("repos/"))) {
      return jsonResult(eligibleRepo());
    }
    return undefined;
  });
  try {
    await checkRepoImpl(run, { slug: ws.slug }, ctx);
    const rw = ctx.writes.find((w) => w.spec === "repoCheck");
    assert(rw);
    assertEquals(rw.data.eligible, false);
    const findings = rw.data.findings as Array<{ rule: string }>;
    assert(findings.some((f) => f.rule === "repo/ref-unresolved"));
  } finally {
    await ws.cleanup();
  }
});

Deno.test("checkPatchesImpl reports when the solution patch does not apply", async () => {
  const ws = await buildWorkspace({ slug: "wf-solfail" });
  const ctx = ctxFor(ws);
  // Fail only the solution apply — its stdin carries the widget.py diff; the
  // test apply (test.sh / test_new.py) still succeeds.
  const run = scriptedRunner((call) =>
    call.args[0] === "apply" &&
      String(call.opts.stdin ?? "").includes("widget.py")
      ? failResult(1, "solution.patch does not apply")
      : undefined
  );
  try {
    await checkPatchesImpl(run, { slug: ws.slug }, ctx);
    const pw = ctx.writes.find((w) => w.spec === "patchCheck");
    assert(pw);
    assertEquals(pw.data.testPatchApplies, true);
    assertEquals(pw.data.solutionPatchApplies, false);
    assertEquals(pw.data.passed, false);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("checkPatchesImpl fails closed when test.patch does not apply", async () => {
  const ws = await buildWorkspace({ slug: "wf-fail" });
  const ctx = ctxFor(ws);
  // Fail only `git apply`; clone/checkout/clean still succeed.
  const run = scriptedRunner((call) =>
    call.args[0] === "apply"
      ? failResult(1, "error: patch does not apply")
      : undefined
  );
  try {
    await checkPatchesImpl(run, { slug: ws.slug }, ctx);
    const patchWrite = ctx.writes.find((w) => w.spec === "patchCheck");
    assert(patchWrite);
    assertEquals(patchWrite.data.passed, false);
    assertEquals(patchWrite.data.testPatchApplies, false);
  } finally {
    await ws.cleanup();
  }
});

// ---------- advance (the gate-enforcement method) ----------------------------

Deno.test("advance refuses to move out of a blocked gate and surfaces the blockers", async () => {
  const ws = await buildWorkspace({
    slug: "adv-block",
    state: { phase: "repo", checks: {} },
  });
  const ctx = ctxFor(ws);
  try {
    let msg = "";
    try {
      await runMethod("advance", { slug: ws.slug }, ctx);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("cannot advance"), msg);
    assert(
      msg.includes("gate/"),
      "the blocker rules must be surfaced in the error",
    );
    const st = SubmissionStateSchema.parse(
      ctx.store.get(dataName(ws.slug, "state")),
    );
    assertEquals(
      st.phase,
      "repo",
      "a blocked advance must not change the phase",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("advance moves to the next phase and records history when the gate is clean", async () => {
  const ws = await buildWorkspace({
    slug: "adv-clean",
    state: {
      phase: "repo",
      checks: {
        repo: { passed: true, ranAt: "x" },
        priorArt: {
          passed: true,
          ranAt: "x",
          hitCount: 0,
          truncated: false,
          hitFingerprint: "clear",
        },
      },
    },
  });
  const ctx = ctxFor(ws);
  try {
    await runMethod("advance", { slug: ws.slug, note: "onward" }, ctx);
    const st = SubmissionStateSchema.parse(
      ctx.store.get(dataName(ws.slug, "state")),
    );
    assertEquals(st.phase, "problem");
    const last = st.history[st.history.length - 1];
    assertEquals(last.from, "repo");
    assertEquals(last.to, "problem");
    assertEquals(last.note, "onward");
  } finally {
    await ws.cleanup();
  }
});

Deno.test("advance refuses from an abandoned submission", async () => {
  const ws = await buildWorkspace({
    slug: "adv-aband",
    state: { phase: "abandoned" },
  });
  const ctx = ctxFor(ws);
  try {
    let threw = false;
    try {
      await runMethod("advance", { slug: ws.slug }, ctx);
    } catch {
      threw = true;
    }
    assert(threw, "advance must refuse from a terminal/abandoned phase");
  } finally {
    await ws.cleanup();
  }
});

// ---------- readRegularFile (untrusted JUnit path) ---------------------------

Deno.test("readRegularFile reads a regular file but refuses to follow a symlink", async () => {
  const dir = await Deno.makeTempDir({ prefix: "olympus-rrf-" });
  try {
    const real = `${dir}/real.xml`;
    await Deno.writeTextFile(real, "<junit/>");
    assertEquals(await readRegularFile(real), "<junit/>");

    // test.sh is untrusted; a symlink planted at the out path must NOT be read.
    const secret = `${dir}/secret.txt`;
    await Deno.writeTextFile(secret, "SECRET");
    const link = `${dir}/link.xml`;
    await Deno.symlink(secret, link);
    assertEquals(await readRegularFile(link), null);

    assertEquals(await readRegularFile(`${dir}/absent.xml`), null);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ---------- more scanPriorArt + checkRepo paths ------------------------------

Deno.test("checkRepoImpl fails closed when pushed_at is absent", async () => {
  const ws = await buildWorkspace({ slug: "wf-repo-nopush" });
  const ctx = ctxFor(ws);
  // pushed_at absent → String(?? "") → "" → POSITIVE_INFINITY: a distinct branch
  // from the unparseable-NaN case.
  const run = scriptedRunner(ghApi(eligibleRepo({ pushed_at: undefined })));
  try {
    await checkRepoImpl(run, { slug: ws.slug }, ctx);
    const rw = ctx.writes.find((w) => w.spec === "repoCheck");
    assert(rw);
    assertEquals(rw.data.eligible, false);
    const findings = rw.data.findings as Array<{ rule: string }>;
    assert(findings.some((f) => f.rule === "repo/inactive"));
    assertEquals(rw.data.monthsSinceLastPush, null);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("scanPriorArt recovers after a transient rate-limit", async () => {
  const ws = await buildWorkspace({ slug: "pa-recover" });
  const ctx = ctxFor(ws);
  let firstSearch = true;
  const run = scriptedRunner((call) => {
    if (firstSearch && call.args.includes("search/issues")) {
      firstSearch = false; // 403 once, then let the retry through
      return failResult(403, "gh: API rate limit exceeded (HTTP 403)");
    }
    if (call.args.includes("graphql")) {
      return jsonResult({ data: { search: { nodes: [] } } });
    }
    if (call.args.includes("search/issues")) return jsonResult({ items: [] });
    return undefined;
  });
  try {
    await scanPriorArtImpl(run, { slug: ws.slug, terms: ["x"] }, ctx, {
      sleep: () => Promise.resolve(),
      rateLimitBackoffMs: [0, 0, 0],
    });
    const pa = priorArtCheck(ctx, ws.slug);
    assertEquals(pa?.hitCount, 0);
    assertEquals(pa?.passed, true);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("scanPriorArt records a discussion hit and classifies a merged PR", async () => {
  const ws = await buildWorkspace({ slug: "pa-disc" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner((call) => {
    if (call.args.includes("graphql")) {
      return jsonResult({
        data: {
          search: {
            nodes: [{
              title: "design ruling",
              url: "https://github.com/acme/widget/discussions/3",
              updatedAt: "2020",
              category: { name: "Ideas" },
            }],
          },
        },
      });
    }
    if (call.args.some((a) => a.includes("is:pr"))) {
      return jsonResult({
        items: [{
          html_url: "https://github.com/acme/widget/pull/12",
          title: "did it",
          state: "closed",
          pull_request: { merged_at: "2021-01-01T00:00:00Z" },
          updated_at: "2021",
        }],
      });
    }
    if (call.args.includes("search/issues")) return jsonResult({ items: [] });
    return undefined;
  });
  try {
    await scanPriorArtImpl(run, { slug: ws.slug, terms: ["x"] }, ctx);
    const paResource = ctx.writes.find((w) => w.spec === "priorArt");
    assert(paResource);
    const hits = paResource.data.hits as Array<
      { kind: string; state?: string }
    >;
    const disc = hits.find((h) => h.kind === "discussion");
    assert(disc, "a discussion hit must be recorded");
    assertEquals(disc.state, "Ideas");
    const pr = hits.find((h) => h.kind === "pr");
    assert(pr);
    assertEquals(
      pr.state,
      "merged",
      "a PR with merged_at resolves to 'merged'",
    );
    assertEquals(paResource.data.discussionCount, 1);
  } finally {
    await ws.cleanup();
  }
});

// ---------- bundle (final readiness gate) ------------------------------------

Deno.test("bundle reports not-ready when the local review is not green", async () => {
  const ws = await buildWorkspace({ slug: "bundle-blocked" });
  const ctx = ctxFor(ws);
  try {
    await runMethod("bundle", { slug: ws.slug }, ctx);
    const bw = ctx.writes.find((w) => w.spec === "bundle");
    assert(bw);
    assertEquals(bw.data.ready, false);
    const rules = (bw.data.blockers as Array<{ rule: string }>).map((b) =>
      b.rule
    );
    assert(rules.includes("bundle/review"), JSON.stringify(rules));
  } finally {
    await ws.cleanup();
  }
});

Deno.test("bundle reports not-ready when an artifact is missing", async () => {
  const ws = await buildWorkspace({
    slug: "bundle-missing",
    artifacts: { dockerfile: null },
  });
  const ctx = ctxFor(ws);
  try {
    await runMethod("bundle", { slug: ws.slug }, ctx);
    const bw = ctx.writes.find((w) => w.spec === "bundle");
    assert(bw);
    assertEquals(bw.data.ready, false);
    const rules = (bw.data.blockers as Array<{ rule: string }>).map((b) =>
      b.rule
    );
    assert(rules.includes("bundle/missing"), JSON.stringify(rules));
  } finally {
    await ws.cleanup();
  }
});

Deno.test("bundle reports ready when artifacts are clean and the review is green", async () => {
  const commit = "c".repeat(40);
  const artifacts = {
    problem: GOOD_PROBLEM,
    testPatch: GOOD_TEST_PATCH,
    solutionPatch: GOOD_SOLUTION_PATCH,
    dockerfile: GOOD_DOCKERFILE,
  };
  const rf = await reviewFingerprint(artifacts, commit);
  const ws = await buildWorkspace({
    slug: "bundle-ready",
    commit,
    artifacts,
    state: {
      commit,
      checks: { review: { passed: true, ranAt: "x", fingerprint: rf } },
    },
  });
  const ctx = ctxFor(ws);
  try {
    await runMethod("bundle", { slug: ws.slug }, ctx);
    const bw = ctx.writes.find((w) => w.spec === "bundle");
    assert(bw);
    assertEquals(bw.data.ready, true, JSON.stringify(bw.data.blockers));
  } finally {
    await ws.cleanup();
  }
});

// ---------- preflight + lifecycle smoke --------------------------------------

Deno.test("preflight flips passed=false on a missing artifact", async () => {
  const ws = await buildWorkspace({
    slug: "pf-missing",
    artifacts: { solutionPatch: null },
  });
  const ctx = ctxFor(ws);
  try {
    await runMethod("preflight", { slug: ws.slug }, ctx);
    const pw = ctx.writes.find((w) => w.spec === "preflight");
    assert(pw);
    assertEquals(pw.data.passed, false);
    assert((pw.data.artifactsMissing as string[]).includes("solution.patch"));
  } finally {
    await ws.cleanup();
  }
});

Deno.test("preflight flips passed=false on an error-level lint finding", async () => {
  // Only the problem is broken (headings/bullets are errors); the other three
  // are clean, so passed=false is attributable to the problem lint alone.
  const ws = await buildWorkspace({
    slug: "pf-lint",
    artifacts: {
      problem: "## Task\n\n- do the thing",
      testPatch: GOOD_TEST_PATCH,
      solutionPatch: GOOD_SOLUTION_PATCH,
      dockerfile: GOOD_DOCKERFILE,
    },
  });
  const ctx = ctxFor(ws);
  try {
    await runMethod("preflight", { slug: ws.slug }, ctx);
    const pw = ctx.writes.find((w) => w.spec === "preflight");
    assert(pw);
    assertEquals(pw.data.passed, false);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("abandon closes a submission from any phase with a reason", async () => {
  const ws = await buildWorkspace({
    slug: "ab-smoke",
    state: { phase: "tests" },
  });
  const ctx = ctxFor(ws);
  try {
    await runMethod("abandon", { slug: ws.slug, reason: "superseded" }, ctx);
    const st = SubmissionStateSchema.parse(
      ctx.store.get(dataName(ws.slug, "state")),
    );
    assertEquals(st.phase, "abandoned");
    assertEquals(st.abandonReason, "superseded");
  } finally {
    await ws.cleanup();
  }
});

// ---------- Phase 5 code-review fixes ----------------------------------------

Deno.test("the localReview method's arg schema accepts rootInContainer", () => {
  // deno-lint-ignore no-explicit-any
  const schema = (model.methods as any).localReview.arguments;
  const parsed = schema.parse({ slug: "x", rootInContainer: true });
  assertEquals(
    parsed.rootInContainer,
    true,
    "the opt-out must survive parsing",
  );
});

Deno.test("localReview does not credit a permission crash printed to stderr while stdout has output", async () => {
  const ws = await buildWorkspace({ slug: "lr-perm-stderr" });
  const ctx = ctxFor(ws);
  // new-before-solution exits non-zero, but with test output on stdout AND the
  // permission crash on stderr — a stdout-only classifier would miss it.
  const run = reviewRunner((call) =>
    call.args.some((a) => a.includes("new-before-solution.xml"))
      ? {
        code: 1,
        stdout: "collecting tests ...",
        stderr: "bash: ./test.sh: Permission denied",
      }
      : undefined
  );
  try {
    await localReviewImpl(run, { slug: ws.slug }, ctx);
    const rr = reviewResultOf(ctx);
    assertEquals(rr.verdict, "fail");
    assert(
      (rr.failedStages as string[]).includes("new-before-solution"),
      "a stderr-only permission crash must not be credited as the expected failure",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("scanPriorArt marks a scan truncated when GitHub reports incomplete_results", async () => {
  const ws = await buildWorkspace({ slug: "pa-incomplete" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner((call) => {
    if (call.args.includes("graphql")) {
      return jsonResult({ data: { search: { nodes: [] } } });
    }
    if (call.args.includes("search/issues")) {
      // Zero items but the search backend timed out — must not read as clear.
      return jsonResult({ incomplete_results: true, items: [] });
    }
    return undefined;
  });
  try {
    await scanPriorArtImpl(run, { slug: ws.slug, terms: ["x"] }, ctx);
    const pa = priorArtCheck(ctx, ws.slug);
    assertEquals(pa?.truncated, true);
    assertEquals(pa?.hitCount, 0);
  } finally {
    await ws.cleanup();
  }
});

Deno.test("checkRepoImpl confirms the pinned commit on a ref-less re-run, not HEAD", async () => {
  const pin = "a".repeat(40);
  const ws = await buildWorkspace({ slug: "repo-pin", commit: pin });
  const ctx = ctxFor(ws);
  const run = scriptedRunner(ghApi(eligibleRepo({ default_branch: "main" })));
  try {
    await checkRepoImpl(run, { slug: ws.slug }, ctx); // no ref
    // The commit resolution must have used the existing pin, never the default
    // branch — otherwise a re-checkRepo silently re-pins to HEAD.
    assert(
      run.calls.some((c) => c.args.some((a) => a.includes("commits/" + pin))),
      "ref-less checkRepo must resolve the pinned commit",
    );
    assertFalse(
      run.calls.some((c) => c.args.some((a) => a.includes("commits/main"))),
      "ref-less checkRepo must not resolve the default branch when a pin exists",
    );
  } finally {
    await ws.cleanup();
  }
});

Deno.test("priorArtFingerprint does not collide a term with the section boundary or a hit", async () => {
  // Without tagged sections + counts, ["a","hit-boundary"] with no hits would
  // hash the same as ["a"] with a hit whose url is "hit-boundary".
  const a = await priorArtFingerprint(["a", "hit-boundary"], []);
  const b = await priorArtFingerprint(["a"], [{ url: "hit-boundary" }]);
  assert(a !== b, "a term must never masquerade as the boundary or a hit");
  // A url and a state must not be able to swap the boundary between them.
  const c = await priorArtFingerprint([], [{ url: "ab", state: "c" }]);
  const d = await priorArtFingerprint([], [{ url: "a", state: "bc" }]);
  assert(c !== d, "url and state must be unambiguously delimited");
});

Deno.test("startSubmission rejects a commit that would be read by git as a flag", async () => {
  const root = await Deno.makeTempDir({ prefix: "olympus-badcommit-" });
  const ctx = fakeCtx({ globalArgs: { path: root } });
  try {
    let threw = false;
    try {
      await runMethod("startSubmission", {
        slug: "w",
        repoUrl: "acme/widget",
        commit: "--exec=evil",
      }, ctx);
    } catch {
      threw = true;
    }
    assert(threw, "a leading-dash commit must be rejected");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("startSubmission treats a case-different owner/repo as the same submission", async () => {
  const root = await Deno.makeTempDir({ prefix: "olympus-case-" });
  const ctx = fakeCtx({ globalArgs: { path: root } });
  try {
    await runMethod("startSubmission", {
      slug: "w",
      repoUrl: "acme/widget",
    }, ctx);
    // Re-create with different casing — GitHub owner/repo are case-insensitive,
    // so this is the same submission, not a conflict.
    let threw = false;
    try {
      await runMethod("startSubmission", {
        slug: "w",
        repoUrl: "https://github.com/ACME/Widget",
      }, ctx);
    } catch {
      threw = true;
    }
    assertFalse(
      threw,
      "case-different owner/repo must not be a spurious conflict",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("scanPriorArt fails when gh returns a non-object JSON body", async () => {
  const ws = await buildWorkspace({ slug: "pa-null" });
  const ctx = ctxFor(ws);
  // gh exits 0 but writes bare `null`; a dereference of res.items would throw a
  // generic TypeError, so ghSearchJson must reject it with a clear error.
  const run = scriptedRunner((call) =>
    call.args.includes("search/issues")
      ? { code: 0, stdout: "null" }
      : (call.args.includes("graphql")
        ? jsonResult({ data: { search: { nodes: [] } } })
        : undefined)
  );
  try {
    let threw = false;
    try {
      await scanPriorArtImpl(run, { slug: ws.slug, terms: ["x"] }, ctx);
    } catch {
      threw = true;
    }
    assert(threw, "a non-object JSON body must fail the scan cleanly");
    assertFalse(ctx.writes.some((w) => w.spec === "priorArt"));
  } finally {
    await ws.cleanup();
  }
});

Deno.test("readRegularFile skips a file over the size cap", async () => {
  const dir = await Deno.makeTempDir({ prefix: "olympus-cap-" });
  try {
    const path = `${dir}/big.xml`;
    await Deno.writeTextFile(path, "01234567890"); // 11 bytes
    assertEquals(
      await readRegularFile(path, 10),
      null,
      "over-cap file skipped",
    );
    assertEquals(await readRegularFile(path, 100), "01234567890");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("checkRepoImpl rejects a ref containing path traversal", async () => {
  const ws = await buildWorkspace({ slug: "repo-badref" });
  const ctx = ctxFor(ws);
  const run = scriptedRunner(ghApi(eligibleRepo()));
  try {
    let threw = false;
    try {
      await checkRepoImpl(run, { slug: ws.slug, ref: "../../secret" }, ctx);
    } catch {
      threw = true;
    }
    assert(threw, "a ref containing .. must be rejected");
    assertEquals(run.calls.length, 0, "must reject before any gh call");
  } finally {
    await ws.cleanup();
  }
});
