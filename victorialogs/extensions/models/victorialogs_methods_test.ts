/**
 * Method-level tests for @magistr/victorialogs — every one of the 5 methods
 * (query, stats, container-log-status, error-summary, compare-periods),
 * happy path + failure path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch`, a stubbed `Deno.Command` (container-log-status only),
 * and a fake context.
 *
 * victorialogs.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior, including behavior that is arguably buggy (see the adversarial
 * and coverage suites for the found-bug write-ups; this file pins the happy
 * and ordinary-failure paths).
 *
 * Fixture provenance: fixtures/*.json are pure doc-derived synthetic NDJSON
 * rows (see fixtures/PROVENANCE.md) — no live call was ever made against the
 * real vlogs-unraid instance.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./victorialogs.ts";
import queryFixture from "../../fixtures/query.json" with { type: "json" };
import statsFixture from "../../fixtures/stats.json" with { type: "json" };
import containerStatsFixture from "../../fixtures/container-stats.json" with {
  type: "json",
};
import errorLinesFixture from "../../fixtures/error-lines.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = { host: "vlogs.example.test", port: 9428 };

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: {
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warning: (...args: unknown[]) => {
          logs.push({ level: "warning", args });
        },
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

/** Build a VictoriaLogs NDJSON response body from an array of row objects —
 * built IN-TEST so no raw wire bytes are committed to disk. */
function ndjson(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request.
 * No `as typeof globalThis.fetch` cast — the stub is written to `globalThis`
 * through an `any`-cast assignment (the fresh wave-2b no-cast idiom), while
 * the restore assigns the ORIGINAL (already correctly typed) function back. */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = stub;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** A route that returns queued (text, status) responses in call order —
 * models `Promise.all` issuing two sequential fetches (compare-periods). */
function queueRoute(
  bodies: Array<{ text: string; status?: number }>,
): Route {
  const queue = [...bodies];
  return () => {
    const item = queue.shift() ?? { text: "", status: 200 };
    return new Response(item.text, { status: item.status ?? 200 });
  };
}

async function requestParams(req: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await req.text());
}

// ---------------------------------------------------------------------------
// Deno.Command stub (container-log-status only)
// ---------------------------------------------------------------------------

type CmdResp = { success: boolean; stdout: string; stderr: string };
type Invocation = { command: string; args: string[] };

function installCmdStub(queue: CmdResp[]) {
  const invocations: Invocation[] = [];
  const original = Deno.Command;
  const enc = new TextEncoder();
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts: { args: string[] }) {
      this.#cmd = cmd;
      this.#args = opts.args;
    }
    output() {
      invocations.push({ command: this.#cmd, args: this.#args });
      const r = queue.shift() ?? { success: true, stdout: "", stderr: "" };
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        signal: null,
        stdout: enc.encode(r.stdout),
        stderr: enc.encode(r.stderr),
      });
    }
  };
  return {
    invocations,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

/** A stub whose .output() call REJECTS — models an ssh binary that cannot
 * even be spawned (ENOENT). */
function installThrowingCmdStub(message: string) {
  const invocations: Invocation[] = [];
  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts: { args: string[] }) {
      this.#cmd = cmd;
      this.#args = opts.args;
    }
    output() {
      invocations.push({ command: this.#cmd, args: this.#args });
      return Promise.reject(new Error(message));
    }
  };
  return {
    invocations,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

const TS_SUFFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

/** Assert a written resource name is `<prefix>-<second-granularity timestamp
 * shape>` — never a frozen exact value, since `new Date()` varies per run. */
function assertTimestampedName(name: string, prefix: string) {
  assert(
    name.startsWith(`${prefix}-`),
    `expected "${name}" to start with "${prefix}-"`,
  );
  const suffix = name.slice(prefix.length + 1);
  assert(
    TS_SUFFIX_RE.test(suffix),
    `unexpected timestamp suffix "${suffix}" in "${name}"`,
  );
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

Deno.test("query: happy path — POSTs to /select/logsql/query, writes queryResult", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture) }])],
    async (calls) => {
      await run("query", {}, ctx);
      assertEquals(calls.length, 1);
      const url = new URL(calls[0].url);
      assertEquals(url.protocol, "http:");
      assertEquals(url.host, "vlogs.example.test:9428");
      assertEquals(url.pathname, "/select/logsql/query");
      assertEquals(calls[0].method, "POST");
      const params = await requestParams(calls[0]);
      assertEquals(params.get("query"), "*");
      assertEquals(params.get("start"), "-24h");
      assertEquals(params.get("limit"), "100");
      assert(!params.has("end"), "no end arg -> omitted from the body");
    },
  );
  const res = written.find((w) => w.spec === "queryResult")!;
  assertEquals(res.payload.query, "*");
  assertEquals(res.payload.totalEntries, queryFixture.length);
  assertTimestampedName(res.name, "query");
});

