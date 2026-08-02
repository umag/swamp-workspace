/**
 * Coverage suite: regression tests closing gaps a code reviewer found — every
 * `|| []` / `|| default` falsy guard on BOTH sides, both `sshExecSql` mode
 * flags (now `-json`/`-readonly`), its warning-vs-real-error stderr filter
 * (now SURFACES a warning-only failure instead of swallowing it — LB8),
 * `db-exec`'s `parseInt` fallback over its single combined write+changes()
 * session (LB4), `ensure-podcast-dirs`'s subdir-empty variants, the
 * failed-envelope message/code fallback, and a security pin on the
 * `password`/`username` `.meta({ sensitive })` annotations.
 *
 * gonic.ts is no longer wholly byte-frozen — this change fixes LB3/LB4/LB8
 * (read-only db-query enforcement, connection-scoped db-exec change count,
 * surfaced warning-only SSH failures); every other test here still PINS
 * already-shipped, unrelated behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { model } from "./gonic.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  host: "gonic.example.com",
  port: 4747,
  username: "listener",
  password: "fixture-only-not-a-real-password-000",
  sshUser: "root",
  dbPath: "/data/gonic.db",
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
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

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

async function withOneEndpoint(
  endpoint: string,
  body: unknown,
  fn: (calls: Request[]) => Promise<unknown>,
) {
  await withFetchStub([restRoute(endpoint, body)], fn);
}

function okEnvelope(extra: Record<string, unknown> = {}) {
  return {
    "subsonic-response": { status: "ok", version: "1.16.1", ...extra },
  };
}

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
// get-podcasts: sr.podcasts?.channel || [] — both falsy shapes
// ---------------------------------------------------------------------------

Deno.test("guard: get-podcasts — sr.podcasts entirely absent yields channels: []", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope(),
    () => run("get-podcasts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  assertEquals(res.payload.channels, []);
});

Deno.test("guard: get-podcasts — sr.podcasts present but with no `channel` key yields channels: []", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({ podcasts: {} }),
    () => run("get-podcasts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  assertEquals(res.payload.channels, []);
});

// ---------------------------------------------------------------------------
// ch.episode || [] — both falsy shapes, plus explicit []
// ---------------------------------------------------------------------------

Deno.test("guard: get-podcasts — a channel with episode: null defaults to episode: []", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({
      podcasts: {
        channel: [{
          id: "pd-1",
          url: "https://feeds.example.com/a.xml",
          title: "A",
          status: "completed",
          episode: null,
        }],
      },
    }),
    () => run("get-podcasts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  assertEquals(channels[0].episode, []);
});

Deno.test("guard: get-podcasts — a channel with episode: [] stays an empty array", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({
      podcasts: {
        channel: [{
          id: "pd-1",
          url: "https://feeds.example.com/a.xml",
          title: "A",
          status: "completed",
          episode: [],
        }],
      },
    }),
    () => run("get-podcasts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  assertEquals(channels[0].episode, []);
});

// ---------------------------------------------------------------------------
// ep.channelId || ch.id — fallback AND precedence
// ---------------------------------------------------------------------------

Deno.test("guard: get-podcasts — an episode missing channelId falls back to the parent channel's id", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({
      podcasts: {
        channel: [{
          id: "pd-1",
          url: "https://feeds.example.com/a.xml",
          title: "A",
          status: "completed",
          episode: [{ id: "pe-1", title: "E1", status: "completed" }],
        }],
      },
    }),
    () => run("get-podcasts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  const episodes = channels[0].episode as Array<Record<string, unknown>>;
  assertEquals(episodes[0].channelId, "pd-1");
});

Deno.test("guard: get-podcasts — an episode's OWN channelId takes precedence over the parent channel's id", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({
      podcasts: {
        channel: [{
          id: "pd-1",
          url: "https://feeds.example.com/a.xml",
          title: "A",
          status: "completed",
          episode: [{
            id: "pe-1",
            channelId: "pd-DIFFERENT",
            title: "E1",
            status: "completed",
          }],
        }],
      },
    }),
    () => run("get-podcasts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  const episodes = channels[0].episode as Array<Record<string, unknown>>;
  assertEquals(episodes[0].channelId, "pd-DIFFERENT");
});

// ---------------------------------------------------------------------------
// title/status defaults — channel AND episode
// ---------------------------------------------------------------------------

Deno.test("guard: get-podcasts — a channel missing title/status defaults to '' / 'unknown'", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({
      podcasts: {
        channel: [{ id: "pd-1", url: "https://feeds.example.com/a.xml" }],
      },
    }),
    () => run("get-podcasts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  assertEquals(channels[0].title, "");
  assertEquals(channels[0].status, "unknown");
});

Deno.test("guard: get-podcasts — an episode missing title/status defaults to '' / 'unknown'", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPodcasts",
    okEnvelope({
      podcasts: {
        channel: [{
          id: "pd-1",
          url: "https://feeds.example.com/a.xml",
          title: "A",
          status: "completed",
          episode: [{ id: "pe-1" }],
        }],
      },
    }),
    () => run("get-podcasts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "podcasts")!;
  const channels = res.payload.channels as Array<Record<string, unknown>>;
  const episodes = channels[0].episode as Array<Record<string, unknown>>;
  assertEquals(episodes[0].title, "");
  assertEquals(episodes[0].status, "unknown");
});

// ---------------------------------------------------------------------------
// scan.scanning || false / scan.count || 0 — missing scanStatus key entirely
// ---------------------------------------------------------------------------

Deno.test("guard: scan-status — sr.scanStatus entirely absent defaults to scanning:false, count:0", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getScanStatus",
    okEnvelope(),
    () => run("scan-status", {}, ctx),
  );
  const res = written.find((w) => w.spec === "scanStatus")!;
  assertEquals(res.payload.scanning, false);
  assertEquals(res.payload.count, 0);
});

Deno.test("guard: scan-status — an explicit scanning:false / count:0 is preserved (not re-defaulted to something else)", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getScanStatus",
    okEnvelope({ scanStatus: { scanning: false, count: 0 } }),
    () => run("scan-status", {}, ctx),
  );
  const res = written.find((w) => w.spec === "scanStatus")!;
  assertEquals(res.payload.scanning, false);
  assertEquals(res.payload.count, 0);
});

// ---------------------------------------------------------------------------
// sr.playlists?.playlist || [] — both falsy shapes
// ---------------------------------------------------------------------------

Deno.test("guard: get-playlists — sr.playlists entirely absent yields playlists: []", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPlaylists",
    okEnvelope(),
    () => run("get-playlists", {}, ctx),
  );
  const res = written.find((w) => w.spec === "playlists")!;
  assertEquals(res.payload.playlists, []);
});

Deno.test("guard: get-playlists — sr.playlists present but with no `playlist` key yields playlists: []", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPlaylists",
    okEnvelope({ playlists: {} }),
    () => run("get-playlists", {}, ctx),
  );
  const res = written.find((w) => w.spec === "playlists")!;
  assertEquals(res.payload.playlists, []);
});

Deno.test("guard: get-playlists — songCount/duration missing default to 0", async () => {
  const { ctx, written } = makeCtx();
  await withOneEndpoint(
    "getPlaylists",
    okEnvelope({ playlists: { playlist: [{ id: "pl-1", name: "N" }] } }),
    () => run("get-playlists", {}, ctx),
  );
  const res = written.find((w) => w.spec === "playlists")!;
  const playlists = res.payload.playlists as Array<Record<string, unknown>>;
  assertEquals(playlists[0].songCount, 0);
  assertEquals(playlists[0].duration, 0);
});

// ---------------------------------------------------------------------------
// sshExecSql: stdout.trim() ? JSON.parse(stdout) : []
// ---------------------------------------------------------------------------

Deno.test("guard: db-query — a whitespace-only stdout (trim() is falsy) yields rows: []", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    () => ({ success: true, stdout: "   \n\t  ", stderr: "" }),
    () => run("db-query", { sql: "SELECT 1 WHERE 0" }, ctx),
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(res.payload.rows, []);
  assertEquals(res.payload.rowCount, 0);
});

// ---------------------------------------------------------------------------
// sshExecSql jsonMode/readOnly: "-json -readonly" vs "" flags — pinned
// command-line difference
// ---------------------------------------------------------------------------

Deno.test("guard: db-query passes '-json -readonly' while db-exec passes NO flag, for the identical dbPath", async () => {
  const { ctx } = makeCtx();
  const commandLines: string[] = [];
  await withCommandStub(
    (inv) => {
      commandLines.push(inv.commandLine);
      return { success: true, stdout: "", stderr: "" };
    },
    async () => {
      await run("db-query", { sql: "SELECT 1" }, ctx);
      await run("db-exec", { sql: "DELETE FROM x" }, ctx);
    },
  );
  assertEquals(commandLines[0], "sqlite3 -json -readonly '/data/gonic.db'");
  // db-exec now issues exactly ONE combined invocation (write + SELECT
  // changes() on the SAME connection); it omits both -json and -readonly,
  // since jsonMode/readOnly are both `false` — note the DOUBLE space:
  // sshExecSql's template `sqlite3 ${flags} '${dbPath}'` leaves an extra
  // space when flags is the empty string.
  assertEquals(commandLines[1], "sqlite3  '/data/gonic.db'");
  assertEquals(
    commandLines.length,
    2,
    "db-exec is a single combined invocation, not two",
  );
});

// ---------------------------------------------------------------------------
// sshExecSql: warning-only stderr on failure now SURFACES vs a real error
// ---------------------------------------------------------------------------

Deno.test("guard: sshExecSql SURFACES a warning-only stderr when success is false — throws instead of swallowing", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    () => ({
      success: false,
      stdout: "",
      stderr:
        "Warning: Permanently added 'gonic.example.com' (ED25519) to the list of known hosts.\n",
    }),
    () =>
      assertRejects(
        () => run("db-query", { sql: "SELECT 1" }, ctx),
        Error,
        "sqlite3 failed:",
      ),
  );
});

Deno.test("guard: sshExecSql DOES throw when stderr has a real (non-warning) line, even mixed with a warning", async () => {
  const { ctx } = makeCtx();
  await withCommandStub(
    () => ({
      success: false,
      stdout: "",
      stderr:
        "Warning: Permanently added 'gonic.example.com' (ED25519) to the list of known hosts.\n" +
        "Error: near line 1: syntax error\n",
    }),
    () =>
      assertRejects(
        () => run("db-query", { sql: "SELEKT 1" }, ctx),
        Error,
        "sqlite3 failed: Error: near line 1: syntax error",
      ),
  );
});

// ---------------------------------------------------------------------------
// db-exec: parseInt(lastLine) || 0 fallback, from the single combined
// write+SELECT changes() session
// ---------------------------------------------------------------------------

Deno.test("guard: db-exec — a non-numeric count output (parseInt -> NaN) falls back to changes: 0", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    () => ({ success: true, stdout: "not-a-number\n", stderr: "" }),
    () => run("db-exec", { sql: "UPDATE x SET y = 1" }, ctx),
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(res.payload.rows, [{ changes: 0 }]);
});

Deno.test("guard: db-exec — a zero-padded count output parses to its numeric value (e.g. '007' -> 7)", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    () => ({ success: true, stdout: "007\n", stderr: "" }),
    () => run("db-exec", { sql: "UPDATE x SET y = 1" }, ctx),
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(res.payload.rows, [{ changes: 7 }]);
});

// ---------------------------------------------------------------------------
// ensure-podcast-dirs: subdir-empty variants (both regex-collapsing forms)
// ---------------------------------------------------------------------------

Deno.test("guard: ensure-podcast-dirs — root_dir exactly '/podcasts' (no trailing slash) is skipped, no mkdir issued", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    (inv) => {
      if (inv.commandLine === "sqlite3 -json '/data/gonic.db'") {
        return {
          success: true,
          stdout: JSON.stringify([{
            id: "pd-1",
            title: "Root",
            root_dir: "/podcasts",
          }]),
          stderr: "",
        };
      }
      if (inv.commandLine.startsWith("docker inspect gonic")) {
        return { success: true, stdout: "/mnt/user/podcasts\n", stderr: "" };
      }
      throw new Error(
        `unexpected mkdir invocation for an empty subdir: ${inv.commandLine}`,
      );
    },
    () => run("ensure-podcast-dirs", {}, ctx),
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(res.payload.rows, []);
  assertEquals(res.payload.rowCount, 0);
});

Deno.test("guard: ensure-podcast-dirs — root_dir '/podcasts/' (trailing slash) is ALSO skipped, no mkdir issued", async () => {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    (inv) => {
      if (inv.commandLine === "sqlite3 -json '/data/gonic.db'") {
        return {
          success: true,
          stdout: JSON.stringify([{
            id: "pd-1",
            title: "Root",
            root_dir: "/podcasts/",
          }]),
          stderr: "",
        };
      }
      if (inv.commandLine.startsWith("docker inspect gonic")) {
        return { success: true, stdout: "/mnt/user/podcasts\n", stderr: "" };
      }
      throw new Error(
        `unexpected mkdir invocation for an empty subdir: ${inv.commandLine}`,
      );
    },
    () => run("ensure-podcast-dirs", {}, ctx),
  );
  const res = written.find((w) => w.spec === "dbResult")!;
  assertEquals(res.payload.rows, []);
  assertEquals(res.payload.rowCount, 0);
});

// ---------------------------------------------------------------------------
// Failed-envelope error.message || "unknown error" / code fallback
// ---------------------------------------------------------------------------

Deno.test("guard: a failed envelope whose error object is missing `message` falls back to 'unknown error'", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint(
    "ping",
    { "subsonic-response": { status: "failed", error: { code: 70 } } },
    () =>
      assertRejects(
        () => run("ping", {}, ctx),
        Error,
        "Gonic API ping: unknown error (code 70)",
      ),
  );
});

Deno.test("guard: a failed envelope with NO `error` object at all falls back to 'unknown error (code undefined)'", async () => {
  const { ctx } = makeCtx();
  await withOneEndpoint(
    "ping",
    { "subsonic-response": { status: "failed" } },
    () =>
      assertRejects(
        () => run("ping", {}, ctx),
        Error,
        "Gonic API ping: unknown error (code undefined)",
      ),
  );
});

// ---------------------------------------------------------------------------
// Security pin: password IS sensitive today; username is NOT
// ---------------------------------------------------------------------------

Deno.test("pin: globalArguments.password IS marked .meta({ sensitive: true }) today — a regression flips this", () => {
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.password) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    true,
    "password must stay marked sensitive — if this starts failing, gonic.ts regressed the annotation",
  );
});

Deno.test("pin: globalArguments.username is NOT marked sensitive (only password is)", () => {
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.username) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(meta?.sensitive, undefined);
});
