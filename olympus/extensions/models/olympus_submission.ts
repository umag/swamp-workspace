import { z } from "npm:zod@4";
import {
  ALLOWED_LANGUAGES,
  ALLOWED_LICENSES,
  BASE_IMAGES,
  CheckRecordSchema,
  type CommandRunner,
  countEffectiveLoc,
  defaultRunner,
  dirExists,
  type Finding,
  FindingSchema,
  ghJson,
  hasErrors,
  LANGUAGE_TO_BASE,
  lintDockerfileText,
  lintProblemText,
  lintSolutionPatch,
  lintTestPatch,
  parseJUnit,
  parseRepoUrl,
  parseUnifiedDiff,
  PHASES,
  PriorArtRecordSchema,
  readIfExists,
  REVIEW_DOCKERFILE,
  sha256,
  SUBMISSIONS_DIR,
  summarise,
  tail,
} from "./lib/checks.ts";

// =============================================================================
// @magistr/olympus/submission
//
// State model over a Project Olympus (https://shipd.ai/quests/olympus)
// challenge-authoring workspace. One submission per directory under
// `submissions/<slug>/`, holding the artifacts a submission is made of:
//
//   problem.md      the task, written as a maintainer would write an issue
//   test.patch      unified diff: test.sh + the new/modified tests
//   solution.patch  unified diff: the reference implementation
//   Dockerfile      the environment everything runs in
//
// The repo URL and pinned commit SHA live in the submission state.
//
// The model owns the state and the checks. Writing the artifacts is the
// author's job (Claude's, via the bundled `olympus` skill); this model decides
// whether what is on disk clears the documented bar, and reproduces the
// reviewer's local-review loop in Docker so failures are found before tokens
// are spent on platform checks.
//
// Lifecycle:
//   repo -> problem -> tests -> solution -> dockerfile -> review -> ready
//        -> submitted        (abandon from any state)
//
// `advance` re-runs every text-only validator live and refuses to move unless
// the current phase's gate is clean. Gates that need a clone or a container
// (repo eligibility, prior art, patch application, local review) are satisfied
// by a recorded pass whose artifact fingerprint still matches disk, so editing
// an artifact after a green run reopens the gate instead of coasting on it.
// =============================================================================

const GlobalArgsSchema = z.object({
  path: z.string().describe(
    "Absolute path to the Olympus workspace root (the directory containing submissions/)",
  ),
  dockerBin: z.string().optional().describe(
    "Docker executable used for the local review (default: docker)",
  ),
  ghBin: z.string().optional().describe(
    "GitHub CLI executable used for repo eligibility and prior-art scans (default: gh)",
  ),
  gitBin: z.string().optional().describe(
    "Git executable used for cloning and applying patches (default: git)",
  ),
  buildTimeoutSeconds: z.number().optional().describe(
    "Timeout for a single docker build, in seconds (default: 2400)",
  ),
  testTimeoutSeconds: z.number().optional().describe(
    "Timeout for a single test.sh run inside the container, in seconds (default: 1800)",
  ),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const dockerBin = (g: GlobalArgs) => g.dockerBin ?? "docker";
const ghBin = (g: GlobalArgs) => g.ghBin ?? "gh";
const gitBin = (g: GlobalArgs) => g.gitBin ?? "git";
const buildTimeout = (g: GlobalArgs) => g.buildTimeoutSeconds ?? 2400;
const testTimeout = (g: GlobalArgs) => g.testTimeoutSeconds ?? 1800;

// ---------- Resource schemas -------------------------------------------------

const PhaseSchema = z.enum([...PHASES, "abandoned"]);

const TransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  at: z.string(),
  note: z.string().optional(),
});

export const SubmissionStateSchema = z.object({
  slug: z.string(),
  repoUrl: z.string(),
  owner: z.string(),
  repo: z.string(),
  commit: z.string().optional().describe(
    "The pinned commit SHA the task lives at",
  ),
  issueUrl: z.string().optional(),
  language: z.string().optional(),
  baseImage: z.string().optional(),
  phase: PhaseSchema,
  dir: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(TransitionSchema),
  checks: z.object({
    repo: CheckRecordSchema.optional(),
    priorArt: PriorArtRecordSchema.optional(),
    preflight: CheckRecordSchema.optional(),
    patches: CheckRecordSchema.optional(),
    review: CheckRecordSchema.optional(),
  }),
  abandonReason: z.string().optional(),
});

type SubmissionState = z.infer<typeof SubmissionStateSchema>;

const RepoCheckSchema = z.object({
  slug: z.string(),
  repoUrl: z.string(),
  eligible: z.boolean(),
  owner: z.string(),
  repo: z.string(),
  stars: z.number(),
  pushedAt: z.string(),
  monthsSinceLastPush: z.number().nullable().describe(
    "Months since the last push, or null when pushed_at is absent or unparseable (which itself fails the activity gate).",
  ),
  license: z.string(),
  language: z.string(),
  archived: z.boolean(),
  isPrivate: z.boolean(),
  suggestedBaseImage: z.string().optional(),
  resolvedCommit: z.string().optional(),
  resolvedCommitDate: z.string().optional(),
  findings: z.array(FindingSchema),
  checkedAt: z.string(),
});

const PriorArtHitSchema = z.object({
  kind: z.enum(["pr", "issue", "discussion"]),
  title: z.string(),
  url: z.string(),
  state: z.string().optional(),
  updatedAt: z.string().optional(),
  matchedTerm: z.string(),
});

const PriorArtSchema = z.object({
  slug: z.string(),
  repoUrl: z.string(),
  terms: z.array(z.string()),
  hits: z.array(PriorArtHitSchema),
  prCount: z.number(),
  issueCount: z.number(),
  discussionCount: z.number(),
  verdict: z.enum(["clear", "review-required"]),
  note: z.string(),
  scannedAt: z.string(),
});

const SectionSchema = z.object({
  present: z.boolean(),
  findings: z.array(FindingSchema),
  summary: z.string(),
});

const PreflightSchema = z.object({
  slug: z.string(),
  passed: z.boolean(),
  fingerprint: z.string(),
  artifactsPresent: z.array(z.string()),
  artifactsMissing: z.array(z.string()),
  problem: SectionSchema,
  tests: SectionSchema,
  solution: SectionSchema,
  dockerfile: SectionSchema,
  loc: z.object({
    rawAdded: z.number(),
    effective: z.number(),
    files: z.array(z.object({
      path: z.string(),
      added: z.number(),
      effective: z.number(),
      excluded: z.string().optional(),
    })),
  }),
  ranAt: z.string(),
});

const PatchCheckSchema = z.object({
  slug: z.string(),
  passed: z.boolean(),
  fingerprint: z.string(),
  commit: z.string(),
  repoDir: z.string(),
  testPatchApplies: z.boolean(),
  solutionPatchApplies: z.boolean(),
  testPatchError: z.string().optional(),
  solutionPatchError: z.string().optional(),
  filesTouchedByTests: z.array(z.string()),
  filesTouchedBySolution: z.array(z.string()),
  loc: z.object({ rawAdded: z.number(), effective: z.number() }),
  findings: z.array(FindingSchema),
  ranAt: z.string(),
});

const ReviewStageSchema = z.object({
  name: z.string(),
  description: z.string(),
  expectation: z.string(),
  exitCode: z.number(),
  ok: z.boolean(),
  durationSeconds: z.number(),
  junit: z.object({
    tests: z.number(),
    failures: z.number(),
    errors: z.number(),
    skipped: z.number(),
    parsed: z.boolean(),
  }).optional(),
  outputTail: z.string(),
});

const ReviewResultSchema = z.object({
  slug: z.string(),
  verdict: z.enum(["pass", "fail"]),
  fingerprint: z.string(),
  commit: z.string(),
  image: z.string(),
  stages: z.array(ReviewStageSchema),
  failedStages: z.array(z.string()),
  note: z.string(),
  durationSeconds: z.number(),
  containerUser: z.string().optional().describe(
    "The uid:gid the test containers ran as, or a 'root ...' marker when the host uid was unavailable or the --user opt-out was set. Recorded here (not on the plain state check record, which would strip it).",
  ),
  ranAt: z.string(),
});

const GateSchema = z.object({
  phase: z.string(),
  satisfied: z.boolean(),
  blockers: z.array(FindingSchema),
});

const SubmissionStatusSchema = z.object({
  slug: z.string(),
  phase: PhaseSchema,
  repoUrl: z.string(),
  commit: z.string().optional(),
  gate: GateSchema,
  nextPhase: z.string().optional(),
  nextAction: z.string(),
  artifacts: z.array(z.object({
    file: z.string(),
    present: z.boolean(),
    bytes: z.number(),
  })),
  checks: z.array(z.object({
    name: z.string(),
    state: z.enum(["passed", "failed", "stale", "never-run"]),
    ranAt: z.string().optional(),
  })),
  effectiveLoc: z.number().optional(),
  checkedAt: z.string(),
});

const WorkspaceSchema = z.object({
  path: z.string(),
  submissions: z.array(z.object({
    slug: z.string(),
    phase: z.string(),
    repoUrl: z.string(),
    commit: z.string().optional(),
    updatedAt: z.string(),
  })),
  byPhase: z.array(z.object({ phase: z.string(), count: z.number() })),
  scannedAt: z.string(),
});

