/**
 * Method-level tests for @magistr/musicbrainz — every one of the 17 methods
 * (5 search + 5 lookup + 3 browse + generic search + 3 Bandcamp-seeding
 * methods), happy + failure path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a HOST-ROUTED
 * stubbed `globalThis.fetch` (musicbrainz.org -> JSON, *.bandcamp.com ->
 * HTML) and a fake ExecCtx — the porkbun PR #65 harness pattern, adapted to
 * musicbrainz's dual-endpoint, rate-limited surface.
 *
 * musicbrainz.ts was UNMODIFIED by the original backfill this file traces
 * back to — every test up through the RATE LIMITER section and the
 * pre-existing method pins below is a characterization test that PINS the
 * model's already-shipped behavior, not red-green TDD. The
 * sync-artist-discographies section at the bottom is the one exception:
 * musicbrainz-discography-sync (2026.08.04.1, ported from an older untested
 * copy of this model) DID add real behavior — those tests exercise it, they
 * don't just pin pre-existing output.
 *
 * RATE LIMITER: `mbFetch`'s module-level `lastRequest` spacer is neutralized
 * AND explicitly pinned (not just worked around) using `@std/testing`
 * FakeTime — see the three dedicated tests at the bottom of this section.
 * `lastRequest` is still spaced at ~1100ms by default (unchanged by the
 * musicbrainz-discography-sync port, which only replaced HOW the wait is
 * computed and applied — a concurrency-safe promise-chain queue in place of
 * a plain read-then-write timestamp check, see musicbrainz.ts's own
 * comments above `mbFetch` — not the ~1100ms spacing itself). Because
 * `lastRequest` is module state that persists across every `Deno.test()` in
 * this file (the module is imported once per file), every test after the
 * FIRST uses `drainAndAwait`, a generic helper that ticks the fake clock in
 * small steps until the pending call settles — robust regardless of how
 * much virtual-time debt earlier tests left behind (empirically confirmed:
 * a burst of 5 prior calls can leave over 6s of carried-over debt on the
 * very next test's first call). The dedicated "first call, no wait" pin
 * therefore MUST be (and is) the first Deno.test() in this file — nothing
 * before it may touch `mbFetch`.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { fingerprintMbids, model } from "./musicbrainz.ts";
import { ALBUM_JSONLD_HTML } from "../../fixtures/bandcamp/album_jsonld.ts";
import { ARTIST_MUSICGRID_HTML } from "../../fixtures/bandcamp/artist_musicgrid.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  userAgent: "swamp-musicbrainz-methods-test/1.0 (fixture@example.com)",
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
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a HOST-ROUTED fetch stub for the duration of `fn`; captures every
 * request. Bridge-cast `as unknown as typeof globalThis.fetch` — the
 * kaiten/shoko CI-green pattern under deno 2.8.3 (never porkbun's older
 * direct `as typeof globalThis.fetch`). */
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

/** Single-route MB stub: every musicbrainz.org call gets the same JSON body. */
function withMbFixture(
  body: unknown,
  fn: (calls: Request[]) => Promise<unknown>,
  status = 200,
) {
  return withFetchStub(
    [(req) => (isMbHost(req) ? json(body, status) : undefined)],
    fn,
  );
}

/** Drains a FakeTime-scheduled promise regardless of how many sequential
 * rate-limiter waits it needs, robust to virtual-time debt carried over from
 * earlier tests in this module (see file header — a long file of sequential
 * MB-touching tests can accumulate a LARGE virtual-time debt, empirically
 * observed in the tens of seconds by the middle of this file). Caps at 400
 * virtual seconds (2000 * 200ms) to fail loudly (the final `await p` would
 * simply hang) rather than silently truncate a legitimately long drain. */
async function drainAndAwait<T>(time: FakeTime, p: Promise<T>): Promise<T> {
  let settled = false;
  p.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  // Flush pure-microtask chains first (a call needing NO wait resolves via
  // microtasks alone — e.g. the "no wait" rate-limiter pin — and must not
  // have the fake clock advanced at all in that case).
  for (let i = 0; i < 20 && !settled; i++) {
    await Promise.resolve();
  }
  for (let i = 0; i < 2000 && !settled; i++) {
    await time.tickAsync(200);
  }
  return await p;
}

// ---------------------------------------------------------------------------
// RATE LIMITER — explicit characterization. The "no wait" pin MUST be the
// first Deno.test() in this file (declaration order = execution order) —
// nothing above this point may call a method that touches mbFetch, or
// `lastRequest`'s module-level starting value (null, never fetched) will
// already have been advanced.
// ---------------------------------------------------------------------------

Deno.test("RATE LIMITER: the very first mbFetch call in this module incurs NO wait", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  const t0 = time.now;
  await withMbFixture(
    { artists: [], count: 0 },
    () => drainAndAwait(time, run("search-artist", { query: "first" }, ctx)),
  );
  assertEquals(
    time.now - t0,
    0,
    "lastRequest starts at null (never fetched); rateLimitDelayMs returns 0 for a null lastRequestAt, so the first call incurs no wait",
  );
});

Deno.test("RATE LIMITER: a second call soon after the first schedules a >=1100ms wait", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    { artists: [], count: 0 },
    () => drainAndAwait(time, run("search-artist", { query: "warm-up" }, ctx)),
  );
  const t1 = time.now;
  await withMbFixture(
    { artists: [], count: 0 },
    () => drainAndAwait(time, run("search-artist", { query: "second" }, ctx)),
  );
  const t2 = time.now;
  assert(
    t2 - t1 >= 1100,
    `second call must wait >=1100ms; waited ${t2 - t1}ms`,
  );
});

Deno.test("RATE LIMITER: spacing COLLAPSES toward 0 as real/fake elapsed time between calls grows", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    { artists: [], count: 0 },
    () => drainAndAwait(time, run("search-artist", { query: "warm-up" }, ctx)),
  );
  // Advance the fake clock by 900ms BETWEEN calls (simulating real elapsed
  // time passing) before launching the next call — the scheduled wait must
  // shrink by roughly that same amount (1100 - 900 = ~200ms), not stay
  // pinned at a fixed 1100ms.
  await time.tickAsync(900);
  const t1 = time.now;
  await withMbFixture(
    { artists: [], count: 0 },
    () => drainAndAwait(time, run("search-artist", { query: "third" }, ctx)),
  );
  const t2 = time.now;
  const waited = t2 - t1;
  assert(
    waited < 1100 && waited >= 0,
    `spacing must collapse below the full 1100ms once 900ms already elapsed; got ${waited}ms`,
  );
});

// ---------------------------------------------------------------------------
// search-artist
// ---------------------------------------------------------------------------

Deno.test("search-artist: happy path — GET /ws/2/artist/, writes {artists,count,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const artists = [{ id: "00000000-0000-0000-0000-000000000001", name: "A" }];
  await withMbFixture({ artists, count: 1 }, async (calls) => {
    await drainAndAwait(
      time,
      run("search-artist", { query: "fixture", limit: 5, offset: 2 }, ctx),
    );
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/ws/2/artist/");
    assertEquals(url.searchParams.get("query"), "fixture");
    assertEquals(url.searchParams.get("limit"), "5");
    assertEquals(url.searchParams.get("offset"), "2");
    assertEquals(url.searchParams.get("fmt"), "json");
    assertEquals(calls[0].headers.get("Accept"), "application/json");
    assertEquals(calls[0].headers.get("User-Agent"), GLOBAL_ARGS.userAgent);
  });
  const res = written.find((w) => w.name === "search-artist")!;
  assertEquals(res.payload.artists, artists);
  assertEquals(res.payload.count, 1);
  assertEquals(typeof res.payload.timestamp, "string");
});

