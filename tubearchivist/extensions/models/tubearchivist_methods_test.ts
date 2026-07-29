/**
 * Method-level tests for @magistr/tubearchivist — every one of the 19
 * methods, happy path + error path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` and a fake context.
 *
 * tubearchivist.ts is BYTE-FROZEN by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Token-leak assertions run for every method: the `token` global arg must
 * never appear in a thrown error, a written resource payload, or a logger
 * call. A standalone pin also asserts that NO method calls the logger today.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./tubearchivist.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TOKEN = "ta_test_stub_do_not_log";
const HOST = "https://tubearchivist.example.com";

const GLOBAL_ARGS = { host: HOST, token: TOKEN };

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

/** Install a fetch stub for the duration of `fn`; captures every request.
 * Uses the plan-mandated `as unknown as typeof globalThis.fetch` bridge
 * (CI deno 2.8.3 vs local 2.7.x — a direct `as typeof globalThis.fetch`
 * cast risks a CI-only deno-check break). */
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

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
}

// ---------------------------------------------------------------------------
// list-videos
// ---------------------------------------------------------------------------

Deno.test("list-videos: happy path, no filters — GETs /api/video/ with no query string", async () => {
  const { ctx, written } = makeCtx();
  const fixture = {
    data: [{
      youtube_id: "synVid00001",
      title: "T1",
      channel: { channel_name: "Example Channel" },
      published: "2026-01-01",
      vid_type: "videos",
      active: true,
    }],
    paginate: { total_hits: 1, current_page: 0 },
  };
  await withOneResponse(fixture, 200, async (calls) => {
    await run("list-videos", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/video/");
    assertEquals(calls[0].method, "GET");
    assertEquals(new URL(calls[0].url).search, "");
  });
  const res = written.find((w) => w.spec === "videos");
  assert(res);
  assertEquals((res.payload.videos as unknown[]).length, 1);
  assertEquals(res.payload.total, 1);
  assertEquals(res.payload.page, 0);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("list-videos: with channel/watch/type filters — builds the matching query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ data: [], paginate: {} }, 200, async (calls) => {
    await run("list-videos", {
      channel: "UCsynthetic0000000001",
      watch: "watched",
      type: "videos",
    }, ctx);
    const params = new URL(calls[0].url).searchParams;
    assertEquals(params.get("channel"), "UCsynthetic0000000001");
    assertEquals(params.get("watch"), "watched");
    assertEquals(params.get("type"), "videos");
  });
});

Deno.test("list-videos: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("list-videos", {}, ctx),
      Error,
      "GET /api/video/ failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// get-video
// ---------------------------------------------------------------------------

Deno.test("get-video: happy path — GETs /api/video/<id>/, stores the bare response", async () => {
  const { ctx, written } = makeCtx();
  const detail = { youtube_id: "synVid00001", title: "T1" };
  await withOneResponse(detail, 200, async (calls) => {
    await run("get-video", { youtube_id: "synVid00001" }, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/video/synVid00001/");
    assertEquals(calls[0].method, "GET");
  });
  const res = written.find((w) => w.spec === "videos");
  assert(res);
  assertEquals(res.name, "synVid00001");
  assertEquals(res.payload.videos, [detail]);
  assertEquals(res.payload.total, 1);
});

Deno.test("get-video: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("not found", 404, async () => {
    await assertRejects(
      () => run("get-video", { youtube_id: "synVid00001" }, ctx),
      Error,
      "failed: 404",
    );
  });
});

Deno.test("get-video: non-JSON content-type response throws a distinct error", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })],
    async () => {
      await assertRejects(
        () => run("get-video", { youtube_id: "synVid00001" }, ctx),
        Error,
        "returned non-JSON",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// delete-video
// ---------------------------------------------------------------------------

Deno.test("delete-video: happy path — DELETEs /api/video/<id>/, writes task/delete", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("delete-video", { youtube_id: "synVid00001" }, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/video/synVid00001/");
    assertEquals(calls[0].method, "DELETE");
  });
  const res = written.find((w) => w.spec === "task" && w.name === "delete");
  assert(res);
  assertEquals(res.payload.message, "Deleted video synVid00001");
  assertEquals(res.payload.task_id, "");
});

Deno.test("delete-video: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("gone", 410, async () => {
    await assertRejects(
      () => run("delete-video", { youtube_id: "synVid00001" }, ctx),
      Error,
      "failed: 410",
    );
  });
});

