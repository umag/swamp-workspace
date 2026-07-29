/**
 * Property-based tests (fast-check) for @magistr/victoriametrics.
 *
 * victoriametrics.ts exports no pure helpers (stats/extractValues are module-
 * private) — every property here is observed by driving
 * `model.methods.<m>.execute()` against a stubbed fetch and reading back the
 * written resource, per the approved plan.
 *
 * Properties:
 *  (a) stats identities — arbitrary constrained to FINITE bounded doubles
 *      (fc.double({min:-1e6,max:1e6,noNaN:true,noDefaultInfinity:true}));
 *      asserts the EXACT identities min===Math.min(...vals),
 *      max===Math.max(...vals), current===last — NOT the avg-ordering chain
 *      (round-1 MED: a naive min<=avg<=max property false-fails on floats).
 *  (b) container ranking — sorted desc by maxMB, length===min(qualifying,
 *      topN), every output maxMB>=50.
 *  (c) health — every target status in {up,down}, count===#series (absent
 *      series are never counted, by construction: every generated tuple
 *      yields a real series).
 *  (d) promql transport lossless/injective —
 *      new URL(url).searchParams.get("query")===promql for arbitrary
 *      strings. NO double-decode (searchParams.get already decodes — this
 *      was the round-1 HIGH).
 *  (e) query-range flow — end===now, start===end-hoursBack*3600,
 *      end>start for hoursBack>0 (deterministic under FakeTime).
 *
 * Any property that drives system-overview answers ALL SIX queries with the
 * benign quiet fixture and only overrides the ONE metric under test (round-1
 * residual LOW — the stub throws "unrouted" otherwise). FakeTime is
 * constructed/disposed INSIDE each fc run via a `using` declaration so the
 * frozen clock is restored between iterations (same residual LOW).
 */
import { assert } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./victoriametrics.ts";
import systemOverviewFixture from "../../fixtures/system_overview.json" with {
  type: "json",
};

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

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

