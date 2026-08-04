/**
 * Contract-fixture suite: pins the CONCRETE MusicBrainz WS v2 JSON wire shape
 * (keysets, value types, MBID format) and the Bandcamp JSON-LD/TralbumData
 * wire shapes, both read directly from the committed fixtures under
 * fixtures/ — independent of musicbrainz.ts's resource schemas, which use
 * `.passthrough()` zod objects for almost every entity. A suite that only
 * asserted "the written resource validates against the model's schema" would
 * be toothless (passthrough accepts anything); this suite hardcodes the
 * expected keyset + value types from the MusicBrainz/Bandcamp documented wire
 * formats so a real wire-format drift turns a test red (STANDARD.md's
 * contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made. This file covers only the methods for which a
 * committed fixture exists; lookup-release/lookup-recording/lookup-label/
 * browse-recordings and the remaining bandcamp flows are exercised with
 * INLINE stub bodies in musicbrainz_methods_test.ts instead (porkbun/shoko
 * precedent: contract-fixture pins the committed corpus, methods/coverage/
 * property use inline bodies for everything else).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./musicbrainz.ts";
import artistSearch from "../../fixtures/artist-search.json" with {
  type: "json",
};
import releaseGroupSearch from "../../fixtures/release-group-search.json" with {
  type: "json",
};
import releaseSearch from "../../fixtures/release-search.json" with {
  type: "json",
};
import recordingSearch from "../../fixtures/recording-search.json" with {
  type: "json",
};
import labelSearch from "../../fixtures/label-search.json" with {
  type: "json",
};
import artistLookup from "../../fixtures/artist-lookup.json" with {
  type: "json",
};
import releaseGroupLookup from "../../fixtures/release-group-lookup.json" with {
  type: "json",
};
import browseReleaseGroups from "../../fixtures/browse-release-groups.json" with {
  type: "json",
};
import browseReleases from "../../fixtures/browse-releases.json" with {
  type: "json",
};
import genericSearch from "../../fixtures/generic-search.json" with {
  type: "json",
};
import error404 from "../../fixtures/error-404.json" with { type: "json" };
import error503 from "../../fixtures/error-503.json" with { type: "json" };
import { ALBUM_JSONLD_HTML } from "../../fixtures/bandcamp/album_jsonld.ts";
import { ALBUM_TRALBUM_HTML } from "../../fixtures/bandcamp/album_tralbum.ts";
import { ARTIST_JSONLD_HTML } from "../../fixtures/bandcamp/artist_jsonld.ts";
import { ARTIST_MUSICGRID_HTML } from "../../fixtures/bandcamp/artist_musicgrid.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  userAgent: "swamp-musicbrainz-test/1.0 (fixture@example.com)",
};

const MBID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ONE FakeTime for the whole file (neutralizes mbFetch's real 1100ms
// rate-limiter wait so this suite runs in milliseconds, not ~14 real
// seconds) — see musicbrainz_property_test.ts's header comment for why a
// single shared clock (not one per test) is required: `lastRequest` is
// musicbrainz.ts module state that never resets, so a fresh FakeTime() per
// test would make the gap between its real-now anchor and the ever-
// advancing lastRequest grow across the file. This suite doesn't pin
// rate-limiter TIMING (that's musicbrainz_methods_test.ts's job) — here
// FakeTime is purely a speed/robustness mechanism.
//
// Deliberately left undisposed — see musicbrainz_property_test.ts's header
// comment: `deno test <dir>` isolates each test file's global scope, so
// this cannot leak into a different file's tests (empirically confirmed
// across all 109 tests in this suite regardless of run order).
const time = new FakeTime();

async function drainAndAwait<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  p.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  for (let i = 0; i < 20 && !settled; i++) {
    await Promise.resolve();
  }
  for (let i = 0; i < 30 && !settled; i++) {
    await time.tickAsync(1200);
  }
  return await p;
}

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

/** Single-fixture JSON stub — every call gets the same body/status. Drains
 * the shared FakeTime internally so callers don't need to think about the
 * rate limiter at all. */
