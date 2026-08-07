/**
 * Property-based / invariant / multi-step-flow tests (fast-check) for
 * @magistr/musicbrainz.
 *
 * musicbrainz.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch (host-routed
 * where Bandcamp + MusicBrainz both participate) and reading back the
 * written resource, per the approved plan (porkbun precedent, adapted for
 * the dual-endpoint + rate-limited surface).
 *
 * Properties:
 *  (a) search/browse result-array round-trip + count invariants.
 *  (b) seed-URL builder injectivity, MODULO the documented normalization
 *      (canonical non-collapsing subset — falsy releaseDate/durationMs/
 *      artistMbid all omit their param; the round-1 review precedent from
 *      porkbun applies here too) — plus explicit named collapse pins.
 *  (c) normalizeTitle collision property: two titles are predicted to
 *      collide using a LOCAL mirror of the (unexported) normalization rule
 *      read from source, post-LB5-fix (NFKD-decompose, strip the resulting
 *      combining marks, lowercase, collapse non-letter/non-number Unicode
 *      runs to a space, trim), then find-missing's actual match/missing
 *      classification is asserted against that prediction for every
 *      generated pair — never calling the private function directly, only
 *      observing its effect through execute().
 *  (d) two multi-step find-missing FLOW tests under FakeTime: the original
 *      pins the BOUNDED paginated release-group walk terminating on a
 *      naturally short page (offset 0->100->200-><100, asserting the offset
 *      progression) — the flow stub MUST terminate pagination with a <100
 *      page or the source's bounded loop would need its full `maxPages`
 *      iterations to stop. The second (LB4 FIX) proves the NEW `maxPages`
 *      cap terminates the walk even when EVERY page is full (would have
 *      looped forever pre-fix), by setting `globalArgs.maxPages: 2` against
 *      an always-full-page stub and asserting the walk stops after exactly
 *      2 pages.
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { FakeTime } from "jsr:@std/testing@1/time";
import {
  advanceSyncCursor,
  classifyDiscographyCache,
  dedupeMbids,
  dedupeQueries,
  deriveMaxDurationMs,
  fingerprintMbids,
  isCacheStale,
  model,
  planSearchBatch,
  projectArtistCandidates,
  rateLimitDelayMs,
  retryAfterBackoffMs,
  syncRunCoverage,
} from "./musicbrainz.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);

// ONE FakeTime instance for the ENTIRE file, shared by every test and every
// fast-check iteration within them — deliberately NOT re-constructed per
// Deno.test() or per property iteration. `lastRequest` (musicbrainz.ts
// module state) only ever advances forward and is never reset; a FRESH
// `FakeTime()` re-anchors to real "now" each time it's constructed, so if
// each test (or worse, each of fast-check's tens-to-thousands of iterations)
// got its own instance, the gap between that ever-resetting anchor and the
// ever-advancing `lastRequest` would grow without bound — empirically this
// produced 29-48 REAL seconds for just 40-75 iterations, and eventually a
// dangling/hung promise once the accumulated gap exceeded any fixed drain
// cap. Sharing exactly one clock across the whole file means the clock and
// `lastRequest` advance TOGETHER consistently: every individual mbFetch call
// only ever needs to drain the standard ~1100ms window (or a small bounded
// multiple for a 2-3-call flow), regardless of how many calls came before it
// anywhere else in this file. Never construct a second `FakeTime()` in this
// file — reuse this one.
//
// Deliberately left undisposed (no `using`, no explicit teardown): `deno
// test <dir>` gives each test FILE its own isolated global scope, so the
// patched timer functions here cannot leak into a DIFFERENT file's tests —
// empirically confirmed (all 109 tests across this file's 5 siblings pass
// regardless of run order). This is an assumption about the test runner,
// not something this file can verify on its own; if a future deno/test-
// runner change ever stopped isolating global scope per file, the failure
// mode would likely be a DIFFERENT file's real-timer test going flaky, not
// a loud error here — worth re-checking this comment if that ever happens.
const time = new FakeTime();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  userAgent: "swamp-musicbrainz-property-test/1.0 (fixture@example.com)",
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

// Eager plain-object snapshot instead of `.clone()` — cloning a body-bearing
// Request tees its body into a ReadableStream that is never consumed or
// cancelled, leaking ~6KB per stubbed fetch call (see
// fix/soak-property-harness-heap-leak). The body is read ONCE via
// `await req.text()`; routes get a freshly reconstructed Request built from
// the captured text so existing route logic (which may itself read the
// body) keeps working.
type CapturedRequest = {
  method: string;
  url: string;
  headers: Headers;
  body: string;
};

async function withFetchStub(
  routes: Route[],
  fn: (calls: CapturedRequest[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const body = await req.text();
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    const routable = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    for (const route of routes) {
      const res = await route(routable);
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
  fn: (calls: CapturedRequest[]) => Promise<unknown>,
) {
  return withFetchStub(
    [(req) => (isMbHost(req) ? json(body) : undefined)],
    fn,
  );
}

/**
 * Drains a FakeTime-scheduled promise. Ticks in LARGE steps (1200ms — just
 * over the rate limiter's 1100ms window) rather than many small ones: each
 * `tickAsync()` call carries real (non-fake) overhead in the Deno event
 * loop, so a naive many-small-ticks loop (originally 200ms steps) turned out
 * to cost ~200-300ms of REAL wall-clock time per rate-limiter wait it
 * drained — negligible for a handful of Deno.test() calls, but fast-check
 * calls the property function tens to thousands of times *within a single
 * Deno.test()*, and that per-wait real-time cost multiplied by run count
 * dominated this whole suite's runtime (empirically 29-48 REAL seconds for
 * 40-75 runs). Ticking in 1200ms jumps needs only ONE call to drain a
 * typical single wait (vs ~6 at 200ms steps), and the cap (30 iterations =
 * 36s of virtual time) comfortably covers the few-calls-per-iteration shape
 * every test in this file has (find-missing/seed-all-missing make at most 3
 * MB calls). `lastRequest` is module-level state in musicbrainz.ts that is
 * NEVER reset between fast-check iterations, but the resulting cross-
 * iteration debt stays bounded (each iteration only ever adds the small
 * amount ITS OWN calls advanced the clock by) — do NOT "fix" this by jumping
 * the clock forward by a huge amount before each iteration; that was tried
 * and made things catastrophically worse (it makes `lastRequest` itself an
 * enormous fake timestamp that then poisons every subsequent test in the
 * file with a multi-hour wait, since a fresh `FakeTime()` anchors back to
 * real "now" and computes `wait = 1100 - (now - lastRequest)` against that
 * inflated value).
 */
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
  for (let i = 0; i < 30 && !settled; i++) {
    await time.tickAsync(1200);
  }
  return await p;
}