Deno.test("query: logsql/start/end/limit are SEPARATE form fields — the logsql string is never concatenated with them (P1)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture) }])],
    async (calls) => {
      await run("query", {
        logsql: 'container_name:"svc-alpha"',
        start: "-6h",
        end: "-1h",
        limit: 50,
      }, ctx);
      const params = await requestParams(calls[0]);
      assertEquals(params.get("query"), 'container_name:"svc-alpha"');
      assertEquals(params.get("start"), "-6h");
      assertEquals(params.get("end"), "-1h");
      assertEquals(params.get("limit"), "50");
    },
  );
});

Deno.test("query: error path — non-ok status throws 'VLogs query failed: <status> <body>'", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: "internal error", status: 500 }])],
    async () => {
      await assertRejects(
        () => run("query", {}, ctx),
        Error,
        "VLogs query failed: 500 internal error",
      );
    },
  );
});

Deno.test("query: no AbortSignal.timeout is attached to the request (P10 — a hung endpoint hangs forever)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture) }])],
    async (calls) => {
      await run("query", {}, ctx);
      assertEquals(
        calls[0].signal?.aborted,
        false,
        "a real timeout signal would eventually abort; none is wired at all",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

Deno.test("stats: happy path — defaults to '* | stats count() as total', writes stats resource", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(statsFixture) }])],
    async (calls) => {
      await run("stats", {}, ctx);
      const params = await requestParams(calls[0]);
      assertEquals(params.get("query"), "* | stats count() as total");
      assertEquals(params.get("start"), "-24h");
      assert(!params.has("end"));
    },
  );
  const res = written.find((w) => w.spec === "stats")!;
  assertEquals(res.payload.query, "* | stats count() as total");
  assertEquals(res.payload.stats, statsFixture);
  assertTimestampedName(res.name, "stats");
});

Deno.test("stats: custom logsql/start/end are sent as separate fields", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(statsFixture) }])],
    async (calls) => {
      await run("stats", {
        logsql: "* | stats by (level) count() as total",
        start: "-7d",
        end: "-1d",
      }, ctx);
      const params = await requestParams(calls[0]);
      assertEquals(
        params.get("query"),
        "* | stats by (level) count() as total",
      );
      assertEquals(params.get("start"), "-7d");
      assertEquals(params.get("end"), "-1d");
    },
  );
});

Deno.test("stats: error path — non-ok status throws 'VLogs stats failed: <status> <body>'", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: "bad gateway", status: 502 }])],
    async () => {
      await assertRejects(
        () => run("stats", {}, ctx),
        Error,
        "VLogs stats failed: 502 bad gateway",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// container-log-status
// ---------------------------------------------------------------------------

const SSH_FIXED_ARGS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "BatchMode=yes",
  "root@vlogs.example.test",
  "docker ps --format '{{.Names}}'",
];

Deno.test("container-log-status: happy path — running-but-not-logging is surfaced, running-and-logging is not", async () => {
  const cmdStub = installCmdStub([
    { success: true, stdout: "svc-alpha\nsvc-beta\nsvc-gamma", stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson(containerStatsFixture) }])],
      async () => {
        await run("container-log-status", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  assertEquals(cmdStub.invocations.length, 1);
  assertEquals(cmdStub.invocations[0].command, "ssh");
  assertEquals(cmdStub.invocations[0].args, SSH_FIXED_ARGS);
  const res = written.find((w) => w.spec === "containerStatus")!;
  assertEquals(res.payload.logging, [
    { name: "svc-alpha", count: 1024 },
    { name: "svc-beta", count: 56 },
  ]);
  assertEquals(
    res.payload.notLogging,
    ["svc-gamma"],
    "svc-gamma is running but absent from the logging stats — surfaced",
  );
  assertEquals(res.payload.period, "-1h");
});

Deno.test("container-log-status: no method arg reaches the ssh Deno.Command args (subprocess-arg negative)", async () => {
  const cmdStub = installCmdStub([
    { success: true, stdout: "svc-alpha", stderr: "" },
  ]);
  const { ctx } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson(containerStatsFixture) }])],
      async () => {
        await run(
          "container-log-status",
          { start: "-distinctive-marker-6h", end: "-distinctive-marker-1h" },
          ctx,
        );
      },
    );
  } finally {
    cmdStub.restore();
  }
  assertEquals(
    cmdStub.invocations[0].args,
    SSH_FIXED_ARGS,
    "ssh args are a FIXED array regardless of the method's start/end args",
  );
  for (const a of cmdStub.invocations[0].args) {
    assert(
      !a.includes("distinctive-marker"),
      `ssh arg "${a}" must never carry a method-supplied start/end value`,
    );
  }
});

