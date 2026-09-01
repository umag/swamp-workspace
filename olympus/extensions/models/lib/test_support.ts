// =============================================================================
// Test-support fixtures for the olympus/submission model.
//
// Two things the method-level tests need and cannot get from production code:
//
//   1. A scripted CommandRunner — the process-runner port (lib/checks.ts) so a
//      test can answer `git`, `gh` and `docker` calls without spawning them.
//   2. An in-memory Ctx double + a real temp workspace, so an extracted impl
//      (checkRepoImpl, scanPriorArtImpl, checkPatchesImpl, localReviewImpl) can
//      run start-to-finish against seeded state and materialised artifacts.
//
// The Ctx double imports the Ctx and GlobalArgs types the model exports rather
// than re-declaring them, so a shape drift in the model is a compile error here
// even with noImplicitAny off.
// =============================================================================

import type { CommandRunner, RunResult } from "./checks.ts";
import type { Ctx, GlobalArgs } from "../olympus_submission.ts";

// ---------- resource naming --------------------------------------------------

/**
 * Mirror of the model's private `dataName`: `readResource`/`writeResource` key
 * on the instance name alone, and every data name carries its kind as a suffix.
 * Kept in step with the model by the resource round-trip tests — seed the state
 * under `dataName(slug, "state")` and the prior-art record under
 * `dataName(slug, "priorart")`.
 */
export function dataName(slug: string, kind: string): string {
  return `${slug}.${kind}`;
}

// ---------- scripted CommandRunner -------------------------------------------

export type RunOpts = NonNullable<Parameters<CommandRunner>[2]>;

export interface RunCall {
  bin: string;
  args: string[];
  opts: RunOpts;
}

/**
 * Answers one recorded call. Return a partial RunResult to override the
 * success default `{ code: 0, stdout: "", stderr: "", timedOut: false }`;
 * return nothing to accept it (a benign `git clean`, say).
 */
export type RunHandler = (call: RunCall) => Partial<RunResult> | void;

export interface ScriptedRunner {
  (bin: string, args: string[], opts?: RunOpts): Promise<RunResult>;
  /** Every call in order, for assertions on what was invoked. */
  calls: RunCall[];
}

/**
 * A CommandRunner whose every invocation is recorded and answered by `handler`.
 * Assignable to `CommandRunner` — the impls take it as their first parameter.
 */
export function scriptedRunner(handler: RunHandler = () => {}): ScriptedRunner {
  const calls: RunCall[] = [];
  const runner = ((bin: string, args: string[], opts: RunOpts = {}) => {
    const call: RunCall = { bin, args, opts };
    calls.push(call);
    const partial = handler(call) ?? {};
    const result: RunResult = {
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...partial,
    };
    return Promise.resolve(result);
  }) as ScriptedRunner;
  runner.calls = calls;
  return runner;
}

/** RunResult carrying `obj` as JSON on stdout — for mocking `gh api` output. */
export function jsonResult(obj: unknown): Partial<RunResult> {
  return { code: 0, stdout: JSON.stringify(obj) };
}

/** A non-zero exit with `stderr` — for mocking a failed git/gh/docker call. */
export function failResult(code: number, stderr = ""): Partial<RunResult> {
  return { code, stderr };
}

// ---------- in-memory Ctx double ---------------------------------------------

export interface CtxWrite {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

export interface CtxLog {
  msg: string;
  data?: Record<string, unknown>;
}

export interface FakeCtx extends Ctx {
  /** Backing store, keyed on instance name, shared by read and write. */
  store: Map<string, Record<string, unknown>>;
  /** Every writeResource call in order. */
  writes: CtxWrite[];
  /** Every logger.info call in order. */
  logs: CtxLog[];
}

/**
 * An in-memory Ctx. `readResource` serves seeded resources by instance name and
 * sees anything `writeResource` persists, so an impl that writes state and then
 * a later method that reads it round-trip through the same store. Seed the
 * pre-existing SubmissionState (and, for prior-art tests, the priorArt record)
 * via `seed`.
 */
export function fakeCtx(opts: {
  globalArgs: GlobalArgs;
  seed?: Array<{ name: string; data: Record<string, unknown> }>;
}): FakeCtx {
  const store = new Map<string, Record<string, unknown>>();
  for (const s of opts.seed ?? []) store.set(s.name, s.data);
  const writes: CtxWrite[] = [];
  const logs: CtxLog[] = [];

  return {
    globalArgs: opts.globalArgs,
    logger: {
      info: (msg: string, data?: Record<string, unknown>) => {
        logs.push({ msg, data });
      },
    },
    readResource: (name: string, _version?: number) =>
      Promise.resolve(store.get(name) ?? null),
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      store.set(name, data);
      return Promise.resolve({ name });
    },
    store,
    writes,
    logs,
  };
}

// ---------- seeded state -----------------------------------------------------

