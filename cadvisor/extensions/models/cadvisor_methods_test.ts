/**
 * Method-level tests for @magistr/cadvisor — every one of the 5 methods
 * (deploy, status, current-metrics, top-memory, remove), happy path + error
 * path, driven through `model.methods.<m>.arguments.parse()` + `.execute()`
 * against BOTH stubbed boundaries: `Deno.Command("ssh", ...)` (via the
 * talos-node `Deno as unknown as Record<string, unknown>` FakeCommand bridge)
 * and `globalThis.fetch` (via the porkbun fetch-stub pattern) — plus a
 * neutralized `setTimeout` for deploy's 5-second verify delay.
 *
 * cadvisor.ts now wraps vmComposeDir/vmComposeFile/vmScrapeConfig-derived
 * remote command strings in `shellEsc` (2026.08.01.1, closing the HIGH
 * remote-shell command-injection finding in `cadvisor-latent-bugs`) — every
 * exact-string assertion and `cat`-equality stub matcher below is
 * re-baselined to the single-quote-wrapped, legit metacharacter-free form.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./cadvisor.ts";
import dockerFixture from "../../fixtures/cadvisor-docker.json" with {
  type: "json",
};
import vmRangeFixture from "../../fixtures/vm-query-range.json" with {
  type: "json",
};

const FIXTURES_DIR = new URL("../../fixtures/", import.meta.url);
async function readFixtureText(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIXTURES_DIR));
}
const SCRAPE_CONFIG_BEFORE = await readFixtureText("scrape-config-before.txt");
const SCRAPE_CONFIG_AFTER = await readFixtureText("scrape-config-after.txt");

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

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};
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

// --- SSH boundary: Deno.Command FakeCommand bridge (talos-node pattern) ----

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
const FAIL = (stderr: string): CommandEnvelope => ({
  success: false,
  stdout: "",
  stderr,
});

/** runSsh() always builds args as [...flags, `${username}@${host}`, command]
 * — the command string is always the LAST argv element. */
function sshCommandOf(call: CommandRecording): string {
  return call.args[call.args.length - 1];
}

// --- HTTP boundary: fetch stub (porkbun pattern) ---------------------------

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

// --- setTimeout neutralization (talos-node pattern) — deploy's 5s verify --

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
// deploy
// ---------------------------------------------------------------------------

const DOCKER_RUN_CMD = [
  "docker run -d",
  "--name=cadvisor",
  "--restart=always",
  "--publish=8080:8080",
  "--volume=/:/rootfs:ro",
  "--volume=/var/run:/var/run:ro",
  "--volume=/sys:/sys:ro",
  "--volume=/var/lib/docker/:/var/lib/docker:ro",
  "--volume=/dev/disk/:/dev/disk:ro",
  "--privileged",
  "--device=/dev/kmsg",
  "gcr.io/cadvisor/cadvisor:v0.51.0",
].join(" ");

Deno.test("deploy: happy path (not running, scrape not yet configured) — full 7-call SSH sequence, writes running/scrapeConfigured status", async () => {
  const { ctx, written } = makeCtx();
  await withSyncSetTimeout(() =>
    withCommandStub(
      (call, i) => {
        const cmd = sshCommandOf(call);
        if (i === 0) return FAIL("Error: No such container: cadvisor");
        if (cmd === DOCKER_RUN_CMD) return OK();
        if (cmd === "cat '/opt/victoriametrics/prometheus-vl-single.yml'") {
          // First cat (before append) then second cat (final verify) —
          // routed by call order via the shared counter.
          return i === 2 ? OK(SCRAPE_CONFIG_BEFORE) : OK(SCRAPE_CONFIG_AFTER);
        }
        if (cmd.includes("<< 'HEREDOC'")) return OK();
        if (cmd.includes("docker compose")) return OK();
        if (cmd === "docker inspect cadvisor --format '{{.State.Status}}'") {
          return OK("running\n");
        }
        throw new Error(`unrouted ssh command: ${cmd}`);
      },
      async (calls) => {
        await run("deploy", {}, ctx);
        assertEquals(
          calls.length,
          7,
          "not-running + not-configured is 7 ssh calls",
        );
        assertEquals(
          sshCommandOf(calls[0]),
          "docker inspect cadvisor --format '{{.State.Running}}' 2>/dev/null",
        );
        assertEquals(sshCommandOf(calls[1]), DOCKER_RUN_CMD);
        assertEquals(
          sshCommandOf(calls[2]),
          "cat '/opt/victoriametrics/prometheus-vl-single.yml'",
        );
        assertEquals(
          sshCommandOf(calls[3]),
          "cat >> '/opt/victoriametrics/prometheus-vl-single.yml' << 'HEREDOC'\n" +
            "\n- job_name: cadvisor\n  scrape_interval: 30s\n  static_configs:\n" +
            "  - targets:\n    - host.example.com:8080\nHEREDOC",
        );
        assertEquals(
          sshCommandOf(calls[4]),
          "cd '/opt/victoriametrics' && docker compose -f 'compose-vl-single.yml' restart victoriametrics",
        );
        assertEquals(
          sshCommandOf(calls[5]),
          "docker inspect cadvisor --format '{{.State.Status}}'",
        );
        assertEquals(
          sshCommandOf(calls[6]),
          "cat '/opt/victoriametrics/prometheus-vl-single.yml'",
        );
      },
    )
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.name, "current");
  assertEquals(res.payload.running, true);
  assertEquals(res.payload.containerStatus, "running");
  assertEquals(res.payload.port, 8080);
  assertEquals(res.payload.scrapeConfigured, true);
});

