/**
 * Coverage suite: regression guards for the specific branches named in the
 * approved plan — the memLimit `>0 && <1e18` sentinel guard (both sides),
 * deploy's alreadyRunning idempotency short-circuit, the
 * `scrapeConfigured`/`currentConfig.includes("cadvisor")` guard (both sides),
 * top-memory's `first > 0` growthPct guard, and cpuPercent's unused
 * `_numCores` (bug #3 in cadvisor-latent-bugs) — pinned so cpuPercent stays
 * IDENTICAL regardless of core count, catching either a deletion of this
 * guard's surrounding logic or an accidental "fix" that starts normalizing.
 *
 * cadvisor.ts is UNMODIFIED; every test here PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./cadvisor.ts";

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

type CommandEnvelope = { success: boolean; stdout: string; stderr: string };
type CommandRecording = { cmd: string; args: string[] };

function withCommandStub(
  handler: (
    call: CommandRecording,
    callIndex: number,
  ) => CommandEnvelope | Promise<CommandEnvelope>,
  fn: (calls: CommandRecording[]) => Promise<unknown>,
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

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
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
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

function withSyncSetTimeout(fn: () => Promise<unknown>) {
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
// Guard: memLimit `memLimit > 0 && memLimit < 1e18` — BOTH sides
// ---------------------------------------------------------------------------

function containerWithLimit(limit: number | undefined) {
  return {
    "/docker/guardcase": {
      aliases: ["guard-case"],
      spec: limit === undefined ? {} : { memory: { limit } },
      stats: [{
        timestamp: "2026-07-01T12:00:00Z",
        memory: { usage: 1048576 },
        cpu: { usage: { total: 1000000000 } },
        network: {},
      }],
    },
  };
}

Deno.test("guard memLimit: limit=0 fails the '>0' side -> memoryLimitMB and memoryPercent both 0 (no division by zero)", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(containerWithLimit(0), 200, async () => {
    await run("current-metrics", {}, ctx);
  });
  const c = (written.find((w) => w.spec === "current")!.payload
    .containers as Array<Record<string, unknown>>)[0];
  assertEquals(c.memoryLimitMB, 0);
  assertEquals(c.memoryPercent, 0);
});

Deno.test("guard memLimit: limit ABSENT (spec.memory.limit undefined -> `|| 0`) also fails the '>0' side -> 0/0", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(containerWithLimit(undefined), 200, async () => {
    await run("current-metrics", {}, ctx);
  });
  const c = (written.find((w) => w.spec === "current")!.payload
    .containers as Array<Record<string, unknown>>)[0];
  assertEquals(c.memoryLimitMB, 0);
  assertEquals(c.memoryPercent, 0);
});

Deno.test("guard memLimit: a NORMAL positive limit under 1e18 passes both sides -> real MB/percent are computed", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(containerWithLimit(209715200), 200, async () => {
    await run("current-metrics", {}, ctx);
  });
  const c = (written.find((w) => w.spec === "current")!.payload
    .containers as Array<Record<string, unknown>>)[0];
  assertEquals(c.memoryLimitMB, 200);
  assertEquals(c.memoryPercent, 0.5, "1MB usage / 200MB limit * 100 = 0.5%");
});

// ---------------------------------------------------------------------------
// Guard: deploy's alreadyRunning idempotency short-circuit
// ---------------------------------------------------------------------------

Deno.test("guard deploy: docker inspect Running == 'true' -> docker run is NEVER issued", async () => {
  const { ctx } = makeCtx();
  await withSyncSetTimeout(() =>
    withCommandStub(
      (call, i) => {
        const cmd = sshCommandOf(call);
        if (i === 0) return OK("true\n");
        // The heredoc-append command also starts with "cat " (`cat >> ...`),
        // so the specific checks must come before the plain-read `cat` one.
        if (cmd.includes("<< 'HEREDOC'")) return OK();
        if (cmd.includes("docker compose")) return OK();
        if (cmd.startsWith("cat ")) return OK("some-other-job-only\n");
        if (cmd.startsWith("docker inspect")) return OK("running\n");
        return OK("");
      },
      async (calls) => {
        await run("deploy", {}, ctx);
        assert(
          !calls.some((c) => sshCommandOf(c).startsWith("docker run -d")),
          "already-running must short-circuit docker run entirely",
        );
      },
    )
  );
});

Deno.test("guard deploy: docker inspect Running == anything other than the exact string 'true' (e.g. 'false', 'unknown') takes the else (cleanup) branch", async () => {
  for (const value of ["false\n", "unknown\n", "TRUE\n", "\n"]) {
    const { ctx } = makeCtx();
    await withSyncSetTimeout(() =>
      withCommandStub(
        (call, i) => {
          const cmd = sshCommandOf(call);
          if (i === 0) return OK(value);
          if (i === 1) {
            assertEquals(
              cmd,
              "docker rm cadvisor 2>/dev/null || true",
              `value ${
                JSON.stringify(value)
              } must take the else-branch cleanup`,
            );
            return OK();
          }
          if (cmd.startsWith("docker run")) return OK();
          if (cmd.startsWith("cat ")) return OK("cadvisor already here\n");
          if (cmd.startsWith("docker inspect")) return OK("running\n");
          return OK("");
        },
        async () => {
          await run("deploy", {}, ctx);
        },
      )
    );
  }
});

// ---------------------------------------------------------------------------
// Guard: `currentConfig.includes("cadvisor")` — BOTH sides
// ---------------------------------------------------------------------------

Deno.test("guard scrapeConfigured: config WITHOUT 'cadvisor' triggers the append + VM restart", async () => {
  const { ctx } = makeCtx();
  await withSyncSetTimeout(() =>
    withCommandStub(
      (call, i) => {
        const cmd = sshCommandOf(call);
        if (i === 0) return OK("true\n");
        // The heredoc-append command also starts with "cat " (`cat >> ...`),
        // so the specific checks must come before the plain-read `cat` one.
        if (cmd.includes("<< 'HEREDOC'")) return OK();
        if (cmd.includes("docker compose")) return OK();
        if (cmd.startsWith("cat ")) {
          return i === 1
            ? OK("unrelated: config\n")
            : OK("unrelated: config\n- job_name: cadvisor\n");
        }
        if (cmd.startsWith("docker inspect")) return OK("running\n");
        return OK("");
      },
      async (calls) => {
        await run("deploy", {}, ctx);
        assert(calls.some((c) => sshCommandOf(c).includes("<< 'HEREDOC'")));
        assert(calls.some((c) => sshCommandOf(c).includes("docker compose")));
      },
    )
  );
});

Deno.test("guard scrapeConfigured: config that ALREADY includes 'cadvisor' skips both the append and the VM restart", async () => {
  const { ctx } = makeCtx();
  await withSyncSetTimeout(() =>
    withCommandStub(
      (call, i) => {
        const cmd = sshCommandOf(call);
        if (i === 0) return OK("true\n");
        if (cmd.startsWith("cat ")) return OK("- job_name: cadvisor\n");
        if (cmd.startsWith("docker inspect")) return OK("running\n");
        return OK("");
      },
      async (calls) => {
        await run("deploy", {}, ctx);
        assert(!calls.some((c) => sshCommandOf(c).includes("<< 'HEREDOC'")));
        assert(!calls.some((c) => sshCommandOf(c).includes("docker compose")));
      },
    )
  );
});

// ---------------------------------------------------------------------------
// Guard: top-memory's `first > 0 ? ... : 0` growthPct branch
// ---------------------------------------------------------------------------

Deno.test("guard top-memory: growthPercent's TRUE branch (first > 0) is exercised and computes exactly (growth/first)*100 for a minimal series", async () => {
  const { ctx, written } = makeCtx();
  const hostile = {
    data: {
      result: [{
        metric: { name: "min-series" },
        values: [[1751370000, "1048576"], [1751370300, "2097152"]],
      }],
    },
  };
  await withOneResponse(hostile, 200, async () => {
    await run("top-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "topMemory")!;
  const c = (res.payload.containers as Array<Record<string, unknown>>)[0];
  // first=1MB, last=2MB -> growth=1MB, growthPercent=(1/1)*100=100
  assertEquals(c.growthPercent, 100);
});

Deno.test("guard top-memory: a single-sample series has first===last -> growth=0, growthPercent=0 (the TRUE branch, 0/first*100)", async () => {
  // Note: the `:0` fallback of `first > 0 ? ... : 0` is structurally
  // unreachable given the upstream `.filter(v => v > 0)` — `first` is always
  // an element that PASSED that filter, so it can never be <= 0 here. This
  // test documents that the guard's true branch is what always executes,
  // rather than asserting an unreachable fallback.
  const { ctx, written } = makeCtx();
  const hostile = {
    data: {
      result: [{
        metric: { name: "single-sample" },
        values: [[1751370000, "1048576"]],
      }],
    },
  };
  await withOneResponse(hostile, 200, async () => {
    await run("top-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "topMemory")!;
  const c = (res.payload.containers as Array<Record<string, unknown>>)[0];
  assertEquals(c.growthMB, 0);
  assertEquals(c.growthPercent, 0);
});

// ---------------------------------------------------------------------------
// Guard: cpuPercent's unused `_numCores` — bug #3 in cadvisor-latent-bugs.
// Pinned as a regression guard: cpuPercent must stay IDENTICAL across
// different core counts, since the computed `_numCores` variable is
// currently discarded. If a future change starts using it, this test goes
// red — which is the intended signal to update cadvisor-latent-bugs.
// ---------------------------------------------------------------------------

function twoStatContainer(coreLimit: number, perCoreLen: number) {
  const perCpuUsage = Array.from({ length: perCoreLen }, () => 50000000000);
  return {
    "/docker/corecase": {
      aliases: ["core-case"],
      spec: { memory: { limit: 1073741824 }, cpu: { limit: coreLimit } },
      stats: [
        {
          timestamp: "2026-07-01T12:00:00Z",
          memory: { usage: 104857600 },
          cpu: { usage: { total: 100000000000, per_cpu_usage: perCpuUsage } },
          network: {},
        },
        {
          timestamp: "2026-07-01T12:00:30Z",
          memory: { usage: 104857600 },
          cpu: { usage: { total: 130000000000, per_cpu_usage: perCpuUsage } },
          network: {},
        },
      ],
    },
  };
}

Deno.test("guard cpuPercent: identical cpu deltas produce the IDENTICAL cpuPercent regardless of spec.cpu.limit (1 core vs 16 cores)", async () => {
  const oneCore = twoStatContainer(1, 1);
  const sixteenCores = twoStatContainer(16, 16);

  const { ctx: ctx1, written: written1 } = makeCtx();
  await withOneResponse(oneCore, 200, async () => {
    await run("current-metrics", {}, ctx1);
  });
  const { ctx: ctx2, written: written2 } = makeCtx();
  await withOneResponse(sixteenCores, 200, async () => {
    await run("current-metrics", {}, ctx2);
  });

  const c1 = (written1.find((w) => w.spec === "current")!.payload
    .containers as Array<Record<string, unknown>>)[0];
  const c2 = (written2.find((w) => w.spec === "current")!.payload
    .containers as Array<Record<string, unknown>>)[0];
  assertEquals(
    c1.cpuPercent,
    c2.cpuPercent,
    "cpuPercent must be identical across core counts — _numCores is computed but never applied (bug #3)",
  );
  assertEquals(
    c1.cpuPercent,
    100,
    "sanity: 30e9ns delta / 30000ms = 100% host-relative",
  );
});
