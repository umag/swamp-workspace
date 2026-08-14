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
import {
  BANDCAMP_INSTANCE_PREFIXES,
  formatDuration,
  model,
} from "./musicbrainz.ts";
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
      // Fail-closed write-budget funnel (musicbrainz-missing-seed-instance-
      // collision, round 4) — see WRITE_BUDGET/run() below. The model itself
      // never reads this property; it's exposed purely so run() can assert
      // on it.
      __written: written,
    },
  };
}

/**
 * Assert the STRUCTURAL invariant find-missing/seed-all-missing both hold —
 * exactly one resource written, at the given spec — and return it. Round 3
 * (musicbrainz-missing-seed-instance-collision review): a deprecation alias
 * gated on argument shape (`!args.artistMbid`), then on the resolved local
 * (`!artistMbid`), then on computed state (`missing.length === 0` /
 * `releases.length === 0`) each slipped past a DIFFERENT hand-picked
 * `written.map((w) => w.name)` literal pin, because a pin attached to one
 * fixture's write list only covers the state that fixture happens to
 * produce. `onlyWrite` is attached to the property instead of any one
 * fixture: it fails on an extra write regardless of what condition produced
 * it or what the fixture's other assertions expect, so it cannot be walked
 * past by inventing a new gate the way the four per-test pins were.
 */
function onlyWrite(written: Written[], spec: string): Written {
  assertEquals(
    written.length,
    1,
    `expected exactly one resource write, got ${written.length}: ${
      JSON.stringify(written.map((w) => `${w.spec}:${w.name}`))
    }`,
  );
  assertEquals(
    written[0].spec,
    spec,
    `the one write must be spec "${spec}", got "${written[0].spec}"`,
  );
  return written[0];
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

// Per-method write budget for every method with a call-shape-independent
// write count — the funnel `run()` enforces below. `sync-artist-discographies`
// is a genuine fan-out (0..batchSize per-artist writes plus one cursor-state
// write) and is deliberately left OUT rather than pinned to a number that
// would be wrong on the very next fixture.
//
// This is the STRUCTURAL counterpart to `onlyWrite` above: `onlyWrite`
// documents and asserts the shape a given TEST expects; WRITE_BUDGET/run()
// make that shape true of every invocation of a budgeted method in this
// file, whether or not the test author remembered to call `onlyWrite` — see
// the round-4 review this closes (three invented gatings — a paginated-
// catalogue alias, a maxPages-gated alias, and find-missing writing into
// seed-all-missing's spec — all passed 263/0 by landing in one of this
// file's eleven un-pinned `written.find(...)` readers, none of which
// exercise `onlyWrite` at all).
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
// throw — see the
// "a crash mid-batch still persists..." test in musicbrainz_methods_test.ts).
// `run()` below checks every row in the delta window against this predicate
// in place of a count for any method listed here.
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
// future — rather than relying on each new test to remember a per-test pin.
// Fail-CLOSED on two axes:
//  1. A method with NEITHER a WRITE_BUDGET NOR a WRITE_SHAPE entry throws
//     immediately, rather than passing through unchecked the way
//     `sync-artist-discographies` used to — so the next method added to the
//     model can't silently land outside the funnel either.
//  2. A budgeted/shaped method invoked against a ctx that doesn't expose
//     `__written` throws rather than silently skipping the check, so a
//     hand-rolled ctx (makeSyncCtx / makeCollisionCtx below) has to opt in.
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
    // Selected by INSTANCE NAME, not spec: once search-artist ALSO writes a
    // deprecated alias under the same spec "artists" (a different instance
    // name, "search"), `method` (which equals the canonical instance name
    // for every row in SEARCH_GUARD_CASES) stays the only unambiguous key.
    const res = written.find((w) => w.name === method)!;
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
    // Selected by INSTANCE NAME, not spec: once search-artist ALSO writes a
    // deprecated alias under the same spec "artists" (a different instance
    // name, "search"), `method` (which equals the canonical instance name
    // for every row in SEARCH_GUARD_CASES) stays the only unambiguous key.
    const res = written.find((w) => w.name === method)!;
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
// KNOWN COVERAGE GAPS in find-missing / seed-all-missing (musicbrainz-
// missing-seed-instance-collision, round 5) — recorded here, not just in a
// review file, so the next person editing either method's pagination or
// track-count handling sees the gap instead of trusting a green suite.
// Each was confirmed by temporarily throwing on the condition and observing
// the suite stay fully green.
//   - `bandcampUrl` already ending "/music" — the else-arm of the URL-
//     normalization guard (the `if (!bcUrl.endsWith("/music")) bcUrl +=
//     "/music";` line, present verbatim once in find-missing's execute and
//     once in seed-all-missing's) — no fixture in this file passes a
//     bandcampUrl already suffixed "/music".
//   - seed-all-missing's `context.globalArgs.maxPages` override
//     (`maxPagesArg !== undefined`, i.e. the `?? 50` fallback on
//     `const maxPages = maxPagesArg ?? 50;` inside seed-all-missing's own
//     execute, distinct from find-missing's copy of the same line) — no
//     seed-all-missing fixture sets a custom maxPages global arg.
//   - seed-all-missing's release-group pagination loop reaching a full
//     100-item first page (the `for (let page = 0; page < maxPages;
//     page++)` loop inside seed-all-missing's own `if (artistMbid) {`
//     block) — find-missing's mirror of this IS exercised (the "LB4 FIX"
//     pagination tests below), but no seed-all-missing fixture drives its
//     own loop past one partial page.
//   - the "trust the album data" `albumData.tracks.length || trackCount`
//     branch — present once in find-missing's per-album try block and once
//     in seed-all-missing's — no fixture's album JSON-LD/tralbum payload
//     supplies a non-empty `tracks` array, so the DOM-derived trackCount
//     always wins.
//   - WRITE_SHAPE for sync-artist-discographies is a PREFIX PATTERN, not
//     membership: the predicate accepts any `browse` row whose name starts
//     with "rg-by-artist-", so a write for an MBID that was never in the
//     requested batch would still pass the funnel (the WRITE_SHAPE preamble
//     comment above explains why shape replaced count but not what shape
//     does not check).
//   - seed-all-missing has no failure-path test mirroring find-missing's
//     "failure path — a non-ok Bandcamp discography fetch throws, and
//     writes nothing on the way out" (musicbrainz_methods_test.ts:1321) —
//     no seed-all-missing fixture drives a non-ok discography fetch, so a
//     write-before-rethrow there has no dedicated catcher.
// None of these writes anything conditionally as shipped today (they're
// pagination/arithmetic branches, not gated writes), which is why closing
// GUARD I's gap didn't also close these — but a future change that adds a
// write behind any of them would land here unnoticed, the same shape as the
// escape this issue has spent five rounds closing elsewhere.
// ---------------------------------------------------------------------------

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
  // onlyWrite subsumes round-2's GUARD C full-write-list pin: this is the
  // artist-MBID-UNRESOLVED path, exactly where the pre-fix bare "unknown"
  // instance lived, and where a deprecation alias has twice been re-added
  // gated on a DIFFERENT condition each round. Round-3 review (fallback
  // axis): the instance name is now derived from bandcampUrl
  // ("fixturemarinholloway", this fixture's subdomain), not the old shared
  // "unknown" constant — see GUARD J in musicbrainz_property_test.ts and the
  // two-artist reproduction below for why that constant was itself a
  // collision.
  const res = onlyWrite(written, "missingReleases");
  assertEquals(res.payload.artistMbid, undefined);
  assertEquals(res.payload.mbReleaseCount, 0);
  assertEquals(
    res.name,
    "find-missing-bc-fixturemarinholloway",
    "writeResource's name falls back to a bandcampUrl-derived instance when artistMbid is undefined",
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
  // onlyWrite subsumes round-2's GUARD C mirror pin — see the find-missing
  // test above.
  const res = onlyWrite(written, "seedUrls");
  assertEquals(res.payload.artistMbid, undefined);
  assertEquals(res.name, "seed-all-missing-bc-fixturemarinholloway");
  assertEquals(res.payload.total, 2);
});