Deno.test("search-artist: failure path — non-ok throws with status + body slice", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "server exploded",
    () =>
      drainAndAwait(
        time,
        assertRejects(
          () => run("search-artist", { query: "x" }, ctx),
          Error,
          "500",
        ),
      ),
    500,
  );
});

// ---------------------------------------------------------------------------
// search-artists-batch — single-invocation internal loop over
// searchArtistsOnce, so the module-level rate-limit queue that is already
// correct within one invocation becomes correct for the whole workload by
// construction (this issue's fix). Spacing/failure-isolation/truncation/
// abort/backoff behaviors live in musicbrainz_adversarial_test.ts (step 6's
// six RED-phase items); this is the happy path — N distinct queries produce
// N fetches, one written artistSearchBatch row whose queries[] carries each
// query's OWN artist (via a per-query-distinct route — withMbFixture returns
// the SAME body for every request, which would let a crossed
// query-to-result mapping pass vacuously).
// ---------------------------------------------------------------------------

Deno.test("search-artists-batch: happy path — N distinct queries produce N fetches, writes artistSearchBatch with each query's OWN projected artist, echoing the caller's batchId", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const QUERIES = ['artist:"Fixture Aurora"', 'artist:"Fixture Nightfall"'];
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      const q = new URL(req.url).searchParams.get("query")!;
      const idx = QUERIES.indexOf(q);
      return json({
        artists: [{
          id: `00000000-0000-0000-0000-00000000000${idx + 1}`,
          name: q,
          "sort-name": q,
          disambiguation: "must be dropped by the projection",
        }],
        count: 1,
      });
    }],
    async (calls) => {
      await drainAndAwait(
        time,
        run("search-artists-batch", {
          queries: QUERIES,
          batchId: "batch-fixture-1",
          minIntervalMs: 5,
          // Explicit and generous: this file's module-level rate-limit
          // queue carries accumulated "virtual debt" from every earlier
          // FakeTime-driven test (see the RATE LIMITER section's header
          // comment), which the tiny DERIVED default at minIntervalMs=5
          // could otherwise trip as a false max-duration stop. This test is
          // about the happy-path SHAPE, not the duration ceiling.
          maxDurationMs: 600_000,
        }, ctx),
      );
      assertEquals(
        calls.filter(isMbHost).length,
        2,
        "one fetch per distinct query",
      );
    },
  );
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  assertEquals(res.name, "artist-search-batch");
  assertEquals(res.payload.batchId, "batch-fixture-1");
  const rows = res.payload.queries as Array<
    { query: string; artists: Array<{ id: string; name: string }> }
  >;
  assertEquals(rows.length, 2);
  for (const q of QUERIES) {
    const row = rows.find((r) => r.query === q)!;
    assert(row, `must carry a row for ${q}`);
    assertEquals(
      row.artists[0].name,
      q,
      "each query's OWN artist must come back, not a shared/crossed one",
    );
    assertEquals(
      Object.keys(row.artists[0]).sort(),
      ["id", "name", "sort-name"],
      "projected shape only — sort-name kept (it was present), disambiguation/other MusicBrainz fields dropped",
    );
  }
  assertEquals(res.payload.requested, 2);
  assertEquals(res.payload.searched, 2);
  assertEquals(res.payload.failed, 0);
  assertEquals(res.payload.deferred, []);
  assertEquals(res.payload.truncated, false);
  assertEquals(res.payload.stopReason, "complete");
  assertEquals(typeof res.payload.timestamp, "string");
});

Deno.test("search-artists-batch: batchId is generated when the caller omits it", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { artists: [], count: 0 },
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
  assertEquals(typeof res.payload.batchId, "string");
  assert((res.payload.batchId as string).length > 0);
});

Deno.test("search-artists-batch: duplicate queries are deduped — one fetch and one queries[] row per DISTINCT query, not per input entry", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  let fetchCount = 0;
  await withFetchStub(
    [(req) => {
      if (!isMbHost(req)) return undefined;
      fetchCount++;
      return json({ artists: [], count: 0 });
    }],
    () =>
      drainAndAwait(
        time,
        run("search-artists-batch", {
          queries: [
            'artist:"Fixture Dup"',
            'artist:"Fixture Dup"',
            'artist:"Fixture Other"',
          ],
          minIntervalMs: 5,
          maxDurationMs: 600_000,
        }, ctx),
      ),
  );
  assertEquals(fetchCount, 2, "deduped to 2 distinct queries");
  const res = written.find((w) => w.spec === "artistSearchBatch")!;
  assertEquals((res.payload.queries as unknown[]).length, 2);
  assertEquals(res.payload.requested, 2);
});

// ---------------------------------------------------------------------------
// search-release-group
// ---------------------------------------------------------------------------

Deno.test("search-release-group: happy path — GET /ws/2/release-group/, writes {releaseGroups,count,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const rgs = [{ id: "00000000-0000-0000-0000-000000000101", title: "R" }];
  await withMbFixture({ "release-groups": rgs, count: 1 }, async (calls) => {
    await drainAndAwait(
      time,
      run("search-release-group", { query: "fixture" }, ctx),
    );
    assertEquals(new URL(calls[0].url).pathname, "/ws/2/release-group/");
  });
  const res = written.find((w) => w.spec === "releaseGroups")!;
  assertEquals(res.payload.releaseGroups, rgs);
  assertEquals(res.payload.count, 1);
});

Deno.test("search-release-group: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "boom",
    () =>
      drainAndAwait(
        time,
        assertRejects(
          () => run("search-release-group", { query: "x" }, ctx),
          Error,
          "503",
        ),
      ),
    503,
  );
});

// ---------------------------------------------------------------------------
// search-release
// ---------------------------------------------------------------------------

Deno.test("search-release: happy path — GET /ws/2/release/, writes {releases,count,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const releases = [{ id: "00000000-0000-0000-0000-000000000201", title: "R" }];
  await withMbFixture({ releases, count: 1 }, async (calls) => {
    await drainAndAwait(time, run("search-release", { query: "fixture" }, ctx));
    assertEquals(new URL(calls[0].url).pathname, "/ws/2/release/");
  });
  const res = written.find((w) => w.spec === "releases")!;
  assertEquals(res.payload.releases, releases);
});

Deno.test("search-release: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("search-release", { query: "x" }, ctx)),
      ),
    404,
  );
});

// ---------------------------------------------------------------------------
// search-recording
// ---------------------------------------------------------------------------

Deno.test("search-recording: happy path — GET /ws/2/recording/, writes {recordings,count,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const recordings = [{
    id: "00000000-0000-0000-0000-000000000301",
    title: "T",
  }];
  await withMbFixture({ recordings, count: 1 }, async (calls) => {
    await drainAndAwait(
      time,
      run("search-recording", { query: "fixture" }, ctx),
    );
    assertEquals(new URL(calls[0].url).pathname, "/ws/2/recording/");
  });
  const res = written.find((w) => w.spec === "recordings")!;
  assertEquals(res.payload.recordings, recordings);
});

Deno.test("search-recording: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("search-recording", { query: "x" }, ctx)),
      ),
    500,
  );
});

// ---------------------------------------------------------------------------
// search-label
// ---------------------------------------------------------------------------

