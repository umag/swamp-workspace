/**
 * Method-level tests for @magistr/victoriametrics — every one of the 5
 * methods (query, query-range, health, system-overview, container-memory),
 * happy path + error path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` and a fake context.
 *
 * As of 2026.08.02.1, victoriametrics.ts has been FIXED (all 11 latent bugs
 * tracked by victoriametrics-latent-bugs closed — see the adversarial suite
 * for the flipped pins). Every existing test in THIS file stays
 * BYTE-IDENTICAL — they only exercise benign, well-formed happy/error paths
 * the fixes don't touch. One NEW test is added for the VM5 fix (`query`'s
 * scalar-resultType happy path).
 *
 * TOOLCHAIN NOTE: the fetch stub is bound via a TYPED CONST
 * (`const stub: typeof globalThis.fetch = ...`) with NO
 * `as typeof globalThis.fetch` cast — wave-2b bans the porkbun/telegram-send
 * precedent. FakeTime drives every start/end/uptime/timestamp assertion and
 * coexists with the fetch stub in every test that needs both.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./victoriametrics.ts";
import systemOverviewFixture from "../../fixtures/system_overview.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FIXED_EPOCH_S = 1700000000;
const FIXED_NOW_MS = FIXED_EPOCH_S * 1000;

const GLOBAL_ARGS = { host: "vm.example", port: 8428 };

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx() {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs: GLOBAL_ARGS,
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

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request.
 * Bound via a typed const — no `as typeof globalThis.fetch` cast. */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub: typeof globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  globalThis.fetch = stub;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

/** A raw (non-JSON) text response — `vmQuery` reads a non-ok response body
 * via `resp.text()` verbatim, so an error-path fixture must NOT be run
 * through `json()` (which would JSON.stringify the string, wrapping it in
 * quotes and corrupting the exact error-message assertion). */
function text(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function withOneTextResponse(
  body: string,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => text(body, status)], fn);
}

/** Router over the six exact PromQL strings system-overview issues. A
 * mismatched key throws "unrouted" and fails every system-overview test —
 * that IS the tripwire (see fixtures/PROVENANCE.md). Accepts overrides so a
 * single metric's fixture can be swapped while the other five stay benign
 * (the round-1 residual LOW: the router must answer ALL SIX queries even
 * when the assertion targets just one). */
function systemOverviewRoute(overrides: Record<string, unknown> = {}): Route {
  const table: Record<string, unknown> = {
    ...(systemOverviewFixture as Record<string, unknown>),
    ...overrides,
  };
  return (req) => {
    const query = new URL(req.url).searchParams.get("query");
    if (query === null || !(query in table)) return undefined;
    return json(table[query]);
  };
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

Deno.test("query: happy path — GET /api/v1/query?query=<encoded>, writes queryResult", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const body = {
    status: "success",
    data: {
      resultType: "vector",
      result: [
        {
          metric: { job: "demo-node", instance: "fixture-host-1:9100" },
          value: [FIXED_EPOCH_S, "3.5"],
        },
      ],
    },
  };
  await withOneResponse(body, 200, async (calls) => {
    await run("query", { promql: "up" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/v1/query");
    assertEquals(url.searchParams.get("query"), "up");
    assertEquals(calls[0].method, "GET");
  });
  const res = written.find((w) => w.spec === "queryResult")!;
  assertEquals(res.payload.query, "up");
  assertEquals(res.payload.resultType, "vector");
  assertEquals(res.payload.results, [
    {
      metric: { job: "demo-node", instance: "fixture-host-1:9100" },
      value: 3.5,
    },
  ]);
  assertEquals(res.payload.timestamp, new Date(FIXED_NOW_MS).toISOString());
});

Deno.test("query: error path — non-ok HTTP throws 'VM query failed: <status> <text>'", async () => {
  const { ctx } = makeCtx();
  await withOneTextResponse("internal error", 500, async () => {
    await assertRejects(
      () => run("query", { promql: "up" }, ctx),
      Error,
      "VM query failed: 500 internal error",
    );
  });
});

Deno.test("query: scalar resultType happy path (VM5 fix) — maps to a single {metric:{}, value:<parsed number>} row", async () => {
  const { ctx, written } = makeCtx();
  const body = {
    status: "success",
    data: { resultType: "scalar", result: [1700000000, "7"] },
  };
  await withOneResponse(body, 200, async () => {
    await run("query", { promql: "scalar(7)" }, ctx);
  });
  const res = written.find((w) => w.spec === "queryResult")!;
  assertEquals(res.payload.resultType, "scalar");
  assertEquals(res.payload.results, [{ metric: {}, value: 7 }]);
});

// ---------------------------------------------------------------------------
// query-range
// ---------------------------------------------------------------------------

Deno.test("query-range: happy path — start/end/step derived from FakeTime+hoursBack, matrix mapped to values[]", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const body = {
    status: "success",
    data: {
      resultType: "matrix",
      result: [
        {
          metric: { job: "demo-node", instance: "fixture-host-1:9100" },
          values: [[1699956800, "1.1"], [1699957400, "1.2"]],
        },
      ],
    },
  };
  await withOneResponse(body, 200, async (calls) => {
    await run("query-range", { promql: "node_load1" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/v1/query_range");
    assertEquals(url.searchParams.get("query"), "node_load1");
    assertEquals(url.searchParams.get("start"), "1699956800");
    assertEquals(url.searchParams.get("end"), String(FIXED_EPOCH_S));
    assertEquals(url.searchParams.get("step"), "300");
  });
  const res = written.find((w) => w.spec === "queryResult")!;
  assertEquals(res.payload.resultType, "matrix");
  const results = res.payload.results as Array<
    { values: Array<{ timestamp: number; value: number }> }
  >;
  assertEquals(results[0].values, [
    { timestamp: 1699956800, value: 1.1 },
    { timestamp: 1699957400, value: 1.2 },
  ]);
});

Deno.test("query-range: hoursBack and stepSeconds override the defaults", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx } = makeCtx();
  const body = {
    status: "success",
    data: { resultType: "matrix", result: [] },
  };
  await withOneResponse(body, 200, async (calls) => {
    await run(
      "query-range",
      { promql: "node_load1", hoursBack: 1, stepSeconds: 60 },
      ctx,
    );
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("start"), String(FIXED_EPOCH_S - 3600));
    assertEquals(url.searchParams.get("step"), "60");
  });
});