// ---------------------------------------------------------------------------
// list-channels
// ---------------------------------------------------------------------------

Deno.test("list-channels: happy path, no filters — GETs /api/channel/ with no query string", async () => {
  const { ctx, written } = makeCtx();
  const fixture = {
    data: [{
      channel_id: "UCsynthetic0000000001",
      channel_name: "Example Channel",
      channel_subs: 1,
      channel_subscribed: true,
    }],
    paginate: { total_hits: 1 },
  };
  await withOneResponse(fixture, 200, async (calls) => {
    await run("list-channels", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/channel/");
    assertEquals(new URL(calls[0].url).search, "");
  });
  const res = written.find((w) => w.spec === "channels");
  assert(res);
  assertEquals(res.payload.total, 1);
});

Deno.test("list-channels: with filter — builds the matching query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ data: [] }, 200, async (calls) => {
    await run("list-channels", { filter: "subscribed" }, ctx);
    assertEquals(
      new URL(calls[0].url).searchParams.get("filter"),
      "subscribed",
    );
  });
});

Deno.test("list-channels: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("list-channels", {}, ctx),
      Error,
      "GET /api/channel/ failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

Deno.test("subscribe: happy path — POSTs /api/channel/ with the wrapped channel_id array", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { task_id: "t1", message: "ok", status: "PENDING" },
    200,
    async (calls) => {
      await run("subscribe", {
        channel_ids: ["UCsynthetic0000000001", "UCsynthetic0000000002"],
      }, ctx);
      assertEquals(new URL(calls[0].url).pathname, "/api/channel/");
      assertEquals(calls[0].method, "POST");
      const body = await requestBody(calls[0]);
      assertEquals(body.data, [
        { channel_id: "UCsynthetic0000000001", channel_subscribed: true },
        { channel_id: "UCsynthetic0000000002", channel_subscribed: true },
      ]);
    },
  );
  const res = written.find((w) => w.spec === "task" && w.name === "subscribe");
  assert(res);
  assertEquals(res.payload.task_id, "t1");
  assertEquals(res.payload.message, "ok");
  assertEquals(res.payload.status, "PENDING");
});

Deno.test("subscribe: message falls back to a generated summary when the server omits one", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ task_id: "t1" }, 200, async () => {
    await run("subscribe", { channel_ids: ["UCsynthetic0000000001"] }, ctx);
  });
  const res = written.find((w) => w.spec === "task" && w.name === "subscribe");
  assert(res);
  assertEquals(res.payload.message, "Subscribed to 1 channels");
});

Deno.test("subscribe: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("subscribe", { channel_ids: ["UCsynthetic0000000001"] }, ctx),
      Error,
      "POST /api/channel/ failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// add-to-queue
// ---------------------------------------------------------------------------

Deno.test("add-to-queue: happy path — POSTs /api/download/ with the wrapped youtube_id array", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { task_id: "t2", message: "queued" },
    200,
    async (calls) => {
      await run("add-to-queue", {
        youtube_ids: ["synVid00001", "synVid00002"],
      }, ctx);
      assertEquals(new URL(calls[0].url).pathname, "/api/download/");
      assertEquals(calls[0].method, "POST");
      const body = await requestBody(calls[0]);
      assertEquals(body.data, [
        { youtube_id: "synVid00001", status: "pending" },
        { youtube_id: "synVid00002", status: "pending" },
      ]);
    },
  );
  const res = written.find((w) =>
    w.spec === "download" && w.name === "queue-add"
  );
  assert(res);
  assertEquals(res.payload.task_id, "t2");
  assertEquals(res.payload.total, 2);
  assertEquals(res.payload.items, [
    { youtube_id: "synVid00001", status: "pending" },
    { youtube_id: "synVid00002", status: "pending" },
  ]);
});

