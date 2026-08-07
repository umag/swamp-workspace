/**
 * Coverage suite: sweeps every `data.<key> || fallback` guard in
 * musicbrainz.ts on BOTH sides, the generic-search results-key heuristic
 * (including its own empty-fallback branch), find-missing/seed-all-missing's
 * exact-match vs no-match vs artist-MBID-UNRESOLVED branches (the round-2
 * review fold-in — pinned for BOTH methods, not just one), the normalizeTitle
 * collision (observed only through execute(), since it is module-private),
 * buildSeedUrl's conditional param guards, the album-fetch try/catch
 * minimal-seed fallback, and (as of the musicbrainz-ssrf-and-latent-bugs LB5/
 * LB6 real fixes) normalizeTitle's NFKD-fold-then-strip collision rule plus
 * direct unit tests of the newly-exported `formatDuration()` helper — so
 * deleting any one of these guards turns a test red (STANDARD.md's coverage
 * role: a behavioral regression guard, not a numeric percentage).
 *
 * Most of this file still PINS unmodified behavior. The normalizeTitle
 * collision tests below were updated for the LB5 fix (NFKD decomposition +
 * combining-mark stripping + `\p{L}`/`\p{N}`-aware collapsing, replacing the
 * old ASCII-only `[^a-z0-9]` strip) — see each test's own comment for what
 * changed and why.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { formatDuration, model } from "./musicbrainz.ts";
import { ARTIST_MUSICGRID_HTML } from "../../fixtures/bandcamp/artist_musicgrid.ts";
import { ALBUM_JSONLD_HTML } from "../../fixtures/bandcamp/album_jsonld.ts";

const GLOBAL_ARGS = {
  userAgent: "swamp-musicbrainz-coverage-test/1.0 (fixture@example.com)",
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

type Route = (req: Request) => Response | Promise<Response> | undefined;

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
  fn: (calls: Request[]) => Promise<unknown>,
) {
  return withFetchStub(
    [(req) => (isMbHost(req) ? json(body) : undefined)],
    fn,
  );
}

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
// `data.<results-array>| []` — both sides, for every search/browse method
// ---------------------------------------------------------------------------

const SEARCH_GUARD_CASES: Array<
  [method: string, args: Record<string, unknown>, key: string, spec: string]
> = [
  ["search-artist", { query: "x" }, "artists", "artists"],
  ["search-release-group", { query: "x" }, "release-groups", "releaseGroups"],
  ["search-release", { query: "x" }, "releases", "releases"],
  ["search-recording", { query: "x" }, "recordings", "recordings"],
  ["search-label", { query: "x" }, "labels", "labels"],
];

for (const [method, args, wireKey, payloadKey] of SEARCH_GUARD_CASES) {
  Deno.test(`${method}: ${wireKey} ABSENT from the response -> [] and count 0`, async () => {
    using time = new FakeTime();
    const { ctx, written } = makeCtx();
    await withMbFixture({}, () => drainAndAwait(time, run(method, args, ctx)));
    const res = written.find((w) => w.spec === payloadKey)!;
    assertEquals(res.payload[payloadKey], []);
    assertEquals(res.payload.count, 0);
  });

  Deno.test(`${method}: ${wireKey} PRESENT -> passed through with matching count`, async () => {
    using time = new FakeTime();
    const { ctx, written } = makeCtx();
    const items = [{ id: "00000000-0000-0000-0000-000000000001" }];
    await withMbFixture(
      { [wireKey]: items },
      () => drainAndAwait(time, run(method, args, ctx)),
    );
    const res = written.find((w) => w.spec === payloadKey)!;
    assertEquals(res.payload[payloadKey], items);
    assertEquals(res.payload.count, 1);
  });
}

// ---------------------------------------------------------------------------
// browse-* — count/offset prefixed-key guards, both sides
// ---------------------------------------------------------------------------

Deno.test("browse-release-groups: release-group-count/offset ABSENT -> derived from array length / defaults to 0", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const rgs = [{ id: "00000000-0000-0000-0000-000000000101" }];
  await withMbFixture(
    { "release-groups": rgs },
    () =>
      drainAndAwait(
        time,
        run("browse-release-groups", { artist: "x" }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(res.payload.count, 1, "falls back to rgs.length");
  assertEquals(res.payload.offset, 0);
});

Deno.test("browse-release-groups: release-group-count/offset PRESENT -> used verbatim (not re-derived)", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    {
      "release-groups": [{ id: "00000000-0000-0000-0000-000000000101" }],
      "release-group-count": 999,
      "release-group-offset": 42,
    },
    () =>
      drainAndAwait(
        time,
        run("browse-release-groups", { artist: "x" }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(res.payload.count, 999);
  assertEquals(res.payload.offset, 42);
});

Deno.test("browse-releases: release-count/offset ABSENT -> derived / defaulted", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { releases: [{ id: "00000000-0000-0000-0000-000000000201" }] },
    () => drainAndAwait(time, run("browse-releases", { artist: "x" }, ctx)),
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(res.payload.count, 1);
  assertEquals(res.payload.offset, 0);
});

Deno.test("browse-recordings: recording-count/offset ABSENT -> derived / defaulted", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { recordings: [{ id: "00000000-0000-0000-0000-000000000301" }] },
    () => drainAndAwait(time, run("browse-recordings", { artist: "x" }, ctx)),
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(res.payload.count, 1);
  assertEquals(res.payload.offset, 0);
});

// ---------------------------------------------------------------------------
// generic search — resultsKey heuristic, including its OWN empty-fallback
// ---------------------------------------------------------------------------

Deno.test("search: when a non-meta key exists, it is picked as resultsKey (regardless of entity name)", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    {
      count: 1,
      offset: 0,
      works: [{ id: "00000000-0000-0000-0000-000000000601" }],
    },
    () =>
      drainAndAwait(time, run("search", { entity: "work", query: "x" }, ctx)),
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.results, [{
    id: "00000000-0000-0000-0000-000000000601",
  }]);
});

Deno.test("search: when NO non-meta key exists at all, resultsKey falls back to args.entity, and results is [] (Array.isArray guard fails on undefined)", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { count: 0, offset: 0, created: "2026-01-01T00:00:00.000Z" },
    () =>
      drainAndAwait(time, run("search", { entity: "work", query: "x" }, ctx)),
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.name, "work-search");
  assertEquals(res.payload.results, []);
});

Deno.test("search: count/offset ABSENT -> derived from results.length / defaulted to 0", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { areas: [{ id: "00000000-0000-0000-0000-000000000501" }] },
    () =>
      drainAndAwait(time, run("search", { entity: "area", query: "x" }, ctx)),
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.count, 1);
  assertEquals(res.payload.offset, 0);
});

// ---------------------------------------------------------------------------
// find-missing / seed-all-missing — exact-match / no-match / ARTIST-MBID-
// UNRESOLVED branches, pinned for BOTH methods (round-2 review fold-in)
// ---------------------------------------------------------------------------

function mbEmptyArtistSearch() {
  return json({ artists: [] });
}

Deno.test("find-missing: artist-MBID-UNRESOLVED (search returns no exact match) -> the MB release-group fetch is SKIPPED entirely; every bandcamp release is 'missing'", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(ARTIST_MUSICGRID_HTML) : undefined),
      (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
    ],
    (calls) =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        }, ctx).then(() => {
          assertEquals(
            calls.filter(isMbHost).length,
            1,
            "only the artist-search call — no release-group browse once artistMbid stays unresolved",
          );
        }),
      ),
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  assertEquals(res.payload.artistMbid, undefined);
  assertEquals(res.payload.mbReleaseCount, 0);
  assertEquals(
    res.name,
    "unknown",
    "writeResource's name falls back to 'unknown' when artistMbid is undefined",
  );
  const missing = res.payload.missing as unknown[];
  assertEquals(missing.length, 2, "both discography entries land in 'missing'");
});

Deno.test("seed-all-missing: artist-MBID-UNRESOLVED (mirror) -> MB release-group fetch skipped; every bandcamp release is seeded", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(ARTIST_MUSICGRID_HTML) : undefined),
      (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
    ],
    (calls) =>
      drainAndAwait(
        time,
        run("seed-all-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        }, ctx).then(() => {
          assertEquals(calls.filter(isMbHost).length, 1);
        }),
      ),
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.payload.artistMbid, undefined);
  assertEquals(res.name, "all-missing");
  assertEquals(res.payload.total, 2);
});

Deno.test("find-missing: an EXACT normalizeTitle match resolves the artist, matched[] gets an entry, and only the remainder is 'missing'", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(ARTIST_MUSICGRID_HTML) : undefined),
      (req) => {
        if (!isMbHost(req)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/ws/2/artist/") {
          return json({
            artists: [{
              id: "00000000-0000-0000-0000-000000000001",
              name: "Fixture Marin Holloway",
            }],
          });
        }
        return json({
          "release-groups": [{
            id: "00000000-0000-0000-0000-000000000601",
            title: "Fixture Drift Sessions",
          }],
          "release-group-count": 1,
          "release-group-offset": 0,
        });
      },
    ],
    (calls) =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        }, ctx).then(() => {
          assertEquals(
            calls.filter(isMbHost).length,
            2,
            "1 artist search + 1 release-group browse",
          );
        }),
      ),
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  assertEquals(res.payload.artistMbid, "00000000-0000-0000-0000-000000000001");
  const matched = res.payload.matched as Array<Record<string, unknown>>;
  const missing = res.payload.missing as unknown[];
  assertEquals(matched.length, 1);
  assertEquals(missing.length, 1);
});

Deno.test("find-missing: the album-fetch try/catch — a failing per-album fetch falls back to a MINIMAL seed URL (no track data, still succeeds)", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        if (!isBcHost(req)) return undefined;
        const url = new URL(req.url);
        // Discography listing succeeds; the per-album detail fetch (any
        // /album or /track path) FAILS to exercise the try/catch fallback.
        if (url.pathname.endsWith("/music")) return html(ARTIST_MUSICGRID_HTML);
        return html("server error", 500);
      },
      () => mbEmptyArtistSearch(),
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  const missing = res.payload.missing as Array<Record<string, unknown>>;
  assertEquals(missing.length, 2);
  for (const m of missing) {
    assertEquals(
      m.numTracks,
      0,
      "the minimal fallback seed has no track-count data",
    );
    assert(
      (m.seedUrl as string).startsWith("https://musicbrainz.org/release/add?"),
      "the minimal fallback still produces a usable seed URL",
    );
  }
});

// ---------------------------------------------------------------------------
// normalizeTitle collision — observed only through execute() (module-private)
// ---------------------------------------------------------------------------

Deno.test("normalizeTitle COLLISION: 'Fixture-Drift Sessions' (bandcamp) and 'Fixture Drift Sessions' (MusicBrainz) normalize identically and are treated as a MATCH", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const collidingBcHtml = `<!doctype html>
<html><head></head><body>
<p id="band-name-location"><span class="title">Fixture Marin Holloway</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/x"><p class="title">Fixture-Drift Sessions</p></a></li>
</ol></div>
</body></html>`;
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(collidingBcHtml) : undefined),
      (req) => {
        if (!isMbHost(req)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/ws/2/artist/") {
          return json({
            artists: [{
              id: "00000000-0000-0000-0000-000000000001",
              name: "Fixture Marin Holloway",
            }],
          });
        }
        return json({
          "release-groups": [{
            id: "00000000-0000-0000-0000-000000000601",
            title: "Fixture Drift Sessions",
          }],
          "release-group-count": 1,
          "release-group-offset": 0,
        });
      },
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  const matched = res.payload.matched as Array<Record<string, unknown>>;
  const missing = res.payload.missing as unknown[];
  assertEquals(
    matched.length,
    1,
    "the hyphen in 'Fixture-Drift' and the space in 'Fixture Drift' both strip to the same normalized string — treated as the SAME release, which may be a false-positive match for two genuinely different titles that merely share letters",
  );
  assertEquals(missing.length, 0);
  assertEquals(matched[0].bcTitle, "Fixture-Drift Sessions");
  assertEquals(matched[0].mbTitle, "Fixture Drift Sessions");
});

Deno.test("LB5 FIX: 'Café Nuit' (bandcamp) and 'Caf Nuit' (MusicBrainz) NO LONGER collide — NFKD decomposition + combining-mark stripping folds 'é' to 'e', so 'Café' normalizes to 'cafe', distinct from 'caf'", async () => {
  // Distinct from the ASCII punctuation-collision test above: this covers the
  // OVER-COLLAPSE mode most likely to surprise a real user, since non-ASCII
  // artist/track names are common on both MusicBrainz and Bandcamp.
  // normalizeTitle now runs `s.normalize("NFKD")` (decomposing "é" into "e" +
  // a combining acute accent), strips the combining mark, lowercases, then
  // collapses non-letter/non-number runs to a single space — "Café Nuit" ->
  // "cafe nuit", "Caf Nuit" -> "caf nuit". These are different strings, so
  // the false match this used to produce is gone.
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const unicodeBcHtml = `<!doctype html>
<html><head></head><body>
<p id="band-name-location"><span class="title">Fixture Unicode Artist</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/x"><p class="title">Café Nuit</p></a></li>
</ol></div>
</body></html>`;
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(unicodeBcHtml) : undefined),
      (req) => {
        if (!isMbHost(req)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/ws/2/artist/") {
          return json({
            artists: [{
              id: "00000000-0000-0000-0000-000000000001",
              name: "Fixture Unicode Artist",
            }],
          });
        }
        return json({
          "release-groups": [{
            id: "00000000-0000-0000-0000-000000000701",
            title: "Caf Nuit",
          }],
          "release-group-count": 1,
          "release-group-offset": 0,
        });
      },
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixtureunicodeartist.bandcamp.com",
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  const matched = res.payload.matched as Array<Record<string, unknown>>;
  const missing = res.payload.missing as Array<Record<string, unknown>>;
  assertEquals(
    matched.length,
    0,
    "'Café Nuit' now normalizes to \"cafe nuit\" (the accent folds via NFKD, it no longer vanishes) while 'Caf Nuit' normalizes to \"caf nuit\" — distinct strings, no more false match",
  );
  assertEquals(missing.length, 1);
  assertEquals(missing[0].title, "Café Nuit");
});

Deno.test("LB5 FIX: a CJK title and a punctuation-only title NO LONGER collide — CJK characters are \\p{L} (Letter) and survive, '---' collapses to an empty/whitespace string that no longer equals a real title", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const cjkBcHtml = `<!doctype html>
<html><head></head><body>
<p id="band-name-location"><span class="title">Fixture CJK Artist</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/x"><p class="title">北京</p></a></li>
</ol></div>
</body></html>`;
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(cjkBcHtml) : undefined),
      (req) => {
        if (!isMbHost(req)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/ws/2/artist/") {
          return json({
            artists: [{
              id: "00000000-0000-0000-0000-000000000001",
              name: "Fixture CJK Artist",
            }],
          });
        }
        // "---" normalizes to "" (every char is punctuation, collapsed and
        // trimmed to nothing) while "北京" normalizes to itself (CJK
        // characters are \p{L} under the new \p{L}/\p{N} rule, never
        // stripped) — the two are no longer equal.
        return json({
          "release-groups": [{
            id: "00000000-0000-0000-0000-000000000702",
            title: "---",
          }],
          "release-group-count": 1,
          "release-group-offset": 0,
        });
      },
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturecjkartist.bandcamp.com",
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  const matched = res.payload.matched as Array<Record<string, unknown>>;
  const missing = res.payload.missing as Array<Record<string, unknown>>;
  assertEquals(
    matched.length,
    0,
    "a CJK title (letters, preserved) and a punctuation-only title (collapses to empty) no longer normalize to the same string",
  );
  assertEquals(missing.length, 1);
  assertEquals(missing[0].title, "北京");
});

// ---------------------------------------------------------------------------
// LB5 FIX coverage: 'Motörhead' now matches 'Motorhead' — the whole point of
// switching from ASCII-deletion to NFKD-fold-then-strip is that a diacritic
// FOLDS to its base letter instead of vanishing, so titles that a human would
// consider the SAME now collide, while titles that only coincidentally shared
// letters after ASCII-stripping (Café/Caf, CJK/---, see above) no longer do.
// ---------------------------------------------------------------------------

Deno.test("LB5 FIX: 'Motörhead' (bandcamp) and 'Motorhead' (MusicBrainz) now MATCH — NFKD folds 'ö' to 'o' instead of deleting it", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const motorheadBcHtml = `<!doctype html>
<html><head></head><body>
<p id="band-name-location"><span class="title">Fixture Motörhead Artist</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/x"><p class="title">Motörhead</p></a></li>
</ol></div>
</body></html>`;
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(motorheadBcHtml) : undefined),
      (req) => {
        if (!isMbHost(req)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/ws/2/artist/") {
          return json({
            artists: [{
              id: "00000000-0000-0000-0000-000000000001",
              name: "Fixture Motörhead Artist",
            }],
          });
        }
        return json({
          "release-groups": [{
            id: "00000000-0000-0000-0000-000000000703",
            title: "Motorhead",
          }],
          "release-group-count": 1,
          "release-group-offset": 0,
        });
      },
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturemotorheadartist.bandcamp.com",
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  const matched = res.payload.matched as Array<Record<string, unknown>>;
  const missing = res.payload.missing as unknown[];
  assertEquals(
    matched.length,
    1,
    "'Motörhead' normalizes to \"motorhead\" (NFKD decomposes 'ö' to 'o' + a combining diaeresis, which is stripped) — identical to 'Motorhead' normalized",
  );
  assertEquals(missing.length, 0);
  assertEquals(matched[0].bcTitle, "Motörhead");
  assertEquals(matched[0].mbTitle, "Motorhead");
});

// ---------------------------------------------------------------------------
// buildSeedUrl conditional guards — durationMs / releaseDate parts / artistMbid
// ---------------------------------------------------------------------------

Deno.test("buildSeedUrl: a track with durationMs=0 OMITS the length param (falsy guard, not a presence check)", async () => {
  const zeroDurationHtml = `<!doctype html>
<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicAlbum","name":"Fixture Zero Duration","byArtist":{"name":"Fixture Artist"},"track":{"itemListElement":[{"position":1,"item":{"name":"Silent Track","duration":"PT0S"}}]}}</script>
</head><body></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(zeroDurationHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/zero",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  const seedUrl = new URL(release.seedUrl as string);
  assert(
    !seedUrl.searchParams.has("mediums.0.track.0.length"),
    "durationMs=0 is falsy -> the length param is omitted entirely, not sent as '0'",
  );
});

Deno.test("buildSeedUrl: a PARTIAL releaseDate (year only, no month/day) only sets the year param", async () => {
  const partialDateHtml = `<!doctype html>
<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicAlbum","name":"Fixture Partial Date","byArtist":{"name":"Fixture Artist"},"datePublished":"2021","track":{"itemListElement":[]}}</script>
</head><body></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(partialDateHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/partial",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  const seedUrl = new URL(release.seedUrl as string);
  assertEquals(seedUrl.searchParams.get("events.0.date.year"), "2021");
  assert(!seedUrl.searchParams.has("events.0.date.month"));
  assert(!seedUrl.searchParams.has("events.0.date.day"));
});

Deno.test("buildSeedUrl: NO releaseDate at all -> no date params set, no crash", async () => {
  const noDateHtml = `<!doctype html>
<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicAlbum","name":"Fixture No Date","byArtist":{"name":"Fixture Artist"},"track":{"itemListElement":[]}}</script>
</head><body></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(noDateHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/nodate",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  const seedUrl = new URL(release.seedUrl as string);
  assert(!seedUrl.searchParams.has("events.0.date.year"));
  assertEquals(release.releaseDate, "");
});

Deno.test("buildSeedUrl: artistMbid UNSET omits the mbid param but still sets the artist name param", async () => {
  const { ctx, written } = makeCtx();
  const albumHtml = `<!doctype html>
<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicAlbum","name":"Fixture No Mbid","byArtist":{"name":"Fixture Artist"},"track":{"itemListElement":[]}}</script>
</head><body></body></html>`;
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(albumHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/nombid",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  const seedUrl = new URL(release.seedUrl as string);
  assert(!seedUrl.searchParams.has("artist_credit.names.0.mbid"));
  assertEquals(
    seedUrl.searchParams.get("artist_credit.names.0.artist.name"),
    "Fixture Artist",
  );
});

// ---------------------------------------------------------------------------
// LB6 FIX: formatDuration() — H:MM:SS past one hour, else M:SS. Now exported,
// so tested directly rather than only through execute() (unlike
// normalizeTitle, which stays module-private).
// ---------------------------------------------------------------------------

Deno.test("formatDuration: 65 seconds -> '1:05' (under an hour, M:SS, no leading hour)", () => {
  assertEquals(formatDuration(65), "1:05");
});

Deno.test("formatDuration: 3750 seconds -> '1:02:30' (past an hour, H:MM:SS, hours no longer silently dropped)", () => {
  assertEquals(formatDuration(3750), "1:02:30");
});

Deno.test("formatDuration: 3600 seconds -> '1:00:00' (exactly one hour)", () => {
  assertEquals(formatDuration(3600), "1:00:00");
});

Deno.test("formatDuration: 0 seconds -> '0:00'", () => {
  assertEquals(formatDuration(0), "0:00");
});

// ---------------------------------------------------------------------------
// musicbrainz-discography-sync: NEW METHOD/RESOURCE SURFACE — the model
// registers sync-artist-discographies and its discographySyncState resource
// — plus its maxPages/truncated-flag guard (a code-reviewer-found gap:
// silently caching a partial discography as complete, with no test
// protecting it, would ship again without this). General execute() paths
// (explicit artistMbids, the search-artist fallback, cursor resume across
// runs, the no-artist-list error) live in musicbrainz_methods_test.ts; the
// stale-cache/count:0 failure-mode branches live in
// musicbrainz_adversarial_test.ts; the pure classifyDiscographyCache/
// isCacheStale/rateLimitDelayMs/retryAfterBackoffMs invariants everything
// here is built on live in musicbrainz_property_test.ts.
// ---------------------------------------------------------------------------

Deno.test("NEW SURFACE: sync-artist-discographies is a registered method with its own discographySyncState resource, and every arg is optional", () => {
  const method = (model.methods as MethodMap)["sync-artist-discographies"];
  assert(method, "sync-artist-discographies must be a registered method");
  assertEquals(
    method.arguments.parse({}),
    {},
    "every argument is optional — a bare {} must parse cleanly — batchSize has no zod .default(), the list-length default lives in the execute body",
  );
  assert(
    "discographySyncState" in model.resources,
    "the discographySyncState resource must be registered",
  );
  // The eight new coverage/keying fields (requested, requestedRaw,
  // listFingerprint, startOffset, covered, remaining, uncovered,
  // uncoveredCount) are all OPTIONAL — a state written by a version before
  // this change (which has none of them) must still parse cleanly, and no
  // `resetCursor` argument was added, so nothing new enters this pin.
  const resourceSchema = (model.resources as Record<
    string,
    { schema: { parse: (v: unknown) => unknown } }
  >).discographySyncState.schema;
  const updatedAt = new Date().toISOString();
  const minimal = resourceSchema.parse({
    cursor: { offset: 0 },
    processed: [],
    skipped: [],
    updatedAt,
  });
  assertEquals(
    minimal,
    { cursor: { offset: 0 }, processed: [], skipped: [], updatedAt },
    "a pre-this-change state (none of the eight new fields present) must still parse cleanly",
  );
});

Deno.test("HELP-TEXT GUARD: sync-artist-discographies' argument describes and method description no longer advertise the deleted search-artist fallback or the stale batchSize default — this is what stops the authoritative machine surface (swamp model type describe) drifting back", () => {
  const method = (model.methods as Record<string, {
    description: string;
    arguments: { shape: Record<string, { description?: string }> };
  }>)["sync-artist-discographies"];
  assert(
    !method.description.includes("search-artist"),
    "the method description must not mention the deleted search-artist fallback",
  );
  assert(
    !method.description.includes(
      "repeated batches cover the artist list exactly once",
    ),
    "the method description must not claim batches cover the list exactly once by default — one run now covers it",
  );
  const shape = method.arguments.shape;
  assert(
    !shape.artistMbids.description?.includes("search-artist"),
    "artistMbids' describe() must not mention the deleted search-artist fallback",
  );
  for (const [key, field] of Object.entries(shape)) {
    assert(
      !field.description?.includes("default 10"),
      `${key}'s describe() must not contain the literal "default 10"`,
    );
  }
  assert(
    shape.batchSize.description?.includes("~35"),
    "batchSize's describe() must state the ~35-minute cold-pass cost",
  );
});

type SyncStore = Map<string, Record<string, unknown>>;

/** Stub context for sync-artist-discographies: `readResource` is a real
 * in-memory map (keyed on instance name only, matching the runtime
 * contract) so the method can read back its own prior writes within a
 * single test. */
