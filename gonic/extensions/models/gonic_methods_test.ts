/**
 * Method-level tests for @magistr/gonic — every one of the 12 methods (9
 * Subsonic-REST fetch methods + 3 SSH/subprocess methods), happy path + error
 * path, driven through `model.methods.<m>.arguments.parse()` + `.execute()`
 * against a stubbed `globalThis.fetch` (the 9 Subsonic methods) and a stubbed
 * `Deno.Command` (the 3 SSH methods: `db-query`, `db-exec`,
 * `ensure-podcast-dirs`).
 *
 * gonic.ts is BYTE-FROZEN by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Toolchain rules (deno 2.8.3 in CI):
 *  - fetch seam: `as unknown as typeof globalThis.fetch` (double-bridge,
 *    never the bare `as typeof globalThis.fetch`).
 *  - Deno.Command seam: `FakeCommand as unknown as typeof Deno.Command`,
 *    reassigned directly onto `Deno.Command` (probed reassignable). The fake
 *    models BOTH the `.output()` shape (`sshCommand`'s docker-inspect/mkdir)
 *    and the `.spawn()` + `stdin.getWriter()` shape (`sshExecSql`'s
 *    `sqlite3 -json`), routing a canned `{success,stdout,stderr}` per
 *    invocation by matching the composed command line AND/OR the stdin SQL
 *    text (db-exec's write and its `SELECT changes()` follow-up share an
 *    IDENTICAL command line — only the stdin text tells them apart).
 *
 * Credential-leak assertions run after every fetch-method happy path: the raw
 * password and its enc-hex encoding must never appear in a written resource
 * payload, and the logger must never be called by any method.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./gonic.ts";
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HOST = "gonic.example.com";
const PORT = 4747;
const USERNAME = "listener";
const PASSWORD = "fixture-only-not-a-real-password-000";
const GLOBAL_ARGS = {
  host: HOST,
  port: PORT,
  username: USERNAME,
  password: PASSWORD,
  sshUser: "root",
  dbPath: "/data/gonic.db",
};

function hexEncode(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
const PASSWORD_HEX = hexEncode(PASSWORD);

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx() {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
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
      logger: {
        info: (...args: unknown[]) => logs.push({ level: "info", args }),
        warning: (...args: unknown[]) => logs.push({ level: "warning", args }),
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

/** Assert no method ever leaks the raw password or its enc-hex encoding into
 * a written resource, and never calls the logger. */
function assertNoCredentialLeak(written: Written[], logs: LogCall[]) {
  const blob = JSON.stringify(written);
  assert(
    !blob.includes(PASSWORD),
    "raw password must never appear in a written resource payload",
  );
  assert(
    !blob.includes(PASSWORD_HEX),
    "enc-hex password must never appear in a written resource payload",
  );
  assertEquals(logs.length, 0, "logger must never be called by any method");
}

function assertAuthParams(url: URL, extra: Record<string, string> = {}) {
  assertEquals(url.searchParams.get("u"), USERNAME);
  assertEquals(url.searchParams.get("p"), `enc:${PASSWORD_HEX}`);
  assertEquals(url.searchParams.get("v"), "1.15.0");
  assertEquals(url.searchParams.get("c"), "swamp");
  assertEquals(url.searchParams.get("f"), "json");
  for (const [k, v] of Object.entries(extra)) {
    assertEquals(url.searchParams.get(k), v, `expected ${k}=${v}`);
  }
}

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request.
 * Double-bridge cast per the toolchain rule above. */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function restRoute(endpoint: string, body: unknown, status = 200): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname !== `/rest/${endpoint}`) return undefined;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function okEnvelope(extra: Record<string, unknown> = {}) {
  return {
    "subsonic-response": { status: "ok", version: "1.16.1", ...extra },
  };
}

/** Run `endpoint` through a single-route fixture and return the captured
 * request. */
async function withOneEndpoint(
  endpoint: string,
  body: unknown,
  fn: (calls: Request[]) => Promise<unknown>,
) {
  await withFetchStub([restRoute(endpoint, body)], fn);
}

// ---------------------------------------------------------------------------
// Deno.Command dual-shape stub (db-query, db-exec, ensure-podcast-dirs)
// ---------------------------------------------------------------------------

type CommandResult = { success: boolean; stdout: string; stderr: string };
type CommandInvocation = { commandLine: string; stdin: string };
type CommandRouter = (inv: CommandInvocation) => CommandResult;

