/**
 * Adversarial suite: PromQL injection through user args, hostile/partial
 * matrix responses, single-series collapse, anomaly-threshold edges, top-N
 * ties/empty/negative edges, hostile transport, and a fixtures-secret/
 * real-infra scan over victoriametrics/fixtures/*.json.
 *
 * victoriametrics.ts is FIXED as of 2026.08.02.1 — all 11 latent bugs tracked
 * by the local `victoriametrics-latent-bugs` issue are closed (VM2 HIGH
 * multi-series aggregation via `extractValues.flatMap`, a shared `vmData`
 * response guard for the three direct single-query methods, series-level
 * `?? []` guards, `query`'s scalar-resultType dispatch, absence/boot-
 * unavailable anomaly flags, and a negative-`topN` clamp). Every test below
 * that used to be labeled "pin" for one of the 11 bugs now asserts the FIXED
 * behavior instead (see each test's own comment for the before/after) — they
 * are regression tests for the fix, not pins anymore. Tests still labeled
 * "pin" document genuinely INTENTIONAL, still-latent quirks that were never
 * in scope for this fix (tie-order stability, `topN:0` clamping to `[]`,
 * matrix-fed-into-`query` still mapping to `value:null`, absent-target
 * omission from `health` without `expectedTargets`, etc.) — those remain
 * characterization tests, not bugs.
 *
 * TOOLCHAIN NOTE: the fetch stub is bound via a TYPED CONST with NO
 * `as typeof globalThis.fetch` cast. FakeTime drives every timestamp
 * assertion and coexists with the fetch stub throughout.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import {
  DISK_IO_QUERY,
  isPhysicalDiskDevice,
  model,
} from "./victoriametrics.ts";
import queryVector from "../../fixtures/query_vector.json" with {
  type: "json",
};
import queryScalar from "../../fixtures/query_scalar.json" with {
  type: "json",
};
import queryRangeMatrix from "../../fixtures/query_range_matrix.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };
import healthUp from "../../fixtures/health_up.json" with { type: "json" };
import systemOverviewFixture from "../../fixtures/system_overview.json" with {
  type: "json",
};
import containerMemory from "../../fixtures/container_memory.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FIXED_EPOCH_S = 1700000000;
const FIXED_NOW_MS = FIXED_EPOCH_S * 1000;

const GLOBAL_ARGS = { host: "vm.example", port: 8428 };

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
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
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

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

const CPU_QUERY = '100-avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100';
const MEM_QUERY =
  "(1-node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)*100";
const LOAD_QUERY = "node_load1";
const DISK_QUERY = DISK_IO_QUERY;
const BOOT_QUERY = "node_boot_time_seconds";

/** Router over the six exact PromQL strings system-overview issues, with
 * per-query overrides so a single metric can be replaced with a hostile
 * fixture while the other five stay on the benign quiet baseline (round-1
 * residual LOW: the router must answer ALL SIX or the stub throws
 * "unrouted"). */
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

function matrixBody(
  result: Array<{ metric?: Record<string, string>; values?: unknown }>,
) {
  return { status: "success", data: { resultType: "matrix", result } };
}
function vectorBody(
  result: Array<{ metric?: Record<string, string>; value?: unknown }>,
) {
  return { status: "success", data: { resultType: "vector", result } };
}

// ---------------------------------------------------------------------------
// PromQL injection — query & query-range
// ---------------------------------------------------------------------------

const HOSTILE_PROMQL = [
  "up} or on() vector(1)",
  "up&admin=1&x=2",
  "up#frag",
  "../etc",
  "cpu usage 100% full",
  "multi\nline\nquery",
  // A literal '+' is the exact double-decode failure mode from the round-1
  // HIGH: encodeURIComponent escapes it to %2B, and searchParams.get decodes
  // %2B back to '+' — but a second, unwarranted decodeURIComponent pass
  // would treat a literal '+' as a form-encoded space and corrupt it.
  'node_cpu_seconds_total{a="1"}+node_cpu_seconds_total{a="2"}',
];

Deno.test("injection: query — searchParams.get('query') round-trips EXACTLY for every hostile PromQL string (no double-decode)", async () => {
  const { ctx } = makeCtx();
  for (const promql of HOSTILE_PROMQL) {
    await withOneResponse(
      { status: "success", data: { resultType: "vector", result: [] } },
      200,
      async (calls) => {
        await run("query", { promql }, ctx);
        const url = new URL(calls[0].url);
        assertEquals(url.pathname, "/api/v1/query");
        assertEquals(url.searchParams.get("query"), promql);
        assertEquals(Array.from(url.searchParams.keys()).sort(), ["query"]);
      },
    );
  }
});

