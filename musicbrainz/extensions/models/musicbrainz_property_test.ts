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
 *      read from source (`s.toLowerCase().replace(/[^a-z0-9]/g, "")`), then
 *      find-missing's actual match/missing classification is asserted
 *      against that prediction for every generated pair — never calling the
 *      private function directly, only observing its effect through
 *      execute().
 *  (d) a multi-step find-missing FLOW test under FakeTime pinning the
 *      BOUNDED paginated release-group walk (offset 0->100->200-><100,
 *      asserting the offset progression) — the flow stub MUST terminate
 *      pagination with a <100 page or the source's `while(true)` never
 *      ends and the FakeTime drain would hang; the unbounded-loop gap
 *      itself is documented, never exercised to infinity.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./musicbrainz.ts";

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
        const res = written.find((w) => w.spec === "artists")!;
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
 * from source: `s.toLowerCase().replace(/[^a-z0-9]/g, "")`). Used only to
 * PREDICT whether two generated titles should collide — the actual
 * assertion always goes through `run("find-missing", ...)`, never calling
 * this mirror as if it were the source under test. */
function predictNormalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
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
