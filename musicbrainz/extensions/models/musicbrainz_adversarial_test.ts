/**
 * Adversarial suite: hostile-HTML pins (malformed JSON-LD fallback,
 * script-injection text, huge/nested input), raw MBID path-interpolation
 * FIXES (concrete captured-URL assertions — a `new URL()` normalization
 * spike originally showed an UNENCODED `../` COLLAPSING the path, escaping
 * even the `/ws/2/` prefix; `encodeURIComponent(args.id)` now closes that),
 * per-fetch AbortSignal timeouts on both fetch sites, 503-Retry-After now
 * driving a single backoff-and-retry inside mbFetch (musicbrainz-
 * discography-sync — see below; a persistent 503 still throws, just after
 * one retry instead of zero), Array.isArray response-shape guards (a truthy
 * non-array `data.<key>` now normalizes to `[]` instead of sailing through
 * unchanged), and mbFetch's concurrency-safe rate-limit queue (concurrent
 * callers never observe the same stale `lastRequest` and fire together) —
 * plus a fixtures-secret-scan backstop over both the JSON and Bandcamp HTML
 * corpus.
 *
 * This file, alongside the SSRF fix from musicbrainz-ssrf-and-latent-bugs
 * (2026.07.31.1: fetchPage requires an https bandcamp.com/*.bandcamp.com URL
 * via assertBandcampUrl, applied before any network call and re-applied on
 * every manual redirect hop), now also covers the musicbrainz-ssrf-and-
 * latent-bugs LB2/LB3/LB6/LB7 real fixes (2026.08.02.1): MBID path-injection
 * (LB2), the TralbumData //-strip URL corruption (LB3, now direct-parse-first
 * with a `://`-protected fallback strip — see the FIX test near the top),
 * per-fetch timeouts + Retry-After + Array.isArray guards (LB7). LB4
 * (unbounded pagination) and LB5 (normalizeTitle over-collapse) are covered
 * in musicbrainz_property_test.ts and musicbrainz_coverage_test.ts
 * respectively. musicbrainz-discography-sync (2026.08.04.1, ported from an
 * older untested copy — see musicbrainz_property_test.ts's header for the
 * pure-helper side of that port) turned the LB7-era "surfaced, never acted
 * on" 503/Retry-After characterization into a real single-retry-with-backoff
 * behavior and made mbFetch's rate limiter concurrency-safe; the two tests
 * covering those are below, alongside the updated Retry-After test. Tests
 * not called out above (hostile-HTML fallback characterization, huge/nested
 * input, array-wrapped JSON-LD, the raw-entity `data` passthrough, and the
 * SSRF allowlist tests) are UNCHANGED pins — still current, correct
 * behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { mbFetch, model, MusicBrainzBackoffError } from "./musicbrainz.ts";
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
import { HOSTILE_ALBUM_HTML } from "../../fixtures/bandcamp/hostile.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  userAgent: "swamp-musicbrainz-adversarial-test/1.0 (fixture@example.com)",
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

type Call = { input: Request | URL | string; init: RequestInit | undefined };
type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Host-routed fetch stub that ALSO captures the raw (input, init) pair the
 * source passed to `fetch()` — needed to inspect whether an AbortSignal was
 * ever threaded through, since `new Request(input, init)` always synthesizes
 * an implicit `.signal` even when the caller passed none. */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[], rawCalls: Call[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const rawCalls: Call[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    rawCalls.push({ input, init });
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls, rawCalls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function isMbHost(req: Request): boolean {
  return new URL(req.url).hostname === "musicbrainz.org";
}

function isBcHost(req: Request): boolean {
  return new URL(req.url).hostname.endsWith(".bandcamp.com");
}

function withMbFixture(
  body: unknown,
  fn: (calls: Request[], rawCalls: Call[]) => Promise<unknown>,
  status = 200,
) {
  return withFetchStub(
    [(req) => (isMbHost(req) ? json(body, status) : undefined)],
    fn,
  );
}

/** Same generic drain helper as musicbrainz_methods_test.ts — see that
 * file's header for why the loop-then-tick shape is required. */
async function drainAndAwait<T>(time: FakeTime, p: Promise<T>): Promise<T> {
  let settled = false;
  p.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  for (let i = 0; i < 20 && !settled; i++) {
    await Promise.resolve();
  }
  for (let i = 0; i < 2000 && !settled; i++) {
    await time.tickAsync(200);
  }
  return await p;
}

// ---------------------------------------------------------------------------
// Hostile Bandcamp HTML — malformed JSON-LD -> fallback, script-injection
// ---------------------------------------------------------------------------

Deno.test("pin: malformed/invalid JSON-LD (unbalanced braces) is silently swallowed by the try/catch, falling back to DOM selectors", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(HOSTILE_ALBUM_HTML) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl:
          "https://forceclosed.bandcamp.com/track/fixture-corrupt-track",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assertEquals(
    res.payload.artist,
    "Fixture Hostile Artist",
    "artist falls back to the DOM selector since the invalid JSON-LD parses to {}",
  );
  assertEquals(
    release.releaseDate,
    "",
    "releaseDate has NO DOM fallback at all — an unparseable JSON-LD silently loses it entirely",
  );
});

Deno.test("pin: a raw <script> tag embedded in the title element is included VERBATIM in the extracted title (textContent, not sanitized — never executed by this parser, but not stripped either)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(HOSTILE_ALBUM_HTML) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl:
          "https://forceclosed.bandcamp.com/track/fixture-corrupt-track",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assertEquals(release.title, "Fixture Hostile alert(1) Static");
  const seedUrl = new URL(release.seedUrl as string);
  assertEquals(
    seedUrl.searchParams.get("name"),
    "Fixture Hostile alert(1) Static",
    "URLSearchParams.set safely percent-encodes the injected text into the seed URL — no HTML/JS ever executes here, this is a data pipeline",
  );
});

Deno.test("FIX: TralbumData is tried as a direct JSON.parse FIRST — an embedded https:// URL survives, tracks parse correctly instead of vanishing", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(HOSTILE_ALBUM_HTML) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl:
          "https://forceclosed.bandcamp.com/track/fixture-corrupt-track",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assertEquals(
    release.trackCount,
    1,
    "TralbumData is valid JSON on its own (embedded https:// URL included) — a direct JSON.parse succeeds before any //-strip cleanup is even attempted, so the real track survives",
  );
  const seedUrl = new URL(release.seedUrl as string);
  assertEquals(
    seedUrl.searchParams.get("mediums.0.track.0.name"),
    "Fixture Corrupt Track",
    "the track title from the (now correctly parsed) trackinfo entry reaches the seed URL",
  );
});

