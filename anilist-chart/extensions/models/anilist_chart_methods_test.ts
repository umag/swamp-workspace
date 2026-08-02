/**
 * Method-level tests for @magistr/anilist-chart — all 3 methods (settings,
 * render, publish), happy path + error path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` (the single ClickHouse HTTP seam, lib/clickhouse.ts —
 * NOT AniList GraphQL, which lives in the sibling @magistr/anilist ingest
 * model, out of scope), a fake context, and FakeTime for deterministic
 * `now`.
 *
 * `2026.08.02.1` REAL-FIXED all 7 latent bugs tracked in the LOCAL
 * `anilist-chart-latent-bugs` issue-lifecycle model (see CHANGELOG.md). The
 * tests below that used to PIN a bug (LB1, LB4, LB6) now assert the FIXED
 * behavior instead; every other test in this file is an unchanged
 * characterization of already-shipped behavior — most notably the
 * happy-path render (11 reads / 7 artifacts) and the publish suite, both
 * byte-identical to before this change.
 *
 * publish() has TWO write branches: a LOCAL filesystem path (Deno.stat sees
 * a real directory -> Deno.writeTextFile + Deno.rename) and an SSH path
 * (Deno.Command spawn). This suite drives the LOCAL path exclusively, via a
 * REAL Deno.makeTempDir — no `Deno.Command` stub, no `as typeof Deno.Command`
 * cast (forbidden under the Deno-skew rule). The ssh branch's fault
 * semantics (one failing page never suppresses the rest) are already
 * covered by lib/publish.test.ts's injected-writer unit, which is agnostic
 * to which writer (ssh or local) is plugged in — see that file's "one page
 * failing never suppresses the rest" test.
 *
 * Context API: `writeResource(spec, name, payload)` records the call AND
 * stores `payload` in an in-memory map keyed by `name` alone (matching the
 * real runtime: `context.readResource(name)` is keyed on instance name ONLY,
 * per this repo's `reference_swamp_runmodel_context_api` lesson). This lets
 * a `render()` call's `renderedPage` artifacts be read straight back by a
 * following `publish()` call on the SAME ctx, exercising the real
 * render->publish integration in one flow.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./anilist_chart.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SENTINEL_KEY = "sntl_clickhouse_key_leak_check_do_not_log_13579";

const GLOBAL_ARGS: Record<string, unknown> = {
  clickhouseUrl: "https://ch.example.test:8443",
  clickhouseUser: "render_ro",
  clickhouseKey: SENTINEL_KEY,
  clickhouseDatabase: "default",
  userNames: ["alice", "bob", "carol"],
  topK: 13,
  bayesMinVotes: 5,
  penaltyRate: 0.05,
  nodeHost: "node.example.test",
  nodeUser: "deploy",
  outputDir: "/srv/out",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const store = new Map<string, unknown>();
  return {
    written,
    store,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        store.set(name, payload);
        return Promise.resolve({ spec, name });
      },
      readResource: (name: string) => {
        if (!store.has(name)) {
          return Promise.reject(new Error(`no resource named "${name}"`));
        }
        return Promise.resolve(store.get(name));
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// ClickHouse HTTP fetch stub — dispatches on the POST-body SQL text, since
// every one of the 11 read queries shares one endpoint/method (POST) and is
// distinguished only by its SQL. Bridge cast (never `as typeof`), mirroring
// the repo's documented no-cast idiom for stubbing a builtin.
// ---------------------------------------------------------------------------

type Route = (req: Request) => Promise<Response | undefined>;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req.clone());
      if (res) return res;
    }
    throw new Error(
      `fetch stub: unrouted ClickHouse call: ${await req.text()}`,
    );
  };
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonEachRow(rows: unknown[], status = 200): Response {
  return new Response(rows.map((r) => JSON.stringify(r)).join("\n"), {
    status,
  });
}

interface CHDataset {
  board: Record<string, unknown>[];
  distinctIds: number[];
  chartScores: Record<string, unknown>[];
  chartMeta: Record<string, unknown>[];
  totals: Record<string, unknown>;
  titles: Record<string, unknown>;
  genres: Record<string, unknown>;
  currentSeason: Record<string, unknown>;
  movies: Record<string, unknown>;
  years: Record<string, unknown>;
  freshness: Record<string, unknown> | null;
}

/** A tiny but internally-consistent dataset (3 users, 6 titles) that renders
 * all seven artifacts clean — same shape as anilist_chart.test.ts's own
 * `inputs()` fixture, expressed as raw ClickHouse rows instead of
 * already-typed RenderInputs. */