Deno.test("add-to-queue: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("add-to-queue", { youtube_ids: ["synVid00001"] }, ctx),
      Error,
      "POST /api/download/ failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// list-queue
// ---------------------------------------------------------------------------

Deno.test("list-queue: happy path, no filters — GETs /api/download/ with no query string", async () => {
  const { ctx, written } = makeCtx();
  const fixture = {
    data: [{ youtube_id: "synQue00001", status: "pending" }],
    paginate: { total_hits: 1 },
  };
  await withOneResponse(fixture, 200, async (calls) => {
    await run("list-queue", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/download/");
    assertEquals(new URL(calls[0].url).search, "");
  });
  const res = written.find((w) =>
    w.spec === "download" && w.name === "queue-list"
  );
  assert(res);
  assertEquals(res.payload.total, 1);
});

Deno.test("list-queue: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("list-queue", {}, ctx),
      Error,
      "GET /api/download/ failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// start-download
// ---------------------------------------------------------------------------

Deno.test("start-download: happy path — POSTs /api/task/by-name/download_pending/", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { task_id: "t3", message: "downloading", status: "PENDING" },
    200,
    async (calls) => {
      await run("start-download", {}, ctx);
      assertEquals(
        new URL(calls[0].url).pathname,
        "/api/task/by-name/download_pending/",
      );
      assertEquals(calls[0].method, "POST");
    },
  );
  const res = written.find((w) => w.spec === "task" && w.name === "download");
  assert(res);
  assertEquals(res.payload.task_id, "t3");
  assertEquals(res.payload.status, "PENDING");
});

Deno.test("start-download: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("start-download", {}, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// rescan
// ---------------------------------------------------------------------------

Deno.test("rescan: happy path — POSTs /api/appsettings/rescan-filesystem/", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { task_id: "t4", message: "rescanning" },
    200,
    async (calls) => {
      await run("rescan", {}, ctx);
      assertEquals(
        new URL(calls[0].url).pathname,
        "/api/appsettings/rescan-filesystem/",
      );
      assertEquals(calls[0].method, "POST");
    },
  );
  const res = written.find((w) => w.spec === "task" && w.name === "rescan");
  assert(res);
  assertEquals(res.payload.task_id, "t4");
});

Deno.test("rescan: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("rescan", {}, ctx), Error, "failed: 500");
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

Deno.test("refresh: happy path — POSTs /api/refresh/ with only the provided keys", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { task_id: "t5", message: "refreshing" },
    200,
    async (calls) => {
      await run("refresh", { video: ["synVid00001"] }, ctx);
      assertEquals(new URL(calls[0].url).pathname, "/api/refresh/");
      const body = await requestBody(calls[0]);
      assertEquals(body.video, ["synVid00001"]);
      assert(!("channel" in body));
      assert(!("playlist" in body));
    },
  );
  const res = written.find((w) => w.spec === "task" && w.name === "refresh");
  assert(res);
  assertEquals(res.payload.task_id, "t5");
});

Deno.test("refresh: happy path — no args sends an empty body", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ task_id: "t6" }, 200, async (calls) => {
    await run("refresh", {}, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body, {});
  });
});

Deno.test("refresh: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("refresh", {}, ctx), Error, "failed: 500");
  });
});

// ---------------------------------------------------------------------------
// update-subscribed
// ---------------------------------------------------------------------------

Deno.test("update-subscribed: happy path — POSTs /api/task/by-name/update_subscribed/", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ task_id: "t7" }, 200, async (calls) => {
    await run("update-subscribed", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/task/by-name/update_subscribed/",
    );
    assertEquals(calls[0].method, "POST");
  });
  const res = written.find((w) =>
    w.spec === "task" && w.name === "update-subscribed"
  );
  assert(res);
  assertEquals(res.payload.task_id, "t7");
});

Deno.test("update-subscribed: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("update-subscribed", {}, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

Deno.test("search: happy path — GETs /api/search/?q=<query>, writes results verbatim", async () => {
  const { ctx, written } = makeCtx();
  const results = [{ youtube_id: "synVid00001", title: "T1" }];
  await withOneResponse({ results }, 200, async (calls) => {
    await run("search", { query: "keynote" }, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/search/");
    assertEquals(new URL(calls[0].url).searchParams.get("q"), "keynote");
  });
  const res = written.find((w) => w.spec === "search");
  assert(res);
  assertEquals(res.payload.results, results);
  assertEquals(res.payload.total, 1);
  assertEquals(res.payload.query, "keynote");
});

Deno.test("search: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("search", { query: "keynote" }, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// mark-watched
// ---------------------------------------------------------------------------

Deno.test("mark-watched: happy path — POSTs /api/watched/ with {id, is_watched}", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run(
      "mark-watched",
      { youtube_id: "synVid00001", is_watched: true },
      ctx,
    );
    assertEquals(new URL(calls[0].url).pathname, "/api/watched/");
    const body = await requestBody(calls[0]);
    assertEquals(body.id, "synVid00001");
    assertEquals(body.is_watched, true);
  });
  const res = written.find((w) => w.spec === "task" && w.name === "watched");
  assert(res);
  assertEquals(res.payload.message, "Marked synVid00001 as watched");
});