Deno.test("injection: query-range — searchParams.get('query') round-trips EXACTLY; only query/start/end/step present", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx } = makeCtx();
  for (const promql of HOSTILE_PROMQL) {
    await withOneResponse(
      { status: "success", data: { resultType: "matrix", result: [] } },
      200,
      async (calls) => {
        await run("query-range", { promql }, ctx);
        const url = new URL(calls[0].url);
        assertEquals(url.pathname, "/api/v1/query_range");
        assertEquals(url.searchParams.get("query"), promql);
        assertEquals(
          Array.from(url.searchParams.keys()).sort(),
          ["end", "query", "start", "step"],
        );
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Result-type matrix — pins, not fixes
// ---------------------------------------------------------------------------

Deno.test("fix (VM5): query on a SCALAR result now dispatches on resultType -> [{metric:{}, value:<parsed number>}], not the old garbage [{metric:undefined,value:null},{metric:undefined,value:null}]", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(queryScalar, 200, async () => {
    await run("query", { promql: "scalar(7)" }, ctx);
  });
  const res = written.find((w) => w.spec === "queryResult")!;
  const results = res.payload.results as Array<
    { metric: unknown; value: unknown }
  >;
  assertEquals(results.length, 1, "a scalar result now yields exactly ONE row");
  assertEquals(results[0].metric, {});
  assertEquals(results[0].value, 7);
});

Deno.test("pin: query fed a MATRIX-shaped body maps every series to value:null (no singular .value field on a matrix element)", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(queryRangeMatrix, 200, async () => {
    await run("query", { promql: "node_load1" }, ctx);
  });
  const res = written.find((w) => w.spec === "queryResult")!;
  const results = res.payload.results as Array<
    { metric: Record<string, string>; value: unknown }
  >;
  assertEquals(results.length, 1);
  assertEquals(
    results[0].metric,
    { job: "demo-node", instance: "fixture-host-1:9100" },
  );
  assertEquals(results[0].value, null);
});

Deno.test("fix (VM6): query fed a 200 {status:'error'} body with NO `data` field now throws a MAPPED Error via vmData(), not an uncaught TypeError", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(errorFixture, 200, async () => {
    await assertRejects(
      () => run("query", { promql: "up" }, ctx),
      Error,
      "VM query error: invalid parameter",
    );
  });
});

Deno.test("fix (VM7): query-range fed a VECTOR-shaped body no longer throws — (r.values ?? []) degrades each series to values:[] instead of crashing on .values.map", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withOneResponse(queryVector, 200, async () => {
    await run("query-range", { promql: "up" }, ctx);
  });
  const res = written.find((w) => w.spec === "queryResult")!;
  assertEquals(res.payload.results, [
    {
      metric: { job: "demo-node", instance: "fixture-host-1:9100" },
      values: [],
    },
  ]);
});

Deno.test("fix (VM2): system-overview — a range query answering with a SCALAR body no longer crashes extractValues; flatMap over the [ts,valString] tuple finds no `.values` on either element and degrades to cpu {0,0,0,0}", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: queryScalar })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.cpu, { current: 0, min: 0, max: 0, avg: 0 });
});

// ---------------------------------------------------------------------------
// MULTI-SERIES AGGREGATION (VM2, HIGH — FIXED) — was single-series collapse
// ---------------------------------------------------------------------------

Deno.test("fix (VM2): system-overview's memory stats now AGGREGATE across ALL series of a multi-series range result — series[1]'s spike is no longer silently dropped", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const multiSeriesMem = matrixBody([
    {
      metric: { instance: "fixture-host-1:9100" },
      values: [
        [1699956800, "40.0"],
        [1699957100, "42.0"],
        [1699957400, "41.0"],
      ],
    },
    {
      // A second series with WILDLY different values. extractValues now
      // flatMaps result.data.result, so memStats reflects BOTH series.
      metric: { instance: "fixture-host-2:9100" },
      values: [
        [1699956800, "95.0"],
        [1699957100, "97.0"],
        [1699957400, "96.0"],
      ],
    },
  ]);
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: multiSeriesMem })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.memory, {
    usedPercent: 96.0,
    min: 40.0,
    max: 97.0,
    avg: 68.5,
  });
  assert(
    (res.payload.anomalies as string[]).includes("Memory peaked at 97.0%"),
    "series[1]'s 97% peak must now be visible to the anomaly checks",
  );
});

