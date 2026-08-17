/**
 * Contract-fixture suite: pins the CONCRETE wire shape of the public AniList
 * GraphQL API (`https://graphql.anilist.co`) that `@magistr/anilist` speaks,
 * directly from `anilist/fixtures/*.json`, independent of the model's
 * resource schemas — anilist.ts never zod-validates the raw GraphQL payload
 * (the `gql()` helper trusts `json.data` as-is), so a suite that only checked
 * "the written resource validates against the schema" would be toothless.
 * Also pins the three ingest query-const invariants migrated from the old
 * `anilist.test.ts` (LIST_INGEST_QUERY / USERLIST_QUERY / METADATA_INGEST_QUERY
 * byte-shape anchors to the ClickHouse schema).
 *
 * All fixtures are pure doc-derived synthetic data — see
 * `anilist/fixtures/PROVENANCE.md`. Every test here is offline: fixtures are
 * fed through a stubbed `globalThis.fetch`, no network call is ever made.
 * This suite characterizes the wire-shape contract, which is unaffected by
 * the `2026.08.02.1` AL1-AL4 fixes to `gql()`'s request/retry path (see
 * `anilist_adversarial_test.ts` for those) — the query/mutation consts and
 * every resource shape pinned here are untouched.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  LIST_INGEST_QUERY,
  METADATA_INGEST_QUERY,
  model,
  USERLIST_QUERY,
} from "./anilist.ts";
import searchFixture from "../../fixtures/search.json" with { type: "json" };
import mediaDetailsFixture from "../../fixtures/media-details.json" with {
  type: "json",
};
import userlistFixture from "../../fixtures/userlist.json" with {
  type: "json",
};
import trendingFixture from "../../fixtures/trending.json" with {
  type: "json",
};
import seasonalFixture from "../../fixtures/seasonal.json" with {
  type: "json",
};
import watchingFixture from "../../fixtures/watching.json" with {
  type: "json",
};
import activitiesFixture from "../../fixtures/activities.json" with {
  type: "json",
};
import userIdFixture from "../../fixtures/user-id.json" with { type: "json" };
import listIngestFixture from "../../fixtures/list-ingest.json" with {
  type: "json",
};
import metadataFixture from "../../fixtures/metadata.json" with {
  type: "json",
};
import graphqlErrorFixture from "../../fixtures/graphql-error.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  mediaType: "ANIME" as const,
};

const CH_GLOBAL_ARGS = {
  ...GLOBAL_ARGS,
  clickhouseUrl: "http://ch.fixtures.example:8123",
  clickhouseDatabase: "default",
  clickhouseUser: "default",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      readResource: (_name: string) => Promise.resolve(null),
      logger: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
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

type ParsedBody = { query: string; variables: Record<string, unknown> };
type Route = (
  req: Request,
  body: ParsedBody,
) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request.
 * Cast via the UNKNOWN-BRIDGE (`as unknown as typeof globalThis.fetch`) per
 * the plan's toolchain note for deno 2.8.3 — never the direct
 * `as typeof globalThis.fetch` porkbun used. */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    let body: ParsedBody = { query: "", variables: {} };
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body)) as ParsedBody;
      } catch {
        // non-JSON body: routes that need it will simply not match
      }
    }
    for (const route of routes) {
      const res = await route(req, body);
      if (res) return res;
    }
    throw new Error(
      `fetch stub: unrouted request ${req.method} ${req.url} query=${
        (body.query ?? "").slice(0, 80)
      }`,
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Every stubbed 200 response carries HEALTHY rate-limit headers by default
 * (remaining=90, reset=epoch-0-already-elapsed) so no test in this file
 * incurs gql()'s pre-flight wait. Rate-limit state is per-invocation
 * (`makeGql()`, since `2026.08.02.1`) so this is purely a per-test
 * convenience now, not a cross-test isolation requirement — one test's
 * headers can no longer leak into another's. Tests that specifically want to
 * exercise a low-remaining/429 state override these explicitly. */
function jsonRes(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-RateLimit-Remaining": "90",
      "X-RateLimit-Reset": "0",
      ...headers,
    },
  });
}

function isAniListHost(req: Request): boolean {
  return new URL(req.url).hostname === "graphql.anilist.co";
}

/** Route matching a query by a distinctive substring unique to one of the
 * module's GraphQL query/mutation constants (see the per-query mapping in
 * PROVENANCE.md). */
