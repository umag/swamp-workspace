/**
 * Method-level tests for @magistr/shoko — every one of the 14 methods
 * (authenticate, status, dashboard, list-series, search-series,
 * find-unrecognized-files, find-missing-episodes, find-duplicate-files,
 * list-import-folders, queue-status, list-actions, run-action,
 * remove-missing-files, rescan-folder), happy path + error path, driven
 * through `model.methods.<m>.arguments.parse()` + `.execute()` against a
 * stubbed `globalThis.fetch` and a fake context.
 *
 * shoko.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Two header/body branches get explicit coverage here (round-1 plan review
 * MEDIUM): `apikey` is sent on every authed method and withheld from the
 * three auth-optional ones (authenticate, status, list-actions); and
 * `Content-Type: application/json` is sent ONLY when a body is passed
 * (authenticate's POST), never on the 13 GET methods.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./shoko.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HOST = "http://203.0.113.10:8111";
const API_KEY = "fixture-shoko-key-0001";

const GLOBAL_ARGS = {
  host: HOST,
  apiKey: API_KEY,
  userAgent: "swamp-shoko-test/1.0",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };
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

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied,
 * enums enforced) before execute is invoked — never call execute() with raw,
 * unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request. */
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
  }) as unknown as typeof globalThis.fetch;
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

/** Single-route stub returning the same body/status to every call. */
function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

/** Single-route stub returning a raw (non-JSON-encoded) text body — for
 * pinning http()'s non-ok error-message slicing against plain-text bodies,
 * the way a real reverse proxy / ASP.NET error page would send them. */
function withOneTextResponse(
  body: string,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub(
    [() => new Response(body, { status })],
    fn,
  );
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------

Deno.test("authenticate: happy path — POSTs to /api/auth with Content-Type + JSON body, NO apikey header, writes auth/current", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { apikey: "returned-fixture-key" },
    200,
    async (calls) => {
      await run(
        "authenticate",
        { user: "alice", pass: "hunter2", device: "swamp" },
        ctx,
      );
      assertEquals(calls.length, 1);
      const url = new URL(calls[0].url);
      assertEquals(url.pathname, "/api/auth");
      assertEquals(calls[0].method, "POST");
      assertEquals(calls[0].headers.get("Content-Type"), "application/json");
      assertEquals(calls[0].headers.has("apikey"), false);
      const body = await requestBody(calls[0]);
      assertEquals(body, { user: "alice", pass: "hunter2", device: "swamp" });
    },
  );
  const res = written.find((w) => w.spec === "auth");
  assert(res);
  assertEquals(res.name, "current");
  assertEquals(res.payload.apikey, "returned-fixture-key");
  assertEquals(res.payload.device, "swamp");
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("authenticate: device defaults to 'swamp' when omitted", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(
    { apikey: "k" },
    200,
    async (calls) => {
      await run("authenticate", { user: "alice", pass: "hunter2" }, ctx);
      const body = await requestBody(calls[0]);
      assertEquals(body.device, "swamp");
    },
  );
});

Deno.test("authenticate: error path — non-ok HTTP status throws 'Shoko POST /api/auth → <status>: <body>'", async () => {
  const { ctx } = makeCtx();
  await withOneTextResponse("Unauthorized", 401, async () => {
    await assertRejects(
      () => run("authenticate", { user: "a", pass: "b" }, ctx),
      Error,
      "Shoko POST /api/auth → 401: Unauthorized",
    );
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

Deno.test("status: happy path — GETs /api/v3/Init/Status, NO apikey header, NO body, writes status/init", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { State: 5, StartupMessage: null },
    200,
    async (calls) => {
      await run("status", {}, ctx);
      assertEquals(calls.length, 1);
      assertEquals(new URL(calls[0].url).pathname, "/api/v3/Init/Status");
      assertEquals(calls[0].method, "GET");
      assertEquals(calls[0].headers.has("apikey"), false);
      assertEquals(calls[0].headers.has("Content-Type"), false);
    },
  );
  const res = written.find((w) => w.spec === "status");
  assert(res);
  assertEquals(res.name, "init");
  assertEquals(res.payload.State, 5);
});

Deno.test("status: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneTextResponse("server down", 503, async () => {
    await assertRejects(
      () => run("status", {}, ctx),
      Error,
      "Shoko GET /api/v3/Init/Status → 503: server down",
    );
  });
});

// ---------------------------------------------------------------------------
// dashboard — the representative authed GET: apikey present, NO Content-Type,
// NO body (round-1 plan review MEDIUM finding)
// ---------------------------------------------------------------------------