// ---------------------------------------------------------------------------
// Round 3/round 4 review (musicbrainz-missing-seed-instance-collision): the
// unresolved-artist console.error diagnostic — naming the instance actually
// written, rendering bandcampUrl's HOSTNAME ONLY (never the raw argument, so
// embedded userinfo never reaches the log), and clamping the scraped artist
// name to 120 chars — had NO assertion anywhere in this package. Three
// mutants survived a fully green suite: reverting the hostname-only render
// back to the raw bandcampUrl argument, dropping the 120-char artistName
// clamp, and deleting BOTH console.error call sites outright. Captures the
// real console.error around run() rather than reimplementing the log's
// format, so a wording change does not itself break this test — only the
// three properties below do.
// ---------------------------------------------------------------------------

const ARTIST_LONGNAME_HTML = `<!doctype html>
<html><head></head><body>
<p id="band-name-location"><span class="title">${"A".repeat(5000)}</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/x"><p class="title">X</p></a></li>
</ol></div>
</body></html>`;

async function withCapturedConsoleError(
  fn: () => Promise<unknown>,
): Promise<string[]> {
  const captured: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return captured;
}

Deno.test("find-missing: unresolved-artist console.error names the instance actually written, never leaks bandcampUrl's userinfo, and stays length-bounded against a pathological scraped artist name", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();

  const captured = await withCapturedConsoleError(() =>
    withFetchStub(
      [
        (req) => (isBcHost(req) ? html(ARTIST_LONGNAME_HTML) : undefined),
        (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
      ],
      () =>
        drainAndAwait(
          time,
          run("find-missing", {
            bandcampUrl:
              "https://alice:hunter2@fixturemarinholloway.bandcamp.com",
          }, ctx),
        ),
    )
  );

  const res = onlyWrite(written, "missingReleases");
  assertEquals(
    captured.length,
    1,
    "exactly one console.error at the resolution boundary — a deleted call site (mutant M12) leaves this at 0",
  );
  const message = captured[0];
  assert(
    message.includes(res.name),
    `console.error must name the instance actually written ("${res.name}"), got: ${message}`,
  );
  assert(
    !message.includes("hunter2"),
    `console.error must never leak bandcampUrl's userinfo credential — a raw-URL regression (mutant M10) puts "hunter2" in the message, got: ${message}`,
  );
  assert(
    message.length < 1000,
    `console.error must stay length-bounded against a pathological scraped artist name (5000 chars in) — a dropped clamp (mutant M11) makes this thousands of chars, got ${message.length} chars`,
  );
});