function queryRoute(match: string, fixture: unknown, status = 200): Route {
  return (req, body) => {
    if (!isAniListHost(req)) return undefined;
    if (!body.query.includes(match)) return undefined;
    return jsonRes(fixture, status);
  };
}

async function requestBody(req: Request): Promise<ParsedBody> {
  return JSON.parse(await req.text()) as ParsedBody;
}

// ---------------------------------------------------------------------------
// search.json contract — SEARCH_QUERY
// ---------------------------------------------------------------------------

Deno.test("contract: search.json — Page envelope pinned, two results (anime + manga) written verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute(
      "media(search: $search, type: $type, sort: SEARCH_MATCH)",
      searchFixture,
    )],
    async () => {
      await run("search", {
        query: "Nebula",
        perPage: 10,
        page: 1,
        fetchAll: false,
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assert(res);
  assertEquals(res.payload.totalResults, 2);
  assertEquals(res.payload.page, 1);
  assertEquals(res.payload.hasNextPage, false);
  const results = res.payload.results as Array<Record<string, unknown>>;
  assertEquals(results.length, 2);
  assertEquals(results[0].id, 90001);
  assertEquals(
    (results[0].title as Record<string, unknown>).romaji,
    "Nebula Drifters",
  );
  assertEquals(results[1].id, 90002);
  assertEquals(results[1].format, "MANGA");
});

Deno.test("contract: search — POST body carries the search term and type variables", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("SEARCH_MATCH", searchFixture)],
    async (calls) => {
      await run("search", {
        query: "Nebula Drifters",
        perPage: 10,
        page: 1,
        fetchAll: false,
      }, ctx);
      const body = await requestBody(calls[0]);
      assertEquals(body.variables.search, "Nebula Drifters");
      assertEquals(body.variables.type, "ANIME");
      assertEquals(calls[0].headers.get("Content-Type"), "application/json");
      assertEquals(calls[0].headers.get("Accept"), "application/json");
    },
  );
});

// ---------------------------------------------------------------------------
// media-details.json contract — DETAILS_QUERY
// ---------------------------------------------------------------------------

Deno.test("contract: media-details.json — studios/staff flattened from nodes[], relations/recommendations/tags/externalLinks pinned", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute("Media(id: $id)", mediaDetailsFixture)],
    async () => {
      await run("get", { id: 90001 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "media")!;
  assert(res);
  assertEquals(res.payload.id, 90001);
  assertEquals(res.payload.studios, ["Fixture Animation Works"]);
  assertEquals(res.payload.staff, ["Aria Fixture"]);
  const relations = res.payload.relations as Record<string, unknown>;
  const edges = relations.edges as Array<Record<string, unknown>>;
  assertEquals(edges[0].relationType, "SEQUEL");
  const recs = (res.payload.recommendations as Record<string, unknown>)
    .nodes as Array<Record<string, unknown>>;
  assertEquals(
    (recs[0].mediaRecommendation as Record<string, unknown>).id,
    90002,
  );
  assertEquals(res.payload.tags, [
    { name: "Space", rank: 90 },
    { name: "Ensemble Cast", rank: 70 },
  ]);
  assertEquals(res.payload.externalLinks, [
    { site: "Fixture Streaming", url: "https://stream.example/90001" },
  ]);
});

// ---------------------------------------------------------------------------
// userlist.json contract — USERLIST_QUERY
// ---------------------------------------------------------------------------

Deno.test("contract: userlist.json — lists mapped with entryCount, totalEntries summed across lists", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute(
      "MediaListCollection(userName: $userName, type: $type, status: $status)",
      userlistFixture,
    )],
    async () => {
      await run("userlist", { userName: "fixture_watcher" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "userlist")!;
  assert(res);
  assertEquals(res.payload.listCount, 2);
  assertEquals(res.payload.totalEntries, 2);
  const lists = res.payload.lists as Array<Record<string, unknown>>;
  assertEquals(lists[0].name, "Completed");
  assertEquals(lists[0].entryCount, 1);
  assertEquals(lists[1].name, "Planning");
  assertEquals(lists[1].entryCount, 1);
});

// ---------------------------------------------------------------------------
// trending.json contract — TRENDING_QUERY
// ---------------------------------------------------------------------------