function installCommandStub(router: CommandRouter) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const invocations: CommandInvocation[] = [];
  const constructions: string[] = [];

  class FakeCommand {
    #commandLine: string;
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      const args = options.args ?? [];
      this.#commandLine = args[args.length - 1] ?? "";
      constructions.push(this.#commandLine);
    }
    output() {
      const inv: CommandInvocation = {
        commandLine: this.#commandLine,
        stdin: "",
      };
      invocations.push(inv);
      const r = router(inv);
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        stdout: encoder.encode(r.stdout),
        stderr: encoder.encode(r.stderr),
      });
    }
    spawn() {
      const commandLine = this.#commandLine;
      let written = "";
      return {
        stdin: {
          getWriter: () => ({
            write: (bytes: Uint8Array) => {
              written += decoder.decode(bytes);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          const inv: CommandInvocation = { commandLine, stdin: written };
          invocations.push(inv);
          const r = router(inv);
          return Promise.resolve({
            success: r.success,
            code: r.success ? 0 : 1,
            stdout: encoder.encode(r.stdout),
            stderr: encoder.encode(r.stderr),
          });
        },
      };
    }
  }

  const original = Deno.Command;
  Deno.Command = FakeCommand as unknown as typeof Deno.Command;
  return {
    invocations,
    constructions,
    restore: () => {
      Deno.Command = original;
    },
  };
}

async function withCommandStub(
  router: CommandRouter,
  fn: (stub: ReturnType<typeof installCommandStub>) => Promise<unknown>,
) {
  const stub = installCommandStub(router);
  try {
    await fn(stub);
  } finally {
    stub.restore();
  }
}

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

Deno.test("ping: happy path — GETs /rest/ping with the enc-hex auth params, writes serverStatus", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint(
    "ping",
    okEnvelope({ type: "gonic", serverVersion: "v0.16.2", openSubsonic: true }),
    async (calls) => {
      await run("ping", {}, ctx);
      assertAuthParams(new URL(calls[0].url));
    },
  );
  const res = written.find((w) => w.spec === "serverStatus")!;
  assertEquals(res.payload.status, "ok");
  assertNoCredentialLeak(written, logs);
});

Deno.test("ping: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("ping", errorFixture, async () => {
    await assertRejects(
      () => run("ping", {}, ctx),
      Error,
      "Gonic API ping: Wrong username or password (synthetic fixture) (code 40)",
    );
  });
});

Deno.test("ping: non-ok HTTP status throws 'Gonic API <ep> failed: <status> <body>'", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/rest/ping") return undefined;
      return new Response("service unavailable", { status: 503 });
    }],
    async () => {
      await assertRejects(
        () => run("ping", {}, ctx),
        Error,
        "Gonic API ping failed: 503 service unavailable",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// get-podcasts
// ---------------------------------------------------------------------------

Deno.test("get-podcasts: happy path (default includeEpisodes=true) — sends includeEpisodes=true, writes podcasts", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({
      podcasts: {
        channel: [{
          id: "pd-1",
          url: "https://feeds.example.com/a.xml",
          title: "A",
          status: "completed",
        }],
      },
    }),
    async (calls) => {
      await run("get-podcasts", {}, ctx);
      assertAuthParams(new URL(calls[0].url), { includeEpisodes: "true" });
    },
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  assertEquals((res.payload.channels as unknown[]).length, 1);
  assertNoCredentialLeak(written, logs);
});

Deno.test("get-podcasts: includeEpisodes=false is forwarded verbatim", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({ podcasts: { channel: [] } }),
    async (calls) => {
      await run("get-podcasts", { includeEpisodes: false }, ctx);
      assertAuthParams(new URL(calls[0].url), { includeEpisodes: "false" });
    },
  );
});

Deno.test("get-podcasts: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("getPodcasts", errorFixture, async () => {
    await assertRejects(
      () => run("get-podcasts", {}, ctx),
      Error,
      "Gonic API getPodcasts:",
    );
  });
});

// ---------------------------------------------------------------------------
// refresh-podcasts — no resource written
// ---------------------------------------------------------------------------

Deno.test("refresh-podcasts: happy path — GETs /rest/refreshPodcasts, writes nothing", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint("refreshPodcasts", okEnvelope(), async (calls) => {
    const result = await run("refresh-podcasts", {}, ctx) as {
      dataHandles: unknown[];
    };
    assertEquals(result.dataHandles, []);
    assertAuthParams(new URL(calls[0].url));
  });
  assertEquals(written.length, 0);
  assertNoCredentialLeak(written, logs);
});