Deno.test("search-label: happy path — GET /ws/2/label/, writes {labels,count,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const labels = [{ id: "00000000-0000-0000-0000-000000000401", name: "L" }];
  await withMbFixture({ labels, count: 1 }, async (calls) => {
    await drainAndAwait(time, run("search-label", { query: "fixture" }, ctx));
    assertEquals(new URL(calls[0].url).pathname, "/ws/2/label/");
  });
  const res = written.find((w) => w.spec === "labels")!;
  assertEquals(res.payload.labels, labels);
});

Deno.test("search-label: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("search-label", { query: "x" }, ctx)),
      ),
    500,
  );
});

// ---------------------------------------------------------------------------
// INSTANCE NAME pins (musicbrainz-search-resource-collision) — each typed
// search method writes its OWN resource instance now (named for itself),
// never the shared "search" instance all five collided on before this fix.
// Four of these five had NO instance-name assertion at all before this
// change — a single-site revert of exactly one call site back to the
// literal "search" was invisible to every existing test in this file, since
// each test above only ever selected its write by SPEC. Selection here is
// on the INSTANCE NAME, which stays unique per method even once
// search-artist ALSO writes a deprecated alias under the same spec
// "artists" (see the DEPRECATION ALIAS pin below) — selecting by spec alone
// would become order-dependent at that point.
// ---------------------------------------------------------------------------

const INSTANCE_NAME_PINS: Array<
  [method: string, wireKey: string, spec: string]
> = [
  ["search-artist", "artists", "artists"],
  ["search-release-group", "release-groups", "releaseGroups"],
  ["search-release", "releases", "releases"],
  ["search-recording", "recordings", "recordings"],
  ["search-label", "labels", "labels"],
];

for (const [method, wireKey, spec] of INSTANCE_NAME_PINS) {
  Deno.test(`${method}: writes instance "${method}" under spec "${spec}"`, async () => {
    using time = new FakeTime();
    const { ctx, written } = makeCtx();
    await withMbFixture(
      { [wireKey]: [], count: 0 },
      () => drainAndAwait(time, run(method, { query: "x" }, ctx)),
    );
    const res = written.find((w) => w.name === method);
    assert(
      res,
      `${method} must write to an instance literally named "${method}"`,
    );
    assertEquals(res!.spec, spec);
  });
}

// ---------------------------------------------------------------------------
// DEPRECATION ALIAS pin (musicbrainz-search-resource-collision) —
// search-artist ALSO writes the historical "search" instance (spec
// "artists"), marked deprecated/supersededBy, for the time-bounded
// migration window (removed no earlier than 2026-09-07, see
// README.md/CHANGELOG.md). Two parts, because part (ii) is unobservable
// without part (i): this file's writeResource stub records the payload
// VERBATIM, before any schema runs (musicbrainz_adversarial_test.ts:1372
// pins that directly), so only running the alias payload through the
// resource's OWN declared schema (part ii) can see a change to the two
// additive `artists` schema fields — zod strips unknown keys on `.parse()`
// by default. Pattern copied from the cast form already used at
// musicbrainz_coverage_test.ts:831-834.
// ---------------------------------------------------------------------------

Deno.test("search-artist: ALSO writes the deprecated 'search' alias (spec artists) with deprecated/supersededBy markers; the canonical write carries neither", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const artists = [{ id: "00000000-0000-0000-0000-000000000001", name: "A" }];
  await withMbFixture(
    { artists, count: 1 },
    () => drainAndAwait(time, run("search-artist", { query: "x" }, ctx)),
  );

  const canonical = written.find((w) => w.name === "search-artist")!;
  assert(canonical, "the canonical write must exist");
  assertEquals(
    canonical.payload.deprecated,
    undefined,
    "the canonical search-artist row must never carry the deprecated marker",
  );
  assertEquals(canonical.payload.supersededBy, undefined);

  const aliasWrite = written.find((w) => w.name === "search")!;
  assert(
    aliasWrite,
    "search-artist must ALSO write the deprecated 'search' alias",
  );
  assertEquals(aliasWrite.spec, "artists");
  assertEquals(aliasWrite.payload.deprecated, true);
  assertEquals(aliasWrite.payload.supersededBy, "search-artist");
  assertEquals(aliasWrite.payload.artists, artists);

  // (ii) Assert on the SCHEMA-PARSED payload, not just the raw recorded
  // one — this is the ONLY assertion in the suite that would notice the two
  // additive `artists` schema fields being deleted.
  const parsed = (model.resources as Record<
    string,
    { schema: { parse: (v: unknown) => unknown } }
  >).artists.schema.parse(aliasWrite.payload) as Record<string, unknown>;
  assert(
    "deprecated" in parsed && "supersededBy" in parsed,
    "the artists resource schema must declare deprecated/supersededBy — they silently vanished on parse",
  );
  assertEquals(parsed.deprecated, true);
  assertEquals(parsed.supersededBy, "search-artist");
});

// ---------------------------------------------------------------------------
// lookup-artist / lookup-release-group / lookup-release / lookup-recording /
// lookup-label
// ---------------------------------------------------------------------------

Deno.test("lookup-artist: happy path — GET /ws/2/artist/{id}?inc=..., writes {entity:'artist',data,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const data = { id: "00000000-0000-0000-0000-000000000001", name: "A" };
  await withMbFixture(data, async (calls) => {
    await drainAndAwait(
      time,
      run("lookup-artist", {
        id: "00000000-0000-0000-0000-000000000001",
        inc: "releases+tags",
      }, ctx),
    );
    const url = new URL(calls[0].url);
    assertEquals(
      url.pathname,
      "/ws/2/artist/00000000-0000-0000-0000-000000000001",
    );
    assertEquals(url.searchParams.get("inc"), "releases+tags");
  });
  const res = written.find((w) => w.spec === "entity")!;
  assertEquals(res.name, "artist-00000000-0000-0000-0000-000000000001");
  assertEquals(res.payload.entity, "artist");
  assertEquals(res.payload.data, data);
});

Deno.test("lookup-artist: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "gone",
    () =>
      drainAndAwait(
        time,
        assertRejects(
          () => run("lookup-artist", { id: "x" }, ctx),
          Error,
          "404",
        ),
      ),
    404,
  );
});

Deno.test("lookup-release-group: happy path — GET /ws/2/release-group/{id}, writes {entity:'release-group',data,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const data = { id: "00000000-0000-0000-0000-000000000101", title: "R" };
  await withMbFixture(data, async (calls) => {
    await drainAndAwait(
      time,
      run("lookup-release-group", {
        id: "00000000-0000-0000-0000-000000000101",
      }, ctx),
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/ws/2/release-group/00000000-0000-0000-0000-000000000101",
    );
  });
  const res = written.find((w) => w.spec === "entity")!;
  assertEquals(res.name, "rg-00000000-0000-0000-0000-000000000101");
  assertEquals(res.payload.entity, "release-group");
});

Deno.test("lookup-release-group: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("lookup-release-group", { id: "x" }, ctx)),
      ),
    500,
  );
});