const InitResultSchema = z.object({
  path: z.string(),
  created: z.array(z.string()),
  existing: z.array(z.string()),
  initializedAt: z.string(),
});

const BundleSchema = z.object({
  slug: z.string(),
  ready: z.boolean(),
  repoUrl: z.string(),
  commit: z.string(),
  problemDescription: z.string(),
  testPatch: z.string(),
  solutionPatch: z.string(),
  dockerfile: z.string(),
  effectiveLoc: z.number(),
  blockers: z.array(FindingSchema),
  builtAt: z.string(),
});

// ---------- State helpers ----------------------------------------------------

/**
 * `readResource` is keyed on the instance name alone — it is not scoped per
 * spec — so every data name carries its kind as a suffix, otherwise two specs
 * writing the same slug would share (and clobber) one storage path.
 */
function dataName(slug: string, kind: string): string {
  return `${slug}.${kind}`;
}

export type Ctx = {
  globalArgs: GlobalArgs;
  logger: { info: (msg: string, data?: Record<string, unknown>) => void };
  readResource?: (
    name: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

async function readState(
  context: Ctx,
  slug: string,
): Promise<SubmissionState | null> {
  const raw = await context.readResource!(dataName(slug, "state"));
  if (!raw) return null;
  // Re-parse through the schema so defaults backfill for older instances.
  return SubmissionStateSchema.parse(raw);
}

async function requireState(
  context: Ctx,
  slug: string,
): Promise<SubmissionState> {
  const state = await readState(context, slug);
  if (!state) {
    throw new Error(
      `No submission "${slug}" — create it with the startSubmission method`,
    );
  }
  return state;
}

async function writeState(
  context: Ctx,
  state: SubmissionState,
): Promise<{ name: string }> {
  state.updatedAt = new Date().toISOString();
  return await context.writeResource(
    "submissionState",
    dataName(state.slug, "state"),
    state as unknown as Record<string, unknown>,
  );
}

function submissionDir(root: string, slug: string): string {
  return `${root}/${SUBMISSIONS_DIR}/${slug}`;
}

interface Artifacts {
  problem: string | null;
  testPatch: string | null;
  solutionPatch: string | null;
  dockerfile: string | null;
}

async function readArtifacts(dir: string): Promise<Artifacts> {
  return {
    problem: await readIfExists(`${dir}/problem.md`),
    testPatch: await readIfExists(`${dir}/test.patch`),
    solutionPatch: await readIfExists(`${dir}/solution.patch`),
    dockerfile: await readIfExists(`${dir}/Dockerfile`),
  };
}

/**
 * Fingerprint of the artifacts a check depends on, for staleness detection.
 *
 * Parts are joined on an explicit NUL delimiter so ["ab", "c"] cannot collide
 * with ["a", "bc"]; a missing artifact uses a sentinel so it hashes
 * differently from one that exists but is empty.
 */
function fingerprint(
  parts: Array<string | null | undefined>,
): Promise<string> {
  return sha256(parts.map((p) => p ?? "\u0002absent").join("\u0000"));
}

export function patchFingerprint(
  a: Artifacts,
  commit?: string,
): Promise<string> {
  return fingerprint([a.testPatch, a.solutionPatch, commit]);
}

export function reviewFingerprint(
  a: Artifacts,
  commit?: string,
): Promise<string> {
  return fingerprint([a.testPatch, a.solutionPatch, a.dockerfile, commit]);
}

/**
 * Fingerprint of a prior-art hit set: the sorted search terms, then the sorted
 * url+state pairs of the hits. State is included so a PR that merges after an
 * acknowledgement reopens the gate; terms are included so an acknowledgement
 * made against a wide scan cannot be reused by a narrower re-scan. Shared by
 * scanPriorArt (records it) and acknowledgePriorArt (recomputes it) so the two
 * agree by construction.
 */
export function priorArtFingerprint(
  terms: string[],
  hits: Array<{ url: string; state?: string }>,
): Promise<string> {
  // Tag each section and element with a type prefix + a control-char
  // separator and carry the counts, so a term can never masquerade as the
  // term/hit boundary or a hit url+state pair (a plain shared separator would
  // let terms=["hit-boundary"] collide with a hit whose url is "hit-boundary").
  const sep = String.fromCharCode(1);
  const t = [...terms].sort().map((x) => `t${sep}${x}`);
  const h = hits.map((x) => `h${sep}${x.url}${sep}${x.state ?? ""}`).sort();
  return fingerprint([
    `terms=${terms.length}`,
    ...t,
    `hits=${hits.length}`,
    ...h,
  ]);
}

type CheckState = "passed" | "failed" | "stale" | "never-run";

function recordState(
  record: z.infer<typeof CheckRecordSchema> | undefined,
  expected: string,
): CheckState {
  if (!record) return "never-run";
  if (record.fingerprint && record.fingerprint !== expected) return "stale";
  return record.passed ? "passed" : "failed";
}

function blocker(rule: string, message: string): Finding {
  return { rule, severity: "error", message };
}

function errorsOnly(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "error");
}

// ---------- Gate evaluation --------------------------------------------------

/**
 * Evaluate the gate that must be clean to leave `state.phase`. Text-only
 * validators run live off disk; clone- and container-backed checks are
 * satisfied by a recorded pass whose fingerprint still matches.
 */
export async function evaluateGate(
  state: SubmissionState,
  artifacts: Artifacts,
): Promise<z.infer<typeof GateSchema>> {
  const blockers: Finding[] = [];
  const phase = state.phase;
  const pf = await patchFingerprint(artifacts, state.commit);
  const rf = await reviewFingerprint(artifacts, state.commit);

  switch (phase) {
    case "repo": {
      if (!state.commit) {
        blockers.push(blocker(
          "gate/no-commit",
          "no commit SHA pinned — run checkRepo with a ref, or pass one to startSubmission",
        ));
      }
      const repo = state.checks.repo;
      if (!repo) {
        blockers.push(blocker(
          "gate/repo-unchecked",
          "repo eligibility has never been checked — run the checkRepo method",
        ));
      } else if (!repo.passed) {
        blockers.push(blocker(
          "gate/repo-ineligible",
          `repo failed eligibility: ${
            repo.summary ?? "see the repoCheck data"
          }`,
        ));
      }
      const pa = state.checks.priorArt;
      if (!pa) {
        blockers.push(blocker(
          "gate/prior-art-unscanned",
          "prior art has never been scanned — an existing open, merged or closed PR is the top rejection reason; run the scanPriorArt method",
        ));
      } else {
        // Truncation blocks unconditionally, evaluated BEFORE and independently
        // of the emptiness check: a scan that hit its result cap cannot certify
        // a clear result even if the (capped) hit count came back zero.
        if (pa.truncated) {
          blockers.push(blocker(
            "gate/prior-art-truncated",
            "the prior-art scan hit its result cap, so a clear result cannot be trusted — narrow the terms or raise perTerm and re-run scanPriorArt",
          ));
        }
        // ONLY a strictly-numeric hitCount of 0 opens the gate through state
        // alone. A legacy record parses with hitCount === undefined; that must
        // fail closed (never coerced to 0 — that is the original H5 fail-open).
        // Any positive count, or undefined, requires an acknowledgement whose
        // fingerprint recomputes to the scan's hit-set fingerprint.
        if (pa.hitCount !== 0) {
          const ackFp = pa.acknowledgement?.fingerprint;
          const adjudicated = !!pa.hitFingerprint &&
            ackFp === pa.hitFingerprint;
          if (!adjudicated) {
            blockers.push(blocker(
              "gate/prior-art-unadjudicated",
              "prior-art hits have not been adjudicated against the current scan — review each hit with the user and record the decision with the acknowledgePriorArt method",
            ));
          }
        }
      }
      break;
    }
    case "problem": {
      if (artifacts.problem === null) {
        blockers.push(blocker(
          "gate/no-problem",
          "problem.md does not exist in the submission directory",
        ));
        break;
      }
      blockers.push(...errorsOnly(lintProblemText(artifacts.problem)));
      break;
    }
    case "tests": {
      if (artifacts.testPatch === null) {
        blockers.push(blocker(
          "gate/no-test-patch",
          "test.patch does not exist in the submission directory",
        ));
        break;
      }
      blockers.push(...errorsOnly(lintTestPatch(artifacts.testPatch)));
      const st = recordState(state.checks.patches, pf);
      if (st === "never-run") {
        blockers.push(blocker(
          "gate/patches-unchecked",
          "the patches have never been applied against the pinned commit — run the checkPatches method",
        ));
      } else if (st === "stale") {
        blockers.push(blocker(
          "gate/patches-stale",
          "the patches changed since checkPatches last ran — re-run it",
        ));
      } else if (st === "failed") {
        blockers.push(blocker(
          "gate/patches-failed",
          `the patches do not apply cleanly: ${
            state.checks.patches?.summary ?? "see the patchCheck data"
          }`,
        ));
      }
      break;
    }
    case "solution": {
      if (artifacts.solutionPatch === null) {
        blockers.push(blocker(
          "gate/no-solution-patch",
          "solution.patch does not exist in the submission directory",
        ));
        break;
      }
      blockers.push(...errorsOnly(lintSolutionPatch(artifacts.solutionPatch)));
      const st = recordState(state.checks.patches, pf);
      if (st !== "passed") {
        blockers.push(blocker(
          "gate/patches-not-green",
          `checkPatches is ${st} for the current patches — run it against the pinned commit`,
        ));
      }
      break;
    }
    case "dockerfile": {
      if (artifacts.dockerfile === null) {
        blockers.push(blocker(
          "gate/no-dockerfile",
          "Dockerfile does not exist in the submission directory",
        ));
        break;
      }
      blockers.push(...errorsOnly(lintDockerfileText(artifacts.dockerfile)));
      break;
    }
    case "review": {
      const st = recordState(state.checks.review, rf);
      if (st === "never-run") {
        blockers.push(blocker(
          "gate/review-never-run",
          "the local review has never run — run the localReview method",
        ));
      } else if (st === "stale") {
        blockers.push(blocker(
          "gate/review-stale",
          "an artifact changed since the last local review — re-run localReview",
        ));
      } else if (st === "failed") {
        blockers.push(blocker(
          "gate/review-failed",
          `the local review did not pass: ${
            state.checks.review?.summary ?? "see the reviewResult data"
          }`,
        ));
      }
      break;
    }
    case "ready":
    case "submitted":
    case "abandoned":
      break;
  }

  return { phase, satisfied: blockers.length === 0, blockers };
}

export function nextPhase(phase: string): string | undefined {
  const i = (PHASES as readonly string[]).indexOf(phase);
  if (i < 0 || i >= PHASES.length - 1) return undefined;
  return PHASES[i + 1];
}

const NEXT_ACTION: Record<string, string> = {
  repo:
    "Run checkRepo to pin the commit and confirm eligibility, then scanPriorArt. If the scan returns hits, review each one with the user and record the decision with acknowledgePriorArt before advancing; a clear scan needs no acknowledgement.",
  problem:
    "Write problem.md as a maintainer would write an issue — prose, opening with the ask, no headings, bullets or code fences — then run preflight.",
  tests:
    "Write test.sh plus the new tests, generate test.patch with git diff, then run preflight and checkPatches.",
  solution:
    "Write the reference implementation, generate solution.patch, then run preflight and checkPatches.",
  dockerfile:
    "Write the Dockerfile from an approved base image with WORKDIR /app and every dependency installed at build time, then run preflight.",
  review:
    "Run localReview — base must pass and new must fail before the solution, and both must pass after it.",
  ready:
    "Run bundle to emit the submission fields, review the agent runs the way a reviewer would, then submit on platform.",
  submitted: "Nothing left — this submission is closed.",
  abandoned: "This submission was abandoned.",
};

// ---------- Clone / review helpers -------------------------------------------

/**
 * Bring the scratch clone to exactly the pinned commit with a clean tree.
 * Cloning is cached across runs; the checkout is forced and the tree wiped so
 * a review never inherits state from the previous one.
 */
async function prepareClone(
  run: CommandRunner,
  g: GlobalArgs,
  workDir: string,
  repoUrl: string,
  commit: string,
): Promise<string> {
  const git = gitBin(g);
  const repoDir = `${workDir}/repo`;
  await Deno.mkdir(workDir, { recursive: true });

  if (!await dirExists(`${repoDir}/.git`)) {
    const cloned = await run(git, ["clone", repoUrl, repoDir], {
      timeoutSeconds: 900,
    });
    if (cloned.code !== 0) {
      throw new Error(`git clone failed: ${tail(cloned.stderr, 10)}`);
    }
  }

  let co = await run(git, ["checkout", "-f", commit], {
    cwd: repoDir,
    timeoutSeconds: 300,
  });
  if (co.code !== 0) {
    // The commit may post-date the cached clone.
    const fetched = await run(git, ["fetch", "--all", "--tags"], {
      cwd: repoDir,
      timeoutSeconds: 900,
    });
    if (fetched.code !== 0) {
      throw new Error(`git fetch failed: ${tail(fetched.stderr, 10)}`);
    }
    co = await run(git, ["checkout", "-f", commit], {
      cwd: repoDir,
      timeoutSeconds: 300,
    });
    if (co.code !== 0) {
      throw new Error(
        `git checkout ${commit} failed: ${tail(co.stderr, 10)}`,
      );
    }
  }

  const cleaned = await run(git, ["clean", "-ffdx"], {
    cwd: repoDir,
    timeoutSeconds: 300,
  });
  if (cleaned.code !== 0) {
    throw new Error(`git clean failed: ${tail(cleaned.stderr, 10)}`);
  }
  return repoDir;
}

async function applyPatch(
  run: CommandRunner,
  g: GlobalArgs,
  repoDir: string,
  patch: string,
  check: boolean,
): Promise<RunOutcome> {
  const args = ["apply", "--whitespace=nowarn"];
  if (check) args.push("--check");
  args.push("-");
  const res = await run(gitBin(g), args, {
    cwd: repoDir,
    stdin: patch,
    timeoutSeconds: 300,
  });
  return {
    ok: res.code === 0,
    error: res.code === 0 ? undefined : tail(res.stderr, 15) ||
      tail(res.stdout, 15),
  };
}

interface RunOutcome {
  ok: boolean;
  error?: string;
}

// ---------- Shell-driving method implementations -----------------------------
// Each takes the CommandRunner as an explicit first parameter so tests can
// substitute a scripted fake; the model's execute wrappers call them with
// defaultRunner. The runner is threaded on through ghJson / prepareClone /
// applyPatch and the direct docker invocations.

export async function checkPatchesImpl(
  run: CommandRunner,
  args: { slug: string },
  context: Ctx,
) {
  const g = context.globalArgs;
  const state = await requireState(context, args.slug);
  if (!state.commit) {
    throw new Error(
      `submission "${args.slug}" has no pinned commit — run checkRepo first`,
    );
  }
  const a = await readArtifacts(state.dir);
  if (a.testPatch === null) {
    throw new Error(`${state.dir}/test.patch does not exist`);
  }

  const repoDir = await prepareClone(
    run,
    g,
    `${state.dir}/.work`,
    state.repoUrl,
    state.commit,
  );

  const findings: Finding[] = [];
  const testApply = await applyPatch(run, g, repoDir, a.testPatch, false);
  if (!testApply.ok) {
    findings.push(blocker(
      "patches/test-does-not-apply",
      `test.patch does not apply at ${state.commit.slice(0, 12)}: ${
        testApply.error ?? "unknown error"
      }`,
    ));
  }

  let solutionApplies = false;
  let solutionError: string | undefined;
  if (a.solutionPatch === null) {
    findings.push({
      rule: "patches/no-solution",
      severity: "warn",
      message:
        "solution.patch does not exist yet — only test.patch was verified",
    });
  } else if (testApply.ok) {
    const solApply = await applyPatch(run, g, repoDir, a.solutionPatch, false);
    solutionApplies = solApply.ok;
    solutionError = solApply.error;
    if (!solApply.ok) {
      findings.push(blocker(
        "patches/solution-does-not-apply",
        `solution.patch does not apply on top of test.patch: ${
          solApply.error ?? "unknown error"
        }`,
      ));
    }
  } else {
    solutionError = "skipped — test.patch did not apply";
  }

  const loc = a.solutionPatch
    ? countEffectiveLoc(a.solutionPatch)
    : { rawAdded: 0, effective: 0, files: [] };

  const passed = !hasErrors(findings);
  const ranAt = new Date().toISOString();
  const fp = await patchFingerprint(a, state.commit);

  const handle = await context.writeResource(
    "patchCheck",
    dataName(args.slug, "patches"),
    {
      slug: args.slug,
      passed,
      fingerprint: fp,
      commit: state.commit,
      repoDir,
      testPatchApplies: testApply.ok,
      solutionPatchApplies: solutionApplies,
      testPatchError: testApply.error,
      solutionPatchError: solutionError,
      filesTouchedByTests: parseUnifiedDiff(a.testPatch).map((f) => f.path),
      filesTouchedBySolution: a.solutionPatch
        ? parseUnifiedDiff(a.solutionPatch).map((f) => f.path)
        : [],
      loc: { rawAdded: loc.rawAdded, effective: loc.effective },
      findings,
      ranAt,
    },
  );

  state.checks.patches = {
    passed,
    ranAt,
    fingerprint: fp,
    summary: passed
      ? `both patches apply at ${state.commit.slice(0, 12)}`
      : findings.filter((f) => f.severity === "error").map((f) => f.rule)
        .join(", "),
  };
  context.logger.info("Patch check for {slug}: {verdict}", {
    slug: args.slug,
    verdict: passed ? "clean" : "failed",
  });
  const stateHandle = await writeState(context, state);
  return { dataHandles: [handle, stateHandle] };
}

export async function checkRepoImpl(
  run: CommandRunner,
  args: { slug: string; ref?: string },
  context: Ctx,
) {
  const g = context.globalArgs;
  const state = await requireState(context, args.slug);
  if (
    args.ref !== undefined &&
    (args.ref.includes("..") || args.ref.startsWith("-"))
  ) {
    throw new Error(
      `invalid ref "${args.ref}" — a ref must not contain ".." or start with "-" (it is interpolated into the gh api path)`,
    );
  }
  const gh = ghBin(g);
  const nwo = `${state.owner}/${state.repo}`;

  const repo = await ghJson(run, gh, ["api", `repos/${nwo}`]);
  const findings: Finding[] = [];

  const stars = Number(repo.stargazers_count ?? 0);
  const pushedAt = String(repo.pushed_at ?? "");
  const archived = Boolean(repo.archived);
  const disabled = Boolean(repo.disabled);
  const isPrivate = Boolean(repo.private);
  const language = String(repo.language ?? "");
  const licenseObj = repo.license as { spdx_id?: string } | null;
  const license = licenseObj?.spdx_id ?? "NOASSERTION";

  const monthsSince = pushedAt
    ? (Date.now() - Date.parse(pushedAt)) / (1000 * 60 * 60 * 24 * 30.44)
    : Number.POSITIVE_INFINITY;

  if (isPrivate) {
    findings.push(blocker(
      "repo/private",
      "the repository is not public",
    ));
  }
  if (archived || disabled) {
    findings.push(blocker(
      "repo/archived",
      "the repository is archived or disabled — inactive and abandoned repos are out of bounds",
    ));
  }
  if (stars < 500) {
    findings.push(blocker(
      "repo/stars",
      `${stars} stars — the bar is 500+`,
    ));
  }
  // A single branch: over twelve months OR non-finite (an unparseable or
  // absent pushed_at hashes to NaN/Infinity). NaN > 12 is false, so without the
  // finiteness guard an unparseable date would sail through the activity check.
  if (!Number.isFinite(monthsSince) || monthsSince > 12) {
    const ago = Number.isFinite(monthsSince)
      ? `${monthsSince.toFixed(1)} months ago`
      : "at an unknown time (no parseable last-push date)";
    findings.push(blocker(
      "repo/inactive",
      `last push was ${ago} — the repo needs at least one commit in the last 12 months`,
    ));
  }
  if (!ALLOWED_LICENSES.has(license)) {
    findings.push(blocker(
      "repo/license",
      `license ${license} is not on the permissive allow-list (MIT, BSD family, Apache-2.0, BSL-1.0, CC-BY)`,
    ));
  }
  if (!ALLOWED_LANGUAGES.has(language)) {
    findings.push(blocker(
      "repo/language",
      `primary language ${
        language || "unknown"
      } is not accepted (TypeScript, JavaScript, Python, Go, Rust, C++, Java)`,
    ));
  }

  const baseToken = LANGUAGE_TO_BASE[language];
  const suggestedBaseImage = baseToken ? BASE_IMAGES[baseToken] : undefined;

  let resolvedCommit: string | undefined;
  let resolvedCommitDate: string | undefined;
  // Default to the EXISTING pin, not the default branch: a ref-less re-run of
  // checkRepo on a submission already pinned to a specific commit must confirm
  // that commit, never silently re-pin to HEAD (which would run checkPatches /
  // localReview against the wrong tree).
  const ref = args.ref ?? state.commit ?? String(repo.default_branch ?? "HEAD");
  try {
    const commit = await ghJson(run, gh, [
      "api",
      `repos/${nwo}/commits/${ref}`,
    ]);
    resolvedCommit = String(commit.sha ?? "");
    const c = commit.commit as { committer?: { date?: string } } | undefined;
    resolvedCommitDate = c?.committer?.date;
  } catch (e) {
    findings.push(blocker(
      "repo/ref-unresolved",
      `could not resolve ref "${ref}": ${(e as Error).message}`,
    ));
  }

  const eligible = !hasErrors(findings);
  const checkedAt = new Date().toISOString();
  const summary = eligible
    ? `eligible: ${stars} stars, ${license}, ${language}, last push ${
      monthsSince.toFixed(1)
    }mo ago`
    : findings.filter((f) => f.severity === "error").map((f) => f.rule)
      .join(", ");

  const checkHandle = await context.writeResource(
    "repoCheck",
    dataName(args.slug, "repo"),
    {
      slug: args.slug,
      repoUrl: state.repoUrl,
      eligible,
      owner: state.owner,
      repo: state.repo,
      stars,
      pushedAt,
      monthsSinceLastPush: Number.isFinite(monthsSince)
        ? Number(monthsSince.toFixed(2))
        : null,
      license,
      language,
      archived: archived || disabled,
      isPrivate,
      suggestedBaseImage,
      resolvedCommit,
      resolvedCommitDate,
      findings,
      checkedAt,
    },
  );

  if (resolvedCommit) state.commit = resolvedCommit;
  if (language) state.language = language;
  if (suggestedBaseImage) state.baseImage = suggestedBaseImage;
  state.checks.repo = { passed: eligible, ranAt: checkedAt, summary };
  context.logger.info("Repo check for {slug}: {verdict}", {
    slug: args.slug,
    verdict: eligible ? "eligible" : "ineligible",
  });
  const stateHandle = await writeState(context, state);
  return { dataHandles: [checkHandle, stateHandle] };
}

interface ScanDeps {
  /** Overridable so tests do not wait out real rate-limit backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Fixed backoff schedule for HTTP 403/429; its length caps the retries. */
  rateLimitBackoffMs?: number[];
}

/** The `(HTTP nnn)` marker gh writes to stderr, or null if absent. */
function parseHttpStatus(stderr: string): number | null {
  const m = stderr.match(/\(HTTP (\d{3})\)/);
  return m ? Number(m[1]) : null;
}

/**
 * Run a gh search that must complete or fail the whole scan. gh exits 1 for a
 * 403, a 404 and a network error alike, so the status comes from the (HTTP nnn)
 * marker on stderr: 403/429 back off on a fixed schedule and retry; anything
 * else — a different status, an absent/unparseable marker, or exhausted retries
 * — is FATAL. Retry-After is unavailable without --include, which would break
 * the JSON parse, so the backoff is a fixed schedule. scanPriorArt writes no
 * state until the end, so a fatal throw is recovered by re-running it; letting a
 * failed search contribute zero hits would instead poison a "clear" verdict.
 */
async function ghSearchJson(
  run: CommandRunner,
  gh: string,
  ghArgs: string[],
  label: string,
  deps: { sleep: (ms: number) => Promise<void>; rateLimitBackoffMs: number[] },
): Promise<Record<string, unknown>> {
  for (let attempt = 0;; attempt++) {
    const res = await run(gh, ghArgs, { timeoutSeconds: 60 });
    if (res.code === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        throw new Error(
          `${label}: gh returned non-JSON output — the prior-art scan cannot complete; re-run scanPriorArt`,
        );
      }
      // gh can exit 0 with a bare `null` or a non-object body; the callers
      // dereference res.items / res.data, so reject anything but an object.
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(
          `${label}: gh returned a non-object JSON body — the prior-art scan cannot complete; re-run scanPriorArt`,
        );
      }
      return parsed as Record<string, unknown>;
    }
    const status = parseHttpStatus(res.stderr);
    // GraphQL rate limits surface as HTTP 200 with a RATE_LIMITED error and no
    // (HTTP nnn) marker, so match that text as a retry signal too.
    const rateLimited = status === 403 || status === 429 ||
      /RATE_LIMITED/i.test(res.stderr);
    if (rateLimited && attempt < deps.rateLimitBackoffMs.length) {
      await deps.sleep(deps.rateLimitBackoffMs[attempt]);
      continue;
    }
    const reason = status === null ? "no HTTP status marker" : `HTTP ${status}`;
    throw new Error(
      `${label} failed (${reason}) — the prior-art scan cannot complete; re-run scanPriorArt: ${
        tail(res.stderr, 5)
      }`,
    );
  }
}

