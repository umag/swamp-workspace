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