Deno.test("pin: a huge/deeply-repeated tags list and a very long title do not crash the parser — pure pass-through, no size guard", async () => {
  const hugeTag = "x".repeat(5000);
  const manyTagsHtml = `<!doctype html>
<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicAlbum","name":"${
    "Fixture Huge Title " + "Z".repeat(2000)
  }","byArtist":{"name":"Fixture Huge Artist"}}</script>
</head><body>
<div class="tralbumData tralbum-tags">${
    Array.from({ length: 300 }, (_, i) =>
      `<a class="tag" href="/tag/${i}">tag${i}</a>`).join("")
  }<a class="tag" href="/tag/huge">${hugeTag}</a></div>
</body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(manyTagsHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/huge",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assert(
    (release.title as string).length > 2000,
    "the huge title passes through unmodified — no length guard",
  );
});

Deno.test("pin: a LARGE track list (200 itemListElement entries) and DEEPLY NESTED unrelated JSON-LD properties do not crash the parser or silently truncate — the 'nested' half of 'huge/nested input'", async () => {
  const trackCount = 200;
  const ld = {
    "@context": "https://schema.org",
    "@type": "MusicAlbum",
    name: "Fixture Massive Tracklist",
    byArtist: {
      name: "Fixture Massive Artist",
      // Deeply nested, otherwise-irrelevant properties — pure structural
      // stress, never read by the parser, must not cause a crash either.
      nested: { deeply: { nested: { object: { forNoReason: true } } } },
    },
    track: {
      itemListElement: Array.from({ length: trackCount }, (_, i) => ({
        position: i + 1,
        item: { name: `Fixture Track ${i + 1}`, duration: "PT3M00S" },
      })),
    },
  };
  const largeHtml =
    `<!doctype html><html><head><script type="application/ld+json">${
      JSON.stringify(ld)
    }</script></head><body></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(largeHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/massive",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assertEquals(
    release.trackCount,
    trackCount,
    "all 200 tracks parsed, none silently dropped",
  );
  const seedUrl = new URL(release.seedUrl as string);
  assertEquals(
    seedUrl.searchParams.get(`mediums.0.track.${trackCount - 1}.name`),
    `Fixture Track ${trackCount}`,
    "the LAST track's params are present in the seed URL — no truncation",
  );
});

Deno.test("pin: an ARRAY-wrapped JSON-LD block (`[{...}]`, a valid schema.org alternate form) makes ld.name/ld.byArtist BOTH undefined on an album page — falls back to the DOM selectors", async () => {
  const arrayLdHtml = `<!doctype html>
<html><head>
<script type="application/ld+json">[{"@context":"https://schema.org","@type":"MusicAlbum","name":"Fixture Array Wrapped","byArtist":{"name":"Fixture Array Artist"}}]</script>
</head><body>
<div id="name-section"><h2 class="trackTitle">Fixture DOM Fallback Title</h2></div>
<div id="band-name-location"><span class="title">Fixture DOM Fallback Artist</span></div>
</body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(arrayLdHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/array",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assertEquals(
    res.payload.artist,
    "Fixture DOM Fallback Artist",
    "ld is a bare Array -> ld.byArtist is undefined (arrays have no such property) -> falls back to the DOM selector, NOT 'Fixture Array Artist'",
  );
  assertEquals(
    release.title,
    "Fixture DOM Fallback Title",
    "ld.name is undefined on an array -> falls back to the DOM selector, NOT 'Fixture Array Wrapped'",
  );
});

Deno.test("pin: an ARRAY-wrapped JSON-LD block on an ARTIST page makes ld.album undefined -> discography falls back to the #music-grid DOM scan entirely (the array's own album entries are silently ignored)", async () => {
  const arrayArtistHtml = `<!doctype html>
<html><head>
<script type="application/ld+json">[{"@context":"https://schema.org","@type":"MusicGroup","name":"Fixture Array Group","album":[{"@id":"https://x.bandcamp.com/album/a","name":"Should Not Appear — inside the array, unreachable"}]}]</script>
</head><body>
<p id="band-name-location"><span class="title">Fixture DOM Group Fallback</span></p>
<div id="music-grid"><ol><li class="music-grid-item"><a href="/album/y"><p class="title">Fixture Music Grid Fallback</p></a></li></ol></div>
</body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(arrayArtistHtml) : undefined),
      (req) =>
        isMbHost(req)
          ? json({
            "release-groups": [],
            "release-group-count": 0,
            "release-group-offset": 0,
          })
          : undefined,
    ],
    async () => {
      await run("seed-all-missing", {
        bandcampUrl: "https://fixture.bandcamp.com",
        artistMbid: "00000000-0000-0000-0000-000000000001",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.payload.artist, "Fixture DOM Group Fallback");
  const releases = res.payload.releases as Array<Record<string, unknown>>;
  assertEquals(releases.length, 1);
  assertEquals(
    releases[0].title,
    "Fixture Music Grid Fallback",
    "the array-wrapped ld.album entry ('Should Not Appear') never surfaces — ld.album is undefined on a bare array, so the DOM #music-grid scan is the ONLY source",
  );
});

// ---------------------------------------------------------------------------
// MBID raw path-interpolation injection — concrete captured-URL assertions
// ---------------------------------------------------------------------------

Deno.test("LB2 FIX: an UNENCODED-looking '../../' MBID is percent-encoded before path interpolation — the request can no longer escape /ws/2/artist/", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-artist", { id: "../../secret" }, ctx).then(() => {
        assertEquals(
          new URL(calls[0].url).pathname,
          "/ws/2/artist/..%2F..%2Fsecret",
          "encodeURIComponent turns each '/' into %2F (dots are left alone, they are unreserved) — the request now stays anchored under /ws/2/artist/, it can never collapse out via dot-segment normalization",
        );
      }),
    ));
});

Deno.test("LB2 FIX: an MBID containing '/' is percent-encoded to %2F — no extra path segment is added", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-release", { id: "abc/def" }, ctx).then(() => {
        assertEquals(
          new URL(calls[0].url).pathname,
          "/ws/2/release/abc%2Fdef",
        );
      }),
    ));
});

Deno.test("LB2 FIX: an MBID containing '?' is percent-encoded to %3F — no query parameter can be injected via the id", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-recording", { id: "abc?inc=injected-param" }, ctx).then(
        () => {
          const url = new URL(calls[0].url);
          assertEquals(
            url.pathname,
            "/ws/2/recording/abc%3Finc%3Dinjected-param",
          );
          assertEquals(
            url.searchParams.get("inc"),
            null,
            "the '?' is now part of the encoded path segment, not a real query delimiter — no 'inc' param is ever injected",
          );
          assertEquals(url.searchParams.get("fmt"), "json");
        },
      ),
    ));
});

