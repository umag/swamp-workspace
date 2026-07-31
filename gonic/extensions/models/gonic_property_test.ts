/**
 * Property-based tests (fast-check) for @magistr/gonic.
 *
 * gonic.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch or a stubbed
 * Deno.Command and reading back the captured request / written resource.
 *
 * Properties:
 *  (a) get-podcasts/get-playlists preserve every generated channel/playlist,
 *      IN ORDER, with the written array's length == the generated array's
 *      length; absent/empty input both yield [].
 *  (b) AUTH-ENCODING — FIXED to Subsonic TOKEN auth: for ANY generated
 *      password, the captured URL has NO `p` param, its `s` param is
 *      hex-shaped, and its `t` param always equals md5hex(password + s) —
 *      recomputed from the EMITTED (random) per-request salt, never a fixed
 *      expected value. (Token auth is a pure hash of password+salt, so there
 *      is no lone-surrogate/U+FFFD collapse edge case here — unlike the
 *      retired enc-hex encoding, the invariant holds for ANY string.)
 *  (c) db-query's rows/rowCount round-trip the Command stub's JSON stdout
 *      exactly, in order; empty stdout always yields []/0.
 */
import { assert } from "jsr:@std/assert@1";
import { crypto as stdCrypto } from "jsr:@std/crypto@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./gonic.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

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
type CommandRouter = () => CommandResult;