Deno.test("lookup-release: happy path — GET /ws/2/release/{id}, writes {entity:'release',data,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const data = { id: "00000000-0000-0000-0000-000000000201", title: "R" };
  await withMbFixture(data, async (calls) => {
    await drainAndAwait(
      time,
      run("lookup-release", {
        id: "00000000-0000-0000-0000-000000000201",
        inc: "recordings+artist-credits+labels",
      }, ctx),
    );
    const url = new URL(calls[0].url);
    assertEquals(
      url.pathname,
      "/ws/2/release/00000000-0000-0000-0000-000000000201",
    );
    assertEquals(
      url.searchParams.get("inc"),
      "recordings+artist-credits+labels",
    );
  });
  const res = written.find((w) => w.spec === "entity")!;
  assertEquals(res.name, "release-00000000-0000-0000-0000-000000000201");
  assertEquals(res.payload.entity, "release");
});

Deno.test("lookup-release: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("lookup-release", { id: "x" }, ctx)),
      ),
    500,
  );
});

Deno.test("lookup-recording: happy path — GET /ws/2/recording/{id}, writes {entity:'recording',data,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const data = { id: "00000000-0000-0000-0000-000000000301", title: "T" };
  await withMbFixture(data, async (calls) => {
    await drainAndAwait(
      time,
      run("lookup-recording", {
        id: "00000000-0000-0000-0000-000000000301",
      }, ctx),
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/ws/2/recording/00000000-0000-0000-0000-000000000301",
    );
  });
  const res = written.find((w) => w.spec === "entity")!;
  assertEquals(res.name, "recording-00000000-0000-0000-0000-000000000301");
  assertEquals(res.payload.entity, "recording");
});

Deno.test("lookup-recording: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("lookup-recording", { id: "x" }, ctx)),
      ),
    500,
  );
});

Deno.test("lookup-label: happy path — GET /ws/2/label/{id}, writes {entity:'label',data,timestamp}", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const data = { id: "00000000-0000-0000-0000-000000000401", name: "L" };
  await withMbFixture(data, async (calls) => {
    await drainAndAwait(
      time,
      run("lookup-label", {
        id: "00000000-0000-0000-0000-000000000401",
      }, ctx),
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/ws/2/label/00000000-0000-0000-0000-000000000401",
    );
  });
  const res = written.find((w) => w.spec === "entity")!;
  assertEquals(res.name, "label-00000000-0000-0000-0000-000000000401");
  assertEquals(res.payload.entity, "label");
});

Deno.test("lookup-label: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("lookup-label", { id: "x" }, ctx)),
      ),
    500,
  );
});

// ---------------------------------------------------------------------------
// browse-release-groups / browse-releases / browse-recordings
// ---------------------------------------------------------------------------

Deno.test("browse-release-groups: happy path — GET /ws/2/release-group/?artist=..., writes {results,count,offset} from release-group-* keys", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const rgs = [{ id: "00000000-0000-0000-0000-000000000101", title: "R" }];
  await withMbFixture(
    {
      "release-groups": rgs,
      "release-group-count": 1,
      "release-group-offset": 0,
    },
    async (calls) => {
      await drainAndAwait(
        time,
        run("browse-release-groups", {
          artist: "00000000-0000-0000-0000-000000000001",
          type: "album",
          limit: 10,
          offset: 0,
        }, ctx),
      );
      const url = new URL(calls[0].url);
      assertEquals(url.pathname, "/ws/2/release-group/");
      assertEquals(
        url.searchParams.get("artist"),
        "00000000-0000-0000-0000-000000000001",
      );
      assertEquals(url.searchParams.get("type"), "album");
    },
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(res.name, "rg-by-artist-00000000-0000-0000-0000-000000000001");
  assertEquals(res.payload.entity, "release-group");
  assertEquals(res.payload.linkedEntity, "artist");
  assertEquals(res.payload.results, rgs);
  assertEquals(res.payload.count, 1);
});

Deno.test("browse-release-groups: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(
          () => run("browse-release-groups", { artist: "x" }, ctx),
        ),
      ),
    500,
  );
});

Deno.test("browse-releases: happy path (by label) — GET /ws/2/release/?label=..., writes {results,count,offset} from release-* keys, linkedEntity='label'", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const releases = [{ id: "00000000-0000-0000-0000-000000000201", title: "R" }];
  await withMbFixture(
    { releases, "release-count": 1, "release-offset": 0 },
    async (calls) => {
      await drainAndAwait(
        time,
        run("browse-releases", {
          label: "00000000-0000-0000-0000-000000000401",
        }, ctx),
      );
      const url = new URL(calls[0].url);
      assertEquals(
        url.searchParams.get("label"),
        "00000000-0000-0000-0000-000000000401",
      );
    },
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(
    res.name,
    "releases-by-label-00000000-0000-0000-0000-000000000401",
  );
  assertEquals(res.payload.linkedEntity, "label");
  assertEquals(res.payload.results, releases);
});

Deno.test("browse-releases: happy path (by release-group) — 'release-group' query param, linkedEntity='release-group'", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withMbFixture(
    { releases: [], "release-count": 0, "release-offset": 0 },
    async (calls) => {
      await drainAndAwait(
        time,
        run("browse-releases", {
          releaseGroup: "00000000-0000-0000-0000-000000000101",
        }, ctx),
      );
      assertEquals(
        new URL(calls[0].url).searchParams.get("release-group"),
        "00000000-0000-0000-0000-000000000101",
      );
    },
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(
    res.name,
    "releases-by-release-group-00000000-0000-0000-0000-000000000101",
  );
});

Deno.test("browse-releases: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("browse-releases", { artist: "x" }, ctx)),
      ),
    500,
  );
});

Deno.test("browse-recordings: happy path (by release) — GET /ws/2/recording/?release=..., writes {results,count,offset}, linkedEntity='release'", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const recordings = [{ id: "00000000-0000-0000-0000-000000000301" }];
  await withMbFixture(
    { recordings, "recording-count": 1, "recording-offset": 0 },
    async (calls) => {
      await drainAndAwait(
        time,
        run("browse-recordings", {
          release: "00000000-0000-0000-0000-000000000201",
        }, ctx),
      );
      const url = new URL(calls[0].url);
      assertEquals(url.pathname, "/ws/2/recording/");
      assertEquals(
        url.searchParams.get("release"),
        "00000000-0000-0000-0000-000000000201",
      );
    },
  );
  const res = written.find((w) => w.spec === "browse")!;
  assertEquals(
    res.name,
    "recordings-by-release-00000000-0000-0000-0000-000000000201",
  );
  assertEquals(res.payload.results, recordings);
});

Deno.test("browse-recordings: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("browse-recordings", { artist: "x" }, ctx)),
      ),
    500,
  );
});

// ---------------------------------------------------------------------------
// search (generic entity search)
// ---------------------------------------------------------------------------

Deno.test("search: happy path (entity=area) — GET /ws/2/area/, picks the single non-{count,offset,created} key as resultsKey", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  const areas = [{ id: "00000000-0000-0000-0000-000000000501", name: "Z" }];
  await withMbFixture(
    { created: "2026-01-01T00:00:00.000Z", count: 1, offset: 0, areas },
    async (calls) => {
      await drainAndAwait(
        time,
        run("search", { entity: "area", query: "z" }, ctx),
      );
      assertEquals(new URL(calls[0].url).pathname, "/ws/2/area/");
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.name, "area-search");
  assertEquals(res.payload.results, areas);
  assertEquals(res.payload.count, 1);
});

Deno.test("search: rejects an entity outside the documented enum at the schema boundary", () => {
  const method = (model.methods as MethodMap).search;
  let threw = false;
  try {
    method.arguments.parse({ entity: "not-a-real-entity", query: "x" });
  } catch {
    threw = true;
  }
  assert(threw, "an unknown entity type must be rejected before execute()");
});