export async function scanPriorArtImpl(
  run: CommandRunner,
  args: { slug: string; terms: string[]; perTerm?: number },
  context: Ctx,
  deps: ScanDeps = {},
) {
  const g = context.globalArgs;
  const state = await requireState(context, args.slug);
  const gh = ghBin(g);
  const nwo = `${state.owner}/${state.repo}`;
  const perTerm = args.perTerm ?? 10;
  if (args.terms.length === 0) {
    throw new Error("at least one search term is required");
  }
  const scanDeps = {
    sleep: deps.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    rateLimitBackoffMs: deps.rateLimitBackoffMs ?? [2000, 5000, 10000],
  };

  const hits: Array<z.infer<typeof PriorArtHitSchema>> = [];
  const seen = new Set<string>();
  // A search that returns a full page has hit the result cap: there may be
  // more, so a zero-hit "clear" cannot be trusted. This blocks the gate
  // independently of the hit count.
  let truncated = false;

  for (const term of args.terms) {
    for (const kind of ["pr", "issue"] as const) {
      const q = `repo:${nwo} is:${kind} ${term}`;
      const res = await ghSearchJson(
        run,
        gh,
        [
          "api",
          "-X",
          "GET",
          "search/issues",
          "-f",
          `q=${q}`,
          "-f",
          `per_page=${perTerm}`,
        ],
        `${kind} search for "${term}"`,
        scanDeps,
      );
      const items = (res.items ?? []) as Array<Record<string, unknown>>;
      // A full page means the cap was hit; incomplete_results is GitHub's own
      // signal that the search backend timed out and returned a partial set.
      // Either way the count cannot be trusted, so the gate must not read clear.
      if (items.length >= perTerm || res.incomplete_results === true) {
        truncated = true;
      }
      for (const item of items) {
        const url = String(item.html_url ?? "");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const merged = item.pull_request &&
            (item.pull_request as { merged_at?: string }).merged_at
          ? "merged"
          : undefined;
        hits.push({
          kind,
          title: String(item.title ?? ""),
          url,
          state: merged ?? String(item.state ?? ""),
          updatedAt: String(item.updated_at ?? ""),
          matchedTerm: term,
        });
      }
    }

    // Discussions are only reachable through GraphQL — design rulings and
    // declined features tend to live there rather than in PRs. A failure here
    // is classified exactly like a REST failure (rate-limit backoff, else
    // fatal): a discussion search that cannot complete cannot certify "clear".
    const gql =
      "query($q:String!,$n:Int!){search(query:$q,type:DISCUSSION,first:$n){nodes{... on Discussion{title url updatedAt category{name}}}}}";
    const res = await ghSearchJson(
      run,
      gh,
      [
        "api",
        "graphql",
        "-f",
        `query=${gql}`,
        "-f",
        `q=repo:${nwo} ${term}`,
        "-F",
        `n=${perTerm}`,
      ],
      `discussion search for "${term}"`,
      scanDeps,
    );
    const data = res.data as
      | { search?: { nodes?: Array<Record<string, unknown>> } }
      | undefined;
    const nodes = data?.search?.nodes ?? [];
    if (nodes.length >= perTerm) truncated = true;
    for (const node of nodes) {
      const url = String(node.url ?? "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const cat = node.category as { name?: string } | undefined;
      hits.push({
        kind: "discussion",
        title: String(node.title ?? ""),
        url,
        state: cat?.name,
        updatedAt: String(node.updatedAt ?? ""),
        matchedTerm: term,
      });
    }
  }

  const prCount = hits.filter((h) => h.kind === "pr").length;
  const issueCount = hits.filter((h) => h.kind === "issue").length;
  const discussionCount = hits.filter((h) => h.kind === "discussion").length;
  const hitCount = hits.length;
  const passed = hitCount === 0;
  const clear = passed && !truncated;
  const hitFingerprint = await priorArtFingerprint(
    args.terms,
    hits.map((h) => ({ url: h.url, state: h.state })),
  );
  const verdict = clear ? "clear" : "review-required";
  const note = truncated
    ? `A search hit the ${perTerm}-result cap, so the result set may be incomplete — narrow the terms or raise perTerm and re-scan. The gate stays closed until a scan completes untruncated.`
    : hitCount === 0
    ? "No matching PRs, issues or discussions. Widen the terms if the idea could be described differently."
    : `${hitCount} candidate(s) found. Open each one: a closed or unmerged PR that already implements the idea still rules it out, and a maintainer ruling in an issue or discussion counts as misalignment. Record the decision with acknowledgePriorArt.`;

  const scannedAt = new Date().toISOString();
  const handle = await context.writeResource(
    "priorArt",
    dataName(args.slug, "priorart"),
    {
      slug: args.slug,
      repoUrl: state.repoUrl,
      terms: args.terms,
      hits,
      prCount,
      issueCount,
      discussionCount,
      verdict,
      note,
      scannedAt,
    },
  );

  // `passed` reflects ADJUDICATION, not merely that the scan ran: a clear scan
  // is passed, a scan with hits is NOT passed until acknowledgePriorArt flips
  // it, so the status priorArt row does not read "passed" while the gate blocks
  // on unadjudicated hits. A fresh scan drops any prior acknowledgement — the
  // hit set may have changed under it.
  state.checks.priorArt = {
    passed,
    ranAt: scannedAt,
    hitCount,
    hitFingerprint,
    truncated,
    acknowledgement: undefined,
    summary: `${hitCount} candidate(s) for ${args.terms.length} term(s): ${
      args.terms.join(", ")
    }${truncated ? " (TRUNCATED — result cap hit)" : ""}`,
  };
  context.logger.info(
    "Prior-art scan for {slug}: {count} candidate(s){trunc}",
    {
      slug: args.slug,
      count: hitCount,
      trunc: truncated ? " (truncated)" : "",
    },
  );
  const stateHandle = await writeState(context, state);
  return { dataHandles: [handle, stateHandle] };
}

/**
 * The host uid:gid for `docker run --user`, or null when it cannot be read
 * (non-unix, or the runtime denies sys access — swamp's sandbox may). Falling
 * back to null keeps the review running as the image's default user rather than
 * failing; the caller records which happened.
 */
function hostUserSpec(): string | null {
  try {
    const uid = Deno.uid();
    const gid = Deno.gid();
    if (uid === null || gid === null) return null;
    return `${uid}:${gid}`;
  } catch {
    return null;
  }
}

/** Cap on the untrusted JUnit XML: test.sh could write an enormous file to
 * exhaust host memory, so anything over the cap is skipped (junit stays
 * undefined and the stage still records its exit code). */
export const MAX_JUNIT_BYTES = 25_000_000;

/** Only read a JUnit path that is a real regular file within the size cap —
 * test.sh is untrusted, so a symlink at /out/<label>.xml pointing outside the
 * mount is not followed, and an oversized file is not slurped into memory. */
export async function readRegularFile(
  path: string,
  maxBytes = MAX_JUNIT_BYTES,
): Promise<string | null> {
  try {
    const st = await Deno.lstat(path);
    if (!st.isFile) return null;
    if (st.size > maxBytes) return null;
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/**
 * A non-zero container exit that is a setup/permission failure, not a genuine
 * test failure. Under `--user`, a Dockerfile that builds as root can leave the
 * repo tree unwritable, so test.sh dies before running any test — that must not
 * be credited as the expected failure of the new-before-solution stage.
 */
function looksLikeSetupFailure(output: string, code: number): boolean {
  if (code === 126 || code === 127) return true; // not executable / not found
  return /permission denied|operation not permitted|read-only file system|unable to (?:create|write)|cannot (?:create|open|write)/i
    .test(output);
}

export async function localReviewImpl(
  run: CommandRunner,
  args: { slug: string; keepImages?: boolean; rootInContainer?: boolean },
  context: Ctx,
) {
  const g = context.globalArgs;
  const state = await requireState(context, args.slug);
  if (!state.commit) {
    throw new Error(
      `submission "${args.slug}" has no pinned commit — run checkRepo first`,
    );
  }
  const a = await readArtifacts(state.dir);
  for (
    const [name, body] of [
      ["test.patch", a.testPatch],
      ["solution.patch", a.solutionPatch],
      ["Dockerfile", a.dockerfile],
    ] as const
  ) {
    if (body === null) {
      throw new Error(
        `${state.dir}/${name} does not exist — the local review needs all three`,
      );
    }
  }

  const docker = dockerBin(g);
  const workDir = `${state.dir}/.work`;
  const outDir = `${workDir}/out`;
  const started = Date.now();

  const repoDir = await prepareClone(
    run,
    g,
    workDir,
    state.repoUrl,
    state.commit,
  );

  // A clean out dir keeps a stale XML from a previous run out of the
  // summary when a stage dies before writing one.
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(outDir, { recursive: true });

  const testApply = await applyPatch(run, g, repoDir, a.testPatch!, false);
  if (!testApply.ok) {
    throw new Error(
      `test.patch does not apply at ${state.commit} — run checkPatches: ${testApply.error}`,
    );
  }
  // Written after `git clean` inside prepareClone, and never part of a
  // patch, so the repo tree still looks like an ordinary checkout.
  await Deno.writeTextFile(
    `${repoDir}/${REVIEW_DOCKERFILE}`,
    a.dockerfile!,
  );

  const image = `olympus-review-${args.slug}`;
  const testTag = `${image}:tests`;
  const solTag = `${image}:solution`;
  const stages: Array<z.infer<typeof ReviewStageSchema>> = [];

  // Run the test containers as the host uid:gid by default so a Dockerfile that
  // builds as root cannot leave root-owned droppings in the mounted out dir or
  // the repo tree. rootInContainer opts out (some toolchains — cargo target,
  // pytest caches — need a writable tree they built as root).
  const userSpec = args.rootInContainer ? null : hostUserSpec();
  const containerUser = args.rootInContainer
    ? "root (rootInContainer opt-out)"
    : userSpec ?? "root (host uid unavailable)";

  const build = async (tag: string, description: string) => {
    const t0 = Date.now();
    context.logger.info("localReview build {tag}", { tag });
    const res = await run(docker, [
      "build",
      "-f",
      REVIEW_DOCKERFILE,
      "-t",
      tag,
      ".",
    ], { cwd: repoDir, timeoutSeconds: buildTimeout(g) });
    stages.push({
      name: tag.split(":")[1] ?? tag,
      description,
      expectation: "build succeeds",
      exitCode: res.code,
      ok: res.code === 0,
      durationSeconds: Math.round((Date.now() - t0) / 1000),
      outputTail: tail(res.stderr || res.stdout, 30),
    });
    context.logger.info("localReview build {tag}: exit {code}", {
      tag,
      code: res.code,
    });
    return res.code === 0;
  };

  const runMode = async (
    tag: string,
    mode: "base" | "new",
    label: string,
    description: string,
    expectPass: boolean,
  ) => {
    const t0 = Date.now();
    const xml = `${label}.xml`;
    context.logger.info("localReview run {label}", { label });
    const runArgs = ["run", "--rm", "--network", "none"];
    if (userSpec) runArgs.push("--user", userSpec);
    runArgs.push(
      "-v",
      `${outDir}:/out`,
      tag,
      "bash",
      "-lc",
      `./test.sh --output_path /out/${xml} ${mode}`,
    );
    const res = await run(docker, runArgs, { timeoutSeconds: testTimeout(g) });
    const xmlBody = await readRegularFile(`${outDir}/${xml}`);
    const junit = xmlBody ? parseJUnit(xmlBody) : undefined;
    // Classify (and report) on BOTH streams: a container can print test output
    // to stdout and then die with "Permission denied" on stderr at exit, so a
    // stdout-only view would miss the crash and credit it as the expected fail.
    const combined = `${res.stdout}\n${res.stderr}`;
    const output = tail(combined, 30);
    const passed = res.code === 0;
    // A setup/permission crash is never the expected failure — it did not run
    // the tests. Crediting it would pass new-before-solution for the wrong
    // reason.
    const setupFailed = !passed && looksLikeSetupFailure(combined, res.code);
    stages.push({
      name: label,
      description,
      expectation: setupFailed
        ? "test.sh ran the tests (a setup/permission crash does not count)"
        : expectPass
        ? "test.sh exits 0 (tests pass)"
        : "test.sh exits non-zero (tests fail)",
      exitCode: res.code,
      ok: setupFailed ? false : passed === expectPass,
      durationSeconds: Math.round((Date.now() - t0) / 1000),
      junit,
      outputTail: output,
    });
    if (setupFailed) {
      context.logger.info(
        "localReview run {label}: setup/permission failure, not credited",
        { label, code: res.code },
      );
    }
  };

  try {
    if (await build(testTag, "Build the image with test.patch applied")) {
      await runMode(
        testTag,
        "base",
        "base-before-solution",
        "Existing repo tests, solution not applied — the regression check",
        true,
      );
      await runMode(
        testTag,
        "new",
        "new-before-solution",
        "New tests, solution not applied — these must fail at the base commit",
        false,
      );

      const solApply = await applyPatch(
        run,
        g,
        repoDir,
        a.solutionPatch!,
        false,
      );
      if (!solApply.ok) {
        stages.push({
          name: "apply-solution",
          description: "Apply solution.patch on top of test.patch",
          expectation: "patch applies cleanly",
          exitCode: 1,
          ok: false,
          durationSeconds: 0,
          outputTail: solApply.error ?? "",
        });
      } else if (
        await build(solTag, "Rebuild the image with solution.patch applied")
      ) {
        await runMode(
          solTag,
          "base",
          "base-after-solution",
          "Existing repo tests with the solution applied — no regressions",
          true,
        );
        await runMode(
          solTag,
          "new",
          "new-after-solution",
          "New tests with the solution applied — the proof the task is solvable",
          true,
        );
      }
    }
  } finally {
    // Always reclaim the images, even if a stage threw mid-sequence. Remove
    // each tag on its own and tolerate not-found: the solution tag is only
    // built on the path past the solution patch, so a routine early exit (or a
    // throw) can leave either tag absent, and a combined rm would report that
    // as a failure.
    if (!args.keepImages) {
      for (const tag of [testTag, solTag]) {
        await run(docker, ["image", "rm", "-f", tag], { timeoutSeconds: 120 })
          .catch(() => {});
      }
    }
  }

  const expectedStages = 6;
  const failedStages = stages.filter((s) => !s.ok).map((s) => s.name);
  const verdict = failedStages.length === 0 &&
      stages.length === expectedStages
    ? "pass"
    : "fail";
  const baseNote = verdict === "pass"
    ? "base passes and new fails at the base commit; both pass with the solution applied"
    : stages.length < expectedStages
    ? `the review stopped early after ${stages.length} of ${expectedStages} stages — read the last stage's output`
    : `failed stage(s): ${failedStages.join(", ")}`;
  const note = `${baseNote} (container user: ${containerUser})`;

  const ranAt = new Date().toISOString();
  const fp = await reviewFingerprint(a, state.commit);
  const durationSeconds = Math.round((Date.now() - started) / 1000);

  const handle = await context.writeResource(
    "reviewResult",
    dataName(args.slug, "review"),
    {
      slug: args.slug,
      verdict,
      fingerprint: fp,
      commit: state.commit,
      image,
      stages,
      failedStages,
      note,
      durationSeconds,
      containerUser,
      ranAt,
    },
  );

  state.checks.review = {
    passed: verdict === "pass",
    ranAt,
    fingerprint: fp,
    summary: note,
  };
  context.logger.info(
    "Local review for {slug}: {verdict} in {seconds}s",
    {
      slug: args.slug,
      verdict,
      seconds: durationSeconds,
    },
  );
  const stateHandle = await writeState(context, state);
  return { dataHandles: [handle, stateHandle] };
}

// ---------- Model ------------------------------------------------------------

/**
 * @magistr/olympus/submission — one Olympus challenge-authoring workspace.
 *
 * Lifecycle methods (startSubmission / status / advance / abandon / list) own
 * the phase state; check methods (checkRepo / scanPriorArt / preflight /
 * checkPatches / localReview) produce the evidence the gates consume; bundle
 * emits the four fields the platform submission form wants.
 */
export const model = {
  type: "@magistr/olympus/submission",
  version: "2026.07.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    submissionState: {
      description:
        "Lifecycle state of one submission (data name = <slug>.state): repo, pinned commit, current phase, recorded check results with artifact fingerprints, and full transition history.",
      schema: SubmissionStateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    submissionStatus: {
      description:
        "Derived per-submission status (<slug>.status): current gate with blockers, artifact presence, per-check freshness and the suggested next action. Non-authoritative.",
      schema: SubmissionStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    workspace: {
      description:
        "Inventory of every submission in the workspace with its phase, repo and pinned commit.",
      schema: WorkspaceSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    initResult: {
      description:
        "Result of workspace scaffolding: which directories were created vs already present.",
      schema: InitResultSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    repoCheck: {
      description:
        "Repo eligibility verdict (<slug>.repo): stars, last push, license, primary language, archived/private flags, the resolved commit SHA and the suggested base image.",
      schema: RepoCheckSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    priorArt: {
      description:
        "Prior-art scan (<slug>.priorart): matching PRs (open, merged and closed), issues and discussions that may already cover the idea.",
      schema: PriorArtSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    preflight: {
      description:
        "Text-only validation of all four artifacts (<slug>.preflight): problem-description prose linter, test-patch and solution-patch structure, Dockerfile conformance, leak scan and the effective-LOC count.",
      schema: PreflightSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    patchCheck: {
      description:
        "Result of applying both patches against the pinned commit in a real clone (<slug>.patches).",
      schema: PatchCheckSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    reviewResult: {
      description:
        "Local review in Docker (<slug>.review): per-stage exit codes and JUnit counts for base/new before and after the solution patch, with the overall verdict.",
      schema: ReviewResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    bundle: {
      description:
        "The assembled submission (<slug>.bundle): problem description, test patch, solution patch and Dockerfile, ready to paste into the platform form.",
      schema: BundleSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    init: {
      description:
        "Idempotently scaffold the Olympus workspace skeleton (submissions/) at the configured path. Existing directories are left untouched and reported.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const root = context.globalArgs.path;
        const created: string[] = [];
        const existing: string[] = [];
        for (const dir of [SUBMISSIONS_DIR]) {
          const full = `${root}/${dir}`;
          if (await dirExists(full)) {
            existing.push(dir);
            continue;
          }
          await Deno.mkdir(full, { recursive: true });
          created.push(dir);
        }
        const handle = await context.writeResource("initResult", "init", {
          path: root,
          created,
          existing,
          initializedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startSubmission: {
      description:
        "Create a new submission: scaffold submissions/<slug>/ and open its lifecycle at the repo phase. Pass the GitHub repo URL, and optionally the commit SHA and the issue URL that describes the problem.",
      arguments: z.object({
        slug: z.string().describe(
          "Short kebab-case identifier for this submission; also the directory name",
        ),
        repoUrl: z.string().describe("GitHub repository URL"),
        commit: z.string().optional().describe(
          "Commit SHA to pin the task to; if omitted, resolve one with checkRepo",
        ),
        issueUrl: z.string().optional().describe(
          "Optional GitHub issue URL describing the problem",
        ),
      }),
      execute: async (
        args: {
          slug: string;
          repoUrl: string;
          commit?: string;
          issueUrl?: string;
        },
        context: Ctx,
      ) => {
        const root = context.globalArgs.path;
        const parsed = parseRepoUrl(args.repoUrl);
        if (!parsed) {
          throw new Error(
            `"${args.repoUrl}" is not a GitHub repository URL (expected github.com/<owner>/<repo>)`,
          );
        }
        if (!/^[a-z0-9][a-z0-9-]*$/.test(args.slug)) {
          throw new Error(
            `slug "${args.slug}" must be lowercase kebab-case — it is used as a directory name`,
          );
        }
        if (
          args.commit !== undefined &&
          !/^[0-9a-zA-Z][0-9a-zA-Z._/-]*$/.test(args.commit)
        ) {
          throw new Error(
            `commit "${args.commit}" is not a valid ref/SHA — it must start with an alphanumeric and contain only [0-9a-zA-Z._/-] (a leading "-" would be read by git as a flag)`,
          );
        }
        const canonicalUrl =
          `https://github.com/${parsed.owner}/${parsed.repo}`;
        const existing = await readState(context, args.slug);
        if (existing) {
          // Idempotent re-create: the same slug pointed at the same repo, commit
          // and issue is a no-op that returns the existing submission. Both URLs
          // are normalised through parseRepoUrl, so a .git suffix or a bare
          // owner/repo spelling is not a spurious conflict. Any real difference
          // is a conflict rather than a silent overwrite — keying only on
          // slug+repoUrl would swallow a corrected commit.
          const existingParsed = parseRepoUrl(existing.repoUrl);
          const differs: string[] = [];
          // GitHub owner/repo are case-insensitive, so compare lowercased —
          // Owner/Repo is the same submission as owner/repo, not a conflict.
          if (
            !existingParsed ||
            existingParsed.owner.toLowerCase() !== parsed.owner.toLowerCase() ||
            existingParsed.repo.toLowerCase() !== parsed.repo.toLowerCase()
          ) {
            differs.push(`repo (${existing.repoUrl} vs ${canonicalUrl})`);
          }
          // A supplied short ref that is a prefix of the resolved SHA (or vice
          // versa), or no supplied commit at all, is the same submission; only a
          // genuinely different commit is a conflict.
          const ec = (existing.commit ?? "").toLowerCase();
          const ac = (args.commit ?? "").toLowerCase();
          if (
            ac !== "" && ec !== "" && !ec.startsWith(ac) && !ac.startsWith(ec)
          ) {
            differs.push(
              `commit (${existing.commit ?? "none"} vs ${
                args.commit ?? "none"
              })`,
            );
          }
          if ((existing.issueUrl ?? "") !== (args.issueUrl ?? "")) {
            differs.push(
              `issue (${existing.issueUrl ?? "none"} vs ${
                args.issueUrl ?? "none"
              })`,
            );
          }
          if (differs.length > 0) {
            throw new Error(
              `submission "${args.slug}" already exists at phase ${existing.phase} with different ${
                differs.join(", ")
              } — abandon it first or use a different slug`,
            );
          }
          context.logger.info(
            "Submission {slug} already exists — returning it (idempotent)",
            { slug: args.slug, phase: existing.phase },
          );
          const handle = await writeState(context, existing);
          return { dataHandles: [handle] };
        }
        const dir = submissionDir(root, args.slug);
        await Deno.mkdir(dir, { recursive: true });

        const now = new Date().toISOString();
        const state: SubmissionState = {
          slug: args.slug,
          repoUrl: canonicalUrl,
          owner: parsed.owner,
          repo: parsed.repo,
          commit: args.commit,
          issueUrl: args.issueUrl,
          phase: "repo",
          dir,
          createdAt: now,
          updatedAt: now,
          history: [{ from: "none", to: "repo", at: now }],
          checks: {},
        };
        context.logger.info("Started submission {slug} on {repo}", {
          slug: args.slug,
          repo: `${parsed.owner}/${parsed.repo}`,
        });
        const handle = await writeState(context, state);
        return { dataHandles: [handle] };
      },
    },

    list: {
      description:
        "Inventory every submission in the workspace in one run: slug, phase, repo and pinned commit, plus a per-phase count.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const root = context.globalArgs.path;
        const base = `${root}/${SUBMISSIONS_DIR}`;
        const submissions: Array<{
          slug: string;
          phase: string;
          repoUrl: string;
          commit?: string;
          updatedAt: string;
        }> = [];
        if (await dirExists(base)) {
          for await (const entry of Deno.readDir(base)) {
            if (!entry.isDirectory) continue;
            const state = await readState(context, entry.name);
            if (!state) continue;
            submissions.push({
              slug: state.slug,
              phase: state.phase,
              repoUrl: state.repoUrl,
              commit: state.commit,
              updatedAt: state.updatedAt,
            });
          }
        }
        submissions.sort((a, b) => a.slug.localeCompare(b.slug));
        const counts = new Map<string, number>();
        for (const s of submissions) {
          counts.set(s.phase, (counts.get(s.phase) ?? 0) + 1);
        }
        const handle = await context.writeResource("workspace", "workspace", {
          path: root,
          submissions,
          byPhase: [...counts].map(([phase, count]) => ({ phase, count })),
          scannedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report one submission's current gate: whether it is satisfied, what is blocking it, which artifacts exist, how fresh each recorded check is, and the suggested next action.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
      }),
      execute: async (args: { slug: string }, context: Ctx) => {
        const state = await requireState(context, args.slug);
        const artifacts = await readArtifacts(state.dir);
        const gate = await evaluateGate(state, artifacts);
        const pf = await patchFingerprint(artifacts, state.commit);
        const rf = await reviewFingerprint(artifacts, state.commit);

        const files: Array<{ file: string; present: boolean; bytes: number }> =
          [
            ["problem.md", artifacts.problem],
            ["test.patch", artifacts.testPatch],
            ["solution.patch", artifacts.solutionPatch],
            ["Dockerfile", artifacts.dockerfile],
          ].map(([file, body]) => ({
            file: file as string,
            present: body !== null,
            bytes: (body as string | null)?.length ?? 0,
          }));

        const checks = [
          { name: "repo", record: state.checks.repo, expect: "" },
          { name: "priorArt", record: state.checks.priorArt, expect: "" },
          { name: "preflight", record: state.checks.preflight, expect: "" },
          { name: "patches", record: state.checks.patches, expect: pf },
          { name: "review", record: state.checks.review, expect: rf },
        ].map((c) => ({
          name: c.name,
          state: recordState(c.record, c.expect || c.record?.fingerprint || ""),
          ranAt: c.record?.ranAt,
        }));

        const effectiveLoc = artifacts.solutionPatch
          ? countEffectiveLoc(artifacts.solutionPatch).effective
          : undefined;

        const handle = await context.writeResource(
          "submissionStatus",
          dataName(args.slug, "status"),
          {
            slug: state.slug,
            phase: state.phase,
            repoUrl: state.repoUrl,
            commit: state.commit,
            gate,
            nextPhase: nextPhase(state.phase),
            nextAction: NEXT_ACTION[state.phase] ?? "",
            artifacts: files,
            checks,
            effectiveLoc,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    advance: {
      description:
        "Move a submission to the next phase, but only if the current gate is clean. Text validators are re-run live off disk; clone- and container-backed checks must have a recorded pass whose fingerprint still matches the artifacts.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
        note: z.string().optional().describe(
          "Optional note recorded on the transition",
        ),
      }),
      execute: async (
        args: { slug: string; note?: string },
        context: Ctx,
      ) => {
        const state = await requireState(context, args.slug);
        if (state.phase === "abandoned") {
          throw new Error(`submission "${args.slug}" was abandoned`);
        }
        const to = nextPhase(state.phase);
        if (!to) {
          throw new Error(
            `submission "${args.slug}" is already at the final phase (${state.phase})`,
          );
        }
        const artifacts = await readArtifacts(state.dir);
        const gate = await evaluateGate(state, artifacts);
        if (!gate.satisfied) {
          const lines = gate.blockers
            .map((b) => `  - [${b.rule}] ${b.message}`)
            .join("\n");
          throw new Error(
            `cannot advance "${args.slug}" out of ${state.phase} — ${gate.blockers.length} blocker(s):\n${lines}`,
          );
        }
        const at = new Date().toISOString();
        state.history.push({ from: state.phase, to, at, note: args.note });
        context.logger.info("Advancing {slug}: {from} -> {to}", {
          slug: args.slug,
          from: state.phase,
          to,
        });
        state.phase = to as SubmissionState["phase"];
        const handle = await writeState(context, state);
        return { dataHandles: [handle] };
      },
    },

    abandon: {
      description:
        "Close a submission from any phase without submitting it, recording why.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
        reason: z.string().describe("Why this submission is being dropped"),
      }),
      execute: async (
        args: { slug: string; reason: string },
        context: Ctx,
      ) => {
        const state = await requireState(context, args.slug);
        const at = new Date().toISOString();
        state.history.push({
          from: state.phase,
          to: "abandoned",
          at,
          note: args.reason,
        });
        state.phase = "abandoned";
        state.abandonReason = args.reason;
        context.logger.info("Abandoned {slug}: {reason}", {
          slug: args.slug,
          reason: args.reason,
        });
        const handle = await writeState(context, state);
        return { dataHandles: [handle] };
      },
    },

    checkRepo: {
      description:
        "Check the pinned repo against the quest's eligibility bar — public, not archived, 500+ stars, a commit in the last 12 months, a permissive license and an accepted primary language — and resolve a ref to a concrete commit SHA. Records the verdict on the submission and suggests the matching base image.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
        ref: z.string().optional().describe(
          "Branch, tag or SHA to pin (default: the repo's default branch HEAD)",
        ),
      }),
      execute: (args: { slug: string; ref?: string }, context: Ctx) =>
        checkRepoImpl(defaultRunner, args, context),
    },

    scanPriorArt: {
      description:
        "Fan out one search across the repo's pull requests (open, merged and closed), issues and GitHub Discussions for the given terms, so an idea that is already implemented, already proposed or already declined is caught before any patch is written. Surfaces candidates for a human to read — it does not decide.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
        terms: z.array(z.string()).describe(
          'Search terms describing the idea, e.g. ["distinct aggregation", "count distinct"]',
        ),
        perTerm: z.number().optional().describe(
          "Maximum hits per term per surface (default: 10)",
        ),
      }),
      execute: (
        args: { slug: string; terms: string[]; perTerm?: number },
        context: Ctx,
      ) => scanPriorArtImpl(defaultRunner, args, context),
    },

    acknowledgePriorArt: {
      description:
        "Record a human's adjudication of the prior-art hits scanPriorArt found. Pass the exact set of hit URLs, each already reviewed with the user; the repo gate opens only when the acknowledged set equals the scanned hit set and its fingerprint still matches. This RECORDS a decision — it does not make one. Present every hit with its disposition and obtain an explicit user decision first; never run it to wave a scan through, and never report it as the gate being approved or prior art cleared.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
        urls: z.array(z.string()).describe(
          "Every hit URL from the latest scan, each reviewed with the user; must equal the scanned hit set exactly",
        ),
        note: z.string().optional().describe(
          "Optional record of the adjudication rationale",
        ),
      }),
      execute: async (
        args: { slug: string; urls: string[]; note?: string },
        context: Ctx,
      ) => {
        const state = await requireState(context, args.slug);
        const record = await context.readResource!(
          dataName(args.slug, "priorart"),
        );
        if (!record) {
          throw new Error(
            `no prior-art scan for "${args.slug}" — run the scanPriorArt method first`,
          );
        }
        const pa = state.checks.priorArt;
        if (!pa || pa.hitCount === undefined) {
          throw new Error(
            `submission "${args.slug}" has no recorded prior-art scan to acknowledge — run scanPriorArt first`,
          );
        }
        const hits = (record.hits ?? []) as Array<
          { url?: unknown; state?: unknown }
        >;
        if (hits.length === 0) {
          throw new Error(
            `the prior-art scan for "${args.slug}" found no hits — nothing to acknowledge; the gate is already open`,
          );
        }
        // Derive the recompute inputs ALL from the record: the caller supplies
        // URLs only, so a stale caller value cannot diverge the fingerprint and
        // shut the gate with no diagnostic.
        const terms = (record.terms ?? []) as string[];
        const recordUrls = hits.map((h) => String(h.url ?? ""));
        const recordUrlSet = new Set(recordUrls);
        const suppliedSet = new Set(args.urls);
        const missing = [...recordUrlSet].filter((u) => !suppliedSet.has(u));
        const unexpected = [...suppliedSet].filter((u) => !recordUrlSet.has(u));
        if (missing.length > 0 || unexpected.length > 0) {
          throw new Error(
            `the acknowledged URL set does not equal the scanned hit set — ${
              missing.length ? `missing: ${missing.join(", ")}` : "none missing"
            }${
              unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""
            }. Acknowledge exactly the hits scanPriorArt found.`,
          );
        }
        // Recompute with the SAME function scanPriorArt used, so an
        // equality-covered acknowledgement matches hitFingerprint by
        // construction; a hand-edited record instead diverges and stays shut.
        const fp = await priorArtFingerprint(
          terms,
          hits.map((h) => ({
            url: String(h.url ?? ""),
            state: h.state === undefined ? undefined : String(h.state),
          })),
        );
        state.checks.priorArt = {
          ...pa,
          passed: true,
          acknowledgement: {
            fingerprint: fp,
            urls: [...recordUrls].sort(),
            acknowledgedAt: new Date().toISOString(),
            note: args.note,
          },
        };
        context.logger.info(
          "Prior-art hits acknowledged for {slug}: {count} URL(s)",
          { slug: args.slug, count: recordUrls.length },
        );
        const handle = await writeState(context, state);
        return { dataHandles: [handle] };
      },
    },

    preflight: {
      description:
        "Run every text-only validator over all four artifacts in one pass: the problem-description prose linter, test-patch structure (test.sh present, executable, both modes, --output_path, no fail-fast), solution-patch structure, Dockerfile conformance, the quest-word leak scan, and the effective-LOC count. Needs no clone, no network and no Docker — run it after every edit.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
      }),
      execute: async (args: { slug: string }, context: Ctx) => {
        const state = await requireState(context, args.slug);
        const a = await readArtifacts(state.dir);

        const present: string[] = [];
        const missing: string[] = [];
        for (
          const [file, body] of [
            ["problem.md", a.problem],
            ["test.patch", a.testPatch],
            ["solution.patch", a.solutionPatch],
            ["Dockerfile", a.dockerfile],
          ] as const
        ) {
          (body === null ? missing : present).push(file);
        }

        const section = (
          body: string | null,
          lint: (t: string) => Finding[],
        ) => {
          if (body === null) {
            return { present: false, findings: [], summary: "not written yet" };
          }
          const findings = lint(body);
          return { present: true, findings, summary: summarise(findings) };
        };

        const problem = section(a.problem, lintProblemText);
        const tests = section(a.testPatch, lintTestPatch);
        const solution = section(a.solutionPatch, lintSolutionPatch);
        const dockerfile = section(a.dockerfile, lintDockerfileText);

        const loc = a.solutionPatch
          ? countEffectiveLoc(a.solutionPatch)
          : { rawAdded: 0, effective: 0, files: [] };

        const allFindings = [
          ...problem.findings,
          ...tests.findings,
          ...solution.findings,
          ...dockerfile.findings,
        ];
        const passed = missing.length === 0 && !hasErrors(allFindings);
        const ranAt = new Date().toISOString();
        const fp = await fingerprint([
          a.problem,
          a.testPatch,
          a.solutionPatch,
          a.dockerfile,
        ]);

        const handle = await context.writeResource(
          "preflight",
          dataName(args.slug, "preflight"),
          {
            slug: args.slug,
            passed,
            fingerprint: fp,
            artifactsPresent: present,
            artifactsMissing: missing,
            problem,
            tests,
            solution,
            dockerfile,
            loc,
            ranAt,
          },
        );

        state.checks.preflight = {
          passed,
          ranAt,
          fingerprint: fp,
          summary: `${
            summarise(allFindings)
          }; ${loc.effective} effective solution line(s)`,
        };
        context.logger.info("Preflight for {slug}: {summary}", {
          slug: args.slug,
          summary: summarise(allFindings),
        });
        const stateHandle = await writeState(context, state);
        return { dataHandles: [handle, stateHandle] };
      },
    },

    checkPatches: {
      description:
        "Clone the repo at the pinned commit and verify both patches apply cleanly — test.patch on the bare commit, then solution.patch on top of it — reporting the files each one touches and the effective solution LOC. This is what the reviewer does before building anything.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
      }),
      execute: (args: { slug: string }, context: Ctx) =>
        checkPatchesImpl(defaultRunner, args, context),
    },

    localReview: {
      description:
        "Reproduce the reviewer's local review end to end in Docker: check out the pinned commit, apply test.patch, build the image, and run test.sh with --network none — base must pass and new must fail. Then apply solution.patch, rebuild, and run both again — both must pass. Reports every stage's exit code and JUnit counts, so a failure says which of the four runs went wrong.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
        keepImages: z.boolean().optional().describe(
          "Keep the built images instead of removing them afterwards (default: false)",
        ),
        rootInContainer: z.boolean().optional().describe(
          "Run the test containers as the image's default user (usually root) instead of the host uid:gid — needed when a toolchain that built as root leaves the tree unwritable for a non-root uid (default: false)",
        ),
      }),
      execute: (
        args: { slug: string; keepImages?: boolean; rootInContainer?: boolean },
        context: Ctx,
      ) => localReviewImpl(defaultRunner, args, context),
    },

    bundle: {
      description:
        "Assemble the four fields the platform submission form wants — problem description, test patch, solution patch and Dockerfile — with the effective LOC count and any remaining blockers. Emits the bundle even when blockers remain, so the gaps are visible in one place.",
      arguments: z.object({
        slug: z.string().describe("Submission slug"),
      }),
      execute: async (args: { slug: string }, context: Ctx) => {
        const state = await requireState(context, args.slug);
        const a = await readArtifacts(state.dir);
        const blockers: Finding[] = [];

        for (
          const [file, body] of [
            ["problem.md", a.problem],
            ["test.patch", a.testPatch],
            ["solution.patch", a.solutionPatch],
            ["Dockerfile", a.dockerfile],
          ] as const
        ) {
          if (body === null) {
            blockers.push(blocker("bundle/missing", `${file} does not exist`));
          }
        }
        if (!state.commit) {
          blockers.push(blocker("bundle/no-commit", "no commit SHA pinned"));
        }
        const rf = await reviewFingerprint(a, state.commit);
        const reviewState = recordState(state.checks.review, rf);
        if (reviewState !== "passed") {
          blockers.push(blocker(
            "bundle/review",
            `the local review is ${reviewState} — at least one agent must solve the challenge and the local review must be green before submitting`,
          ));
        }
        blockers.push(...errorsOnly([
          ...(a.problem ? lintProblemText(a.problem) : []),
          ...(a.testPatch ? lintTestPatch(a.testPatch) : []),
          ...(a.solutionPatch ? lintSolutionPatch(a.solutionPatch) : []),
          ...(a.dockerfile ? lintDockerfileText(a.dockerfile) : []),
        ]));

        const loc = a.solutionPatch
          ? countEffectiveLoc(a.solutionPatch)
          : { rawAdded: 0, effective: 0, files: [] };

        const handle = await context.writeResource(
          "bundle",
          dataName(args.slug, "bundle"),
          {
            slug: args.slug,
            ready: blockers.length === 0,
            repoUrl: state.repoUrl,
            commit: state.commit ?? "",
            problemDescription: a.problem ?? "",
            testPatch: a.testPatch ?? "",
            solutionPatch: a.solutionPatch ?? "",
            dockerfile: a.dockerfile ?? "",
            effectiveLoc: loc.effective,
            blockers,
            builtAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
