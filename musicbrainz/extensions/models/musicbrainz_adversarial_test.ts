/**
 * Adversarial suite: hostile-HTML pins (malformed JSON-LD fallback,
 * script-injection text, huge/nested input, TralbumData //-strip URL
 * corruption), raw MBID path-interpolation injection (concrete captured-URL
 * assertions — a `new URL()` normalization spike showed an UNENCODED `../`
 * actually COLLAPSES the path, escaping even the `/ws/2/` prefix),
 * no-AbortSignal on either fetch site, 503-throws-without-honoring-Retry-After,
 * unvalidated-response type-confusion (no safeParse — a truthy non-array
 * `data.<key>` sails through unchanged, mirroring porkbun's `records || []`
 * pin), and a fixtures-secret-scan backstop over both the JSON and Bandcamp
 * HTML corpus.
 *
 * musicbrainz.ts is UNMODIFIED except for the bandcampUrl SSRF fix
 * (musicbrainz-ssrf-and-latent-bugs): fetchPage now requires an https
 * bandcamp.com/*.bandcamp.com URL via assertBandcampUrl, applied before any
 * network call and re-applied on every manual redirect hop. The two SSRF
 * tests below assert the FIX (rejection + zero egress), not the vulnerable
 * behavior; the positive allowlist/redirect/scheme tests that follow them
 * are new. Every other test in this file still PINS current behavior
 * (including behavior that is a real, documented gap) rather than proposing
 * a fix — those remaining pinned gaps are reported for separate filing under
 * musicbrainz-ssrf-and-latent-bugs, never fixed here.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
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

Deno.test("pin: TralbumData's //-comment-strip cleanup corrupts an embedded https:// URL, causing a JSON.parse failure that is silently swallowed — tracks end up EMPTY", async () => {
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
    0,
    "the TralbumData blob DID contain real track data, but the //-strip corrupted it into invalid JSON before parsing — tracks silently vanish rather than surfacing an error",
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

Deno.test("INJECTION: an UNENCODED '../../' MBID actually COLLAPSES the request path via standard URL dot-segment normalization, escaping even the /ws/2/ prefix", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-artist", { id: "../../secret" }, ctx).then(() => {
        assertEquals(
          new URL(calls[0].url).pathname,
          "/ws/secret",
          "the naive `/artist/${id}` interpolation, once run through new URL(), normalizes away BOTH '..' segments — the request lands on /ws/secret, not /ws/2/artist/../../secret",
        );
      }),
    ));
});

Deno.test("INJECTION: an MBID containing '/' adds an EXTRA path segment verbatim (no encodeURIComponent)", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-release", { id: "abc/def" }, ctx).then(() => {
        assertEquals(
          new URL(calls[0].url).pathname,
          "/ws/2/release/abc/def",
        );
      }),
    ));
});

Deno.test("INJECTION: an MBID containing '?' truncates the id there and INJECTS an arbitrary query parameter alongside fmt=json", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-recording", { id: "abc?inc=injected-param" }, ctx).then(
        () => {
          const url = new URL(calls[0].url);
          assertEquals(url.pathname, "/ws/2/recording/abc");
          assertEquals(url.searchParams.get("inc"), "injected-param");
          assertEquals(url.searchParams.get("fmt"), "json");
        },
      ),
    ));
});

Deno.test("INJECTION: an MBID containing '#' is embedded verbatim as a URL fragment — the query params (fmt=json) are unaffected", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture({ id: "whatever" }, (calls) =>
    drainAndAwait(
      time,
      run("lookup-label", { id: "abc#injected-fragment" }, ctx).then(() => {
        const url = new URL(calls[0].url);
        assertEquals(url.pathname, "/ws/2/label/abc");
        assertEquals(url.searchParams.get("fmt"), "json");
        // Whether a fragment is actually transmitted to a real server is
        // governed by HTTP/URL semantics outside musicbrainz.ts's control
        // (a live client strips fragments before opening the connection) —
        // this pin only characterizes THIS model's own string handling: the
        // raw id (fragment included) reaches the constructed URL unmodified.
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
// No AbortSignal / timeout on either fetch site
// ---------------------------------------------------------------------------

Deno.test("pin: mbFetch never passes an AbortSignal — a hung MusicBrainz endpoint would hang this call forever", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    { artists: [], count: 0 },
    (_calls, rawCalls) =>
      drainAndAwait(time, run("search-artist", { query: "x" }, ctx)).then(
        () => {
          assertEquals(rawCalls.length, 1);
          assertEquals(
            rawCalls[0].init?.signal,
            undefined,
            "no signal was ever passed in the fetch init — no client-side timeout exists",
          );
        },
      ),
  );
});

Deno.test("pin: fetchPage (Bandcamp) never passes an AbortSignal either", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => html(ALBUM_JSONLD_HTML)],
    async (_calls, rawCalls) => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/x",
      }, ctx);
      assertEquals(rawCalls[0].init?.signal, undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// 503 throws immediately — no Retry-After honored, no retry attempted
// ---------------------------------------------------------------------------

Deno.test("pin: a 503 WITH a Retry-After header still throws immediately — the header is never read, and no retry is attempted", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) =>
      isMbHost(req)
        ? json(error503, 503, { "Retry-After": "120" })
        : undefined],
    (calls) =>
      drainAndAwait(
        time,
        assertRejects(
          () => run("search-artist", { query: "x" }, ctx),
          Error,
          "503",
        ).then(() => {
          assertEquals(
            calls.length,
            1,
            "no retry was attempted despite the Retry-After hint",
          );
        }),
      ),
  );
});

// ---------------------------------------------------------------------------
// Unvalidated response — no safeParse, a truthy non-array field type-confuses
// the derived count (mirrors porkbun's `records || []` pin)
// ---------------------------------------------------------------------------

Deno.test("pin: a truthy non-array `artists` field (hostile/malformed response) type-confuses search-artist's derived count via `.length` on a STRING", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { artists: "not-an-array", count: 999 },
    () => drainAndAwait(time, run("search-artist", { query: "x" }, ctx)),
  );
  const res = written.find((w) => w.spec === "artists")!;
  assertEquals(
    res.payload.artists,
    "not-an-array",
    "the string sails through unfiltered — no shape validation at all",
  );
  assertEquals(
    res.payload.count,
    999,
    "count DOES come from data.count when present — the type-confusion only bites when count is absent (see the next test)",
  );
});

Deno.test("pin: when `count` is ALSO absent, a truthy non-array `artists` produces a STRING-LENGTH count, not an actual result count", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { artists: "abcdefghij" },
    () => drainAndAwait(time, run("search-artist", { query: "x" }, ctx)),
  );
  const res = written.find((w) => w.spec === "artists")!;
  assertEquals(res.payload.artists, "abcdefghij");
  assertEquals(
    res.payload.count,
    10,
    "count falls back to artists.length, which reads the STRING's character count",
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