Deno.test("search: failure path — non-ok throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withMbFixture(
    "err",
    () =>
      drainAndAwait(
        time,
        assertRejects(() => run("search", { entity: "work", query: "x" }, ctx)),
      ),
    500,
  );
});

// ---------------------------------------------------------------------------
// seed-from-bandcamp (no MB fetch at all — pure Bandcamp scrape + local build)
// ---------------------------------------------------------------------------

Deno.test("seed-from-bandcamp: happy path — fetches the album page, writes {artist,releases:[1],total:1}", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html(ALBUM_JSONLD_HTML) : undefined)],
    async (calls) => {
      await run("seed-from-bandcamp", {
        bandcampUrl:
          "https://fixtureaurorastatic.bandcamp.com/album/fixture-nightfall-static",
        artistMbid: "00000000-0000-0000-0000-000000000001",
      }, ctx);
      assertEquals(calls.length, 1, "no rate limiter — Bandcamp is not MB");
    },
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.name, "seed-single");
  assertEquals(res.payload.artist, "Fixture Aurora Static");
  assertEquals(res.payload.artistMbid, "00000000-0000-0000-0000-000000000001");
  assertEquals(res.payload.total, 1);
  const release = (res.payload.releases as Array<Record<string, unknown>>)[0];
  assertEquals(release.status, "ready");
  assertEquals(release.trackCount, 3);
});

Deno.test("seed-from-bandcamp: failure path — non-ok Bandcamp fetch throws (status only, no body slice — asymmetric with mbFetch)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html("gone", 404) : undefined)],
    async () => {
      await assertRejects(
        () =>
          run("seed-from-bandcamp", {
            bandcampUrl: "https://fixture.bandcamp.com/album/gone",
          }, ctx),
        Error,
        "404",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// find-missing / seed-all-missing — host-routed, artistMbid supplied to skip
// the artist-search MB call (isolating the pagination-walk rate-limiter
// behavior, characterized separately below)
// ---------------------------------------------------------------------------

Deno.test("find-missing: happy path — matches by normalized title, reports the rest missing with seed URLs", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(ARTIST_MUSICGRID_HTML) : undefined),
      (req) =>
        isMbHost(req)
          ? json({
            "release-groups": [
              {
                id: "00000000-0000-0000-0000-000000000601",
                title: "Fixture Drift Sessions",
              },
            ],
            "release-group-count": 1,
            "release-group-offset": 0,
          })
          : undefined,
    ],
    (calls) =>
      drainAndAwait(
        time,
        run("find-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
          artistMbid: "00000000-0000-0000-0000-000000000001",
        }, ctx).then(() => {
          assertEquals(
            calls.filter(isBcHost).length,
            2,
            "1 discography-page fetch + 1 album-page fetch for the missing item",
          );
        }),
      ),
  );
  const res = written.find((w) => w.spec === "missingReleases")!;
  assertEquals(res.name, "00000000-0000-0000-0000-000000000001");
  assertEquals(res.payload.mbReleaseCount, 1);
  assertEquals(res.payload.bcReleaseCount, 2);
  const matched = res.payload.matched as Array<Record<string, unknown>>;
  const missing = res.payload.missing as Array<Record<string, unknown>>;
  assertEquals(matched.length, 1);
  assertEquals(matched[0].bcTitle, "Fixture Drift Sessions");
  assertEquals(missing.length, 1);
  assertEquals(missing[0].title, "Fixture Single Echo");
  assert(
    (missing[0].seedUrl as string).startsWith(
      "https://musicbrainz.org/release/add?",
    ),
  );
});

Deno.test("find-missing: failure path — a non-ok Bandcamp discography fetch throws", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => (isBcHost(req) ? html("nope", 500) : undefined)],
    () =>
      drainAndAwait(
        time,
        assertRejects(
          () =>
            run("find-missing", {
              bandcampUrl: "https://fixture.bandcamp.com",
              artistMbid: "00000000-0000-0000-0000-000000000001",
            }, ctx),
        ),
      ),
  );
});

Deno.test("seed-all-missing: happy path — writes seed URLs for every UNMATCHED bandcamp release only", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(ARTIST_MUSICGRID_HTML) : undefined),
      (req) =>
        isMbHost(req)
          ? json({
            "release-groups": [
              {
                id: "00000000-0000-0000-0000-000000000601",
                title: "Fixture Single Echo",
              },
            ],
            "release-group-count": 1,
            "release-group-offset": 0,
          })
          : undefined,
    ],
    () =>
      drainAndAwait(
        time,
        run("seed-all-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
          artistMbid: "00000000-0000-0000-0000-000000000001",
        }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.name, "00000000-0000-0000-0000-000000000001");
  assertEquals(res.payload.total, 1);
  const releases = res.payload.releases as Array<Record<string, unknown>>;
  assertEquals(releases[0].title, "Fixture Drift Sessions");
});

Deno.test("seed-all-missing: no artistMbid AND unresolvable artist name — MB call is SKIPPED entirely, every bandcamp release is 'missing'", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) => (isBcHost(req) ? html(ARTIST_MUSICGRID_HTML) : undefined),
      (req) =>
        isMbHost(req)
          ? json({ artists: [] }) // no exact match -> artistMbid stays undefined
          : undefined,
    ],
    (calls) =>
      drainAndAwait(
        time,
        run("seed-all-missing", {
          bandcampUrl: "https://fixturemarinholloway.bandcamp.com",
        }, ctx).then(() => {
          assertEquals(
            calls.filter(isMbHost).length,
            1,
            "only the artist-search call — no release-group browse once artistMbid is unresolved",
          );
        }),
      ),
  );
  const res = written.find((w) => w.spec === "seedUrls")!;
  assertEquals(res.payload.artistMbid, undefined);
  assertEquals(res.payload.total, 2, "both discography entries are 'missing'");
});

// ---------------------------------------------------------------------------
// sync-artist-discographies — execute() paths (musicbrainz-discography-sync,
// ported from an older untested copy of this model). The maxPages/truncated
// pagination guard lives in musicbrainz_coverage_test.ts (new-surface
// enumeration); the stale-cache/count:0 skip-vs-refetch failure modes live
// in musicbrainz_adversarial_test.ts; the pure classifyDiscographyCache/
// isCacheStale/advanceSyncCursor/rateLimitDelayMs/retryAfterBackoffMs
// invariants everything here is built on live in
// musicbrainz_property_test.ts.
// ---------------------------------------------------------------------------

type SyncStore = Map<string, Record<string, unknown>>;

/** Stub context for sync-artist-discographies: `readResource` is a real
 * in-memory map (keyed on instance name only, matching the runtime
 * contract) so a method run can read back an earlier run's writes — needed
 * for cursor-resume and search-artist-fallback tests below, unlike every
 * other harness in this file. */
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

const SYNC_TEST_MBIDS = [
  "aaaaaaaa-0000-4000-8000-000000000001",
  "aaaaaaaa-0000-4000-8000-000000000002",
  "aaaaaaaa-0000-4000-8000-000000000003",
];

/** Generates `n` synthetic hexspeak-form MBIDs, disjoint across tests via
 * `offset` — never a real MusicBrainz MBID, per both PROVENANCE.md files'
 * standing prohibition on live capture. */
function syntheticMbids(n: number, offset = 0): string[] {
  return Array.from(
    { length: n },
    (_, i) =>
      `aaaaaaaa-0000-4000-8000-${String(offset + i + 1).padStart(12, "0")}`,
  );
}

