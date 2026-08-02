/**
 * Coverage suite: sweeps every remaining guard/branch in victoriametrics.ts
 * that the contract-fixture/methods/adversarial suites don't already
 * exercise on BOTH sides, so deleting any one of these guards turns a test
 * red (STANDARD.md's coverage role — a behavioral regression guard, not a
 * numeric percentage).
 *
 * Also adds the single-series-collapse guard's GREEN complement (a genuine
 * single-series range result computes correct stats) as the positive
 * counterpart to the adversarial suite's multi-series pin, plus (as of
 * 2026.08.02.1) a TWO-series green complement now that VM2 aggregates across
 * series instead of collapsing to series[0].
 *
 * As of 2026.08.02.1, victoriametrics.ts has been FIXED (all 11 latent bugs
 * tracked by victoriametrics-latent-bugs closed — see the adversarial suite
 * for the flipped pins). Every EXISTING test in this file stays
 * BYTE-IDENTICAL — each drives a single well-formed series per metric with
 * every guard/key present, so none of the 11 fixes change their outcome.
 */
import { assertEquals } from "jsr:@std/assert@1";
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
const NET_QUERY = 'rate(node_network_receive_bytes_total{device="br0"}[5m])*8';

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
// extractValues' three `!` guards — both sides each
// ---------------------------------------------------------------------------

Deno.test("extractValues guard 1: `!result.data` (data key entirely absent) -> [] (no crash)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: { status: "success" } })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.cpu, { current: 0, min: 0, max: 0, avg: 0 });
});

Deno.test("extractValues guard 2: `!result.data.result` (result key absent under data) -> [] (no crash)", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      systemOverviewRoute({
        [CPU_QUERY]: { status: "success", data: { resultType: "matrix" } },
      }),
    ],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.cpu, { current: 0, min: 0, max: 0, avg: 0 });
});

Deno.test("extractValues guard 3: `!result.data.result[0]` (result is a present but empty array) -> [] (no crash)", async () => {
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
});

Deno.test("extractValues: all three guards FALSE (data/result/result[0] all present) -> the real series is read", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const cpuSeries = matrixBody([{
    metric: {},
    values: [[FIXED_EPOCH_S - 300, "20"], [FIXED_EPOCH_S, "24"]],
  }]);
  await withFetchStub(
    [systemOverviewRoute({ [CPU_QUERY]: cpuSeries })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.cpu, { current: 24, min: 20, max: 24, avg: 22 });
});

// ---------------------------------------------------------------------------
// stats(): empty vs non-empty
// ---------------------------------------------------------------------------

Deno.test("stats: empty input -> {min:0,max:0,avg:0} (the `!values.length` guard)", async () => {
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
});

Deno.test("stats: non-empty input -> real min/max/avg computed from the values", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const loadSeries = matrixBody([{
    metric: {},
    values: [[FIXED_EPOCH_S - 300, "1"], [FIXED_EPOCH_S, "3"]],
  }]);
  await withFetchStub(
    [systemOverviewRoute({ [LOAD_QUERY]: loadSeries })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.load, { load1: 3, min: 1, max: 3, avg: 2 });
});

// ---------------------------------------------------------------------------
// disk: `.filter(>10)` + `.sort` desc + `device || "unknown"`
// ---------------------------------------------------------------------------

Deno.test("disk: three devices — below-10 filtered out, the remaining two sorted DESC by maxIoPercent, missing device label -> 'unknown'", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const diskSeries = matrixBody([
    { metric: { device: "vda" }, values: [[FIXED_EPOCH_S, "20"]] },
    { metric: {}, values: [[FIXED_EPOCH_S, "50"]] }, // no device label
    { metric: { device: "vdc" }, values: [[FIXED_EPOCH_S, "5"]] }, // filtered
  ]);
  await withFetchStub(
    [systemOverviewRoute({ [DISK_QUERY]: diskSeries })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.disk, [
    { device: "unknown", maxIoPercent: 50, avgIoPercent: 50 },
    { device: "vda", maxIoPercent: 20, avgIoPercent: 20 },
  ]);
});

// ---------------------------------------------------------------------------
// container-memory: `name || "unknown"`, <50MB continue (both sides in one
// mixed batch), and slice(topN) fewer-than-N
// ---------------------------------------------------------------------------