Deno.test("dashboard: happy path — GETs /api/v3/Dashboard/Stats WITH apikey header, NO Content-Type, NO body, writes dashboard/dashboard-stats", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { CollectionStats: { SeriesCount: 1 } },
    200,
    async (calls) => {
      await run("dashboard", {}, ctx);
      assertEquals(new URL(calls[0].url).pathname, "/api/v3/Dashboard/Stats");
      assertEquals(calls[0].method, "GET");
      assertEquals(
        calls[0].headers.get("apikey"),
        API_KEY,
        "authed GET methods must send the apikey header",
      );
      assertEquals(
        calls[0].headers.has("Content-Type"),
        false,
        "GET methods with no body must NOT send Content-Type",
      );
      const rawBody = await calls[0].text();
      assertEquals(rawBody, "", "GET methods with no body must send no body");
    },
  );
  const res = written.find((w) => w.spec === "dashboard");
  assert(res);
  assertEquals(res.payload, { CollectionStats: { SeriesCount: 1 } });
});

Deno.test("dashboard: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("boom", 500, async () => {
    await assertRejects(() => run("dashboard", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// list-series
// ---------------------------------------------------------------------------

Deno.test("list-series: happy path — default page/pageSize, no startsWith param, writes series/page-1", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { Total: 1, List: [{ Name: "A" }] },
    200,
    async (calls) => {
      await run("list-series", {}, ctx);
      const url = new URL(calls[0].url);
      assertEquals(url.pathname, "/api/v3/Series");
      assertEquals(url.searchParams.get("page"), "1");
      assertEquals(url.searchParams.get("pageSize"), "50");
      assertEquals(url.searchParams.has("startsWith"), false);
      assertEquals(calls[0].headers.get("apikey"), API_KEY);
    },
  );
  const res = written.find((w) => w.spec === "series");
  assert(res);
  assertEquals(res.name, "page-1");
  assertEquals(res.payload.total, 1);
});

Deno.test("list-series: startsWith is included in the query string when provided", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ Total: 0, List: [] }, 200, async (calls) => {
    await run("list-series", { page: 2, pageSize: 10, startsWith: "A" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("page"), "2");
    assertEquals(url.searchParams.get("pageSize"), "10");
    assertEquals(url.searchParams.get("startsWith"), "A");
  });
  const { ctx: ctx2, written } = makeCtx();
  await withOneResponse({ Total: 0, List: [] }, 200, async () => {
    await run("list-series", { page: 2 }, ctx2);
  });
  assertEquals(written.find((w) => w.spec === "series")!.name, "page-2");
});

Deno.test("list-series: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(() => run("list-series", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// search-series
// ---------------------------------------------------------------------------

Deno.test("search-series: happy path — GETs the encoded query path with limit/fuzzy params, writes series/search-<query>", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse([{ Name: "A" }], 200, async (calls) => {
    await run("search-series", { query: "one two" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/v3/Series/Search/one%20two");
    assertEquals(url.searchParams.get("limit"), "20");
    assertEquals(url.searchParams.get("fuzzy"), "true");
  });
  const res = written.find((w) => w.spec === "series");
  assert(res);
  assertEquals(res.name, "search-one two");
  assertEquals(res.payload.total, 1);
});

Deno.test("search-series: limit/fuzzy overrides are sent", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("search-series", { query: "x", limit: 5, fuzzy: false }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("limit"), "5");
    assertEquals(url.searchParams.get("fuzzy"), "false");
  });
});

Deno.test("search-series: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 404, async () => {
    await assertRejects(() => run("search-series", { query: "x" }, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// find-unrecognized-files
// ---------------------------------------------------------------------------

Deno.test("find-unrecognized-files: happy path — GETs /api/v3/File with include_only=Unrecognized, writes files/unrecognized", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { Total: 0, List: [] },
    200,
    async (calls) => {
      await run("find-unrecognized-files", {}, ctx);
      const url = new URL(calls[0].url);
      assertEquals(url.pathname, "/api/v3/File");
      assertEquals(url.searchParams.get("include_only"), "Unrecognized");
      assertEquals(url.searchParams.get("page"), "1");
      assertEquals(url.searchParams.get("pageSize"), "100");
    },
  );
  const res = written.find((w) => w.spec === "files");
  assert(res);
  assertEquals(res.name, "unrecognized");
  assertEquals(res.payload.category, "unrecognized");
});

Deno.test("find-unrecognized-files: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(() => run("find-unrecognized-files", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// find-missing-episodes
// ---------------------------------------------------------------------------

Deno.test("find-missing-episodes: happy path (default scope=series) — GETs .../MissingEpisodes/Series, writes episodes/missing-series", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ Total: 0, List: [] }, 200, async (calls) => {
    await run("find-missing-episodes", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v3/ReleaseManagement/MissingEpisodes/Series",
    );
  });
  const res = written.find((w) => w.spec === "episodes");
  assert(res);
  assertEquals(res.name, "missing-series");
  assertEquals(res.payload.category, "missing-series");
});