Deno.test("fix (VM2): system-overview's load stats aggregate a 2-series result — series[1]'s spike sets load.max, series[0] still contributes load.min, and the spike anomaly fires", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const multiSeriesLoad = matrixBody([
    {
      metric: { instance: "fixture-host-1:9100" },
      values: [[1699956800, "5"], [1699957100, "6"]],
    },
    {
      // series[1] carries the spike — a single point at the SAME first
      // timestamp as series[0], so the flatten's inter-series boundary
      // (series[0]'s last ts 1699957100 -> series[1]'s ts 1699956800) is a
      // BACKWARD jump, never a >600s forward gap.
      metric: { instance: "fixture-host-2:9100" },
      values: [[1699956800, "40"]],
    },
  ]);
  await withFetchStub(
    [systemOverviewRoute({ [LOAD_QUERY]: multiSeriesLoad })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  const load = res.payload.load as { min: number; max: number };
  assertEquals(load.max, 40, "series[1]'s spike sets load.max");
  assertEquals(load.min, 5, "series[0] still contributes load.min");
  assert(
    (res.payload.anomalies as string[]).includes("Load spike to 40.0"),
    "the aggregated max must cross the >30 spike threshold",
  );
});

Deno.test("fix (VM2): a multi-series CPU result whose inter-series boundary is a BACKWARD timestamp jump never spuriously fires the >600s 'Metric gap' reboot detector", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const multiSeriesCpu = matrixBody([
    {
      metric: { instance: "fixture-host-1:9100" },
      values: [[1699956800, "10"], [1699957400, "12"]],
    },
    {
      // Concatenated onto series[0] via flatMap, this jumps BACKWARD from
      // ts 1699957400 to ts 1699956800 (a -600s "gap") — the reboot
      // detector only fires on a FORWARD gap >600s, so this must stay
      // silent even though the raw timestamp delta's magnitude is large.
      metric: { instance: "fixture-host-2:9100" },
      values: [[1699956800, "11"], [1699957400, "13"]],
    },
  ]);
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: multiSeriesCpu })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.cpu, { current: 13, min: 10, max: 13, avg: 11.5 });
  assertEquals(
    (res.payload.anomalies as string[]).filter((a) => a.includes("Metric gap")),
    [],
    "a backward inter-series boundary must never be reported as a reboot gap",
  );
});

// ---------------------------------------------------------------------------
// system-overview anomaly thresholds — strict `>` edges
// ---------------------------------------------------------------------------

function singlePointRange(value: string) {
  return matrixBody([{ metric: {}, values: [[FIXED_EPOCH_S, value]] }]);
}

Deno.test("pin: cpu.max exactly 90 does NOT fire; 90.1 DOES fire (strict >90)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx: ctxAt, written: wAt } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: singlePointRange("90") })],
    async () => {
      await run("system-overview", {}, ctxAt);
    },
  );
  assertEquals(
    (wAt.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .filter((a) => a.includes("CPU spike")),
    [],
  );

  const { ctx: ctxOver, written: wOver } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: singlePointRange("90.1") })],
    async () => {
      await run("system-overview", {}, ctxOver);
    },
  );
  assertEquals(
    wOver.find((w) => w.spec === "overview")!.payload.anomalies,
    ["CPU spike to 90.1%"],
  );
});

Deno.test("pin: mem.max exactly 90 does NOT fire; 90.1 DOES fire (strict >90)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx: ctxAt, written: wAt } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: singlePointRange("90") })],
    async () => {
      await run("system-overview", {}, ctxAt);
    },
  );
  assertEquals(
    (wAt.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .filter((a) => a.includes("Memory peaked")),
    [],
  );

  const { ctx: ctxOver, written: wOver } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: singlePointRange("90.1") })],
    async () => {
      await run("system-overview", {}, ctxOver);
    },
  );
  assert(
    (wOver.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .includes("Memory peaked at 90.1%"),
  );
});