Deno.test("query-range: error path — non-ok HTTP throws 'VM query failed'", async () => {
  const { ctx } = makeCtx();
  await withOneTextResponse("bad gateway", 502, async () => {
    await assertRejects(
      () => run("query-range", { promql: "up" }, ctx),
      Error,
      "VM query failed: 502 bad gateway",
    );
  });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

Deno.test("health: happy path — up vector maps 1/0 to up/down, name is 'job (instance)'", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const body = {
    status: "success",
    data: {
      resultType: "vector",
      result: [
        {
          metric: { job: "demo-node", instance: "fixture-host-1:9100" },
          value: [FIXED_EPOCH_S, "1"],
        },
        {
          metric: { job: "demo-node", instance: "fixture-host-2:9100" },
          value: [FIXED_EPOCH_S, "0"],
        },
      ],
    },
  };
  await withOneResponse(body, 200, async (calls) => {
    await run("health", {}, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("query"), "up");
  });
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.targets, [
    { name: "demo-node (fixture-host-1:9100)", status: "up" },
    { name: "demo-node (fixture-host-2:9100)", status: "down" },
  ]);
  assertEquals(res.payload.timestamp, new Date(FIXED_NOW_MS).toISOString());
});

Deno.test("health: error path — non-ok HTTP throws 'VM query failed'", async () => {
  const { ctx } = makeCtx();
  await withOneTextResponse("forbidden", 403, async () => {
    await assertRejects(
      () => run("health", {}, ctx),
      Error,
      "VM query failed: 403 forbidden",
    );
  });
});

// ---------------------------------------------------------------------------
// system-overview
// ---------------------------------------------------------------------------

Deno.test("system-overview: happy path — 6 parallel queries routed by exact PromQL, quiet fixture yields anomalies:[]", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub([systemOverviewRoute()], async (calls) => {
    await run("system-overview", {}, ctx);
    assertEquals(calls.length, 6, "all six queries must be issued");
    // Five range queries carry start/end/step; the boot query is instant.
    const rangeCalls = calls.filter((c) =>
      new URL(c.url).pathname === "/api/v1/query_range"
    );
    const instantCalls = calls.filter((c) =>
      new URL(c.url).pathname === "/api/v1/query"
    );
    assertEquals(rangeCalls.length, 5);
    assertEquals(instantCalls.length, 1);
    for (const c of rangeCalls) {
      const url = new URL(c.url);
      assertEquals(url.searchParams.get("start"), "1699956800");
      assertEquals(url.searchParams.get("end"), String(FIXED_EPOCH_S));
      assertEquals(url.searchParams.get("step"), "300");
    }
    assertEquals(
      new URL(instantCalls[0].url).searchParams.get("query"),
      "node_boot_time_seconds",
    );
  });
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.anomalies, []);
  assertEquals(res.payload.cpu, {
    current: 11.2,
    min: 10.5,
    max: 12.0,
    avg: (10.5 + 12.0 + 11.2) / 3,
  });
  assertEquals(res.payload.uptime, {
    bootTime: new Date(1699982000 * 1000).toISOString(),
    uptimeMinutes: 300,
  });
  assertEquals(res.payload.timestamp, new Date(FIXED_NOW_MS).toISOString());
});

