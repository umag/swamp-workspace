/**
 * Method-level tests for @magistr/bandcamp -- all 11 methods (search-artist,
 * search-album, search-track, get-artist, get-album, get-track, my-bands,
 * sales-report, get-orders, get-merch-details, update-shipped), happy +
 * error path, driven through `model.methods.<m>.arguments.parse()` +
 * `.execute()` against a stubbed `globalThis.fetch` and a fake context.
 *
 * bandcamp.ts is UNMODIFIED -- every test here is a characterization test
 * that PINS the model's current, already-shipped behavior.
 *
 * IMPORTANT -- module-global token cache (see bandcamp-latent-bugs #2):
 * `cachedToken` is a `let` at module scope, shared across every Deno.test in
 * THIS FILE (Deno isolates module state PER TEST FILE, not per Deno.test --
 * verified empirically before writing this suite). Only the FIRST
 * OAuth-gated test below ("my-bands: happy path") observes a true first-ever
 * `grant_type=client_credentials` token fetch. Every OAuth test after it
 * inherits a warm, never-expiring-by-itself cache (getToken never nulls
 * `cachedToken`, and once it has ever seen a refresh_token it always takes
 * the refresh_token branch from then on -- see the coverage suite's
 * dedicated token-lifecycle test for that mechanism in full). So every OAuth
 * test AFTER the first only asserts the business-endpoint URL/body/written
 * resource, not the token-request grant_type.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./bandcamp.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CLIENT_ID = "fixture-client-id-do-not-log";
const CLIENT_SECRET = "fixture-client-secret-do-not-log";
const OAUTH_GLOBAL_ARGS = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = {}) {
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

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
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
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withOneHtmlResponse(
  body: string,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => html(body, status)], fn);
}

async function requestJsonBody(req: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
}

/** Standard OAuth two-hop router: /oauth_token then the given business path. */
function oauthRouter(
  path: string,
  accountResponse: unknown,
  tokenResponse: unknown = {
    ok: true,
    access_token: "fixture-access-token",
    expires_in: 3600,
    refresh_token: "fixture-refresh-token",
  },
): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/oauth_token") return json(tokenResponse);
    if (url.pathname === path) return json(accountResponse);
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// search-artist
// ---------------------------------------------------------------------------

Deno.test("search-artist: happy path -- GET, query encoded, item_type=b, default page=1", async () => {
  const { ctx, written } = makeCtx();
  await withOneHtmlResponse(
    `<html><body><div class="pagination">of 0 results</div></body></html>`,
    200,
    async (calls) => {
      await run("search-artist", { query: "boards of canada" }, ctx);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].method, "GET");
      const url = new URL(calls[0].url);
      assertEquals(url.hostname, "bandcamp.com");
      assertEquals(url.pathname, "/search");
      assertEquals(url.searchParams.get("q"), "boards of canada");
      assertEquals(url.searchParams.get("item_type"), "b");
      assertEquals(url.searchParams.get("page"), "1");
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.name, "search-artist");
  assertEquals(res.payload.page, 1);
});

Deno.test("search-artist: explicit page is forwarded", async () => {
  const { ctx } = makeCtx();
  await withOneHtmlResponse(`<html></html>`, 200, async (calls) => {
    await run("search-artist", { query: "x", page: 3 }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("page"), "3");
  });
});

// ---------------------------------------------------------------------------
// search-album
// ---------------------------------------------------------------------------

Deno.test("search-album: happy path -- item_type=a", async () => {
  const { ctx, written } = makeCtx();
  await withOneHtmlResponse(`<html></html>`, 200, async (calls) => {
    await run("search-album", { query: "static dreams" }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("item_type"), "a");
  });
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.name, "search-album");
  assertEquals(res.payload.itemType, "album");
});

// ---------------------------------------------------------------------------
// search-track
// ---------------------------------------------------------------------------