Deno.test("pin: P4 — ssh failure (success:false) is swallowed as running=[] -> notLogging=[] -> FALSE all-clear", async () => {
  // getRunningContainers never checks output.success; it blindly decodes
  // stdout. An ssh failure typically yields empty stdout (the error went to
  // stderr), so `running` becomes [] and notLogging becomes [] — a FALSE
  // ALL-CLEAR that looks identical to "every running container is logging",
  // even though the check never actually ran. Documented gap (found bug,
  // HIGH per the alert-baseline lesson), NOT fixed here.
  const cmdStub = installCmdStub([
    {
      success: false,
      stdout: "",
      stderr:
        "ssh: connect to host vlogs.example.test port 22: Connection refused",
    },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson(containerStatsFixture) }])],
      async () => {
        await run("container-log-status", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  const res = written.find((w) => w.spec === "containerStatus")!;
  assertEquals(
    res.payload.notLogging,
    [],
    "an ssh failure produces the SAME notLogging:[] shape as a healthy fleet",
  );
});

Deno.test("pin: an ssh spawn failure (ENOENT-style, .output() rejects) propagates as a method rejection — unlike the success:false swallow above", async () => {
  const cmdStub = installThrowingCmdStub(
    "No such file or directory (os error 2)",
  );
  const { ctx } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson(containerStatsFixture) }])],
      async () => {
        await assertRejects(
          () => run("container-log-status", {}, ctx),
          Error,
          "No such file or directory",
        );
      },
    );
  } finally {
    cmdStub.restore();
  }
});

Deno.test("pin: empty logging stats + non-empty running -> notLogging == running (full-fleet false-alarm storm, the P6 sibling)", async () => {
  const cmdStub = installCmdStub([
    { success: true, stdout: "svc-alpha\nsvc-beta\nsvc-gamma", stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: "" }])], // empty NDJSON body -> [] stats rows
      async () => {
        await run("container-log-status", {}, ctx);
      },
    );
  } finally {
    cmdStub.restore();
  }
  const res = written.find((w) => w.spec === "containerStatus")!;
  assertEquals(
    res.payload.notLogging,
    ["svc-alpha", "svc-beta", "svc-gamma"],
    "an empty vlogs pipeline (silent SOURCE) flags every running container — the storm sibling of P6's empty comparison WINDOW",
  );
  assertEquals(res.payload.logging, []);
});

// ---------------------------------------------------------------------------
// error-summary
// ---------------------------------------------------------------------------

Deno.test("error-summary: groups by container, caps samples at 5, buckets unlabeled entries as 'unknown', sorts desc by count", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(errorLinesFixture) }])],
    async (calls) => {
      await run("error-summary", {}, ctx);
      const params = await requestParams(calls[0]);
      assert(params.get("query")?.includes("_msg:error"));
      assertEquals(params.get("limit"), "500");
    },
  );
  const res = written.find((w) => w.spec === "errorSummary")!;
  assertEquals(res.payload.totalErrors, errorLinesFixture.length);
  const byContainer = res.payload.byContainer as Array<
    { name: string; count: number; samples: string[] }
  >;
  const alpha = byContainer.find((c) => c.name === "svc-alpha")!;
  assertEquals(alpha.count, 6, "6 svc-alpha error lines in the fixture");
  assertEquals(
    alpha.samples.length,
    5,
    "samples are capped at 5 (count stays 6)",
  );
  const beta = byContainer.find((c) => c.name === "svc-beta")!;
  assertEquals(beta.count, 1);
  const unknown = byContainer.find((c) => c.name === "unknown")!;
  assertEquals(
    unknown.count,
    1,
    "the unlabeled fixture row buckets as 'unknown'",
  );
  // sorted desc by count
  for (let i = 1; i < byContainer.length; i++) {
    assert(byContainer[i - 1].count >= byContainer[i].count);
  }
});

