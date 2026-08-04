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
import { model } from "./musicbrainz.ts";
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
  const res = written.find((w) => w.spec === "artists")!;
  assertEquals(res.name, "search");
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

Deno.test("sync-artist-discographies: with no artistMbids arg, falls back to the artists cached by this instance's last search-artist run", async () => {
  using time = new FakeTime();
  const store: SyncStore = new Map();
  store.set("search", {
    artists: [
      { id: SYNC_TEST_MBIDS[0], name: "Fixture Artist One" },
      { id: SYNC_TEST_MBIDS[1], name: "Fixture Artist Two" },
    ],
    count: 2,
    timestamp: new Date().toISOString(),
  });
  const { written, ctx } = makeSyncCtx(store);
  await withMbFixture(
    { "release-groups": [] },
    () =>
      drainAndAwait(
        time,
        run("sync-artist-discographies", { minIntervalMs: 5 }, ctx),
      ),
  );
  const state = written.find((w) => w.spec === "discographySyncState")!;
  assertEquals(
    state.payload.processed,
    [SYNC_TEST_MBIDS[0], SYNC_TEST_MBIDS[1]],
    "fell back to the two artists cached by search-artist's own bare 'search' instance write",
  );
});

Deno.test("sync-artist-discographies: no explicit artistMbids AND no cached search-artist results — throws an actionable error naming the full command via context.definition.name", async () => {
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
      "swamp model method run my-musicbrainz-instance search-artist",
    ),
    "the error must give the exact runnable command to unblock the user",
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