/** Build a synthetic Bandcamp album page whose JSON-LD block embeds the
 * given title/artist/track deterministically via JSON.stringify (safe
 * against quoting — the generated strings are restricted to a charset with
 * no '<'/'>'  so the <script> tag itself can never be broken out of). */
function albumHtmlFor(
  title: string,
  artist: string,
  trackName: string,
  durationSeconds: number,
): string {
  const ld = {
    "@context": "https://schema.org",
    "@type": "MusicAlbum",
    name: title,
    byArtist: { name: artist },
    track: {
      itemListElement: [
        {
          position: 1,
          item: { name: trackName, duration: `PT${durationSeconds}S` },
        },
      ],
    },
  };
  return `<!doctype html><html><head><script type="application/ld+json">${
    JSON.stringify(ld)
  }</script></head><body></body></html>`;
}

// ---------------------------------------------------------------------------
// (a) search/browse result-array round-trip + count invariants
// ---------------------------------------------------------------------------

const arbArtist = fc.record({
  id: fc.stringMatching(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  ),
  name: fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/),
});

Deno.test("property: search-artist preserves every generated artist, in order, with count == length", async () => {
  // Uses the file-level shared `time` (see its header comment) — do NOT
  // construct a new FakeTime() per test/iteration here.
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbArtist, { minLength: 0, maxLength: 8 }),
      async (artists) => {
        const { ctx, written } = makeCtx();
        await withMbFixture(
          { artists },
          () => drainAndAwait(time, run("search-artist", { query: "x" }, ctx)),
        );
        const res = written.find((w) => w.name === "search-artist")!;
        return (
          JSON.stringify(res.payload.artists) === JSON.stringify(artists) &&
          res.payload.count === artists.length
        );
      },
    ),
    { numRuns: NIGHT(75) },
  );
});

Deno.test("property: browse-release-groups' offset ALWAYS defaults to 0 when absent, regardless of how many release-groups are returned", async () => {
  // Uses the file-level shared `time`.
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbArtist, { minLength: 0, maxLength: 5 }),
      async (rgs) => {
        const { ctx, written } = makeCtx();
        await withMbFixture(
          { "release-groups": rgs },
          () =>
            drainAndAwait(
              time,
              run("browse-release-groups", { artist: "x" }, ctx),
            ),
        );
        const res = written.find((w) => w.spec === "browse")!;
        return res.payload.offset === 0 && res.payload.count === rgs.length;
      },
    ),
    { numRuns: NIGHT(50) },
  );
});

// ---------------------------------------------------------------------------
// (b) seed-URL builder injectivity, MODULO documented normalization
// ---------------------------------------------------------------------------

// Restricted to a canonical, NON-collapsing subset: non-empty title/artist/
// trackName (excludes the "" vs missing collapse) and durationSeconds >= 1
// (excludes the durationMs=0 collapse pinned in the coverage suite). No
// '<'/'>'/'"'/'\\' so the JSON-LD embedding and the HTML <script> boundary
// are never at risk regardless of generated content.
const SAFE_TEXT = /^[A-Za-z0-9 ,.'-]{1,24}$/;
const arbCanonicalSeedInput = fc.record({
  title: fc.stringMatching(SAFE_TEXT),
  artist: fc.stringMatching(SAFE_TEXT),
  trackName: fc.stringMatching(SAFE_TEXT),
  durationSeconds: fc.integer({ min: 1, max: 7199 }),
});

type SeedInput = {
  title: string;
  artist: string;
  trackName: string;
  durationSeconds: number;
};

async function seedUrlFor(input: SeedInput): Promise<URL> {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) =>
      isBcHost(req)
        ? html(
          albumHtmlFor(
            input.title,
            input.artist,
            input.trackName,
            input.durationSeconds,
          ),
        )
        : undefined],
    async () => {
      await run("seed-from-bandcamp", {
        bandcampUrl: "https://fixture.bandcamp.com/album/prop",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  return new URL(release.seedUrl as string);
}

function canonicalSignature(input: SeedInput): string {
  return JSON.stringify([
    input.title,
    input.artist,
    input.trackName,
    input.durationSeconds,
  ]);
}

Deno.test("property: seed-from-bandcamp's seed URL round-trips title/artist/trackName/durationMs for any canonical input", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalSeedInput, async (input) => {
      const seedUrl = await seedUrlFor(input);
      return (
        seedUrl.searchParams.get("name") === input.title &&
        seedUrl.searchParams.get("artist_credit.names.0.artist.name") ===
          input.artist &&
        seedUrl.searchParams.get("mediums.0.track.0.name") ===
          input.trackName &&
        seedUrl.searchParams.get("mediums.0.track.0.length") ===
          String(input.durationSeconds * 1000)
      );
    }),
    { numRuns: NIGHT(40) },
  );
});