Deno.test("LB2 FIX: an MBID containing '#' is percent-encoded to %23 — no URL fragment can be smuggled via the id", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-label", { id: "abc#injected-fragment" }, ctx).then(() => {
        const url = new URL(calls[0].url);
        assertEquals(url.pathname, "/ws/2/label/abc%23injected-fragment");
        assertEquals(url.searchParams.get("fmt"), "json");
      }),
    ));
});

Deno.test("LB2 FIX: a canonical hyphenated-hex MBID encodes to ITSELF (identity) — happy-path request URLs stay byte-identical", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  const uuid = "00000000-0000-0000-0000-000000000001";
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-artist", { id: uuid }, ctx).then(() => {
        assertEquals(
          new URL(calls[0].url).pathname,
          `/ws/2/artist/${uuid}`,
          "encodeURIComponent leaves hex digits and hyphens unescaped — a real MBID round-trips unchanged",
        );
      }),
    ));
});

Deno.test("LB2 FIX: an id combining every special character at once is FULLY percent-encoded, none left raw in the path", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-release-group", { id: "../a/b?c=d#e f" }, ctx).then(() => {
        const url = new URL(calls[0].url);
        assertEquals(
          url.pathname,
          "/ws/2/release-group/..%2Fa%2Fb%3Fc%3Dd%23e%20f",
        );
        assertEquals(
          url.searchParams.get("c"),
          null,
          "nothing from the id leaks out as a real query parameter",
        );
        assertEquals(url.searchParams.get("fmt"), "json");
      }),
    ));
});

// ---------------------------------------------------------------------------
// seed-URL injection — title/artist/track names with '&'/'=' stay
// URLSearchParams-encoded (buildSeedUrl is injection-safe by construction)
// ---------------------------------------------------------------------------