Deno.test("sync-artist-discographies: happy path — explicit artistMbids caches each artist's discography via the browse/rg-by-artist-<mbid> path and records them processed", async () => {
  using time = new FakeTime();
  const { written, ctx } = makeSyncCtx();
  await withMbFixture(
    { "release-groups": [{ id: "rg-1", title: "Fixture Album" }] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: SYNC_TEST_MBIDS,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  for (const mbid of SYNC_TEST_MBIDS) {
    const cached = written.find((w) => w.name === `rg-by-artist-${mbid}`);
    assert(cached, `rg-by-artist-${mbid} must have been cached`);
    assertEquals(cached.spec, "browse");
    assertEquals(cached.payload.truncated, false);
    assertEquals(
      (cached.payload.results as unknown[])[0],
      { id: "rg-1", title: "Fixture Album" },
    );
  }
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.processed, SYNC_TEST_MBIDS);
  assertEquals(state.payload.skipped, []);
  assertEquals(
    (state.payload.cursor as { offset: number }).offset,
    SYNC_TEST_MBIDS.length,
  );
});

Deno.test("sync-artist-discographies: a POPULATED search-artist resource is NOT consulted — with no artistMbids arg the run rejects rather than silently syncing whatever 'search-artist' holds", async () => {
  const store: SyncStore = new Map();
  store.set("search-artist", {
    artists: [
      { id: SYNC_TEST_MBIDS[0], name: "Fixture Artist One" },
      { id: SYNC_TEST_MBIDS[1], name: "Fixture Artist Two" },
    ],
    count: 2,
    timestamp: new Date().toISOString(),
  });
  const { written, ctx } = makeSyncCtx(store);
  await assertRejects(
    () => run("sync-artist-discographies", { minIntervalMs: 5 }, ctx),
    Error,
    "was given no artistMbids",
  );
  assertEquals(
    written.find((w) => w.spec === "discographySyncState"),
    undefined,
    "a rejected run with a populated 'search-artist' resource must not have synced anything, and must not have written state",
  );
});

Deno.test("sync-artist-discographies: no explicit artistMbids at all — throws an actionable error naming the full runnable --input command via context.definition.name, never suggesting search-artist or --query as the fix", async () => {
  const { ctx } = makeSyncCtx(new Map(), "my-musicbrainz-instance");
  const err = await assertRejects(
    () => run("sync-artist-discographies", {}, ctx),
    Error,
  );
  assert(
    err.message.includes("my-musicbrainz-instance"),
    "the error must name the actual instance, not a placeholder",
  );
  assert(
    err.message.includes(
      "swamp model method run my-musicbrainz-instance sync-artist-discographies --input 'artistMbids:json=",
    ),
    "the error must give the exact runnable command, including the --input flag form, to unblock the user",
  );
  assert(
    // Broadened past the instance-qualified literal: a mutant that
    // suggests running search-artist against a DIFFERENT, hardcoded
    // instance name (not context.definition.name) must still be caught.
    // The negative lookahead excludes "search-artists-batch", a real,
    // valid method whose name merely starts with the same substring.
    !/swamp model method run \S+ search-artist(?!s)/.test(err.message),
    "the error must no longer suggest running search-artist as the fix — the mention of the deleted fallback in the historical-context sentence is fine, a suggested search-artist COMMAND (against any instance name) is not",
  );
  assert(
    // No trailing space: "--query " alone would miss a mutant that writes
    // "--query=..." instead of "--query ...".
    !err.message.includes("--query"),
    "the error must not use the unrunnable --query flag form",
  );
  assert(
    err.message.includes("Before 2026.08.05.2"),
    "the error must say 'Before', not 'Until', naming the version that removed the fallback",
  );
});

Deno.test("sync-artist-discographies: resuming from a persisted cursor across two runs covers a 5-artist list exactly once — no gap, no overlap", async () => {
  using time = new FakeTime();
  const fiveMbids = [
    ...SYNC_TEST_MBIDS,
    "aaaaaaaa-0000-4000-8000-000000000004",
    "aaaaaaaa-0000-4000-8000-000000000005",
  ];
  const store: SyncStore = new Map();
  const { written, ctx } = makeSyncCtx(store);

  // First run: batchSize 3 processes the first 3 artists and persists a
  // cursor at offset 3.
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: fiveMbids,
          batchSize: 3,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const stateAfterFirst = written.find((w) =>
    w.spec === "discographySyncState"
  )!;
  assertEquals(stateAfterFirst.payload.processed, fiveMbids.slice(0, 3));
  assertEquals(
    (stateAfterFirst.payload.cursor as { offset: number }).offset,
    3,
  );

  // Second run: resumes from the persisted cursor (offset 3) rather than
  // restarting at 0, covering exactly the remaining 2 artists.
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: fiveMbids,
          batchSize: 3,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const stateAfterSecond = written.filter((w) =>
    w.spec === "discographySyncState"
  ).at(-1)!;
  assertEquals(stateAfterSecond.payload.processed, fiveMbids.slice(3, 5));
  assertEquals(
    (stateAfterSecond.payload.cursor as { offset: number }).offset,
    5,
    "the cursor lands exactly at the end of the 5-artist input",
  );

  const allProcessed = [
    ...(stateAfterFirst.payload.processed as string[]),
    ...(stateAfterSecond.payload.processed as string[]),
  ];
  assertEquals(
    allProcessed,
    fiveMbids,
    "the two runs together cover the input exactly once, no gap, no overlap",
  );
});

// ---------------------------------------------------------------------------
// Cursor keying — `discographySyncState` is a resumable cursor with identity:
// it must identify the list it indexes (fingerprint + persisted distinct
// count), not just an offset into an unnamed list. All four cases below
// share the shape: pre-seed "discography-sync-cursor" directly in the store,
// then run and inspect `startOffset` on the freshly-written state.
// ---------------------------------------------------------------------------

Deno.test("sync-artist-discographies: cursor keying — a persisted state with NO listFingerprint at all (the pre-this-change shape) always restarts at offset 0, never resumes", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(4, 300);
  const store: SyncStore = new Map();
  store.set("discography-sync-cursor", {
    cursor: { offset: 2 },
    processed: [mbids[0]],
    skipped: [mbids[1]],
    updatedAt: new Date().toISOString(),
    // no listFingerprint at all — the live pre-this-change shape
  });
  const { written, ctx } = makeSyncCtx(store);
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(
    state.payload.startOffset,
    0,
    "a state with no fingerprint at all must never be resumed from — it always restarts at 0",
  );
});

Deno.test("sync-artist-discographies: cursor keying — a persisted listFingerprint that does not match this run's list restarts at offset 0", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(4, 310);
  const otherMbids = syntheticMbids(4, 400);
  const store: SyncStore = new Map();
  store.set("discography-sync-cursor", {
    cursor: { offset: 2 },
    processed: [],
    skipped: [],
    updatedAt: new Date().toISOString(),
    listFingerprint: fingerprintMbids(otherMbids),
    requested: otherMbids.length,
  });
  const { written, ctx } = makeSyncCtx(store);
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(
    state.payload.startOffset,
    0,
    "a fingerprint mismatch must never be resumed from",
  );
});

