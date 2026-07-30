/**
 * Property-based tests (fast-check) for @magistr/cadvisor.
 *
 * cadvisor.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against stubbed boundaries (fetch for
 * the HTTP side, Deno.Command for the SSH side) and reading back the written
 * resource, per the approved plan.
 *
 * Properties:
 *  (a) current-metrics — the written `containers` array is always sorted by
 *      memoryUsageMB in non-increasing order, and `totalMemoryMB` is always
 *      exactly the sum of the (already-rounded) per-container memoryUsageMB
 *      values, for any set of well-formed single-sample containers.
 *  (b) top-memory — `maxMB` is always >= `currentMB` and >= `avgMB` (a
 *      mathematical invariant: the max of a series is >= any element,
 *      including the last, and >= the arithmetic mean; `Math.round` is
 *      monotonic so this survives rounding), the written array is sorted by
 *      maxMB in non-increasing order, and `topN` always returns a PREFIX of
 *      that sorted array of length `min(topN, seriesCount)`.
 *  (c) deploy — idempotency multi-step flow: `docker run` is issued iff the
 *      container was not already reported running, and the scrape-config
 *      append + VictoriaMetrics restart are issued iff the config did not
 *      already include "cadvisor" — for every combination of the two
 *      independent boolean pre-conditions.
 *
 * cadvisor.ts is UNMODIFIED by this change; every property PINS existing,
 * already-shipped behavior.
 */
import fc from "npm:fast-check@4.8.0";
import { model } from "./cadvisor.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  host: "host.example.com",
  username: "root",
  cadvisorPort: 8080,
  vmComposeDir: "/opt/victoriametrics",
  vmComposeFile: "compose-vl-single.yml",
  vmScrapeConfig: "prometheus-vl-single.yml",
};

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

// --- HTTP boundary ----------------------------------------------------------