function withJsonFixture(
  body: unknown,
  fn: () => Promise<unknown>,
  status = 200,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    )) as unknown as typeof globalThis.fetch;
  return drainAndAwait(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

/** Single-fixture HTML stub — every call gets the same body/status. */
function withHtmlFixture(html: string, fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    )) as unknown as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Host-routed stub: bandcamp-host requests get `html`; musicbrainz.org
 * requests get an EMPTY release-group browse page (used only to let the
 * artist-discography flow complete past its MB side without a real match —
 * the point of these tests is pinning the Bandcamp wire shape, not MB). */
function withArtistPageAndEmptyMb(
  html: string,
  fn: () => Promise<unknown>,
) {
  const routes: Route[] = [
    (req) =>
      new URL(req.url).hostname.endsWith(".bandcamp.com")
        ? new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
        : undefined,
    (req) =>
      new URL(req.url).hostname === "musicbrainz.org"
        ? new Response(
          JSON.stringify({
            "release-groups": [],
            "release-group-count": 0,
            "release-group-offset": 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
        : undefined,
  ];
  const original = globalThis.fetch;
  globalThis.fetch =
    (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      for (const route of routes) {
        const res = await route(req);
        if (res) return res;
      }
      throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
    }) as unknown as typeof globalThis.fetch;
  return drainAndAwait(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// artist-search.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: artist-search.json — search-artist writes {artists, count, timestamp}; every artist keeps a valid MBID + documented keyset", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    artistSearch,
    () => run("search-artist", { query: "fixture" }, ctx),
  );
  const res = written.find((w) => w.spec === "artists")!;
  const artists = res.payload.artists as Array<Record<string, unknown>>;
  assertEquals(artists.length, artistSearch.artists.length);
  assertEquals(res.payload.count, artistSearch.count);
  assertEquals(artists, artistSearch.artists);
  for (const a of artists) {
    assert(MBID_RE.test(a.id as string), `${a.id} must be a valid MBID`);
    assertEquals(typeof a.name, "string");
    assertEquals(typeof a.score, "number");
  }
  assertEquals(
    Object.keys(artists[0]).sort(),
    [
      "area",
      "country",
      "disambiguation",
      "id",
      "name",
      "score",
      "sort-name",
      "tags",
      "type",
      "type-id",
    ].sort(),
  );
  assertEquals(
    Object.keys(artists[1]).sort(),
    [
      "country",
      "disambiguation",
      "id",
      "name",
      "score",
      "sort-name",
      "type",
      "type-id",
    ].sort(),
    "the second fixture artist has no area/tags — the documented keyset varies per entity, not fixed",
  );
});

// ---------------------------------------------------------------------------
// release-group-search.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: release-group-search.json — search-release-group writes {releaseGroups, count, timestamp} verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    releaseGroupSearch,
    () => run("search-release-group", { query: "fixture" }, ctx),
  );
  const res = written.find((w) => w.spec === "releaseGroups")!;
  const rgs = res.payload.releaseGroups as Array<Record<string, unknown>>;
  assertEquals(rgs, releaseGroupSearch["release-groups"]);
  assertEquals(res.payload.count, releaseGroupSearch.count);
  assert(MBID_RE.test(rgs[0].id as string));
  assertEquals(rgs[0]["primary-type"], "Album");
  assertEquals(rgs[1]["secondary-types"], ["Live"]);
});

// ---------------------------------------------------------------------------
// release-search.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: release-search.json — search-release writes {releases, count, timestamp} verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    releaseSearch,
    () => run("search-release", { query: "fixture" }, ctx),
  );
  const res = written.find((w) => w.spec === "releases")!;
  const releases = res.payload.releases as Array<Record<string, unknown>>;
  assertEquals(releases, releaseSearch.releases);
  assertEquals(typeof releases[0].barcode, "string");
  assertEquals(releases[0].status, "Official");
});

// ---------------------------------------------------------------------------
// recording-search.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: recording-search.json — search-recording writes {recordings, count, timestamp}; length is a NUMBER (ms)", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    recordingSearch,
    () => run("search-recording", { query: "fixture" }, ctx),
  );
  const res = written.find((w) => w.spec === "recordings")!;
  const recordings = res.payload.recordings as Array<Record<string, unknown>>;
  assertEquals(recordings, recordingSearch.recordings);
  assertEquals(typeof recordings[0].length, "number");
});

