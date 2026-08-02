/**
 * Contract-fixture suite: pins the CONCRETE VictoriaMetrics/Prometheus HTTP
 * query API wire shape from victoriametrics/fixtures/*.json directly —
 * independent of victoriametrics.ts's resource schemas, which use
 * `z.array(z.any())` for `queryResult.results`. A suite that only asserted
 * "the written resource validates against the model's schema" would be
 * toothless there (z.any() accepts anything); this suite hardcodes the
 * expected keyset + value types documented by the Prometheus HTTP API query
 * format (https://prometheus.io/docs/prometheus/latest/querying/api/), which
 * VictoriaMetrics implements wire-compatibly, so a real wire-format drift
 * turns a test red (see STANDARD.md's contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made.
 *
 * As of 2026.08.02.1, victoriametrics.ts has been FIXED (all 11 latent bugs
 * tracked by victoriametrics-latent-bugs closed — see the adversarial suite
 * for the flipped pins). Every assertion in THIS file stays BYTE-IDENTICAL —
 * none of the fixed bugs touch the benign, single-series, well-formed wire
 * shapes this contract-fixture suite characterizes; the fixes only change
 * behavior on multi-series/malformed/absent input, which this suite never
 * feeds it.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./victoriametrics.ts";
import queryVector from "../../fixtures/query_vector.json" with {
  type: "json",
};
import queryRangeMatrix from "../../fixtures/query_range_matrix.json" with {
  type: "json",
};
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

function withFixture(body: unknown, fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  const stub: typeof globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  globalThis.fetch = stub;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const CPU_QUERY = '100-avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100';
const NET_QUERY = 'rate(node_network_receive_bytes_total{device="br0"}[5m])*8';

function withSystemOverviewFixture(fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  const table = systemOverviewFixture as Record<string, unknown>;
  const stub: typeof globalThis.fetch = (input) => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
      ? input.toString()
      : input;
    const query = new URL(url).searchParams.get("query");
    if (query === null || !(query in table)) {
      throw new Error(`fetch stub: unrouted query ${query}`);
    }
    return Promise.resolve(
      new Response(JSON.stringify(table[query]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  globalThis.fetch = stub;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// query_vector.json contract — instant vector
// ---------------------------------------------------------------------------

Deno.test("contract: query_vector.json — vector result maps to {metric, value:<parsed number>}", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFixture(queryVector, () => run("query", { promql: "up" }, ctx));
  const res = written.find((w) => w.spec === "queryResult")!;
  assertEquals(res.payload.resultType, "vector");
  const results = res.payload.results as Array<
    { metric: Record<string, string>; value: number | null }
  >;
  assertEquals(results.length, 1);
  assertEquals(results[0].metric, {
    job: "demo-node",
    instance: "fixture-host-1:9100",
  });
  assertEquals(results[0].value, 42.5);
  assertEquals(typeof results[0].value, "number");
  assertEquals(res.payload.timestamp, new Date(FIXED_NOW_MS).toISOString());
});

// ---------------------------------------------------------------------------
// query_range_matrix.json contract — range matrix
// ---------------------------------------------------------------------------

Deno.test("contract: query_range_matrix.json — matrix result maps to {metric, values:[{timestamp,value}]}", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFixture(
    queryRangeMatrix,
    () => run("query-range", { promql: "node_load1" }, ctx),
  );
  const res = written.find((w) => w.spec === "queryResult")!;
  assertEquals(res.payload.resultType, "matrix");
  const results = res.payload.results as Array<
    {
      metric: Record<string, string>;
      values: Array<{ timestamp: number; value: number }>;
    }
  >;
  assertEquals(results.length, 1);
  assertEquals(results[0].values, [
    { timestamp: 1699956800, value: 1.1 },
    { timestamp: 1699957100, value: 1.3 },
    { timestamp: 1699957400, value: 1.2 },
  ]);
});

// ---------------------------------------------------------------------------
// health_up.json contract — up vector -> targets[]
// ---------------------------------------------------------------------------

Deno.test("contract: health_up.json — every target has exactly {name, status} with status in {up,down}", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFixture(healthUp, () => run("health", {}, ctx));
  const res = written.find((w) => w.spec === "health")!;
  const targets = res.payload.targets as Array<
    { name: string; status: string }
  >;
  assertEquals(targets.length, 2);
  for (const t of targets) {
    assertEquals(Object.keys(t).sort(), ["name", "status"]);
    assert(t.status === "up" || t.status === "down");
  }
  assertEquals(targets[0], {
    name: "demo-node (fixture-host-1:9100)",
    status: "up",
  });
  assertEquals(targets[1], {
    name: "demo-node (fixture-host-2:9100)",
    status: "down",
  });
});

// ---------------------------------------------------------------------------
// system_overview.json contract — the six-query fixture, full keyset
// ---------------------------------------------------------------------------

Deno.test("contract: system_overview.json — six exact PromQL keys route correctly; overview carries the full documented keyset", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withSystemOverviewFixture(() => run("system-overview", {}, ctx));
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(
    Object.keys(res.payload).sort(),
    [
      "anomalies",
      "cpu",
      "disk",
      "load",
      "memory",
      "network",
      "timestamp",
      "uptime",
    ],
  );
  const cpu = res.payload.cpu as Record<string, number>;
  assertEquals(Object.keys(cpu).sort(), ["avg", "current", "max", "min"]);
  const memory = res.payload.memory as Record<string, number>;
  assertEquals(
    Object.keys(memory).sort(),
    ["avg", "max", "min", "usedPercent"],
  );
  const load = res.payload.load as Record<string, number>;
  assertEquals(Object.keys(load).sort(), ["avg", "load1", "max", "min"]);
  const network = res.payload.network as Record<string, number>;
  assertEquals(Object.keys(network).sort(), ["avgMbps", "maxMbps"]);
  const uptime = res.payload.uptime as Record<string, unknown>;
  assertEquals(Object.keys(uptime).sort(), ["bootTime", "uptimeMinutes"]);
  const disk = res.payload.disk as Array<Record<string, unknown>>;
  for (const d of disk) {
    assertEquals(
      Object.keys(d).sort(),
      ["avgIoPercent", "device", "maxIoPercent"],
    );
  }
  assertEquals(res.payload.anomalies, []);
});

Deno.test("contract: system_overview.json — quiet fixture yields the exact pinned cpu/memory/load/disk/network/uptime values", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withSystemOverviewFixture(() => run("system-overview", {}, ctx));
  const res = written.find((w) => w.spec === "overview")!;
  assertEquals(res.payload.cpu, {
    current: 11.2,
    min: 10.5,
    max: 12.0,
    avg: (10.5 + 12.0 + 11.2) / 3,
  });
  assertEquals(res.payload.memory, {
    usedPercent: 44.8,
    min: 44.8,
    max: 46.2,
    avg: (45.0 + 46.2 + 44.8) / 3,
  });
  assertEquals(res.payload.load, { load1: 0.6, min: 0.5, max: 0.7, avg: 0.6 });
  assertEquals(res.payload.disk, [
    { device: "vda", maxIoPercent: 15, avgIoPercent: 13.5 },
  ]);
  assertEquals(res.payload.network, {
    maxMbps: 7.5,
    avgMbps: (5000000 + 7500000 + 6200000) / 3 / 1e6,
  });
  assertEquals(res.payload.uptime, {
    bootTime: new Date(1699982000 * 1000).toISOString(),
    uptimeMinutes: 300,
  });
});

Deno.test("sanity: CPU_QUERY and NET_QUERY constants match the exact keys present in system_overview.json (documents the six-key coupling)", () => {
  const table = systemOverviewFixture as Record<string, unknown>;
  assert(CPU_QUERY in table, "cpu query key must be present verbatim");
  assert(NET_QUERY in table, "network query key must be present verbatim");
  assertEquals(Object.keys(table).length, 6, "exactly six queries are keyed");
});

// ---------------------------------------------------------------------------
// container_memory.json contract — matrix -> containers[] ranking
// ---------------------------------------------------------------------------

Deno.test("contract: container_memory.json — every container has exactly the documented keyset, sorted desc by maxMB, sub-50MB filtered", async () => {
  using _time = new FakeTime(FIXED_NOW_MS);
  const { ctx, written } = makeCtx();
  await withFixture(
    containerMemory,
    () => run("container-memory", {}, ctx),
  );
  const res = written.find((w) => w.spec === "containerMemory")!;
  const containers = res.payload.containers as Array<Record<string, unknown>>;
  // "worker" tops out under the 50MB threshold and must be filtered out.
  assertEquals(containers.map((c) => c.name), ["cache", "web"]);
  for (const c of containers) {
    assertEquals(
      Object.keys(c).sort(),
      ["endMB", "growthPercent", "maxMB", "name", "startMB"],
    );
  }
  assertEquals(containers[0], {
    name: "cache",
    maxMB: 124,
    startMB: 114,
    endMB: 119,
    growthPercent: 4.2,
  });
  assertEquals(containers[1], {
    name: "web",
    maxMB: 72,
    startMB: 57,
    endMB: 67,
    growthPercent: 16.7,
  });
});