Deno.test("sync-artist-discographies: cursor keying — a matching fingerprint with a persisted requested count that differs from this run's deduped length restarts at offset 0 (the list grew or shrank)", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(6, 320);
  const store: SyncStore = new Map();
  store.set("discography-sync-cursor", {
    cursor: { offset: 3 },
    processed: [],
    skipped: [],
    updatedAt: new Date().toISOString(),
    // Fingerprint matches BY CONSTRUCTION (same helper, same list) — but
    // `requested` is stale, as if the list grew since this state was
    // written. A 32-bit digest alone cannot promise collision-freedom
    // across different-length inputs at ~2^-32; the persisted-count
    // comparison is what makes growth detection exact.
    listFingerprint: fingerprintMbids(mbids),
    requested: mbids.length - 1,
  });
  const { written, ctx } = makeSyncCtx(store);
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(
    state.payload.startOffset,
    0,
    "a persisted requested count that disagrees with this run's deduped length must never be resumed from, even with a matching fingerprint",
  );
});

Deno.test("sync-artist-discographies: cursor keying — same fingerprint AND same requested count resumes from the persisted non-zero offset", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(6, 330);
  const store: SyncStore = new Map();
  store.set("discography-sync-cursor", {
    cursor: { offset: 3 },
    processed: mbids.slice(0, 3),
    skipped: [],
    updatedAt: new Date().toISOString(),
    listFingerprint: fingerprintMbids(mbids),
    requested: mbids.length,
  });
  const { written, ctx } = makeSyncCtx(store);
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(
    state.payload.startOffset,
    3,
    "a matching fingerprint and requested count must resume from the persisted offset, not restart at 0",
  );
  assertEquals(
    state.payload.processed,
    mbids.slice(3),
    "resuming must process exactly the remainder, not re-process the first 3",
  );
});

// ---------------------------------------------------------------------------
// batchSize default — must cover the WHOLE deduped list, not the old 10.
// ---------------------------------------------------------------------------

Deno.test("sync-artist-discographies: with no batchSize argument, processes the WHOLE deduped list (12 synthetic MBIDs), not the old default of 10", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(12, 340);
  const { written, ctx } = makeSyncCtx();
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(
    (state.payload.processed as string[]).length,
    12,
    "batchSize must default to the whole 12-artist deduped list, not 10",
  );
  assertEquals((state.payload.cursor as { offset: number }).offset, 12);
});

// ---------------------------------------------------------------------------
// Coverage accounting — THE DIRECT PIN FOR THE CRITICAL. covered =
// processedCount + skippedCount; remaining = requested - covered. The
// rejected `requested - cursor.offset` formula is algebraically identical to
// the defect this issue was filed about and must NOT be what these numbers
// equal.
// ---------------------------------------------------------------------------

Deno.test("sync-artist-discographies: coverage accounting — a full pass over 12 distinct MBIDs records startOffset 0, covered 12, remaining 0", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(12, 350);
  const { written, ctx } = makeSyncCtx();
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.startOffset, 0);
  assertEquals(state.payload.covered, 12);
  assertEquals(state.payload.remaining, 0);
});

Deno.test("sync-artist-discographies: coverage accounting — THE LIVE SHAPE (775 distinct, startOffset 1, 765 processed + 9 skipped) records covered 774 and remaining 1, NOT the rejected requested-cursor.offset=0, and the cursor.offset (775) is a distinct LIST POSITION from remaining", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(775, 100_000);
  const skipMbids = mbids.slice(1, 10); // 9 fresh-cache skips within the batch
  const store: SyncStore = new Map();
  store.set("discography-sync-cursor", {
    cursor: { offset: 1 },
    processed: [],
    skipped: [],
    updatedAt: new Date().toISOString(),
    listFingerprint: fingerprintMbids(mbids),
    requested: mbids.length,
  });
  for (const mbid of skipMbids) {
    store.set(`rg-by-artist-${mbid}`, {
      entity: "release-group",
      linkedEntity: "artist",
      linkedId: mbid,
      results: [],
      count: 0,
      offset: 0,
      truncated: false,
      timestamp: new Date().toISOString(), // fresh — never stale
    });
  }
  const { written, ctx } = makeSyncCtx(store);
  let result: { dataHandles: unknown[] } | undefined;
  await withMbFixture(
    { "release-groups": [] },
    async () => {
      result = await drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          minIntervalMs: 1,
        }, ctx),
      ) as { dataHandles: unknown[] };
    },
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.startOffset, 1);
  assertEquals(
    (state.payload.processed as string[]).length +
      (state.payload.skipped as string[]).length,
    774,
    "774 artists were visited this run (765 processed + 9 skipped)",
  );
  assertEquals((state.payload.skipped as string[]).length, 9);
  assertEquals(state.payload.covered, 774);
  assertEquals(
    state.payload.remaining,
    1,
    "the rejected formula requested - cursor.offset (775 - 775) gives 0; the correct definition gives 1",
  );
  assertEquals(
    (state.payload.cursor as { offset: number }).offset,
    775,
    "the cursor (a LIST POSITION) and remaining (a RUN COVERAGE SHORTFALL) are different values on the same row",
  );

  // Pin the method's RESOLVED VALUE, not just the written store — the only
  // assertion that catches the finally-write-before-return `[undefined]`
  // bug, since the written store looks identical either way.
  assert(result, "the method must have resolved");
  assertEquals(result!.dataHandles.length, 1, "exactly one element");
  assert(
    result!.dataHandles[0] !== undefined,
    "the element must be defined, never undefined",
  );
  assertEquals(
    (result!.dataHandles[0] as { name: string }).name,
    "discography-sync-cursor",
    "the returned handle must name the discography-sync-cursor instance",
  );
});

Deno.test("sync-artist-discographies: coverage accounting — a partial run from offset 0 with batchSize 5 over 12 MBIDs records covered 5, remaining 7, cursor.offset 5", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(12, 200_000);
  const { written, ctx } = makeSyncCtx();
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          batchSize: 5,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.covered, 5);
  assertEquals(state.payload.remaining, 7);
  assertEquals((state.payload.cursor as { offset: number }).offset, 5);
});

// ---------------------------------------------------------------------------
// Dedupe — at list-resolution time, so `requested`/the cursor/the fingerprint
// all index the SAME deduped list a duplicate-bearing caller handed in once.
// ---------------------------------------------------------------------------

Deno.test("sync-artist-discographies: dedupe — a repeated MBID is fetched once, requested is the DISTINCT count, requestedRaw is the raw length, and the duplicate never appears in skipped masquerading as a cache hit", async () => {
  using time = new FakeTime();
  const base = syntheticMbids(3, 360);
  const withDupe = [base[0], base[1], base[0], base[2]]; // base[0] repeated
  const { written, ctx } = makeSyncCtx();
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: withDupe,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.requested, 3, "requested is the DISTINCT count");
  assertEquals(
    state.payload.requestedRaw,
    4,
    "requestedRaw is the raw list length, dupes included",
  );
  const processed = state.payload.processed as string[];
  const skipped = state.payload.skipped as string[];
  assertEquals(
    processed.filter((m) => m === base[0]).length,
    1,
    "the duplicated MBID was fetched exactly once",
  );
  assertEquals(
    skipped.includes(base[0]),
    false,
    "the duplicate must not appear in skipped masquerading as a cache hit",
  );
});