Deno.test("deploy: idempotent short-circuit — already running + already scrape-configured skips docker run, append, and VM restart (4-call sequence)", async () => {
  const { ctx, written } = makeCtx();
  await withSyncSetTimeout(() =>
    withCommandStub(
      (call, i) => {
        const cmd = sshCommandOf(call);
        if (i === 0) return OK("true\n"); // docker inspect Running
        if (cmd === "cat '/opt/victoriametrics/prometheus-vl-single.yml'") {
          return OK(SCRAPE_CONFIG_AFTER); // already configured
        }
        if (cmd === "docker inspect cadvisor --format '{{.State.Status}}'") {
          return OK("running\n");
        }
        throw new Error(`unrouted ssh command: ${cmd}`);
      },
      async (calls) => {
        await run("deploy", {}, ctx);
        assertEquals(
          calls.length,
          4,
          "already-running + already-configured is 4 ssh calls",
        );
        assertEquals(
          sshCommandOf(calls[0]),
          "docker inspect cadvisor --format '{{.State.Running}}' 2>/dev/null",
        );
        assert(
          !calls.some((c) => sshCommandOf(c) === DOCKER_RUN_CMD),
          "docker run must NOT be issued when already running",
        );
        assert(
          !calls.some((c) => sshCommandOf(c).includes("<< 'HEREDOC'")),
          "the scrape-config append must NOT run when already configured",
        );
        assert(
          !calls.some((c) => sshCommandOf(c).includes("docker compose")),
          "the VictoriaMetrics restart must NOT run when already configured",
        );
      },
    )
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.running, true);
  assertEquals(res.payload.scrapeConfigured, true);
});

Deno.test("deploy: stopped-container cleanup — Running check succeeds with 'false' -> removes the stopped container before re-running", async () => {
  const { ctx } = makeCtx();
  await withSyncSetTimeout(() =>
    withCommandStub(
      (call, i) => {
        const cmd = sshCommandOf(call);
        if (i === 0) return OK("false\n");
        if (i === 1) {
          assertEquals(cmd, "docker rm cadvisor 2>/dev/null || true");
          return OK();
        }
        if (cmd === DOCKER_RUN_CMD) return OK();
        if (cmd === "cat '/opt/victoriametrics/prometheus-vl-single.yml'") {
          return OK(SCRAPE_CONFIG_AFTER);
        }
        if (cmd === "docker inspect cadvisor --format '{{.State.Status}}'") {
          return OK("running\n");
        }
        throw new Error(`unrouted ssh command: ${cmd}`);
      },
      async (calls) => {
        await run("deploy", {}, ctx);
        assertEquals(
          sshCommandOf(calls[1]),
          "docker rm cadvisor 2>/dev/null || true",
        );
        assertEquals(sshCommandOf(calls[2]), DOCKER_RUN_CMD);
      },
    )
  );
});