type Route = (req: Request) => Response | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub: typeof globalThis.fetch = (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = r(req);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unrouted ${req.url}`));
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

const LOAD_QUERY = "node_load1";

/** Router over the six exact PromQL strings, defaulting to the quiet
 * fixture for every key except the one under test. */
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
  result: Array<{ metric?: Record<string, string>; values: unknown }>,
) {
  return { status: "success", data: { resultType: "matrix", result } };
}

// ---------------------------------------------------------------------------
// (a) stats identities — exact, over finite bounded doubles
// ---------------------------------------------------------------------------

const arbFiniteDouble = fc.double({
  min: -1e6,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
});

Deno.test("property: stats identities — load.min/max/current are EXACT over any finite bounded series (via system-overview)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbFiniteDouble, { minLength: 1, maxLength: 15 }),
      async (vals) => {
        using _time = new FakeTime(FIXED_NOW_MS);
        const { ctx, written } = makeCtx();
        const series = matrixBody([{
          metric: {},
          values: vals.map((
            v,
            i,
          ) => [FIXED_EPOCH_S - (vals.length - i) * 300, String(v)]),
        }]);
        await withFetchStub(
          [systemOverviewRoute({ [LOAD_QUERY]: series })],
          async () => {
            await run("system-overview", {}, ctx);
          },
        );
        const load = written.find((w) => w.spec === "overview")!
          .payload.load as { min: number; max: number; load1: number };
        return (
          load.min === Math.min(...vals) &&
          load.max === Math.max(...vals) &&
          load.load1 === vals[vals.length - 1]
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) container ranking — sorted desc, length clamp, threshold floor
// ---------------------------------------------------------------------------

const arbContainerBytes = fc.array(
  fc.integer({ min: 0, max: 209715200 }), // 0..200MB
  { minLength: 1, maxLength: 20 },
);
const FIFTY_MB = 50 * 1024 * 1024;

Deno.test("property: container-memory ranking is sorted desc by maxMB, length==min(qualifying,topN), every output >=50MB", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbContainerBytes,
      fc.integer({ min: 0, max: 25 }),
      async (byteCounts, topN) => {
        using _time = new FakeTime(FIXED_NOW_MS);
        const { ctx, written } = makeCtx();
        const body = matrixBody(
          byteCounts.map((bytes, i) => ({
            metric: { name: `c${i}` },
            values: [[FIXED_EPOCH_S, String(bytes)]],
          })),
        );
        await withFetchStub([() => json(body)], async () => {
          await run("container-memory", { topN }, ctx);
        });
        const containers = written.find((w) => w.spec === "containerMemory")!
          .payload.containers as Array<{ maxMB: number }>;
        const qualifying = byteCounts.filter((b) => b >= FIFTY_MB).length;
        const sortedDesc = containers.every((c, i) =>
          i === 0 || containers[i - 1].maxMB >= c.maxMB
        );
        const allAbove50 = containers.every((c) => c.maxMB >= 50);
        return (
          sortedDesc &&
          allAbove50 &&
          containers.length === Math.min(qualifying, topN)
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) health — status domain + exact per-series correspondence
// ---------------------------------------------------------------------------

const arbTarget = fc.record({
  job: fc.string({ minLength: 1, maxLength: 10, unit: "grapheme-ascii" }),
  instance: fc.string({ minLength: 1, maxLength: 10, unit: "grapheme-ascii" }),
  up: fc.constantFrom(0, 1),
});

Deno.test("property: health — every target status in {up,down}, one-to-one with the generated series (absent series are never counted)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbTarget, { minLength: 1, maxLength: 10 }),
      async (targets) => {
        const { ctx, written } = makeCtx();
        const body = {
          status: "success",
          data: {
            resultType: "vector",
            result: targets.map((t) => ({
              metric: { job: t.job, instance: t.instance },
              value: [FIXED_EPOCH_S, String(t.up)],
            })),
          },
        };
        await withFetchStub([() => json(body)], async () => {
          await run("health", {}, ctx);
        });
        const healthTargets = written.find((w) => w.spec === "health")!
          .payload.targets as Array<{ name: string; status: string }>;
        if (healthTargets.length !== targets.length) return false;
        return healthTargets.every((t, i) => {
          const expected = targets[i].up === 1 ? "up" : "down";
          return t.status === expected &&
            (t.status === "up" || t.status === "down");
        });
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) promql transport — lossless/injective, NO double-decode
// ---------------------------------------------------------------------------

Deno.test("property: query — searchParams.get('query') === promql for ANY string (no double-decode)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 200, unit: "grapheme-ascii" }),
      async (promql) => {
        const { ctx } = makeCtx();
        let observed = "";
        const body = {
          status: "success",
          data: { resultType: "vector", result: [] },
        };
        await withFetchStub([(req) => {
          observed = new URL(req.url).searchParams.get("query") ?? "";
          return json(body);
        }], async () => {
          await run("query", { promql }, ctx);
        });
        return observed === promql;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: query-range — searchParams.get('query') === promql for ANY string, and pathname/param-set stay fixed", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 200, unit: "grapheme-ascii" }),
      async (promql) => {
        const { ctx } = makeCtx();
        using _time = new FakeTime(FIXED_NOW_MS);
        let url: URL | undefined;
        const body = {
          status: "success",
          data: { resultType: "matrix", result: [] },
        };
        await withFetchStub([(req) => {
          url = new URL(req.url);
          return json(body);
        }], async () => {
          await run("query-range", { promql }, ctx);
        });
        return (
          url !== undefined &&
          url.pathname === "/api/v1/query_range" &&
          url.searchParams.get("query") === promql &&
          JSON.stringify(Array.from(url.searchParams.keys()).sort()) ===
            JSON.stringify(["end", "query", "start", "step"])
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) query-range flow — start/end derived deterministically under FakeTime
// ---------------------------------------------------------------------------

Deno.test("property: query-range flow — end===now, start===end-hoursBack*3600, end>start for hoursBack>0", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 100000 }),
      async (hoursBack) => {
        using _time = new FakeTime(FIXED_NOW_MS);
        const { ctx } = makeCtx();
        let url: URL | undefined;
        const body = {
          status: "success",
          data: { resultType: "matrix", result: [] },
        };
        await withFetchStub([(req) => {
          url = new URL(req.url);
          return json(body);
        }], async () => {
          await run("query-range", { promql: "up", hoursBack }, ctx);
        });
        assert(url !== undefined);
        const start = Number(url.searchParams.get("start"));
        const end = Number(url.searchParams.get("end"));
        return (
          end === FIXED_EPOCH_S &&
          start === end - hoursBack * 3600 &&
          end > start
        );
      },
    ),
    FC_RUNS,
  );
});