/**
 * A schema-valid SubmissionState as a plain resource object (what readResource
 * hands back — readState re-parses it through SubmissionStateSchema). Returned
 * loosely typed on purpose: the model does not export the state type, and the
 * schema parse in readState is the real validator. Override any field.
 */
export function makeState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    slug: "sample",
    repoUrl: "https://github.com/acme/widget",
    owner: "acme",
    repo: "widget",
    commit: "a".repeat(40),
    phase: "review",
    dir: "/nonexistent",
    createdAt: at,
    updatedAt: at,
    history: [],
    checks: {},
    ...overrides,
  };
}

// ---------- temp workspace ---------------------------------------------------

/** `null` omits the file, to exercise a missing-artifact path. */
export interface ArtifactContents {
  problem: string | null;
  testPatch: string | null;
  solutionPatch: string | null;
  dockerfile: string | null;
}

export const DEFAULT_PROBLEM = `## Add a feature

Implement the feature described below. Existing tests must keep passing; the
new tests must fail until the change is in place.
`;

export const DEFAULT_TEST_PATCH = `diff --git a/test.sh b/test.sh
new file mode 100755
index 0000000..1111111
--- /dev/null
+++ b/test.sh
@@ -0,0 +1,4 @@
+#!/usr/bin/env bash
+set -euo pipefail
+# supports base and new modes
+echo ok
diff --git a/tests/test_new.py b/tests/test_new.py
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/tests/test_new.py
@@ -0,0 +1,2 @@
+def test_feature():
+    assert True
`;

export const DEFAULT_SOLUTION_PATCH =
  `diff --git a/src/widget.py b/src/widget.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/widget.py
@@ -0,0 +1,2 @@
+def feature():
+    return 42
`;

export const DEFAULT_DOCKERFILE = `FROM python:3.12-slim
WORKDIR /app
COPY . .
`;

export interface TempSubmission {
  /** Workspace root — pass as globalArgs.path. */
  root: string;
  /** submissions/<slug>. */
  dir: string;
  /** <dir>/.work/repo, pre-created so localReview's Dockerfile write lands. */
  repoDir: string;
  slug: string;
  /** Schema-valid seed state whose `dir` points at `dir`. */
  state: Record<string, unknown>;
  /** Remove the temp tree. Idempotent. */
  cleanup: () => Promise<void>;
}

/**
 * Materialise a real temp workspace: submissions/<slug>/ with the four
 * artifacts on disk and an empty `.work/repo` pre-created (a fake runner never
 * clones, so without it localReview throws writing the review Dockerfile before
 * any stage runs). The returned `state.dir` points at the submission dir.
 */
export async function buildWorkspace(opts: {
  slug?: string;
  repoUrl?: string;
  commit?: string;
  artifacts?: Partial<ArtifactContents>;
  state?: Record<string, unknown>;
} = {}): Promise<TempSubmission> {
  const slug = opts.slug ?? "sample";
  const repoUrl = opts.repoUrl ?? "https://github.com/acme/widget";
  const commit = opts.commit ?? "a".repeat(40);

  const root = await Deno.makeTempDir({ prefix: "olympus-test-" });
  const dir = `${root}/submissions/${slug}`;
  const repoDir = `${dir}/.work/repo`;
  await Deno.mkdir(repoDir, { recursive: true });

  const a: ArtifactContents = {
    problem: DEFAULT_PROBLEM,
    testPatch: DEFAULT_TEST_PATCH,
    solutionPatch: DEFAULT_SOLUTION_PATCH,
    dockerfile: DEFAULT_DOCKERFILE,
    ...opts.artifacts,
  };
  if (a.problem !== null) {
    await Deno.writeTextFile(`${dir}/problem.md`, a.problem);
  }
  if (a.testPatch !== null) {
    await Deno.writeTextFile(`${dir}/test.patch`, a.testPatch);
  }
  if (a.solutionPatch !== null) {
    await Deno.writeTextFile(`${dir}/solution.patch`, a.solutionPatch);
  }
  if (a.dockerfile !== null) {
    await Deno.writeTextFile(`${dir}/Dockerfile`, a.dockerfile);
  }

  const state = makeState({
    slug,
    repoUrl,
    commit,
    dir,
    ...opts.state,
  });

  return {
    root,
    dir,
    repoDir,
    slug,
    state,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

/**
 * Convenience over fakeCtx + buildWorkspace: a Ctx whose globalArgs.path is the
 * workspace root and whose store is seeded with the submission's state. Extra
 * resources (e.g. a priorArt record) go in `seed`.
 */
export function ctxFor(
  ws: TempSubmission,
  extra: {
    globalArgs?: Partial<GlobalArgs>;
    seed?: Array<{ name: string; data: Record<string, unknown> }>;
  } = {},
): FakeCtx {
  return fakeCtx({
    globalArgs: { path: ws.root, ...extra.globalArgs },
    seed: [
      { name: dataName(ws.slug, "state"), data: ws.state },
      ...(extra.seed ?? []),
    ],
  });
}