Deno.test("seed-all-missing: unresolved-artist console.error mirror — same three properties as find-missing's version above", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();

  const captured = await withCapturedConsoleError(() =>
    withFetchStub(
      [
        (req) => (isBcHost(req) ? html(ARTIST_LONGNAME_HTML) : undefined),
        (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
      ],
      () =>
        drainAndAwait(
          time,
          run("seed-all-missing", {
            bandcampUrl:
              "https://alice:hunter2@fixturemarinholloway.bandcamp.com",
          }, ctx),
        ),
    )
  );

  const res = onlyWrite(written, "seedUrls");
  assertEquals(captured.length, 1);
  const message = captured[0];
  assert(
    message.includes(res.name),
    `console.error must name the instance actually written ("${res.name}"), got: ${message}`,
  );
  assert(
    !message.includes("hunter2"),
    `console.error must never leak bandcampUrl's userinfo credential, got: ${message}`,
  );
  assert(
    message.length < 1000,
    `console.error must stay length-bounded, got ${message.length} chars`,
  );
});

// ---------------------------------------------------------------------------
// GUARD B (musicbrainz-missing-seed-instance-collision) — the EMPTY-STRING
// case, execute()-level. `artistMbid: ""` is falsy, exactly like `undefined`,
// but is a DIFFERENT input: it is explicitly PASSED, not omitted, so it
// enters (and survives, unresolved) the exact same auto-resolve branch as the
// omitted-argument tests above. The fallback operator must be `||`, not `??`
// — `??` only catches null/undefined, so an empty string would slip through
// and render a dangling-hyphen name (`find-missing-` / `seed-all-missing-`)
// instead of falling back to the bandcampUrl-derived instance (round-2's
// "unknown" constant, before the fallback-axis fix below). Nothing before
// this issue tested this input at all.
// ---------------------------------------------------------------------------

Deno.test("GUARD B: find-missing — an EXPLICIT empty-string artistMbid (not omitted) still falls back to the bandcampUrl-derived instance, never a dangling hyphen", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(ARTIST_MUSICGRID_HTML) : undefined),
      (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
          artistMbid: "",
        }, ctx),
      ),
  );
  // onlyWrite subsumes round-2's GUARD B full-write-list pin.
  const res = onlyWrite(written, "missingReleases");
  assertEquals(
    res.name,
    "find-missing-bc-fixturemarinholloway",
    'GUARD B: find-missing\'s written instance name must be exactly "find-missing-bc-fixturemarinholloway" for an explicit empty-string artistMbid — a divergence here may be the || fallback rendering a dangling hyphen, or any other regression in how the name is built',
  );
});

Deno.test("GUARD B: seed-all-missing — an EXPLICIT empty-string artistMbid (not omitted) still falls back to the bandcampUrl-derived instance, never a dangling hyphen", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(ARTIST_MUSICGRID_HTML) : undefined),
      (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
    ],
    () =>
      drainAndAwait(
        time,
        run("seed-all-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
          artistMbid: "",
        }, ctx),
      ),
  );
  // onlyWrite subsumes round-2's GUARD B mirror pin.
  const res = onlyWrite(written, "seedUrls");
  assertEquals(
    res.name,
    "seed-all-missing-bc-fixturemarinholloway",
    'GUARD B: seed-all-missing\'s written instance name must be exactly "seed-all-missing-bc-fixturemarinholloway" for an explicit empty-string artistMbid — a divergence here may be the || fallback rendering a dangling hyphen, or any other regression in how the name is built',
  );
});

// ---------------------------------------------------------------------------
// GUARD J (musicbrainz-missing-seed-instance-collision, fallback axis) —
// review found round-2's fix namespaces by METHOD, not by ARTIST: on the
// unresolved-artistMbid path, every unresolved artist collapsed onto the
// SAME constant suffix ("unknown"), so the collision this issue exists to
// close reappeared one axis over, across artists rather than across
// methods — and "unresolved" is the MODAL path for a tool whose job is
// finding artists MISSING from MusicBrainz. Reproduces the review's exact
// scenario: two distinct unresolved artists, run through BOTH methods (four
// executions total against ONE shared ctx, so every write lands in the same
// `written` array exactly as it would across four separate
// `swamp model method run` invocations). Pre-fix this left only the last
// artist's two rows surviving; post-fix `bandcampUrlSlug` derives a
// distinct, `bc-`-namespaced suffix per artist from the required
// `bandcampUrl`, so all four writes land at four distinct names and BOTH
// artists' rows survive intact.
// ---------------------------------------------------------------------------

const ARTIST_OBSCURE_ALPHA_HTML = `<!doctype html>
<html><head></head><body>
<p id="band-name-location"><span class="title">Obscure Alpha</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/alpha-debut"><p class="title">Alpha Debut</p></a></li>
</ol></div>
</body></html>`;

const ARTIST_OBSCURE_BETA_HTML = `<!doctype html>
<html><head></head><body>
<p id="band-name-location"><span class="title">Obscure Beta</span></p>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/beta-debut"><p class="title">Beta Debut</p></a></li>
</ol></div>
</body></html>`;