function makeSyncCtx(store: SyncStore = new Map()) {
  const written: Written[] = [];
  return {
    written,
    store,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      definition: { name: "test-instance" },
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

Deno.test("sync-artist-discographies: pagination stops at maxPages and marks the discography truncated, not silently complete", async () => {
  using time = new FakeTime();
  const artistMbid = "aaaaaaaa-0000-4000-8000-000000000099";
  let pageCallCount = 0;
  const { written, ctx } = makeSyncCtx();
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      pageCallCount++;
      // Every page comes back full (100 release groups), so without the
      // maxPages ceiling this would page forever.
      const releaseGroups = Array.from({ length: 100 }, (_, i) => ({
        id: `rg-${pageCallCount}-${i}`,
        title: `Release ${pageCallCount}-${i}`,
      }));
      return json({
        "release-groups": releaseGroups,
        "release-group-count": 10_000, // MusicBrainz reports far more exist
      });
    }],
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: [artistMbid],
          maxPages: 3,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  assertEquals(pageCallCount, 3);
  const cached = written.find((w) => w.name === `rg-by-artist-${artistMbid}`)!;
  assertEquals(cached.payload.truncated, true);
  assertEquals((cached.payload.results as unknown[]).length, 300);
});

Deno.test("sync-artist-discographies: a discography that ends naturally within the page ceiling is NOT marked truncated", async () => {
  using time = new FakeTime();
  const artistMbid = "aaaaaaaa-0000-4000-8000-000000000098";
  let pageCallCount = 0;
  const { written, ctx } = makeSyncCtx();
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      pageCallCount++;
      // First page full (100), second page partial (37) — a natural end.
      const size = pageCallCount === 1 ? 100 : 37;
      const releaseGroups = Array.from({ length: size }, (_, i) => ({
        id: `rg-${pageCallCount}-${i}`,
        title: `Release ${pageCallCount}-${i}`,
      }));
      return json({
        "release-groups": releaseGroups,
        "release-group-count": 137,
      });
    }],
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: [artistMbid],
          maxPages: 5,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  assertEquals(pageCallCount, 2);
  const cached = written.find((w) => w.name === `rg-by-artist-${artistMbid}`)!;
  assertEquals(cached.payload.truncated, false);
  assertEquals((cached.payload.results as unknown[]).length, 137);
});