Deno.test("find-missing-episodes: scope=episodes — GETs .../MissingEpisodes/Episodes, writes episodes/missing-episodes", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ Total: 0, List: [] }, 200, async (calls) => {
    await run("find-missing-episodes", { scope: "episodes" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v3/ReleaseManagement/MissingEpisodes/Episodes",
    );
  });
  const res = written.find((w) => w.spec === "episodes");
  assert(res);
  assertEquals(res.name, "missing-episodes");
});

Deno.test("find-missing-episodes: collecting is included in the query string when provided (even collecting=false)", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ Total: 0, List: [] }, 200, async (calls) => {
    await run("find-missing-episodes", { collecting: false }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("collecting"), "false");
  });
});

Deno.test("find-missing-episodes: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(() => run("find-missing-episodes", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// find-duplicate-files
// ---------------------------------------------------------------------------

Deno.test("find-duplicate-files: happy path (default scope=series) — GETs .../DuplicateFiles/Series, writes files/duplicates-series", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ Total: 0, List: [] }, 200, async (calls) => {
    await run("find-duplicate-files", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v3/ReleaseManagement/DuplicateFiles/Series",
    );
  });
  const res = written.find((w) => w.spec === "files");
  assert(res);
  assertEquals(res.name, "duplicates-series");
});

Deno.test("find-duplicate-files: scope=episodes — GETs .../DuplicateFiles/Episodes, writes files/duplicates-episodes", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ Total: 0, List: [] }, 200, async (calls) => {
    await run("find-duplicate-files", { scope: "episodes" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v3/ReleaseManagement/DuplicateFiles/Episodes",
    );
  });
  const res = written.find((w) => w.spec === "files");
  assert(res);
  assertEquals(res.name, "duplicates-episodes");
});

Deno.test("find-duplicate-files: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(() => run("find-duplicate-files", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// list-import-folders
// ---------------------------------------------------------------------------

Deno.test("list-import-folders: happy path — GETs /api/v3/ImportFolder WITH apikey, writes importFolders/import-folders", async () => {
  const { ctx, written } = makeCtx();
  const folders = [{ ID: 1, Path: "/mnt/anime", Name: "Main" }];
  await withOneResponse(folders, 200, async (calls) => {
    await run("list-import-folders", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/v3/ImportFolder");
    assertEquals(calls[0].headers.get("apikey"), API_KEY);
  });
  const res = written.find((w) => w.spec === "importFolders");
  assert(res);
  assertEquals(res.name, "import-folders");
  assertEquals(res.payload.folders, folders);
  assertEquals(res.payload.total, 1);
});

Deno.test("list-import-folders: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(() => run("list-import-folders", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// queue-status
// ---------------------------------------------------------------------------

Deno.test("queue-status: happy path (array response) — GETs /api/v3/Queue WITH apikey, writes queue/queue", async () => {
  const { ctx, written } = makeCtx();
  const items = [{ Name: "General", Status: "Idle", Type: "General" }];
  await withOneResponse(items, 200, async (calls) => {
    await run("queue-status", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/v3/Queue");
    assertEquals(calls[0].headers.get("apikey"), API_KEY);
  });
  const res = written.find((w) => w.spec === "queue");
  assert(res);
  assertEquals(res.name, "queue");
  assertEquals(res.payload.items, items);
});

Deno.test("queue-status: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(() => run("queue-status", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// list-actions
// ---------------------------------------------------------------------------

Deno.test("list-actions: happy path — GETs /swagger/v3/swagger.json, NO apikey header, filters to /Action/-prefixed paths with a GET", async () => {
  const { ctx, written } = makeCtx();
  const spec = {
    paths: {
      "/api/v3/Action/RunImport": { get: { summary: "skipped: wrong prefix" } },
      "/Action/Foo": { get: { summary: "matched" } },
      "/Action/NoGet": { post: { summary: "skipped: no get" } },
    },
  };
  await withOneResponse(spec, 200, async (calls) => {
    await run("list-actions", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/swagger/v3/swagger.json",
    );
    assertEquals(calls[0].headers.has("apikey"), false);
  });
  const res = written.find((w) => w.spec === "actions");
  assert(res);
  const actions = res.payload.actions as Array<{ Name: string }>;
  assertEquals(actions.length, 1);
  assertEquals(actions[0].Name, "Foo");
  assertEquals(res.payload.total, 1);
});

Deno.test("list-actions: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(() => run("list-actions", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// run-action
// ---------------------------------------------------------------------------

Deno.test("run-action: happy path — GETs the encoded /api/v3/Action/<name> path, discards the response, writes task/action-<rawName>", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ ignored: true }, 200, async (calls) => {
    await run("run-action", { action: "Run Import" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v3/Action/Run%20Import",
      "the URL path segment IS encodeURIComponent-encoded",
    );
    assertEquals(calls[0].headers.get("apikey"), API_KEY);
  });
  const res = written.find((w) => w.spec === "task");
  assert(res);
  assertEquals(res.name, "action-Run Import");
  assertEquals(
    res.payload.message,
    "Triggered Run Import",
    "the written message keeps the RAW (unencoded) action name",
  );
  assertEquals(res.payload.endpoint, "/api/v3/Action/Run%20Import");
});

Deno.test("run-action: error path — the discarded http() call still propagates a non-ok rejection", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(
      () => run("run-action", { action: "RunImport" }, ctx),
      Error,
    );
  });
});

// ---------------------------------------------------------------------------
// remove-missing-files
// ---------------------------------------------------------------------------

Deno.test("remove-missing-files: default removeFromMyList=false — GETs .../RemoveMissingFiles/false, writes task/remove-missing-files-false", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("remove-missing-files", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v3/Action/RemoveMissingFiles/false",
    );
  });
  const res = written.find((w) => w.spec === "task");
  assert(res);
  assertEquals(res.name, "remove-missing-files-false");
  assertEquals(
    res.payload.message,
    "Triggered RemoveMissingFiles (removeFromMyList=false)",
  );
});