Deno.test("deploy: error path — docker run itself failing propagates (NOT caught)", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    (_call, i) => {
      if (i === 0) return FAIL("no such container");
      return FAIL("permission denied while trying to connect to Docker daemon");
    },
    async () => {
      await assertRejects(
        () => run("deploy", {}, ctx),
        Error,
        "SSH failed: permission denied while trying to connect to Docker daemon",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

Deno.test("status: happy path — running + scrape configured", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    (call) => {
      const cmd = sshCommandOf(call);
      if (cmd === "docker inspect cadvisor --format '{{.State.Status}}'") {
        return OK("running\n");
      }
      if (cmd === "cat '/opt/victoriametrics/prometheus-vl-single.yml'") {
        return OK(SCRAPE_CONFIG_AFTER);
      }
      throw new Error(`unrouted: ${cmd}`);
    },
    async (calls) => {
      await run("status", {}, ctx);
      assertEquals(calls.length, 2);
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.running, true);
  assertEquals(res.payload.containerStatus, "running");
  assertEquals(res.payload.port, 8080);
  assertEquals(res.payload.scrapeConfigured, true);
});

Deno.test("status: container not found + scrape config unreadable — both catches fire, no throw", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    () => FAIL("no such container / no such file"),
    async () => {
      await run("status", {}, ctx); // must not throw
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.running, false);
  assertEquals(res.payload.containerStatus, "not found");
  assertEquals(res.payload.scrapeConfigured, false);
});

Deno.test("status: mixed case — docker inspect SUCCEEDS while cat FAILS (each try/catch is independent)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    (call) => {
      const cmd = sshCommandOf(call);
      if (cmd.startsWith("docker inspect")) return OK("running\n");
      return FAIL("no such file");
    },
    async () => {
      await run("status", {}, ctx); // must not throw
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.running, true);
  assertEquals(res.payload.containerStatus, "running");
  assertEquals(res.payload.scrapeConfigured, false);
});

Deno.test("status: mixed case — docker inspect FAILS while cat SUCCEEDS (each try/catch is independent)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    (call) => {
      const cmd = sshCommandOf(call);
      if (cmd.startsWith("docker inspect")) return FAIL("no such container");
      return OK(SCRAPE_CONFIG_AFTER);
    },
    async () => {
      await run("status", {}, ctx); // must not throw
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.running, false);
  assertEquals(res.payload.containerStatus, "not found");
  assertEquals(res.payload.scrapeConfigured, true);
});

// ---------------------------------------------------------------------------
// current-metrics
// ---------------------------------------------------------------------------

Deno.test("current-metrics: happy path — full transform pinned against cadvisor-docker.json (bytes->MB, cpu%, network rates, sort, totals)", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(dockerFixture, 200, async (calls) => {
    await run("current-metrics", {}, ctx);
    assertEquals(calls.length, 1);
  });
  const res = written.find((w) => w.spec === "current")!;
  const containers = res.payload.containers as Array<Record<string, unknown>>;

  // Sorted desc by memoryUsageMB: postgres-db(250) > web-frontend(150) >
  // unknown(128, empty-aliases bug) > <hash>(64, no-aliases fallback).
  assertEquals(containers.map((c) => c.name), [
    "postgres-db",
    "web-frontend",
    "unknown",
    "4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd",
  ]);

  const postgres = containers[0];
  assertEquals(postgres.memoryUsageMB, 250);
  assertEquals(
    postgres.memoryLimitMB,
    0,
    "the >1e18 no-limit sentinel yields 0, not a huge MB value",
  );
  assertEquals(postgres.memoryPercent, 0);
  assertEquals(postgres.cpuPercent, 50);
  assertEquals(postgres.networkRxMBps, 0.1);
  assertEquals(postgres.networkTxMBps, 0.03);

  const web = containers[1];
  assertEquals(web.memoryUsageMB, 150);
  assertEquals(web.memoryLimitMB, 512);
  assertEquals(web.memoryPercent, 29.3);
  assertEquals(web.cpuPercent, 100);
  assertEquals(web.networkRxMBps, 1);
  assertEquals(web.networkTxMBps, 0.5);

  const emptyAliases = containers[2];
  assertEquals(emptyAliases.memoryUsageMB, 128);
  assertEquals(emptyAliases.cpuPercent, 0, "no previous stat -> cpuPercent 0");
  assertEquals(emptyAliases.networkRxMBps, 0);
  assertEquals(emptyAliases.networkTxMBps, 0);

  const noAliases = containers[3];
  assertEquals(noAliases.memoryUsageMB, 64);

  assertEquals(res.payload.totalMemoryMB, 592);
  assertEquals(
    res.payload.totalContainers,
    4,
    "empty-stats and missing-stats containers are excluded",
  );
});

Deno.test("current-metrics: error path — non-ok response throws 'cAdvisor API failed: <status>'", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 503, async () => {
    await assertRejects(
      () => run("current-metrics", {}, ctx),
      Error,
      "cAdvisor API failed: 503",
    );
  });
});

// ---------------------------------------------------------------------------
// top-memory
// ---------------------------------------------------------------------------