// ---------------------------------------------------------------------------
// Model surface enumeration — closed-set guard over model.methods /
// model.resources, in music-library's style (music_library_coverage_test.ts:
// 418-450): "if someone adds a method or resource to musicbrainz.ts without
// adding a matching test suite entry, does a test go red?" musicbrainz had
// NO closed-set enumeration before this — only per-feature "NEW SURFACE"
// pins (one existed, above) — so surface growth failed nothing
// automatically, which is exactly how search-artists-batch nearly shipped
// unenumerated. Seeded from model.methods/model.resources AS THEY STAND
// after step 6 (19 methods, 12 resources) — must be updated in the SAME
// change that adds a method or resource, not as an afterthought.
// ---------------------------------------------------------------------------

const KNOWN_METHODS = [
  "search-artist",
  "search-artists-batch",
  "search-release-group",
  "search-release",
  "search-recording",
  "search-label",
  "lookup-artist",
  "lookup-release-group",
  "lookup-release",
  "lookup-recording",
  "lookup-label",
  "browse-release-groups",
  "browse-releases",
  "browse-recordings",
  "sync-artist-discographies",
  "seed-from-bandcamp",
  "find-missing",
  "seed-all-missing",
  "search",
].sort();

const KNOWN_RESOURCES = [
  "search",
  "entity",
  "browse",
  "discographySyncState",
  "artists",
  "releaseGroups",
  "releases",
  "recordings",
  "labels",
  "artistSearchBatch",
  "seedUrls",
  "missingReleases",
].sort();