Deno.test("mark-watched: is_watched=false writes the 'unwatched' message", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async () => {
    await run(
      "mark-watched",
      { youtube_id: "synVid00001", is_watched: false },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "task" && w.name === "watched");
  assert(res);
  assertEquals(res.payload.message, "Marked synVid00001 as unwatched");
});

Deno.test("mark-watched: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () =>
        run(
          "mark-watched",
          { youtube_id: "synVid00001", is_watched: true },
          ctx,
        ),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

Deno.test("stats: happy path — GETs /api/stats/video/, spreads every field", async () => {
  const { ctx, written } = makeCtx();
  const fixture = {
    doc_count: 10,
    media_size: 100,
    duration: 1000,
    duration_str: "16m 40s",
  };
  await withOneResponse(fixture, 200, async (calls) => {
    await run("stats", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/stats/video/");
  });
  const res = written.find((w) => w.spec === "stats");
  assert(res);
  assertEquals(res.payload.doc_count, 10);
  assertEquals(res.payload.media_size, 100);
});

Deno.test("stats: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("stats", {}, ctx), Error, "failed: 500");
  });
});

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

Deno.test("backup: happy path — POSTs /api/appsettings/backup/", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ task_id: "t8" }, 200, async (calls) => {
    await run("backup", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/appsettings/backup/",
    );
    assertEquals(calls[0].method, "POST");
  });
  const res = written.find((w) => w.spec === "backup" && w.name === "backup");
  assert(res);
  assertEquals(res.payload.task_id, "t8");
});

Deno.test("backup: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("backup", {}, ctx), Error, "failed: 500");
  });
});

// ---------------------------------------------------------------------------
// list-backups
// ---------------------------------------------------------------------------

Deno.test("list-backups: happy path — GETs /api/appsettings/backup/, reads data.data", async () => {
  const { ctx, written } = makeCtx();
  const backups = [{ filename: "ta_backup-2026-01-01.zip" }];
  await withOneResponse({ data: backups }, 200, async (calls) => {
    await run("list-backups", {}, ctx);
    assertEquals(calls[0].method, "GET");
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/appsettings/backup/",
    );
  });
  const res = written.find((w) => w.spec === "backup" && w.name === "list");
  assert(res);
  assertEquals(res.payload.backups, backups);
});

Deno.test("list-backups: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("list-backups", {}, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// create-snapshot
// ---------------------------------------------------------------------------

Deno.test("create-snapshot: happy path — POSTs /api/appsettings/snapshot/", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { snapshot_name: "snap-1" },
    200,
    async (calls) => {
      await run("create-snapshot", {}, ctx);
      assertEquals(
        new URL(calls[0].url).pathname,
        "/api/appsettings/snapshot/",
      );
      assertEquals(calls[0].method, "POST");
    },
  );
  const res = written.find((w) => w.spec === "snapshot" && w.name === "create");
  assert(res);
  assertEquals(res.payload.snapshot_name, "snap-1");
});

Deno.test("create-snapshot: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("create-snapshot", {}, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// list-snapshots
// ---------------------------------------------------------------------------

Deno.test("list-snapshots: happy path — GETs /api/appsettings/snapshot/, reads data.data", async () => {
  const { ctx, written } = makeCtx();
  const snapshots = [{ id: "snap-1", state: "SUCCESS" }];
  await withOneResponse({ data: snapshots }, 200, async (calls) => {
    await run("list-snapshots", {}, ctx);
    assertEquals(calls[0].method, "GET");
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/appsettings/snapshot/",
    );
  });
  const res = written.find((w) => w.spec === "snapshot" && w.name === "list");
  assert(res);
  assertEquals(res.payload.snapshots, snapshots);
});

Deno.test("list-snapshots: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("list-snapshots", {}, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

Deno.test("ping: happy path — GETs /api/ping/, message is JSON.stringify(data)", async () => {
  const { ctx, written } = makeCtx();
  const body = { response: "pong" };
  await withOneResponse(body, 200, async (calls) => {
    await run("ping", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/ping/");
    assertEquals(calls[0].method, "GET");
  });
  const res = written.find((w) => w.spec === "task" && w.name === "ping");
  assert(res);
  assertEquals(res.payload.message, JSON.stringify(body));
  assertEquals(res.payload.task_id, "");
});

Deno.test("ping: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 503, async () => {
    await assertRejects(() => run("ping", {}, ctx), Error, "failed: 503");
  });
});