Deno.test("system-overview: hoursBack overrides the default lookback window for all five range queries", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx } = makeCtx();
  await withFetchStub([systemOverviewRoute()], async (calls) => {
    // The fixture's own values don't matter for this shape assertion — the
    // stub answers every routed query with the quiet fixture regardless of
    // hoursBack (only the request params are under test here).
    await run("system-overview", { hoursBack: 1 }, ctx);
    const rangeCalls = calls.filter((c) =>
      new URL(c.url).pathname === "/api/v1/query_range"
    );
    for (const c of rangeCalls) {
      assertEquals(
        new URL(c.url).searchParams.get("start"),
        String(FIXED_EPOCH_S - 3600),
      );
    }
  });
});

Deno.test("system-overview: error path — any one of the six queries failing (non-ok HTTP) rejects the whole Promise.all", async () => {
  const { ctx } = makeCtx();
  const BOOT_QUERY = "node_boot_time_seconds";
  await withFetchStub(
    [
      // Intercept the boot query specifically and fail it; let the other
      // five fall through to the benign fixture router so this pins
      // "one hostile response among six fails the whole batch", not
      // "every query must fail".
      (req) => {
        const q = new URL(req.url).searchParams.get("query");
        return q === BOOT_QUERY ? text("boom", 500) : undefined;
      },
      systemOverviewRoute(),
    ],
    async () => {
      await assertRejects(
        () => run("system-overview", {}, ctx),
        Error,
        "VM query failed: 500 boom",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// container-memory
// ---------------------------------------------------------------------------

Deno.test("container-memory: happy path — matrix mapped to top-N ranking by maxMB, 50MB threshold applied", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const body = {
    status: "success",
    data: {
      resultType: "matrix",
      result: [
        {
          metric: { name: "web" },
          values: [
            [1699956800, "60000000"],
            [1699957100, "75000000"],
            [1699957400, "70000000"],
          ],
        },
        {
          metric: { name: "worker" },
          values: [[1699956800, "10000000"], [1699957400, "11000000"]],
        },
      ],
    },
  };
  await withOneResponse(body, 200, async (calls) => {
    await run("container-memory", {}, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/v1/query_range");
    assertEquals(
      url.searchParams.get("query"),
      "container_memory_usage_bytes",
    );
    assertEquals(url.searchParams.get("start"), "1699956800");
    assertEquals(url.searchParams.get("step"), "600");
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  const containers = res.payload.containers as Array<Record<string, unknown>>;
  assertEquals(containers.length, 1, "worker stays under the 50MB threshold");
  assertEquals(containers[0], {
    name: "web",
    maxMB: 72,
    startMB: 57,
    endMB: 67,
    growthPercent: 16.7,
  });
});

Deno.test("container-memory: topN limits the ranking to the top N by maxMB", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const body = {
    status: "success",
    data: {
      resultType: "matrix",
      result: [
        { metric: { name: "web" }, values: [[1699956800, "75000000"]] },
        { metric: { name: "cache" }, values: [[1699956800, "130000000"]] },
      ],
    },
  };
  await withOneResponse(body, 200, async () => {
    await run("container-memory", { topN: 1 }, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  const containers = res.payload.containers as Array<Record<string, unknown>>;
  assertEquals(containers.length, 1);
  assertEquals(containers[0].name, "cache");
});

Deno.test("container-memory: error path — non-ok HTTP throws 'VM query failed'", async () => {
  const { ctx } = makeCtx();
  await withOneTextResponse("gateway timeout", 504, async () => {
    await assertRejects(
      () => run("container-memory", {}, ctx),
      Error,
      "VM query failed: 504 gateway timeout",
    );
  });
});

// ---------------------------------------------------------------------------
// Pin: no method calls the logger today
// ---------------------------------------------------------------------------

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own scan)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, logs } = makeCtx();
  const body = {
    status: "success",
    data: { resultType: "vector", result: [] },
  };
  await withOneResponse(body, 200, async () => {
    await run("query", { promql: "up" }, ctx);
  });
  assertEquals(logs.length, 0);
});
