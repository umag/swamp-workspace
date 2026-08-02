/**
 * Method-level tests for @magistr/lastfm. All network traffic is intercepted
 * by stubbing `globalThis.fetch`; no test may reach the real API (the default
 * `deno task test` runs without --allow-net, so a leak fails loudly).
 *
 * Invariants under test (from approved plan v3):
 *  - every request is https, carries method/api_key/format=json, and the
 *    documented per-method parameters
 *  - the api_key never appears in a written resource
 *  - `period` is a closed enum; out-of-range limit/page are rejected
 *  - `user` is constrained to the Last.fm username charset
 *  - sync-history pins `to` for the whole walk (page-drift defence)
 *  - sync-history writes one scrobbles.<year> resource per calendar year
 *  - sync-history is idempotent: a second run over the same data is a no-op
 *
 * Method arguments are always parsed THROUGH the zod `arguments` schema before
 * execute() — swamp strips any argument the schema omits, so calling execute()
 * directly would hide that entire bug class.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./lastfm.ts";

const KEY = "0123456789abcdef0123456789abcdef";
const GLOBAL_ARGS = { user: "u3BpaT", apiKey: KEY };

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(
  globalArgs: Record<string, unknown> = GLOBAL_ARGS,
  /**
   * Optional resource store. Supplying it exercises the resume-from-cursor
   * branch of sync-history; omitting it exercises the full-walk fallback for
   * drivers that do not offer readResource.
   */
  store?: Record<string, Record<string, unknown>> | "reject",
) {
  const written: Written[] = [];
  const logs: string[] = [];
  const ctx: Record<string, unknown> = {
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
      info: (m: string) => logs.push(m),
      warning: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
  };
  if (store === "reject") {
    ctx.readResource = () => Promise.reject(new Error("no such resource"));
  } else if (store) {
    ctx.readResource = (name: string) => Promise.resolve(store[name] ?? null);
  }
  return { written, logs, ctx };
}

/** Mirror the swamp runtime: schema-parse arguments, then execute. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

/** Parse arguments only — for assertions about schema rejection. */
function parseArgs(name: string, args: Record<string, unknown>) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
  }>)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.arguments.parse(args);
}

async function withFetchStub(
  handler: (url: URL) => unknown,
  fn: (urls: URL[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = ((input: Request | URL | string) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    urls.push(url);
    const body = handler(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    await fn(urls);
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// Transport invariants
// ---------------------------------------------------------------------------

Deno.test("every request is https and carries api_key + format=json", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    () => ({ user: { name: "u3BpaT", playcount: "17004" } }),
    async (urls) => {
      await run("profile", {}, ctx);
      assertEquals(urls.length, 1);
      assertEquals(urls[0].protocol, "https:");
      assertEquals(urls[0].searchParams.get("method"), "user.getInfo");
      assertEquals(urls[0].searchParams.get("api_key"), KEY);
      assertEquals(urls[0].searchParams.get("format"), "json");
      assertEquals(urls[0].searchParams.get("user"), "u3BpaT");
    },
  );
});

Deno.test("a non-https baseUrl override is rejected, not requested", async () => {
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    baseUrl: "http://ws.audioscrobbler.com/2.0/",
  });
  await withFetchStub(
    () => ({ user: { name: "u3BpaT" } }),
    async (urls) => {
      await assertRejects(() => run("profile", {}, ctx) as Promise<unknown>);
      assertEquals(urls.length, 0, "must not issue the request at all");
    },
  );
});

Deno.test("the api_key never reaches a written resource", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    () => ({ user: { name: "u3BpaT", playcount: "17004" } }),
    async () => {
      await run("profile", {}, ctx);
      const blob = JSON.stringify(written);
      assert(!blob.includes(KEY), "api_key leaked into a resource");
    },
  );
});

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

Deno.test("period is a closed enum — garbage is rejected at the boundary", () => {
  for (
    const p of ["overall", "7day", "1month", "3month", "6month", "12month"]
  ) {
    parseArgs("top-artists", { period: p });
  }
  let threw = false;
  try {
    parseArgs("top-artists", { period: "1week" });
  } catch {
    threw = true;
  }
  assert(threw, "an out-of-enum period must be rejected, not coerced");
});