function dataset(now: Date): CHDataset {
  const users = ["alice", "bob", "carol"];
  const board: Record<string, unknown>[] = [];
  const chartScores: Record<string, unknown>[] = [];
  const chartMeta: Record<string, unknown>[] = [];
  for (let mid = 1; mid <= 6; mid++) {
    chartMeta.push({
      media_id: mid,
      title_romaji: `Title ${mid}`,
      title_english: `T${mid}`,
      genres: ["Comedy", "Action"],
      format: "TV",
      start_year: 2010 + mid,
      start_date: `${2010 + mid}-07-05`,
      cover_image_large: `https://cdn.example.test/${mid}.jpg`,
    });
    for (const u of users) {
      const score = 6 + (mid % 4);
      board.push({
        user_name: u,
        media_id: mid,
        score,
        title_romaji: `Title ${mid}`,
        title_english: `T${mid}`,
        genres: ["Comedy", "Action"],
        start_year: 2010 + mid,
        format: "TV",
        episodes: 12,
        duration: 24,
        average_score: 70 + mid,
        popularity: 1000 * mid,
        cover_image_large: `https://cdn.example.test/${mid}.jpg`,
      });
      chartScores.push({ user_name: u, media_id: mid, score });
    }
  }
  return {
    board,
    distinctIds: [1, 2, 3, 4, 5, 6],
    chartScores,
    chartMeta,
    totals: { users: 3, rows: board.length, rated: board.length },
    titles: { titles: 6 },
    genres: { genres: 2 },
    currentSeason: { cur_titles: 1, cur_users: 1 },
    movies: { movies: 0 },
    years: { y_min: 2011, y_max: 2016 },
    // 1 day before `now` — well inside the 30d stale window, no anomaly.
    freshness: {
      newest: `${
        new Date(now.getTime() - 86400000).toISOString().slice(0, 19).replace(
          "T",
          " ",
        )
      }`,
    },
  };
}

/** Route every ClickHouse POST by inspecting its SQL body. Each query family
 * has a unique substring/prefix in clickhouse.ts's fixed templates — see the
 * comment on each branch for why it is unambiguous. Falls through to
 * `undefined` (unrouted) for anything unmatched, which the harness turns
 * into a loud "unrouted" throw rather than a silent empty result. */
