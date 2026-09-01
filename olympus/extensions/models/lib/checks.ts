import { z } from "npm:zod@4";

// =============================================================================
// @magistr/olympus — pure checks and process helpers
//
// Everything here is deliberately side-effect-light and unit-testable: the
// reference tables from the Creating Challenges doc, the linters (problem
// description, test patch, solution patch, Dockerfile), unified-diff parsing,
// the effective-LOC count, JUnit summarisation, and the small process and
// GitHub helpers the model methods build on.
//
// The model itself lives in ../olympus_submission.ts.
// =============================================================================

// ---------- Reference tables (from the Creating Challenges doc) --------------

/** Base images, keyed by the language token used in the FROM line. */
export const BASE_IMAGES: Record<string, string> = {
  python: "public.ecr.aws/d3j8x8q7/olympus-base-python:latest",
  typescript: "public.ecr.aws/d3j8x8q7/olympus-base-typescript:latest",
  go: "public.ecr.aws/d3j8x8q7/olympus-base-go:latest",
  rust: "public.ecr.aws/d3j8x8q7/olympus-base-rust:latest",
  jvm: "public.ecr.aws/d3j8x8q7/olympus-base-jvm:latest",
  cpp: "public.ecr.aws/d3j8x8q7/olympus-base-cpp:latest",
};

/** GitHub's reported primary language -> base-image language token. */
export const LANGUAGE_TO_BASE: Record<string, string> = {
  "Python": "python",
  "TypeScript": "typescript",
  "JavaScript": "typescript",
  "Go": "go",
  "Rust": "rust",
  "Java": "jvm",
  "Kotlin": "jvm",
  "Scala": "jvm",
  "C++": "cpp",
};

/** Languages the quest accepts as a repo's primary language. */
export const ALLOWED_LANGUAGES = new Set([
  "TypeScript",
  "JavaScript",
  "Python",
  "Go",
  "Rust",
  "C++",
  "Java",
]);

/**
 * SPDX ids on the permissive allow-list. GitHub reports `license.spdx_id`;
 * anything outside this set (including NOASSERTION for a missing or custom
 * LICENSE) fails eligibility.
 */
export const ALLOWED_LICENSES = new Set([
  "MIT",
  "BSL-1.0",
  "Apache-2.0",
  "BSD-1-Clause",
  "BSD-2-Clause",
  "BSD-2-Clause-Flex",
  "BSD-2-Clause-FreeBSD",
  "BSD-2-Clause-Modification",
  "BSD-2-Clause-Patent",
  "BSD-2-Clause-Views",
  "BSD-3-Clause",
  "BSD-3-Clause-Attribution",
  "BSD-3-Clause-HealthLevelSeven",
  "BSD-3-Clause-LBNL",
  "BSD-3-Clause-Modification",
  "BSD-3-Clause-Open-MPI",
  "BSD-4-Clause",
  "BSD-4-Clause-Shortened",
  "BSD-4-Clause-UC",
  "BSD-4.3TAHOE",
  "BSD-Protection",
  "BSD-Source-Code",
  "CC-BY-1.0",
  "CC-BY-2.0",
  "CC-BY-2.5",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "FSFAP",
]);

/**
 * Words that must never appear in a patch, a path, or the Dockerfile — the
 * patches have to read like an ordinary PR to the repo.
 */
export const LEAK_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: "leak/olympus", re: /olympus/i },
  { rule: "leak/shipd", re: /shipd/i },
  { rule: "leak/quest", re: /\bquests?\b/i },
  { rule: "leak/mars", re: /\bmars\b/i },
  { rule: "leak/challenge", re: /\bchallenges?\b/i },
];

/** Test invocations that must not appear in a Dockerfile RUN step. */
const TEST_INVOCATIONS =
  /\b(pytest|go\s+test|cargo\s+test|mvn\s+(test|verify)|gradle\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|npx\s+jest|jest\b|vitest\b|mocha\b|deno\s+test|ctest\b|\.\/test\.sh)/;