Deno.test("pin: mem.min exactly 80 does NOT fire 'consistently high'; 80.1 DOES fire (strict >80)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx: ctxAt, written: wAt } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: singlePointRange("80") })],
    async () => {
      await run("system-overview", {}, ctxAt);
    },
  );
  assertEquals(
    (wAt.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .filter((a) => a.includes("consistently high")),
    [],
  );

  const { ctx: ctxOver, written: wOver } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: singlePointRange("80.1") })],
    async () => {
      await run("system-overview", {}, ctxOver);
    },
  );
  assert(
    (wOver.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .some((a) => a.includes("consistently high")),
  );
});

Deno.test("pin: load.max exactly 30 does NOT fire; 30.1 DOES fire (strict >30)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx: ctxAt, written: wAt } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [LOAD_QUERY]: singlePointRange("30") })],
    async () => {
      await run("system-overview", {}, ctxAt);
    },
  );
  assertEquals(
    (wAt.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .filter((a) => a.includes("Load spike")),
    [],
  );

  const { ctx: ctxOver, written: wOver } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [LOAD_QUERY]: singlePointRange("30.1") })],
    async () => {
      await run("system-overview", {}, ctxOver);
    },
  );
  assert(
    (wOver.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .includes("Load spike to 30.1"),
  );
});

Deno.test("pin: disk maxIoPercent exactly 90 does NOT fire 'saturated'; 90.1 DOES fire (strict >90)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const diskAt90 = matrixBody([
    { metric: { device: "vda" }, values: [[FIXED_EPOCH_S, "90"]] },
  ]);
  const { ctx: ctxAt, written: wAt } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [DISK_QUERY]: diskAt90 })],
    async () => {
      await run("system-overview", {}, ctxAt);
    },
  );
  assertEquals(
    (wAt.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .filter((a) => a.includes("saturated")),
    [],
  );

  const diskOver90 = matrixBody([
    { metric: { device: "vda" }, values: [[FIXED_EPOCH_S, "90.1"]] },
  ]);
  const { ctx: ctxOver, written: wOver } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [DISK_QUERY]: diskOver90 })],
    async () => {
      await run("system-overview", {}, ctxOver);
    },
  );
  assert(
    (wOver.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .includes("Disk vda saturated at 90.1%"),
  );
});

Deno.test("pin: a 600s gap in cpu samples does NOT fire the reboot detector; 601s DOES (strict >600)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const cpuGap600 = matrixBody([{
    metric: {},
    values: [[1699956800, "10"], [1699957400, "10"]],
  }]);
  const { ctx: ctxAt, written: wAt } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: cpuGap600 })],
    async () => {
      await run("system-overview", {}, ctxAt);
    },
  );
  assertEquals(
    (wAt.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .filter((a) => a.includes("Metric gap")),
    [],
  );

  const cpuGap601 = matrixBody([{
    metric: {},
    values: [[1699956800, "10"], [1699957401, "10"]],
  }]);
  const { ctx: ctxOver, written: wOver } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: cpuGap601 })],
    async () => {
      await run("system-overview", {}, ctxOver);
    },
  );
  assert(
    (wOver.find((w) => w.spec === "overview")!.payload.anomalies as string[])
      .some((a) => a.includes("Metric gap") && a.includes("possible reboot")),
  );
});

// ---------------------------------------------------------------------------
// ABSENT metric — missing-metric silent {0,0,0}, not flagged
// ---------------------------------------------------------------------------

Deno.test("fix (VM3): an EMPTY cpu result (no series at all) still reports {current:0,min:0,max:0,avg:0} but is now FLAGGED as absent, no longer indistinguishable from a genuinely idle 0% CPU", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: matrixBody([]) })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.cpu, { current: 0, min: 0, max: 0, avg: 0 });
  assertEquals(
    (res.payload.anomalies as string[]).filter((a) => a.includes("CPU")),
    ["CPU metric absent (no series returned)"],
  );
});

Deno.test("fix (VM3): an EMPTY memory result is flagged 'Memory metric absent (no series returned)'", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: matrixBody([]) })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.memory, { usedPercent: 0, min: 0, max: 0, avg: 0 });
  assertEquals(
    (res.payload.anomalies as string[]).filter((a) => a.includes("Memory")),
    ["Memory metric absent (no series returned)"],
  );
});