function clickhouseRoute(ds: CHDataset): Route {
  return (req) =>
    (async () => {
      if (req.method !== "POST") return undefined;
      const sql = await req.text();
      const url = new URL(req.url);
      // board: the only query with a LEFT JOIN.
      if (sql.includes("LEFT JOIN")) return jsonEachRow(ds.board);
      // distinctMediaIds: SELECT DISTINCT media_id (checked before
      // chartScores, whose "user_name IN {names...}" clause it shares).
      if (sql.includes("SELECT DISTINCT media_id")) {
        return jsonEachRow(ds.distinctIds.map((id) => ({ media_id: id })));
      }
      // chartScores: exact prefix (board's is "s.user_name, s.media_id...").
      if (sql.startsWith("SELECT user_name, media_id, score")) {
        // LB5 pin: a poisoned {ids} param (non-numeric media_id trunc'd to
        // NaN by arrayIntParam) reaches chartMetadataQuery as the literal
        // string "[NaN]" — a real ClickHouse would reject this as invalid
        // Array(Int64) syntax. Simulated here so the WHOLE render() call is
        // proven to reject with no diagnostic marker (see the adversarial
        // suite's dedicated LB5 test for the full characterization).
        return jsonEachRow(ds.chartScores);
      }
      if (sql.includes("WHERE media_id IN {ids:Array(Int64)}")) {
        if (url.searchParams.get("param_ids") === "[NaN]") {
          return new Response(
            "Code: 53. DB::Exception: Cannot parse Int64 from String, because value is too short: NaN",
            { status: 400 },
          );
        }
        return jsonEachRow(ds.chartMeta);
      }
      if (sql.includes("AS users, count() AS rows")) {
        return jsonEachRow([ds.totals]);
      }
      if (sql.includes("AS titles FROM")) return jsonEachRow([ds.titles]);
      if (sql.includes("arrayJoin(genres)")) return jsonEachRow([ds.genres]);
      if (sql.includes("cur_titles")) return jsonEachRow([ds.currentSeason]);
      if (sql.includes("AS movies")) return jsonEachRow([ds.movies]);
      if (sql.includes("y_min")) return jsonEachRow([ds.years]);
      if (sql.includes("AS newest")) {
        return jsonEachRow(ds.freshness ? [ds.freshness] : []);
      }
      return undefined;
    })();
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

Deno.test("settings: not configured -> clickhouseConfigured false, userCount 0, defaults echoed", async () => {
  const time = new FakeTime(new Date("2026-07-21T12:00:00Z"));
  try {
    const { ctx, written } = makeCtx({});
    await run("settings", {}, ctx);
    const res = written.find((w) => w.spec === "settings")!;
    assertEquals(res.payload.clickhouseConfigured, false);
    assertEquals(res.payload.userCount, 0);
    assertEquals(res.payload.clickhouseDatabase, "default");
    assertEquals(res.payload.topK, 13);
    assertEquals(res.payload.bayesMinVotes, 5);
    assertEquals(res.payload.penaltyRate, 0.05);
    assertEquals(res.payload.timestamp, "2026-07-21T12:00:00.000Z");
  } finally {
    time.restore();
  }
});

Deno.test("settings: fully configured -> clickhouseConfigured true, userCount reflects userNames, explicit values echoed verbatim", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await run("settings", {}, ctx);
  const res = written.find((w) => w.spec === "settings")!;
  assertEquals(res.payload.clickhouseConfigured, true);
  assertEquals(res.payload.userCount, 3);
  assertEquals(res.payload.topK, 13);
  assertEquals(res.payload.bayesMinVotes, 5);
  assertEquals(res.payload.penaltyRate, 0.05);
});