Deno.test("GUARD J: two distinct unresolved artists, both methods, four runs — every row survives at a distinct instance (the fallback-axis collision review found by execution)", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();

  const runOne = (
    method: string,
    bandcampUrl: string,
    artistHtml: string,
  ) =>
    withFetchStub(
      [
        (req) => (isBcHost(req) ? html(artistHtml) : undefined),
        (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
      ],
      () => drainAndAwait(time, run(method, { bandcampUrl }, ctx)),
    );

  await runOne(
    "find-missing",
    "https://obscurealpha.bandcamp.com",
    ARTIST_OBSCURE_ALPHA_HTML,
  );
  await runOne(
    "find-missing",
    "https://obscurebeta.bandcamp.com",
    ARTIST_OBSCURE_BETA_HTML,
  );
  await runOne(
    "seed-all-missing",
    "https://obscurealpha.bandcamp.com",
    ARTIST_OBSCURE_ALPHA_HTML,
  );
  await runOne(
    "seed-all-missing",
    "https://obscurebeta.bandcamp.com",
    ARTIST_OBSCURE_BETA_HTML,
  );

  assertEquals(
    written.length,
    4,
    `expected four writes (one per run), got ${written.length}: ${
      JSON.stringify(written.map((w) => `${w.spec}:${w.name}`))
    }`,
  );
  assertEquals(
    new Set(written.map((w) => w.name)).size,
    4,
    `all four instance names must be distinct — a repeat here means the fallback still collides: ${
      JSON.stringify(written.map((w) => w.name))
    }`,
  );

  const findMissingAlpha = written.find((w) =>
    w.spec === "missingReleases" && w.name === "find-missing-bc-obscurealpha"
  );
  const findMissingBeta = written.find((w) =>
    w.spec === "missingReleases" && w.name === "find-missing-bc-obscurebeta"
  );
  const seedAlpha = written.find((w) =>
    w.spec === "seedUrls" && w.name === "seed-all-missing-bc-obscurealpha"
  );
  const seedBeta = written.find((w) =>
    w.spec === "seedUrls" && w.name === "seed-all-missing-bc-obscurebeta"
  );

  assert(findMissingAlpha, "find-missing-bc-obscurealpha must survive intact");
  assert(findMissingBeta, "find-missing-bc-obscurebeta must survive intact");
  assert(seedAlpha, "seed-all-missing-bc-obscurealpha must survive intact");
  assert(seedBeta, "seed-all-missing-bc-obscurebeta must survive intact");

  assertEquals(findMissingAlpha!.payload.artist, "Obscure Alpha");
  assertEquals(findMissingBeta!.payload.artist, "Obscure Beta");
  assertEquals(seedAlpha!.payload.artist, "Obscure Alpha");
  assertEquals(seedBeta!.payload.artist, "Obscure Beta");
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
  // onlyWrite subsumes round-2's GUARD G(a) full-write-list pin.
  const res = onlyWrite(written, "missingReleases");
  assertEquals(res.payload.artistMbid, "00000000-0000-0000-0000-000000000001");
  assertEquals(
    res.name,
    "find-missing-00000000-0000-0000-0000-000000000001",
    'GUARD G(a): find-missing\'s written instance name must equal "find-missing-00000000-0000-0000-0000-000000000001" — built from the RESOLVED local artistMbid (reassigned from the artist search), not the omitted args.artistMbid',
  );
  const matched = res.payload.matched as Array<Record<string, unknown>>;
  const missing = res.payload.missing as unknown[];
  assertEquals(matched.length, 1);
  assertEquals(missing.length, 1);
});