Deno.test("contract: trending.json — Page envelope pinned, sortedBy echoed from args", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute("media(type: $type, sort: $sort)", trendingFixture)],
    async () => {
      await run("trending", {
        sort: "POPULARITY_DESC",
        perPage: 10,
        page: 1,
        fetchAll: false,
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "trending")!;
  assert(res);
  assertEquals(res.payload.sortedBy, "POPULARITY_DESC");
  const results = res.payload.results as Array<Record<string, unknown>>;
  assertEquals(results[0].id, 90003);
});

// ---------------------------------------------------------------------------
// seasonal.json contract — SEASONAL_QUERY
// ---------------------------------------------------------------------------

Deno.test("contract: seasonal.json — season/seasonYear echoed, nextAiringEpisode passed through", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute(
      "media(season: $season, seasonYear: $seasonYear",
      seasonalFixture,
    )],
    async () => {
      await run("seasonal", {
        season: "SUMMER",
        seasonYear: 2026,
        perPage: 50,
        page: 1,
      }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seasonal")!;
  assert(res);
  assertEquals(res.payload.season, "SUMMER");
  assertEquals(res.payload.seasonYear, 2026);
  const results = res.payload.results as Array<Record<string, unknown>>;
  assertEquals(
    (results[0].nextAiringEpisode as Record<string, unknown>).episode,
    4,
  );
});

// ---------------------------------------------------------------------------
// watching.json contract — WATCHING_QUERY
// ---------------------------------------------------------------------------

Deno.test("contract: watching.json — synonyms flattened, timeUntilAiringHours rounded from seconds, null nextAiringEpisode handled", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute("type: ANIME, status: CURRENT)", watchingFixture)],
    async () => {
      await run("watching", { userName: "fixture_watcher" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "watching")!;
  assert(res);
  assertEquals(res.payload.count, 2);
  const entries = res.payload.entries as Array<Record<string, unknown>>;
  assertEquals(entries[0].mediaId, 90003);
  assertEquals(entries[0].synonyms, ["QH"]);
  // 345600s / 3600 = 96h exactly
  assertEquals(entries[0].timeUntilAiringHours, 96);
  assertEquals(entries[1].mediaId, 90001);
  assertEquals(entries[1].nextAiringEp, null);
  assertEquals(entries[1].nextAiringAt, null);
  assertEquals(entries[1].timeUntilAiringHours, null);
});

// ---------------------------------------------------------------------------
// user-id.json + activities.json contract — recent-activity's full read path
// ---------------------------------------------------------------------------

/** activities.json's committed createdAt values are fixed 2023-era epoch
 * seconds; recent-activity computes its lookback cutoff from the REAL
 * wall-clock `Date.now()`. Shift to "recently before now" so the default
 * 120-minute lookback always admits them, independent of when the suite
 * runs. */
function freshActivitiesFixture(): typeof activitiesFixture {
  const now = Math.floor(Date.now() / 1000);
  const clone = JSON.parse(
    JSON.stringify(activitiesFixture),
  ) as typeof activitiesFixture;
  clone.data.Page.activities.forEach((a, i) => {
    a.createdAt = now - (i + 1) * 60;
  });
  return clone;
}

Deno.test("contract: user-id.json + activities.json — recent-activity resolves the user, filters to consumption activity only, writes activityFeed + activityCursor", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", freshActivitiesFixture()),
    ],
    async () => {
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        lookbackMinutes: 120,
        maxPages: 6,
        telegramModel: "",
        telegramChatId: "",
        format: "rich",
        dryRun: true,
        floorReset: false,
      }, ctx);
    },
  );
  const feed = written.find((w) => w.spec === "activityFeed")!;
  assert(feed);
  assertEquals(feed.payload.usersChecked, ["fixture_watcher"]);
  // "plans to watch" is filtered out by isConsumptionActivity; the other two
  // (watched episode, completed) survive.
  assertEquals(feed.payload.newCount, 2);
  const activities = feed.payload.activities as Array<Record<string, unknown>>;
  assert(activities.every((a) => a.status !== "plans to watch"));
  const cursor = written.find((w) => w.spec === "activityCursor")!;
  assert(cursor);
});

// ---------------------------------------------------------------------------
// list-ingest.json + metadata.json contract — ingest-scores charting pipeline
// ---------------------------------------------------------------------------