// ---------------------------------------------------------------------------
// label-search.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: label-search.json — search-label writes {labels, count, timestamp} verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    labelSearch,
    () => run("search-label", { query: "fixture" }, ctx),
  );
  const res = written.find((w) => w.spec === "labels")!;
  assertEquals(res.payload.labels, labelSearch.labels);
});

// ---------------------------------------------------------------------------
// artist-lookup.json contract — the raw entity detail envelope
// ---------------------------------------------------------------------------

Deno.test("contract: artist-lookup.json — lookup-artist writes {entity:'artist', data, timestamp}; data is the RAW MB response, unwrapped", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    artistLookup,
    () =>
      run("lookup-artist", {
        id: "00000000-0000-0000-0000-000000000001",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "entity")!;
  assertEquals(res.name, "artist-00000000-0000-0000-0000-000000000001");
  assertEquals(res.payload.entity, "artist");
  assertEquals(res.payload.data, artistLookup);
  const data = res.payload.data as Record<string, unknown>;
  assertEquals(
    (data["life-span"] as Record<string, unknown>).ended,
    false,
  );
});

// ---------------------------------------------------------------------------
// release-group-lookup.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: release-group-lookup.json — lookup-release-group writes {entity:'release-group', data, timestamp}", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    releaseGroupLookup,
    () =>
      run("lookup-release-group", {
        id: "00000000-0000-0000-0000-000000000101",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "entity")!;
  assertEquals(res.name, "rg-00000000-0000-0000-0000-000000000101");
  assertEquals(res.payload.data, releaseGroupLookup);
});

// ---------------------------------------------------------------------------
// browse-release-groups.json contract — the browse envelope's count/offset
// keys are entity-PREFIXED ("release-group-count"), distinct from search's
// bare "count"/"offset"
// ---------------------------------------------------------------------------

Deno.test("contract: browse-release-groups.json — browse-release-groups writes {results, count, offset} sourced from the release-group-* prefixed keys", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    browseReleaseGroups,
    () =>
      run("browse-release-groups", {
        artist: "00000000-0000-0000-0000-000000000001",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(res.name, "rg-by-artist-00000000-0000-0000-0000-000000000001");
  assertEquals(res.payload.results, browseReleaseGroups["release-groups"]);
  assertEquals(res.payload.count, browseReleaseGroups["release-group-count"]);
  assertEquals(
    res.payload.offset,
    browseReleaseGroups["release-group-offset"],
  );
  assertEquals(res.payload.linkedEntity, "artist");
});

// ---------------------------------------------------------------------------
// browse-releases.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: browse-releases.json — browse-releases writes {results, count, offset} sourced from the release-* prefixed keys", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    browseReleases,
    () =>
      run("browse-releases", {
        label: "00000000-0000-0000-0000-000000000401",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(res.payload.results, browseReleases.releases);
  assertEquals(res.payload.count, browseReleases["release-count"]);
  assertEquals(res.payload.linkedEntity, "label");
});

// ---------------------------------------------------------------------------
// generic-search.json contract — the entity-varying results-key heuristic
// ---------------------------------------------------------------------------

Deno.test("contract: generic-search.json (entity=area) — search picks the ONE non-{count,offset,created} key as resultsKey", async () => {
  const { ctx, written } = makeCtx();
  await withJsonFixture(
    genericSearch,
    () => run("search", { entity: "area", query: "fixture" }, ctx),
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.name, "area-search");
  assertEquals(res.payload.results, genericSearch.areas);
  assertEquals(res.payload.count, genericSearch.count);
  assertEquals(res.payload.offset, genericSearch.offset);
});

// ---------------------------------------------------------------------------
// error-404.json / error-503.json contract — non-ok responses throw, body
// text sliced to 300 chars, embedded verbatim
// ---------------------------------------------------------------------------

Deno.test("contract: error-404.json — a 404 throws, embedding the response body text and status", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withJsonFixture(error404, async () => {
    try {
      await run("search-artist", { query: "fixture" }, ctx);
    } catch (err) {
      threw = err;
    }
  }, 404);
  assert(threw instanceof Error);
  const message = (threw as Error).message;
  assert(message.includes("404"));
  assert(message.includes(error404.error));
});