Deno.test("GUARD G(a) mirror: seed-all-missing — an EXACT normalizeTitle match auto-resolves the artist, and the written instance name is built from the RESOLVED mbid, never the omitted argument", async () => {
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
        run("seed-all-missing", {
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
  // onlyWrite subsumes round-2's GUARD G(a) mirror pin.
  const res = onlyWrite(written, "seedUrls");
  assertEquals(res.payload.artistMbid, "00000000-0000-0000-0000-000000000001");
  assertEquals(
    res.name,
    "seed-all-missing-00000000-0000-0000-0000-000000000001",
    'GUARD G(a) mirror: seed-all-missing\'s written instance name must equal "seed-all-missing-00000000-0000-0000-0000-000000000001" — built from the RESOLVED local artistMbid, not the omitted args.artistMbid',
  );
  const releases = res.payload.releases as unknown[];
  assertEquals(releases.length, 1, "the matched release is excluded");
});

// ---------------------------------------------------------------------------
// GUARD I (musicbrainz-missing-seed-instance-collision, reachability gap) —
// every exact-match fixture above (GUARD G(a) and its mirror) resolves an MB
// artist whose `.name` is BYTE-IDENTICAL to ARTIST_MUSICGRID_HTML's
// "Fixture Marin Holloway", so `artistName = exact.name` (musicbrainz.ts's
// auto-resolve reassignment) is a same-value write on every fixture in this
// suite: no fixture anywhere drives `artistName !== bcArtist.name` to true.
// A write (or any other behavior) gated on that condition is therefore
// unreachable — probed directly by temporarily throwing on the condition and
// confirming the suite stays 263/0. MusicBrainz canonical names routinely
// differ from a Bandcamp page's rendering (diacritics is one of the more
// common cases: MB carries "í", Bandcamp's plain-text title strips it), so
// this is a realistic case, not a contrived one. Both tests keep the SAME
// normalizeTitle-equivalence the GUARD G(a) fixtures rely on (NFKD-decompose
// + strip combining marks makes "í" and "i" equal) while making the raw
// strings differ, so the exact-match branch still fires but now with a
// TEXTUAL mismatch downstream.
// ---------------------------------------------------------------------------

Deno.test("GUARD I: find-missing — an EXACT normalizeTitle match whose canonical MusicBrainz name differs TEXTUALLY (diacritic) from the Bandcamp-parsed name still auto-resolves, and the written `artist` field reflects the RESOLVED canonical name, not the Bandcamp string", async () => {
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
              id: "00000000-0000-0000-0000-000000000002",
              // Diacritic on the "i" in "Marin" — NFKD-decomposes to
              // "i" + combining acute (U+0301), which normalizeTitle's
              // U+0300-U+036F strip removes, so this is normalizeTitle-equal
              // to Bandcamp's plain "Fixture Marin Holloway" while being a
              // DIFFERENT JS string (!==).
              name: "Fixture Marín Holloway",
            }],
          });
        }
        return json({
          "release-groups": [{
            id: "00000000-0000-0000-0000-000000000602",
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
            "1 artist search + 1 release-group browse — the exact match still auto-resolves despite the textual diff",
          );
        }),
      ),
  );
  const res = onlyWrite(written, "missingReleases");
  assertEquals(res.payload.artistMbid, "00000000-0000-0000-0000-000000000002");
  assertEquals(
    res.payload.artist,
    "Fixture Marín Holloway",
    "the written artist field must be the RESOLVED canonical name (exact.name), not the Bandcamp-parsed string",
  );
  assert(
    res.payload.artist !== "Fixture Marin Holloway",
    "GUARD I: this is the textual-mismatch state (artistName !== bcArtist.name) that no other fixture in this suite ever drives",
  );
  assertEquals(
    res.name,
    "find-missing-00000000-0000-0000-0000-000000000002",
    "instance name is still built from the resolved mbid, unaffected by the name mismatch",
  );
  const matched = res.payload.matched as Array<Record<string, unknown>>;
  const missing = res.payload.missing as unknown[];
  assertEquals(matched.length, 1);
  assertEquals(missing.length, 1);
});

Deno.test("GUARD I mirror: seed-all-missing — an EXACT normalizeTitle match whose canonical MusicBrainz name differs TEXTUALLY (diacritic) from the Bandcamp-parsed name still auto-resolves, and the written `artist` field reflects the RESOLVED canonical name, not the Bandcamp string", async () => {
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
              id: "00000000-0000-0000-0000-000000000002",
              name: "Fixture Marín Holloway",
            }],
          });
        }
        return json({
          "release-groups": [{
            id: "00000000-0000-0000-0000-000000000602",
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
        run("seed-all-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        }, ctx).then(() => {
          assertEquals(
            calls.filter(isMbHost).length,
            2,
            "1 artist search + 1 release-group browse — the exact match still auto-resolves despite the textual diff",
          );
        }),
      ),
  );
  const res = onlyWrite(written, "seedUrls");
  assertEquals(res.payload.artistMbid, "00000000-0000-0000-0000-000000000002");
  assertEquals(
    res.payload.artist,
    "Fixture Marín Holloway",
    "the written artist field must be the RESOLVED canonical name (exact.name), not the Bandcamp-parsed string",
  );
  assert(
    res.payload.artist !== "Fixture Marin Holloway",
    "GUARD I mirror: this is the textual-mismatch state (artistName !== bcArtist.name) that no other fixture in this suite ever drives",
  );
  assertEquals(
    res.name,
    "seed-all-missing-00000000-0000-0000-0000-000000000002",
    "instance name is still built from the resolved mbid, unaffected by the name mismatch",
  );
  const releases = res.payload.releases as unknown[];
  assertEquals(releases.length, 1, "the matched release is excluded");
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
  const res = onlyWrite(written, "missingReleases");
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
  const res = onlyWrite(written, "missingReleases");
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
  const res = onlyWrite(written, "missingReleases");
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
  const res = onlyWrite(written, "missingReleases");
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
  const res = onlyWrite(written, "missingReleases");
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
// Round-3 MEDIUM finding (musicbrainz-missing-seed-instance-collision):
// seed-all-missing's album-fetch catch (the `catch {` immediately after
// `trackCount = albumData.tracks.length || trackCount;` inside
// seed-all-missing's own per-album try block) was reached by no test — the
// mirror find-missing catch above was covered, this one was
// not — plus two fixture states neither method's tests ever produced: an
// empty Bandcamp discography, and a Bandcamp page whose artist name doesn't
// parse. All three hide a bare-"unknown" write at 260/0 before this fix.
// ---------------------------------------------------------------------------

Deno.test("seed-all-missing: the album-fetch try/catch — a failing per-album fetch falls back to a MINIMAL seed URL (mirror of find-missing's fallback test above; this catch had NO coverage at all before this fixture)", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => {
        if (!isBcHost(req)) return undefined;
        const url = new URL(req.url);
        // Discography listing succeeds; the per-album detail fetch (any
        // /album or /track path) FAILS to exercise seed-all-missing's OWN
        // try/catch fallback (its `catch {` right after the
        // `albumData.tracks.length || trackCount` line) — distinct from
        // (and, before this test, unlike) find-missing's mirror catch above.
        if (url.pathname.endsWith("/music")) return html(ARTIST_MUSICGRID_HTML);
        return html("server error", 500);
      },
      () => mbEmptyArtistSearch(),
    ],
    () =>
      drainAndAwait(
        time,
        run("seed-all-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        }, ctx),
      ),
  );
  const res = onlyWrite(written, "seedUrls");
  const releases = res.payload.releases as Array<Record<string, unknown>>;
  assertEquals(
    releases.length,
    2,
    "neither discography entry matches an MB release, so both fall through to the failed-fetch minimal seed",
  );
  for (const r of releases) {
    assertEquals(
      r.trackCount,
      0,
      "the minimal fallback seed has no track-count data — the album fetch that would supply it failed",
    );
    assert(
      (r.seedUrl as string).startsWith("https://musicbrainz.org/release/add?"),
      "the minimal fallback still produces a usable seed URL",
    );
  }
});