Deno.test("error-summary: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: "gateway timeout", status: 504 }])],
    async () => {
      await assertRejects(
        () => run("error-summary", {}, ctx),
        Error,
        "VLogs query failed: 504 gateway timeout",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// compare-periods
// ---------------------------------------------------------------------------

Deno.test("compare-periods: happy path — baseline THEN comparison fetched, classified and sorted", async () => {
  const baseline = [
    { container_name: "svc-alpha", total: "1000" },
    { container_name: "svc-beta", total: "50" },
  ];
  const compare = [
    { container_name: "svc-alpha", total: "1100" }, // NORMAL (within 0.1x-2x)
    // svc-beta absent from compare -> GONE
    { container_name: "svc-gamma", total: "30" }, // NEW (absent from baseline)
  ];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson(compare) }])],
    async (calls) => {
      await run("compare-periods", {}, ctx);
      assertEquals(calls.length, 2, "baseline and comparison are both fetched");
      const baselineParams = await requestParams(calls[0]);
      assertEquals(baselineParams.get("start"), "2026-01-07T00:00:00Z");
      assertEquals(baselineParams.get("end"), "2026-01-21T00:00:00Z");
      const compareParams = await requestParams(calls[1]);
      assertEquals(compareParams.get("start"), "-2h");
      assert(!compareParams.has("end"), "no compare_end -> omitted");
    },
  );
  const res = written.find((w) => w.spec === "stats")!;
  assertEquals(res.payload.query, "compare-periods");
  const rows = res.payload.stats as Array<
    { name: string; baseline: number; current: number; status: string }
  >;
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assertEquals(byName["svc-alpha"].status, "NORMAL");
  assertEquals(byName["svc-beta"].status, "GONE");
  assertEquals(byName["svc-gamma"].status, "NEW");
  // pin: P13 — the sort comparator is `(order[a.status] || 9) - (order[b.status] || 9)`.
  // GONE maps to 0, which is FALSY, so `0 || 9` collapses to 9 — the same
  // class of bug as compare-periods' own NaN-total `|| 0` collapse (P6), but
  // here it hits the SORT PRIORITY itself. The intended order comment says
  // "GONE, MOSTLY_SILENT, NEW, MUCH_MORE_ACTIVE, NORMAL" but GONE actually
  // sorts LAST (tied with any truly-unmapped status), not first — the most
  // urgent alert (a service went silent) is buried at the bottom of the
  // list. Found bug, NOT in the original plan's P1-P12 list — pinned here,
  // not fixed (victorialogs.ts stays byte-frozen).
  assertEquals(rows.map((r) => r.status), ["NEW", "NORMAL", "GONE"]);
  assertTimestampedName(res.name, "compare");
});

Deno.test("compare-periods: default baseline window is the frozen calendar range 2026-01-07..2026-01-21", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: "" }, { text: "" }])],
    async (calls) => {
      await run("compare-periods", {}, ctx);
      const baselineParams = await requestParams(calls[0]);
      assertEquals(baselineParams.get("start"), "2026-01-07T00:00:00Z");
      assertEquals(baselineParams.get("end"), "2026-01-21T00:00:00Z");
      const compareParams = await requestParams(calls[1]);
      assertEquals(compareParams.get("start"), "-2h");
    },
  );
});

Deno.test("pin: compare-periods Promise.all is all-or-nothing — a non-ok BASELINE fetch rejects the whole method", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: "server error", status: 500 }, { text: ndjson([]) }])],
    async () => {
      await assertRejects(
        () => run("compare-periods", {}, ctx),
        Error,
        "VLogs stats failed: 500 server error",
      );
    },
  );
});

Deno.test("pin: compare-periods Promise.all is all-or-nothing — a non-ok COMPARISON fetch rejects the whole method", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson([]) }, { text: "server error", status: 500 }])],
    async () => {
      await assertRejects(
        () => run("compare-periods", {}, ctx),
        Error,
        "VLogs stats failed: 500 server error",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Logger — pin the absence of any logging today
// ---------------------------------------------------------------------------

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own content-leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture) }])],
    async () => {
      await run("query", {}, ctx);
    },
  );
  assertEquals(logs.length, 0);
});