Deno.test("settings: never echoes clickhouseKey into the written resource", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await run("settings", {}, ctx);
  const res = written.find((w) => w.spec === "settings")!;
  const s = JSON.stringify(res.payload);
  assert(
    !s.includes(SENTINEL_KEY),
    "clickhouseKey must never appear in settings",
  );
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

Deno.test("render: ClickHouse not configured -> refuses with no fetch call at all, writes renderRun ok:false", async () => {
  const { ctx, written } = makeCtx({});
  await withFetchStub([], async (calls) => {
    await run("render", {}, ctx);
    assertEquals(
      calls.length,
      0,
      "no ClickHouse call may happen when unconfigured",
    );
  });
  const res = written.find((w) => w.spec === "renderRun")!;
  assertEquals(res.payload.ok, false);
  assertStringIncludes(
    String(res.payload.refuseReason),
    "ClickHouse is not configured",
  );
  assertEquals(res.payload.published, []);
});

Deno.test("render: happy path — all 7 artifacts publish, renderRun ok:true, nothing refused or failed", async () => {
  const now = new Date("2026-07-21T12:00:00Z");
  const time = new FakeTime(now);
  try {
    const { ctx, written } = makeCtx(GLOBAL_ARGS);
    const ds = dataset(now);
    await withFetchStub([clickhouseRoute(ds)], async (calls) => {
      await run("render", {}, ctx);
      // 11 distinct read queries: board, chartScores, distinctIds, chartMeta,
      // totals, titles, genres, currentSeason, movies, years, freshness.
      assertEquals(calls.length, 11);
    });
    const pages = written.filter((w) => w.spec === "renderedPage");
    assertEquals(
      pages.map((p) => p.name).sort(),
      ["bayes", "bayes-json", "board", "chart", "current", "fresh", "landing"],
    );
    const runRes = written.find((w) => w.spec === "renderRun")!;
    assertEquals(runRes.payload.ok, true);
    assertEquals(runRes.payload.refuseReason, null);
    assertEquals(
      (runRes.payload.published as string[]).sort(),
      ["bayes", "bayes-json", "board", "chart", "current", "fresh", "landing"],
    );
    assertEquals(runRes.payload.refused, []);
    assertEquals(runRes.payload.failed, []);
    // NOTE: `anomalies` is NOT asserted empty here — this small 3-user/6-title
    // fixture is far below the board's MIN_LIST/MIN_RATED (100) thresholds,
    // so several awards genuinely have "no eligible candidate" and their
    // pickOrSkip warn.skips entries legitimately flow into `anomalies`
    // (the render() code merges verdict.anomalies + warn.skips + warn.curated
    // + refused + failed into one array). That is correct, expected behavior
    // for this fixture size, not a freshness anomaly.
    assertEquals(runRes.payload.timestamp, now.toISOString());
  } finally {
    time.restore();
  }
});

Deno.test("render: every ClickHouse request carries auth in headers only — never in the URL or body", async () => {
  const now = new Date("2026-07-21T12:00:00Z");
  const time = new FakeTime(now);
  try {
    const { ctx } = makeCtx(GLOBAL_ARGS);
    const ds = dataset(now);
    await withFetchStub([clickhouseRoute(ds)], async (calls) => {
      await run("render", {}, ctx);
      for (const req of calls) {
        assertEquals(req.headers.get("X-ClickHouse-User"), "render_ro");
        assertEquals(req.headers.get("X-ClickHouse-Key"), SENTINEL_KEY);
        assert(
          !req.url.includes(SENTINEL_KEY),
          "clickhouseKey must never appear in the URL",
        );
      }
    });
  } finally {
    time.restore();
  }
});

Deno.test("render: topK is threaded into BOTH the chart and the landing copy, via execute()", async () => {
  const now = new Date("2026-07-21T12:00:00Z");
  const time = new FakeTime(now);
  try {
    const { ctx, written } = makeCtx(GLOBAL_ARGS);
    const ds = dataset(now);
    await withFetchStub([clickhouseRoute(ds)], async () => {
      await run("render", { topK: 10 }, ctx);
    });
    const chart = written.find((w) => w.name === "chart")!;
    const landing = written.find((w) => w.name === "landing")!;
    assertStringIncludes(String(chart.payload.html), "Top 10 Anime by Genre");
    assertStringIncludes(String(landing.payload.html), "жанров, по 10 тайтлов");
  } finally {
    time.restore();
  }
});

Deno.test("render: bayesMinVotes is threaded into the /bayes info line, via execute()", async () => {
  const now = new Date("2026-07-21T12:00:00Z");
  const time = new FakeTime(now);
  try {
    const { ctx, written } = makeCtx(GLOBAL_ARGS);
    const ds = dataset(now);
    await withFetchStub([clickhouseRoute(ds)], async () => {
      await run("render", { bayesMinVotes: 9 }, ctx);
    });
    const bayes = written.find((w) => w.name === "bayes")!;
    assertStringIncludes(String(bayes.payload.html), "m=9,");
  } finally {
    time.restore();
  }
});

Deno.test("render: with no method args at all (bypassing zod defaults), topK/bayesMinVotes fall back to the GLOBAL args, not the schema default", async () => {
  const now = new Date("2026-07-21T12:00:00Z");
  const time = new FakeTime(now);
  try {
    const { ctx, written } = makeCtx({
      ...GLOBAL_ARGS,
      topK: 7,
      bayesMinVotes: 3,
    });
    const ds = dataset(now);
    await withFetchStub([clickhouseRoute(ds)], async () => {
      // Calling execute() DIRECTLY with {} (not through run()/zod .parse(),
      // which would inject the schema's own defaults of 13/5) is the only
      // way to observe the `a.topK ?? (g.topK as number) ?? 13` global-arg
      // fallback branch at all.
      const method = (model.methods as MethodMap).render;
      await method.execute({}, ctx);
    });
    const chart = written.find((w) => w.name === "chart")!;
    assertStringIncludes(String(chart.payload.html), "Top 7 Anime by Genre");
  } finally {
    time.restore();
  }
});

Deno.test("render: no score rows -> refuses before publishing anything (but all reads already happened)", async () => {
  const now = new Date("2026-07-21T12:00:00Z");
  const time = new FakeTime(now);
  try {
    const { ctx, written } = makeCtx(GLOBAL_ARGS);
    const ds = dataset(now);
    ds.totals = { users: 0, rows: 0, rated: 0 };
    await withFetchStub([clickhouseRoute(ds)], async (calls) => {
      await run("render", {}, ctx);
      // Characterization: the freshness gate is evaluated AFTER every read,
      // so all 11 queries still fire even though the run is refused.
      assertEquals(calls.length, 11);
    });
    const runRes = written.find((w) => w.spec === "renderRun")!;
    assertEquals(runRes.payload.ok, false);
    assertStringIncludes(String(runRes.payload.refuseReason), "no score rows");
    assertEquals(written.filter((w) => w.spec === "renderedPage").length, 0);
  } finally {
    time.restore();
  }
});

Deno.test("LB4 (fixed): a malformed freshness timestamp still renders, and now surfaces an explicit 'unparseable' anomaly instead of a silent gap", async () => {
  const now = new Date("2026-07-21T12:00:00Z");
  const time = new FakeTime(now);
  try {
    const { ctx, written } = makeCtx(GLOBAL_ARGS);
    const ds = dataset(now);
    // Garbage, unparseable timestamp — Date.parse -> NaN -> newestDataAgeMs
    // coerced to `null` -> the staleness branch (`!== null`) never fires, but
    // `newestTimestampMalformed` is now computed and passed through, so
    // evaluateFreshness pushes an explicit "unparseable" anomaly (LB4).
    ds.freshness = { newest: "not-a-timestamp" };
    await withFetchStub([clickhouseRoute(ds)], async () => {
      await run("render", {}, ctx);
    });
    const runRes = written.find((w) => w.spec === "renderRun")!;
    assertEquals(
      runRes.payload.ok,
      true,
      "still renders — a malformed timestamp is an anomaly, never a refusal",
    );
    const anomalies = runRes.payload.anomalies as string[];
    assert(
      !anomalies.some((a) => a.includes("publishing last-known-good")),
      "a garbage timestamp must not spuriously report staleness (that would need a real, parseable, past-window timestamp)",
    );
    assert(
      anomalies.some((a) => a.includes("unparseable")),
      "the gap must now be SIGNALLED, not silent (LB4 fix)",
    );
  } finally {
    time.restore();
  }
});

Deno.test("LB1 (fixed): a read-phase ClickHouse failure still aborts render() (fail loud), but now leaves a diagnostic renderRun marker behind", async () => {
  const now = new Date("2026-07-21T12:00:00Z");
  const time = new FakeTime(now);
  try {
    const { ctx, written } = makeCtx(GLOBAL_ARGS);
    const ds = dataset(now);
    await withFetchStub(
      [
        // The landing 'totals' query fails; every read before it (board,
        // chartScores, distinctIds, chartMeta) already succeeded.
        (req) =>
          (async () => {
            const sql = await req.text();
            if (sql.includes("AS users, count() AS rows")) {
              return new Response(
                "Code: 210. DB::NetworkError: connection reset",
                {
                  status: 503,
                },
              );
            }
            return undefined;
          })(),
        clickhouseRoute(ds),
      ],
      async () => {
        await assertRejects(
          () => run("render", {}, ctx),
          Error,
          "ClickHouse 503",
        );
      },
    );
    const runRes = written.find((w) => w.spec === "renderRun")!;
    assert(
      runRes,
      "a diagnostic renderRun marker must now survive a mid-flight read throw (LB1 fix: write-then-rethrow)",
    );
    assertEquals(runRes.payload.ok, false);
    assertStringIncludes(String(runRes.payload.refuseReason), "read failed");
    assertStringIncludes(String(runRes.payload.refuseReason), "ClickHouse 503");
    assert(
      !JSON.stringify(runRes.payload).includes(SENTINEL_KEY),
      "the LB1 diagnostic marker must never leak clickhouseKey",
    );
  } finally {
    time.restore();
  }
});

Deno.test("LB6 (fixed): the ClickHouse error body is trimmed+redacted (BODY_SENTINEL still survives) — the configured key never appears, and the LB1 diagnostic marker now also carries it, key-free", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  const BODY_SENTINEL = "Code: 62. DB::Exception: Syntax error near XYZ123";
  await withFetchStub(
    [() => Promise.resolve(new Response(BODY_SENTINEL, { status: 400 }))],
    async () => {
      const err = await assertRejects(() => run("render", {}, ctx), Error);
      assertStringIncludes(String(err), BODY_SENTINEL);
      assert(
        !String(err).includes(SENTINEL_KEY),
        "clickhouseKey must never appear in a thrown ClickHouse error",
      );
    },
  );
  const runRes = written.find((w) => w.spec === "renderRun")!;
  assert(
    runRes,
    "LB1's write-then-rethrow means a renderRun marker now survives this too",
  );
  assertEquals(runRes.payload.ok, false);
  assertStringIncludes(String(runRes.payload.refuseReason), BODY_SENTINEL);
  assert(
    !JSON.stringify(runRes.payload).includes(SENTINEL_KEY),
    "clickhouseKey must never appear in the renderRun marker either",
  );
});

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