Deno.test("sync-artist-discographies: dedupe placement — a persisted cursor at an offset below the RAW length but at/past the DEDUPED length resets to 0 and produces a non-empty batch", async () => {
  using time = new FakeTime();
  const base = syntheticMbids(3, 370);
  const withDupe = [base[0], base[1], base[0], base[2]]; // deduped length 3, raw length 4
  const store: SyncStore = new Map();
  store.set("discography-sync-cursor", {
    cursor: { offset: 3 }, // below raw length (4), AT the deduped length (3)
    processed: [],
    skipped: [],
    updatedAt: new Date().toISOString(),
    listFingerprint: fingerprintMbids([base[0], base[1], base[2]]),
    requested: 3,
  });
  const { written, ctx } = makeSyncCtx(store);
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: withDupe,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(
    state.payload.startOffset,
    0,
    "an offset at/past the DEDUPED length must reset to 0, not produce an empty batch forever",
  );
  assertEquals(
    (state.payload.processed as string[]).length +
      (state.payload.skipped as string[]).length,
    3,
    "the reset batch must be non-empty — it covers the full 3-artist deduped list",
  );
});

// ---------------------------------------------------------------------------
// The uncovered set — computed from stored data (which MBIDs this run's
// requested list has no cached rg-by-artist row for), not from any counter.
// ---------------------------------------------------------------------------

Deno.test("sync-artist-discographies: the uncovered set — an MBID with no cached rg-by-artist row is recorded uncovered; a fully cached list has none", async () => {
  using time = new FakeTime();

  {
    const mbids = syntheticMbids(3, 380);
    const store: SyncStore = new Map();
    for (const mbid of [mbids[0], mbids[2]]) {
      store.set(`rg-by-artist-${mbid}`, {
        entity: "release-group",
        linkedEntity: "artist",
        linkedId: mbid,
        results: [],
        count: 0,
        offset: 0,
        truncated: false,
        timestamp: new Date().toISOString(),
      });
    }
    const { written, ctx } = makeSyncCtx(store);
    await withMbFixture(
      { "release-groups": [] },
      () =>
        drainAndAwait(
          time,
          run("sync-artist-discographies", {
            artistMbids: mbids,
            batchSize: 0,
            minIntervalMs: 5,
          }, ctx),
        ),
    );
    const state = written.find((w) => w.spec === "discographySyncState")!;
    assertEquals(state.payload.uncoveredCount, 1);
    assertEquals(state.payload.uncovered, [mbids[1]]);
  }

  {
    const mbids = syntheticMbids(3, 390);
    const store: SyncStore = new Map();
    for (const mbid of mbids) {
      store.set(`rg-by-artist-${mbid}`, {
        entity: "release-group",
        linkedEntity: "artist",
        linkedId: mbid,
        results: [],
        count: 0,
        offset: 0,
        truncated: false,
        timestamp: new Date().toISOString(),
      });
    }
    const { written, ctx } = makeSyncCtx(store);
    await withMbFixture(
      { "release-groups": [] },
      () =>
        drainAndAwait(
          time,
          run("sync-artist-discographies", {
            artistMbids: mbids,
            batchSize: 0,
            minIntervalMs: 5,
          }, ctx),
        ),
    );
    const state = written.find((w) => w.spec === "discographySyncState")!;
    assertEquals(state.payload.uncoveredCount, 0);
    assertEquals(state.payload.uncovered, []);
  }
});

Deno.test("sync-artist-discographies: discographySyncState's DECLARED resource schema still round-trips uncoveredCount -- pins the resource contract, not just the stub's captured payload", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(3, 420);
  const { written, ctx } = makeSyncCtx();
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          batchSize: 0,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  // Every MBID is uncovered here (empty store, no prior cache), so the
  // written payload's uncoveredCount is non-zero -- if the resource's own
  // declared schema no longer lists uncoveredCount, zod's default
  // unknown-key stripping silently drops it on parse even though the
  // method still writes it, and this assertion (not just the raw payload
  // read above) is what catches that drift.
  const parsed = model.resources.discographySyncState.schema.parse(
    state.payload,
  ) as Record<string, unknown>;
  assert(
    "uncoveredCount" in parsed,
    "the discographySyncState resource schema must declare uncoveredCount -- it silently vanished on parse",
  );
  assertEquals(parsed.uncoveredCount, state.payload.uncoveredCount);
});

Deno.test("sync-artist-discographies: the uncovered set caps the reported list at 50 while uncoveredCount holds the true total", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(60, 400);
  const { written, ctx } = makeSyncCtx();
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          batchSize: 0,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.uncoveredCount, 60);
  assertEquals((state.payload.uncovered as string[]).length, 50);
});

Deno.test("sync-artist-discographies: a full pass over the whole list records uncoveredCount 0 without any extra readResource calls for already-visited MBIDs", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(5, 410);
  const readCountsByKey = new Map<string, number>();
  const store: SyncStore = new Map();
  const { written, ctx: baseCtx } = makeSyncCtx(store);
  const ctx = {
    ...baseCtx,
    readResource: (name: string) => {
      readCountsByKey.set(name, (readCountsByKey.get(name) ?? 0) + 1);
      return Promise.resolve(store.get(name) ?? null);
    },
  };
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", {
          artistMbids: mbids,
          minIntervalMs: 5,
        }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(state.payload.uncoveredCount, 0);
  for (const mbid of mbids) {
    assertEquals(
      readCountsByKey.get(`rg-by-artist-${mbid}`),
      1,
      `${mbid} must be read exactly once — the cache check in the main loop, no extra read for the uncovered computation on a full pass`,
    );
  }
});

// ---------------------------------------------------------------------------
// A crash mid-batch still leaves a record — durability is part of the
// process-state entity's contract, not an optimisation for the happy path.
// ---------------------------------------------------------------------------

Deno.test("sync-artist-discographies: a crash mid-batch still persists an accurate cursor, covered, remaining, and uncovered — and the original error propagates", async () => {
  using time = new FakeTime();
  const mbids = syntheticMbids(5, 420);
  const { written, ctx } = makeSyncCtx();
  let callCount = 0;
  await assertRejects(
    () =>
      withFetchStub(
        [(req) => {
          if (!isMbHost(req)) return undefined;
          callCount++;
          if (callCount === 3) {
            throw new Error("simulated MusicBrainz network failure");
          }
          return json({ "release-groups": [] });
        }],
        () =>
          drainAndAwait(
            time,
            run("sync-artist-discographies", {
              artistMbids: mbids,
              minIntervalMs: 5,
            }, ctx),
          ),
      ),
    Error,
    "simulated MusicBrainz network failure",
  );
  const state = written.find((w) => w.spec === "discographySyncState");
  assert(
    state,
    "a discographySyncState must still have been written despite the crash",
  );
  const covered = state!.payload.covered as number;
  assertEquals(
    covered,
    2,
    "exactly the 2 artists fetched before the 3rd request threw",
  );
  assertEquals(
    (state!.payload.cursor as { offset: number }).offset,
    0 + covered,
    "cursor.offset == startOffset + covered, so a re-run resumes at the failed artist",
  );
  assert(
    (state!.payload.remaining as number) > 0,
    "remaining must be non-zero after a partial pass",
  );
  assert(
    (state!.payload.uncoveredCount as number) > 0,
    "the artists never visited before the throw must be recorded uncovered",
  );
});

Deno.test("sync-artist-discographies: the missing-artistMbids throw writes NO state at all", async () => {
  const { written, ctx } = makeSyncCtx();
  await assertRejects(() => run("sync-artist-discographies", {}, ctx), Error);
  assertEquals(
    written.find((w) => w.spec === "discographySyncState"),
    undefined,
    "a missing-artistMbids rejection is not a sync attempt — it must write no state whatsoever",
  );
});