Deno.test("find-missing: an EMPTY Bandcamp discography (no JSON-LD album list, empty #music-grid) -> missing and matched both stay [] instead of never being produced", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const emptyDiscographyHtml = `<!doctype html>
<html><head></head><body>
<p id="band-name-location"><span class="title">Fixture Empty Discography Artist</span></p>
<div id="music-grid"><ol></ol></div>
</body></html>`;
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(emptyDiscographyHtml) : undefined),
      (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
    ],
    () =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixtureemptydiscographyartist.bandcamp.com",
        }, ctx),
      ),
  );
  const res = onlyWrite(written, "missingReleases");
  assertEquals(res.payload.bcReleaseCount, 0);
  const missing = res.payload.missing as unknown[];
  const matched = res.payload.matched as unknown[];
  assertEquals(missing.length, 0, "no discography entries -> nothing to seed");
  assertEquals(
    matched.length,
    0,
    "no discography entries -> nothing to match either",
  );
});

Deno.test("find-missing: an UNPARSEABLE artist name (no #band-name-location title) -> the auto-resolve branch is SKIPPED entirely (no MusicBrainz artist-search call), artistMbid stays unresolved", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const noArtistNameHtml = `<!doctype html>
<html><head></head><body>
<div id="music-grid"><ol>
  <li class="music-grid-item"><a href="/album/x"><p class="title">Fixture Untitled Release</p></a></li>
</ol></div>
</body></html>`;
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(noArtistNameHtml) : undefined),
      (req) => (isMbHost(req) ? mbEmptyArtistSearch() : undefined),
    ],
    (calls) =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixtureuntitled.bandcamp.com",
        }, ctx).then(() => {
          assertEquals(
            calls.filter(isMbHost).length,
            0,
            "an empty/unparsed artist name is falsy, so `!artistMbid && artistName` is false and the auto-resolve search is never called at all",
          );
        }),
      ),
  );
  const res = onlyWrite(written, "missingReleases");
  assertEquals(res.payload.artist, "");
  assertEquals(res.payload.artistMbid, undefined);
  assertEquals(res.name, "find-missing-bc-fixtureuntitled");
  const missing = res.payload.missing as Array<Record<string, unknown>>;
  assertEquals(
    missing.length,
    1,
    "no MB releases were ever fetched, so the one discography entry is unconditionally 'missing'",
  );
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
      // See makeCtx() above — this file also drives budgeted
      // search-artists-batch calls through this ctx, not just
      // sync-artist-discographies.
      __written: written,
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
// Chain presence — musicbrainz declares a non-empty upgrades[] migration
// chain. The TERMINUS rule (the newest upgrades[].toVersion must equal
// model.version) moved to the repo-wide
// scripts/quality/check_upgrade_chain.ts gate, which owns that check for
// every manifest-listed model file, not just this one; what remains here
// is musicbrainz's OWN presence requirement — this package specifically
// commits to declaring a migration chain, which the
// global gate does not and must not enforce (28 of 59 real declarations
// legitimately have no chain at all, and an absent one is legal).
// ---------------------------------------------------------------------------