Deno.test("refresh-podcasts: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("refreshPodcasts", errorFixture, async () => {
    await assertRejects(() => run("refresh-podcasts", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// delete-podcast-channel
// ---------------------------------------------------------------------------

Deno.test("delete-podcast-channel: happy path — sends id, writes nothing", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint(
    "deletePodcastChannel",
    okEnvelope(),
    async (calls) => {
      await run("delete-podcast-channel", { id: "pd-5" }, ctx);
      assertAuthParams(new URL(calls[0].url), { id: "pd-5" });
    },
  );
  assertEquals(written.length, 0);
  assertNoCredentialLeak(written, logs);
});

Deno.test("delete-podcast-channel: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("deletePodcastChannel", errorFixture, async () => {
    await assertRejects(
      () => run("delete-podcast-channel", { id: "pd-5" }, ctx),
      Error,
    );
  });
});

// ---------------------------------------------------------------------------
// delete-podcast-episode
// ---------------------------------------------------------------------------

Deno.test("delete-podcast-episode: happy path — sends id, writes nothing", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint(
    "deletePodcastEpisode",
    okEnvelope(),
    async (calls) => {
      await run("delete-podcast-episode", { id: "pe-42" }, ctx);
      assertAuthParams(new URL(calls[0].url), { id: "pe-42" });
    },
  );
  assertEquals(written.length, 0);
  assertNoCredentialLeak(written, logs);
});

Deno.test("delete-podcast-episode: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("deletePodcastEpisode", errorFixture, async () => {
    await assertRejects(
      () => run("delete-podcast-episode", { id: "pe-42" }, ctx),
      Error,
    );
  });
});

// ---------------------------------------------------------------------------
// download-podcast-episode
// ---------------------------------------------------------------------------

Deno.test("download-podcast-episode: happy path — sends id, writes nothing", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint(
    "downloadPodcastEpisode",
    okEnvelope(),
    async (calls) => {
      await run("download-podcast-episode", { id: "pe-42" }, ctx);
      assertAuthParams(new URL(calls[0].url), { id: "pe-42" });
    },
  );
  assertEquals(written.length, 0);
  assertNoCredentialLeak(written, logs);
});

Deno.test("download-podcast-episode: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("downloadPodcastEpisode", errorFixture, async () => {
    await assertRejects(
      () => run("download-podcast-episode", { id: "pe-42" }, ctx),
      Error,
    );
  });
});

// ---------------------------------------------------------------------------
// scan-status
// ---------------------------------------------------------------------------

Deno.test("scan-status: happy path — GETs /rest/getScanStatus, writes scanStatus", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint(
    "getScanStatus",
    okEnvelope({ scanStatus: { scanning: false, count: 10 } }),
    async (calls) => {
      await run("scan-status", {}, ctx);
      assertAuthParams(new URL(calls[0].url));
    },
  );
  const res = written.find((w) => w.spec === "scanStatus")!;
  assertEquals(res.payload.scanning, false);
  assertEquals(res.payload.count, 10);
  assertNoCredentialLeak(written, logs);
});