Deno.test("seed-URL injection: album title/artist with '&' and '=' are safely percent-encoded by URLSearchParams, never break the query string", async () => {
  const injectionHtml = `<!doctype html>
<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicAlbum","name":"Fixture & Static = Noise","byArtist":{"name":"A&B=C Fixture"},"track":{"itemListElement":[{"position":1,"item":{"name":"T1&T2=T3"}}]}}</script>
</head><body></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(injectionHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/injection",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  const seedUrl = new URL(release.seedUrl as string);
  assertEquals(seedUrl.searchParams.get("name"), "Fixture & Static = Noise");
  assertEquals(
    seedUrl.searchParams.get("artist_credit.names.0.artist.name"),
    "A&B=C Fixture",
  );
  assertEquals(seedUrl.searchParams.get("mediums.0.track.0.name"), "T1&T2=T3");
  assert(
    seedUrl.toString().includes("%26") || seedUrl.toString().includes("+"),
    "the raw '&' must never appear un-encoded as a param delimiter in the serialized URL",
  );
});

// ---------------------------------------------------------------------------
// bandcampUrl SSRF — assertBandcampUrl host/scheme allowlist inside fetchPage
// (musicbrainz-ssrf-and-latent-bugs fix). These two tests used to PIN the
// vulnerable behavior (internal address fetched verbatim); they now assert
// the fix: rejection BEFORE any network call, with zero fetch egress.
// ---------------------------------------------------------------------------

Deno.test("SSRF FIX: fetchPage(bandcampUrl) rejects a non-Bandcamp host (internal/metadata-service address) BEFORE any fetch — zero network egress", async () => {
  const { ctx } = makeCtx();
  const internalUrl =
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
  await withFetchStub(
    [() => html("<html><body>internal</body></html>")],
    async (calls) => {
      await assertRejects(
        () => run("seed-from-bandcamp", { bandcampUrl: internalUrl }, ctx),
      );
      assertEquals(
        calls.length,
        0,
        "the host allowlist must reject BEFORE any fetch call — no egress to the internal target",
      );
    },
  );
});

Deno.test("SSRF FIX: find-missing's artist-discography fetch rejects a non-Bandcamp bandcampUrl (internal address) BEFORE any fetch — zero network egress", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  const internalUrl = "http://internal.corp.local:8080/admin";
  // Host-routed by exclusion: musicbrainz.org would get a valid empty
  // release-group page if reached; EVERYTHING ELSE (including the
  // attacker-controlled "internal.corp.local" bandcampUrl) gets the internal
  // HTML stub. With the fix, the bcUrl allowlist check rejects before the
  // bandcamp fetch even happens, so no MusicBrainz call is ever reached
  // either — assert zero calls of ANY kind.
  await withFetchStub(
    [
      (req) =>
        isMbHost(req)
          ? json({
            "release-groups": [],
            "release-group-count": 0,
            "release-group-offset": 0,
          })
          : html("<html><body>internal</body></html>"),
    ],
    (calls) =>
      drainAndAwait(
        time,
        assertRejects(
          () =>
            run("find-missing", {
              bandcampUrl: internalUrl,
              artistMbid: "00000000-0000-0000-0000-000000000001",
            }, ctx),
        ).then(() => {
          assertEquals(
            calls.length,
            0,
            "the host allowlist must reject the internal bcUrl BEFORE any fetch — no egress at all, not even to musicbrainz.org",
          );
        }),
      ),
  );
});

// ---------------------------------------------------------------------------
// Positive guard tests — the allowlist must not regress any legit Bandcamp
// fetch, must re-validate redirect hops, and must reject on scheme alone.
// ---------------------------------------------------------------------------

Deno.test("SSRF FIX (positive): a legit https://*.bandcamp.com URL still fetches (200) unchanged", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(ALBUM_JSONLD_HTML) : undefined)],
    async (calls) => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/allowed",
      }, ctx);
      assertEquals(
        calls.length,
        1,
        "exactly one legit fetch, unblocked by the allowlist",
      );
      assertEquals(calls[0].url, "https://fixture.bandcamp.com/album/allowed");
    },
  );
});

Deno.test("SSRF FIX (positive): a bandcamp -> bandcamp redirect (302) is followed across hosts, re-validating the Location on each hop", async () => {
  const { ctx } = makeCtx();
  let firstHopServed = false;
  await withFetchStub(
    [
      (req) => {
        const hostname = new URL(req.url).hostname;
        if (hostname === "fixture.bandcamp.com" && !firstHopServed) {
          firstHopServed = true;
          return new Response(null, {
            status: 302,
            headers: {
              Location: "https://redirected.bandcamp.com/album/target",
            },
          });
        }
        if (hostname === "redirected.bandcamp.com") {
          return html(ALBUM_JSONLD_HTML);
        }
        return undefined;
      },
    ],
    async (calls) => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/redirect-me",
      }, ctx);
      assertEquals(
        calls.length,
        2,
        "one redirect hop: initial 302 + final 200",
      );
      assertEquals(
        calls[0].url,
        "https://fixture.bandcamp.com/album/redirect-me",
      );
      assertEquals(
        calls[1].url,
        "https://redirected.bandcamp.com/album/target",
      );
    },
  );
});

Deno.test("SSRF FIX: a bandcamp -> internal-address redirect (302) is rejected via manual-redirect re-validation — under real fetch auto-follow semantics this would otherwise leak to the internal host", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        const hostname = new URL(req.url).hostname;
        if (hostname !== "fixture.bandcamp.com") return undefined;
        if (req.redirect === "manual") {
          // Fixed code: passes redirect: "manual", so it receives the raw
          // 302 + Location and must re-validate the Location itself before
          // ever following it.
          return new Response(null, {
            status: 302,
            headers: { Location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        // Unfixed code passes no redirect option at all — fetch's default
        // is "follow", so a real HTTP client would transparently chase this
        // redirect straight to the internal target and hand back ITS
        // response, never even exposing the 302 to fetchPage. This branch
        // simulates that auto-follow to prove the pre-fix code actually
        // leaks here (not merely fails on the raw 3xx status).
        return html(
          "<html><body>internal (leaked via auto-follow)</body></html>",
        );
      },
    ],
    async (calls) => {
      await assertRejects(
        () =>
          run("seed-from-bandcamp", {
            bandcampUrl: "https://fixture.bandcamp.com/album/evil-redirect",
          }, ctx),
      );
      assertEquals(
        calls.length,
        1,
        "only the initial bandcamp fetch happens; the redirect target is rejected before a second fetch",
      );
    },
  );
});

Deno.test("SSRF FIX: file:// and http:// (non-https) bandcampUrl inputs are rejected on scheme before any fetch", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => html("<html></html>")],
    async (calls) => {
      await assertRejects(() =>
        run("seed-from-bandcamp", {
          bandcampUrl: "file:///etc/passwd",
        }, ctx)
      );
      await assertRejects(() =>
        run("seed-from-bandcamp", {
          bandcampUrl: "http://fixture.bandcamp.com/album/insecure",
        }, ctx)
      );
      assertEquals(calls.length, 0, "neither non-https scheme reaches fetch()");
    },
  );
});

Deno.test("SSRF FIX: hostname allowlist is anchored on the dot — evil.bandcamp.com.attacker.com and notbandcamp.com are rejected, bare bandcamp.com is allowed", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        const hostname = new URL(req.url).hostname;
        return (isBcHost(req) || hostname === "bandcamp.com")
          ? html(ALBUM_JSONLD_HTML)
          : undefined;
      },
    ],
    async (calls) => {
      await assertRejects(() =>
        run("seed-from-bandcamp", {
          bandcampUrl: "https://evil.bandcamp.com.attacker.com/album/x",
        }, ctx)
      );
      await assertRejects(() =>
        run("seed-from-bandcamp", {
          bandcampUrl: "https://notbandcamp.com/album/x",
        }, ctx)
      );
      assertEquals(
        calls.length,
        0,
        "both spoofed hostnames are rejected before any fetch",
      );

      await run("seed-from-bandcamp", {
        bandcampUrl: "https://bandcamp.com/album/bare-host-allowed",
      }, ctx);
      assertEquals(
        calls.length,
        1,
        "bare bandcamp.com (no subdomain) is explicitly allowed",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// LB7 FIX: AbortSignal timeout on both fetch sites
// ---------------------------------------------------------------------------

Deno.test("LB7 FIX: mbFetch always passes a real AbortSignal in the fetch init", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    { artists: [], count: 0 },
    (_calls, rawCalls) =>
      drainAndAwait(time, run("search-artist", { query: "x" }, ctx)).then(
        () => {
          assertEquals(rawCalls.length, 1);
          assert(
            rawCalls[0].init?.signal instanceof AbortSignal,
            "mbFetch now threads an AbortController's signal through every fetch init",
          );
        },
      ),
  );
});

Deno.test("LB7 FIX: fetchPage (Bandcamp) always passes a real AbortSignal too", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => html(ALBUM_JSONLD_HTML)],
    async (_calls, rawCalls) => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/x",
      }, ctx);
      assert(rawCalls[0].init?.signal instanceof AbortSignal);
    },
  );
});

Deno.test("LB7 FIX: mbFetch aborts a never-resolving fetch once the client-side timeout elapses (AbortError)", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  const original = globalThis.fetch;
  let sawSignal: AbortSignal | undefined;
  globalThis.fetch = ((
    _input: Request | URL | string,
    init?: RequestInit,
  ) => {
    sawSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The signal has been aborted", "AbortError"));
      });
    });
  }) as unknown as typeof globalThis.fetch;
  try {
    await drainAndAwait(
      time,
      assertRejects(() => run("search-artist", { query: "x" }, ctx)),
    );
  } finally {
    globalThis.fetch = original;
  }
  assert(sawSignal instanceof AbortSignal, "a signal must have been passed");
  assert(
    sawSignal?.aborted,
    "the signal must be aborted once the 30s client-side timeout elapses, even though the stub never resolves on its own",
  );
});

// ---------------------------------------------------------------------------
// mbFetch is CANCELLABLE via an optional 5th `signal` parameter — this is
// the ONLY way `--timeout` on a long-running batch (search-artists-batch,
// step 6) can be enforced at any point INSIDE a request, since v1 only
// checked the flag BETWEEN queries. All existing 4-argument callers are
// unchanged; a caller that never passes a signal sees identical behaviour.
// ---------------------------------------------------------------------------

Deno.test("mbFetch cancellation: an already-aborted external signal prevents the request entirely, checked BEFORE reserveRateLimitSlot", async () => {
  using time = new FakeTime();
  const controller = new AbortController();
  controller.abort();
  const original = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.reject(new Error("must never be called"));
  }) as unknown as typeof globalThis.fetch;
  try {
    await drainAndAwait(
      time,
      assertRejects(() =>
        mbFetch(
          "test-agent/1.0",
          "/artist/",
          { query: "x" },
          1100,
          controller.signal,
        )
      ),
    );
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(
    fetchCalled,
    false,
    "an already-aborted signal must short-circuit before any network call, including the rate-limit reservation",
  );
});

Deno.test("mbFetch cancellation: the external signal is composed into the per-call AbortController via AbortSignal.any — aborting it aborts the in-flight fetch", async () => {
  using time = new FakeTime();
  const controller = new AbortController();
  const original = globalThis.fetch;
  let sawSignal: AbortSignal | undefined;
  globalThis.fetch = ((
    _input: Request | URL | string,
    init?: RequestInit,
  ) => {
    sawSignal = init?.signal ?? undefined;
    // Schedule the external abort only once fetch() has actually been
    // called — proves the composed signal fetch received is LIVE, not
    // evaluated ahead of time. A fake-clock timer (not a raw microtask
    // flush) so drainAndAwait's tick loop reliably drives it.
    setTimeout(() => controller.abort(), 10);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The signal has been aborted", "AbortError"));
      });
    });
  }) as unknown as typeof globalThis.fetch;
  try {
    await drainAndAwait(
      time,
      assertRejects(() =>
        mbFetch(
          "test-agent/1.0",
          "/artist/",
          { query: "x" },
          1100,
          controller.signal,
        )
      ),
    );
  } finally {
    globalThis.fetch = original;
  }
  assert(
    sawSignal instanceof AbortSignal,
    "a composed signal must have been passed to fetch",
  );
  assert(
    sawSignal?.aborted,
    "the composed signal must reflect the external signal's abort",
  );
});

Deno.test("mbFetch cancellation: a 503 backoff sleep RACES the external signal instead of being an uninterruptible setTimeout — aborting during the backoff rejects immediately, well short of the full backoff", async () => {
  using time = new FakeTime();
  const controller = new AbortController();
  let callCount = 0;
  let firstFetchAt = 0;
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      callCount++;
      if (callCount === 1) {
        firstFetchAt = time.now;
        // Schedule the abort right as the first 503 is produced — a
        // fake-clock timer (not a manually-guessed tick amount, which broke
        // under this file's module-level rate-limiter "virtual debt" from
        // earlier tests, see the file header) so it reliably lands while
        // mbFetch is inside the Retry-After backoff sleep, not before it.
        setTimeout(() => controller.abort(), 1);
      }
      return json(error503, 503, { "Retry-After": "30" });
    }],
    () =>
      drainAndAwait(
        time,
        (async () => {
          const pending = mbFetch(
            "test-agent/1.0",
            "/artist/",
            { query: "x" },
            1100,
            controller.signal,
          );
          await assertRejects(() => pending);
          assert(
            time.now - firstFetchAt < 30_000,
            "the backoff sleep must have been interrupted by the abort, not run to completion",
          );
          assertEquals(
            callCount,
            1,
            "an aborted backoff sleep must never reach the retry fetch",
          );
        })(),
      ),
  );
});

// ---------------------------------------------------------------------------
// musicbrainz-discography-sync: mbFetch now retries a 503 exactly once
// (honouring Retry-After as the backoff when present), and its rate-limit
// queue is concurrency-safe. Ported from an older untested copy of this
// model — see musicbrainz_property_test.ts's header for the pure-helper
// side (rateLimitDelayMs/retryAfterBackoffMs) these two behaviors are built
// on.
// ---------------------------------------------------------------------------

Deno.test("musicbrainz-discography-sync: a 503 WITH a Retry-After header is retried exactly once, honouring the header as the backoff — the header still surfaces in the thrown message if the retry also 503s", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) =>
      isMbHost(req) ? json(error503, 503, { "Retry-After": "45" }) : undefined],
    (calls) =>
      drainAndAwait(
        time,
        (async () => {
          const err = await assertRejects(
            () => run("search-artist", { query: "x" }, ctx),
            Error,
            "503",
          );
          assert(
            err.message.includes("45"),
            "the Retry-After value from the (also-503) retry response must be surfaced in the thrown message",
          );
          assertEquals(
            calls.length,
            2,
            "mbFetch retries exactly once after honouring the Retry-After backoff, then throws when the retry also 503s",
          );
        })(),
      ),
  );
});

Deno.test("search-artists-batch backoff: a 503 with a Retry-After EXCEEDING the cap throws MusicBrainzBackoffError immediately — no sleep, no retry, virtual elapsed time never reaches the header value", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  const t0 = time.now;
  let callCount = 0;
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      callCount++;
      return json(error503, 503, { "Retry-After": "3600" });
    }],
    () =>
      drainAndAwait(
        time,
        (async () => {
          const err = await assertRejects(
            () => run("search-artist", { query: "x" }, ctx),
            MusicBrainzBackoffError,
          );
          assertEquals(err.retryAfterMs, 3_600_000);
          assertEquals(
            callCount,
            1,
            "the classification is 'stop' — mbFetch must throw immediately, never retry",
          );
          assert(
            time.now - t0 < 3_600_000,
            "must not have slept out anywhere close to the 3600s Retry-After value",
          );
        })(),
      ),
  );
});

Deno.test("musicbrainz-discography-sync: a 503 with NO Retry-After backs off one mbFetch interval and retries exactly once, succeeding on the retry", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  let callCount = 0;
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      callCount++;
      return callCount === 1
        ? json(error503, 503)
        : json({ artists: [], count: 0 });
    }],
    () =>
      drainAndAwait(
        time,
        run("search-artist", { query: "x" }, ctx),
      ),
  );
  assertEquals(callCount, 2, "the retry succeeds on the second attempt");
  const res = written.find((w) => w.name === "search-artist")!;
  assertEquals(res.payload.count, 0);
});

Deno.test("musicbrainz-discography-sync: mbFetch's concurrent in-flight callers are serialized — no two consecutive fetches land closer than minIntervalMs apart", async () => {
  // Fires three requests concurrently (no await between them) via the
  // exported mbFetch directly, per the regression this guards: a rate
  // limiter that only checks-then-writes a shared timestamp (rather than
  // serializing the check-then-update itself, as mbFetch's promise-chain
  // queue does) would let some of these read the same stale `lastRequest`
  // and fire together. Uses FakeTime (like every other mbFetch-touching test
  // in this file) rather than real timers — `lastRequest` is module state
  // shared across every test in this file, so a real-timer wait here could
  // be poisoned by virtual-time debt an earlier FakeTime test left behind
  // (see the Retry-After test above, which ticks its own fake clock forward
  // by tens of seconds) and hang on a real, non-fake setTimeout.
  using time = new FakeTime();
  const calls: number[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    calls.push(Date.now());
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    await drainAndAwait(
      time,
      Promise.all([
        mbFetch("test-agent/1.0", "/artist/", { q: "1" }, 40),
        mbFetch("test-agent/1.0", "/artist/", { q: "2" }, 40),
        mbFetch("test-agent/1.0", "/artist/", { q: "3" }, 40),
      ]),
    );
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(calls.length, 3);
  const sorted = [...calls].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    assert(
      gap >= 40,
      `gap ${gap}ms below 40ms floor between concurrent callers`,
    );
  }
});

Deno.test("musicbrainz-discography-sync: a 503 with NO Retry-After that persists past the retry throws instead of retrying indefinitely", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  let callCount = 0;
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      callCount++;
      return json(error503, 503);
    }],
    () =>
      drainAndAwait(
        time,
        assertRejects(
          () => run("search-artist", { query: "x" }, ctx),
          Error,
          "503",
        ),
      ),
  );
  assertEquals(
    callCount,
    2,
    "exactly the initial attempt plus one retry — never more",
  );
});

// ---------------------------------------------------------------------------
// musicbrainz-discography-sync: cache staleness / count:0 skip-vs-refetch —
// the failure-mode half of the sync-artist-discographies port. The
// classifyDiscographyCache/isCacheStale pure invariants these two branches
// are built on live in musicbrainz_property_test.ts; the method's general
// execute() paths (explicit artistMbids, the search-artist fallback, cursor
// resume, the no-artist-list error) live in musicbrainz_methods_test.ts.
// ---------------------------------------------------------------------------

type SyncStore = Map<string, Record<string, unknown>>;

/** Stub context for sync-artist-discographies: `readResource` is a real
 * in-memory map (keyed on instance name only, matching the runtime
 * contract), pre-seedable so a test can install a cached entry before the
 * method runs. No other harness in this file needs `readResource` since no
 * other method reads what an earlier run wrote. */
function makeSyncCtx(
  store: SyncStore = new Map(),
  instanceName = "test-instance",
) {
  const written: Written[] = [];
  return {
    written,
    store,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      definition: { name: instanceName },
      readResource: (name: string) => Promise.resolve(store.get(name) ?? null),
      writeResource: (spec: string, name: string, payload: unknown) => {
        store.set(name, payload as Record<string, unknown>);
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

Deno.test("musicbrainz-discography-sync: a STALE cached discography (older than ttlMs) is re-fetched, not skipped", async () => {
  using time = new FakeTime();
  const artistMbid = "aaaaaaaa-0000-4000-8000-000000000010";
  const store: SyncStore = new Map();
  store.set(`rg-by-artist-${artistMbid}`, {
    entity: "release-group",
    linkedEntity: "artist",
    linkedId: artistMbid,
    results: [{ id: "old-rg", title: "Old Release" }],
    count: 1,
    offset: 0,
    truncated: false,
    // 2 minutes old — stale against the 60s ttlMs this test passes below.
    timestamp: new Date(Date.now() - 120_000).toISOString(),
  });
  const { written, ctx } = makeSyncCtx(store);
  await withMbFixture(
    {
      "release-groups": [{ id: "new-rg", title: "New Release" }],
      "release-group-count": 1,
    },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: [artistMbid],
          ttlMs: 60_000,
          minIntervalMs: 40,
        }, ctx),
      ),
  );
  const cached = written.filter((w) => w.name === `rg-by-artist-${artistMbid}`);
  const latest = cached[cached.length - 1];
  assertEquals(
    (latest.payload.results as unknown[])[0],
    { id: "new-rg", title: "New Release" },
    "the stale cache entry was overwritten by a fresh fetch, not left in place",
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.processed, [artistMbid]);
  assertEquals(state.payload.skipped, []);
});

Deno.test("musicbrainz-discography-sync: a FRESH cached count:0 discography is skipped, never re-fetched merely for being empty", async () => {
  using time = new FakeTime();
  const artistMbid = "aaaaaaaa-0000-4000-8000-000000000011";
  const store: SyncStore = new Map();
  store.set(`rg-by-artist-${artistMbid}`, {
    entity: "release-group",
    linkedEntity: "artist",
    linkedId: artistMbid,
    results: [],
    count: 0,
    offset: 0,
    truncated: false,
    // 1s old, well under the 60s ttlMs this test passes below.
    timestamp: new Date(Date.now() - 1_000).toISOString(),
  });
  const { written, ctx } = makeSyncCtx(store);
  let mbCalled = false;
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      mbCalled = true;
      return json({ "release-groups": [] });
    }],
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: [artistMbid],
          ttlMs: 60_000,
          minIntervalMs: 40,
        }, ctx),
      ),
  );
  assertEquals(
    mbCalled,
    false,
    "a fresh count:0 cache entry is skipped — never re-fetched merely for being empty",
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.processed, []);
  assertEquals(state.payload.skipped, [artistMbid]);
});

Deno.test("musicbrainz-discography-sync LIVE FAILURE, verbatim: a 'search-artist' resource holding exactly ONE artist must raise, never complete with processed of length 1", async () => {
  // The regression this whole issue is about, reproduced with synthetic
  // MBIDs (never a real artist name or MBID — both PROVENANCE.md files'
  // standing prohibition). Before this change, an operator who ran
  // sync-artist-discographies with no artistMbids arg on an instance whose
  // 'search-artist' resource held one lone cached artist got a silent,
  // "successful" one-artist sync instead of the actionable rejection this
  // test pins.
  const artistMbid = "aaaaaaaa-0000-4000-8000-000000000501";
  const store: SyncStore = new Map();
  store.set("search-artist", {
    artists: [{ id: artistMbid, name: "Fixture Solitary Artist" }],
    count: 1,
    timestamp: new Date().toISOString(),
  });
  const { written, ctx } = makeSyncCtx(store, "my-musicbrainz-instance");
  await assertRejects(
    () => run("sync-artist-discographies", {}, ctx),
    Error,
    "was given no artistMbids",
  );
  const state = written.find((w) => w.spec === "discographySyncState");
  assertEquals(
    state,
    undefined,
    "must never complete with processed of length 1 — no state write at all, and definitely no one-artist success",
  );
});

// ---------------------------------------------------------------------------
// LB7 FIX: Array.isArray response-shape guard — a truthy non-array field now
// normalizes to [] instead of type-confusing the derived count
// ---------------------------------------------------------------------------

Deno.test("LB7 FIX: a truthy non-array `artists` field (hostile/malformed response) is normalized to [] — count is unaffected when present", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { artists: "not-an-array", count: 999 },
    () => drainAndAwait(time, run("search-artist", { query: "x" }, ctx)),
  );
  const res = written.find((w) => w.name === "search-artist")!;
  assertEquals(
    res.payload.artists,
    [],
    "Array.isArray(data.artists) now guards the fallback — a non-array value is discarded, never written through",
  );
  assertEquals(
    res.payload.count,
    999,
    "count still comes from data.count when present — unrelated to the array guard",
  );
});

Deno.test("LB7 FIX: when `count` is ALSO absent, a truthy non-array `artists` normalizes to [] and count derives from the EMPTY array's length (0), not the string's character count", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { artists: "abcdefghij" },
    () => drainAndAwait(time, run("search-artist", { query: "x" }, ctx)),
  );
  const res = written.find((w) => w.name === "search-artist")!;
  assertEquals(res.payload.artists, []);
  assertEquals(
    res.payload.count,
    0,
    "count now falls back to [].length (0) — the STRING-LENGTH type-confusion (10) is fixed",
  );
});

Deno.test("pin: entity `data` from lookup-artist is written through with NO schema validation whatsoever — an entirely unexpected shape still writes cleanly", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const hostileData = { totally: "unexpected", shape: [1, 2, 3], id: 42 };
  await withMbFixture(
    hostileData,
    () => drainAndAwait(time, run("lookup-artist", { id: "x" }, ctx)),
  );
  const res = written.find((w) => w.spec === "entity")!;
  assertEquals(res.payload.data, hostileData);
});

// ---------------------------------------------------------------------------
// search-artists-batch — the six behaviors this step owns (testStrategy RED
// phase 4): (a) spacing across the WHOLE batch — the assertion this entire
// issue exists for; (b) per-query failure isolation; (c) max-queries
// truncation; (d) an explicit low maxDurationMs stopping with max-duration,
// plus its derived-default companion; (e) an already-aborted context.signal;
// (f) a mid-batch MusicBrainzBackoffError. Happy-path/dedup/batchId live in
// musicbrainz_methods_test.ts.
// ---------------------------------------------------------------------------

function batchQueries(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `artist:"Fixture Batch ${i}"`);
}

Deno.test("search-artists-batch (a): consecutive MusicBrainz requests are spaced at least minIntervalMs apart across the WHOLE batch — the assertion this issue exists for", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  const requestTimes: number[] = [];
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      requestTimes.push(time.now);
      return json({ artists: [], count: 0 });
    }],
    () =>
      drainAndAwait(
        time,
        run("search-artists-batch", {
          queries: batchQueries(5),
          minIntervalMs: 1100,
        }, ctx),
      ),
  );
  assertEquals(requestTimes.length, 5);
  for (let i = 1; i < requestTimes.length; i++) {
    const gap = requestTimes[i] - requestTimes[i - 1];
    assert(gap >= 1100, `gap ${gap}ms below the 1100ms floor`);
  }
});

Deno.test("search-artists-batch (b): one query's fetch throwing does NOT abort the batch — its entry carries a non-empty error, distinguishable from a legitimate empty result, and the rest still search", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const queries = batchQueries(3);
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      const q = new URL(req.url).searchParams.get("query")!;
      if (q === queries[1]) {
        throw new Error("simulated network failure");
      }
      return json({ artists: [], count: 0 });
    }],
    () =>
      drainAndAwait(
        time,
        run("search-artists-batch", {
          queries,
          minIntervalMs: 5,
          // Explicit and generous — see the happy-path test's comment in
          // musicbrainz_methods_test.ts: this file's shared module-level
          // rate limiter carries virtual-time debt from every earlier
          // FakeTime test, which the tiny DERIVED default at
          // minIntervalMs=5 could otherwise trip as a false max-duration
          // stop. This test is about per-query failure isolation, not the
          // duration ceiling.
          maxDurationMs: 600_000,
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  const rows = res.payload.queries as Array<
    { query: string; artists: unknown[]; count: number; error?: string }
  >;
  assertEquals(rows.length, 3, "the failing query still gets an entry");
  const failedRow = rows.find((r) => r.query === queries[1])!;
  assert(
    failedRow.error,
    "the failed query's entry must carry a non-empty error",
  );
  assertEquals(failedRow.artists, []);
  const okRow = rows.find((r) => r.query === queries[0])!;
  assertEquals(
    okRow.error,
    undefined,
    "a legitimately empty result must NOT carry an error field",
  );
  assertEquals(res.payload.failed, 1);
  assertEquals(res.payload.searched, 3, "every query got a verdict attempt");
  assertEquals(res.payload.stopReason, "complete");
});

Deno.test("search-artists-batch (c): maxQueries truncation — the deferred remainder is ABSENT from queries[] and PRESENT in deferred[], stopReason max-queries, truncated true", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const queries = batchQueries(5);
  await withMbFixture(
    { artists: [], count: 0 },
    () =>
      drainAndAwait(
        time,
        run("search-artists-batch", {
          queries,
          maxQueries: 2,
          minIntervalMs: 5,
          maxDurationMs: 600_000,
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  const rows = res.payload.queries as Array<{ query: string }>;
  assertEquals(rows.map((r) => r.query), queries.slice(0, 2));
  assertEquals(res.payload.deferred, queries.slice(2));
  assertEquals(res.payload.truncated, true);
  assertEquals(res.payload.stopReason, "max-queries");
  assertEquals(res.payload.searched, 2);
});

Deno.test("search-artists-batch (d): an explicit low maxDurationMs stops the batch with stopReason max-duration, deferring the untried remainder", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const queries = batchQueries(5);
  await withMbFixture(
    { artists: [], count: 0 },
    () =>
      drainAndAwait(
        time,
        run("search-artists-batch", {
          queries,
          minIntervalMs: 1100,
          maxDurationMs: 0,
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  assertEquals(res.payload.stopReason, "max-duration");
  assertEquals(res.payload.truncated, true);
  assert(
    (res.payload.deferred as unknown[]).length > 0,
    "at least the untried remainder must be deferred",
  );
});

Deno.test("search-artists-batch (d, companion): with NO explicit maxDurationMs, max-queries wins over the DERIVED max-duration backstop at nominal speed — a batch that actually needs truncating stops on max-queries, not max-duration", async () => {
  // The prior version of this test used the DEFAULT maxQueries (400) with
  // only 3 queries, so `queries.length < maxQueries` made max-queries
  // structurally unreachable — stopReason could only ever be "complete",
  // never distinguishing "the derived backstop is generous enough" from
  // "the derived backstop is generous enough to matter". A mutant
  // `deriveMaxDurationMs` returning HALF the nominal `maxQueries *
  // minIntervalMs` product (dropping the 1.5x margin and 30s floor) still
  // passed. This version forces genuine max-queries truncation (more
  // queries than maxQueries) and asserts the derived backstop does NOT
  // trip before all `maxQueries` are served — which the halved mutant
  // fails, since nominal-speed processing of `maxQueries` queries takes
  // roughly `(maxQueries - 1) * minIntervalMs`, comfortably past half the
  // nominal product but comfortably under the real (1.5x + 30s) one.
  //
  // Reads on the shared module-level rate limiter (see the neighboring (b)
  // test's comment on virtual-time debt from earlier FakeTime tests in
  // this file) would make the elapsed-time math below unpredictable, so
  // this test primes it first: ONE throwaway request, driven through
  // drainAndAwait exactly like the real call below, however long its own
  // wait needs to be. When that reservation resolves it sets the module's
  // `lastRequest` to the CURRENT fake `now` at that moment — whatever the
  // wait was — so the real batch's very first request always sees a clean,
  // fully-predictable `minIntervalMs` gap, no arbitrary padding required.
  // (An earlier version of this test instead jumped the fake clock forward
  // by a large fixed amount to the same end — that jump itself becomes
  // debt for whatever test runs next, and reproduced locally, it broke
  // case (f)'s `maxDurationMs: 600_000` assumption. Priming via a real
  // request avoids manufacturing any debt of its own.)
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const minIntervalMs = 1100;
  const maxQueries = 8;
  const queries = batchQueries(maxQueries + 2);

  await withMbFixture(
    { artists: [], count: 0 },
    () => drainAndAwait(time, run("search-artist", { query: "priming" }, ctx)),
  );

  await withMbFixture(
    { artists: [], count: 0 },
    () =>
      drainAndAwait(
        time,
        run(
          "search-artists-batch",
          { queries, maxQueries, minIntervalMs },
          ctx,
        ),
      ),
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  assertEquals(
    res.payload.stopReason,
    "max-queries",
    "the derived backstop (>= maxQueries*minIntervalMs*1.5 + 30s) must not trip before all maxQueries queries are served at nominal speed",
  );
  assertEquals(res.payload.truncated, true);
  assertEquals(res.payload.searched, maxQueries);
  assertEquals(
    (res.payload.deferred as string[]).length,
    2,
    "the 2 queries past maxQueries are deferred, not dropped",
  );
});

Deno.test("search-artists-batch (e): an already-aborted context.signal stops the batch immediately with stopReason aborted, before any fetch", async () => {
  const { ctx, written } = makeCtx();
  const controller = new AbortController();
  controller.abort();
  const ctxWithSignal = { ...ctx, signal: controller.signal };
  let fetchCalled = false;
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      fetchCalled = true;
      return json({ artists: [], count: 0 });
    }],
    () =>
      run("search-artists-batch", {
        queries: batchQueries(3),
        minIntervalMs: 5,
      }, ctxWithSignal),
  );
  assertEquals(
    fetchCalled,
    false,
    "an already-aborted signal must prevent any fetch",
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  assertEquals(res.payload.stopReason, "aborted");
  assertEquals(res.payload.truncated, true);
  assertEquals(res.payload.deferred, batchQueries(3));
});