Deno.test("model surface: methods enumerate to EXACTLY the known 19 — a new method must be added here too", () => {
  assertEquals(Object.keys(model.methods).sort(), KNOWN_METHODS);
});

Deno.test("model surface: resources enumerate to EXACTLY the known 12 — a new resource must be added here too", () => {
  assertEquals(Object.keys(model.resources).sort(), KNOWN_RESOURCES);
});

// ---------------------------------------------------------------------------
// NEW SURFACE: search-artists-batch — registered method + artistSearchBatch
// resource, correct instance name, and the regression pin for the payload
// budget (step 5's MongoDB 16MB guard): a full MusicBrainz artist object
// carrying area/begin-area/life-span/aliases/tags must NOT survive into the
// written row — only projectArtistCandidates' {id, name, sort-name}.
// ---------------------------------------------------------------------------

Deno.test("NEW SURFACE: search-artists-batch is a registered method with its own artistSearchBatch resource", () => {
  const method = (model.methods as MethodMap)["search-artists-batch"];
  assert(method, "search-artists-batch must be a registered method");
  assert(
    "artistSearchBatch" in model.resources,
    "the artistSearchBatch resource must be registered",
  );
});

Deno.test("NEW SURFACE: search-artists-batch writes instance name 'artist-search-batch' — explicitly NOT 'search' (the colliding instance every other search-* method writes to)", async () => {
  using time = new FakeTime();
  const store: SyncStore = new Map();
  const { written, ctx } = makeSyncCtx(store);
  await withFetchStub(
    [(req) => (isMbHost(req) ? json({ artists: [], count: 0 }) : undefined)],
    () =>
      drainAndAwait(
        time,
        run("search-artists-batch", {
          queries: ['artist:"Fixture Solo"'],
          minIntervalMs: 5,
          maxDurationMs: 600_000,
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  assert(res, "must have written the artistSearchBatch spec");
  assertEquals(res.name, "artist-search-batch");
  assert(
    res.name !== "search",
    "must never collide with the shared 'search' instance",
  );
});

Deno.test("NEW SURFACE (payload budget regression): a full MusicBrainz artist object with area/begin-area/life-span/aliases/tags writes a row whose artist objects contain NONE of those keys", async () => {
  using time = new FakeTime();
  const store: SyncStore = new Map();
  const { written, ctx } = makeSyncCtx(store);
  const fullArtist = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Fixture Full Artist",
    "sort-name": "Fixture Full Artist",
    type: "Person",
    score: 100,
    country: "US",
    area: { id: "area-1", name: "Fixture Land" },
    "begin-area": { id: "area-2", name: "Fixture City" },
    "life-span": { begin: "1990", ended: false },
    aliases: [{ name: "Fixture Alias", "sort-name": "Alias, Fixture" }],
    tags: [{ count: 5, name: "fixture-tag" }],
    disambiguation: "the fixture one",
  };
  await withFetchStub(
    [(req) =>
      isMbHost(req) ? json({ artists: [fullArtist], count: 1 }) : undefined],
    () =>
      drainAndAwait(
        time,
        run("search-artists-batch", {
          queries: ['artist:"Fixture Full Artist"'],
          minIntervalMs: 5,
          maxDurationMs: 600_000,
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  const rows = res.payload.queries as Array<
    { artists: Array<Record<string, unknown>> }
  >;
  const projected = rows[0].artists[0];
  for (
    const forbidden of [
      "area",
      "begin-area",
      "life-span",
      "aliases",
      "tags",
      "type",
      "score",
      "country",
      "disambiguation",
    ]
  ) {
    assert(
      !Object.hasOwn(projected, forbidden),
      `must NOT carry "${forbidden}" — only the projected {id, name, sort-name} shape`,
    );
  }
  assertEquals(Object.keys(projected).sort(), ["id", "name", "sort-name"]);
});

// ---------------------------------------------------------------------------
// COLLISION INVARIANT (musicbrainz-search-resource-collision) — every
// resource INSTANCE this model writes must map to exactly one resource SPEC.
// Before this fix, all five typed search methods wrote the shared literal
// instance "search" under five different specs (artists/releaseGroups/
// releases/recordings/labels), so a reader keyed on instance name alone
// (`readResource(name)`) saw whichever method happened to run last.
//
// COLLISION_FIXTURES carries one execution recipe per model method, pinned
// 1:1 against `model.methods` (assertEquals below) so a new method cannot be
// added to this model without a fixture covering it here — every method
// writes a resource, so every method needs one. The generic `search` entry
// expands over its OWN entity enum, read live from
// `model.methods.search.arguments` (never hardcoded), rather than counting
// as a single execution: 18 non-generic fixtures + 12 entity-expanded
// `search` runs = 30 method executions total, not 19 and not 31 (the
// unexpanded `search` entry only counts once as a KEY, not as an
// execution). Every fixture runs through this file's existing host-routed
// fetch stub (`withFetchStub`/`json`/`html`/`isMbHost`/`isBcHost`) and the
// shared `FakeTime`/`drainAndAwait` pair used everywhere else in this
// suite — the module-level ~1100ms mbFetch spacer applies to every fixture
// except `seed-from-bandcamp` (Bandcamp scraping is not rate-limited; see
// musicbrainz.ts's own comment above `mbFetch`), so a bare `await` here
// would hang, not fail, without draining the fake clock. Bandcamp-backed
// fixtures (`seed-from-bandcamp`, `find-missing`, `seed-all-missing`) reuse
// the shared fixture modules under `fixtures/bandcamp/` already imported by
// this file and by `musicbrainz_methods_test.ts`, rather than inlining new
// HTML.
//
// SCOPE, stated honestly in this comment because it must not be overclaimed
// anywhere else either: this is a BEHAVIOURAL statement over the fixture set
// actually executed below, not a proof over every possible argument.
// `find-missing` and `seed-all-missing` both derive their written instance
// name directly from an UNCONSTRAINED free-string `artistMbid`
// (`artistMbid || "unknown"` / `artistMbid || "all-missing"` in
// musicbrainz.ts), so any caller-supplied string reaches the instance name
// unfiltered — no test, this one included, can close that channel. This
// invariant only ever says "collision-free across the fixtures actually run
// here, with one named, tracked carve-out" — never "any present or future
// collision".
//
// The one carve-out: `find-missing` and `seed-all-missing` both key their
// write on the SAME optional `artistMbid` argument (`missingReleases` vs
// `seedUrls`), so one artist run through both methods produces the
// identical defect this issue fixes for the five search methods — pinned
// live already at musicbrainz_methods_test.ts:1053-1054 and :1118-1119, with
// one row already on the live instance. It is explicitly OUT OF SCOPE here
// (see the plan's hard constraints) and tracked by its own filed issue,
// `musicbrainz-missing-seed-instance-collision`. `KNOWN_UNFIXED_COLLISIONS`
// is keyed on the INSTANCE NAME **and** the sorted spec set together, not
// the spec set alone: spec `seedUrls` has a SECOND writer at instance
// `seed-single` (`seed-from-bandcamp`, musicbrainz.ts:2025), and a
// spec-set-only key would silently excuse a future `{missingReleases,
// seedUrls}` pair arising at any OTHER instance name too. The test also
// asserts every allowlist key was actually observed, so this carve-out
// self-destructs (goes red) the moment the follow-up issue lands and the
// collision it names stops occurring.
// ---------------------------------------------------------------------------

const COLLISION_ARTIST_MBID = "00000000-0000-0000-0000-000000000001";
const COLLISION_SYNC_ARTIST_MBID = "aaaaaaaa-0000-4000-8000-000000009001";
const COLLISION_BROWSE_ARTIST = "aaaaaaaa-0000-4000-8000-000000009002";

type CollisionWrite = { name: string; spec: string };

/** Context shared by every collision fixture: a single in-memory store backs
 * BOTH `readResource` (so `sync-artist-discographies`' cursor/cache reads
 * resolve to `null` -> "never fetched", never throwing) and `writeResource`
 * (which records every write for the invariant to inspect). No other
 * fixture needs `readResource`, but sharing one context shape keeps this
 * table uniform instead of branching per method. */
function makeCollisionCtx() {
  const written: CollisionWrite[] = [];
  const store = new Map<string, Record<string, unknown>>();
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      definition: { name: "collision-test-instance" },
      readResource: (name: string) =>
        Promise.resolve(store.get(name) ?? null),
      writeResource: (spec: string, name: string, payload: unknown) => {
        store.set(name, payload as Record<string, unknown>);
        written.push({ spec, name });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

/** Runs one method to completion against a fresh fetch stub + collision
 * context, returning every (instanceName, specName) pair it wrote. */
async function runCollision(
  time: FakeTime,
  method: string,
  args: Record<string, unknown>,
  routes: Route[],
): Promise<CollisionWrite[]> {
  const { written, ctx } = makeCollisionCtx();
  await withFetchStub(
    routes,
    () => drainAndAwait(time, run(method, args, ctx)),
  );
  return written;
}

const mbRoute = (body: unknown): Route => (req) =>
  isMbHost(req) ? json(body) : undefined;
const bcRoute = (body: string): Route => (req) =>
  isBcHost(req) ? html(body) : undefined;

/** The generic `search` method's entity enum, read LIVE off the model's own
 * declared arguments schema (musicbrainz.ts:2314-2326) rather than
 * hardcoded — a 13th entity added to the enum is automatically covered by
 * one more execution here, with no edit needed in this file. */
type SearchEntityShape = {
  arguments: { shape: { entity: { options: readonly string[] } } };
};
const SEARCH_ENTITIES =
  (model.methods as unknown as Record<string, SearchEntityShape>).search
    .arguments.shape.entity.options;

const COLLISION_FIXTURES: Record<
  string,
  (time: FakeTime) => Promise<CollisionWrite[]>
> = {
  "search-artist": (time) =>
    runCollision(time, "search-artist", { query: "x" }, [
      mbRoute({ artists: [], count: 0 }),
    ]),
  "search-artists-batch": (time) =>
    runCollision(
      time,
      "search-artists-batch",
      { queries: ["x"], minIntervalMs: 5, maxDurationMs: 600_000 },
      [mbRoute({ artists: [], count: 0 })],
    ),
  "search-release-group": (time) =>
    runCollision(time, "search-release-group", { query: "x" }, [
      mbRoute({ "release-groups": [], count: 0 }),
    ]),
  "search-release": (time) =>
    runCollision(time, "search-release", { query: "x" }, [
      mbRoute({ releases: [], count: 0 }),
    ]),
  "search-recording": (time) =>
    runCollision(time, "search-recording", { query: "x" }, [
      mbRoute({ recordings: [], count: 0 }),
    ]),
  "search-label": (time) =>
    runCollision(time, "search-label", { query: "x" }, [
      mbRoute({ labels: [], count: 0 }),
    ]),
  "lookup-artist": (time) =>
    runCollision(time, "lookup-artist", { id: "collision-artist" }, [
      mbRoute({}),
    ]),
  "lookup-release-group": (time) =>
    runCollision(time, "lookup-release-group", { id: "collision-rg" }, [
      mbRoute({}),
    ]),
  "lookup-release": (time) =>
    runCollision(time, "lookup-release", { id: "collision-rel" }, [
      mbRoute({}),
    ]),
  "lookup-recording": (time) =>
    runCollision(time, "lookup-recording", { id: "collision-rec" }, [
      mbRoute({}),
    ]),
  "lookup-label": (time) =>
    runCollision(time, "lookup-label", { id: "collision-lbl" }, [
      mbRoute({}),
    ]),
  "browse-release-groups": (time) =>
    runCollision(
      time,
      "browse-release-groups",
      { artist: COLLISION_BROWSE_ARTIST },
      [mbRoute({ "release-groups": [] })],
    ),
  "browse-releases": (time) =>
    runCollision(
      time,
      "browse-releases",
      { artist: COLLISION_BROWSE_ARTIST },
      [mbRoute({ releases: [] })],
    ),
  "browse-recordings": (time) =>
    runCollision(
      time,
      "browse-recordings",
      { artist: COLLISION_BROWSE_ARTIST },
      [mbRoute({ recordings: [] })],
    ),
  "sync-artist-discographies": (time) =>
    runCollision(
      time,
      "sync-artist-discographies",
      { artistMbids: [COLLISION_SYNC_ARTIST_MBID], minIntervalMs: 5 },
      [mbRoute({ "release-groups": [] })],
    ),
  "seed-from-bandcamp": (time) =>
    runCollision(
      time,
      "seed-from-bandcamp",
      { bandcampUrl: "https://fixturecollision.bandcamp.com/album/x" },
      [bcRoute(ALBUM_JSONLD_HTML)],
    ),
  // find-missing and seed-all-missing are BOTH given the SAME artistMbid —
  // matching the existing live pins at musicbrainz_methods_test.ts:1053-1054
  // and :1118-1119 — so the second, already-tracked live collision
  // (KNOWN_UNFIXED_COLLISIONS below) is genuinely observed here, not assumed.
  "find-missing": (time) =>
    runCollision(
      time,
      "find-missing",
      {
        bandcampUrl: "https://fixturecollision.bandcamp.com",
        artistMbid: COLLISION_ARTIST_MBID,
      },
      [
        bcRoute(ARTIST_MUSICGRID_HTML),
        mbRoute({
          "release-groups": [
            { id: "rg-1", title: "Fixture Drift Sessions" },
          ],
          "release-group-count": 1,
          "release-group-offset": 0,
        }),
      ],
    ),
  "seed-all-missing": (time) =>
    runCollision(
      time,
      "seed-all-missing",
      {
        bandcampUrl: "https://fixturecollision.bandcamp.com",
        artistMbid: COLLISION_ARTIST_MBID,
      },
      [
        bcRoute(ARTIST_MUSICGRID_HTML),
        mbRoute({
          "release-groups": [
            { id: "rg-1", title: "Fixture Drift Sessions" },
          ],
          "release-group-count": 1,
          "release-group-offset": 0,
        }),
      ],
    ),
  search: async (time) => {
    const all: CollisionWrite[] = [];
    for (const entity of SEARCH_ENTITIES) {
      const writes = await runCollision(
        time,
        "search",
        { entity, query: "x" },
        [mbRoute({ count: 0, offset: 0 })],
      );
      all.push(...writes);
    }
    return all;
  },
};

/** The one named, tracked carve-out — see the section comment above for why
 * it is keyed on the instance name AND the sorted spec set together. */
const KNOWN_UNFIXED_COLLISIONS = new Map<
  string,
  { producers: string[]; tracking: string }
>([
  [
    `${COLLISION_ARTIST_MBID}|missingReleases|seedUrls`,
    {
      producers: ["find-missing", "seed-all-missing"],
      tracking: "musicbrainz-missing-seed-instance-collision",
    },
  ],
]);

Deno.test("COLLISION INVARIANT: every resource instance this model writes maps to exactly one spec, except the one named, tracked carve-out", async () => {
  using time = new FakeTime();

  assertEquals(
    Object.keys(COLLISION_FIXTURES).sort(),
    Object.keys(model.methods).sort(),
    "every model method must have a COLLISION_FIXTURES entry — a new method must be added here too",
  );

  const byInstance = new Map<string, Set<string>>();
  for (const [method, fixture] of Object.entries(COLLISION_FIXTURES)) {
    const writes = await fixture(time);
    assert(writes.length > 0, `${method}'s collision fixture wrote nothing`);
    for (const { name, spec } of writes) {
      const specs = byInstance.get(name) ?? new Set<string>();
      specs.add(spec);
      byInstance.set(name, specs);
    }
  }

  const observedAllowlistKeys = new Set<string>();
  const offenders: string[] = [];
  for (const [name, specs] of byInstance) {
    if (specs.size <= 1) continue;
    const key = `${name}|${[...specs].sort().join("|")}`;
    if (KNOWN_UNFIXED_COLLISIONS.has(key)) {
      observedAllowlistKeys.add(key);
      continue;
    }
    offenders.push(`instance "${name}" maps to specs [${[...specs].sort().join(", ")}]`);
  }

  assertEquals(
    offenders,
    [],
    `collision-free invariant violated (a resource instance mapped to more than one spec, with no matching allowlist entry): ${
      offenders.join("; ")
    }`,
  );

  for (const key of KNOWN_UNFIXED_COLLISIONS.keys()) {
    assert(
      observedAllowlistKeys.has(key),
      `KNOWN_UNFIXED_COLLISIONS entry "${key}" was never observed in this run — the carve-out has rotted into a silent no-op (either the collision was fixed, or the fixture no longer reproduces it) and must be removed`,
    );
  }
});
