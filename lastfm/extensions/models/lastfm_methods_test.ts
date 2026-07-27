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
      logger: { info: () => {}, warning: () => {}, error: () => {} },
    },
  };
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

Deno.test("sync-history is idempotent — a second identical run adds nothing", async () => {
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