Deno.test("model surface: model.upgrades declares a non-empty migration chain", () => {
  const upgrades = model.upgrades as Array<
    { fromVersion: string; toVersion: string }
  >;
  assert(upgrades.length > 0, "model.upgrades must not be empty");
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

Deno.test("NEW SURFACE: search-artists-batch writes instance name 'artist-search-batch' — never any other method's resource instance", async () => {
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
  assertEquals(
    written.length,
    1,
    "search-artists-batch must write exactly one resource — never any other method's resource instance (e.g. no search-artist deprecation alias)",
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
// `find-missing` and `seed-all-missing` still derive the SUFFIX of their
// written instance name from an UNCONSTRAINED free-string `artistMbid`, so no
// test, this one included, can prove disjointness over every possible
// caller-supplied string. What changed with
// musicbrainz-missing-seed-instance-collision: the two methods now write
// under DISJOINT PREFIXES (`bandcampInstanceName`, `BANDCAMP_INSTANCE_
// PREFIXES` in musicbrainz.ts) instead of sharing the bare `artistMbid` as
// the whole instance name, so the two of them can no longer collide WITH
// EACH OTHER regardless of what `artistMbid` is — closed by construction,
// checked by Guard D (the prefix sweep below) and Guard E (the deterministic
// exhaustive disjointness table in musicbrainz_property_test.ts), not left to
// this fixture-bounded invariant alone. This invariant now says
// "collision-free across the fixtures actually run below, with NO carve-out"
// — never "any present or future collision", but no longer needs one either.
//
// KNOWN_UNFIXED_COLLISIONS is kept EMPTY as the documented extension point
// for a future, different, genuinely-unfixed collision — see its own comment
// below for why it stays keyed on the instance name **and** the sorted spec
// set together (spec-set-only would silently excuse a future
// `{missingReleases, seedUrls}` pair landing at some OTHER instance name; spec
// `seedUrls` already has a second, unrelated writer, `seed-from-bandcamp`'s
// fixed instance `seed-single`, written by the model's `seed-from-bandcamp`
// method). The test still asserts
// every allowlist key was actually observed, so if this Map is ever populated
// again, that new entry self-destructs (goes red) the moment its own
// collision is fixed too.
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
      readResource: (name: string) => Promise.resolve(store.get(name) ?? null),
      writeResource: (spec: string, name: string, payload: unknown) => {
        store.set(name, payload as Record<string, unknown>);
        written.push({ spec, name });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
      // See makeCtx() above — the COLLISION_FIXTURES table below drives
      // EVERY model method (including every budgeted one) through this ctx
      // via runCollision(), so this is the one hand-rolled ctx in the file
      // that MUST opt in or the funnel throws on the very first fixture.
      __written: written,
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
 * declared arguments schema (the `entity` field of `search`'s own `arguments`
 * zod object) rather than hardcoded — a 13th entity added to the enum is
 * automatically covered by one more execution here, with no edit needed in
 * this file. */
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
  // find-missing and seed-all-missing are BOTH given the SAME artistMbid,
  // matching the live `res.name` pins in musicbrainz_methods_test.ts's
  // find-missing / seed-all-missing happy-path tests — deliberately, and no
  // longer to observe a collision (there isn't one
  // anymore): sharing one constant is what makes a TWO-SIDED REVERT of the
  // fix observable by this invariant (mutation C1) and a drifted MBID between
  // the two fixtures observable by Guard G(b)'s exact instance-name-set
  // assertion below (mutation G3) — if the two fixtures ever used different
  // MBIDs, a bug that reverted BOTH call sites back to the bare artistMbid
  // would produce two same-named single-spec entries in byInstance instead of
  // one two-spec entry, and this invariant would stay green over the exact
  // regression it exists to catch.
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

/** The documented extension point for a FUTURE, genuinely-unfixed collision —
 * empty today. musicbrainz-missing-seed-instance-collision's carve-out
 * (`find-missing` / `seed-all-missing` sharing the bare `artistMbid`) is
 * DELETED, not emptied-and-forgotten: the two methods now write disjoint
 * prefixed instance names (musicbrainz.ts's `bandcampInstanceName` /
 * `BANDCAMP_INSTANCE_PREFIXES`), so byInstance below no longer produces a
 * multi-spec entry for either of them, and a still-present carve-out entry
 * would trip the "was never observed" assertion a few lines down — this Map
 * would go red the moment the fix landed if the entry stayed, by design (see
 * the section comment above). Kept keyed on the instance name AND the sorted
 * spec set together, same rationale as before: spec-set-only would silently
 * excuse a future collision at some OTHER instance name too. */
const KNOWN_UNFIXED_COLLISIONS = new Map<
  string,
  { producers: string[]; tracking: string }
>([]);

Deno.test("COLLISION INVARIANT: every resource instance this model writes maps to exactly one spec (no carve-outs), and the two Bandcamp-compare namespaces are exclusive to their own methods", async () => {
  using time = new FakeTime();

  assertEquals(
    Object.keys(COLLISION_FIXTURES).sort(),
    Object.keys(model.methods).sort(),
    "every model method must have a COLLISION_FIXTURES entry — a new method must be added here too",
  );

  const byInstance = new Map<string, Set<string>>();
  // GUARD D prerequisite: byInstance alone discards WHICH method wrote a
  // name, so the prefix sweep below needs its own accumulator, built in the
  // SAME loop rather than re-running every fixture a second time.
  const byMethod = new Map<string, Set<string>>();
  // GUARD G(b) prerequisite, kept SEPARATE from byMethod above: byMethod is
  // a Map<string, Set<string>>, so a duplicate write at the SAME name AND
  // spec (a double-write / non-idempotent-emit regression — two data rows,
  // two handles, one name) collapses to one Set entry and stays invisible to
  // every check that reads byMethod. byMethodWrites accumulates the RAW
  // write array per method instead, so G(b) below can assert on write
  // COUNT as well as name.
  const byMethodWrites = new Map<string, string[]>();
  for (const [method, fixture] of Object.entries(COLLISION_FIXTURES)) {
    const writes = await fixture(time);
    assert(writes.length > 0, `${method}'s collision fixture wrote nothing`);
    for (const { name, spec } of writes) {
      const specs = byInstance.get(name) ?? new Set<string>();
      specs.add(spec);
      byInstance.set(name, specs);
      const names = byMethod.get(method) ?? new Set<string>();
      names.add(name);
      byMethod.set(method, names);
      const rawNames = byMethodWrites.get(method) ?? [];
      rawNames.push(name);
      byMethodWrites.set(method, rawNames);
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
    offenders.push(
      `instance "${name}" maps to specs [${[...specs].sort().join(", ")}]`,
    );
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

  // GUARD D (musicbrainz-missing-seed-instance-collision) — prefix-based
  // cross-method sweep: for EITHER in-scope prefix (read live off the
  // IMPORTED BANDCAMP_INSTANCE_PREFIXES, never hardcoded here), no OTHER
  // method may have written a name landing in that namespace. Deliberately
  // NOT broadened to "no name written by two methods" — browse-release-groups
  // and sync-artist-discographies legitimately share `rg-by-artist-<mbid>`
  // under one spec, and that is fine.
  for (
    const [inScopeMethod, prefix] of Object.entries(
      BANDCAMP_INSTANCE_PREFIXES,
    )
  ) {
    for (const [method, names] of byMethod) {
      if (method === inScopeMethod) continue;
      for (const name of names) {
        assert(
          name !== prefix && !name.startsWith(`${prefix}-`),
          `GUARD D: method "${method}" wrote instance "${name}", landing inside "${inScopeMethod}"'s namespace (prefix "${prefix}")`,
        );
      }
    }
  }

  // GUARD G(b) (musicbrainz-missing-seed-instance-collision) — the COMPLETE
  // write list (not a deduplicated set: byMethodWrites, so a duplicate write
  // at the same name is also visible) each in-scope method produced, compared
  // against names BUILT FROM THE IMPORTED BANDCAMP_INSTANCE_PREFIXES
  // registry — never a hardcoded literal. This is what actually joins the
  // registry to PRODUCTION: Guard D (above) reads the registry but skips the
  // in-scope method's own output (`if (method === inScopeMethod) continue`),
  // and Guard E/F in musicbrainz_property_test.ts only prove the registry is
  // internally disjoint and that the FACTORY matches it — neither compares
  // the registry against what find-missing/seed-all-missing actually wrote.
  // Registry-derived expected values close that gap: if the registry value
  // and what find-missing/seed-all-missing actually write ever diverge — a
  // renamed registry entry that a call site did not follow, or a call site
  // that stopped going through `bandcampInstanceName` and then drifted —
  // this fails. (Measured: a call site that inlines a byte-identical
  // template literal instead of calling `bandcampInstanceName` is NOT
  // caught and does not need to be — the name it writes is still pinned
  // exactly here.) Also catches a re-added second write inside find-missing
  // for THIS FIXTURE'S argument shape (an explicit COLLISION_ARTIST_MBID)
  // and a fixture MBID drifting out of sync between the two
  // COLLISION_FIXTURES entries above, which would silently disarm mutation
  // C1's two-sided-revert observation. It does NOT reach the omitted- or
  // unresolved-artistMbid shapes — COLLISION_FIXTURES always passes an
  // explicit mbid, so a deprecation alias gated on the omitted argument or
  // on the resolved local `artistMbid` never fires this fixture at all; the
  // `onlyWrite` calls in the artist-MBID-unresolved and empty-string tests
  // above cover those two shapes instead — and, being gated on the write
  // count rather than a fixture-specific name list, also cover any OTHER
  // condition a future alias might be gated on.
  assertEquals(
    byMethodWrites.get("find-missing") ?? [],
    [`${BANDCAMP_INSTANCE_PREFIXES["find-missing"]}-${COLLISION_ARTIST_MBID}`],
    "GUARD G(b): find-missing must write EXACTLY the one instance name find-missing-<mbid>, exactly once",
  );
  assertEquals(
    byMethodWrites.get("seed-all-missing") ?? [],
    [
      `${
        BANDCAMP_INSTANCE_PREFIXES["seed-all-missing"]
      }-${COLLISION_ARTIST_MBID}`,
    ],
    "GUARD G(b): seed-all-missing must write EXACTLY the one instance name seed-all-missing-<mbid>, exactly once",
  );
});

// Round 7: moved off Deno.test onto the module "unload" event, which Deno
// fires once per module after every SELECTED test has run — under any
// --shuffle permutation and any --filter — so this no longer depends on
// declaration order or on which tests were selected. An exception thrown
// from this handler is reported as an uncaught module error that fails the
// run. See the FUNNEL_VIOLATIONS comment near WRITE_SHAPE.
addEventListener("unload", () => {
  if (FUNNEL_VIOLATIONS.length !== 0) {
    throw new Error(
      `FUNNEL: ${FUNNEL_VIOLATIONS.length} write-invariant violation(s) were recorded by run() but swallowed by a bare assertRejects: ${
        JSON.stringify(FUNNEL_VIOLATIONS)
      }`,
    );
  }
});
