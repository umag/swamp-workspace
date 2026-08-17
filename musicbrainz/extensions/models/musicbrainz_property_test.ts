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
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { FakeTime } from "jsr:@std/testing@1/time";
import {
  advanceSyncCursor,
  BANDCAMP_INSTANCE_PREFIXES,
  type BandcampCompareMethod,
  bandcampInstanceName,
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
      // Fail-closed write-budget funnel (musicbrainz-missing-seed-instance-
      // collision, round 4) — see WRITE_BUDGET/run() below. The model itself
      // never reads this property; it's exposed purely so run() can assert
      // on it.
      __written: written,
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

// Per-method write budget for every method with a call-shape-independent
// write count — the funnel `run()` enforces below. `sync-artist-discographies`
// is a genuine fan-out (0..batchSize per-artist writes plus one cursor-state
// write) and is deliberately left OUT rather than pinned to a number that
// would be wrong on the very next fixture; this file only tests its pure
// helpers directly, never through run().
const WRITE_BUDGET: Record<string, number> = {
  "search-artist": 2, // canonical + time-bounded deprecation alias
  "search-artists-batch": 1,
  "search-release-group": 1,
  "search-release": 1,
  "search-recording": 1,
  "search-label": 1,
  "lookup-artist": 1,
  "lookup-release-group": 1,
  "lookup-release": 1,
  "lookup-recording": 1,
  "lookup-label": 1,
  "browse-release-groups": 1,
  "browse-releases": 1,
  "browse-recordings": 1,
  "seed-from-bandcamp": 1,
  "find-missing": 1,
  "seed-all-missing": 1,
  search: 1,
};

// Round 5 (musicbrainz-missing-seed-instance-collision review): a
// call-shape-independent COUNT cannot express `sync-artist-discographies`'
// contract — it is a genuine fan-out (0..batchSize per-artist writes) — so
// leaving it out of WRITE_BUDGET entirely left it completely unchecked; a
// surplus write gated on any state the fixtures don't drive (e.g. the
// `truncated` page-ceiling flag) passed 265/0. Its writes DO have a fixed
// SHAPE that holds regardless of call shape or exit path, though: every
// `writeResource` it makes is either spec "browse" at `rg-by-artist-<mbid>`
// (the `writeResource("browse", \`rg-by-artist-${mbid}\`, ...)` call inside
// sync-artist-discographies, once per processed artist) or spec
// "discographySyncState" at "discography-sync-cursor" (that same method's
// `writeResource("discographySyncState", DISCOGRAPHY_SYNC_CURSOR_INSTANCE,
// ...)` call, written durably in its own `finally` even on a mid-batch
// throw). `run()`
// below checks every row in the delta window against this predicate in
// place of a count for any method listed here; this file only tests
// sync-artist-discographies' pure helpers directly, never through run(), but
// the table is kept identical across all five test files for one shared
// source of truth to read.
const WRITE_SHAPE: Record<
  string,
  (w: { spec: string; name: string }) => boolean
> = {
  "sync-artist-discographies": (w) =>
    (w.spec === "browse" && w.name.startsWith("rg-by-artist-")) ||
    (w.spec === "discographySyncState" &&
      w.name === "discography-sync-cursor"),
};

// Round 6 (musicbrainz-missing-seed-instance-collision review): the finally
// below's assertEquals/assertEquals-on-bad-rows can be swallowed at any
// `assertRejects(fn)` or `assertRejects(fn, Error)` call site that doesn't
// pin a message — JS replaces an in-flight rejection with whatever a
// `finally` throws, so the caller's bare assertRejects then accepts the
// substituted AssertionError as the expected rejection and the test stays
// green. Recording every violation OUT OF BAND, in addition to (not instead
// of) the existing assertEquals, means it cannot be absorbed that way: the
// FUNNEL: the unload handler below reads this array after every run() in the
// file has executed and fails the file if anything landed in it, regardless
// of what any individual assertRejects call swallowed.
const FUNNEL_VIOLATIONS: string[] = [];

// The funnel: every one of this file's `run()` calls passes through here, so
// arming the check ONCE closes the class for every fixture — present and
// future, including every fast-check-generated iteration — rather than
// relying on each new test to remember a per-test pin. Fail-CLOSED on two
// axes:
//  1. A method with NEITHER a WRITE_BUDGET NOR a WRITE_SHAPE entry throws
//     immediately, rather than passing through unchecked the way
//     `sync-artist-discographies` used to — so the next method added to the
//     model can't silently land outside the funnel either.
//  2. A budgeted/shaped method invoked against a ctx that doesn't expose
//     `__written` throws rather than silently skipping the check, so the
//     LB4 FIX test's hand-rolled ctx below has to opt in.
// The check runs in a `finally`, so a method that throws is still checked —
// a write made before rethrowing is exactly as visible as one on the happy
// path, not a silent escape. For a WRITE_BUDGET method the expected count on
// a throwing exit is 0 (none of the 18 budgeted methods deliberately persist
// before rethrowing today — only `sync-artist-discographies` does, and it is
// shape-checked, not count-checked, precisely because its throw-path write
// count varies with how much of the batch completed before the throw).
async function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  const budget = WRITE_BUDGET[name];
  const shape = WRITE_SHAPE[name];
  if (budget === undefined && shape === undefined) {
    throw new Error(
      `run("${name}", ...) has neither a WRITE_BUDGET nor a WRITE_SHAPE entry — every model method invoked through run() must be checked one way or the other, so an unbudgeted, unlisted method fails closed instead of passing through unchecked`,
    );
  }
  const written =
    (ctx as { __written?: Array<{ spec: string; name: string }> }).__written;
  if (!Array.isArray(written)) {
    throw new Error(
      `run("${name}", ...) is ${
        budget !== undefined
          ? `budgeted at ${budget} write(s)`
          : "shape-checked"
      } but its ctx does not expose __written — every ctx passed to a checked method must come from a makeCtx()-style helper (or opt in explicitly) so the write invariant can be enforced`,
    );
  }
  const before = written.length;
  let threw = false;
  try {
    return await method.execute(method.arguments.parse(args), ctx);
  } catch (e) {
    threw = true;
    throw e;
  } finally {
    const rows = written.slice(before);
    if (shape !== undefined) {
      const bad = rows.filter((w) => !shape(w));
      if (bad.length !== 0) {
        FUNNEL_VIOLATIONS.push(
          `${name} wrote ${bad.length} resource(s) outside its declared WRITE_SHAPE: ${
            JSON.stringify(bad.map((w) => `${w.spec}:${w.name}`))
          }`,
        );
      }
      assertEquals(
        bad.length,
        0,
        `${name} wrote ${bad.length} resource(s) outside its declared WRITE_SHAPE: ${
          JSON.stringify(bad.map((w) => `${w.spec}:${w.name}`))
        }`,
      );
    } else {
      const expected = threw ? 0 : budget;
      if (rows.length !== expected) {
        FUNNEL_VIOLATIONS.push(
          `${name} count ${rows.length} != ${expected}: ${
            JSON.stringify(rows.map((w) => `${w.spec}:${w.name}`))
          }`,
        );
      }
      assertEquals(
        rows.length,
        expected,
        `${name} must write exactly ${expected} resource(s) per${
          threw ? " throwing" : ""
        } execution, got ${rows.length}: ${
          JSON.stringify(rows.map((w) => `${w.spec}:${w.name}`))
        }`,
      );
    }
  }
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
    // See makeCtx() above — this is the one hand-rolled ctx in the file, so
    // it must opt into the write-budget funnel explicitly or run() throws.
    __written: written,
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

// ---------------------------------------------------------------------------
// GUARDS E + F (musicbrainz-missing-seed-instance-collision) — disjointness
// of the two Bandcamp-compare instance-name prefixes from every OTHER
// instance name/prefix this model writes.
//
// Disjointness is a finite relation over FIXED tokens, not a property of an
// arbitrary argument: `seed-${a}` equals the literal `seed-single` only when
// a === "single", a value randomized `fc.string()` sampling will not
// reliably draw. Guard E therefore replaces a fast-check-only disjointness
// property with a DETERMINISTIC, EXHAUSTIVE check over the finite token set;
// Guard F is the (small) fast-check property left in this area, and its job
// is narrower: bind the pure factory to the registry, so Guard E's result
// (computed purely from BANDCAMP_INSTANCE_PREFIXES) actually covers every
// name the factory can produce. Neither alone earns "argument-complete";
// their COMPOSITION does.
//
// Both guards read `BANDCAMP_INSTANCE_PREFIXES` from the model module at
// runtime — imported above, never hardcoded here and never re-derived by
// calling `bandcampInstanceName` (which would make Guard F self-referential
// and worthless, and would leave Guard E blind to every registry mutation).
//
// The nine module literals and eight template prefixes below are a
// hand-maintained table with NO assertion tying its length to
// musicbrainz.ts — nothing here reddens if a 22nd writeResource site lands
// carrying a brand-new literal or prefix. That residual is caught by the
// coverage test's Guard D runtime sweep, but ONLY for write sites the
// COLLISION_FIXTURES argument shapes actually reach — a conditional write on
// an unreached branch (e.g. a back-compat alias gated on an omitted
// argument) is covered by NEITHER mechanism. The COUNT_PIN assertion below
// is a cheap structural forcing function — it does not prove the table's
// CONTENTS are still correct, only that nobody added or removed an entry
// without visiting this comment. Only the twelve-member `search` entity set
// is derived LIVE off the model's own declared schema, exactly as
// musicbrainz_coverage_test.ts's own SEARCH_ENTITIES derivation does, so a
// 13th entity added to that enum is automatically covered with no edit
// needed in this file.
// ---------------------------------------------------------------------------

/** The nine LITERAL (non-templated) instance names this model writes: the
 * five SEARCH_INSTANCE_NAMES entries (search-artist, search-release-group,
 * search-release, search-recording, search-label — one per typed search
 * method), DEPRECATED_SEARCH_ALIAS_INSTANCE ("search", search-artist's own
 * time-bounded back-compat alias), search-artists-batch's fixed
 * "artist-search-batch", DISCOGRAPHY_SYNC_CURSOR_INSTANCE
 * ("discography-sync-cursor"), and seed-from-bandcamp's fixed "seed-single".
 * None of these constants is exported (deliberately, like their sibling
 * SEARCH_INSTANCE_NAMES — see musicbrainz.ts's own comment), so this table
 * is hand-maintained, same as the template prefixes below. */
const MODULE_INSTANCE_LITERALS = [
  "search-artist",
  "search",
  "artist-search-batch",
  "search-release-group",
  "search-release",
  "search-recording",
  "search-label",
  "discography-sync-cursor",
  "seed-single",
];

/** The eight DISTINCT template prefixes among the nine TEMPLATE writeResource
 * sites (`rg-by-artist-` is shared by TWO write sites — browse-release-groups
 * and sync-artist-discographies' per-artist discography cache — which is
 * fine: they share one SPEC, `browse`, so the COLLISION INVARIANT in
 * musicbrainz_coverage_test.ts does not flag it): `artist-` (lookup-artist),
 * `rg-` (lookup-release-group), `release-` (lookup-release), `recording-`
 * (lookup-recording), `label-` (lookup-label), `rg-by-artist-`
 * (browse-release-groups + sync-artist-discographies), `releases-by-`
 * (browse-releases), `recordings-by-` (browse-recordings). */
const TEMPLATE_PREFIXES = [
  "artist-",
  "rg-",
  "release-",
  "recording-",
  "label-",
  "rg-by-artist-",
  "releases-by-",
  "recordings-by-",
];

/** The generic `search` method's entity enum, read LIVE off the model's own
 * declared arguments schema rather than hardcoded — mirrors
 * musicbrainz_coverage_test.ts's own SEARCH_ENTITIES derivation exactly
 * (deliberately duplicated per this suite's per-file harness convention,
 * rather than hoisted into a shared module). */
type SearchEntityShape = {
  arguments: { shape: { entity: { options: readonly string[] } } };
};
const SEARCH_ENTITIES =
  (model.methods as unknown as Record<string, SearchEntityShape>).search
    .arguments.shape.entity.options;

// COUNT PIN — a cheap structural forcing function mirroring Guard E's own
// `prefixes.length === 2` sanity assert below: it does not prove
// MODULE_INSTANCE_LITERALS/TEMPLATE_PREFIXES are still CORRECT, only that
// their combined length (9 + 8 = 17) has not silently drifted out of sync
// with musicbrainz.ts without a human visiting this comment block.
Deno.test("GUARD E (count pin): the hand-maintained MODULE_INSTANCE_LITERALS + TEMPLATE_PREFIXES tables total 17 entries", () => {
  assertEquals(
    MODULE_INSTANCE_LITERALS.length + TEMPLATE_PREFIXES.length,
    17,
    "a writeResource site was added or removed in musicbrainz.ts without updating MODULE_INSTANCE_LITERALS/TEMPLATE_PREFIXES above",
  );
});

Deno.test("GUARD E: BANDCAMP_INSTANCE_PREFIXES is disjoint, deterministically and exhaustively, from every other instance name/prefix this model writes", () => {
  const prefixes = Object.values(BANDCAMP_INSTANCE_PREFIXES);
  assertEquals(
    prefixes.length,
    2,
    "sanity: exactly two Bandcamp-compare methods share this registry",
  );

  for (const p of prefixes) {
    for (const literal of MODULE_INSTANCE_LITERALS) {
      assert(
        literal !== p && !literal.startsWith(`${p}-`),
        `prefix "${p}" collides with module literal instance "${literal}"`,
      );
    }
    for (const t of TEMPLATE_PREFIXES) {
      assert(
        !`${p}-`.startsWith(t) && !t.startsWith(`${p}-`),
        `prefix "${p}-" and template prefix "${t}" overlap: one is a prefix of the other, so a name from either namespace can land inside the other's`,
      );
    }
    for (const entity of SEARCH_ENTITIES) {
      const entityName = `${entity}-search`;
      assert(
        entityName !== p && !entityName.startsWith(`${p}-`),
        `prefix "${p}" collides with generic-search instance "${entityName}"`,
      );
    }
  }

  const [a, b] = prefixes;
  assert(
    !`${a}-`.startsWith(`${b}-`) && !`${b}-`.startsWith(`${a}-`),
    `the two Bandcamp-compare prefixes ("${a}", "${b}") must be mutually non-prefixing`,
  );
});

// GUARD F: binds the PURE factory to the IMPORTED BANDCAMP_INSTANCE_PREFIXES
// registry, so Guard E's disjointness result (computed purely from the
// table) actually covers every name `bandcampInstanceName` can produce for
// an arbitrary argument. Asserts INSIDE the property (via assertEquals)
// rather than returning a bare boolean: fast-check can only print the
// counterexample INPUT for a boolean-returning property (under mutation F1
// the entire diagnostic used to be "Counterexample: [...] / Property failed
// by returning false" — no actual/expected, no hint that a prefix went
// missing). assertEquals throws inside the property, so fast-check's report
// now also carries the AssertionError's actual/expected diff.
Deno.test("GUARD F: bandcampInstanceName's output equals the IMPORTED registry's prefix, joined to the fallback-applied argument — binds the pure factory to BANDCAMP_INSTANCE_PREFIXES so Guard E's table result covers every name the factory can actually produce", () => {
  // A fixed bandcampUrl (now REQUIRED) whose own bc-<slug> fallback is a
  // hand-computed literal, not obtained by calling the module's own
  // (private) bandcampUrlSlug — this property is about binding the factory
  // to the PREFIXES table and to `||` semantics on artistMbid, not about
  // re-deriving bandcampUrlSlug's own logic (Guards J and the mutation-kill
  // tests below own that).
  const fixedBandcampUrl = "https://guardf.bandcamp.com";
  fc.assert(
    fc.property(
      fc.constantFrom<BandcampCompareMethod>(
        ...(Object.keys(BANDCAMP_INSTANCE_PREFIXES) as BandcampCompareMethod[]),
      ),
      fc.string(),
      (method, x) => {
        const expected = `${BANDCAMP_INSTANCE_PREFIXES[method]}-${
          x || "bc-guardf"
        }`;
        assertEquals(
          bandcampInstanceName(method, x, fixedBandcampUrl),
          expected,
          `GUARD F: bandcampInstanceName("${method}", ${JSON.stringify(x)}, ${
            JSON.stringify(fixedBandcampUrl)
          }) must equal the registry-derived name`,
        );
      },
    ),
    { numRuns: NIGHT(500) },
  );
});

// GUARD B (factory level) — deterministic pins, not left to fast-check's
// probabilistic corpus. Covers two argument shapes together because both
// exercise the SAME fallback operator and neither is reliably sampled by
// `fc.string()` in Guard F above (which MAY draw "" in a given run, but is
// not guaranteed to, and can never draw "no second argument at all"):
//  - an EXPLICIT empty string must fall back to the same "unknown" token as
//    an omitted argument — this is what actually observes mutation B2 (`||`
//    silently replaced with `??`), which let a dangling-hyphen name through
//    undetected in an earlier round;
//  - an OMITTED artistMbid (undefined, no second argument at all) must also
//    fall back to "unknown". Folded in from a separate two-case
//    fast-check property (its only generator was a two-element
//    fc.constantFrom, so running it under NIGHT(50)/FC_NUM_RUNS gave zero
//    additional coverage over asserting both cases directly — the same
//    "disjointness is a finite relation over fixed tokens, not a property of
//    an arbitrary argument" reasoning that motivated Guard E's deterministic
//    rewrite applies here too).
Deno.test("GUARD B (factory level): bandcampInstanceName — an EXPLICIT empty-string artistMbid AND an EXPLICIT undefined artistMbid both fall back to the SAME bandcampUrl-derived slug (|| semantics), never a dangling hyphen (?? semantics). bandcampUrl is REQUIRED as of this round, so there is no longer an 'omitted' call shape to pin — see the throws-on-missing-argument coverage this replaces at the type level.", () => {
  const url = "https://guardb.bandcamp.com";
  assertEquals(
    bandcampInstanceName("find-missing", "", url),
    "find-missing-bc-guardb",
    "GUARD B: an EXPLICIT empty-string artistMbid must render the bandcampUrl-derived fallback for find-missing",
  );
  assertEquals(
    bandcampInstanceName("seed-all-missing", "", url),
    "seed-all-missing-bc-guardb",
    "GUARD B: an EXPLICIT empty-string artistMbid must render the bandcampUrl-derived fallback for seed-all-missing",
  );
  assertEquals(
    bandcampInstanceName("find-missing", undefined, url),
    "find-missing-bc-guardb",
    "GUARD B: an EXPLICIT undefined artistMbid must render the bandcampUrl-derived fallback for find-missing",
  );
  assertEquals(
    bandcampInstanceName("seed-all-missing", undefined, url),
    "seed-all-missing-bc-guardb",
    "GUARD B: an EXPLICIT undefined artistMbid must render the bandcampUrl-derived fallback for seed-all-missing",
  );
});

// ---------------------------------------------------------------------------
// GUARD J (musicbrainz-missing-seed-instance-collision, fallback axis) —
// review found the fix above namespaces by METHOD, not by ARTIST: when
// artistMbid cannot be auto-resolved, EVERY unresolved artist used to
// collapse onto the same constant suffix ("unknown"), so the collision this
// issue exists to close reappeared one axis over — proven by running two
// unresolved artists through both methods four times, which left only the
// last artist's two rows surviving. The fallback now derives from the
// REQUIRED `bandcampUrl` argument (`bandcampUrlSlug`) instead of a shared
// constant. Round 2 of the same review found the fallback itself still
// collapsed on three further axes — subdomain-only keying (two artists
// sharing one label/compilation subdomain), an uncapped/unsanitized
// preferred branch, and a suffix namespace that intersected the MBID space
// — all covered below alongside the original stability/distinctness pins.
// These are factory-level (pure-function) pins; the execute()-level
// reproduction of the review's exact four-run scenario lives in
// musicbrainz_coverage_test.ts.
// ---------------------------------------------------------------------------

Deno.test("GUARD J (factory level): bandcampInstanceName's bandcampUrl-derived fallback is STABLE for the same artist across repeated calls, DISTINCT across different artists, and stays inside its own method's namespace — for both methods", () => {
  const alpha = "https://obscurealpha.bandcamp.com/music";
  const beta = "https://obscurebeta.bandcamp.com/music";

  for (
    const method of Object.keys(
      BANDCAMP_INSTANCE_PREFIXES,
    ) as BandcampCompareMethod[]
  ) {
    const alphaName = bandcampInstanceName(method, undefined, alpha);
    const betaName = bandcampInstanceName(method, undefined, beta);

    assertEquals(
      alphaName,
      `${BANDCAMP_INSTANCE_PREFIXES[method]}-bc-obscurealpha`,
      `GUARD J: ${method}'s bandcampUrl-derived fallback must be the bc-namespaced subdomain slug`,
    );
    assertEquals(
      bandcampInstanceName(method, undefined, alpha),
      alphaName,
      `GUARD J: ${method}'s bandcampUrl-derived fallback must be stable across repeated calls for the same artist`,
    );
    assertEquals(
      bandcampInstanceName(method, "", alpha),
      alphaName,
      `GUARD J: ${method}'s bandcampUrl-derived fallback must also apply for an explicit empty-string artistMbid (|| semantics, same as the "unknown" fallback it replaces)`,
    );
    assertNotEquals(
      alphaName,
      betaName,
      `GUARD J: ${method}'s bandcampUrl-derived fallback must differ between two distinct artists — a collision here is the exact defect musicbrainz-missing-seed-instance-collision's fallback axis reintroduced`,
    );
    assert(
      alphaName.startsWith(`${BANDCAMP_INSTANCE_PREFIXES[method]}-`),
      `GUARD J: ${method}'s derived name must stay inside its own prefix namespace, got "${alphaName}"`,
    );

    // A resolved artistMbid still takes priority over bandcampUrl — the
    // fallback only applies when artistMbid is absent/empty.
    assertEquals(
      bandcampInstanceName(method, "resolved-mbid-123", alpha),
      `${BANDCAMP_INSTANCE_PREFIXES[method]}-resolved-mbid-123`,
      `GUARD J: ${method} must prefer a resolved artistMbid over the bandcampUrl-derived fallback`,
    );
  }

  // bandcampUrl is REQUIRED (round-2 review: the two-argument call shape had
  // no real caller and kept the shared-"unknown" collision reachable behind
  // a supported signature). The degenerate "truly have neither value" case
  // is now an EXPLICIT empty-string bandcampUrl, not an omitted argument —
  // bandcampUrlSlug("") still yields a defined answer (cleaned || "unknown"
  // inside sanitizeBandcampSlugSegment), now inside the bc- namespace.
  assertEquals(
    bandcampInstanceName("find-missing", undefined, ""),
    "find-missing-bc-unknown",
  );
});

Deno.test("GUARD J2: two unresolved artists sharing ONE Bandcamp subdomain (a label/compilation account) land on DIFFERENT instances when their paths differ — the exact shape the round-2 review found colliding; stated honestly, two that share BOTH subdomain and path still collide, because no further signal is available at this call site", () => {
  const rosterA = "https://somelabel.bandcamp.com/album/roster-a-lp";
  const rosterB = "https://somelabel.bandcamp.com/album/roster-b-lp";
  const rosterAName = bandcampInstanceName("find-missing", undefined, rosterA);
  const rosterBName = bandcampInstanceName("find-missing", undefined, rosterB);

  assertEquals(rosterAName, "find-missing-bc-somelabel-album-roster-a-lp");
  assertEquals(rosterBName, "find-missing-bc-somelabel-album-roster-b-lp");
  assertNotEquals(
    rosterAName,
    rosterBName,
    "two unresolved artists sharing one subdomain must NOT collide when their bandcampUrl paths differ",
  );

  // Honest residual: root and /music are both treated as "no path to fold"
  // (they are the two shapes fetchPage's own bcUrl normalization produces
  // for a SINGLE artist's own page across call-to-call spelling variance —
  // folding them in would break the existing same-artist stability pin
  // above), so two DIFFERENT artists that both merely browse the shared
  // subdomain's root still collide. This is a known, accepted limitation,
  // not a silent gap: see bandcampUrlSlug's doc comment.
  const rootName = bandcampInstanceName(
    "find-missing",
    undefined,
    "https://somelabel.bandcamp.com",
  );
  const musicPathName = bandcampInstanceName(
    "find-missing",
    undefined,
    "https://somelabel.bandcamp.com/music",
  );
  assertEquals(
    rootName,
    musicPathName,
    "root and /music must still collapse to the same instance — this is what keeps repeated runs against the SAME artist stable across bcUrl's own trailing-slash/`/music` normalization",
  );

  // Round-4 review MEDIUM: a caller that concatenates a stored bandcampUrl
  // already ending in "/" with "/music" (a realistic producer — every
  // written row's attributes.bandcampUrl is stored verbatim from the
  // argument) produces "//music", which survived the pre-fix trailing-slash-
  // only normalization untouched and split ONE artist across two instances.
  // Every near-miss spelling below must now collapse to the same instance as
  // the canonical root/`/music` spellings pinned above.
  const doubleSlashMusicName = bandcampInstanceName(
    "find-missing",
    undefined,
    "https://somelabel.bandcamp.com//music",
  );
  const doubleSlashTrailingName = bandcampInstanceName(
    "find-missing",
    undefined,
    "https://somelabel.bandcamp.com//",
  );
  const upperMusicName = bandcampInstanceName(
    "find-missing",
    undefined,
    "https://somelabel.bandcamp.com/MUSIC",
  );
  assertEquals(
    doubleSlashMusicName,
    rootName,
    'https://somelabel.bandcamp.com//music must collapse to the same instance as the bare root — a caller concatenating a trailing-slash bandcampUrl with "/music" must not split the artist across two instances',
  );
  assertEquals(
    doubleSlashTrailingName,
    rootName,
    "a doubled trailing slash on the bare root must also collapse to the same instance",
  );
  assertEquals(
    upperMusicName,
    rootName,
    "/MUSIC (case-insensitive) must collapse to the same instance as /music",
  );
});

Deno.test("GUARD J3: bandcampUrlSlug sanitizes and length-caps the PREFERRED subdomain branch too, not just the bare-domain fallback — two distinct bare-bandcamp.com URLs sharing a long common prefix do not collide, and an over-cap subdomain label does not collide with a different one sharing its visible prefix", () => {
  // Bare `bandcamp.com/...` branch: two distinct paths agreeing on their
  // first 100+ characters must still diverge after the 80-char cap, because
  // truncation now appends a digest of the FULL string rather than a bare
  // slice() — a bare slice() collapsed exactly this shape (round-2 review).
  const sharedPrefix = "z".repeat(100);
  const bareA = `https://bandcamp.com/${sharedPrefix}-artist-alpha`;
  const bareB = `https://bandcamp.com/${sharedPrefix}-artist-beta`;
  const bareAName = bandcampInstanceName("find-missing", undefined, bareA);
  const bareBName = bandcampInstanceName("find-missing", undefined, bareB);
  assertNotEquals(
    bareAName,
    bareBName,
    "two distinct bare-bandcamp.com URLs sharing a long common prefix must not collide after truncation",
  );
  assert(
    bareAName.length <= "find-missing-bc-".length + 80,
    `bareAName must respect the length cap, got ${bareAName.length} chars`,
  );

  // Preferred subdomain branch: previously returned the raw WHATWG-parsed
  // label with NO cap at all. A several-hundred-character subdomain label
  // must now be capped just like the fallback branch is.
  const longSub = "q".repeat(300);
  const longSubName = bandcampInstanceName(
    "find-missing",
    undefined,
    `https://${longSub}.bandcamp.com/`,
  );
  assert(
    longSubName.length <= "find-missing-bc-".length + 80,
    `a several-hundred-char subdomain label must be capped, got ${longSubName.length} chars`,
  );
});

Deno.test("GUARD J4: the bc- marker keeps the URL-derived suffix namespace DISJOINT from the MBID-derived one — a UUID-shaped subdomain never collides with that MBID's resolved instance, and unknown.bandcamp.com never collides with an explicit artistMbid literally 'unknown'", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const resolvedName = bandcampInstanceName(
    "find-missing",
    uuid,
    "https://irrelevant.bandcamp.com",
  );
  const uuidSubdomainName = bandcampInstanceName(
    "find-missing",
    undefined,
    `https://${uuid}.bandcamp.com`,
  );
  assertEquals(resolvedName, `find-missing-${uuid}`);
  assertEquals(uuidSubdomainName, `find-missing-bc-${uuid}`);
  assertNotEquals(
    resolvedName,
    uuidSubdomainName,
    "a UUID-shaped Bandcamp subdomain must not collide with that same MBID's resolved instance",
  );

  const explicitUnknownName = bandcampInstanceName(
    "find-missing",
    "unknown",
    "https://irrelevant.bandcamp.com",
  );
  const unknownSubdomainName = bandcampInstanceName(
    "find-missing",
    undefined,
    "https://unknown.bandcamp.com",
  );
  assertEquals(explicitUnknownName, "find-missing-unknown");
  assertEquals(unknownSubdomainName, "find-missing-bc-unknown");
  assertNotEquals(
    explicitUnknownName,
    unknownSubdomainName,
    "unknown.bandcamp.com must not collide with an explicit artistMbid of the literal string 'unknown'",
  );

  // Empty-label degenerate (https://.bandcamp.com/, an unroutable but
  // parseable host) still yields a defined, non-dangling-hyphen answer.
  const emptyLabelName = bandcampInstanceName(
    "find-missing",
    undefined,
    "https://.bandcamp.com/",
  );
  assertEquals(emptyLabelName, "find-missing-bc-unknown");
  assert(!emptyLabelName.endsWith("-"), "must not be a dangling-hyphen name");
});