Deno.test("fix (VM3): an EMPTY load result is flagged 'Load metric absent (no series returned)'", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [LOAD_QUERY]: matrixBody([]) })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.load, { load1: 0, min: 0, max: 0, avg: 0 });
  assertEquals(
    (res.payload.anomalies as string[]).filter((a) => a.includes("Load")),
    ["Load metric absent (no series returned)"],
  );
});

// ---------------------------------------------------------------------------
// Disk edge cases — empty values:[] vs MISSING values key entirely
// ---------------------------------------------------------------------------

Deno.test("pin: a disk series with values:[] (present, empty) computes NaN/-Infinity and is silently filtered out by the >10 check — no crash", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const diskEmptyValues = matrixBody([
    { metric: { device: "vda" }, values: [] },
  ]);
  await withFetchStub(
    [systemOverviewRoute({ [DISK_QUERY]: diskEmptyValues })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(
    res.payload.disk,
    [],
    "Math.max()=-Infinity and NaN both fail the `>10` filter, so the device is dropped, not crashed",
  );
});

Deno.test("fix (VM8/VM9): a disk series MISSING the `values` key entirely no longer throws — the pre-filter (Array.isArray(r.values) && r.values.length>0) drops it, disk stays []", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const diskNoValuesKey = matrixBody([{ metric: { device: "vda" } }]);
  await withFetchStub(
    [systemOverviewRoute({ [DISK_QUERY]: diskNoValuesKey })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.disk, []);
});

// ---------------------------------------------------------------------------
// Empty boot-time result — 1970 epoch + huge uptime
// ---------------------------------------------------------------------------

Deno.test("fix (VM4): an empty boot-time result no longer falls back to bootTs=0/the 1970 epoch — bootTime is 'unknown', uptimeMinutes is 0, and 'Boot time unavailable' is flagged", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [BOOT_QUERY]: vectorBody([]) })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.uptime, {
    bootTime: "unknown",
    uptimeMinutes: 0,
  });
  assert(
    (res.payload.anomalies as string[]).includes("Boot time unavailable"),
  );
});

// ---------------------------------------------------------------------------
// Memory growth trend — >10 samples fires, <=10 samples silent
// ---------------------------------------------------------------------------

function memPoints(n: number): Array<[number, string]> {
  // Linearly increasing series 30, 36, 42, ... (+6 per step). Kept <=90 so
  // the max>90 "peaked" anomaly never co-fires with the growth check.
  return Array.from(
    { length: n },
    (_, i) => [1699956800 + i * 300, String(30 + 6 * i)] as [number, string],
  );
}

Deno.test("pin: memory growth >10 samples with a >5-point rise over the window fires 'Memory growing'", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const mem11 = matrixBody([{ metric: {}, values: memPoints(11) }]);
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: mem11 })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assert(
    (res.payload.anomalies as string[]).includes(
      "Memory growing: 57.0% -> 63.0% over window",
    ),
  );
});

