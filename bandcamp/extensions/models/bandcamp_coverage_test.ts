/**
 * Coverage suite: sweeps every guard/branch in bandcamp.ts that the
 * contract-fixture/methods/adversarial suites don't already exercise on
 * BOTH sides, so deleting any one of these guards turns a test red
 * (STANDARD.md's coverage role -- a behavioral regression guard, not a
 * numeric percentage).
 *
 * bandcamp.ts is UNMODIFIED; every test here PINS existing behavior.
 *
 * IMPORTANT -- module-global token cache: Deno isolates module state PER
 * TEST FILE (verified empirically), so `cachedToken` starts null at the top
 * of THIS file. The token-lifecycle test below is the FIRST OAuth-touching
 * test in this file, so it observes a genuine first-ever client_credentials
 * fetch before FakeTime forces the refresh_token branch.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./bandcamp.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = {}) {
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

type Route = (
  req: Request,
) => Response | Promise<Response | undefined> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<unknown>,
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

function withHtml(html: string, fn: () => Promise<unknown>) {
  return withFetchStub(
    [() =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })],
    () => fn(),
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function requestJsonBody(req: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
}

// ===========================================================================
// Token lifecycle -- client_credentials -> refresh_token -> cached reuse
// ===========================================================================

Deno.test("token lifecycle: first-ever call is client_credentials; after expiry, refresh_token fires with the cached refresh_token; a third immediate call reuses cache (no 3rd fetch)", async () => {
  const time = new FakeTime();
  try {
    const { ctx } = makeCtx({ clientId: "cid", clientSecret: "csecret" });
    const tokenGrants: string[] = [];
    let tokenFetchCount = 0;
    await withFetchStub(
      [async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/oauth_token") {
          tokenFetchCount++;
          const body = await req.clone().text();
          tokenGrants.push(new URLSearchParams(body).get("grant_type") || "");
          return json({
            ok: true,
            access_token: `token-${tokenFetchCount}`,
            expires_in: 3600,
            refresh_token: "stable-refresh-token",
          });
        }
        if (url.pathname === "/api/account/1/my_bands") {
          return json({ bands: [] });
        }
        return undefined;
      }],
      async () => {
        await run("my-bands", {}, ctx); // #1: cachedToken is null -> client_credentials
        assertEquals(tokenGrants, ["client_credentials"]);

        await time.tickAsync(3600_000 + 120_000); // past expiresAt + the 60s buffer
        await run("my-bands", {}, ctx); // #2: expired, but refreshToken cached -> refresh_token
        assertEquals(tokenGrants, ["client_credentials", "refresh_token"]);

        await run("my-bands", {}, ctx); // #3: immediately after -- still within the new 1h window
        assertEquals(
          tokenFetchCount,
          2,
          "third call reuses the freshly-cached token, no new fetch",
        );
      },
    );
  } finally {
    time.restore();
  }
});

Deno.test("token lifecycle: once ANY refresh_token has ever been cached (by the PRECEDING test in this file), it survives a response that omits refresh_token entirely", async () => {
  // `refreshToken: data.refresh_token || cachedToken?.refreshToken || ""` --
  // a later token response with no refresh_token field does not clear the
  // one already cached; it silently carries the OLD refresh token forward.
  // This test deliberately continues from the module-global `cachedToken`
  // state the PREVIOUS test in this file already established (Deno isolates
  // module state per TEST FILE, not per Deno.test -- verified empirically),
  // rather than fighting it: `cachedToken.refreshToken` is already
  // "stable-refresh-token" when this test starts. Its own FakeTime is set
  // comfortably past that prior cache's expiry so the token ITSELF is
  // treated as stale (forcing a fetch), while the refresh token identity
  // persists across that "expiry" regardless.
  const time = new FakeTime(Date.now() + 3 * 3600_000);
  try {
    const { ctx } = makeCtx({ clientId: "cid", clientSecret: "csecret" });
    const tokenGrants: string[] = [];
    const refreshTokensSent: string[] = [];
    await withFetchStub(
      [async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/oauth_token") {
          const body = await req.clone().text();
          const params = new URLSearchParams(body);
          tokenGrants.push(params.get("grant_type") || "");
          refreshTokensSent.push(params.get("refresh_token") || "");
          // This response carries NO refresh_token at all.
          return json({ ok: true, access_token: "token-x", expires_in: 3600 });
        }
        if (url.pathname === "/api/account/1/my_bands") {
          return json({ bands: [] });
        }
        return undefined;
      }],
      async () => {
        await run("my-bands", {}, ctx); // inherited refreshToken -> refresh_token grant
        await time.tickAsync(3600_000 + 120_000);
        await run("my-bands", {}, ctx); // STILL refresh_token -- the old value was never cleared
        assertEquals(tokenGrants, ["refresh_token", "refresh_token"]);
        assertEquals(refreshTokensSent, [
          "stable-refresh-token",
          "stable-refresh-token",
        ]);
      },
    );
  } finally {
    time.restore();
  }
});

// ===========================================================================
// ld vs DOM discography -- the `.length > 0` guard, explicit-empty-array side
// ===========================================================================

Deno.test("get-artist: ld.album present but an EXPLICIT empty array still falls back to the DOM #music-grid (the `.length > 0` check, not just `||`)", async () => {
  const html =
    `<html><head><script type="application/ld+json">{"name":"Fixture X","album":[]}</script></head>` +
    `<body><ol id="music-grid"><li class="music-grid-item"><a href="https://fixture.example.com/album/dom-album"><p class="title">DOM Album</p></a></li></ol></body></html>`;
  const { ctx, written } = makeCtx();
  await withHtml(
    html,
    () => run("get-artist", { url: "https://fixture.example.com" }, ctx),
  );
  const res = written.find((w) => w.spec === "artistDetail")!;
  assertEquals(res.payload.discography, [
    { title: "DOM Album", url: "https://fixture.example.com/album/dom-album" },
  ]);
  assertEquals(res.payload.albumCount, 1);
});

// ===========================================================================
// my-bands: member_bands = [] (present but empty, still truthy) -- no crash,
// no extra bands pushed
// ===========================================================================

Deno.test("my-bands: a band with member_bands=[] (truthy, empty) contributes zero extra flattened entries and no crash", async () => {
  const { ctx, written } = makeCtx({
    clientId: "cid",
    clientSecret: "csecret",
  });
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return json({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/account/1/my_bands") {
        return json({
          bands: [{
            band_id: 1,
            name: "Fixture Solo",
            subdomain: "fx",
            member_bands: [],
          }],
        });
      }
      return undefined;
    }],
    () => run("my-bands", {}, ctx),
  );
  const res = written.find((w) => w.spec === "bands")!;
  assertEquals(res.payload.total, 1);
  assertEquals(
    (res.payload.bands as Array<Record<string, unknown>>)[0].member_bands,
    [],
  );
});

// ===========================================================================
// sales-report / get-orders: falsy-vs-existence guards on numeric/boolean 0
// ===========================================================================

Deno.test("sales-report: memberBandId=0 is OMITTED from the body -- `if (args.memberBandId)` is a truthy check, not `!== undefined`", async () => {
  const { ctx } = makeCtx({ clientId: "cid", clientSecret: "csecret" });
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return json({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/sales/4/sales_report") {
        return json({ report: [] });
      }
      return undefined;
    }],
    async (calls) => {
      await run(
        "sales-report",
        { bandId: 1, memberBandId: 0, startTime: "2024-01-01T00:00:00Z" },
        ctx,
      );
      const body = await requestJsonBody(
        calls.find((c) =>
          new URL(c.url).pathname === "/api/sales/4/sales_report"
        )!,
      );
      assert(
        !("member_band_id" in body),
        "memberBandId:0 must be omitted (falsy check)",
      );
    },
  );
});

Deno.test("get-orders: unshippedOnly=false is OMITTED from the body, same as omitted entirely -- both collapse to the identical request", async () => {
  const bodies: Record<string, unknown>[] = [];
  for (const args of [{ bandId: 1, unshippedOnly: false }, { bandId: 1 }]) {
    const { ctx } = makeCtx({ clientId: "cid", clientSecret: "csecret" });
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/oauth_token") {
          return json({ ok: true, access_token: "t", expires_in: 3600 });
        }
        if (url.pathname === "/api/merchorders/4/get_orders") {
          return json({ items: [] });
        }
        return undefined;
      }],
      async (calls) => {
        await run("get-orders", args, ctx);
        bodies.push(
          await requestJsonBody(
            calls.find((c) =>
              new URL(c.url).pathname === "/api/merchorders/4/get_orders"
            )!,
          ),
        );
      },
    );
  }
  assertEquals(bodies[0], bodies[1]);
  assert(!("unshipped_only" in bodies[0]));
});

// ===========================================================================
// parseAlbumPage: BOTH ld.track and tralbum.trackinfo absent -> tracks=[]
// ===========================================================================

Deno.test("get-album: both ld.track AND TralbumData absent -> tracks resolves to [] (both sides of the fallback guard covered)", async () => {
  const html =
    `<html><head><script type="application/ld+json">{"name":"Fixture No Tracks"}</script></head><body></body></html>`;
  const { ctx, written } = makeCtx();
  await withHtml(
    html,
    () => run("get-album", { url: "https://fixture.example.com/album/x" }, ctx),
  );
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.tracks, []);
  assertEquals(res.payload.trackCount, 0);
  assertEquals(res.payload.title, "Fixture No Tracks");
});

// ===========================================================================
// parseSearchResults: heading-vs-itemurl OR-branch, explicit dedicated sweep
// ===========================================================================

Deno.test("parseSearchResults: '.heading a' is preferred when BOTH '.heading a' and '.itemurl a' are present on the same item", async () => {
  const html =
    `<html><body><ul class="results"><li class="searchresult data-search">` +
    `<div class="heading"><a href="https://fixture.example.com/heading-wins">Heading Title</a></div>` +
    `<div class="itemurl"><a href="https://fixture.example.com/itemurl-loses">Itemurl Title</a></div>` +
    `</li></ul></body></html>`;
  const { ctx, written } = makeCtx();
  await withHtml(html, () => run("search-artist", { query: "x" }, ctx));
  const results = written[0].payload.results as Array<Record<string, unknown>>;
  assertEquals(results[0].title, "Heading Title");
  assertEquals(results[0].url, "https://fixture.example.com/heading-wins");
});

Deno.test("parseSearchResults: '.itemurl a' is used when '.heading a' is absent (the OR-fallback's second side)", async () => {
  const html =
    `<html><body><ul class="results"><li class="searchresult data-search">` +
    `<div class="itemurl"><a href="https://fixture.example.com/itemurl-only">Itemurl Only Title</a></div>` +
    `</li></ul></body></html>`;
  const { ctx, written } = makeCtx();
  await withHtml(html, () => run("search-artist", { query: "x" }, ctx));
  const results = written[0].payload.results as Array<Record<string, unknown>>;
  assertEquals(results[0].title, "Itemurl Only Title");
});

Deno.test("parseSearchResults: an item with NO title (from either selector) is DROPPED from results entirely", async () => {
  const html =
    `<html><body><ul class="results"><li class="searchresult data-search"><div class="subhead">no heading at all</div></li></ul></body></html>`;
  const { ctx, written } = makeCtx();
  await withHtml(html, () => run("search-artist", { query: "x" }, ctx));
  assertEquals(written[0].payload.results, []);
});

// ===========================================================================
// The "of N results" total regex -- both sides
// ===========================================================================

Deno.test("total: 'of 0 results' text IS matched by the regex, yielding total=0 explicitly (not merely falling back to length)", async () => {
  const html = `<html><body><p>of 0 results</p></body></html>`;
  const { ctx, written } = makeCtx();
  await withHtml(html, () => run("search-artist", { query: "x" }, ctx));
  assertEquals(written[0].payload.total, 0);
});

// ===========================================================================
// page argument -- default vs explicit, both written and forwarded
// ===========================================================================

Deno.test("page: omitted arg defaults to 1 both in the request URL and the written resource", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      assertEquals(new URL(req.url).searchParams.get("page"), "1");
      return new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }],
    () => run("search-artist", { query: "x" }, ctx),
  );
  assertEquals(written[0].payload.page, 1);
});