Deno.test("contract: list-ingest.json — ingest-scores writes user_scores rows (score 0 kept, decimal kept, null dropped)", async () => {
  const { ctx, written } = makeCtx(CH_GLOBAL_ARGS);
  await withFetchStub(
    [
      queryRoute("hasNextChunk", listIngestFixture),
      queryRoute("media(id_in: $ids", metadataFixture),
      (req) => {
        if (isAniListHost(req)) return undefined;
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? "";
        if (
          query.startsWith("SELECT DISTINCT") || query.startsWith("INSERT INTO")
        ) {
          return new Response("", { status: 200 });
        }
        return undefined;
      },
    ],
    async () => {
      await run("ingest-scores", {
        usernames: ["fixture_watcher"],
        perChunk: 500,
        maxChunks: 20,
        metadataBatchSize: 50,
      }, ctx);
    },
  );
  const scored = written.find((w) => w.spec === "userlistScored")!;
  assert(scored);
  assertEquals(
    scored.payload.scoresWritten,
    2,
    "score 0 and 8.5 kept; null dropped",
  );
  assertEquals(scored.payload.userName, "fixture_watcher");
  const run_ = written.find((w) => w.spec === "ingestRun")!;
  assert(run_);
  assertEquals(run_.payload.totalScoresWritten, 2);
});

// ---------------------------------------------------------------------------
// graphql-error.json contract — 200+errors[] causes gql() to THROW (anilist
// got this one right, unlike the seadex/seanime swallow-bug class). Full
// hostile-payload narrative (429-in-body, non-JSON, data:null-no-errors)
// lives in the adversarial suite.
// ---------------------------------------------------------------------------

Deno.test("contract: graphql-error.json — a 200 response with errors[] REJECTS the method call, embedding the error message", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("media(search:", graphqlErrorFixture)],
    async () => {
      const err = await assertRejects(
        () =>
          run("search", {
            query: "Whatever",
            perPage: 10,
            page: 1,
            fetchAll: false,
          }, ctx),
        Error,
      );
      assert(
        (err as Error).message.includes(
          "Something went wrong. Please contact support for more information.",
        ),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Query-const invariants (migrated from the old anilist.test.ts)
// ---------------------------------------------------------------------------

Deno.test("LIST_INGEST_QUERY selects the decimal score + status over MediaListCollection chunks", () => {
  assert(LIST_INGEST_QUERY.includes("score(format:"));
  assert(LIST_INGEST_QUERY.includes("POINT_10_DECIMAL"));
  assert(LIST_INGEST_QUERY.includes("MediaListCollection"));
  assert(LIST_INGEST_QUERY.includes("status_in"));
  assert(LIST_INGEST_QUERY.includes("chunk"));
  assert(LIST_INGEST_QUERY.includes("perChunk"));
  assert(LIST_INGEST_QUERY.includes("hasNextChunk"));
  assert(LIST_INGEST_QUERY.includes("mediaId"));
});

Deno.test("USERLIST_QUERY (notifier/userlist) keeps a bare score, never the ingest decimal format", () => {
  assert(!USERLIST_QUERY.includes("score(format:"));
  assert(/\bscore\b/.test(USERLIST_QUERY));
});

Deno.test("METADATA_INGEST_QUERY covers every anilist_metadata source field (17 columns)", () => {
  const q = METADATA_INGEST_QUERY;
  for (
    const field of [
      "id",
      "romaji",
      "english",
      "native",
      "genres",
      "tags",
      "name",
      "rank",
      "isMediaSpoiler",
      "startDate",
      "endDate",
      "format",
      "status",
      "episodes",
      "duration",
      "averageScore",
      "popularity",
      "studios",
      "coverImage",
      "large",
    ]
  ) {
    assert(q.includes(field), `metadata query missing source field: ${field}`);
  }
  assert(!q.includes("score(format:"));
});

// ---------------------------------------------------------------------------
// Sanity
// ---------------------------------------------------------------------------

Deno.test("sanity: model exposes exactly the 12 documented methods", () => {
  const methodNames = Object.keys(model.methods).sort();
  assertEquals(methodNames, [
    "get",
    "ingest-scores",
    "lookup",
    "recent-activity",
    "refresh-metadata",
    "search",
    "seasonal",
    "set-score",
    "trending",
    "update-progress",
    "userlist",
    "watching",
  ]);
});