/**
 * Package-manager installs. `pip install pytest` names a test runner but does
 * not run one — installing the runner at build time is exactly what the doc
 * asks for, since the runtime container is offline.
 */
const PACKAGE_INSTALL =
  /\b(pip3?\s+install|pipx\s+install|uv\s+(pip\s+)?(install|add|sync)|poetry\s+(add|install)|conda\s+install|npm\s+(install|ci|add)|yarn\s+(add|install)|pnpm\s+(add|install)|apt(-get)?\s+install|apk\s+add|dnf\s+install|yum\s+install|go\s+install|cargo\s+install|gem\s+install)\b/;

/**
 * Split a shell command into the sub-commands a Dockerfile RUN step chains
 * together, so an install can be told apart from an invocation sitting behind
 * the same `&&`.
 */
export function shellSubCommands(command: string): string[] {
  return command
    .replace(/\\\s*\n/g, " ")
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Does this RUN step actually execute tests? Install sub-commands are skipped,
 * so `RUN pip install pytest` is clean while
 * `RUN pip install pytest && pytest tests/` is not.
 */
export function runStepInvokesTests(instruction: string): boolean {
  return shellSubCommands(instruction.replace(/^\s*RUN\s+/i, ""))
    .filter((sub) => !PACKAGE_INSTALL.test(sub))
    .some((sub) => TEST_INVOCATIONS.test(sub));
}

/** Fail-fast flags that would truncate a test run. */
const FAIL_FAST_FLAGS =
  /(^|\s)(-x|--exitfirst|-ff|--failfast|--fail-fast|--bail|-failfast|--maxfail[= ]?1)(\s|$)/;

export const PHASES = [
  "repo",
  "problem",
  "tests",
  "solution",
  "dockerfile",
  "review",
  "ready",
  "submitted",
] as const;

export type Phase = typeof PHASES[number];

/** Artifact filename each phase gates on, for fingerprinting. */
export const PHASE_ARTIFACT: Partial<Record<Phase, string>> = {
  problem: "problem.md",
  tests: "test.patch",
  solution: "solution.patch",
  dockerfile: "Dockerfile",
};

export const SUBMISSIONS_DIR = "submissions";
/** Dockerfile name used inside the scratch clone — never part of a patch. */
export const REVIEW_DOCKERFILE = "Dockerfile.review";

// ---------- Shared schemas ---------------------------------------------------

export const SeveritySchema = z.enum(["error", "warn", "info"]);

export const FindingSchema = z.object({
  rule: z.string(),
  severity: SeveritySchema,
  message: z.string(),
  location: z.string().optional(),
  line: z.number().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const CheckRecordSchema = z.object({
  passed: z.boolean(),
  ranAt: z.string(),
  fingerprint: z.string().optional().describe(
    "SHA-256 of the artifact(s) this check was run against; a mismatch against disk makes the record stale.",
  ),
  summary: z.string().optional(),
});

/**
 * The prior-art check record. It carries fields the other four checks do not,
 * because the repo gate can only see `state.checks.priorArt` — it has no access
 * to the priorArt data resource — so the emptiness fact (`hitCount`), the
 * truncation flag and the adjudication all live here.
 *
 * Every field beyond the inherited CheckRecord is OPTIONAL, and every field of
 * `acknowledgement` is optional too: readState re-parses every stored blob
 * through the state schema on every read, and zod throws when a PRESENT object
 * is missing a REQUIRED key. A legacy priorArt record written before these
 * fields existed must still parse (leaving them undefined), and a
 * writer that omits a field (e.g. an acknowledgement with no note) must not
 * make the whole submission unreadable.
 *
 * `hitFingerprint` is kept distinct from the inherited `fingerprint` (which
 * recordState reads generically for staleness): a clear scan still hashes to a
 * non-empty digest, so the gate branches on `hitCount`, not the fingerprint.
 */
export const PriorArtRecordSchema = CheckRecordSchema.extend({
  truncated: z.boolean().optional().describe(
    "A search hit the result cap, so a clear count cannot be trusted; blocks the gate independently of hitCount.",
  ),
  hitCount: z.number().optional().describe(
    "Number of candidate prior-art hits the scan found; the gate opens only on a strictly-numeric 0.",
  ),
  hitFingerprint: z.string().optional().describe(
    "SHA-256 over the sorted search terms plus the sorted hit url+state pairs; an acknowledgement must recompute to this.",
  ),
  acknowledgement: z.object({
    fingerprint: z.string().optional(),
    urls: z.array(z.string()).optional(),
    acknowledgedAt: z.string().optional(),
    note: z.string().optional(),
  }).optional().describe(
    "Recorded adjudication of the hit set; present only after acknowledgePriorArt.",
  ),
});

// ---------- Process helpers --------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function run(
  bin: string,
  args: string[],
  opts: {
    cwd?: string;
    stdin?: string;
    timeoutSeconds?: number;
    env?: Record<string, string>;
  } = {},
): Promise<RunResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutSeconds) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutSeconds * 1000);
  }
  const cmd = new Deno.Command(bin, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
    signal: controller.signal,
  });
  try {
    const child = cmd.spawn();
    if (opts.stdin !== undefined) {
      // A child that exits before draining stdin makes the write or close
      // reject — BrokenPipe on Linux, a "Writable stream is closed" TypeError
      // from the web-stream layer on macOS. That is not a failure of the run;
      // the child's exit code below is the real outcome. Swallow it and let
      // child.output() report.
      try {
        const w = child.stdin.getWriter();
        await w.write(new TextEncoder().encode(opts.stdin));
        await w.close();
      } catch {
        // child closed stdin early; its exit code carries the outcome
      }
    }
    const out = await child.output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      timedOut,
    };
  } catch (e) {
    if (timedOut) {
      return {
        code: 124,
        stdout: "",
        stderr: `timed out after ${opts.timeoutSeconds}s`,
        timedOut: true,
      };
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The process-runner port — exactly the shape of `run`. Model methods take a
 * CommandRunner as an explicit first parameter so tests can substitute a
 * scripted fake without spawning git, gh or docker. This follows the
 * convention in swamp-go-brr/preflight.ts; the runner is threaded as a
 * parameter, never through the swamp-owned method context.
 */
export type CommandRunner = typeof run;

/** Production CommandRunner, backed by Deno.Command via run(). */
export const defaultRunner: CommandRunner = run;

/** Last N lines of a stream, for embedding in a data resource. */
export function tail(text: string, lines = 40): string {
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n").trim();
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

// ---------- GitHub helpers ---------------------------------------------------

export function parseRepoUrl(
  url: string,
): { owner: string; repo: string } | null {
  const cleaned = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = cleaned.match(
    /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export async function ghJson(
  run: CommandRunner,
  ghBin: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const res = await run(ghBin, args, { timeoutSeconds: 60 });
  if (res.code !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed (exit ${res.code}): ${
        tail(res.stderr, 10) || tail(res.stdout, 10)
      }`,
    );
  }
  try {
    return JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(
      `gh ${args.join(" ")} returned non-JSON output: ${tail(res.stdout, 5)}`,
    );
  }
}

// ---------- Leak scanning ----------------------------------------------------

/**
 * Scan arbitrary text for quest-identifying words. `where` labels the finding
 * (e.g. "test.patch"). Matches inside diff *paths* are errors; matches in
 * content are errors too — the doc is unambiguous that none of it belongs in a
 * patch — but "challenge"/"quest" are downgraded to warnings when the repo
 * itself legitimately uses the word, which the caller signals via `softWords`.
 */
export function scanLeaks(
  text: string,
  where: string,
  softWords = false,
): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (const { rule, re } of LEAK_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const soft = softWords &&
        (rule === "leak/challenge" || rule === "leak/quest");
      findings.push({
        rule,
        severity: soft ? "warn" : "error",
        message: `${where} line ${
          i + 1
        } contains a quest-identifying word — it must read like an ordinary PR to the repo: ${
          lines[i].trim().slice(0, 160)
        }`,
        location: where,
        line: i + 1,
      });
      break; // one finding per rule per file keeps the report readable
    }
  }
  return findings;
}

// ---------- Unified-diff parsing --------------------------------------------

export interface DiffFile {
  path: string;
  isNew: boolean;
  isDelete: boolean;
  mode?: string;
  addedLines: string[];
  removedCount: number;
}

/**
 * Parse a unified git diff into per-file added/removed lines. Only what the
 * checks need — file paths, new-file mode (test.sh must be 100755) and the
 * added lines used for the effective-LOC count.
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        path: m ? m[2] : line.slice("diff --git ".length),
        isNew: false,
        isDelete: false,
        addedLines: [],
        removedCount: 0,
      };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode ")) {
      current.isNew = true;
      current.mode = line.slice("new file mode ".length).trim();
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.isDelete = true;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.addedLines.push(line.slice(1));
    else if (line.startsWith("-")) current.removedCount++;
  }
  return files;
}

const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)tests?(\/|$)/i,
  /(^|\/)spec(\/|$)/i,
  /(^|\/)testdata(\/|$)/i,
  /_test\.(go|py|ts|tsx|js|jsx|rs|cc|cpp|cxx)$/,
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)conftest\.py$/,
  /Tests?\.java$/,
  /_spec\.rb$/,
];

const GENERATED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)vendor(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /\.(lock|sum)$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|deno\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/,
  /\.pb\.go$/,
  /_pb2\.py$/,
  /\.generated\./,
  /\.gen\.(go|ts|js)$/,
  /(^|\/)test\.sh$/,
];

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((re) => re.test(path));
}

const HASH_COMMENT_EXT = new Set([
  "py",
  "rb",
  "sh",
  "bash",
  "yaml",
  "yml",
  "toml",
  "cfg",
  "ini",
  "mk",
]);

/**
 * Comment/blank classification for the effective-LOC count. Deliberately
 * conservative: a line only stops counting when it is unambiguously a comment
 * or blank, so the reported number never flatters the submission.
 */
export function isNonCountingLine(path: string, line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (HASH_COMMENT_EXT.has(ext)) return t.startsWith("#");
  // C-family / JS / Go / Rust / Java / TS
  if (t.startsWith("//")) return true;
  if (t.startsWith("/*") || t.startsWith("*/")) return true;
  if (t.startsWith("*") && !t.startsWith("*=")) return true;
  if (ext === "py" && t.startsWith("#")) return true;
  return false;
}

export interface LocBreakdown {
  path: string;
  added: number;
  effective: number;
  excluded?: "test" | "generated";
}

export interface LocCount {
  rawAdded: number;
  effective: number;
  files: LocBreakdown[];
}

/**
 * Count the implementing lines among a single file's added lines.
 *
 * Python docstrings need a little state: a diff only shows added lines, so the
 * triple-quote toggle is tracked across the run of added lines rather than
 * against the whole file. A docstring opened and closed inside the added lines
 * is therefore excluded, which is the common case when a function is added.
 */
export function countFileLines(path: string, addedLines: string[]): number {
  const isPython = path.toLowerCase().endsWith(".py");
  let inDocstring = false;
  let count = 0;
  for (const line of addedLines) {
    const t = line.trim();
    if (isPython) {
      const fences = (t.match(/"""|'''/g) ?? []).length;
      if (inDocstring) {
        // Closing line of a docstring still belongs to the docstring.
        if (fences > 0) inDocstring = false;
        continue;
      }
      if (fences > 0) {
        // An odd number of fences leaves the docstring open.
        if (fences % 2 === 1) inDocstring = true;
        // A line that is only a docstring does not implement anything.
        if (/^("""|''')/.test(t)) continue;
      }
    }
    if (!isNonCountingLine(path, line)) count++;
  }
  return count;
}

/**
 * Effective solution lines: added lines that actually implement the task.
 * Blank lines, comments, docstrings, test files and generated files do not
 * count — the same arithmetic the reviewers apply to the LOC bar.
 */
export function countEffectiveLoc(patch: string): LocCount {
  const files = parseUnifiedDiff(patch);
  const breakdown: LocBreakdown[] = [];
  let rawAdded = 0;
  let effective = 0;
  for (const f of files) {
    const added = f.addedLines.length;
    rawAdded += added;
    let excluded: "test" | "generated" | undefined;
    if (isGeneratedPath(f.path)) excluded = "generated";
    else if (isTestPath(f.path)) excluded = "test";
    const eff = excluded ? 0 : countFileLines(f.path, f.addedLines);
    effective += eff;
    breakdown.push({ path: f.path, added, effective: eff, excluded });
  }
  breakdown.sort((a, b) => b.effective - a.effective || b.added - a.added);
  return { rawAdded, effective, files: breakdown };
}

// ---------- JUnit XML --------------------------------------------------------

export interface JUnitSummary {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  parsed: boolean;
}

/**
 * Summarise a JUnit report. A full XML parse is overkill for a pass/fail
 * summary and would drag in a dependency.
 *
 * The <testsuites> roll-up is only trusted when it actually carries counters:
 * pytest emits a bare `<testsuites name="pytest tests">` and puts the numbers
 * on the inner <testsuite>, so preferring the roll-up unconditionally reports
 * a run of zero tests.
 */
export function parseJUnit(xml: string): JUnitSummary {
  const summary: JUnitSummary = {
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    parsed: false,
  };
  const counters = (tag: string) => {
    const num = (attr: string) => {
      const m = tag.match(new RegExp(`\\b${attr}="(\\d+)"`));
      return m ? parseInt(m[1], 10) : 0;
    };
    return {
      tests: num("tests"),
      failures: num("failures"),
      errors: num("errors"),
      skipped: num("skipped"),
    };
  };

  // \b after "testsuite" keeps this from matching "<testsuites".
  const suiteTags = xml.match(/<testsuite\b[^>]*>/g) ?? [];
  const rollup = xml.match(/<testsuites\b[^>]*>/)?.[0];

  if (rollup && /\btests="\d+"/.test(rollup)) {
    Object.assign(summary, counters(rollup), { parsed: true });
    return summary;
  }
  if (suiteTags.length === 0) return summary;
  for (const tag of suiteTags) {
    const c = counters(tag);
    summary.tests += c.tests;
    summary.failures += c.failures;
    summary.errors += c.errors;
    summary.skipped += c.skipped;
  }
  summary.parsed = true;
  return summary;
}

// ---------- Problem-description linter ---------------------------------------

const IMPERATIVE_OPENERS =
  /^(add|fix|support|implement|make|allow|change|remove|handle|extend|expose|teach|accept|reject|return|preserve|honou?r|correct|prevent|ensure)\b/i;

const PRESCRIPTIVE_HINTS: Array<{ rule: string; re: RegExp; why: string }> = [
  {
    rule: "problem/leaks-file-path",
    re: /\b[\w./-]+\.(go|py|ts|tsx|js|rs|java|cpp|cc|h|hpp)\b/,
    why:
      "names a source file — describe the behaviour, not where it lives; a developer in the repo would find the file themselves",
  },
  {
    rule: "problem/leaks-symbol",
    re:
      /\b(class|function|method|struct|interface|field|helper)\s+`?[A-Za-z_][\w.]*`?/i,
    why:
      "names an internal identifier — that leaks the solution shape and is discoverable from the repo",
  },
  {
    rule: "problem/prescriptive",
    re:
      /\b(you should|you must|in order to do this|the implementation should|modify the|refactor the)\b/i,
    why:
      "reads as instructions rather than a description of required behaviour",
  },
];

/**
 * Lint problem.md against the doc's writing rules: maintainer-issue prose, no
 * spec-sheet formatting, no solution leakage, no quest words.
 *
 * Structural violations (headings, bullets, fences) and leak words are errors
 * because they are unambiguous; style signals (opener, motivation preamble,
 * named identifiers) are warnings, because the doc explicitly allows naming a
 * detail that is genuinely part of the contract.
 */
export function lintProblemText(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) {
        findings.push({
          rule: "problem/code-fence",
          severity: "error",
          message:
            "contains a fenced code block — the description must be prose; code snippets doing the describing are out of bounds",
          location: "problem.md",
          line: n,
        });
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      findings.push({
        rule: "problem/heading",
        severity: "error",
        message: "contains a markdown heading — write it as continuous prose",
        location: "problem.md",
        line: n,
      });
    }
    if (/^\s*[-*+]\s+\S/.test(line)) {
      findings.push({
        rule: "problem/bullet-list",
        severity: "error",
        message:
          "contains a bulleted list — the doc asks for natural prose, not a requirement list",
        location: "problem.md",
        line: n,
      });
    }
    if (/^\s*\d+[.)]\s+\S/.test(line)) {
      findings.push({
        rule: "problem/numbered-list",
        severity: "error",
        message:
          "contains a numbered list — the doc asks for natural prose, not a requirement list",
        location: "problem.md",
        line: n,
      });
    }
  }
  if (inFence) {
    findings.push({
      rule: "problem/unclosed-fence",
      severity: "warn",
      message: "an opened code fence is never closed",
      location: "problem.md",
    });
  }

  const body = text.trim();
  const firstLine = body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

  if (body.length < 400) {
    findings.push({
      rule: "problem/too-short",
      severity: "warn",
      message:
        `description is ${body.length} characters — that is rarely enough to pin down a task that is self-contained and unambiguous`,
      location: "problem.md",
    });
  }
  if (firstLine && !IMPERATIVE_OPENERS.test(firstLine)) {
    findings.push({
      rule: "problem/opener",
      severity: "info",
      message:
        'the first line does not open with the ask ("Add X to Y", "Fix Z when …") — check that it stands on its own without the title',
      location: "problem.md",
      line: 1,
    });
  }
  if (
    /^(currently|today|at present|right now|the repo (currently )?lacks|there is (currently )?no)\b/i
      .test(firstLine)
  ) {
    findings.push({
      rule: "problem/motivation-preamble",
      severity: "warn",
      message:
        'opens with a motivation / "what the repo currently lacks" preamble — the doc asks you to open with the ask itself',
      location: "problem.md",
      line: 1,
    });
  }
  for (const { rule, re, why } of PRESCRIPTIVE_HINTS) {
    const idx = body.split("\n").findIndex((l) => re.test(l));
    if (idx >= 0) {
      findings.push({
        rule,
        severity: "warn",
        message: `${why}`,
        location: "problem.md",
        line: idx + 1,
      });
    }
  }
  if (/`[^`]+`/.test(body)) {
    findings.push({
      rule: "problem/inline-code",
      severity: "info",
      message:
        "uses inline code spans — fine when the identifier is genuinely part of the contract (the approved example names SQL functions), a problem when it is naming internals",
      location: "problem.md",
    });
  }

  findings.push(...scanLeaks(body, "problem.md"));
  return findings;
}

// ---------- Dockerfile validator ---------------------------------------------

/**
 * Validate the Dockerfile against the doc's rules: an approved base image,
 * WORKDIR /app, everything installed at build time (the runtime container is
 * offline), no tests during build, and a bash CMD.
 */
export function lintDockerfileText(text: string): Finding[] {
  const findings: Finding[] = [];
  const raw = text.split("\n");
  // Join continuation lines so a multi-line RUN is inspected as one command.
  const instructions: Array<{ text: string; line: number }> = [];
  let buffer = "";
  let bufferStart = 0;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (/^\s*#/.test(line) || (line.trim() === "" && buffer === "")) continue;
    if (buffer === "") bufferStart = i + 1;
    buffer += (buffer ? "\n" : "") + line;
    if (/\\\s*$/.test(line)) continue;
    instructions.push({ text: buffer, line: bufferStart });
    buffer = "";
  }
  if (buffer !== "") instructions.push({ text: buffer, line: bufferStart });

  if (instructions.length === 0) {
    return [{
      rule: "dockerfile/empty",
      severity: "error",
      message: "Dockerfile has no instructions",
      location: "Dockerfile",
    }];
  }

  const first = instructions[0];
  const fromMatch = first.text.match(/^\s*FROM\s+(\S+)/i);
  if (!fromMatch) {
    findings.push({
      rule: "dockerfile/first-not-from",
      severity: "error",
      message: "the first instruction must be FROM an approved base image",
      location: "Dockerfile",
      line: first.line,
    });
  } else {
    const image = fromMatch[1];
    const approved = Object.values(BASE_IMAGES);
    if (!approved.includes(image)) {
      findings.push({
        rule: "dockerfile/base-image",
        severity: "error",
        message: `FROM ${image} is not one of the approved base images (${
          Object.keys(BASE_IMAGES).join(", ")
        })`,
        location: "Dockerfile",
        line: first.line,
      });
    }
  }

  const hasWorkdirApp = instructions.some((i) =>
    /^\s*WORKDIR\s+\/app\s*$/i.test(i.text.trim())
  );
  if (!hasWorkdirApp) {
    findings.push({
      rule: "dockerfile/workdir",
      severity: "error",
      message:
        "WORKDIR must be /app — tests are run from there and other paths break imports, editable installs and relative paths",
      location: "Dockerfile",
    });
  }

  const last = instructions[instructions.length - 1];
  if (!/^\s*CMD\s*\[\s*"\/bin\/bash"\s*\]\s*$/i.test(last.text.trim())) {
    findings.push({
      rule: "dockerfile/cmd",
      severity: "error",
      message: 'the Dockerfile must end with CMD ["/bin/bash"]',
      location: "Dockerfile",
      line: last.line,
    });
  }

  for (const inst of instructions) {
    if (!/^\s*RUN\b/i.test(inst.text)) continue;
    if (runStepInvokesTests(inst.text)) {
      findings.push({
        rule: "dockerfile/tests-in-build",
        severity: "error",
        message:
          "a RUN step invokes tests — the build sets things up, it does not test",
        location: "Dockerfile",
        line: inst.line,
      });
    }
  }

  const hasInstall = instructions.some((i) =>
    /^\s*RUN\b/i.test(i.text) &&
    /\b(pip|poetry|uv|npm|yarn|pnpm|go\s+mod|cargo|mvn|gradle|apt-get|apk|cmake|make)\b/
      .test(i.text)
  );
  if (!hasInstall) {
    findings.push({
      rule: "dockerfile/no-install",
      severity: "warn",
      message:
        "no dependency-installation RUN step — the container runs with --network none, so anything not installed at build time will be missing",
      location: "Dockerfile",
    });
  }

  // The approved base images are themselves named olympus-base-*, and the
  // Dockerfile is submitted as its own field rather than inside a patch — so
  // mask the mandated image references before scanning for quest words, or
  // every conforming Dockerfile reports a leak on line 1.
  let scannable = text;
  for (const img of Object.values(BASE_IMAGES)) {
    scannable = scannable.split(img).join("<approved-base-image>");
  }
  findings.push(...scanLeaks(scannable, "Dockerfile"));
  return findings;
}

// ---------- test.sh / patch structural checks --------------------------------

/**
 * Structural checks on the test patch that need no clone: test.sh must be
 * added at the repo root, executable, support both modes and --output_path,
 * and must not fail fast or name the quest.
 */
export function lintTestPatch(patch: string): Finding[] {
  const findings: Finding[] = [];
  const files = parseUnifiedDiff(patch);

  if (files.length === 0) {
    return [{
      rule: "tests/empty-patch",
      severity: "error",
      message: "test.patch contains no file diffs",
      location: "test.patch",
    }];
  }

  const testSh = files.find((f) => f.path === "test.sh");
  if (!testSh) {
    findings.push({
      rule: "tests/no-test-sh",
      severity: "error",
      message:
        "test.patch does not add test.sh at the repo root — the harness is part of the test patch",
      location: "test.patch",
    });
  } else {
    if (testSh.isNew && testSh.mode !== "100755") {
      findings.push({
        rule: "tests/test-sh-not-executable",
        severity: "error",
        message: `test.sh is added with mode ${
          testSh.mode ?? "unknown"
        } — reviewers invoke ./test.sh, so it must be committed executable (chmod +x before git diff)`,
        location: "test.patch",
      });
    }
    const body = testSh.addedLines.join("\n");
    if (!/\bbase\b/.test(body) || !/\bnew\b/.test(body)) {
      findings.push({
        rule: "tests/modes-missing",
        severity: "error",
        message:
          "test.sh does not appear to handle both the base and new modes",
        location: "test.sh",
      });
    }
    if (!/--output_path/.test(body)) {
      findings.push({
        rule: "tests/output-path-missing",
        severity: "error",
        message:
          "test.sh does not handle --output_path — JUnit XML must be written to the given path",
        location: "test.sh",
      });
    }
    if (!/^#!/.test(testSh.addedLines[0] ?? "")) {
      findings.push({
        rule: "tests/no-shebang",
        severity: "warn",
        message: "test.sh has no shebang line",
        location: "test.sh",
      });
    }
    for (let i = 0; i < testSh.addedLines.length; i++) {
      if (FAIL_FAST_FLAGS.test(testSh.addedLines[i])) {
        findings.push({
          rule: "tests/fail-fast",
          severity: "error",
          message:
            `test.sh uses a fail-fast flag — every test result is needed, not just the first failure: ${
              testSh.addedLines[i].trim().slice(0, 120)
            }`,
          location: "test.sh",
          line: i + 1,
        });
        break;
      }
    }
  }

  const touchesTests = files.some((f) =>
    f.path !== "test.sh" && isTestPath(f.path)
  );
  if (!touchesTests) {
    findings.push({
      rule: "tests/no-test-files",
      severity: "warn",
      message:
        "test.patch adds no file under a recognised test path — confirm the new tests are where the repo keeps its tests",
      location: "test.patch",
    });
  }

  for (const f of files) {
    for (const { rule, re } of LEAK_PATTERNS) {
      if (re.test(f.path)) {
        findings.push({
          rule: `${rule}-path`,
          severity: "error",
          message:
            `patched path "${f.path}" contains a quest-identifying word — no directories or files named challenge, quest or olympus`,
          location: "test.patch",
        });
      }
    }
  }
  findings.push(...scanLeaks(patch, "test.patch"));
  return findings;
}

/** Structural checks on the solution patch that need no clone. */
export function lintSolutionPatch(patch: string): Finding[] {
  const findings: Finding[] = [];
  const files = parseUnifiedDiff(patch);
  if (files.length === 0) {
    return [{
      rule: "solution/empty-patch",
      severity: "error",
      message: "solution.patch contains no file diffs",
      location: "solution.patch",
    }];
  }
  for (const f of files) {
    if (f.path === "test.sh" || isTestPath(f.path)) {
      findings.push({
        rule: "solution/touches-tests",
        severity: "warn",
        message:
          `solution.patch modifies ${f.path} — the solution should not be changing the tests it is meant to pass`,
        location: "solution.patch",
      });
    }
    for (const { rule, re } of LEAK_PATTERNS) {
      if (re.test(f.path)) {
        findings.push({
          rule: `${rule}-path`,
          severity: "error",
          message: `patched path "${f.path}" contains a quest-identifying word`,
          location: "solution.patch",
        });
      }
    }
  }
  findings.push(...scanLeaks(patch, "solution.patch"));
  return findings;
}

export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

export function summarise(findings: Finding[]): string {
  const e = findings.filter((f) => f.severity === "error").length;
  const w = findings.filter((f) => f.severity === "warn").length;
  const i = findings.filter((f) => f.severity === "info").length;
  return `${e} error(s), ${w} warning(s), ${i} note(s)`;
}