Deno.test("top-memory: happy path — current/max/avg/growth pinned against vm-query-range.json, sorted by maxMB desc", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(vmRangeFixture, 200, async () => {
    await run("top-memory", { hoursBack: 12, topN: 20 }, ctx);
  });
  const res = written.find((w) => w.spec === "topMemory")!;
  const containers = res.payload.containers as Array<Record<string, unknown>>;

  // idle-scraped-once (empty values) is excluded; sorted desc by maxMB.
  assertEquals(containers.map((c) => c.name), ["postgres-db", "web-frontend"]);

  const postgres = containers[0];
  assertEquals(postgres.currentMB, 225);
  assertEquals(postgres.maxMB, 250);
  assertEquals(postgres.avgMB, 225);
  assertEquals(postgres.growthMB, 25);
  assertEquals(postgres.growthPercent, 12.5);

  const web = containers[1];
  assertEquals(web.currentMB, 180);
  assertEquals(web.maxMB, 180);
  assertEquals(web.avgMB, 143);
  assertEquals(web.growthMB, 80);
  assertEquals(web.growthPercent, 80);

  assertEquals(res.payload.hoursBack, 12);
});

Deno.test("top-memory: topN slices the sorted result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(vmRangeFixture, 200, async () => {
    await run("top-memory", { hoursBack: 12, topN: 1 }, ctx);
  });
  const res = written.find((w) => w.spec === "topMemory")!;
  const containers = res.payload.containers as Array<Record<string, unknown>>;
  assertEquals(containers.length, 1);
  assertEquals(containers[0].name, "postgres-db");
});

Deno.test("top-memory: error path — non-ok response throws 'VM query failed: <status> <body>'", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("internal error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      })],
    async () => {
      await assertRejects(
        () => run("top-memory", {}, ctx),
        Error,
        "VM query failed: 500 internal error",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

Deno.test("remove: happy path — exactly 3 unconditional SSH calls (stop/rm, sed teardown, VM restart), writes removed status", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    () => OK(),
    async (calls) => {
      await run("remove", {}, ctx);
      assertEquals(calls.length, 3);
      assertEquals(
        sshCommandOf(calls[0]),
        "docker stop cadvisor 2>/dev/null; docker rm cadvisor 2>/dev/null || true",
      );
      assertEquals(
        sshCommandOf(calls[1]),
        "sed -i '/cadvisor/,/- .*:8080/{//d;d}' '/opt/victoriametrics/prometheus-vl-single.yml' 2>/dev/null; " +
          "sed -i '/cadvisor/d' '/opt/victoriametrics/prometheus-vl-single.yml' 2>/dev/null; " +
          "sed -i '/^$/N;/^\\n$/d' '/opt/victoriametrics/prometheus-vl-single.yml' 2>/dev/null || true",
      );
      assertEquals(
        sshCommandOf(calls[2]),
        "cd '/opt/victoriametrics' && docker compose -f 'compose-vl-single.yml' restart victoriametrics",
      );
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload.running, false);
  assertEquals(res.payload.containerStatus, "removed");
  assertEquals(res.payload.port, 0);
  assertEquals(res.payload.scrapeConfigured, false);
});

Deno.test("remove: error path — a failing command propagates (NOT caught); no status resource is ever written", async () => {
  // None of remove()'s three runSsh calls are wrapped in try/catch (unlike
  // status()'s independently-guarded calls, or deploy()'s guarded verify
  // step). A failure at ANY of the three stages throws immediately and
  // leaves NO record at all — not even a partial/failed status resource.
  // This differs from deploy(), which always writes a status resource even
  // when its post-verify checks fail.
  for (const failAt of [0, 1, 2]) {
    const { ctx, written } = makeCtx();
    await withCommandStub(
      (_call, i) => i === failAt ? FAIL("permission denied") : OK(),
      async (calls) => {
        await assertRejects(
          () => run("remove", {}, ctx),
          Error,
          "SSH failed: permission denied",
        );
        assertEquals(calls.length, failAt + 1, "no call after the failure");
      },
    );
    assertEquals(
      written.length,
      0,
      `failure at call ${failAt} must leave no written resource`,
    );
  }
});

// ---------------------------------------------------------------------------
// Cross-method: no method calls the logger today
// ---------------------------------------------------------------------------

Deno.test("pin: no method calls the logger at all today (a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneResponse(dockerFixture, 200, async () => {
    await run("current-metrics", {}, ctx);
  });
  await withCommandStub(() => OK(), async () => {
    await run("remove", {}, ctx);
  });
  assertEquals(logs.length, 0);
});