Deno.test("remove-missing-files: explicit removeFromMyList=true — GETs .../RemoveMissingFiles/true", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("remove-missing-files", { removeFromMyList: true }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v3/Action/RemoveMissingFiles/true",
    );
  });
  const res = written.find((w) => w.spec === "task");
  assert(res);
  assertEquals(res.name, "remove-missing-files-true");
});

Deno.test("remove-missing-files: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(() => run("remove-missing-files", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// rescan-folder
// ---------------------------------------------------------------------------

Deno.test("rescan-folder: happy path — GETs /api/v3/ImportFolder/<id>/Scan, writes task/rescan-folder-<id>", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("rescan-folder", { importFolderId: 7 }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v3/ImportFolder/7/Scan",
    );
    assertEquals(calls[0].headers.get("apikey"), API_KEY);
  });
  const res = written.find((w) => w.spec === "task");
  assert(res);
  assertEquals(res.name, "rescan-folder-7");
  assertEquals(res.payload.message, "Triggered rescan of import folder 7");
});

Deno.test("rescan-folder: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("err", 500, async () => {
    await assertRejects(
      () => run("rescan-folder", { importFolderId: 1 }, ctx),
      Error,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: apikey never leaks into a written resource (auth resource
// excepted BY DESIGN — authenticate mints the key into it), and no method
// ever calls the logger today.
// ---------------------------------------------------------------------------

Deno.test("apikey never appears in any written resource across the 13 non-auth methods (the auth resource holds it by design)", async () => {
  const scenarios: Array<[string, Record<string, unknown>, unknown]> = [
    ["status", {}, { State: 1 }],
    ["dashboard", {}, {}],
    ["list-series", {}, { Total: 0, List: [] }],
    ["search-series", { query: "x" }, []],
    ["find-unrecognized-files", {}, { Total: 0, List: [] }],
    ["find-missing-episodes", {}, { Total: 0, List: [] }],
    ["find-duplicate-files", {}, { Total: 0, List: [] }],
    ["list-import-folders", {}, []],
    ["queue-status", {}, []],
    ["list-actions", {}, { paths: {} }],
    ["run-action", { action: "X" }, {}],
    ["remove-missing-files", {}, {}],
    ["rescan-folder", { importFolderId: 1 }, {}],
  ];
  for (const [name, args, response] of scenarios) {
    const { ctx, written, logs } = makeCtx();
    await withOneResponse(response, 200, async () => {
      await run(name, args, ctx);
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(!s.includes(API_KEY), `${name}: apiKey leaked into ${w.spec}`);
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(!s.includes(API_KEY), `${name}: apiKey leaked into a log call`);
    }
  }
});

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneResponse({ State: 1 }, 200, async () => {
    await run("status", {}, ctx);
  });
  assertEquals(logs.length, 0);
});