Deno.test("scan-status: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("getScanStatus", errorFixture, async () => {
    await assertRejects(() => run("scan-status", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// start-scan
// ---------------------------------------------------------------------------

Deno.test("start-scan: happy path — GETs /rest/startScan, writes scanStatus", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint(
    "startScan",
    okEnvelope({ scanStatus: { scanning: true, count: 1 } }),
    async (calls) => {
      await run("start-scan", {}, ctx);
      assertAuthParams(new URL(calls[0].url));
    },
  );
  const res = written.find((w) => w.spec === "scanStatus")!;
  assertEquals(res.payload.scanning, true);
  assertNoCredentialLeak(written, logs);
});

Deno.test("start-scan: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("startScan", errorFixture, async () => {
    await assertRejects(() => run("start-scan", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// get-playlists
// ---------------------------------------------------------------------------

Deno.test("get-playlists: happy path — GETs /rest/getPlaylists, writes playlists", async () => {
  const { ctx, written, logs } = makeCtx();
  await withOneEndpoint(
    "getPlaylists",
    okEnvelope({
      playlists: {
        playlist: [{
          id: "pl-1",
          name: "Favorites",
          songCount: 3,
          duration: 600,
        }],
      },
    }),
    async (calls) => {
      await run("get-playlists", {}, ctx);
      assertAuthParams(new URL(calls[0].url));
    },
  );
  const res = written.find((w) => w.spec === "playlists")!;
  assertEquals((res.payload.playlists as unknown[]).length, 1);
  assertNoCredentialLeak(written, logs);
});

Deno.test("get-playlists: error path — a failed envelope throws the mapped Gonic error", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint("getPlaylists", errorFixture, async () => {
    await assertRejects(() => run("get-playlists", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// db-query — single sshExecSql spawn invocation, jsonMode=true
// ---------------------------------------------------------------------------

Deno.test("db-query: happy path — one sqlite3 -json invocation, SQL piped via stdin, rows parsed from JSON stdout", async () => {
  const { ctx, written, logs } = makeCtx();
  const sql = "SELECT id, title FROM podcasts";
  const rowsOut = [{ id: "pd-1", title: "Example Podcast One" }];
  await withCommandStub(
    (inv) => {
      assertEquals(inv.commandLine, "sqlite3 -json '/data/gonic.db'");
      assertEquals(inv.stdin, sql + "\n");
      return { success: true, stdout: JSON.stringify(rowsOut), stderr: "" };
    },
    async (stub) => {
      await run("db-query", { sql }, ctx);
      assertEquals(stub.invocations.length, 1);
    },
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(res.payload.query, sql);
  assertEquals(res.payload.rows, rowsOut);
  assertEquals(res.payload.rowCount, 1);
  assert(res.name.startsWith("query-"), "resource name must be query-prefixed");
  assertNoCredentialLeak(written, logs);
});

Deno.test("db-query: empty stdout yields rows: [] and rowCount: 0", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    () => ({ success: true, stdout: "", stderr: "" }),
    () => run("db-query", { sql: "SELECT 1 WHERE 0" }, ctx),
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(res.payload.rows, []);
  assertEquals(res.payload.rowCount, 0);
});

// ---------------------------------------------------------------------------
// db-exec — TWO sshExecSql invocations (write, then SELECT changes()),
// distinguished ONLY by stdin (both share the identical non-json command
// line) — anti-vacuity fold-in: route DISTINCT outputs and assert the
// reported count derives from the SECOND invocation, never the first.
// ---------------------------------------------------------------------------

Deno.test("db-exec: happy path — two DISTINCT sqlite3 invocations (write, then SELECT changes()); reported changes comes from the SECOND", async () => {
  const { ctx, written, logs } = makeCtx();
  const sql = "UPDATE podcasts SET title = 'Renamed' WHERE id = 'pd-1'";
  await withCommandStub(
    (inv) => {
      assertEquals(
        inv.commandLine,
        "sqlite3  '/data/gonic.db'",
        "db-exec never passes -json (jsonMode=false for both invocations) — " +
          "note the DOUBLE space: sshExecSql's template `sqlite3 ${flags} '${dbPath}'` " +
          "leaves an extra space when flags is the empty string",
      );
      if (inv.stdin === sql + "\n") {
        // The write invocation: sqlite3 reports nothing useful on stdout.
        return { success: true, stdout: "", stderr: "" };
      }
      if (inv.stdin === "SELECT changes()\n") {
        // A DIFFERENT canned value than any row-count the write "actually"
        // affected — proves the reported number comes from THIS separate
        // connection, not the write's real effect.
        return { success: true, stdout: "3\n", stderr: "" };
      }
      throw new Error(`unrouted db-exec stdin: ${JSON.stringify(inv.stdin)}`);
    },
    async (stub) => {
      await run("db-exec", { sql }, ctx);
      assertEquals(
        stub.constructions.length,
        2,
        "exactly two separate Deno.Command instantiations must occur",
      );
      assertEquals(stub.invocations[0].stdin, sql + "\n", "first is the write");
      assertEquals(
        stub.invocations[1].stdin,
        "SELECT changes()\n",
        "second is the disconnected count query",
      );
    },
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(res.payload.query, sql);
  assertEquals(
    res.payload.rows,
    [{ changes: 3 }],
    "reported changes is whatever the SECOND (count) invocation's stdout says",
  );
  assertEquals(res.payload.rowCount, 1);
  assert(res.name.startsWith("exec-"), "resource name must be exec-prefixed");
  assertNoCredentialLeak(written, logs);
});

Deno.test("db-exec: error path — a failing WRITE propagates WITHOUT ever attempting the SELECT changes() follow-up", async () => {
  const { ctx } = makeCtx();
  const sql = "UPDATE podcasts SET title = 'X'";
  await withCommandStub(
    (inv) => {
      if (inv.stdin === "SELECT changes()\n") {
        throw new Error(
          "REGRESSION: SELECT changes() must never run after a failed write",
        );
      }
      return {
        success: false,
        stdout: "",
        stderr: "Error: near line 1: syntax error\n",
      };
    },
    async (stub) => {
      await assertRejects(
        () => run("db-exec", { sql }, ctx),
        Error,
        "sqlite3 failed: Error: near line 1: syntax error",
      );
      assertEquals(
        stub.constructions.length,
        1,
        "only the failed write invocation occurs — no count-query follow-up",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// ensure-podcast-dirs — SELECT (spawn) + docker-inspect (output) + mkdir
// (output) x N sequence
// ---------------------------------------------------------------------------

Deno.test("ensure-podcast-dirs: happy path — SELECT, docker-inspect, then one mkdir per non-empty subdir, skipping an empty one", async () => {
  const { ctx, written, logs } = makeCtx();
  const podcastRows = [
    {
      id: "pd-1",
      title: "Example Podcast One",
      root_dir: "/podcasts/Example Podcast One",
    },
    {
      id: "pd-2",
      title: "Example Podcast Two",
      root_dir: "/podcasts/Example Podcast Two",
    },
    { id: "pd-3", title: "Empty Root", root_dir: "/podcasts" },
  ];
  const hostBase = "/mnt/user/podcasts";
  await withCommandStub(
    (inv) => {
      if (inv.commandLine === "sqlite3 -json '/data/gonic.db'") {
        assertEquals(inv.stdin, "SELECT id, title, root_dir FROM podcasts\n");
        return {
          success: true,
          stdout: JSON.stringify(podcastRows),
          stderr: "",
        };
      }
      if (inv.commandLine.startsWith("docker inspect gonic")) {
        return { success: true, stdout: hostBase + "\n", stderr: "" };
      }
      if (inv.commandLine.startsWith("mkdir -p ")) {
        return { success: true, stdout: "", stderr: "" };
      }
      throw new Error(
        `unrouted ensure-podcast-dirs command: ${inv.commandLine}`,
      );
    },
    async (stub) => {
      await run("ensure-podcast-dirs", {}, ctx);
      const mkdirCalls = stub.constructions.filter((c) =>
        c.startsWith("mkdir -p ")
      );
      assertEquals(
        mkdirCalls.length,
        2,
        "the empty-subdir podcast (pd-3) must be skipped, no mkdir issued for it",
      );
      assertEquals(
        mkdirCalls[0],
        `mkdir -p '${hostBase}/Example Podcast One'`,
      );
      assertEquals(
        mkdirCalls[1],
        `mkdir -p '${hostBase}/Example Podcast Two'`,
      );
    },
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  const rows = res.payload.rows as Array<Record<string, unknown>>;
  assertEquals(rows.length, 2);
  assertEquals(rows[0], {
    id: "pd-1",
    title: "Example Podcast One",
    dir: `${hostBase}/Example Podcast One`,
  });
  assertEquals(res.payload.rowCount, 2);
  assert(res.name.startsWith("dirs-"), "resource name must be dirs-prefixed");
  assertNoCredentialLeak(written, logs);
});

Deno.test("ensure-podcast-dirs: an empty docker-inspect mount throws 'Could not find /podcasts mount'", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    (inv) => {
      if (inv.commandLine === "sqlite3 -json '/data/gonic.db'") {
        return {
          success: true,
          stdout: JSON.stringify([{
            id: "pd-1",
            title: "A",
            root_dir: "/podcasts/A",
          }]),
          stderr: "",
        };
      }
      if (inv.commandLine.startsWith("docker inspect gonic")) {
        return { success: true, stdout: "", stderr: "" };
      }
      throw new Error(`unrouted command: ${inv.commandLine}`);
    },
    () =>
      assertRejects(
        () => run("ensure-podcast-dirs", {}, ctx),
        Error,
        "Could not find /podcasts mount on gonic container",
      ),
  );
});

// ---------------------------------------------------------------------------
// Cross-method: no method ever calls the logger
// ---------------------------------------------------------------------------

Deno.test("pin: no method calls the logger — 0 log calls across every fetch-based method", async () => {
  const { ctx, logs } = makeCtx();
  await withFetchStub(
    [
      restRoute("ping", okEnvelope()),
      restRoute("getPodcasts", okEnvelope({ podcasts: { channel: [] } })),
      restRoute("refreshPodcasts", okEnvelope()),
      restRoute("getScanStatus", okEnvelope({ scanStatus: {} })),
      restRoute("startScan", okEnvelope({ scanStatus: {} })),
      restRoute("getPlaylists", okEnvelope({ playlists: {} })),
    ],
    async () => {
      await run("ping", {}, ctx);
      await run("get-podcasts", {}, ctx);
      await run("refresh-podcasts", {}, ctx);
      await run("scan-status", {}, ctx);
      await run("start-scan", {}, ctx);
      await run("get-playlists", {}, ctx);
    },
  );
  assertEquals(logs.length, 0);
});
