/**
 * Coverage suite: sweeps every guard/branch in tubearchivist.ts that the
 * methods and adversarial suites don't already exercise on both sides, so
 * deleting any one of these guards turns a test red (STANDARD.md's coverage
 * role — a behavioral regression guard, not a numeric percentage).
 *
 * tubearchivist.ts is BYTE-FROZEN; every test PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { model } from "./tubearchivist.ts";

const GLOBAL_ARGS = {
  host: "https://tubearchivist.example.com",
  token: "ta_stub",
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

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
}

// --- Guard: list-videos `if (args.page)` — page=0 is DROPPED (falsy) -------

Deno.test("list-videos: page=0 is DROPPED from the query string (falsy check, not presence check)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ data: [], paginate: {} })],
    async (calls) => {
      await run("list-videos", { page: 0 }, ctx);
      assertEquals(new URL(calls[0].url).search, "");
    },
  );
});

Deno.test("list-videos: page=1 (truthy) IS included in the query string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ data: [], paginate: {} })],
    async (calls) => {
      await run("list-videos", { page: 1 }, ctx);
      assertEquals(new URL(calls[0].url).searchParams.get("page"), "1");
    },
  );
});

Deno.test("list-videos: page omitted -> no page key at all in the query string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ data: [], paginate: {} })],
    async (calls) => {
      await run("list-videos", {}, ctx);
      assert(!new URL(calls[0].url).searchParams.has("page"));
    },
  );
});

// --- Guard: list-channels / list-queue share the identical page=0 drop -----

Deno.test("list-channels: page=0 is DROPPED from the query string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ data: [] })], async (calls) => {
    await run("list-channels", { page: 0 }, ctx);
    assertEquals(new URL(calls[0].url).search, "");
  });
});

Deno.test("list-queue: page=0 is DROPPED from the query string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ data: [] })], async (calls) => {
    await run("list-queue", { page: 0 }, ctx);
    assertEquals(new URL(calls[0].url).search, "");
  });
});

Deno.test("list-queue: page=2 (truthy) IS included in the query string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ data: [] })], async (calls) => {
    await run("list-queue", { page: 2 }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("page"), "2");
  });
});

// --- Guard: list-videos filter params — each present/absent independently -

Deno.test("list-videos: channel/watch/type each independently omitted are absent from the query string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ data: [], paginate: {} })],
    async (calls) => {
      await run("list-videos", { watch: "unwatched" }, ctx);
      const params = new URL(calls[0].url).searchParams;
      assert(!params.has("channel"));
      assertEquals(params.get("watch"), "unwatched");
      assert(!params.has("type"));
    },
  );
});

// --- Guard: `data.paginate?.total_hits || videos.length` — both sides -----

Deno.test("list-videos: paginate ABSENT entirely -> total falls back to videos.length", async () => {
  const { ctx, written } = makeCtx();
  const videos = [{
    youtube_id: "synVid00001",
    title: "T",
    channel: {},
    published: "2026-01-01",
    vid_type: "videos",
    active: true,
  }];
  await withFetchStub([() => json({ data: videos })], async () => {
    await run("list-videos", {}, ctx);
  });
  const res = written.find((w) => w.spec === "videos")!;
  assertEquals(res.payload.total, 1);
  assertEquals(res.payload.page, 0);
});

Deno.test("list-videos: paginate.total_hits=0 (falsy) falls back to videos.length, NOT the explicit 0", async () => {
  // `data.paginate?.total_hits || videos.length` treats an explicit 0 the
  // same as absent — a real total of 0 hits collapses into whatever
  // videos.length happens to be (here, 1, since the fixture still returned
  // one video despite total_hits:0). Documented gap, not fixed here.
  const { ctx, written } = makeCtx();
  const videos = [{
    youtube_id: "synVid00001",
    title: "T",
    channel: {},
    published: "2026-01-01",
    vid_type: "videos",
    active: true,
  }];
  await withFetchStub(
    [() =>
      json({ data: videos, paginate: { total_hits: 0, current_page: 0 } })],
    async () => {
      await run("list-videos", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "videos")!;
  assertEquals(
    res.payload.total,
    1,
    "explicit total_hits:0 is silently overridden by videos.length",
  );
});

// --- Guard: `v.channel?.channel_name || ""` fallback -----------------------

Deno.test("list-videos: a video with NO channel object -> channel_name falls back to ''", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      json({
        data: [{
          youtube_id: "synVid00001",
          title: "T",
          published: "2026-01-01",
          vid_type: "videos",
          active: true,
        }],
        paginate: {},
      })],
    async () => {
      await run("list-videos", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "videos")!;
  const videos = res.payload.videos as Array<Record<string, unknown>>;
  assertEquals(videos[0].channel_name, "");
});

Deno.test("list-videos: a video WITH a channel object uses channel.channel_name", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      json({
        data: [{
          youtube_id: "synVid00001",
          title: "T",
          channel: { channel_name: "Named Channel" },
          published: "2026-01-01",
          vid_type: "videos",
          active: true,
        }],
        paginate: {},
      })],
    async () => {
      await run("list-videos", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "videos")!;
  const videos = res.payload.videos as Array<Record<string, unknown>>;
  assertEquals(videos[0].channel_name, "Named Channel");
});

// --- Guard: search's `data.results || data.data || []` triple fallback ----

Deno.test("search: results PRESENT (even empty array) is used as-is, never falls through to data.data", async () => {
  // An empty array is TRUTHY in JS — `[] || data.data` short-circuits on the
  // empty array itself, so `results: []` does NOT fall through to data.data
  // even though it is semantically "no results".
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ results: [], data: [{ should: "not appear" }] })],
    async () => {
      await run("search", { query: "q" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, []);
  assertEquals(res.payload.total, 0);
});

Deno.test("search: results ABSENT (undefined) falls through to data.data", async () => {
  const { ctx, written } = makeCtx();
  const data = [{ youtube_id: "synVid00001" }];
  await withFetchStub([() => json({ data })], async () => {
    await run("search", { query: "q" }, ctx);
  });
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, data);
  assertEquals(res.payload.total, 1);
});

Deno.test("search: both results and data ABSENT falls through to []", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({})], async () => {
    await run("search", { query: "q" }, ctx);
  });
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, []);
  assertEquals(res.payload.total, 0);
});

Deno.test("search: results is explicitly null (falsy) falls through to data.data", async () => {
  const { ctx, written } = makeCtx();
  const data = [{ youtube_id: "synVid00001" }];
  await withFetchStub([() => json({ results: null, data })], async () => {
    await run("search", { query: "q" }, ctx);
  });
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, data);
});

// --- Guard: list-backups/list-snapshots `data.data || data || []` ---------

Deno.test("list-backups: data.data ABSENT, response is a bare array -> the bare array itself is used (via the `data` fallback)", async () => {
  const { ctx, written } = makeCtx();
  const bareArray = [{ filename: "ta_backup-2026-02-01.zip" }];
  await withFetchStub([() => json(bareArray)], async () => {
    await run("list-backups", {}, ctx);
  });
  const res = written.find((w) => w.spec === "backup" && w.name === "list")!;
  assertEquals(res.payload.backups, bareArray);
});

Deno.test("list-backups: data.data ABSENT, response is a non-array object -> the WHOLE response object becomes `backups` (documented gap)", async () => {
  // `data.data || data || []`: when the response has no `data` key at all,
  // the fallback lands on `data` itself — the entire parsed response object,
  // not an array. This is arguably wrong (the resource schema expects an
  // array-shaped backups list) but it is the byte-frozen source's actual
  // behavior, so it is pinned rather than silently tightened.
  const { ctx, written } = makeCtx();
  const weirdResponse = { unexpected: "shape", not_data: true };
  await withFetchStub([() => json(weirdResponse)], async () => {
    await run("list-backups", {}, ctx);
  });
  const res = written.find((w) => w.spec === "backup" && w.name === "list")!;
  assertEquals(res.payload.backups, weirdResponse);
});

Deno.test("list-snapshots: data.data PRESENT is used, never falls through", async () => {
  const { ctx, written } = makeCtx();
  const snaps = [{ id: "snap-x" }];
  await withFetchStub(
    [() => json({ data: snaps, extra: "ignored" })],
    async () => {
      await run("list-snapshots", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "snapshot" && w.name === "list")!;
  assertEquals(res.payload.snapshots, snaps);
});

Deno.test("list-snapshots: data.data ABSENT, response is a bare array -> the bare array itself is used", async () => {
  const { ctx, written } = makeCtx();
  const bareArray = [{ id: "snap-y" }];
  await withFetchStub([() => json(bareArray)], async () => {
    await run("list-snapshots", {}, ctx);
  });
  const res = written.find((w) => w.spec === "snapshot" && w.name === "list")!;
  assertEquals(res.payload.snapshots, bareArray);
});

// --- Guard: `data.task_id || ""` fallback (repeats across many methods) ---

Deno.test("subscribe: task_id PRESENT is kept verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ task_id: "task-abc" })], async () => {
    await run("subscribe", { channel_ids: ["UCsynthetic0000000001"] }, ctx);
  });
  const res = written.find((w) => w.spec === "task" && w.name === "subscribe")!;
  assertEquals(res.payload.task_id, "task-abc");
});

Deno.test("subscribe: task_id ABSENT falls back to '' (same guard shape repeats in start-download/rescan/refresh/update-subscribed/backup)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({})], async () => {
    await run("subscribe", { channel_ids: ["UCsynthetic0000000001"] }, ctx);
  });
  const res = written.find((w) => w.spec === "task" && w.name === "subscribe")!;
  assertEquals(res.payload.task_id, "");
});

Deno.test("backup: task_id ABSENT falls back to ''", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({})], async () => {
    await run("backup", {}, ctx);
  });
  const res = written.find((w) => w.spec === "backup" && w.name === "backup")!;
  assertEquals(res.payload.task_id, "");
});

Deno.test("backup: task_id PRESENT is kept verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ task_id: "task-xyz" })], async () => {
    await run("backup", {}, ctx);
  });
  const res = written.find((w) => w.spec === "backup" && w.name === "backup")!;
  assertEquals(res.payload.task_id, "task-xyz");
});

// --- Guard: subscribe's message fallback vs add-to-queue's NO fallback ----

Deno.test("subscribe: message='' (falsy, explicit empty string) ALSO falls back to the generated summary", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ message: "" })], async () => {
    await run("subscribe", { channel_ids: ["UCsynthetic0000000001"] }, ctx);
  });
  const res = written.find((w) => w.spec === "task" && w.name === "subscribe")!;
  assertEquals(res.payload.message, "Subscribed to 1 channels");
});

Deno.test("add-to-queue: message is `data.message` with NO fallback default — undefined stays undefined (asymmetric with subscribe)", async () => {
  // Pin: unlike subscribe (`data.message || "Subscribed to N channels"`),
  // add-to-queue writes `message: data.message` verbatim with no `||`
  // fallback at all. An absent message on the response stays `undefined` in
  // the written resource rather than getting a generated summary.
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ task_id: "t" })], async () => {
    await run("add-to-queue", { youtube_ids: ["synVid00001"] }, ctx);
  });
  const res = written.find((w) =>
    w.spec === "download" && w.name === "queue-add"
  )!;
  assertEquals(res.payload.message, undefined);
});

// --- Guard: refresh's body keys present iff the corresponding arg is given -

Deno.test("refresh: video/channel/playlist each independently included when provided", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({})], async (calls) => {
    await run("refresh", { channel: ["UCsynthetic0000000001"] }, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body.channel, ["UCsynthetic0000000001"]);
    assert(!("video" in body));
    assert(!("playlist" in body));
  });
});

Deno.test("refresh: playlist included when provided, video/channel omitted", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({})], async (calls) => {
    await run("refresh", { playlist: ["PLsynthetic00001"] }, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body.playlist, ["PLsynthetic00001"]);
    assert(!("video" in body));
    assert(!("channel" in body));
  });
});

Deno.test("refresh: an EMPTY array argument is still truthy — `if (args.video)` includes it in the body", async () => {
  // `if (args.video) body.video = args.video` is a truthy check, and arrays
  // are always truthy in JS regardless of length — so an explicit empty
  // array `video: []` IS included in the body, unlike `page: 0` elsewhere in
  // this source which uses the same truthy-check shape but on a number.
  const { ctx } = makeCtx();
  await withFetchStub([() => json({})], async (calls) => {
    await run("refresh", { video: [] }, ctx);
    const body = await requestBody(calls[0]);
    assert("video" in body, "an empty array is truthy — the key IS included");
    assertEquals(body.video, []);
  });
});

// --- Security-review finding: token is NOT marked sensitive ---------------

Deno.test("pin: `token` is NOT marked `.meta({ sensitive: true })` today — documented security-hardening gap", () => {
  // The plan v2 security-review HIGH finding: token is a Token-auth
  // credential but GlobalArgsSchema never calls `.meta({ sensitive: true })`
  // on it, so swamp CLI/log surfaces can render it in cleartext. This is a
  // real gap surfaced during the test-backfill security review, but
  // tubearchivist.ts is deliberately BYTE-FROZEN by this change (no manifest
  // version bump; test-authoring only) — fixing it belongs to a follow-up
  // hardening issue. This test pins the CURRENT (regrettable) state so a
  // future fix flips it from failing to passing, rather than silently
  // slipping by unnoticed. Mirrors porkbun_coverage_test.ts's
  // apiKey/secretApiKey sensitive-meta pin.
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.token) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    undefined,
    "token is not yet marked sensitive — if this starts failing, " +
      "tubearchivist.ts added the annotation; update this pin to assert true",
  );
});

Deno.test("every documented enum value is still accepted by the schema (watch, type, filter)", () => {
  const listVideos = (model.methods as MethodMap)["list-videos"];
  for (const watch of ["watched", "unwatched"]) {
    assertEquals(
      (listVideos.arguments.parse({ watch }) as { watch: string }).watch,
      watch,
    );
  }
  for (const type of ["videos", "streams", "shorts"]) {
    assertEquals(
      (listVideos.arguments.parse({ type }) as { type: string }).type,
      type,
    );
  }
  const listChannels = (model.methods as MethodMap)["list-channels"];
  for (const filter of ["subscribed", "unsubscribed"]) {
    assertEquals(
      (listChannels.arguments.parse({ filter }) as { filter: string }).filter,
      filter,
    );
  }
});