Deno.test("GUARD J4 (reverse direction, round-4 review): the bc- marker's disjointness is ONE-DIRECTIONAL — a real (UUID) artistMbid can never collide with a URL-derived fallback, but this factory does not shape-validate artistMbid, so a hand-passed artistMbid that itself starts \"bc-\" DOES collide with the URL-derived fallback for the matching subdomain. Pinned here as a known, accepted residual (see bandcampInstanceName's doc comment) rather than left as a silent gap — a future fix that closes it (schema validation, or a guard inside this factory) should turn this assertEquals into an assertNotEquals / assertThrows, not delete it.", () => {
  const explicitBcMbid = bandcampInstanceName(
    "find-missing",
    "bc-obscurealpha",
    "https://irrelevant.bandcamp.com",
  );
  const urlDerivedFallback = bandcampInstanceName(
    "find-missing",
    undefined,
    "https://obscurealpha.bandcamp.com",
  );
  assertEquals(explicitBcMbid, "find-missing-bc-obscurealpha");
  assertEquals(urlDerivedFallback, "find-missing-bc-obscurealpha");
  assertEquals(
    explicitBcMbid,
    urlDerivedFallback,
    'known residual: a hand-passed artistMbid starting "bc-" collides with the URL-derived fallback for the subdomain it names — the forward direction (GUARD J4 above) holds, this reverse direction does not',
  );
});