Deno.test("search-track: happy path -- item_type=t", async () => {
  const { ctx, written } = makeCtx();
  await withOneHtmlResponse(`<html></html>`, 200, async (calls) => {
    await run("search-track", { query: "opening track" }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("item_type"), "t");
  });
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.name, "search-track");
  assertEquals(res.payload.itemType, "track");
});

// ---------------------------------------------------------------------------
// get-artist -- the /music URL-normalization guard, all 3 branches
// ---------------------------------------------------------------------------

Deno.test("get-artist: bare artist URL gets '/music' appended", async () => {
  const { ctx } = makeCtx();
  await withOneHtmlResponse(`<html></html>`, 200, async (calls) => {
    await run("get-artist", { url: "https://fixture.bandcamp.com" }, ctx);
    assertEquals(calls[0].url, "https://fixture.bandcamp.com/music");
  });
});

Deno.test("get-artist: URL already ending in '/music' is left unchanged", async () => {
  const { ctx } = makeCtx();
  await withOneHtmlResponse(`<html></html>`, 200, async (calls) => {
    await run("get-artist", { url: "https://fixture.bandcamp.com/music" }, ctx);
    assertEquals(calls[0].url, "https://fixture.bandcamp.com/music");
  });
});

Deno.test("get-artist: URL containing '/music?' (already a music-page query) is left unchanged", async () => {
  const { ctx } = makeCtx();
  await withOneHtmlResponse(`<html></html>`, 200, async (calls) => {
    await run(
      "get-artist",
      { url: "https://fixture.bandcamp.com/music?tab=all" },
      ctx,
    );
    assertEquals(calls[0].url, "https://fixture.bandcamp.com/music?tab=all");
  });
});

Deno.test("get-artist: a trailing slash is stripped before '/music' is appended", async () => {
  const { ctx } = makeCtx();
  await withOneHtmlResponse(`<html></html>`, 200, async (calls) => {
    await run("get-artist", { url: "https://fixture.bandcamp.com/" }, ctx);
    assertEquals(calls[0].url, "https://fixture.bandcamp.com/music");
  });
});

// ---------------------------------------------------------------------------
// get-album -- URL used as-is, no normalization
// ---------------------------------------------------------------------------

Deno.test("get-album: happy path -- URL fetched verbatim, no normalization", async () => {
  const { ctx, written } = makeCtx();
  await withOneHtmlResponse(
    `<html><head><script type="application/ld+json">{"name":"Fixture Album"}</script></head></html>`,
    200,
    async (calls) => {
      await run(
        "get-album",
        { url: "https://fixture.bandcamp.com/album/x?ref=search" },
        ctx,
      );
      assertEquals(
        calls[0].url,
        "https://fixture.bandcamp.com/album/x?ref=search",
      );
    },
  );
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.title, "Fixture Album");
});

// ---------------------------------------------------------------------------
// get-track -- shares the album parser, writes to albumDetail
// ---------------------------------------------------------------------------

Deno.test("get-track: happy path -- URL fetched verbatim, writes to albumDetail (not a separate 'track' resource)", async () => {
  const { ctx, written } = makeCtx();
  await withOneHtmlResponse(
    `<html><head><script type="application/ld+json">{"name":"Fixture Track"}</script></head></html>`,
    200,
    async (calls) => {
      await run(
        "get-track",
        { url: "https://fixture.bandcamp.com/track/y" },
        ctx,
      );
      assertEquals(calls[0].url, "https://fixture.bandcamp.com/track/y");
    },
  );
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.title, "Fixture Track");
});

// ---------------------------------------------------------------------------
// my-bands -- the FIRST OAuth test in this file: true first-ever token fetch
// ---------------------------------------------------------------------------