function installCommandStub(router: CommandRouter) {
  const encoder = new TextEncoder();

  class FakeCommand {
    constructor(_cmd: string, _options: { args?: string[] } = {}) {}
    output() {
      const r = router();
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        stdout: encoder.encode(r.stdout),
        stderr: encoder.encode(r.stderr),
      });
    }
    spawn() {
      return {
        stdin: {
          getWriter: () => ({
            write: (_bytes: Uint8Array) => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        },
        output: () => {
          const r = router();
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
    restore: () => {
      Deno.Command = original;
    },
  };
}

async function withCommandStub(
  router: CommandRouter,
  fn: () => Promise<unknown>,
) {
  const stub = installCommandStub(router);
  try {
    await fn();
  } finally {
    stub.restore();
  }
}

/** Independent md5hex(input) — used to recompute the expected Subsonic
 * token from a captured (random) per-request salt, never a fixed constant. */
async function md5Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await stdCrypto.subtle.digest("MD5", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// (a) get-podcasts / get-playlists — order + count preservation
// ---------------------------------------------------------------------------

const arbChannel = fc.record({
  id: fc.stringMatching(/^pd-[0-9]{1,4}$/),
  url: fc.webUrl(),
  title: fc.string({ minLength: 1, maxLength: 20 }),
  status: fc.string({ minLength: 1, maxLength: 10 }),
});

Deno.test("property: get-podcasts preserves every generated channel, IN ORDER, with channels.length == generated.length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbChannel, { minLength: 0, maxLength: 15 }),
      async (channels) => {
        const { ctx, written } = makeCtx();
        await withOneEndpoint(
          "getPodcasts",
          okEnvelope({ podcasts: { channel: channels } }),
          () => run("get-podcasts", {}, ctx),
        );
        const res = written.find((w) => w.spec === "podcasts")!;
        const out = res.payload.channels as Array<Record<string, unknown>>;
        return out.length === channels.length &&
          out.every((c, i) =>
            c.id === channels[i].id && c.url === channels[i].url &&
            c.title === channels[i].title
          );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: get-podcasts — absent and empty channel arrays both yield channels: []", async () => {
  for (
    const body of [
      okEnvelope(),
      okEnvelope({ podcasts: {} }),
      okEnvelope({ podcasts: { channel: [] } }),
    ]
  ) {
    const { ctx, written } = makeCtx();
    await withOneEndpoint(
      "getPodcasts",
      body,
      () => run("get-podcasts", {}, ctx),
    );
    const res = written.find((w) => w.spec === "podcasts")!;
    assert(
      Array.isArray(res.payload.channels) &&
        (res.payload.channels as unknown[]).length === 0,
    );
  }
});

const arbPlaylist = fc.record({
  id: fc.stringMatching(/^pl-[0-9]{1,4}$/),
  name: fc.string({ minLength: 1, maxLength: 20 }),
  songCount: fc.nat({ max: 10000 }),
  duration: fc.nat({ max: 100000 }),
});

Deno.test("property: get-playlists preserves every generated playlist, IN ORDER, with playlists.length == generated.length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbPlaylist, { minLength: 0, maxLength: 15 }),
      async (playlists) => {
        const { ctx, written } = makeCtx();
        await withOneEndpoint(
          "getPlaylists",
          okEnvelope({ playlists: { playlist: playlists } }),
          () => run("get-playlists", {}, ctx),
        );
        const res = written.find((w) => w.spec === "playlists")!;
        const out = res.payload.playlists as Array<Record<string, unknown>>;
        return out.length === playlists.length &&
          out.every((p, i) =>
            p.id === playlists[i].id && p.name === playlists[i].name &&
            p.songCount === playlists[i].songCount &&
            p.duration === playlists[i].duration
          );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: get-playlists — absent and empty playlist arrays both yield playlists: []", async () => {
  for (
    const body of [
      okEnvelope(),
      okEnvelope({ playlists: {} }),
      okEnvelope({ playlists: { playlist: [] } }),
    ]
  ) {
    const { ctx, written } = makeCtx();
    await withOneEndpoint(
      "getPlaylists",
      body,
      () => run("get-playlists", {}, ctx),
    );
    const res = written.find((w) => w.spec === "playlists")!;
    assert(
      Array.isArray(res.payload.playlists) &&
        (res.payload.playlists as unknown[]).length === 0,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) AUTH-ENCODING — FIXED to Subsonic TOKEN auth: a single invariant that
// holds for ANY generated password (no BMP-safe/surrogate carve-out needed —
// both sides of the equality run the SAME TextEncoder-based md5Hex, so any
// U+FFFD substitution for a lone surrogate is identical on both sides).
// ---------------------------------------------------------------------------

Deno.test("property: TOKEN auth — for ANY password, the URL has NO p param, an s param that is hex-shaped, and t ALWAYS equals md5hex(password + the emitted s)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 60 }), async (password) => {
      const { ctx } = makeCtx({ ...GLOBAL_ARGS, password });
      let url = new URL("http://placeholder/");
      await withOneEndpoint("ping", okEnvelope(), async (calls) => {
        await run("ping", {}, ctx);
        url = new URL(calls[0].url);
      });
      if (url.searchParams.get("p") !== null) return false;
      const s = url.searchParams.get("s");
      const t = url.searchParams.get("t");
      if (!s || !t || !/^[0-9a-f]+$/i.test(s)) return false;
      const expectedToken = await md5Hex(password + s);
      return t === expectedToken;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) db-query row round-trip via the Command stub
// ---------------------------------------------------------------------------

const arbRow = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  title: fc.string({ maxLength: 20 }),
  count: fc.integer(),
  active: fc.boolean(),
});
const arbRows = fc.array(arbRow, { minLength: 0, maxLength: 8 });

Deno.test("property: db-query's rows/rowCount round-trip the Command stub's JSON stdout exactly, in order", async () => {
  await fc.assert(
    fc.asyncProperty(arbRows, async (rows) => {
      const { ctx, written } = makeCtx();
      await withCommandStub(
        () => ({ success: true, stdout: JSON.stringify(rows), stderr: "" }),
        () => run("db-query", { sql: "SELECT * FROM x" }, ctx),
      );
      const res = written.find((w) => w.spec === "dbResult")!;
      return JSON.stringify(res.payload.rows) === JSON.stringify(rows) &&
        res.payload.rowCount === rows.length;
    }),
    FC_RUNS,
  );
});

Deno.test("property: db-query — empty stdout ALWAYS yields rows: [] and rowCount: 0, for any SQL text", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 40 }), async (sql) => {
      const { ctx, written } = makeCtx();
      await withCommandStub(
        () => ({ success: true, stdout: "", stderr: "" }),
        () => run("db-query", { sql }, ctx),
      );
      const res = written.find((w) => w.spec === "dbResult")!;
      return JSON.stringify(res.payload.rows) === "[]" &&
        res.payload.rowCount === 0;
    }),
    FC_RUNS,
  );
});