Deno.test("pin: the SAME growth shape at exactly 10 samples (not >10) never evaluates the growth check — silent", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const mem10 = matrixBody([{ metric: {}, values: memPoints(10) }]);
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: mem10 })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(
    (res.payload.anomalies as string[]).filter((a) =>
      a.includes("Memory growing")
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// health: up==0 vs ABSENT series, and missing labels
// ---------------------------------------------------------------------------

Deno.test("pin: a target present in `up` with value 0 is reported 'down'; a target with NO series at all is OMITTED, not synthesized as down", async () => {
  const { ctx, written } = makeCtx();
  // Only ONE target ever reports a series (host-1, up=1). A hypothetical
  // host-2 that never successfully scraped (up metric absent) simply never
  // appears — health has no notion of "all known targets" to diff against.
  const body = vectorBody([
    {
      metric: { job: "demo-node", instance: "fixture-host-1:9100" },
      value: [FIXED_EPOCH_S, "1"],
    },
  ]);
  await withOneResponse(body, 200, async () => {
    await run("health", {}, ctx);
  });
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.targets, [
    { name: "demo-node (fixture-host-1:9100)", status: "up" },
  ]);
  assertEquals(
    (res.payload.targets as unknown[]).length,
    1,
    "an absent target contributes NOTHING to targets[] — it is not reported down (unchanged: this is opt-in via expectedTargets, see the VM1 fix test below)",
  );
});

Deno.test("fix (VM1): passing expectedTargets now surfaces an absent target explicitly as status:'unknown' instead of silent omission", async () => {
  const { ctx, written } = makeCtx();
  const body = vectorBody([
    {
      metric: { job: "demo-node", instance: "fixture-host-1:9100" },
      value: [FIXED_EPOCH_S, "1"],
    },
  ]);
  await withOneResponse(body, 200, async () => {
    await run(
      "health",
      { expectedTargets: ["demo-node (fixture-host-2:9100)"] },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.targets, [
    { name: "demo-node (fixture-host-1:9100)", status: "up" },
    { name: "demo-node (fixture-host-2:9100)", status: "unknown" },
  ]);
});

Deno.test("pin: a series missing job/instance labels renders name 'undefined (undefined)'", async () => {
  const { ctx, written } = makeCtx();
  const body = vectorBody([{ metric: {}, value: [FIXED_EPOCH_S, "1"] }]);
  await withOneResponse(body, 200, async () => {
    await run("health", {}, ctx);
  });
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.targets, [
    { name: "undefined (undefined)", status: "up" },
  ]);
});

Deno.test("fix (VM8): a series MISSING the `value` field entirely no longer throws — it now degrades to status:'unknown' instead of crashing (r.value ? ... : \"unknown\")", async () => {
  const { ctx, written } = makeCtx();
  const body = vectorBody([{ metric: { job: "demo-node", instance: "x" } }]);
  await withOneResponse(body, 200, async () => {
    await run("health", {}, ctx);
  });
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.targets, [
    { name: "demo-node (x)", status: "unknown" },
  ]);
});

// ---------------------------------------------------------------------------
// container-memory: ties, empty, fewer-than-N, topN=0, NEGATIVE topN,
// all-filtered series, missing `values` key
// ---------------------------------------------------------------------------

Deno.test("pin: ties in maxMB preserve INPUT ORDER (stable sort — Array.sort is stable since ES2019)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const tied = matrixBody([
    { metric: { name: "web" }, values: [[FIXED_EPOCH_S, "60000000"]] },
    { metric: { name: "cache" }, values: [[FIXED_EPOCH_S, "60000000"]] },
  ]);
  await withOneResponse(tied, 200, async () => {
    await run("container-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  const containers = res.payload.containers as Array<{ name: string }>;
  assertEquals(
    containers.map((c) => c.name),
    ["web", "cache"],
    "equal maxMB must not reorder — input order is preserved",
  );
});

Deno.test("pin: nothing over the 50MB threshold -> containers is []", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const allBelow = matrixBody([
    { metric: { name: "tiny" }, values: [[FIXED_EPOCH_S, "1000000"]] },
  ]);
  await withOneResponse(allBelow, 200, async () => {
    await run("container-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  assertEquals(res.payload.containers, []);
});

Deno.test("pin: topN=0 -> containers is [] (slice(0,0))", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withOneResponse(containerMemory, 200, async () => {
    await run("container-memory", { topN: 0 }, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  assertEquals(res.payload.containers, []);
});

Deno.test("fix (VM10): NEGATIVE topN is now clamped via Math.max(0,args.topN) -> containers is [], no longer slice(0,-n) dropping from the END of the desc-sorted array", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const three = matrixBody([
    { metric: { name: "big" }, values: [[FIXED_EPOCH_S, "94371840"]] }, // 90MB
    { metric: { name: "mid" }, values: [[FIXED_EPOCH_S, "73400320"]] }, // 70MB
    { metric: { name: "small" }, values: [[FIXED_EPOCH_S, "62914560"]] }, // 60MB
  ]);
  await withOneResponse(three, 200, async () => {
    await run("container-memory", { topN: -1 }, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  assertEquals(
    res.payload.containers,
    [],
    "Math.max(0,-1)===0 -> slice(0,0) -> [], regardless of how many qualify",
  );
});

Deno.test("pin: a series whose values are ALL <=0 (filtered by v>0) is skipped entirely", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const allNonPositive = matrixBody([
    {
      metric: { name: "idle" },
      values: [[FIXED_EPOCH_S, "-5"], [FIXED_EPOCH_S + 300, "0"]],
    },
  ]);
  await withOneResponse(allNonPositive, 200, async () => {
    await run("container-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  assertEquals(res.payload.containers, []);
});

Deno.test("fix (VM8): a container series MISSING the `values` key entirely no longer throws — (r.values ?? []) yields an empty vals array, the !vals.length guard skips it, containers stays []", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const noValuesKey = matrixBody([{ metric: { name: "web" } }]);
  await withOneResponse(noValuesKey, 200, async () => {
    await run("container-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  assertEquals(res.payload.containers, []);
});

// ---------------------------------------------------------------------------
// Hostile transport
// ---------------------------------------------------------------------------

Deno.test("pin: a non-ok HTTP response (500 + HTML body) throws 'VM query failed: <status> <text>' — this model DOES honor resp.ok", async () => {
  const { ctx } = makeCtx();
  const html = "<html><body>Internal Server Error</body></html>";
  await withFetchStub(
    [() =>
      new Response(html, {
        status: 500,
        headers: { "Content-Type": "text/html" },
      })],
    async () => {
      await assertRejects(
        () => run("query", { promql: "up" }, ctx),
        Error,
        `VM query failed: 500 ${html}`,
      );
    },
  );
});

Deno.test("fix (VM6): a 200 response carrying {status:'error',...} (error.json — no `data` field) is now inspected via vmData() and throws a mapped Error instead of a TypeError", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(errorFixture, 200, async () => {
    await assertRejects(
      () => run("query", { promql: "up" }, ctx),
      Error,
      "VM query error: invalid parameter",
    );
  });
});

// ---------------------------------------------------------------------------
// Generic vmData() mapped-error coverage (VM6+VM11) — across all three
// direct single-query methods, not just the error.json fixture shape
// ---------------------------------------------------------------------------

const DIRECT_METHODS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "query", args: { promql: "up" } },
  { name: "query-range", args: { promql: "up" } },
  { name: "health", args: {} },
];

Deno.test("fix (VM6+VM11): a generic {status:'error',error:'boom'} response maps to Error('VM query error: boom') across query/query-range/health", async () => {
  for (const { name, args } of DIRECT_METHODS) {
    const { ctx } = makeCtx();
    await withOneResponse(
      { status: "error", error: "boom" },
      200,
      async () => {
        await assertRejects(
          () => run(name, args, ctx),
          Error,
          "VM query error: boom",
        );
      },
    );
  }
});

Deno.test("fix (VM6+VM11): a 200 data-less body {} maps to Error('VM query error: response missing data') across query/query-range/health", async () => {
  for (const { name, args } of DIRECT_METHODS) {
    const { ctx } = makeCtx();
    await withOneResponse({}, 200, async () => {
      await assertRejects(
        () => run(name, args, ctx),
        Error,
        "VM query error: response missing data",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Fixtures-secret / real-infra scan — concrete named denylist + poison test
// ---------------------------------------------------------------------------

/**
 * CONCRETE named denylist (round-1 MED finding): an illustrative "e.g. real
 * hostnames" list can pass vacuously. This names the exact real-infra facts
 * that must never leak into a synthetic fixture — the homelab domain, the
 * hypervisor host name, this exact live instance's name, and the three
 * private/CGNAT ranges actually routable in that homelab.
 *
 * The IP-range patterns require a FULL dotted-quad shape (four octets) —
 * not a bare "10." substring — because this model's own legitimate fixture
 * values are small percentages like "10.5" and "12.0" that a bare-prefix
 * match would falsely flag. Requiring the full a.b.c.d shape still catches
 * any real address in the range while staying green over genuine metric
 * values.
 */
const REAL_INFRA_DENYLIST: Array<{ name: string; re: RegExp }> = [
  { name: "homelab domain 'aopab'", re: /aopab/i },
  { name: "hypervisor host 'unraid'", re: /unraid/i },
  { name: "live instance name 'vm-unraid'", re: /vm-unraid/i },
  {
    name: "RFC1918 192.168.0.0/16 address",
    re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  },
  {
    name: "RFC1918 10.0.0.0/8 address",
    re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  },
  {
    name: "CGNAT 100.64.0.0/10 address",
    re: /\b100\.64\.\d{1,3}\.\d{1,3}\b/,
  },
];

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  ...REAL_INFRA_DENYLIST,
  // Generic high-entropy blob backstop, mirroring the porkbun precedent —
  // none of this model's authored fixture values (labels, PromQL strings,
  // byte counts, percentages) are a single 32+ char alnum/base64url token.
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9+/_=-]{32,}$/ },
];

/** Recursively collect every string LEAF and every object KEY in a parsed
 * JSON structure. Keys matter here specifically because system_overview.json
 * is keyed BY the six PromQL query strings themselves (not just nested under
 * generic field names like the other fixtures) — a values-only scan would
 * leave that dictionary's keys as a blind spot. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
  return out;
}

const FIXTURES: Record<string, unknown> = {
  "query_vector.json": queryVector,
  "query_scalar.json": queryScalar,
  "query_range_matrix.json": queryRangeMatrix,
  "health_up.json": healthUp,
  "system_overview.json": systemOverviewFixture,
  "container_memory.json": containerMemory,
  "error.json": errorFixture,
};

Deno.test("fixtures-secret/real-infra-scan: no committed fixture contains a real-infra or secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `real-infra/secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret/real-infra-scan: poison sanity — the scanner actually detects an injected real-infra substring and a CGNAT address", () => {
  // Guards against the scan test above being vacuously true.
  const poisoned = {
    host: "unraid.aopab.example",
    wireguard: "100.64.1.5",
  };
  const violations: string[] = [];
  for (const str of collectStrings(poisoned)) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(`${str} matched ${name}`);
    }
  }
  assert(
    violations.some((v) => v.includes("aopab")),
    "sanity: scanner must flag the aopab domain substring",
  );
  assert(
    violations.some((v) => v.includes("unraid")),
    "sanity: scanner must flag the unraid substring",
  );
  assert(
    violations.some((v) => v.includes("100.64.1.5")),
    "sanity: scanner must flag the CGNAT address",
  );
});

/* ---------------------------------------------------------------------------
 * Virtual block-layer double-counting (2026-08-30 Tower false positive).
 *
 * On Unraid an encrypted array slot stacks dm-N -> mdXp1 -> one physical sdX,
 * and node_exporter exports EVERY layer. `system-overview` therefore listed
 * dm-3 and sdl as two busy disks when they are one 14.6TB spindle, and the
 * pair reading the same number was mistaken for two devices corroborating
 * each other. Only physical devices may reach `disk`/`anomalies`.
 * ------------------------------------------------------------------------ */

Deno.test("isPhysicalDiskDevice: keeps real spindles, drops every virtual layer", () => {
  for (const d of ["sda", "sdl", "sdaa", "nvme0n1", "vda", "hdb", "xvdf"]) {
    assert(isPhysicalDiskDevice(d), `${d} should be kept`);
  }
  for (
    const d of [
      "dm-0",
      "dm-3",
      "dm-10",
      "md1p1",
      "md4",
      "loop2",
      "sr0",
      "zram0",
      "ram3",
      "dm-name-md4p1",
      "",
    ]
  ) {
    assert(!isPhysicalDiskDevice(d), `${d} should be dropped`);
  }
});

Deno.test("DISK_IO_QUERY excludes virtual layers server-side", () => {
  assert(
    DISK_IO_QUERY.includes("node_disk_io_time_seconds_total"),
    "must still read the io_time counter",
  );
  assert(
    /device!~/.test(DISK_IO_QUERY),
    "must carry a negative device matcher so VM drops the layers at query time",
  );
  for (const layer of ["dm-", "md", "loop", "sr", "zram", "ram"]) {
    assert(
      DISK_IO_QUERY.includes(layer),
      `matcher must name the ${layer} layer`,
    );
  }
});

Deno.test("system-overview drops dm-*/md* series even when the server returns them", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  // dm-3 IS sdl (md4p1 over disk4). A server that ignores the matcher, or an
  // older VM, still must not produce two entries for one spindle.
  const doubleCounted = matrixBody([
    { metric: { device: "dm-3" }, values: [[FIXED_EPOCH_S, "95"]] },
    { metric: { device: "md4p1" }, values: [[FIXED_EPOCH_S, "95"]] },
    { metric: { device: "sdl" }, values: [[FIXED_EPOCH_S, "94"]] },
    { metric: { device: "loop2" }, values: [[FIXED_EPOCH_S, "99"]] },
  ]);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [DISK_QUERY]: doubleCounted })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const payload = written.find((w) => w.spec === "overview")!.payload;
  assertEquals(
    (payload.disk as Array<{ device: string }>).map((d) => d.device),
    ["sdl"],
  );
  assertEquals(
    (payload.anomalies as string[]).filter((a) => a.includes("saturated")),
    ["Disk sdl saturated at 94%"],
  );
});