Deno.test("my-bands: happy path -- FIRST-EVER call takes grant_type=client_credentials, posts to /account/1/my_bands, writes bands", async () => {
  const { ctx, written } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [oauthRouter("/api/account/1/my_bands", { bands: [] })],
    async (calls) => {
      await run("my-bands", {}, ctx);
      assertEquals(calls.length, 2);
      assertEquals(new URL(calls[0].url).pathname, "/oauth_token");
      const tokenBody = new URLSearchParams(await calls[0].clone().text());
      assertEquals(tokenBody.get("client_id"), CLIENT_ID);
      assertEquals(tokenBody.get("client_secret"), CLIENT_SECRET);
      assertEquals(tokenBody.get("grant_type"), "client_credentials");
      assertEquals(new URL(calls[1].url).pathname, "/api/account/1/my_bands");
      assertEquals(
        calls[1].headers.get("authorization"),
        "Bearer fixture-access-token",
      );
    },
  );
  const res = written.find((w) => w.spec === "bands")!;
  assertEquals(res.name, "all");
  assertEquals(res.payload.bands, []);
  assertEquals(res.payload.total, 0);
});

Deno.test("my-bands: error path -- account endpoint non-2xx throws with the response body text", async () => {
  const { ctx } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return json({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/account/1/my_bands") {
        return new Response("account suspended", { status: 403 });
      }
      return undefined;
    }],
    async () => {
      await assertRejects(
        () => run("my-bands", {}, ctx),
        Error,
        "Bandcamp /account/1/my_bands failed: 403 - account suspended",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// sales-report
// ---------------------------------------------------------------------------

Deno.test("sales-report: minimal args -- band_id/start_time only, memberBandId/endTime omitted", async () => {
  const { ctx, written } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [oauthRouter("/api/sales/4/sales_report", { report: [] })],
    async (calls) => {
      await run(
        "sales-report",
        { bandId: 7, startTime: "2024-01-01T00:00:00Z" },
        ctx,
      );
      const body = await requestJsonBody(
        calls.find((c) =>
          new URL(c.url).pathname === "/api/sales/4/sales_report"
        )!,
      );
      assertEquals(body, { band_id: 7, start_time: "2024-01-01T00:00:00Z" });
    },
  );
  const res = written.find((w) => w.spec === "sales")!;
  assertEquals(res.name, "band-7");
  assertEquals(res.payload.bandId, 7);
});

Deno.test("sales-report: full args -- memberBandId and endTime included", async () => {
  const { ctx } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [oauthRouter("/api/sales/4/sales_report", { report: [] })],
    async (calls) => {
      await run("sales-report", {
        bandId: 7,
        memberBandId: 8,
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-02-01T00:00:00Z",
      }, ctx);
      const body = await requestJsonBody(
        calls.find((c) =>
          new URL(c.url).pathname === "/api/sales/4/sales_report"
        )!,
      );
      assertEquals(body, {
        band_id: 7,
        start_time: "2024-01-01T00:00:00Z",
        member_band_id: 8,
        end_time: "2024-02-01T00:00:00Z",
      });
    },
  );
});

Deno.test("sales-report: error path -- non-2xx throws", async () => {
  const { ctx } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return json({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/sales/4/sales_report") {
        return new Response("rate limited", { status: 429 });
      }
      return undefined;
    }],
    async () => {
      await assertRejects(
        () =>
          run(
            "sales-report",
            { bandId: 1, startTime: "2024-01-01T00:00:00Z" },
            ctx,
          ),
        Error,
        "429",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// get-orders
// ---------------------------------------------------------------------------

Deno.test("get-orders: minimal args -- band_id only", async () => {
  const { ctx, written } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [oauthRouter("/api/merchorders/4/get_orders", { items: [] })],
    async (calls) => {
      await run("get-orders", { bandId: 9 }, ctx);
      const body = await requestJsonBody(
        calls.find((c) =>
          new URL(c.url).pathname === "/api/merchorders/4/get_orders"
        )!,
      );
      assertEquals(body, { band_id: 9 });
    },
  );
  const res = written.find((w) => w.spec === "orders")!;
  assertEquals(res.name, "band-9");
});

Deno.test("get-orders: full args -- memberBandId/startTime/endTime/unshippedOnly all included", async () => {
  const { ctx } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [oauthRouter("/api/merchorders/4/get_orders", { items: [] })],
    async (calls) => {
      await run("get-orders", {
        bandId: 9,
        memberBandId: 10,
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-02-01T00:00:00Z",
        unshippedOnly: true,
      }, ctx);
      const body = await requestJsonBody(
        calls.find((c) =>
          new URL(c.url).pathname === "/api/merchorders/4/get_orders"
        )!,
      );
      assertEquals(body, {
        band_id: 9,
        member_band_id: 10,
        start_time: "2024-01-01T00:00:00Z",
        end_time: "2024-02-01T00:00:00Z",
        unshipped_only: true,
      });
    },
  );
});

Deno.test("get-orders: error path -- non-2xx throws", async () => {
  const { ctx } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return json({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/merchorders/4/get_orders") {
        return new Response("boom", { status: 500 });
      }
      return undefined;
    }],
    async () => {
      await assertRejects(
        () => run("get-orders", { bandId: 1 }, ctx),
        Error,
        "500",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// get-merch-details
// ---------------------------------------------------------------------------

Deno.test("get-merch-details: minimal args", async () => {
  const { ctx, written } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [oauthRouter("/api/merchorders/1/get_merch_details", { items: [] })],
    async (calls) => {
      await run(
        "get-merch-details",
        { bandId: 11, startTime: "2024-01-01T00:00:00Z" },
        ctx,
      );
      const body = await requestJsonBody(
        calls.find((c) =>
          new URL(c.url).pathname === "/api/merchorders/1/get_merch_details"
        )!,
      );
      assertEquals(body, { band_id: 11, start_time: "2024-01-01T00:00:00Z" });
    },
  );
  const res = written.find((w) => w.spec === "merch")!;
  assertEquals(res.name, "band-11");
});

Deno.test("get-merch-details: full args -- memberBandId/endTime included", async () => {
  const { ctx } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [oauthRouter("/api/merchorders/1/get_merch_details", { items: [] })],
    async (calls) => {
      await run("get-merch-details", {
        bandId: 11,
        memberBandId: 12,
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-02-01T00:00:00Z",
      }, ctx);
      const body = await requestJsonBody(
        calls.find((c) =>
          new URL(c.url).pathname === "/api/merchorders/1/get_merch_details"
        )!,
      );
      assertEquals(body, {
        band_id: 11,
        start_time: "2024-01-01T00:00:00Z",
        member_band_id: 12,
        end_time: "2024-02-01T00:00:00Z",
      });
    },
  );
});

Deno.test("get-merch-details: error path -- non-2xx throws", async () => {
  const { ctx } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return json({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/merchorders/1/get_merch_details") {
        return new Response("boom", { status: 502 });
      }
      return undefined;
    }],
    async () => {
      await assertRejects(
        () =>
          run(
            "get-merch-details",
            { bandId: 1, startTime: "2024-01-01T00:00:00Z" },
            ctx,
          ),
        Error,
        "502",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// update-shipped
// ---------------------------------------------------------------------------

Deno.test("update-shipped: camelCase args are mapped to the snake_case wire body, one item per idType", async () => {
  const { ctx, written } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [oauthRouter("/api/merchorders/2/update_shipped", { ok: true })],
    async (calls) => {
      await run("update-shipped", {
        items: [
          {
            id: "sale-1",
            idType: "s",
            shipped: true,
            carrier: "Fixture Post",
            trackingCode: "TRACK-1",
            notification: true,
          },
          { id: 42, idType: "p" },
        ],
      }, ctx);
      const body = await requestJsonBody(
        calls.find((c) =>
          new URL(c.url).pathname === "/api/merchorders/2/update_shipped"
        )!,
      );
      // The mapper builds an object literal with an explicit `undefined` for
      // every unset optional field (shipped/carrier/tracking_code/
      // notification), but `JSON.stringify` drops `undefined`-valued keys --
      // so the SECOND item's wire body carries only `id`/`id_type`, not the
      // other keys-set-to-undefined. requestJsonBody() parses the ACTUAL
      // wire text, so this pins the real serialized shape, not the
      // in-memory object shape.
      assertEquals(body, {
        items: [
          {
            id: "sale-1",
            id_type: "s",
            shipped: true,
            carrier: "Fixture Post",
            tracking_code: "TRACK-1",
            notification: true,
          },
          { id: 42, id_type: "p" },
        ],
      });
    },
  );
  const res = written.find((w) => w.spec === "task")!;
  assertEquals(res.name, "update-shipped");
  assertEquals(res.payload.message, "Updated shipping status for 2 items");
});

Deno.test("update-shipped: error path -- non-2xx throws", async () => {
  const { ctx } = makeCtx(OAUTH_GLOBAL_ARGS);
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return json({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/merchorders/2/update_shipped") {
        return new Response("bad request", { status: 400 });
      }
      return undefined;
    }],
    async () => {
      await assertRejects(
        () =>
          run(
            "update-shipped",
            { items: [{ id: "1", idType: "s" }] },
            ctx,
          ),
        Error,
        "400",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Missing-credentials guard -- shared by every OAuth method
// ---------------------------------------------------------------------------

Deno.test("OAuth methods: missing clientId/clientSecret throws BEFORE any fetch happens", async () => {
  const { ctx } = makeCtx({});
  await withFetchStub([], async (calls) => {
    await assertRejects(
      () =>
        run(
          "sales-report",
          { bandId: 1, startTime: "2024-01-01T00:00:00Z" },
          ctx,
        ),
      Error,
      "clientId and clientSecret required",
    );
    assertEquals(calls.length, 0, "no fetch should happen without credentials");
  });
});

// ---------------------------------------------------------------------------
// Credential-leak assertions across every OAuth method
// ---------------------------------------------------------------------------

Deno.test("credentials never appear in any written resource or log call across all 5 OAuth methods", async () => {
  const scenarios: Array<[string, Record<string, unknown>, string, unknown]> = [
    ["my-bands", {}, "/api/account/1/my_bands", { bands: [] }],
    [
      "sales-report",
      { bandId: 1, startTime: "2024-01-01T00:00:00Z" },
      "/api/sales/4/sales_report",
      { report: [] },
    ],
    ["get-orders", { bandId: 1 }, "/api/merchorders/4/get_orders", {
      items: [],
    }],
    [
      "get-merch-details",
      { bandId: 1, startTime: "2024-01-01T00:00:00Z" },
      "/api/merchorders/1/get_merch_details",
      { items: [] },
    ],
    [
      "update-shipped",
      { items: [{ id: "1", idType: "s" }] },
      "/api/merchorders/2/update_shipped",
      { ok: true },
    ],
  ];
  for (const [name, args, path, accountResponse] of scenarios) {
    const { ctx, written, logs } = makeCtx(OAUTH_GLOBAL_ARGS);
    await withFetchStub([oauthRouter(path, accountResponse)], async () => {
      await run(name, args, ctx);
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(!s.includes(CLIENT_ID), `${name}: clientId leaked into ${w.spec}`);
      assert(
        !s.includes(CLIENT_SECRET),
        `${name}: clientSecret leaked into ${w.spec}`,
      );
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(
        !s.includes(CLIENT_ID),
        `${name}: clientId leaked into a log call`,
      );
      assert(
        !s.includes(CLIENT_SECRET),
        `${name}: clientSecret leaked into a log call`,
      );
    }
  }
});

Deno.test("no method calls the logger at all today (pin -- a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneHtmlResponse(`<html></html>`, 200, async () => {
    await run("search-artist", { query: "x" }, ctx);
  });
  assertEquals(logs.length, 0);
});
