/**
 * Contract-fixture suite: pins the CONCRETE field-by-field output shape for
 * every one of bandcamp.ts's 11 methods against bandcamp/fixtures/*
 * (10 synthetic HTML pages + 7 synthetic JSON API responses) -- independent
 * of the request-shape assertions that live in the methods suite.
 *
 * bandcamp.ts has ONLY `model` exported -- parseSearchResults, parseAlbumPage,
 * parseArtistPage, fetchPage, bcPost, and getToken are module-private. Every
 * test here drives them exclusively through `model.methods.<m>.execute()`
 * against a stubbed `globalThis.fetch` and a fake context, per the approved
 * plan's test seam. Every assertion below was captured by actually running
 * the CURRENT (2026.08.02.1) source against these fixtures (not hand-derived
 * from reading the regex/selector logic), so it pins REAL observed behavior
 * -- including the bandcamp-latent-bugs #3 and #6 fixes (see CHANGELOG.md).
 *
 * All fixtures are PURE synthetic/hand-authored data -- see
 * fixtures/PROVENANCE.md. Every test here is offline: fixtures are fed
 * through a stubbed fetch, no network call is made.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./bandcamp.ts";
import myBands from "../../fixtures/my_bands.json" with { type: "json" };
import salesReport from "../../fixtures/sales_report.json" with {
  type: "json",
};
import merchDetails from "../../fixtures/merch_details.json" with {
  type: "json",
};
import orders from "../../fixtures/orders.json" with { type: "json" };
import updateShippedFixture from "../../fixtures/update_shipped.json" with {
  type: "json",
};
import apiError from "../../fixtures/api_error.json" with { type: "json" };

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

async function readHtml(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../fixtures/${name}`, import.meta.url),
  );
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withHtmlFixture(name: string, fn: () => Promise<void>) {
  const html = await readHtml(name);
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      htmlResponse(html),
    )) as unknown as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
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
    for (const route of routes) {
      const res = route(req);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(
      new Error(`fetch stub: unrouted request ${req.method} ${req.url}`),
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// search-artist / search_artists.html -- primary `.searchresult.data-search`
// ---------------------------------------------------------------------------

Deno.test("contract: search_artists.html -- two artist results, itemType=artist, location mirrors subhead", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "search_artists.html",
    () => run("search-artist", { query: "fixture" }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.itemType, "artist");
  assertEquals(res.payload.total, 2);
  assertEquals(res.payload.page, 1);
  const results = res.payload.results as Array<Record<string, unknown>>;
  assertEquals(results.length, 2);
  assertEquals(results[0], {
    title: "Fixture Aurora Band",
    url: "https://fixture-aurora-band.example.com",
    type: "artist",
    subhead: "Berlin, Germany",
    artUrl: "https://f4.bcbits.example.com/img/a0000000001_2.jpg",
    location: "Berlin, Germany",
  });
  assertEquals(results[1].location, "Rotterdam, Netherlands");
});

// ---------------------------------------------------------------------------
// search-album / search_albums.html
// ---------------------------------------------------------------------------

Deno.test("contract: search_albums.html -- full-field item + minimal-field item (optional keys omitted when falsy)", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "search_albums.html",
    () => run("search-album", { query: "fixture" }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "search")!;
  const results = res.payload.results as Array<Record<string, unknown>>;
  assertEquals(results.length, 2);
  assertEquals(results[0], {
    title: "Fixture Static Dreams",
    url: "https://fixture-aurora-band.example.com/album/fixture-static-dreams",
    type: "album",
    subhead: "by Fixture Aurora Band",
    released: "March 02, 2024",
    tags: "ambient, drone",
    genre: "Electronic",
    artUrl: "https://f4.bcbits.example.com/img/a0000000003_2.jpg",
    length: "42:00",
    artist: "Fixture Aurora Band",
  });
  // item2 has NO released/tags/genre/artUrl/length in the fixture markup --
  // pins that these keys are OMITTED (not present as "") when the source
  // selector finds nothing, since the code only sets them `if (x)`.
  assertEquals(results[1], {
    title: "Fixture Minimal Fields",
    url: "https://fixture-nightfall.example.com/album/fixture-minimal-fields",
    type: "album",
    subhead: "by Fixture Nightfall",
    artist: "Fixture Nightfall",
  });
});

// ---------------------------------------------------------------------------
// search-track / search_tracks.html -- the byMatch/fromMatch subhead quirk
// ---------------------------------------------------------------------------

Deno.test("contract: search_tracks.html -- byMatch captures the WHOLE 'X from Y' tail as artist; fromMatch separately extracts Y as album", async () => {
  // Characterization (not one of the 7 tracked latent bugs, but a genuine
  // observed quirk): the regex `/^by\s+(.+)/i` is not anchored to stop
  // before "from", so for a "by X from Y" subhead, `artist` ends up as the
  // ENTIRE "X from Y" string, not just "X". `album` is correctly "Y" via
  // the independent `/from\s+(.+)/i` match.
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "search_tracks.html",
    () => run("search-track", { query: "fixture" }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "search")!;
  const results = res.payload.results as Array<Record<string, unknown>>;
  assertEquals(results.length, 1);
  assertEquals(
    results[0].artist,
    "Fixture Aurora Band from Fixture Static Dreams",
  );
  assertEquals(results[0].album, "Fixture Static Dreams");
  assertEquals(results[0].length, "4:12");
});

// ---------------------------------------------------------------------------
// search-track / search_fallback.html -- `.result-items li` + `.itemurl a`
// ---------------------------------------------------------------------------

Deno.test("contract: search_fallback.html -- falls back to `.result-items li` / `.itemurl a`; total(3) can exceed rendered items(2)", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "search_fallback.html",
    () => run("search-track", { query: "fixture" }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "search")!;
  const results = res.payload.results as Array<Record<string, unknown>>;
  assertEquals(results.length, 2);
  assertEquals(results[0].title, "Fixture Legacy Track One");
  assertEquals(results[0].artist, "Fixture Legacy Artist");
  // "of 3 results" text is present even though only 2 <li> render -- the
  // total comes from a page-wide regex, independent of the rendered count.
  assertEquals(res.payload.total, 3);
});

// ---------------------------------------------------------------------------
// search-artist / search_empty.html -- no items, no "of N results" text
// ---------------------------------------------------------------------------

Deno.test("contract: search_empty.html -- zero results, total falls back to results.length (0)", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "search_empty.html",
    () => run("search-artist", { query: "fixture" }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, []);
  assertEquals(res.payload.total, 0);
});

// ---------------------------------------------------------------------------
// get-album / album.html -- JSON-LD wins over DOM fallback
// ---------------------------------------------------------------------------

Deno.test("contract: album.html -- JSON-LD wins over DOM for title/artist/releaseDate/artUrl/about; tags always from DOM; 2 tracks from ld.track", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "album.html",
    () =>
      run("get-album", {
        url:
          "https://fixture-aurora-band.bandcamp.com/album/fixture-static-dreams",
      }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.title, "Fixture Static Dreams");
  assertEquals(res.payload.artist, "Fixture Aurora Band");
  assertEquals(res.payload.releaseDate, "2024-03-02");
  assertEquals(
    res.payload.artUrl,
    "https://f4.bcbits.example.com/img/a0000000005_10.jpg",
  );
  assertEquals(
    res.payload.about,
    "A synthetic fixture description of a fictional album, used only for characterization testing of the JSON-LD extraction path.",
  );
  assertEquals(res.payload.tags, ["ambient", "drone"]);
  assertEquals(res.payload.trackCount, 2);
  assertEquals(res.payload.tracks, [
    {
      position: 1,
      title: "Fixture Opening Track",
      url:
        "https://fixture-aurora-band.example.com/track/fixture-opening-track",
      duration: "PT3M45S",
      recordingOf: "Fixture Opening Track",
    },
    {
      position: 2,
      title: "Fixture Closing Track",
      url:
        "https://fixture-aurora-band.example.com/track/fixture-closing-track",
      duration: "PT4M02S",
      recordingOf: "Fixture Closing Track",
    },
  ]);
});

// ---------------------------------------------------------------------------
// get-album / album_tralbum_fallback.html -- TralbumData trackinfo fallback
// ---------------------------------------------------------------------------

Deno.test("contract: album_tralbum_fallback.html -- no ld.track -> falls back to tralbum.trackinfo, formats duration as M:SS with zero-padded seconds", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "album_tralbum_fallback.html",
    () =>
      run("get-album", {
        url:
          "https://fixture-nightfall.bandcamp.com/album/fixture-tralbum-fallback",
      }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.title, "Fixture Tralbum Fallback Album");
  assertEquals(res.payload.artist, "Fixture Nightfall");
  assertEquals(res.payload.tags, ["synthwave"]);
  assertEquals(res.payload.trackCount, 2);
  assertEquals(res.payload.tracks, [
    // 225s -> floor(225/60)=3, 225%60=45 -> "3:45"
    { position: 1, title: "Fixture Track One", duration: "3:45", url: "" },
    // 63s -> floor(63/60)=1, 63%60=3 -> padStart(2,"0") -> "1:03"
    { position: 2, title: "Fixture Track Two", duration: "1:03", url: "" },
  ]);
});

// ---------------------------------------------------------------------------
// get-album / album_tralbum_dirty.html -- the //-strip RECOVERY value pin
// (bandcamp-latent-bugs #3 -- fuller explanation lives in the adversarial
// suite; this test pins the concrete resulting VALUE).
// ---------------------------------------------------------------------------

Deno.test("contract: album_tralbum_dirty.html -- a //-corrupted TralbumData blob is RECOVERED via the scheme-protected fallback strip, no throw", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "album_tralbum_dirty.html",
    () =>
      run("get-album", {
        url:
          "https://fixture-corrupt-artist.bandcamp.com/album/fixture-dirty-tralbum",
      }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "albumDetail")!;
  // No JSON-LD and no DOM fallback exist in this fixture, so title/artist/
  // tags still resolve to their empty defaults -- but the TralbumData
  // trackinfo fallback now recovers the track instead of losing it.
  assertEquals(res.payload.title, "");
  assertEquals(res.payload.artist, "");
  assertEquals(res.payload.tags, []);
  assertEquals(res.payload.tracks, [
    { position: 1, title: "Fixture Corrupt Track", duration: "3:00", url: "" },
  ]);
  assertEquals(res.payload.trackCount, 1);
});

// ---------------------------------------------------------------------------
// get-artist / artist_grid.html -- DOM #music-grid discography
// ---------------------------------------------------------------------------

Deno.test("contract: artist_grid.html -- no JSON-LD -> name/location/bio/imageUrl/discography all from DOM", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "artist_grid.html",
    () =>
      run(
        "get-artist",
        { url: "https://fixture-grid-artist.bandcamp.com" },
        ctx,
      ) as Promise<
        void
      >,
  );
  const res = written.find((w) => w.spec === "artistDetail")!;
  assertEquals(res.payload.name, "Fixture Grid Artist");
  assertEquals(res.payload.location, "Utrecht, Netherlands");
  assertEquals(
    res.payload.bio,
    "A synthetic fixture bio for the grid-based discography artist page.",
  );
  assertEquals(
    res.payload.imageUrl,
    "https://f4.bcbits.example.com/img/grid-artist.jpg",
  );
  assertEquals(res.payload.url, "");
  assertEquals(res.payload.albumCount, 2);
  assertEquals(res.payload.discography, [
    {
      title: "Fixture Grid Album One",
      url:
        "https://fixture-grid-artist.example.com/album/fixture-grid-album-one",
    },
    {
      title: "Fixture Grid Album Two",
      url:
        "https://fixture-grid-artist.example.com/album/fixture-grid-album-two",
    },
  ]);
});

// ---------------------------------------------------------------------------
// get-artist / artist_ld_discography.html -- ld discography wins over DOM grid
// ---------------------------------------------------------------------------

Deno.test("contract: artist_ld_discography.html -- ld.album (non-empty) wins over the DOM #music-grid; numTracks from BOTH a.numTracks and a.track.numberOfItems", async () => {
  // Also pins the ASYMMETRIC ld-vs-DOM precedence vs parseAlbumPage: here
  // `name` falls back to ld.name only because the DOM #band-name-location
  // is ABSENT in this fixture -- parseArtistPage checks DOM name FIRST
  // (`name || ld.name || ""`), the opposite priority of parseAlbumPage's
  // title (`ld.name || DOM`). location/bio/imageUrl have NO ld-fallback at
  // all in the source and resolve to "" here since the DOM is also absent.
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "artist_ld_discography.html",
    () =>
      run(
        "get-artist",
        { url: "https://fixture-ld-artist.bandcamp.com" },
        ctx,
      ) as Promise<
        void
      >,
  );
  const res = written.find((w) => w.spec === "artistDetail")!;
  assertEquals(res.payload.name, "Fixture LD Artist");
  assertEquals(res.payload.location, "");
  assertEquals(res.payload.bio, "");
  assertEquals(res.payload.imageUrl, "");
  assertEquals(res.payload.url, "https://fixture-ld-artist.example.com");
  assertEquals(res.payload.albumCount, 2);
  assertEquals(res.payload.discography, [
    {
      title: "Fixture LD Album One",
      url: "https://fixture-ld-artist.example.com/album/fixture-ld-album-one",
      releaseDate: "2022-05-01",
      numTracks: 8,
    },
    {
      title: "Fixture LD Album Two",
      url: "https://fixture-ld-artist.example.com/album/fixture-ld-album-two",
      releaseDate: "2023-09-15",
      numTracks: 5,
    },
  ]);
});

// ---------------------------------------------------------------------------
// get-track -- shares parseAlbumPage, writes to the SAME albumDetail spec
// ---------------------------------------------------------------------------

Deno.test("contract: get-track reuses parseAlbumPage and writes to the albumDetail resource, same as get-album", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    "album.html",
    () =>
      run("get-track", {
        url:
          "https://fixture-aurora-band.bandcamp.com/track/fixture-opening-track",
      }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "albumDetail")!;
  // bandcamp-latent-bugs #6: the resource name is now a 47-char sanitized
  // slug plus a 12-hex SHA-256 suffix of the FULL source URL (not a bare
  // 60-char slice), so this literal is the slug truncated at 47 chars
  // (ending mid-word, before "opening-track") followed by "-" + the hash.
  assertEquals(
    res.name,
    "fixture-aurora-band-bandcamp-com-track-fixture--7d1a1ed0bfc9",
  );
  assertEquals(res.payload.title, "Fixture Static Dreams");
  assertEquals(res.payload.trackCount, 2);
});

// ---------------------------------------------------------------------------
// my-bands / my_bands.json -- member_bands flattening pin
// ---------------------------------------------------------------------------

Deno.test("contract: my_bands.json -- flattens member_bands into the top-level list; the PARENT band retains its own member_bands key (push(b) does not strip it)", async () => {
  const { ctx, written } = makeCtx({
    clientId: "fixture-client-id",
    clientSecret: "fixture-client-secret",
  });
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return jsonResponse({
          ok: true,
          access_token: "fixture-token",
          expires_in: 3600,
          refresh_token: "fixture-refresh",
        });
      }
      if (url.pathname === "/api/account/1/my_bands") {
        return jsonResponse(myBands);
      }
      return undefined;
    }],
    () => run("my-bands", {}, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "bands")!;
  assertEquals(res.payload.total, 3);
  const bands = res.payload.bands as Array<Record<string, unknown>>;
  assertEquals(bands.length, 3);
  assertEquals(bands[0].band_id, 1000001);
  // The parent band's OWN member_bands array is still attached in the
  // flattened output -- push(b) pushes the whole object as-is.
  assertEquals(
    (bands[0].member_bands as unknown[]).length,
    1,
  );
  assertEquals(bands[1].band_id, 1000002);
  assertEquals(bands[1].name, "Fixture Aurora Sub Act");
  assertEquals(bands[2].band_id, 1000003);
  assertEquals("member_bands" in bands[2], false);
});

// ---------------------------------------------------------------------------
// sales-report / sales_report.json
// ---------------------------------------------------------------------------

Deno.test("contract: sales_report.json -- items array passed through verbatim, bandId/total/timestamp added", async () => {
  const { ctx, written } = makeCtx({
    clientId: "fixture-client-id",
    clientSecret: "fixture-client-secret",
  });
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return jsonResponse({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/sales/4/sales_report") {
        return jsonResponse(salesReport);
      }
      return undefined;
    }],
    () =>
      run("sales-report", {
        bandId: 1000001,
        startTime: "2024-01-01T00:00:00Z",
      }, ctx) as Promise<
        void
      >,
  );
  const res = written.find((w) => w.spec === "sales")!;
  assertEquals(res.payload.bandId, 1000001);
  assertEquals(res.payload.total, 2);
  assertEquals(res.payload.items, salesReport.report);
});

// ---------------------------------------------------------------------------
// get-merch-details / merch_details.json
// ---------------------------------------------------------------------------

Deno.test("contract: merch_details.json -- items array passed through verbatim", async () => {
  const { ctx, written } = makeCtx({
    clientId: "fixture-client-id",
    clientSecret: "fixture-client-secret",
  });
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return jsonResponse({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/merchorders/1/get_merch_details") {
        return jsonResponse(merchDetails);
      }
      return undefined;
    }],
    () =>
      run("get-merch-details", {
        bandId: 42,
        startTime: "2024-01-01T00:00:00Z",
      }, ctx) as Promise<
        void
      >,
  );
  const res = written.find((w) => w.spec === "merch")!;
  assertEquals(res.payload.bandId, 42);
  assertEquals(res.payload.total, 1);
  assertEquals(res.payload.items, merchDetails.items);
});

// ---------------------------------------------------------------------------
// get-orders / orders.json
// ---------------------------------------------------------------------------

Deno.test("contract: orders.json -- items array passed through verbatim", async () => {
  const { ctx, written } = makeCtx({
    clientId: "fixture-client-id",
    clientSecret: "fixture-client-secret",
  });
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return jsonResponse({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/merchorders/4/get_orders") {
        return jsonResponse(orders);
      }
      return undefined;
    }],
    () => run("get-orders", { bandId: 42 }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "orders")!;
  assertEquals(res.payload.bandId, 42);
  assertEquals(res.payload.total, 2);
  assertEquals(res.payload.items, orders.items);
});

// ---------------------------------------------------------------------------
// update-shipped / update_shipped.json -- the response body is IGNORED
// ---------------------------------------------------------------------------

Deno.test("contract: update_shipped.json -- the account API's response body is never surfaced; the task resource only carries a synthesized message + timestamp", async () => {
  const { ctx, written } = makeCtx({
    clientId: "fixture-client-id",
    clientSecret: "fixture-client-secret",
  });
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        return jsonResponse({ ok: true, access_token: "t", expires_in: 3600 });
      }
      if (url.pathname === "/api/merchorders/2/update_shipped") {
        return jsonResponse(updateShippedFixture);
      }
      return undefined;
    }],
    () =>
      run("update-shipped", {
        items: [{ id: "1", idType: "s", shipped: true }],
      }, ctx) as Promise<void>,
  );
  const res = written.find((w) => w.spec === "task")!;
  assertEquals(res.payload, {
    message: "Updated shipping status for 1 items",
    timestamp: res.payload.timestamp,
  });
  assertEquals("ok" in res.payload, false);
  assertEquals("changed" in res.payload, false);
});

// ---------------------------------------------------------------------------
// api_error.json -- getToken's "ok=false && no access_token" branch
// ---------------------------------------------------------------------------

Deno.test("contract: api_error.json -- getToken throws the JSON-stringified error body verbatim (sliced to 200 chars)", async () => {
  // Earlier tests in THIS file already populated the module-global
  // `cachedToken` (Deno isolates module state per TEST FILE, not per
  // Deno.test -- verified empirically before writing this suite). A
  // FakeTime jump comfortably past any of this file's prior cached
  // expiries forces getToken to actually re-hit /oauth_token instead of
  // silently reusing a still-valid cached bearer.
  const time = new FakeTime(Date.now() + 3 * 3600_000);
  try {
    const { ctx } = makeCtx({
      clientId: "fixture-client-id",
      clientSecret: "fixture-client-secret",
    });
    let threw: unknown;
    await withFetchStub(
      [(
        req,
      ) => (new URL(req.url).pathname === "/oauth_token"
        ? jsonResponse(apiError)
        : undefined)],
      async () => {
        try {
          await run("my-bands", {}, ctx);
        } catch (err) {
          threw = err;
        }
      },
    );
    assertEquals(
      (threw as Error).message,
      `Token request failed: ${JSON.stringify(apiError).slice(0, 200)}`,
    );
  } finally {
    time.restore();
  }
});

// ---------------------------------------------------------------------------
// Structural pin -- the resources map
// ---------------------------------------------------------------------------

Deno.test("structural: model.resources declares exactly the 10 documented resource specs (shippingOrigins/report are declared but no method writes them)", () => {
  assertEquals(
    Object.keys(model.resources).sort(),
    [
      "albumDetail",
      "artistDetail",
      "bands",
      "merch",
      "orders",
      "report",
      "sales",
      "search",
      "shippingOrigins",
      "task",
    ],
  );
});