Deno.test("bandcampInstanceName throws on every unrecognized method key, including every OWN-ENUMERABLE-INHERITED Object.prototype member — the round-2 regression: a truthiness check on a bracket read into BANDCAMP_INSTANCE_PREFIXES (whose prototype is still Object.prototype) let 8 of 12 unrecognized keys bypass the guard and return a stringified native-code function instead of throwing", () => {
  const unrecognizedKeys = [
    "bogus",
    "seed-single",
    "",
    "find-Missing",
    "__proto__",
    "toString",
    "valueOf",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
  ];
  for (const key of unrecognizedKeys) {
    assertThrows(
      () =>
        bandcampInstanceName(
          key as unknown as BandcampCompareMethod,
          "abc",
          "https://irrelevant.bandcamp.com",
        ),
      Error,
      `unrecognized method "${key}"`,
      `bandcampInstanceName must throw on unrecognized method key ${
        JSON.stringify(key)
      }, not return a value derived from an inherited Object.prototype member`,
    );
  }
});

// Round 7: moved off Deno.test onto the module "unload" event, which Deno
// fires once per module after every SELECTED test (including every
// fast-check-generated iteration) has run — under any --shuffle permutation
// and any --filter — so this no longer depends on declaration order or on
// which tests were selected. An exception thrown from this handler is
// reported as an uncaught module error that fails the run. See the
// FUNNEL_VIOLATIONS comment near WRITE_SHAPE.
addEventListener("unload", () => {
  if (FUNNEL_VIOLATIONS.length !== 0) {
    throw new Error(
      `FUNNEL: ${FUNNEL_VIOLATIONS.length} write-invariant violation(s) were recorded by run() but swallowed by a bare assertRejects: ${
        JSON.stringify(FUNNEL_VIOLATIONS)
      }`,
    );
  }
});