Deno.test("limit is bounded to the API maximum of 200", () => {
  parseArgs("top-artists", { limit: 200 });
  let threw = false;
  try {
    parseArgs("top-artists", { limit: 201 });
  } catch {
    threw = true;
  }
  assert(threw, "limit above 200 must be rejected, not silently clamped");
});

Deno.test("page must be a positive integer", () => {
  parseArgs("top-artists", { page: 1 });
  let threw = false;
  try {
    parseArgs("top-artists", { page: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "page 0 must be rejected");
});

Deno.test("user override is constrained to the Last.fm username charset", () => {
  parseArgs("profile", { user: "u3BpaT" });
  for (const bad of ["has space", "semi;colon", "a".repeat(16)]) {
    let threw = false;
    try {
      parseArgs("profile", { user: bad });
    } catch {
      threw = true;
    }
    assert(threw, `username ${JSON.stringify(bad)} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/**
 * Every remaining method, asserted on the three things a wrapper can get
 * wrong: which API method it calls, which parameters it forwards, and which
 * resource spec it writes. Without this table, 9 of 13 methods were reachable
 * only through the type checker.
 */
const METHOD_TABLE: Array<{
  method: string;
  args: Record<string, unknown>;
  apiMethod: string;
  spec: string;
  body: unknown;
  expectParams?: Record<string, string>;
}> = [
  {
    method: "loved-tracks",
    args: { limit: 10 },
    apiMethod: "user.getLovedTracks",
    spec: "loved",
    body: {
      lovedtracks: {
        "@attr": { user: "u3BpaT", total: "12" },
        track: [{ name: "I", artist: { name: "Fief" }, date: { uts: "1" } }],
      },
    },
    expectParams: { limit: "10" },
  },
  {
    method: "artist-info",
    args: { artist: "Fief" },
    apiMethod: "artist.getInfo",
    spec: "entity",
    body: {
      artist: {
        name: "Fief",
        stats: { listeners: "100", playcount: "500", userplaycount: "18" },
        tags: { tag: [{ name: "dungeon synth" }] },
      },
    },
    expectParams: { artist: "Fief", username: "u3BpaT" },
  },
  {
    method: "album-info",
    args: { artist: "Fief", album: "II" },
    apiMethod: "album.getInfo",
    spec: "entity",
    body: { album: { name: "II", artist: "Fief", userplaycount: "9" } },
    expectParams: { artist: "Fief", album: "II", username: "u3BpaT" },
  },
  {
    method: "track-info",
    args: { artist: "Fief", track: "I" },
    apiMethod: "track.getInfo",
    spec: "entity",
    body: {
      track: { name: "I", artist: { name: "Fief" }, userplaycount: "3" },
    },
    expectParams: { artist: "Fief", track: "I", username: "u3BpaT" },
  },
  {
    method: "top-albums",
    args: { period: "3month" },
    apiMethod: "user.getTopAlbums",
    spec: "chart",
    body: {
      topalbums: {
        "@attr": { page: "1", totalPages: "1" },
        album: [{ name: "II", artist: { name: "Fief" }, playcount: "9" }],
      },
    },
    expectParams: { period: "3month" },
  },
  {
    method: "top-tracks",
    args: { period: "12month" },
    apiMethod: "user.getTopTracks",
    spec: "chart",
    body: {
      toptracks: {
        "@attr": { page: "1", totalPages: "1" },
        track: [{ name: "I", artist: { name: "Fief" }, playcount: "4" }],
      },
    },
    expectParams: { period: "12month" },
  },
  {
    method: "weekly-chart-list",
    args: {},
    apiMethod: "user.getWeeklyChartList",
    spec: "weekly",
    body: {
      weeklychartlist: { chart: [{ from: "1000", to: "2000" }] },
    },
  },
  {
    method: "weekly-artist-chart",
    args: { from: 1000, to: 2000 },
    apiMethod: "user.getWeeklyArtistChart",
    spec: "chart",
    body: { weeklyartistchart: { artist: [{ name: "Fief", playcount: "3" }] } },
    expectParams: { from: "1000", to: "2000" },
  },
  {
    method: "weekly-album-chart",
    args: { from: 1000, to: 2000 },
    apiMethod: "user.getWeeklyAlbumChart",
    spec: "chart",
    body: {
      weeklyalbumchart: {
        album: [{ name: "II", artist: { name: "Fief" }, playcount: "3" }],
      },
    },
    expectParams: { from: "1000", to: "2000" },
  },
  {
    method: "weekly-track-chart",
    args: { from: 1000, to: 2000 },
    apiMethod: "user.getWeeklyTrackChart",
    spec: "chart",
    body: {
      weeklytrackchart: {
        track: [{ name: "I", artist: { name: "Fief" }, playcount: "3" }],
      },
    },
    expectParams: { from: "1000", to: "2000" },
  },
];

for (const entry of METHOD_TABLE) {
  Deno.test(`${entry.method} calls ${entry.apiMethod} and writes a ${entry.spec} resource`, async () => {
    const { ctx, written } = makeCtx();
    await withFetchStub(
      () => entry.body,
      async (urls) => {
        await run(entry.method, entry.args, ctx);
        assertEquals(urls.length, 1);
        assertEquals(urls[0].protocol, "https:");
        assertEquals(urls[0].searchParams.get("method"), entry.apiMethod);
        assertEquals(urls[0].searchParams.get("format"), "json");
        for (const [k, v] of Object.entries(entry.expectParams ?? {})) {
          assertEquals(urls[0].searchParams.get(k), v, `param ${k}`);
        }
        assertEquals(written.length, 1);
        assertEquals(written[0].spec, entry.spec);
        assert(!JSON.stringify(written).includes(KEY), "api_key leaked");
      },
    );
  });
}

Deno.test("top-artists sends the period and writes a chart resource", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    () => ({
      topartists: {
        "@attr": { user: "u3BpaT", page: "1", totalPages: "1" },
        artist: [{
          name: "Fief",
          playcount: "18",
          mbid: "",
          "@attr": { rank: "1" },
        }],
      },
    }),
    async (urls) => {
      await run("top-artists", { period: "7day" }, ctx);
      assertEquals(urls[0].searchParams.get("method"), "user.getTopArtists");
      assertEquals(urls[0].searchParams.get("period"), "7day");
      assertEquals(written.length, 1);
      assertEquals(written[0].spec, "chart");
    },
  );
});

// ---------------------------------------------------------------------------
// sync-history
// ---------------------------------------------------------------------------

const UTS_2007 = Date.UTC(2007, 2, 5) / 1000;
const UTS_2008 = Date.UTC(2008, 0, 2) / 1000;

function recentPage(
  tracks: Array<{ uts: number; artist: string; track: string }>,
  page: number,
  totalPages: number,
) {
  return {
    recenttracks: {
      "@attr": {
        user: "u3BpaT",
        page: String(page),
        totalPages: String(totalPages),
      },
      track: tracks.map((t) => ({
        artist: { "#text": t.artist, mbid: "" },
        name: t.track,
        date: { uts: String(t.uts) },
      })),
    },
  };
}

Deno.test("sync-history pins `to` across every page of the walk", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    (url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return recentPage(
        [{ uts: UTS_2008 - page, artist: "A", track: `t${page}` }],
        page,
        3,
      );
    },
    async (urls) => {
      await run("sync-history", {}, ctx);
      assert(
        urls.length >= 3,
        `expected a multi-page walk, got ${urls.length}`,
      );
      const tos = new Set(urls.map((u) => u.searchParams.get("to")));
      assertEquals(tos.size, 1, "`to` must be identical on every page");
      assert([...tos][0], "`to` must actually be set");
    },
  );
});

Deno.test("sync-history writes one scrobbles.<year> resource per calendar year", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    () =>
      recentPage(
        [
          { uts: UTS_2007, artist: "A", track: "t1" },
          { uts: UTS_2008, artist: "B", track: "t2" },
        ],
        1,
        1,
      ),
    async () => {
      await run("sync-history", {}, ctx);
      const names = written.filter((w) => w.spec === "scrobbles").map((w) =>
        w.name
      )
        .sort();
      assertEquals(names, ["scrobbles.2007", "scrobbles.2008"]);
    },
  );
});

Deno.test("sync-history excludes the now-playing track from history", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    () => ({
      recenttracks: {
        "@attr": { user: "u3BpaT", page: "1", totalPages: "1" },
        track: [
          {
            "@attr": { nowplaying: "true" },
            artist: { "#text": "Eldamar" },
            name: "Akt III",
          },
          {
            artist: { "#text": "Fief" },
            name: "I",
            date: { uts: String(UTS_2008) },
          },
        ],
      },
    }),
    async () => {
      await run("sync-history", {}, ctx);
      const chunks = written.filter((w) => w.spec === "scrobbles");
      const all = chunks.flatMap((c) =>
        (c.payload.scrobbles as Array<{ track: string }>) ?? []
      );
      assertEquals(all.length, 1);
      assertEquals(all[0].track, "I");
    },
  );
});

// --- the resume-from-cursor branch ----------------------------------------

Deno.test("sync-history resumes from the stored cursor when readResource exists", async () => {
  const priorUts = UTS_2008 - 500;
  const { ctx } = makeCtx(GLOBAL_ARGS, {
    "history.u3BpaT": { user: "u3BpaT", lastUts: priorUts },
  });
  await withFetchStub(
    () => recentPage([{ uts: UTS_2008, artist: "A", track: "t1" }], 1, 1),
    async (urls) => {
      await run("sync-history", {}, ctx);
      assertEquals(
        urls[0].searchParams.get("from"),
        String(priorUts + 1),
        "must resume just past the stored cursor, not re-walk from zero",
      );
    },
  );
});

Deno.test("sync-history omits `from` entirely when there is no prior cursor", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS, {});
  await withFetchStub(
    () => recentPage([{ uts: UTS_2008, artist: "A", track: "t1" }], 1, 1),
    async (urls) => {
      await run("sync-history", {}, ctx);
      assertEquals(urls[0].searchParams.get("from"), null);
    },
  );
});

Deno.test("sync-history survives a readResource that rejects", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS, "reject");
  await withFetchStub(
    () => recentPage([{ uts: UTS_2008, artist: "A", track: "t1" }], 1, 1),
    async (urls) => {
      await run("sync-history", {}, ctx);
      assertEquals(
        urls[0].searchParams.get("from"),
        null,
        "falls back to a full walk",
      );
      assert(
        written.find((w) => w.spec === "history"),
        "the walk still completes",
      );
    },
  );
});

Deno.test("sync-history: an explicit `from` overrides the stored cursor", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS, {
    "history.u3BpaT": { user: "u3BpaT", lastUts: UTS_2008 },
  });
  await withFetchStub(
    () => recentPage([{ uts: UTS_2008, artist: "A", track: "t1" }], 1, 1),
    async (urls) => {
      await run("sync-history", { from: 1234 }, ctx);
      assertEquals(urls[0].searchParams.get("from"), "1235");
    },
  );
});

Deno.test("sync-history: resyncYear rewinds the cursor to that year's start", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS, {
    "history.u3BpaT": { user: "u3BpaT", lastUts: UTS_2008 },
  });
  await withFetchStub(
    () => recentPage([{ uts: UTS_2008, artist: "A", track: "t1" }], 1, 1),
    async (urls) => {
      await run("sync-history", { resyncYear: "2008" }, ctx);
      assertEquals(
        urls[0].searchParams.get("from"),
        String(Date.UTC(2008, 0, 1) / 1000 + 1),
        "resync must start at the year boundary, not the stored cursor",
      );
    },
  );
});

Deno.test("sync-history: a truncated walk HOLDS the cursor so older pages are not skipped", async () => {
  // getRecentTracks pages newest-first, so stopping early leaves a gap at the
  // OLD end of the range. Advancing the cursor to the newest uts seen would
  // put that gap permanently behind the cursor and those scrobbles would never
  // be fetched again. This is the regression guard for that data loss.
  const priorUts = 1_000_000;
  const { ctx, written } = makeCtx(GLOBAL_ARGS, {
    "history.u3BpaT": { user: "u3BpaT", lastUts: priorUts },
  });
  await withFetchStub(
    (url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      // Newest first: page 1 is the most recent.
      return recentPage(
        [{ uts: UTS_2008 - page * 1000, artist: "A", track: `t${page}` }],
        page,
        10,
      );
    },
    async () => {
      await run("sync-history", { maxPages: 2 }, ctx);
      const history = written.find((w) => w.spec === "history");
      assert(history, "history must be written");
      assertEquals(
        history.payload.lastUts,
        priorUts,
        "a truncated walk must NOT advance the cursor past the unread gap",
      );
      assertEquals(
        history.payload.truncated,
        true,
        "truncation must be reported",
      );
    },
  );
});

Deno.test("sync-history: a complete walk DOES advance the cursor", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS, {
    "history.u3BpaT": { user: "u3BpaT", lastUts: 1000 },
  });
  await withFetchStub(
    () => recentPage([{ uts: UTS_2008, artist: "A", track: "t1" }], 1, 1),
    async () => {
      await run("sync-history", { maxPages: 5 }, ctx);
      const history = written.find((w) => w.spec === "history");
      assertEquals(history?.payload.lastUts, UTS_2008);
      assertEquals(history?.payload.truncated, false);
    },
  );
});

Deno.test("sync-history: maxPages stops the walk early and says so", async () => {
  const { ctx, logs } = makeCtx();
  await withFetchStub(
    (url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return recentPage(
        [{ uts: UTS_2008 - page, artist: "A", track: `t${page}` }],
        page,
        10,
      );
    },
    async (urls) => {
      await run("sync-history", { maxPages: 2 }, ctx);
      assertEquals(urls.length, 2, "must stop at the cap");
      assert(
        logs.some((l) => l.includes("maxPages")),
        "the cap must be reported, not silent",
      );
    },
  );
});

Deno.test("sync-history chunk content is deterministic — identical data yields identical bytes", async () => {
  const page = () =>
    recentPage([{ uts: UTS_2008, artist: "A", track: "t1" }], 1, 1);

  const first = makeCtx();
  await withFetchStub(page, async () => {
    await run("sync-history", {}, first.ctx);
  });
  const firstChunk = first.written.find((w) => w.spec === "scrobbles");

  const second = makeCtx();
  await withFetchStub(page, async () => {
    await run("sync-history", {}, second.ctx);
  });
  const secondChunk = second.written.find((w) => w.spec === "scrobbles");

  assertEquals(
    JSON.stringify(secondChunk?.payload),
    JSON.stringify(firstChunk?.payload),
    "re-running over identical data must produce identical chunk content",
  );
});

Deno.test("sync-history is genuinely idempotent — a resumed second run adds nothing new", async () => {
  const rows = [
    { uts: UTS_2008, artist: "A", track: "t1" },
    { uts: UTS_2008 + 60, artist: "B", track: "t2" },
  ];
  // A store shared across both runs, so run 2 resumes from run 1's cursor.
  const store: Record<string, Record<string, unknown>> = {};
  const persist = (written: Written[]) => {
    for (const w of written) store[w.name] = w.payload;
  };

  const first = makeCtx(GLOBAL_ARGS, store);
  await withFetchStub(() => recentPage(rows, 1, 1), async () => {
    await run("sync-history", {}, first.ctx);
  });
  persist(first.written);
  const firstHistory = store["history.u3BpaT"];
  assertEquals(firstHistory.added, 2);

  // Second run: the API has nothing newer than the cursor.
  const second = makeCtx(GLOBAL_ARGS, store);
  await withFetchStub(() => recentPage([], 1, 0), async (urls) => {
    await run("sync-history", {}, second.ctx);
    assertEquals(
      urls[0].searchParams.get("from"),
      String((firstHistory.lastUts as number) + 1),
      "the second run must resume from the first run's cursor",
    );
  });

  const secondHistory = second.written.find((w) => w.spec === "history");
  assertEquals(secondHistory?.payload.added, 0, "nothing new to add");
  assertEquals(
    secondHistory?.payload.lastUts,
    firstHistory.lastUts,
    "the cursor must hold steady, not rewind",
  );
  assertEquals(
    second.written.filter((w) => w.spec === "scrobbles").length,
    0,
    "an empty delta must not rewrite any year chunk",
  );
});

Deno.test("sync-history writes a history resource carrying the cursor", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    () => recentPage([{ uts: UTS_2008, artist: "A", track: "t1" }], 1, 1),
    async () => {
      await run("sync-history", {}, ctx);
      const hist = written.find((w) => w.spec === "history");
      assert(hist, "a history resource must be written");
      assertEquals(hist.payload.lastUts, UTS_2008);
    },
  );
});

Deno.test("sync-history failure path — an empty history writes no chunk but still records state", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    () => ({
      recenttracks: { "@attr": { page: "1", totalPages: "0" }, track: [] },
    }),
    async () => {
      await run("sync-history", {}, ctx);
      assertEquals(written.filter((w) => w.spec === "scrobbles").length, 0);
      assert(written.find((w) => w.spec === "history"), "state still recorded");
    },
  );
});