Deno.test("property: the seed URL is INJECTIVE over the canonical (non-collapsing) input subset", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalSeedInput,
      arbCanonicalSeedInput,
      async (a, b) => {
        const sigA = canonicalSignature(a);
        const sigB = canonicalSignature(b);
        const urlA = (await seedUrlFor(a)).toString();
        const urlB = (await seedUrlFor(b)).toString();
        return sigA === sigB ? urlA === urlB : urlA !== urlB;
      },
    ),
    { numRuns: NIGHT(60) },
  );
});

// --- Explicit named collapse pins (documented normalization exclusions) ---

Deno.test("collapse: durationMs=0 (PT0S) vs NO duration at all produce the IDENTICAL seed URL (both omit the length param)", async () => {
  const withZero = await seedUrlFor({
    title: "T",
    artist: "A",
    trackName: "Zero",
    durationSeconds: 0,
  });
  const noDurationHtml =
    `<!doctype html><html><head><script type="application/ld+json">${
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "MusicAlbum",
        name: "T",
        byArtist: { name: "A" },
        track: { itemListElement: [{ position: 1, item: { name: "Zero" } }] },
      })
    }</script></head><body></body></html>`;
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(noDurationHtml) : undefined)],
    async () => {
      await run("seed-from-bandcamp", {
        // MUST match seedUrlFor()'s fixed bandcampUrl exactly — the
        // urls.0.url / edit_note params are derived from it, so a
        // mismatched URL here would make the two seed URLs differ for a
        // reason unrelated to the property under test (durationMs).
        bandcampUrl: "https://fixture.bandcamp.com/album/prop",
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  const withoutDuration = new URL(
    (res.payload.releases as Array<Record<string, unknown>>)[0]
      .seedUrl as string,
  );
  assertEquals(withZero.toString(), withoutDuration.toString());
});

// ---------------------------------------------------------------------------
// (c) normalizeTitle collision property — local mirror predicts, execute()
// through find-missing confirms
// ---------------------------------------------------------------------------

/** Mirrors musicbrainz.ts's module-private `normalizeTitle` EXACTLY (read
 * from source, post-LB5-fix: NFKD-decompose, strip the combining diacritical
 * marks NFKD leaves behind (U+0300-U+036F), lowercase, collapse any run of
 * non-letter/non-number Unicode codepoints to a single space, then trim).
 * Used only to PREDICT whether two generated titles should collide — the
 * actual assertion always goes through `run("find-missing", ...)`, never
 * calling this mirror as if it were the source under test. */
function predictNormalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const arbTitlePair = fc.tuple(
  fc.stringMatching(/^[A-Za-z0-9 _-]{1,12}$/),
  fc.stringMatching(/^[A-Za-z0-9 _-]{1,12}$/),
);

Deno.test("property: find-missing's match/missing classification agrees with predictNormalize's collision prediction for ANY generated title pair", async () => {
  // Uses the file-level shared `time`.
  await fc.assert(
    fc.asyncProperty(arbTitlePair, async ([bcTitle, mbTitle]) => {
      const bcHtml = `<!doctype html><html><head></head><body>
<p id="band-name-location"><span class="title">Fixture Prop Artist</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/x"><p class="title">${bcTitle}</p></a></li>
</ol></div>
</body></html>`;
      const { ctx, written } = makeCtx();
      await withFetchStub(
        [
          (req) => (isBcHost(req) ? html(bcHtml) : undefined),
          (req) => {
            if (!isMbHost(req)) return undefined;
            const url = new URL(req.url);
            if (url.pathname === "/ws/2/artist/") {
              return json({
                artists: [{
                  id: "00000000-0000-0000-0000-000000000001",
                  name: "Fixture Prop Artist",
                }],
              });
            }
            return json({
              "release-groups": [{
                id: "00000000-0000-0000-0000-000000000601",
                title: mbTitle,
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
              bandcampUrl: "https://fixturepropartist.bandcamp.com",
            }, ctx),
          ),
      );
      const res = written.find((w) => w.spec === "missingReleases")!;
      const matched = res.payload.matched as unknown[];
      const shouldCollide =
        predictNormalize(bcTitle) === predictNormalize(mbTitle);
      return shouldCollide ? matched.length === 1 : matched.length === 0;
    }),
    { numRuns: NIGHT(40) },
  );
});

// ---------------------------------------------------------------------------
// (d) multi-step find-missing FLOW test — bounded paginated release-group
// walk under FakeTime (offset 0->100->200-><100)
// ---------------------------------------------------------------------------

function page(n: number, offset: number, titlePrefix: string) {
  return {
    "release-groups": Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-0000-0000-0000000${
        String(offset + i).padStart(5, "0")
      }`,
      title: `${titlePrefix}${offset + i}`,
    })),
  };
}

Deno.test("FLOW: find-missing's release-group pagination walks offset 0->100->200 then stops on a <100 page, visiting every offset exactly once", async () => {
  // Uses the file-level shared `time`.
  const { ctx, written } = makeCtx();
  const offsetsSeen: string[] = [];
  const artistPageHtml = `<!doctype html><html><head></head><body>
<p id="band-name-location"><span class="title">Fixture Flow Artist</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/keep"><p class="title">Flow Keeper Album</p></a></li>
</ol></div>
</body></html>`;
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(artistPageHtml) : undefined),
      (req) => {
        if (!isMbHost(req)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/ws/2/artist/") {
          return json({
            artists: [{
              id: "00000000-0000-0000-0000-000000000001",
              name: "Fixture Flow Artist",
            }],
          });
        }
        const offset = url.searchParams.get("offset") ?? "0";
        offsetsSeen.push(offset);
        const off = Number(offset);
        // offset 0 and 100 return a FULL page (100 items) -> pagination
        // continues; offset 200 returns a SHORT page (30 items) -> stops.
        // Deliberately BOUNDED (never returns >=100 forever) — an unbounded
        // stub would hang the source's `while(true)` walk under runAllAsync.
        return json(page(off < 200 ? 100 : 30, off, "Flow Page Title "));
      },
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixtureflowartist.bandcamp.com",
          artistMbid: "00000000-0000-0000-0000-000000000001",
        }, ctx),
      ),
  );
  assertEquals(
    offsetsSeen,
    ["0", "100", "200"],
    "the offset progression is EXACTLY 0, 100, 200 — one call per page, no repeats, no gaps",
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  assertEquals(
    res.payload.mbReleaseCount,
    230,
    "100 + 100 + 30 release-groups fetched across the three pages",
  );
  assertEquals(res.payload.bcReleaseCount, 1);
  const missing = res.payload.missing as unknown[];
  const matched = res.payload.matched as unknown[];
  assertEquals(
    matched.length,
    0,
    "the bandcamp album title never matches any of the 230 generated MB titles",
  );
  assertEquals(missing.length, 1);
});

// ---------------------------------------------------------------------------
// LB4 FIX: `maxPages` caps the walk even when every page is FULL — the old
// `while (true)` would never terminate against this stub; the new bounded
// `for` loop stops after exactly `maxPages` iterations regardless.
// ---------------------------------------------------------------------------

Deno.test("LB4 FIX: globalArgs.maxPages=2 stops find-missing's pagination after offsets 0,100 even though EVERY page is full (would loop forever pre-fix)", async () => {
  // Uses the file-level shared `time`.
  const written: Array<
    { spec: string; name: string; payload: Record<string, unknown> }
  > = [];
  const ctx = {
    globalArgs: { ...GLOBAL_ARGS, maxPages: 2 },
    writeResource: (spec: string, name: string, payload: unknown) => {
      written.push({ spec, name, payload: payload as Record<string, unknown> });
      return Promise.resolve({ spec, name });
    },
    logger: { info: () => {}, warning: () => {} },
  };
  const offsetsSeen: string[] = [];
  const artistPageHtml = `<!doctype html><html><head></head><body>
<p id="band-name-location"><span class="title">Fixture MaxPages Artist</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/keep"><p class="title">MaxPages Keeper Album</p></a></li>
</ol></div>
</body></html>`;
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(artistPageHtml) : undefined),
      (req) => {
        if (!isMbHost(req)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/ws/2/artist/") {
          return json({
            artists: [{
              id: "00000000-0000-0000-0000-000000000001",
              name: "Fixture MaxPages Artist",
            }],
          });
        }
        const offset = url.searchParams.get("offset") ?? "0";
        offsetsSeen.push(offset);
        const off = Number(offset);
        // ALWAYS a full page (100 items), never a short one — a naive
        // `while (true)` walk would never stop against this stub.
        return json(page(100, off, "MaxPages Page Title "));
      },
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturemaxpagesartist.bandcamp.com",
          artistMbid: "00000000-0000-0000-0000-000000000001",
        }, ctx),
      ),
  );
  assertEquals(
    offsetsSeen,
    ["0", "100"],
    "maxPages=2 caps the walk at exactly 2 pages despite every page being full",
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  assertEquals(
    res.payload.mbReleaseCount,
    200,
    "2 full pages of 100 = 200, capped by maxPages rather than a natural short-page stop",
  );
});

// ---------------------------------------------------------------------------
// (e) musicbrainz-discography-sync: pure-helper invariants —
// classifyDiscographyCache, isCacheStale, advanceSyncCursor,
// rateLimitDelayMs, retryAfterBackoffMs. Ported from an older, untested copy
// of this model. Unlike every property/flow test above, these need no
// stubbed fetch and no FakeTime at all — they are pure functions (no I/O, no
// internal clock read; `now`/`ttlMs`/`lastRequestAt`/etc. are always
// parameters, per each function's own doc comment in musicbrainz.ts), so
// each is called directly and asserted against ordinary values, real time
// included. The impure behaviors these back — mbFetch's concurrency-safe
// spacing queue and its single 503/Retry-After retry — are exercised
// end-to-end (stubbed fetch, real assertions on call count/timing) in
// musicbrainz_adversarial_test.ts instead; sync-artist-discographies'
// maxPages/truncated pagination guard is in musicbrainz_coverage_test.ts;
// its general execute() paths (batch processing, cursor resume across runs,
// the search-artist fallback, the no-artist-list error) are in
// musicbrainz_methods_test.ts.
// ---------------------------------------------------------------------------

// Invented MBIDs — never real MusicBrainz IDs.
const SYNC_ARTIST_MBIDS = [
  "aaaaaaaa-0000-4000-8000-000000000001",
  "aaaaaaaa-0000-4000-8000-000000000002",
  "aaaaaaaa-0000-4000-8000-000000000003",
  "aaaaaaaa-0000-4000-8000-000000000004",
  "aaaaaaaa-0000-4000-8000-000000000005",
];

Deno.test("isCacheStale: an entry fresher than the TTL is not stale", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const timestamp = new Date(now - 1_000).toISOString(); // 1s old
  assertEquals(isCacheStale(timestamp, now, 60_000), false); // TTL 60s
});

Deno.test("isCacheStale: an entry older than the TTL is re-fetched (stale)", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const timestamp = new Date(now - 120_000).toISOString(); // 2min old
  assertEquals(isCacheStale(timestamp, now, 60_000), true); // TTL 60s
});

Deno.test("isCacheStale: identical inputs give identical results across real time", async () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const timestamp = new Date(now - 5_000).toISOString();
  const first = isCacheStale(timestamp, now, 60_000);
  await time.tickAsync(5);
  const second = isCacheStale(timestamp, now, 60_000);
  assertEquals(first, second);
});

Deno.test("advanceSyncCursor: an interrupted run resumes from its cursor rather than restarting", () => {
  const cursor0 = { offset: 0 };
  const firstBatch = SYNC_ARTIST_MBIDS.slice(
    cursor0.offset,
    cursor0.offset + 3,
  );
  // Simulate an interruption partway: only 3 of the intended artists were
  // actually processed before the run stopped.
  const cursor1 = advanceSyncCursor(cursor0, {
    processedCount: firstBatch.length,
  });
  assertEquals(cursor1, { offset: 3 });

  // Resuming must start at offset 3, not restart at 0.
  const resumedBatch = SYNC_ARTIST_MBIDS.slice(
    cursor1.offset,
    cursor1.offset + 3,
  );
  assertEquals(resumedBatch, SYNC_ARTIST_MBIDS.slice(3));
});

Deno.test("advanceSyncCursor: two sequential batches cover the input exactly once, no gap, no overlap", () => {
  const cursor0 = { offset: 0 };
  const batch1 = SYNC_ARTIST_MBIDS.slice(cursor0.offset, cursor0.offset + 2);
  const cursor1 = advanceSyncCursor(cursor0, {
    processedCount: batch1.length,
  });

  const batch2 = SYNC_ARTIST_MBIDS.slice(cursor1.offset, cursor1.offset + 3);
  const cursor2 = advanceSyncCursor(cursor1, {
    processedCount: batch2.length,
  });

  // No overlap: disjoint index ranges.
  const overlap = batch1.filter((id) => batch2.includes(id));
  assertEquals(overlap, []);

  // No gap: concatenation reconstructs the full input in order.
  assertEquals([...batch1, ...batch2], SYNC_ARTIST_MBIDS);

  // Cursor lands exactly at the end of the input.
  assertEquals(cursor2, { offset: SYNC_ARTIST_MBIDS.length });
});

Deno.test("advanceSyncCursor: identical inputs give identical results across real time", async () => {
  const cursor = { offset: 2 };
  const outcome = { processedCount: 3 };
  const first = advanceSyncCursor(cursor, outcome);
  await time.tickAsync(5);
  const second = advanceSyncCursor(cursor, outcome);
  assertEquals(first, second);
});

Deno.test("classifyDiscographyCache: no entry at all is never-fetched", () => {
  assertEquals(classifyDiscographyCache(undefined), "never-fetched");
  assertEquals(classifyDiscographyCache(null), "never-fetched");
});

Deno.test("classifyDiscographyCache: count 0 with empty results is a legitimate empty discography, not never-fetched", () => {
  const entry = {
    count: 0,
    results: [],
    timestamp: "2026-08-01T00:00:00.000Z",
  };
  assertEquals(classifyDiscographyCache(entry), "empty");
});

Deno.test("classifyDiscographyCache: a non-empty entry is populated", () => {
  const entry = {
    count: 2,
    results: [{ id: SYNC_ARTIST_MBIDS[0] }, { id: SYNC_ARTIST_MBIDS[1] }],
    timestamp: "2026-08-01T00:00:00.000Z",
  };
  assertEquals(classifyDiscographyCache(entry), "populated");
});

Deno.test("classifyDiscographyCache + isCacheStale: empty (count 0) is NOT re-fetched, but never-fetched IS — regardless of TTL", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const ttlMs = 60_000;

  // A genuinely empty discography, freshly cached: should be skipped.
  const emptyEntry = {
    count: 0,
    results: [],
    timestamp: new Date(now - 1_000).toISOString(),
  };
  const emptyStatus = classifyDiscographyCache(emptyEntry);
  assertEquals(emptyStatus, "empty");
  assertEquals(isCacheStale(emptyEntry.timestamp, now, ttlMs), false);

  // An artist that was never fetched at all: must always be fetched, no
  // timestamp to even evaluate a TTL against.
  const neverFetchedStatus = classifyDiscographyCache(undefined);
  assertEquals(neverFetchedStatus, "never-fetched");
});

Deno.test("classifyDiscographyCache: identical inputs give identical results across real time", async () => {
  const entry = {
    count: 0,
    results: [],
    timestamp: "2026-08-01T00:00:00.000Z",
  };
  const first = classifyDiscographyCache(entry);
  await time.tickAsync(5);
  const second = classifyDiscographyCache(entry);
  assertEquals(first, second);
});

Deno.test("rateLimitDelayMs: no prior request means zero delay", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  assertEquals(rateLimitDelayMs(null, now, 1_000), 0);
});

Deno.test("rateLimitDelayMs: a caller that already waited long enough gets zero delay", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const lastRequestAt = now - 1_500; // waited 1.5s, min interval is 1s
  assertEquals(rateLimitDelayMs(lastRequestAt, now, 1_000), 0);
});

Deno.test("rateLimitDelayMs: a caller that requested too recently must wait the remainder", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const lastRequestAt = now - 200; // only 200ms ago
  assertEquals(rateLimitDelayMs(lastRequestAt, now, 1_000), 800);
});

Deno.test("rateLimitDelayMs: across a simulated batch no two requests land closer than 1s apart", () => {
  const minIntervalMs = 1_000;
  let simulatedClock = Date.UTC(2026, 7, 3, 12, 0, 0);
  let lastRequestAt: number | null = null;
  const requestTimes: number[] = [];

  for (let i = 0; i < 5; i++) {
    const delay = rateLimitDelayMs(
      lastRequestAt,
      simulatedClock,
      minIntervalMs,
    );
    simulatedClock += delay; // wait out the computed delay
    requestTimes.push(simulatedClock);
    lastRequestAt = simulatedClock;
    simulatedClock += 50; // small amount of "work" before the next iteration
  }

  for (let i = 1; i < requestTimes.length; i++) {
    const gap = requestTimes[i] - requestTimes[i - 1];
    assertEquals(
      gap >= minIntervalMs,
      true,
      `gap ${gap}ms below ${minIntervalMs}ms floor`,
    );
  }
});

Deno.test("rateLimitDelayMs: identical inputs give identical results across real time", async () => {
  const lastRequestAt = Date.UTC(2026, 7, 3, 12, 0, 0);
  const now = lastRequestAt + 200;
  const first = rateLimitDelayMs(lastRequestAt, now, 1_000);
  await time.tickAsync(5);
  const second = rateLimitDelayMs(lastRequestAt, now, 1_000);
  assertEquals(first, second);
});

// retryAfterBackoffMs returns a DISCRIMINATED result rather than a bare
// number (round-2 fix — see musicbrainz.ts's own comment above the
// function): {kind:"sleep", ms} when the parsed header is absent,
// unparsable, non-finite, non-positive, or <= maxBackoffMs (clamped up to
// the minIntervalMs floor); {kind:"stop", retryAfterMs} when a finite
// positive parsed header EXCEEDS maxBackoffMs. mbFetch acts on the
// classification alone and never re-parses the header itself.

Deno.test("retryAfterBackoffMs: a valid positive Retry-After header (seconds) within the cap sleeps for that many ms", () => {
  assertEquals(retryAfterBackoffMs("2", 1_000), { kind: "sleep", ms: 2_000 });
});

Deno.test("retryAfterBackoffMs: no Retry-After header sleeps at the minIntervalMs floor", () => {
  assertEquals(retryAfterBackoffMs(null, 1_000), { kind: "sleep", ms: 1_000 });
});

Deno.test("retryAfterBackoffMs: a non-numeric Retry-After header (HTTP-date form) sleeps at the minIntervalMs floor", () => {
  assertEquals(
    retryAfterBackoffMs("Wed, 21 Oct 2026 07:28:00 GMT", 1_000),
    { kind: "sleep", ms: 1_000 },
  );
});

Deno.test("retryAfterBackoffMs: a zero or negative Retry-After header sleeps at the minIntervalMs floor", () => {
  assertEquals(retryAfterBackoffMs("0", 1_000), { kind: "sleep", ms: 1_000 });
  assertEquals(retryAfterBackoffMs("-5", 1_000), { kind: "sleep", ms: 1_000 });
});

Deno.test("retryAfterBackoffMs: a header parsing below minIntervalMs is clamped UP to the floor, not honoured verbatim", () => {
  assertEquals(retryAfterBackoffMs("0.2", 1_000), { kind: "sleep", ms: 1_000 });
});

Deno.test("retryAfterBackoffMs: a header exceeding maxBackoffMs classifies as 'stop', carrying the full uncapped ms — never a Math.min-clamped value mbFetch would have to re-derive", () => {
  assertEquals(
    retryAfterBackoffMs("3600", 1_000),
    { kind: "stop", retryAfterMs: 3_600_000 },
  );
});

Deno.test("retryAfterBackoffMs: a header exactly AT maxBackoffMs still sleeps — the cap is exclusive", () => {
  assertEquals(
    retryAfterBackoffMs("60", 1_000, 60_000),
    { kind: "sleep", ms: 60_000 },
  );
});

Deno.test("retryAfterBackoffMs: maxBackoffMs is optional and defaults to 60_000 — no call site needs a third argument", () => {
  assertEquals(retryAfterBackoffMs("61", 1_000), {
    kind: "stop",
    retryAfterMs: 61_000,
  });
});

Deno.test("retryAfterBackoffMs: identical inputs give identical results across real time", async () => {
  const first = retryAfterBackoffMs("3", 1_000);
  await time.tickAsync(5);
  const second = retryAfterBackoffMs("3", 1_000);
  assertEquals(first, second);
});

Deno.test("property: retryAfterBackoffMs classification — always {kind:'sleep', minIntervalMs<=ms<=maxBackoffMs} or {kind:'stop', retryAfterMs>maxBackoffMs}, never anything else", () => {
  const maxBackoffMs = 60_000;
  fc.assert(
    fc.property(
      fc.option(
        fc.oneof(
          fc.integer({ min: -1000, max: 500_000 }).map(String),
          fc.constant("not-a-number"),
        ),
        { nil: null },
      ),
      fc.integer({ min: 100, max: 5_000 }),
      (header, minIntervalMs) => {
        const result = retryAfterBackoffMs(header, minIntervalMs, maxBackoffMs);
        if (result.kind === "sleep") {
          return result.ms >= minIntervalMs && result.ms <= maxBackoffMs;
        }
        if (result.kind === "stop") {
          return result.retryAfterMs > maxBackoffMs;
        }
        return false;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: retryAfterBackoffMs — absent, non-numeric, negative and zero headers ALL classify as sleep at the minIntervalMs floor", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(null),
        fc.constant("garbage"),
        fc.integer({ min: -1000, max: 0 }).map(String),
      ),
      fc.integer({ min: 100, max: 5_000 }),
      (header, minIntervalMs) => {
        const result = retryAfterBackoffMs(header, minIntervalMs);
        return result.kind === "sleep" && result.ms === minIntervalMs;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

// ---------------------------------------------------------------------------
// projectArtistCandidates — the search-artists-batch payload-budget
// projection (step 5's MongoDB 16MB guard). A KEY-SET invariant, not a value
// round-trip: for ANY generated artist object carrying arbitrary extra keys
// (area/begin-area/life-span/aliases/tags/...), the projected output's keys
// are always a SUBSET of {id, name, sort-name} and ALWAYS contain id + name.
// ---------------------------------------------------------------------------

const arbExtraArtistFields = fc.dictionary(
  fc.constantFrom(
    "area",
    "begin-area",
    "life-span",
    "aliases",
    "tags",
    "disambiguation",
    "country",
    "score",
    "type",
  ),
  fc.oneof(fc.string(), fc.integer(), fc.array(fc.string())),
);

const arbArtistWithExtras = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 40 }),
  "sort-name": fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
  extras: arbExtraArtistFields,
}).map(({ id, name, "sort-name": sortName, extras }) => ({
  id,
  name,
  ...(sortName !== undefined ? { "sort-name": sortName } : {}),
  ...extras,
}));

Deno.test("property: projectArtistCandidates — output keys are always a subset of {id, name, sort-name} and always contain id + name, for artist objects carrying arbitrary extra keys", () => {
  fc.assert(
    fc.property(
      fc.array(arbArtistWithExtras, { maxLength: 20 }),
      (artists) => {
        const projected = projectArtistCandidates(artists);
        return projected.length === artists.length &&
          projected.every((p, i) => {
            const keys = Object.keys(p);
            const subset = keys.every((k) =>
              k === "id" || k === "name" || k === "sort-name"
            );
            return subset && p.id === artists[i].id &&
              p.name === artists[i].name;
          });
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("projectArtistCandidates: drops area/begin-area/life-span/aliases/tags from a full MusicBrainz artist object", () => {
  const full = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Fixture Artist",
    "sort-name": "Fixture Artist",
    area: { id: "x", name: "Fixture Land" },
    "begin-area": { id: "y", name: "Fixture City" },
    "life-span": { begin: "2000", ended: false },
    aliases: [{ name: "Alias" }],
    tags: [{ count: 1, name: "fixture-tag" }],
    disambiguation: "the fixture one",
  };
  const [projected] = projectArtistCandidates([full]);
  assertEquals(Object.keys(projected).sort(), ["id", "name", "sort-name"]);
});

Deno.test("projectArtistCandidates: a hit missing id or name is DROPPED, not substituted with empty strings", () => {
  const hits = [
    { id: "cafebabe-0001-4a57-8bad-f00dfeedca01", name: "Fixture Real Hit" },
    { name: "Fixture Missing Id" }, // no `id` at all
    { id: "cafebabe-0002-4a57-8bad-f00dfeedca02" }, // no `name` at all
    { id: "", name: "Fixture Empty Id" }, // `id` present but empty
    { id: "cafebabe-0003-4a57-8bad-f00dfeedca03", name: "" }, // `name` present but empty
    { id: 12345, name: "Fixture Non-String Id" }, // `id` wrong type
    { id: "cafebabe-0004-4a57-8bad-f00dfeedca04", name: null }, // `name` wrong type
  ];
  const projected = projectArtistCandidates(
    hits as unknown as Record<string, unknown>[],
  );
  assertEquals(
    projected,
    [{ id: "cafebabe-0001-4a57-8bad-f00dfeedca01", name: "Fixture Real Hit" }],
    'every malformed hit must be dropped outright — never survive as {id: "", name: ""}, which would later false-match a zero-token library artist name',
  );
});

// ---------------------------------------------------------------------------
// dedupeQueries / planSearchBatch / deriveMaxDurationMs — search-artists-
// batch's pure planning helpers (step 4). Genuinely pure — no clock read, no
// I/O — so every property below drives the REAL implementation, not a
// mirror.
// ---------------------------------------------------------------------------

const arbQuery = fc.string({ minLength: 1, maxLength: 20 });

Deno.test("property: dedupeQueries is order-preserving — the FIRST occurrence of each distinct query survives, in original relative order", () => {
  fc.assert(
    fc.property(fc.array(arbQuery, { maxLength: 30 }), (queries) => {
      const deduped = dedupeQueries(queries);
      const seen = new Set<string>();
      const expected: string[] = [];
      for (const q of queries) {
        if (!seen.has(q)) {
          seen.add(q);
          expected.push(q);
        }
      }
      return JSON.stringify(deduped) === JSON.stringify(expected);
    }),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: dedupeQueries is idempotent — deduping an already-deduped list changes nothing", () => {
  fc.assert(
    fc.property(fc.array(arbQuery, { maxLength: 30 }), (queries) => {
      const once = dedupeQueries(queries);
      const twice = dedupeQueries(once);
      return JSON.stringify(once) === JSON.stringify(twice);
    }),
    { numRuns: NIGHT(200) },
  );
});

const arbDistinctQueries = fc.uniqueArray(arbQuery, { maxLength: 30 });

Deno.test("property: planSearchBatch never returns more than maxQueries in `batch`", () => {
  fc.assert(
    fc.property(
      arbDistinctQueries,
      fc.integer({ min: 0, max: 40 }),
      (queries, maxQueries) => {
        const { batch } = planSearchBatch(queries, maxQueries);
        return batch.length <= maxQueries;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: planSearchBatch — batch is exactly the input's first maxQueries entries, deferred is exactly the remainder, and batch++deferred reconstructs the input exactly once (no gap, no overlap)", () => {
  fc.assert(
    fc.property(
      arbDistinctQueries,
      fc.integer({ min: 0, max: 40 }),
      (queries, maxQueries) => {
        const { batch, deferred } = planSearchBatch(queries, maxQueries);
        const expectedBatch = queries.slice(0, maxQueries);
        const expectedDeferred = queries.slice(maxQueries);
        return JSON.stringify(batch) === JSON.stringify(expectedBatch) &&
          JSON.stringify(deferred) === JSON.stringify(expectedDeferred) &&
          JSON.stringify([...batch, ...deferred]) === JSON.stringify(queries);
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: planSearchBatch — truncated is true IFF deferred is non-empty", () => {
  fc.assert(
    fc.property(
      arbDistinctQueries,
      fc.integer({ min: 0, max: 40 }),
      (queries, maxQueries) => {
        const { deferred, truncated } = planSearchBatch(queries, maxQueries);
        return truncated === (deferred.length > 0);
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

// ---------------------------------------------------------------------------
// deriveMaxDurationMs — TWO properties over DISJOINT domains (round-3 fix:
// never one property "for all inputs" with an unstated exception, since the
// explicit branch deliberately applies NO floor).
// ---------------------------------------------------------------------------

Deno.test("property: deriveMaxDurationMs — DERIVED branch (explicit absent): result >= maxQueries*minIntervalMs, and non-decreasing in maxQueries", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 1, max: 5000 }),
      fc.integer({ min: 0, max: 500 }),
      (maxQueries, minIntervalMs, delta) => {
        const smaller = deriveMaxDurationMs(maxQueries, minIntervalMs);
        const larger = deriveMaxDurationMs(
          maxQueries + delta,
          minIntervalMs,
        );
        return smaller >= maxQueries * minIntervalMs && larger >= smaller;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: deriveMaxDurationMs — EXPLICIT branch: result === explicit VERBATIM, no floor applied even when explicit is far below maxQueries*minIntervalMs", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 1, max: 5000 }),
      fc.integer({ min: 0, max: 2_000_000 }),
      (maxQueries, minIntervalMs, explicit) => {
        return deriveMaxDurationMs(maxQueries, minIntervalMs, explicit) ===
          explicit;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("deriveMaxDurationMs: at the search-artists-batch defaults (maxQueries 400, minIntervalMs 1100), the derived bound is 690_000ms (~11.5min), above the 440_000ms (~7.3min) nominal", () => {
  const derived = deriveMaxDurationMs(400, 1100);
  assertEquals(derived, 690_000);
  assertEquals(derived > 400 * 1100, true);
});

Deno.test("deriveMaxDurationMs: an explicit bound below the nominal maxQueries*minIntervalMs product is respected VERBATIM, not clamped up — the escape hatch actually works", () => {
  assertEquals(deriveMaxDurationMs(400, 1100, 5_000), 5_000);
});

// ---------------------------------------------------------------------------
// sync-artist-discographies pure helpers — dedupeMbids, syncRunCoverage,
// fingerprintMbids. Exported so the test suite exercises the real
// implementation, per this package's established convention (see this
// file's header and the dedupeQueries/planSearchBatch properties above).
// ---------------------------------------------------------------------------

const arbMbid = fc.string({ minLength: 1, maxLength: 40 });

Deno.test("property: dedupeMbids is order-preserving — the FIRST occurrence of each distinct MBID survives, in original relative order", () => {
  fc.assert(
    fc.property(fc.array(arbMbid, { maxLength: 30 }), (mbids) => {
      const deduped = dedupeMbids(mbids);
      const seen = new Set<string>();
      const expected: string[] = [];
      for (const m of mbids) {
        if (!seen.has(m)) {
          seen.add(m);
          expected.push(m);
        }
      }
      return JSON.stringify(deduped) === JSON.stringify(expected);
    }),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: dedupeMbids is idempotent — deduping an already-deduped list changes nothing", () => {
  fc.assert(
    fc.property(fc.array(arbMbid, { maxLength: 30 }), (mbids) => {
      const once = dedupeMbids(mbids);
      const twice = dedupeMbids(once);
      return JSON.stringify(once) === JSON.stringify(twice);
    }),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: dedupeMbids's output is a SUBSET of the input with no duplicate elements", () => {
  fc.assert(
    fc.property(fc.array(arbMbid, { maxLength: 30 }), (mbids) => {
      const deduped = dedupeMbids(mbids);
      const inputSet = new Set(mbids);
      const dedupedSet = new Set(deduped);
      return deduped.length === dedupedSet.size &&
        deduped.every((m) => inputSet.has(m));
    }),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: syncRunCoverage — covered == processedCount + skippedCount, remaining == requested - covered, by definition", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 0, max: 2000 }),
      (requested, processedCount, skippedCount) => {
        const { covered, remaining } = syncRunCoverage(
          requested,
          processedCount,
          skippedCount,
        );
        return covered === processedCount + skippedCount &&
          remaining === requested - covered;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: syncRunCoverage — remaining is never negative whenever covered <= requested", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      (requested, processedCount, skippedCount) => {
        const covered = processedCount + skippedCount;
        fc.pre(covered <= requested);
        const { remaining } = syncRunCoverage(
          requested,
          processedCount,
          skippedCount,
        );
        return remaining >= 0;
      },
    ),
    { numRuns: NIGHT(200) },
  );
});

Deno.test("property: fingerprintMbids is deterministic — equal inputs give equal digests", () => {
  fc.assert(
    fc.property(fc.array(arbMbid, { maxLength: 30 }), (mbids) => {
      return fingerprintMbids(mbids) === fingerprintMbids([...mbids]);
    }),
    { numRuns: NIGHT(200) },
  );
});

// DO NOT pin "different for any two lists of different length" — length-
// prefixing changes the hash INPUT, not the output space, and a 32-bit
// FNV-1a hex digest still collides at ~2^-32. That guarantee comes from the
// persisted-count comparison in the cursor reset rule, not from the digest;
// pinning it here would be a false invariant. Named examples only.
Deno.test("fingerprintMbids: different for these specific example lists (a same-length change, and a length change)", () => {
  const a = [
    "aaaaaaaa-0000-4000-8000-000000000001",
    "aaaaaaaa-0000-4000-8000-000000000002",
  ];
  const b = [
    "aaaaaaaa-0000-4000-8000-000000000001",
    "aaaaaaaa-0000-4000-8000-000000000003",
  ];
  const c = ["aaaaaaaa-0000-4000-8000-000000000001"];
  assertNotEquals(fingerprintMbids(a), fingerprintMbids(b));
  assertNotEquals(fingerprintMbids(a), fingerprintMbids(c));
});