Deno.test("publish: nodeHost/outputDir not configured -> writes publishRun ok:false, missing explains why, no readResource call needed", async () => {
  const { ctx, written } = makeCtx({});
  await run("publish", {}, ctx);
  const res = written.find((w) => w.spec === "publishRun")!;
  assertEquals(res.payload.ok, false);
  assertEquals(res.payload.missing, ["nodeHost/outputDir not configured"]);
  assertEquals(res.payload.published, []);
  // nodeUser defaults to "root" even when unconfigured; only host/dir show "?".
  assertEquals(res.payload.target, "root@?:?");
});

Deno.test("publish: host/dir configured but context has no readResource -> distinct missing reason", async () => {
  const written: Written[] = [];
  const ctx = {
    globalArgs: GLOBAL_ARGS,
    writeResource: (spec: string, name: string, payload: unknown) => {
      written.push({ spec, name, payload: payload as Record<string, unknown> });
      return Promise.resolve({ spec, name });
    },
    // no readResource on this ctx at all
  };
  await run("publish", {}, ctx);
  const res = written.find((w) => w.spec === "publishRun")!;
  assertEquals(res.payload.ok, false);
  assertEquals(res.payload.missing, ["no readResource in context"]);
});

Deno.test("publish: LOCAL path — a real temp dir, all 7 rendered pages are written atomically with the exact content", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "anilist-chart-publish-test-" });
  try {
    const { ctx, store } = makeCtx({
      ...GLOBAL_ARGS,
      outputDir: tmp,
    });
    // Seed the renderedPage artifacts directly (bypassing a full render()
    // call — publish() only ever reads by page key, so this is a faithful,
    // much cheaper way to set up the fixture for this suite's purpose).
    const PAGES: Record<string, string> = {
      board: "<html>board</html>",
      landing: "<html>landing</html>",
      chart: "<html>chart</html>",
      fresh: "<html>fresh</html>",
      bayes: "<html>bayes</html>",
      "bayes-json": '{"ok":true}',
      current: "<html>current</html>",
    };
    for (const [key, html] of Object.entries(PAGES)) store.set(key, { html });

    await run("publish", {}, ctx);

    const FILES: Record<string, string> = {
      board: "board.html",
      landing: "landing.html",
      chart: "genre_chart.html",
      fresh: "genre_chart_age_penalty.html",
      bayes: "genre_chart_bayesian.html",
      "bayes-json": "genre_chart_bayesian.json",
      current: "current_season_chart.html",
    };
    for (const [key, file] of Object.entries(FILES)) {
      const content = await Deno.readTextFile(`${tmp}/${file}`);
      assertEquals(content, PAGES[key], `${file} content mismatch`);
      // atomic-write proof: the .tmp sibling must NOT survive the rename.
      const tmpExists = await Deno.stat(`${tmp}/.${file}.tmp`).then(
        () => true,
        () => false,
      );
      assert(!tmpExists, `${file}.tmp must not survive a successful publish`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("publish: LOCAL path — a page that was never rendered is reported 'missing', not a failure; the rest still publish (ok:true overall)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "anilist-chart-publish-test-" });
  try {
    const { ctx, written, store } = makeCtx({ ...GLOBAL_ARGS, outputDir: tmp });
    // Only 6 of the 7 pages were ever rendered — "board" is absent.
    for (
      const key of [
        "landing",
        "chart",
        "fresh",
        "bayes",
        "bayes-json",
        "current",
      ]
    ) {
      store.set(key, { html: `<html>${key}</html>` });
    }
    await run("publish", {}, ctx);
    const res = written.find((w) => w.spec === "publishRun")!;
    assertEquals(res.payload.ok, true);
    assertEquals(res.payload.missing, ["board"]);
    assertEquals((res.payload.published as string[]).length, 6);
    assertEquals(res.payload.failed, []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("publish: LOCAL path — one page's write failing never suppresses the rest, but the method still throws (fail loud), AND the partial marker survives", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "anilist-chart-publish-test-" });
  try {
    // Force board.html's rename to fail: pre-create a DIRECTORY at the
    // target filename, so `Deno.rename(tmp, dir/board.html)` (file -> onto
    // an existing directory) throws, while every other page's tmp+rename is
    // untouched and succeeds normally.
    await Deno.mkdir(`${tmp}/board.html`);
    const { ctx, written, store } = makeCtx({ ...GLOBAL_ARGS, outputDir: tmp });
    for (
      const key of [
        "board",
        "landing",
        "chart",
        "fresh",
        "bayes",
        "bayes-json",
        "current",
      ]
    ) {
      store.set(key, { html: `<html>${key}</html>` });
    }
    await assertRejects(
      () => run("publish", {}, ctx),
      Error,
      "publish incomplete",
    );
    const res = written.find((w) => w.spec === "publishRun")!;
    assertEquals(res.payload.ok, false);
    assertEquals((res.payload.published as string[]).sort(), [
      "bayes",
      "bayes-json",
      "chart",
      "current",
      "fresh",
      "landing",
    ]);
    assertEquals((res.payload.failed as string[]).length, 1);
    assertStringIncludes(String((res.payload.failed as string[])[0]), "board:");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("publish: zero rendered pages at all -> throws 'publish incomplete: 0 written'", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "anilist-chart-publish-test-" });
  try {
    const { ctx, written } = makeCtx({ ...GLOBAL_ARGS, outputDir: tmp });
    await assertRejects(
      () => run("publish", {}, ctx),
      Error,
      "publish incomplete: 0 written",
    );
    const res = written.find((w) => w.spec === "publishRun")!;
    assertEquals(res.payload.ok, false);
    assertEquals(res.payload.missing, [
      "board",
      "landing",
      "chart",
      "fresh",
      "bayes",
      "current",
      "bayes-json",
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("publish: never echoes clickhouseKey (unrelated secret) into any written resource", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "anilist-chart-publish-test-" });
  try {
    const { ctx, written, store } = makeCtx({ ...GLOBAL_ARGS, outputDir: tmp });
    store.set("board", { html: "<html>board</html>" });
    await run("publish", {}, ctx);
    for (const w of written) {
      assert(!JSON.stringify(w.payload).includes(SENTINEL_KEY));
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Sanity
// ---------------------------------------------------------------------------

Deno.test("sanity: model exposes exactly the 3 documented methods", () => {
  const methodNames = Object.keys(model.methods).sort();
  assertEquals(methodNames, ["publish", "render", "settings"]);
});