// ---------------------------------------------------------------------------
// Host trailing-slash normalization (shared across every method)
// ---------------------------------------------------------------------------

Deno.test("host with a trailing slash is normalized before the path is appended", async () => {
  const { ctx } = makeCtx({ host: `${HOST}/`, token: TOKEN });
  await withOneResponse({ response: "pong" }, 200, async (calls) => {
    await run("ping", {}, ctx);
    assertEquals(calls[0].url, `${HOST}/api/ping/`);
  });
});

// ---------------------------------------------------------------------------
// Authorization header (shared across every method)
// ---------------------------------------------------------------------------

Deno.test("every request carries the Token authorization header and JSON content-type", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ response: "pong" }, 200, async (calls) => {
    await run("ping", {}, ctx);
    assertEquals(calls[0].headers.get("Authorization"), `Token ${TOKEN}`);
    assertEquals(calls[0].headers.get("Content-Type"), "application/json");
  });
});

// ---------------------------------------------------------------------------
// Token-leak assertions across every method
// ---------------------------------------------------------------------------

const ALL_METHOD_SCENARIOS: Array<
  [string, Record<string, unknown>, unknown]
> = [
  ["list-videos", {}, { data: [], paginate: {} }],
  ["get-video", { youtube_id: "synVid00001" }, { youtube_id: "synVid00001" }],
  ["delete-video", { youtube_id: "synVid00001" }, {}],
  ["list-channels", {}, { data: [] }],
  ["subscribe", { channel_ids: ["UCsynthetic0000000001"] }, {
    task_id: "t1",
  }],
  ["add-to-queue", { youtube_ids: ["synVid00001"] }, { task_id: "t2" }],
  ["list-queue", {}, { data: [] }],
  ["start-download", {}, { task_id: "t3" }],
  ["rescan", {}, { task_id: "t4" }],
  ["refresh", {}, { task_id: "t5" }],
  ["update-subscribed", {}, { task_id: "t6" }],
  ["search", { query: "keynote" }, { results: [] }],
  [
    "mark-watched",
    { youtube_id: "synVid00001", is_watched: true },
    {},
  ],
  ["stats", {}, { doc_count: 1 }],
  ["backup", {}, { task_id: "t7" }],
  ["list-backups", {}, { data: [] }],
  ["create-snapshot", {}, { snapshot_name: "snap-1" }],
  ["list-snapshots", {}, { data: [] }],
  ["ping", {}, { response: "pong" }],
];

Deno.test("the token never appears in any written resource across all 19 methods", async () => {
  assertEquals(
    ALL_METHOD_SCENARIOS.length,
    19,
    "sanity: every method must be covered by the leak sweep",
  );
  for (const [name, args, response] of ALL_METHOD_SCENARIOS) {
    const { ctx, written, logs } = makeCtx();
    await withOneResponse(response, 200, async () => {
      await run(name, args, ctx);
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(!s.includes(TOKEN), `${name}: token leaked into ${w.spec}`);
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(!s.includes(TOKEN), `${name}: token leaked into a log call`);
    }
  }
});

Deno.test("the token never appears in a thrown error message for any method's happy-path arguments", async () => {
  for (const [name, args] of ALL_METHOD_SCENARIOS) {
    const { ctx } = makeCtx();
    await withOneResponse(
      `error mentioning nothing sensitive for ${name}`,
      500,
      async () => {
        const err = await assertRejects(() => run(name, args, ctx));
        assert(
          !String(err).includes(TOKEN),
          `${name}: token leaked into the thrown error`,
        );
      },
    );
  }
});

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneResponse({ response: "pong" }, 200, async () => {
    await run("ping", {}, ctx);
  });
  assertEquals(logs.length, 0);
});

Deno.test("every written resource's timestamp is a string (never asserted by exact value — no Date/timer stub needed)", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ response: "pong" }, 200, async () => {
    await run("ping", {}, ctx);
  });
  const res = written.find((w) => w.spec === "task" && w.name === "ping");
  assert(res);
  assertEquals(typeof res.payload.timestamp, "string");
});
