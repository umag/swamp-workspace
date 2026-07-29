/**
 * Adversarial suite: PromQL injection through user args, hostile/partial
 * matrix responses, single-series collapse, anomaly-threshold edges, top-N
 * ties/empty/negative edges, hostile transport, and a fixtures-secret/
 * real-infra scan over victoriametrics/fixtures/*.json.
 *
 * victoriametrics.ts is UNMODIFIED — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Every documented gap is labeled "pin" and says so explicitly. The full set
 * of pinned latent bugs is tracked in the issue `victoriametrics-latent-bugs`
 * — these tests are the pins, not fixes.
 *
 * TOOLCHAIN NOTE: the fetch stub is bound via a TYPED CONST with NO
 * `as typeof globalThis.fetch` cast. FakeTime drives every timestamp
 * assertion and coexists with the fetch stub throughout.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./victoriametrics.ts";
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
const DISK_QUERY = "rate(node_disk_io_time_seconds_total[5m])*100";
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

Deno.test("pin: query on a SCALAR result produces garbage [{metric:undefined,value:null}, ...] — scalar's [ts,val] tuple has no .metric/.value", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(queryScalar, 200, async () => {
    await run("query", { promql: "scalar(7)" }, ctx);
  });
  const res = written.find((w) => w.spec === "queryResult")!;
  const results = res.payload.results as Array<
    { metric: unknown; value: unknown }
  >;
  assertEquals(results.length, 2, "the [ts, valueString] tuple has 2 items");
  for (const r of results) {
    assertEquals(r.metric, undefined);
    assertEquals(r.value, null);
  }
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

Deno.test("pin: query fed a 200 {status:'error'} body with NO `data` field throws an uncaught TypeError — the status field is never inspected", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(errorFixture, 200, async () => {
    await assertRejects(() => run("query", { promql: "up" }, ctx), TypeError);
  });
});

Deno.test("pin: query-range fed a VECTOR-shaped body throws an uncaught TypeError (.values.map on undefined — vector elements have .value, not .values)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx } = makeCtx();
  await withOneResponse(queryVector, 200, async () => {
    await assertRejects(
      () => run("query-range", { promql: "up" }, ctx),
      TypeError,
    );
  });
});

Deno.test("pin: system-overview — a range query answering with a SCALAR body crashes extractValues (result.data.result[0] is a bare number, .values is undefined)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: queryScalar })],
    async () => {
      await assertRejects(() => run("system-overview", {}, ctx), TypeError);
    },
  );
});

// ---------------------------------------------------------------------------
// SINGLE-SERIES COLLAPSE (round-1 HIGH) — pin the multi-series drop
// ---------------------------------------------------------------------------

Deno.test("pin: system-overview's memory stats characterize ONLY series[0] of a multi-series range result — series[1..] are silently dropped", async () => {
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
      // A second series with WILDLY different values. If extractValues
      // aggregated across series, memStats would reflect this — it must
      // not, because extractValues reads only result.data.result[0].
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
    usedPercent: 41.0,
    min: 40.0,
    max: 42.0,
    avg: 41.0,
  });
  assert(
    (res.payload.anomalies as string[]).length === 0,
    "series[1]'s 95-97% values must NOT leak into the anomaly checks",
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

Deno.test("pin: an EMPTY cpu result (no series at all) silently reports {current:0,min:0,max:0,avg:0} — not flagged as missing", async () => {
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
    [],
    "absence is indistinguishable from a genuinely idle 0% CPU",
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

Deno.test("pin: a disk series MISSING the `values` key entirely throws an uncaught TypeError (r.values.map on undefined)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx } = makeCtx();
  const diskNoValuesKey = matrixBody([{ metric: { device: "vda" } }]);
  await withFetchStub(
    [systemOverviewRoute({ [DISK_QUERY]: diskNoValuesKey })],
    async () => {
      await assertRejects(() => run("system-overview", {}, ctx), TypeError);
    },
  );
});

// ---------------------------------------------------------------------------
// Empty boot-time result — 1970 epoch + huge uptime
// ---------------------------------------------------------------------------

Deno.test("pin: an empty boot-time result falls back to bootTs=0 -> bootTime is the 1970 epoch and uptimeMinutes is enormous", async () => {
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
    bootTime: new Date(0).toISOString(),
    uptimeMinutes: Math.round(FIXED_EPOCH_S / 60),
  });
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
    "an absent target contributes NOTHING to targets[] — it is not reported down",
  );
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

Deno.test("pin: a series MISSING the `value` field entirely throws an uncaught TypeError (r.value[1] on undefined) — same unguarded-access shape as the disk/container `.values` pins", async () => {
  // health()'s mapper does `parseFloat(r.value[1])` with no guard — a
  // partial/hostile `up` response that omits `value` for a series crashes,
  // exactly like the disk-loop and container-memory `.values` pins
  // (round-1 MED shape) but on the SINGULAR `.value` field instead.
  const { ctx } = makeCtx();
  const body = vectorBody([{ metric: { job: "demo-node", instance: "x" } }]);
  await withOneResponse(body, 200, async () => {
    await assertRejects(() => run("health", {}, ctx), TypeError);
  });
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

Deno.test("pin: NEGATIVE topN uses slice(0,-n) — drops from the END of the already-desc-sorted array, not 'the smallest n'", async () => {
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
  const containers = res.payload.containers as Array<{ name: string }>;
  assertEquals(
    containers.map((c) => c.name),
    ["big", "mid"],
    "slice(0,-1) drops the LAST (smallest, since desc-sorted) element",
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

Deno.test("pin: a container series MISSING the `values` key entirely throws an uncaught TypeError (r.values.map on undefined)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx } = makeCtx();
  const noValuesKey = matrixBody([{ metric: { name: "web" } }]);
  await withOneResponse(noValuesKey, 200, async () => {
    await assertRejects(
      () => run("container-memory", {}, ctx),
      TypeError,
    );
  });
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

Deno.test("pin: a 200 response carrying {status:'error',...} (error.json — no `data` field) is NOT inspected by status — it crashes with a TypeError instead of a mapped error", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(errorFixture, 200, async () => {
    await assertRejects(() => run("query", { promql: "up" }, ctx), TypeError);
  });
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