Deno.test("search-artists-batch (f): a mid-batch MusicBrainzBackoffError (Retry-After exceeding the cap) stops the batch with stopReason backoff, AND the completed prefix is still written", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const queries = batchQueries(3);
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      const q = new URL(req.url).searchParams.get("query")!;
      if (q === queries[1]) {
        return json(error503, 503, { "Retry-After": "3600" });
      }
      return json({ artists: [], count: 0 });
    }],
    () =>
      drainAndAwait(
        time,
        run("search-artists-batch", {
          queries,
          minIntervalMs: 5,
          maxDurationMs: 600_000,
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  assertEquals(res.payload.stopReason, "backoff");
  assertEquals(res.payload.truncated, true);
  const rows = res.payload.queries as Array<{ query: string }>;
  assertEquals(
    rows.map((r) => r.query),
    [queries[0]],
    "the completed prefix (before the backoff-triggering query) is still written",
  );
  assert(
    (res.payload.deferred as string[]).includes(queries[1]),
    "the query that hit the backoff never got a verdict — it must be deferred, not recorded as a per-query error",
  );
  assert((res.payload.deferred as string[]).includes(queries[2]));
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — reframed: musicbrainz has NO credentials (only a
// public-facing userAgent string), so the scan targets real-email/handle
// patterns and high-entropy token shapes across BOTH the JSON and the
// Bandcamp HTML string fixtures.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "email NOT on the RFC 2606 example.com domain",
    re: /[a-zA-Z0-9._%+-]+@(?!example\.com\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  },
  {
    name:
      "high-entropy token-shaped value (32+ alnum/base64url, no separators)",
    re: /^[A-Za-z0-9+/_=-]{32,}$/,
  },
  { name: "bearer/authorization keyword", re: /\b(bearer|authorization)\b/i },
];

/** Fake MBIDs (`00000000-...` and any other UUID-shaped id) are expected,
 * legitimately-hyphenated structured identifiers throughout this fixture
 * corpus — not high-entropy secrets. Exclude the canonical MBID shape from
 * the high-entropy check so the scan doesn't self-flag every fixture. */
const MBID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Recursively collect every string leaf value in a parsed JSON structure. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

const JSON_FIXTURES: Record<string, unknown> = {
  "artist-search.json": artistSearch,
  "release-group-search.json": releaseGroupSearch,
  "release-search.json": releaseSearch,
  "recording-search.json": recordingSearch,
  "label-search.json": labelSearch,
  "artist-lookup.json": artistLookup,
  "release-group-lookup.json": releaseGroupLookup,
  "browse-release-groups.json": browseReleaseGroups,
  "browse-releases.json": browseReleases,
  "generic-search.json": genericSearch,
  "error-404.json": error404,
  "error-503.json": error503,
};

const HTML_FIXTURES: Record<string, string> = {
  "album_jsonld.ts": ALBUM_JSONLD_HTML,
  "album_tralbum.ts": ALBUM_TRALBUM_HTML,
  "artist_jsonld.ts": ARTIST_JSONLD_HTML,
  "artist_musicgrid.ts": ARTIST_MUSICGRID_HTML,
  "hostile.ts": HOSTILE_ALBUM_HTML,
};

Deno.test("fixtures-secret-scan: no committed JSON fixture contains a real-email or high-entropy token-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(JSON_FIXTURES)) {
    for (const str of collectStrings(data)) {
      if (MBID_RE.test(str)) continue;
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found:\n${violations.join("\n")}`,
  );
});

Deno.test("fixtures-secret-scan: no committed Bandcamp HTML fixture contains a real-email or bearer/authorization pattern", () => {
  const violations: string[] = [];
  for (const [file, htmlStr] of Object.entries(HTML_FIXTURES)) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (name.startsWith("high-entropy")) continue; // HTML naturally contains long non-secret runs (markup); scoped to JSON above
      const m = re.exec(htmlStr);
      if (m) violations.push(`${file}: value "${m[0]}" matched ${name}`);
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found:\n${violations.join("\n")}`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected real-email and high-entropy shape", () => {
  const violations: string[] = [];
  const poisoned = {
    contact: "real.person@gmail.com",
    token: "aGVsbG93b3JsZHRoaXNpc2FmYWtldG9rZW5zaGFwZQ==",
  };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(violations.length > 0, "sanity check: scanner must flag both shapes");
});

Deno.test("fixtures-secret-scan: sanity — the userAgent's example.com contact address is explicitly ALLOWED (RFC 2606)", () => {
  for (const { name, re } of SECRET_PATTERNS) {
    if (name.startsWith("email")) {
      assert(
        !re.test(GLOBAL_ARGS.userAgent),
        "fixture@example.com must not be flagged — it's the RFC 2606 documentation domain",
      );
    }
  }
});