Deno.test("contract: error-503.json — a persistent 503 throws (after mbFetch's single retry), embedding the retry response's body text and status — see the adversarial suite for the retry/Retry-After behavior itself", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withJsonFixture(error503, async () => {
    try {
      await run("search-artist", { query: "fixture" }, ctx);
    } catch (err) {
      threw = err;
    }
  }, 503);
  assert(threw instanceof Error);
  const message = (threw as Error).message;
  assert(message.includes("503"));
  assert(message.includes(error503.error));
});

// ---------------------------------------------------------------------------
// Bandcamp JSON-LD / TralbumData wire shapes
// ---------------------------------------------------------------------------

Deno.test("contract: album_jsonld.ts — seed-from-bandcamp reads title/artist/releaseDate from JSON-LD and trackCount from itemListElement.length", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    ALBUM_JSONLD_HTML,
    () =>
      run("seed-from-bandcamp", {
        bandcampUrl:
          "https://fixtureaurorastatic.bandcamp.com/album/fixture-nightfall-static",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.payload.artist, "Fixture Aurora Static");
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assertEquals(release.title, "Fixture Nightfall Static");
  assertEquals(release.releaseDate, "2021-05-14");
  assertEquals(release.trackCount, 3);
  const seedUrl = new URL(release.seedUrl as string);
  assertEquals(
    seedUrl.searchParams.get("mediums.0.track.1.length"),
    "3750000",
    "the hour-bearing ISO-8601 duration (PT1H2M30S) resolves to a CORRECT durationMs (3,750,000ms) — only the internal display string drops the hour, and that string has no observable side effect through any written resource (see PROVENANCE.md)",
  );
});

Deno.test("contract: album_tralbum.ts — seed-from-bandcamp falls back to TralbumData when JSON-LD has no track list", async () => {
  const { ctx, written } = makeCtx();
  await withHtmlFixture(
    ALBUM_TRALBUM_HTML,
    () =>
      run("seed-from-bandcamp", {
        bandcampUrl:
          "https://fixturemarinholloway.bandcamp.com/album/fixture-static-interference-ep",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.payload.artist, "Fixture Marin Holloway");
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assertEquals(release.trackCount, 2);
  const seedUrl = new URL(release.seedUrl as string);
  assertEquals(seedUrl.searchParams.get("mediums.0.track.0.length"), "187500");
  assertEquals(seedUrl.searchParams.get("mediums.0.track.1.length"), "233250");
});

Deno.test("contract: artist_jsonld.ts — seed-all-missing's discography parsing reads title/url/releaseDate/numTracks from ld.album[]", async () => {
  const { ctx, written } = makeCtx();
  await withArtistPageAndEmptyMb(
    ARTIST_JSONLD_HTML,
    () =>
      run("seed-all-missing", {
        bandcampUrl: "https://fixtureaurorastatic.bandcamp.com",
        artistMbid: "00000000-0000-0000-0000-000000000001",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.payload.artist, "Fixture Aurora Static");
  assertEquals(
    res.payload.total,
    2,
    "an empty MB release-group page means both discography entries are 'missing'",
  );
  const titles = (res.payload.releases as Array<Record<string, unknown>>)
    .map((r) => r.title).sort();
  assertEquals(titles, [
    "Fixture Nightfall Static",
    "Fixture Static Interference EP",
  ]);
});

Deno.test("contract: artist_musicgrid.ts — discography DOM-fallback wire shape (no JSON-LD present)", async () => {
  const { ctx, written } = makeCtx();
  await withArtistPageAndEmptyMb(
    ARTIST_MUSICGRID_HTML,
    () =>
      run("seed-all-missing", {
        bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        artistMbid: "00000000-0000-0000-0000-000000000001",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.payload.artist, "Fixture Marin Holloway");
  assertEquals(res.payload.total, 2);
  const titles = (res.payload.releases as Array<Record<string, unknown>>)
    .map((r) => r.title).sort();
  assertEquals(titles, ["Fixture Drift Sessions", "Fixture Single Echo"]);
});
