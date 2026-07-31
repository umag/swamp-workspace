// Coverage suite for @magistr/swamp-go-brr: regression guards for behavior
// NOT already pinned by the contract-fixture, methods, or adversarial suites
// (STANDARD.md's coverage role: "if someone deletes this guard, does a test
// go red?").
//
// gobrr.ts / docker_verify.ts / source_integration.ts / preflight.ts / lib/*
// are UNMODIFIED — every test here PINS existing behavior.
//
// Specifically owns (not duplicated elsewhere):
//  - nextDecision's remaining three halt branches NOT already covered by the
//    kept gobrr.test.ts (which only exercises the wallclock cap directly):
//    the invocations cap, the "stalled" halt (integration, not just the pure
//    detectStall), and the "exhausted"/final-"blocked" halts.
//  - markBlocked's FIXPOINT iteration — a chain longer than one propagation
//    pass (BAD_STATUSES includes "blocked" itself, so each pass only
//    propagates one hop; a naive single-pass impl would under-mark a deep
//    chain).
//  - addFollowup's cycle guard: a fresh follow-up node structurally can never
//    have a dependency path back to its parent, so the guard cannot fire in
//    practice — pinned as a coverage finding, plus a safety check that an
//    UNRELATED pre-existing cycle elsewhere in the DAG does not break the
//    (bounded, visited-set) traversal.
//  - gobrr's abort/complete/hydrate/emit_otlp edge cases the methods suite's
//    happy path does not reach: complete() rejecting an incomplete run,
//    hydrate()/emit_otlp() rejecting when no run exists, abort() with zero
//    leased tasks, and emit_otlp() on a fresh (traceId, zero-attempt) run.
//  - source-integration apply()'s real-fs write-error path, a failing `jj
//    new`, and the read-with-fallback-to-"" snapshot for an @@EDIT targeting
//    a file that does not exist on disk.
//  - otlp-export's unparseable-URL validate-error and the readResource
//    capability being entirely ABSENT (not just resolving to null).
//  - preflight's dockerReachable throw surfaced through the pin_image
//    METHOD (not just the pure pinImage+injected-runner level already
//    covered), and the push-when-no-digest branch driven the same way.
//  - lib/otlp's gauge (vs sum) metric-kind branch and the double (vs int)
//    numeric-attribute encoding branch — both unexercised by the kept
//    lib/otlp.test.ts, which only uses "sum" metrics and integer attributes.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addFollowup,
  markBlocked,
  model as gobrrModel,
  nextDecision,
  type Run,
  type Task,
} from "./gobrr.ts";
import { model as siModel } from "./source_integration.ts";
import { model as preflightModel } from "./preflight.ts";
import { model as otlpExportModel } from "./otlp_export.ts";
import { serializeMetrics, serializeTrace } from "./lib/otlp.ts";

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention)
// ---------------------------------------------------------------------------

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function callMethod(
  m: { methods: unknown },
  name: string,
  args: Record<string, unknown>,
  ctx: unknown,
): Promise<unknown> {
  const method = (m.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function stubDirectOutput(
  responder: (cmd: string, args: string[]) => CommandResult,
): () => void {
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).Deno.Command;
  class FakeCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    output() {
      const r = responder(this.#cmd, this.#args);
      return Promise.resolve({
        code: r.code,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.Command = orig;
  };
}

function stubSpawnCommand(
  responder: (cmd: string, args: string[]) => CommandResult,
): () => void {
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).Deno.Command;
  class FakeChild {
    stdin = {
      getWriter: () => ({
        write: (_chunk: Uint8Array) => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    };
    constructor(private cmd: string, private args: string[]) {}
    output() {
      const r = responder(this.cmd, this.args);
      return Promise.resolve({
        code: r.code,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      });
    }
  }
  class FakeCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#cmd = cmd;
      this.#args = opts?.args ?? [];
    }
    spawn() {
      return new FakeChild(this.#cmd, this.#args);
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.Command = orig;
  };
}

type Written = { spec: string; name: string; data: Record<string, unknown> };

function collector(): {
  written: Written[];
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
} {
  const written: Written[] = [];
  return {
    written,
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      return Promise.resolve(data);
    },
  };
}

function makeGobrrCtx() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    ctx: {
      logger: { info: () => {} },
      readResource: (name: string) => Promise.resolve(store.get(name) ?? null),
      writeResource: (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        store.set(name, data);
        return Promise.resolve({ name });
      },
      definition: { name: "gobrr-coverage-test" },
    },
  };
}

const T0 = "2026-07-01T00:00:00.000Z";

function cfg(over: Partial<Run["config"]> = {}): Run["config"] {
  return {
    verifyCommand: "deno test",
    verifyInputs: ["tests/"],
    repoScope: "src",
    toolchainImage: "img@sha256:abc",
    leafModel: "",
    leafEffort: "low",
    maxConcurrentVMs: 8,
    maxAttempts: 2,
    maxFollowupDepth: 3,
    maxInvocations: 100,
    leaseTtlSeconds: 1800,
    wallclockSeconds: 7200,
    stallN: 2,
    stallK: 3,
    perInvocationCostEstimate: 0,
    pinnedVersions: {},
    ...over,
  };
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    spec: "do a thing",
    writeAllowlist: ["src/a.ts"],
    dependsOn: [],
    gate: "real",
    status: "pending",
    attempts: 0,
    followupDepth: 0,
    lease: null,
    outcome: null,
    failureKind: null,
    failureSignature: null,
    mergeDisposition: null,
    createdAt: T0,
    ...over,
  };
}

function run(tasks: Task[], over: Partial<Run> = {}): Run {
  return {
    status: "running",
    intake: "build it",
    config: cfg(),
    tasks,
    invocations: 0,
    costEstimate: 0,
    offers: [],
    haltReason: null,
    haltOptions: [],
    stallCulprits: [],
    stallSignature: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

// ===========================================================================
// nextDecision — the three halt branches not covered by gobrr.test.ts.
// ===========================================================================

Deno.test("nextDecision: halts on the invocations cap", () => {
  const r = run([task({ id: "a" })], {
    invocations: 5,
    config: cfg({ maxInvocations: 5 }),
  });
  const { decision, run: nr } = nextDecision(r, "drv", T0);
  assertEquals(decision.cap, "invocations");
  assertEquals(nr.status, "halted");
});

Deno.test("nextDecision: integrates detectStall — halts 'stalled' when no ready/leased task remains and the offer window shows no progress", () => {
  const r = run(
    [task({ id: "a", status: "test_failed", failureSignature: "a:exit1" })],
    { offers: ["a", "a", "a"], config: cfg({ stallK: 3, maxAttempts: 99 }) },
  );
  const { decision, run: nr } = nextDecision(r, "drv", T0);
  assertEquals(decision.outcome, "stalled");
  assertEquals(nr.status, "halted");
  assertEquals(nr.stallCulprits, ["a"]);
});

Deno.test("nextDecision: halts 'exhausted' when an exhausted task blocks the run and nothing else is ready/leased/stalled", () => {
  const r = run([task({ id: "a", status: "exhausted" })]);
  const { decision } = nextDecision(r, "drv", T0);
  assertEquals(decision.outcome, "exhausted");
});

Deno.test("nextDecision: falls through to the final 'blocked' halt when remaining tasks are blocked on a non-exhausted failed dependency", () => {
  // "b" depends on "a" (infra_error, NOT exhausted) — markBlocked marks b
  // blocked; no ready/leased task, not stalled, and no task literally has
  // status "exhausted" — must reach the final default branch.
  const r = run([
    task({ id: "a", status: "infra_error" }),
    task({ id: "b", dependsOn: ["a"] }),
  ]);
  const { decision, run: nr } = nextDecision(r, "drv", T0);
  assertEquals(decision.outcome, "blocked");
  assertEquals(nr.tasks.find((t) => t.id === "b")!.status, "blocked");
});

// ===========================================================================
// markBlocked — fixpoint iteration over a chain deeper than one pass.
// ===========================================================================

Deno.test("markBlocked: FIXPOINT — a 4-hop chain off an exhausted root is fully propagated in ONE call (not just the first hop)", () => {
  // BAD_STATUSES includes "blocked" itself, so each internal pass only
  // propagates one hop further; markBlocked's own loop must re-run until
  // nothing changes (fixpoint) to fully mark b/c/d/e in a single call.
  const tasks = markBlocked([
    task({ id: "a", status: "exhausted" }),
    task({ id: "b", dependsOn: ["a"] }),
    task({ id: "c", dependsOn: ["b"] }),
    task({ id: "d", dependsOn: ["c"] }),
    task({ id: "e", dependsOn: ["d"] }),
  ]);
  for (const id of ["b", "c", "d", "e"]) {
    assertEquals(
      tasks.find((t) => t.id === id)!.status,
      "blocked",
      `${id} must be fully propagated to blocked within one markBlocked() call`,
    );
  }
});

// ===========================================================================
// addFollowup — cycle guard: structurally unreachable, and safe alongside an
// unrelated pre-existing cycle elsewhere in the DAG.
// ===========================================================================

Deno.test("addFollowup: the cycle guard cannot fire in practice — a freshly-created follow-up always starts with an EMPTY dependsOn", () => {
  // addFollowup calls wouldCycle(tasks, parentId, fid) where `fid` is the
  // BRAND NEW follow-up node it just pushed with dependsOn: []. wouldCycle
  // asks "does fid's dependency chain reach parentId?" — since fid has no
  // outgoing deps, the answer is always false. The guard is real defense-in-
  // depth, but under addFollowup's own construction it is unreachable.
  const r = run([task({
    id: "p",
    status: "leased",
    lease: {
      owner: "drv",
      expiresAt: "2999-01-01T00:00:00.000Z",
      heartbeatAt: T0,
    },
  })]);
  const res = addFollowup(r, "p", "add a fix", ["src/b.ts"], T0);
  assert(
    "run" in res,
    "a normal add_followup call must succeed, never hit the guard",
  );
});

Deno.test("addFollowup: succeeds even when the DAG already contains an UNRELATED cycle elsewhere (guard traversal is bounded by a visited set)", () => {
  const r = run([
    task({ id: "x", dependsOn: ["y"] }),
    task({ id: "y", dependsOn: ["x"] }), // x<->y cycle, unrelated to p/fid
    task({
      id: "p",
      status: "leased",
      lease: {
        owner: "drv",
        expiresAt: "2999-01-01T00:00:00.000Z",
        heartbeatAt: T0,
      },
    }),
  ]);
  const res = addFollowup(r, "p", "add a fix", ["src/b.ts"], T0);
  assert(
    "run" in res,
    "an unrelated pre-existing cycle elsewhere must not break add_followup " +
      "(wouldCycle's `seen` set bounds the traversal — no infinite loop)",
  );
});

// ===========================================================================
// gobrr methods — abort/complete/hydrate/emit_otlp edge cases.
// ===========================================================================

Deno.test("gobrr.complete: rejects when not all tasks are done", async () => {
  const { ctx } = makeGobrrCtx();
  await callMethod(gobrrModel, "start", {
    intake: "x",
    config: {
      verifyCommand: "deno test",
      verifyInputs: ["tests/"],
      repoScope: "/repo",
      toolchainImage: "img@sha256:" + "a".repeat(64),
    },
  }, ctx);
  await callMethod(gobrrModel, "seed_tasks", {
    tasks: [{ id: "t1", spec: "x", writeAllowlist: ["src/a.ts"] }],
  }, ctx);
  await assertRejects(
    () => callMethod(gobrrModel, "complete", {}, ctx),
    Error,
    "not all tasks are done",
  );
});

Deno.test("gobrr.hydrate / gobrr.emit_otlp: both reject 'no run — call start first' before any run exists", async () => {
  const { ctx } = makeGobrrCtx();
  await assertRejects(
    () => callMethod(gobrrModel, "hydrate", {}, ctx),
    Error,
    "no run",
  );
  await assertRejects(
    () => callMethod(gobrrModel, "emit_otlp", {}, ctx),
    Error,
    "no run",
  );
});

Deno.test("gobrr.abort: a run with ZERO leased tasks reports an empty leasedVms list", async () => {
  const { store, ctx } = makeGobrrCtx();
  await callMethod(gobrrModel, "start", {
    intake: "x",
    config: {
      verifyCommand: "deno test",
      verifyInputs: ["tests/"],
      repoScope: "/repo",
      toolchainImage: "img@sha256:" + "a".repeat(64),
    },
  }, ctx);
  await callMethod(gobrrModel, "abort", { reason: "nothing running yet" }, ctx);
  const decision = store.get("decision") as Record<string, unknown>;
  assertEquals(decision.leasedVms, []);
});

Deno.test("gobrr.emit_otlp: a fresh run (traceId set, zero attempts, no records) yields trace status=empty", async () => {
  const { store, ctx } = makeGobrrCtx();
  await callMethod(gobrrModel, "start", {
    intake: "x",
    config: {
      verifyCommand: "deno test",
      verifyInputs: ["tests/"],
      repoScope: "/repo",
      toolchainImage: "img@sha256:" + "a".repeat(64),
    },
  }, ctx);
  await callMethod(gobrrModel, "seed_tasks", {
    tasks: [{ id: "t1", spec: "x", writeAllowlist: ["src/a.ts"] }],
  }, ctx);
  await callMethod(gobrrModel, "emit_otlp", {}, ctx);
  const trace = store.get("traceOtlp") as Record<string, unknown>;
  assertEquals(trace.status, "empty");
});

// ===========================================================================
// source-integration apply() — real write-error, failing jj new, and the
// read-with-fallback-to-"" snapshot for a nonexistent edit target.
// ===========================================================================

async function withTempRepo(
  fn: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoRoot}/.jj`, { recursive: true });
    await fn(repoRoot);
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
  }
}

Deno.test("apply: a real filesystem write error (target path collides with an existing directory) is recorded as a 'transport' failure, not a throw", async () => {
  await withTempRepo(async (repoRoot) => {
    // "blocked" exists as a DIRECTORY, so writing a FILE at that exact path
    // must fail with a real Deno fs error (EISDIR-equivalent).
    await Deno.mkdir(`${repoRoot}/blocked`, { recursive: true });
    const nonce = "nwrite";
    const restore = stubDirectOutput((_cmd, args) => {
      if (args.includes("new")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    try {
      const { written, writeResource } = collector();
      const ctx = {
        logger: { info: () => {} },
        globalArgs: { jjPath: "jj" },
        writeResource,
      };
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [{
          taskId: "t1",
          rawStdout:
            `<<<GOBRR:${nonce}\n@@NEWFILE blocked\nx\n@@ENDFILE\nGOBRR:${nonce}>>>`,
          nonce,
          writeAllowlist: ["blocked"],
        }],
      }, ctx); // must not throw — apply() catches per-task write errors
      const applied = written.find((w) => w.spec === "applied")!;
      const t1 = (applied.data.results as Record<string, unknown>).t1 as Record<
        string,
        unknown
      >;
      assertEquals(t1.failureKind, "transport");
    } finally {
      restore();
    }
  });
});

Deno.test("apply: a failing `jj new` is recorded as a per-task 'transport' failure; the fan-out loop continues to the next task", async () => {
  await withTempRepo(async (repoRoot) => {
    let newCalls = 0;
    const nonceOk = "nok";
    const restore = stubDirectOutput((_cmd, args) => {
      if (args.includes("new")) {
        newCalls++;
        if (newCalls === 1) {
          return { code: 1, stdout: "", stderr: "jj: conflict" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("diff")) {
        return {
          code: 0,
          stdout: "diff --git a/ok.ts b/ok.ts\nnew file mode 100644\n",
          stderr: "",
        };
      }
      if (args.includes("log")) {
        return { code: 0, stdout: "cid2\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    try {
      const { written, writeResource } = collector();
      const ctx = {
        logger: { info: () => {} },
        globalArgs: { jjPath: "jj" },
        writeResource,
      };
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [
          {
            taskId: "fails",
            rawStdout:
              `<<<GOBRR:n1\n@@NEWFILE fail.ts\nx\n@@ENDFILE\nGOBRR:n1>>>`,
            nonce: "n1",
            writeAllowlist: ["fail.ts"],
          },
          {
            taskId: "ok",
            rawStdout:
              `<<<GOBRR:${nonceOk}\n@@NEWFILE ok.ts\ny\n@@ENDFILE\nGOBRR:${nonceOk}>>>`,
            nonce: nonceOk,
            writeAllowlist: ["ok.ts"],
          },
        ],
      }, ctx);
      const applied = written.find((w) => w.spec === "applied")!;
      const results = applied.data.results as Record<string, unknown>;
      const fails = results.fails as Record<string, unknown>;
      const ok = results.ok as Record<string, unknown>;
      assertEquals(fails.failureKind, "transport");
      assert((fails.note as string).includes("jj new"));
      assertEquals(
        ok.changeId,
        "cid2",
        "the SECOND task in the fan-out still applies cleanly",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("apply: an @@EDIT targeting a file absent from disk reads back '' (never undefined) and reports envelope_parse (@@OLD not found)", async () => {
  await withTempRepo(async (repoRoot) => {
    const nonce = "nmiss";
    const restore = stubDirectOutput((_cmd, args) => {
      if (args.includes("new")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    try {
      const { written, writeResource } = collector();
      const ctx = {
        logger: { info: () => {} },
        globalArgs: { jjPath: "jj" },
        writeResource,
      };
      await callMethod(siModel, "apply", {
        repoScope: repoRoot,
        base: "base1",
        tasks: [{
          taskId: "t1",
          rawStdout:
            `<<<GOBRR:${nonce}\n@@EDIT missing.ts\n@@OLD\nsomething\n@@NEW\nreplaced\n@@ENDEDIT\nGOBRR:${nonce}>>>`,
          nonce,
          writeAllowlist: ["missing.ts"],
        }],
      }, ctx);
      const applied = written.find((w) => w.spec === "applied")!;
      const t1 = (applied.data.results as Record<string, unknown>).t1 as Record<
        string,
        unknown
      >;
      assertEquals(
        t1.failureKind,
        "envelope_parse",
        "a missing-on-disk edit target reads back as '' (not undefined), so " +
          "planApply's @@OLD-not-found path fires (never a throw from a " +
          "missing snapshot entry)",
      );
    } finally {
      restore();
    }
  });
});

// ===========================================================================
// otlp-export — validate-error (unparseable URL) + readResource ABSENT.
// ===========================================================================

Deno.test("otlp-export: an unparseable endpoint URL is rejected via validateEndpoint's catch branch", async () => {
  const { written, writeResource } = collector();
  const ctx = {
    logger: { info: () => {} },
    globalArgs: { endpoint: "not a url", token: "t" },
    readResource: (_n: string) => Promise.resolve({}),
    writeResource,
    definition: { name: "x" },
  };
  await callMethod(otlpExportModel, "export_run", {}, ctx);
  const status = written.find((w) => w.spec === "exportStatus")!;
  assertEquals(status.data.status, "error");
  assertEquals(status.data.reason, "unparseable endpoint URL");
});

Deno.test("otlp-export: readResource capability entirely ABSENT (undefined, not just resolving null) still posts an empty payload without throwing", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 200 }));
  try {
    const { written, writeResource } = collector();
    const ctx = {
      logger: { info: () => {} },
      globalArgs: { endpoint: "https://c.example.com/v1/traces", token: "t" },
      readResource: undefined,
      writeResource,
      definition: { name: "x" },
    };
    await callMethod(otlpExportModel, "export_run", {}, ctx); // must not throw
    const status = written.find((w) => w.spec === "exportStatus")!;
    assertEquals(status.data.status, "ok");
  } finally {
    globalThis.fetch = orig;
  }
});

// ===========================================================================
// preflight — dockerReachable throw + push-when-no-digest, via the METHOD.
// ===========================================================================

Deno.test("preflight.pin_image: docker unreachable surfaces the helpful error at the METHOD level (spawn-shape stub)", async () => {
  const restore = stubSpawnCommand((cmd, args) => {
    assertEquals(cmd, "docker");
    if (args.join(" ") === "info") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  try {
    const { writeResource } = collector();
    const ctx = {
      globalArgs: preflightModel.globalArguments.parse({}),
      writeResource,
    };
    await assertRejects(
      () =>
        callMethod(preflightModel, "pin_image", {
          name: "proj",
          tag: "gate",
          sourceImage: "denoland/deno:2.8.3",
        }, ctx),
      Error,
      "docker' group",
    );
  } finally {
    restore();
  }
});

Deno.test("preflight.pin_image: buildContext path with no initial digest triggers `docker push` before the digest resolves (METHOD level)", async () => {
  const DIGEST = "127.0.0.1:5000/proj@sha256:" + "b".repeat(64);
  let pushed = false;
  const restore = stubSpawnCommand((cmd, args) => {
    assertEquals(cmd, "docker");
    const joined = args.join(" ");
    if (joined === "info") return { code: 0, stdout: "", stderr: "" };
    if (joined.includes("inspect gobrr-registry")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("image inspect")) {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (joined.startsWith("build ")) return { code: 0, stdout: "", stderr: "" };
    if (joined.startsWith("push ")) {
      pushed = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("--format {{.RepoDigests}}")) {
      return { code: 0, stdout: pushed ? `[${DIGEST}]` : "[]", stderr: "" };
    }
    if (joined.startsWith("pull ")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  try {
    const { written, writeResource } = collector();
    const ctx = {
      globalArgs: preflightModel.globalArguments.parse({}),
      writeResource,
    };
    await callMethod(preflightModel, "pin_image", {
      name: "proj",
      tag: "gate",
      buildContext: "/codebase/.gate",
    }, ctx);
    assert(
      pushed,
      "docker push must be invoked when the built tag has no digest yet",
    );
    const pinned = written.find((w) => w.spec === "pinned")!;
    assertEquals(pinned.data.image, DIGEST);
    assertEquals(pinned.data.built, true);
  } finally {
    restore();
  }
});

// ===========================================================================
// lib/otlp — gauge (vs sum) metric kind + double (vs int) attribute encoding.
// ===========================================================================

Deno.test("serializeMetrics: a 'gauge' kind metric emits {gauge:{dataPoints}}, NOT {sum:{...}}", () => {
  const out = serializeMetrics({
    serviceName: "swamp-go-brr",
    metrics: [{
      name: "gobrr.leaf.concurrency",
      kind: "gauge",
      points: [{ attributes: { gate: "real" }, value: 3 }],
    }],
  }) as Record<string, unknown>;
  const rm = (out.resourceMetrics as Array<Record<string, unknown>>)[0];
  const sm = (rm.scopeMetrics as Array<Record<string, unknown>>)[0];
  const metric = (sm.metrics as Array<Record<string, unknown>>)[0];
  assert("gauge" in metric, "a gauge-kind metric must carry a gauge body");
  assert(!("sum" in metric), "a gauge-kind metric must NOT carry a sum body");
  const gauge = metric.gauge as Record<string, unknown>;
  assertEquals((gauge.dataPoints as unknown[]).length, 1);
});

Deno.test("serializeMetrics: a 'sum' kind metric still emits {sum:{dataPoints, aggregationTemporality, isMonotonic}}", () => {
  const out = serializeMetrics({
    serviceName: "swamp-go-brr",
    metrics: [{
      name: "gobrr.leaf.tokens",
      kind: "sum",
      points: [{ attributes: { gate: "real" }, value: 10 }],
    }],
  }) as Record<string, unknown>;
  const rm = (out.resourceMetrics as Array<Record<string, unknown>>)[0];
  const sm = (rm.scopeMetrics as Array<Record<string, unknown>>)[0];
  const metric = (sm.metrics as Array<Record<string, unknown>>)[0];
  assert("sum" in metric);
  assert(!("gauge" in metric));
  const sum = metric.sum as Record<string, unknown>;
  assertEquals(sum.isMonotonic, true);
});

Deno.test("serializeTrace: a NON-integer numeric attribute encodes as doubleValue, contrasted with an integer attribute's intValue", () => {
  const out = serializeTrace({
    traceId: "a".repeat(32),
    serviceName: "swamp-go-brr",
    spans: [{
      spanId: "1".repeat(16),
      name: "root",
      startUnixNano: "0",
      endUnixNano: "1",
      status: "ok",
      attributes: {
        "gobrr.cost_estimate": 0.42,
        "gobrr.invocations": 3,
      },
    }],
  }) as Record<string, unknown>;
  const rs = (out.resourceSpans as Array<Record<string, unknown>>)[0];
  const ss = (rs.scopeSpans as Array<Record<string, unknown>>)[0];
  const span = (ss.spans as Array<Record<string, unknown>>)[0];
  const attrs = span.attributes as Array<
    { key: string; value: Record<string, unknown> }
  >;
  const cost = attrs.find((a) => a.key === "gobrr.cost_estimate")!;
  const inv = attrs.find((a) => a.key === "gobrr.invocations")!;
  assertEquals(cost.value.doubleValue, 0.42);
  assert(
    !("intValue" in cost.value),
    "a fractional number must NOT be stringified as an OTLP int",
  );
  assertEquals(inv.value.intValue, "3");
  assert(
    !("doubleValue" in inv.value),
    "an integer must NOT be encoded as a double",
  );
});