Deno.test("container-memory: missing `name` label -> 'unknown'; a mixed batch keeps qualifying containers and drops sub-50MB ones", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const mixed = matrixBody([
    { metric: {}, values: [[FIXED_EPOCH_S, "60000000"]] }, // no name -> unknown, qualifies
    { metric: { name: "tiny" }, values: [[FIXED_EPOCH_S, "1000000"]] }, // <50MB, dropped
  ]);
  await withOneResponse(mixed, 200, async () => {
    await run("container-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  const containers = res.payload.containers as Array<{ name: string }>;
  assertEquals(containers.map((c) => c.name), ["unknown"]);
});

Deno.test("container-memory: fewer containers than topN -> all of them are returned, in ranked order", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const two = matrixBody([
    { metric: { name: "small" }, values: [[FIXED_EPOCH_S, "60000000"]] },
    { metric: { name: "big" }, values: [[FIXED_EPOCH_S, "120000000"]] },
  ]);
  await withOneResponse(two, 200, async () => {
    await run("container-memory", { topN: 20 }, ctx);
  });
  const res = written.find((w) => w.spec === "containerMemory")!;
  const containers = res.payload.containers as Array<{ name: string }>;
  assertEquals(containers.map((c) => c.name), ["big", "small"]);
});

// ---------------------------------------------------------------------------
// cpu/mem/load `.length ? last : 0` current-value ternaries — both sides
// ---------------------------------------------------------------------------

Deno.test("cpu/mem/load current-value ternary: zero-length series -> current 0 for all three metrics", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      systemOverviewRoute({
        [CPU_QUERY]: matrixBody([]),
        [MEM_QUERY]: matrixBody([]),
        [LOAD_QUERY]: matrixBody([]),
      }),
    ],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals((res.payload.cpu as { current: number }).current, 0);
  assertEquals((res.payload.memory as { usedPercent: number }).usedPercent, 0);
  assertEquals((res.payload.load as { load1: number }).load1, 0);
});

Deno.test("cpu/mem/load current-value ternary: non-empty series -> current is the LAST sample, not min/max/avg", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const rising = (last: string) =>
    matrixBody([{
      metric: {},
      values: [[FIXED_EPOCH_S - 300, "1"], [FIXED_EPOCH_S, last]],
    }]);
  await withFetchStub(
    [
      systemOverviewRoute({
        [CPU_QUERY]: rising("9"),
        [MEM_QUERY]: rising("8"),
        [LOAD_QUERY]: rising("7"),
      }),
    ],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals((res.payload.cpu as { current: number }).current, 9);
  assertEquals((res.payload.memory as { usedPercent: number }).usedPercent, 8);
  assertEquals((res.payload.load as { load1: number }).load1, 7);
});

// ---------------------------------------------------------------------------
// network: `/1e6` conversion to Mbps
// ---------------------------------------------------------------------------

Deno.test("network: bits/sec values are divided by 1e6 to produce Mbps", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const netSeries = matrixBody([{
    metric: { device: "br0" },
    values: [[FIXED_EPOCH_S - 300, "5000000"], [FIXED_EPOCH_S, "10000000"]],
  }]);
  await withFetchStub(
    [systemOverviewRoute({ [NET_QUERY]: netSeries })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.network, { maxMbps: 10, avgMbps: 7.5 });
});

// ---------------------------------------------------------------------------
// query: `r.value ? parseFloat(r.value[1]) : null` — both sides
// ---------------------------------------------------------------------------

Deno.test("query: a series with `value` present -> parsed float; a series with `value` absent -> null", async () => {
  const { ctx, written } = makeCtx();
  const body = vectorBody([
    {
      metric: { instance: "fixture-host-1:9100" },
      value: [FIXED_EPOCH_S, "5.5"],
    },
    { metric: { instance: "fixture-host-2:9100" } }, // no `value` key at all
  ]);
  await withOneResponse(body, 200, async () => {
    await run("query", { promql: "up" }, ctx);
  });
  const res = written.find((w) => w.spec === "queryResult")!;
  const results = res.payload.results as Array<{ value: number | null }>;
  assertEquals(results[0].value, 5.5);
  assertEquals(results[1].value, null);
});

// ---------------------------------------------------------------------------
// Single-series-collapse GREEN complement — a genuine single-series result
// characterizes correctly (contrast with the adversarial multi-series pin)
// ---------------------------------------------------------------------------

Deno.test("green complement: a single-series memory range result computes correct min/max/avg/current — the collapse pin is about MULTI-series input, not single-series correctness", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const singleSeriesMem = matrixBody([{
    metric: { instance: "fixture-host-1:9100" },
    values: [
      [1699956800, "40.0"],
      [1699957100, "42.0"],
      [1699957400, "41.0"],
    ],
  }]);
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: singleSeriesMem })],
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
});

Deno.test("green complement (VM2 fix): a TWO-series memory range result AGGREGATES across both series — min/max/avg/current reflect the full combined set, not just series[0]", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  const twoSeriesMem = matrixBody([
    {
      metric: { instance: "fixture-host-1:9100" },
      values: [
        [1699956800, "40.0"],
        [1699957100, "42.0"],
        [1699957400, "41.0"],
      ],
    },
    {
      metric: { instance: "fixture-host-2:9100" },
      values: [
        [1699957700, "50.0"],
        [1699958000, "52.0"],
        [1699958300, "51.0"],
      ],
    },
  ]);
  await withFetchStub(
    [systemOverviewRoute({ [MEM_QUERY]: twoSeriesMem })],
    async () => {
      await run("system-overview", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.memory, {
    usedPercent: 51.0,
    min: 40.0,
    max: 52.0,
    avg: 46.0,
  });
});