type Route = (req: Request) => Response | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = r(req);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unrouted ${req.url}`));
  }) as typeof globalThis.fetch;
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
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body)], fn);
}

// --- SSH boundary ------------------------------------------------------------

type CommandEnvelope = { success: boolean; stdout: string; stderr: string };
type CommandRecording = { cmd: string; args: string[] };

function withCommandStub(
  handler: (
    call: CommandRecording,
    callIndex: number,
  ) => CommandEnvelope | Promise<CommandEnvelope>,
  fn: (calls: CommandRecording[]) => Promise<void>,
) {
  const denoRecord = Deno as unknown as Record<string, unknown>;
  const original = denoRecord.Command;
  const calls: CommandRecording[] = [];
  let index = 0;
  class FakeCommand {
    #recording: CommandRecording;
    constructor(cmd: string, options: { args?: string[] }) {
      this.#recording = { cmd, args: options.args ?? [] };
    }
    output(): Promise<
      { success: boolean; stdout: Uint8Array; stderr: Uint8Array }
    > {
      calls.push(this.#recording);
      const i = index++;
      return Promise.resolve(handler(this.#recording, i)).then((r) => ({
        success: r.success,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      }));
    }
  }
  denoRecord.Command = FakeCommand;
  return fn(calls).finally(() => {
    denoRecord.Command = original;
  });
}

const OK = (stdout = ""): CommandEnvelope => ({
  success: true,
  stdout,
  stderr: "",
});

function sshCommandOf(call: CommandRecording): string {
  return call.args[call.args.length - 1];
}

function withSyncSetTimeout(fn: () => Promise<void>) {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const original = globalRecord.setTimeout;
  globalRecord.setTimeout = (
    (cb: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      cb(...args);
      return 0 as unknown as number;
    }
  ) as unknown as typeof globalThis.setTimeout;
  return fn().finally(() => {
    globalRecord.setTimeout = original;
  });
}

// ---------------------------------------------------------------------------
// (a) current-metrics — sort + total invariants
// ---------------------------------------------------------------------------

const arbByteUsage = fc.integer({
  min: 1024 * 1024,
  max: 4 * 1024 * 1024 * 1024,
});

Deno.test("property: current-metrics — containers sorted non-increasing by memoryUsageMB; totalMemoryMB == sum of (rounded) memoryUsageMB", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbByteUsage, { minLength: 1, maxLength: 12 }),
      async (usages) => {
        const dockerJson: Record<string, unknown> = {};
        usages.forEach((usage, i) => {
          dockerJson[`/docker/container${i}`] = {
            aliases: [`c${i}`],
            spec: {},
            stats: [{
              timestamp: "2026-07-01T12:00:00Z",
              memory: { usage },
              cpu: { usage: { total: 1000000000 } },
              network: {},
            }],
          };
        });
        const { ctx, written } = makeCtx();
        await withOneResponse(dockerJson, async () => {
          await run("current-metrics", {}, ctx);
        });
        const res = written.find((w) => w.spec === "current")!;
        const containers = res.payload
          .containers as Array<Record<string, unknown>>;
        for (let i = 0; i < containers.length - 1; i++) {
          if (
            (containers[i].memoryUsageMB as number) <
              (containers[i + 1].memoryUsageMB as number)
          ) return false;
        }
        const sum = containers.reduce(
          (s, c) => s + (c.memoryUsageMB as number),
          0,
        );
        return (
          res.payload.totalMemoryMB === sum &&
          res.payload.totalContainers === containers.length &&
          containers.length === usages.length
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) top-memory — maxMB >= currentMB/avgMB, sorted desc, topN is a prefix
// ---------------------------------------------------------------------------

const arbSeries = fc.array(
  fc.integer({ min: 1024 * 1024, max: 1024 * 1024 * 1024 }),
  { minLength: 1, maxLength: 8 },
);

Deno.test("property: top-memory — maxMB is always >= currentMB and >= avgMB (mathematical invariant, survives rounding)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbSeries, { minLength: 1, maxLength: 6 }),
      async (seriesList) => {
        const result = seriesList.map((series, i) => ({
          metric: { name: `series${i}` },
          values: series.map((v, idx) => [1751370000 + idx * 300, String(v)]),
        }));
        const { ctx, written } = makeCtx();
        await withOneResponse({ data: { result } }, async () => {
          await run("top-memory", { hoursBack: 12, topN: 100 }, ctx);
        });
        const res = written.find((w) => w.spec === "topMemory")!;
        const containers = res.payload
          .containers as Array<Record<string, unknown>>;
        if (containers.length !== seriesList.length) return false;
        for (const c of containers) {
          if ((c.maxMB as number) < (c.currentMB as number)) return false;
          if ((c.maxMB as number) < (c.avgMB as number)) return false;
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: top-memory — the written array is sorted by maxMB in non-increasing order", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbSeries, { minLength: 2, maxLength: 8 }),
      async (seriesList) => {
        const result = seriesList.map((series, i) => ({
          metric: { name: `series${i}` },
          values: series.map((v, idx) => [1751370000 + idx * 300, String(v)]),
        }));
        const { ctx, written } = makeCtx();
        await withOneResponse({ data: { result } }, async () => {
          await run("top-memory", { hoursBack: 12, topN: 100 }, ctx);
        });
        const res = written.find((w) => w.spec === "topMemory")!;
        const containers = res.payload
          .containers as Array<Record<string, unknown>>;
        for (let i = 0; i < containers.length - 1; i++) {
          if (
            (containers[i].maxMB as number) <
              (containers[i + 1].maxMB as number)
          ) return false;
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: top-memory — topN always returns a PREFIX of the fully-sorted array, of length min(topN, seriesCount)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbSeries, { minLength: 1, maxLength: 10 }),
      fc.integer({ min: 1, max: 12 }),
      async (seriesList, topN) => {
        const result = seriesList.map((series, i) => ({
          metric: { name: `series${i}` },
          values: series.map((v, idx) => [1751370000 + idx * 300, String(v)]),
        }));

        const { ctx: fullCtx, written: fullWritten } = makeCtx();
        await withOneResponse({ data: { result } }, async () => {
          await run("top-memory", { hoursBack: 12, topN: 1000 }, fullCtx);
        });
        const fullNames = (fullWritten.find((w) => w.spec === "topMemory")!
          .payload.containers as Array<Record<string, unknown>>).map((c) =>
            c.name
          );

        const { ctx: slicedCtx, written: slicedWritten } = makeCtx();
        await withOneResponse({ data: { result } }, async () => {
          await run("top-memory", { hoursBack: 12, topN }, slicedCtx);
        });
        const sliced = slicedWritten.find((w) => w.spec === "topMemory")!
          .payload.containers as Array<Record<string, unknown>>;

        const expectedLength = Math.min(topN, seriesList.length);
        if (sliced.length !== expectedLength) return false;
        return sliced.every((c, i) => c.name === fullNames[i]);
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) deploy — idempotency multi-step flow over the two independent booleans
// ---------------------------------------------------------------------------

Deno.test("property: deploy — docker run fires iff NOT already running; append+restart fire iff scrape NOT already configured; and the WRITTEN status resource always reflects running:true/scrapeConfigured:true regardless of which path was taken", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.boolean(),
      async (alreadyRunning, alreadyConfigured) => {
        const { ctx, written } = makeCtx();
        let recorded: CommandRecording[] = [];
        // Track the scrape-config state so the stub's `cat` response
        // reflects reality AFTER the heredoc append "happens" — otherwise a
        // stub that unconditionally echoes the pre-deploy state would make
        // the post-deploy scrapeConfigured assertion below meaningless for
        // the alreadyConfigured=false case (the config only becomes
        // configured partway through the real call sequence).
        let configured = alreadyConfigured;
        await withSyncSetTimeout(() =>
          withCommandStub(
            (call, i) => {
              const cmd = sshCommandOf(call);
              if (i === 0) return OK(alreadyRunning ? "true\n" : "false\n");
              if (cmd === "docker rm cadvisor 2>/dev/null || true") return OK();
              if (cmd.startsWith("docker run -d")) return OK();
              // The heredoc-append command ALSO starts with "cat " (it is
              // literally `cat >> <path> << 'HEREDOC'...`), so the more
              // specific HEREDOC/compose checks must come BEFORE the plain
              // `cat <path>` read check — otherwise the append call is
              // misrouted to the read-handler branch below.
              if (cmd.includes("<< 'HEREDOC'")) {
                configured = true;
                return OK();
              }
              if (cmd.includes("docker compose")) return OK();
              if (cmd.startsWith("cat ")) {
                return OK(
                  configured
                    ? "- job_name: cadvisor\n"
                    : "no scrape job configured\n",
                );
              }
              if (cmd.startsWith("docker inspect")) return OK("running\n");
              return OK("");
            },
            async (calls) => {
              await run("deploy", {}, ctx);
              recorded = calls;
            },
          )
        );
        const dockerRunCalls =
          recorded.filter((c) => sshCommandOf(c).startsWith("docker run -d"))
            .length;
        const appendCalls =
          recorded.filter((c) => sshCommandOf(c).includes("<< 'HEREDOC'"))
            .length;
        const restartCalls =
          recorded.filter((c) => sshCommandOf(c).includes("docker compose"))
            .length;
        const expectedRun = alreadyRunning ? 0 : 1;
        const expectedAppend = alreadyConfigured ? 0 : 1;

        const status = written.find((w) => w.spec === "status");
        if (!status) return false;

        return (
          dockerRunCalls === expectedRun &&
          appendCalls === expectedAppend &&
          restartCalls === expectedAppend &&
          status.payload.running === true &&
          status.payload.containerStatus === "running" &&
          status.payload.scrapeConfigured === true
        );
      },
    ),
    { numRuns: NIGHT(50) },
  );
});
