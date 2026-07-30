/**
 * Contract-fixture suite: pins the CONCRETE wire shape of cadvisor.ts's TWO
 * boundaries — the cAdvisor `/api/v1.3/docker` HTTP response and the
 * VictoriaMetrics `/api/v1/query_range` HTTP response — plus the prometheus
 * scrape-config TEXT shape `deploy` reads/writes over SSH.
 *
 * Unlike the `porkbun` exemplar (whose resource schemas are `z.any()`, so its
 * contract suite can assert written-resource == fixture pass-through),
 * cadvisor.ts TRANSFORMS its raw input: current-metrics computes
 * memoryUsageMB from bytes, cpuPercent from cpu.usage.total deltas, and
 * rx/txMBps from network byte deltas — and MetricsSchema/TopMemorySchema use
 * `z.number()`, not `z.any()`. A contract suite modeled on porkbun's
 * written==fixture equality would therefore be WRONG here (round-1 plan
 * review MEDIUM finding).
 *
 * So this suite pins the RAW cAdvisor/VM INPUT wire keyset + types (what the
 * outside world sends us) and the exact REQUEST URLs cadvisor.ts builds (what
 * we send the outside world) as the drift sentinel. It does NOT assert the
 * post-transform MB/percent/rate VALUES — that byte-level transform is pinned
 * in cadvisor_methods_test.ts and cadvisor_coverage_test.ts instead, per the
 * review finding.
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made, and no Deno.Command is constructed at all in this
 * file (the scrape-config text shape is pinned via direct fixture comparison,
 * not by driving deploy() — that execution-level pin belongs to the methods
 * suite). cadvisor.ts is UNMODIFIED — characterization, not TDD.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./cadvisor.ts";
import dockerFixture from "../../fixtures/cadvisor-docker.json" with {
  type: "json",
};
import vmRangeFixture from "../../fixtures/vm-query-range.json" with {
  type: "json",
};

// The two prometheus scrape-config TEXT fixtures are read at runtime (no
// "text" import-attribute exists in stable Deno) rather than imported
// statically — mirrors the `pihole` precedent's readFixtureText helper.
// Requires the narrowly-scoped `--allow-read=extensions,fixtures` the
// deno.json test task grants (still network-less and run-less).
const FIXTURES_DIR = new URL("../../fixtures/", import.meta.url);

async function readFixtureText(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIXTURES_DIR));
}

const scrapeConfigBefore = await readFixtureText("scrape-config-before.txt");
const scrapeConfigAfter = await readFixtureText("scrape-config-after.txt");

// ---------------------------------------------------------------------------
// Harness (fetch boundary only — this suite never touches Deno.Command)
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  host: "host.example.com",
  username: "root",
  cadvisorPort: 8080,
  vmComposeDir: "/opt/victoriametrics",
  vmComposeFile: "compose-vl-single.yml",
  vmScrapeConfig: "prometheus-vl-single.yml",
};

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

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

async function withFetchStub(
  body: unknown,
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: Request | URL | string) => {
    const req = input instanceof Request ? input : new Request(input);
    calls.push(req.clone());
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// Section A — cadvisor-docker.json raw wire keyset + types
// (the cAdvisor /api/v1.3/docker ContainerInfo contract)
// ---------------------------------------------------------------------------

type RawContainerInfo = {
  aliases?: string[];
  spec?: { memory?: { limit?: number }; cpu?: { limit?: number } };
  stats?: Array<{
    timestamp: string;
    memory?: { usage?: number };
    cpu?: { usage: { total: number; per_cpu_usage?: number[] } };
    network?: { rx_bytes?: number; tx_bytes?: number };
  }>;
};

const docker = dockerFixture as unknown as Record<string, RawContainerInfo>;

Deno.test("contract: cadvisor-docker.json — every key is a /docker/<id> cgroup path", () => {
  const paths = Object.keys(docker);
  assert(paths.length > 0, "fixture must have at least one container");
  for (const p of paths) {
    assert(p.startsWith("/docker/"), `${p} must be a /docker/<id> cgroup path`);
  }
});

Deno.test("contract: cadvisor-docker.json — every stats[] entry has the documented keyset with correct wire types", () => {
  for (const [path, info] of Object.entries(docker)) {
    for (const stat of info.stats ?? []) {
      assertEquals(
        typeof stat.timestamp,
        "string",
        `${path}: stats[].timestamp must be a wire string (ISO-8601)`,
      );
      if (stat.memory) {
        assertEquals(
          typeof stat.memory.usage,
          "number",
          `${path}: stats[].memory.usage must be a wire number (bytes)`,
        );
      }
      if (stat.cpu) {
        assertEquals(
          typeof stat.cpu.usage.total,
          "number",
          `${path}: stats[].cpu.usage.total must be a wire number (nanoseconds)`,
        );
      }
      if (stat.network) {
        if (stat.network.rx_bytes !== undefined) {
          assertEquals(typeof stat.network.rx_bytes, "number");
        }
        if (stat.network.tx_bytes !== undefined) {
          assertEquals(typeof stat.network.tx_bytes, "number");
        }
      }
    }
  }
});

Deno.test("contract: cadvisor-docker.json — spec.memory.limit and spec.cpu.limit are wire numbers when present", () => {
  for (const [path, info] of Object.entries(docker)) {
    if (info.spec?.memory?.limit !== undefined) {
      assertEquals(
        typeof info.spec.memory.limit,
        "number",
        `${path}: spec.memory.limit must be a wire number`,
      );
    }
    if (info.spec?.cpu?.limit !== undefined) {
      assertEquals(typeof info.spec.cpu.limit, "number");
    }
  }
});

Deno.test("contract: cadvisor-docker.json — aliases, when present, is an array of wire strings", () => {
  for (const [path, info] of Object.entries(docker)) {
    if (info.aliases !== undefined) {
      assert(Array.isArray(info.aliases), `${path}: aliases must be an array`);
      for (const a of info.aliases) {
        assertEquals(
          typeof a,
          "string",
          `${path}: every alias must be a string`,
        );
      }
    }
  }
});

Deno.test("contract: cadvisor-docker.json — the postgres-db container's spec.memory.limit is the documented cAdvisor 'no limit' sentinel (9223372036854771712), and it exceeds 1e18", () => {
  const entry = Object.values(docker).find((i) =>
    i.aliases?.[0] === "postgres-db"
  )!;
  assertEquals(entry.spec?.memory?.limit, 9223372036854771712);
  assert(
    (entry.spec!.memory!.limit as number) > 1e18,
    "the sentinel value must exceed 1e18 — this is the exact boundary cadvisor.ts's memLimit guard checks",
  );
});

Deno.test("contract: cadvisor-docker.json — includes an EMPTY (but present) aliases array on one container (documented empty-aliases case)", () => {
  const entry = docker[
    "/docker/3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc"
  ];
  assert(entry, "the empty-aliases fixture container must exist");
  assertEquals(entry.aliases, []);
});

Deno.test("contract: cadvisor-docker.json — includes a container with NO aliases field at all (documented path-fallback case)", () => {
  const entry = docker[
    "/docker/4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd"
  ];
  assert(entry, "the no-aliases fixture container must exist");
  assertEquals("aliases" in entry, false);
});

Deno.test("contract: cadvisor-docker.json — includes an EMPTY stats array and a container with NO stats field at all", () => {
  const emptyStats = docker[
    "/docker/5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee"
  ];
  assert(emptyStats, "the empty-stats-array fixture container must exist");
  assertEquals(emptyStats.stats, []);

  const noStats = docker[
    "/docker/6666ffff6666ffff6666ffff6666ffff6666ffff6666ffff6666ffff6666ffff"
  ];
  assert(noStats, "the missing-stats-field fixture container must exist");
  assertEquals("stats" in noStats, false);
});

// ---------------------------------------------------------------------------
// Section B — vm-query-range.json raw wire keyset + types
// (the VictoriaMetrics/Prometheus-compatible /api/v1/query_range contract)
// ---------------------------------------------------------------------------

type RawVmRange = {
  data?: { result?: Array<{ metric: { name?: string }; values: unknown[] }> };
};

const vmRange = vmRangeFixture as unknown as RawVmRange;

Deno.test("contract: vm-query-range.json — data.result[] entries have the documented {metric, values} keyset", () => {
  const results = vmRange.data?.result ?? [];
  assert(results.length > 0, "fixture must have at least one result series");
  for (const r of results) {
    assertEquals(typeof r.metric, "object");
    assert(Array.isArray(r.values), "values must be an array");
  }
});

Deno.test("contract: vm-query-range.json — every [timestamp, value] pair has a wire NUMBER timestamp and a wire STRING value (the Prometheus range-query quirk)", () => {
  const results = vmRange.data?.result ?? [];
  let sawAtLeastOnePair = false;
  for (const r of results) {
    for (const pair of r.values as [number, string][]) {
      sawAtLeastOnePair = true;
      assertEquals(
        typeof pair[0],
        "number",
        "the timestamp (index 0) must be a wire number",
      );
      assertEquals(
        typeof pair[1],
        "string",
        "the sample value (index 1) must be a wire STRING, even though it is numeric-shaped — top-memory's parseFloat(v[1]) exists because of this",
      );
    }
  }
  assert(
    sawAtLeastOnePair,
    "sanity: fixture must contain at least one sample pair",
  );
});

Deno.test("contract: vm-query-range.json — includes a series with an EMPTY values array (documented no-samples-in-window case)", () => {
  const idle = vmRange.data?.result?.find((r) =>
    r.metric.name === "idle-scraped-once"
  );
  assert(idle, "the empty-values fixture series must exist");
  assertEquals(idle.values, []);
});

// ---------------------------------------------------------------------------
// Section C — prometheus scrape-config TEXT shape (fixture-only, no execution)
// ---------------------------------------------------------------------------

Deno.test("contract: scrape-config-before.txt does not already contain a cadvisor job", () => {
  assert(!scrapeConfigBefore.includes("cadvisor"));
});

Deno.test("contract: scrape-config-after.txt == before.txt + the exact documented cadvisor job-append template", () => {
  // Mirrors cadvisor.ts's deploy() template exactly:
  //   ["", "- job_name: cadvisor", "  scrape_interval: 30s",
  //    "  static_configs:", "  - targets:", `    - ${host}:${cadvisorPort}`]
  //     .join("\n")
  // appended via `cat >> path << 'HEREDOC'\n${cadvisorJob}\nHEREDOC`, i.e. the
  // literal appended bytes are `${cadvisorJob}\n`.
  const cadvisorJob = [
    "",
    "- job_name: cadvisor",
    "  scrape_interval: 30s",
    "  static_configs:",
    "  - targets:",
    `    - ${GLOBAL_ARGS.host}:${GLOBAL_ARGS.cadvisorPort}`,
  ].join("\n");
  assertEquals(scrapeConfigAfter, scrapeConfigBefore + cadvisorJob + "\n");
  assert(scrapeConfigAfter.includes("cadvisor"));
});

// ---------------------------------------------------------------------------
// Section D — the REQUEST wire contract: exact URLs cadvisor.ts builds
// ---------------------------------------------------------------------------

Deno.test("contract: current-metrics fetches exactly http://<host>:<cadvisorPort>/api/v1.3/docker", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(dockerFixture, async (calls) => {
    await run("current-metrics", {}, ctx);
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0].url,
      "http://host.example.com:8080/api/v1.3/docker",
    );
  });
});

Deno.test("contract: top-memory fetches /api/v1/query_range with the documented query/start/end/step params", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(vmRangeFixture, async (calls) => {
    await run("top-memory", { hoursBack: 12, topN: 20 }, ctx);
    assertEquals(calls.length, 1);
    const url = new URL(calls[0].url);
    assertEquals(url.hostname, "host.example.com");
    assertEquals(url.port, "8428", "top-memory hardcodes the VM port to 8428");
    assertEquals(url.pathname, "/api/v1/query_range");
    assertEquals(
      url.searchParams.get("query"),
      'container_memory_usage_bytes{name!=""}',
    );
    assertEquals(url.searchParams.get("step"), "300");
    assert(url.searchParams.has("start"));
    assert(url.searchParams.has("end"));
  });
});
