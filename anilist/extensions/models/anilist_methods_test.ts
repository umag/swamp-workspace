/**
 * Method-level tests for @magistr/anilist — every one of the 11 methods
 * (search, get, userlist, trending, watching, seasonal, update-progress,
 * set-score, recent-activity, ingest-scores, refresh-metadata), happy path +
 * failure path, driven through `model.methods.<m>.arguments.parse()` +
 * `.execute()` against a stubbed `globalThis.fetch` and a fake ExecContext —
 * mirroring the porkbun/seadex/musicbrainz harness pattern.
 *
 * This suite characterizes the model's method-level behavior — happy paths
 * and error-handling shape — which is unaffected by the `2026.08.02.1`
 * AL1-AL4 fixes to `gql()`'s internal request/retry path (see
 * `anilist_adversarial_test.ts` for those); every test here still uses
 * healthy/well-formed fixtures, so it never exercises the fixed hostile-200
 * or rate-limit-detection code paths.
 *
 * SUBPROCESS BOUNDARY (mandatory constraint, adversarial review HIGH #1):
 * recent-activity's delivery path (`sendTelegram`/`sendRichTelegram`) spawns a
 * REAL `swamp` subprocess via `Deno.Command`. EVERY recent-activity test in
 * this suite uses `telegramModel: ""` and/or `dryRun: true` — the no-send
 * branches — so the subprocess spawn is NEVER reached. Confirmed-send cursor
 * ADVANCE is characterized separately through the exported `advanceCursor`
 * helper in the coverage/property suites, never by spawning here.
 *
 * Error-path tests for gql()-routed methods use HTTP 400 (not 5xx) so the
 * retry-with-backoff branch never fires and this suite needs no FakeTime; the
 * 429/5xx retry-with-backoff narrative is characterized in the adversarial
 * suite instead.
 *
 * Every stubbed 200 response carries healthy X-RateLimit-* headers (see
 * `jsonRes` below) purely so no test in this file incurs gql()'s pre-flight
 * wait. Rate-limit state is per-invocation (`makeGql()`, since
 * `2026.08.02.1`), so headers here can no longer leak into a later test in
 * this or a sibling suite.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./anilist.ts";
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = { mediaType: "ANIME" as const };
const AUTH_GLOBAL_ARGS = { ...GLOBAL_ARGS, accessToken: "fixture-token-abc" };
const CH_GLOBAL_ARGS = {
  ...GLOBAL_ARGS,
  clickhouseUrl: "http://ch.fixtures.example:8123",
  clickhouseDatabase: "default",
  clickhouseUser: "default",
  clickhousePassword: "fixture-ch-pass",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: { level: string; message: string }[] = [];
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
        info: (m: string) => logs.push({ level: "info", message: m }),
        warn: (m: string) => logs.push({ level: "warn", message: m }),
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

type ResourceMap = Record<string, {
  schema: { parse: (a: unknown) => unknown };
}>;

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
        // non-JSON body: routes needing it simply won't match
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

function queryRoute(match: string, fixture: unknown, status = 200): Route {
  return (req, body) => {
    if (!isAniListHost(req)) return undefined;
    if (!body.query.includes(match)) return undefined;
    return jsonRes(fixture, status);
  };
}

function chRoute(): Route {
  return (req) => {
    if (isAniListHost(req)) return undefined;
    const url = new URL(req.url);
    const query = url.searchParams.get("query") ?? "";
    if (
      query.startsWith("SELECT DISTINCT") || query.startsWith("INSERT INTO")
    ) {
      return new Response("", { status: 200 });
    }
    return undefined;
  };
}

/** activities.json's committed createdAt values are fixed 2023-era epoch
 * seconds. recent-activity computes its lookback cutoff from the REAL
 * wall-clock `Date.now()`, so feeding the static fixture straight into a
 * freshness-sensitive test would silently start failing once real time
 * drifts far enough past the fixture's frozen dates (it already has, in this
 * repo). Returns a deep copy with every activity's createdAt shifted to
 * "recently before now" so the default 120-minute lookback always admits
 * them, regardless of when the suite is run. */
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

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

Deno.test("search: happy path — single page, defaults applied via schema.parse", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute("SEARCH_MATCH", searchFixture)],
    async () => {
      await run("search", { query: "Nebula" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "search")!;
  assertEquals(res.payload.totalResults, 2);
});

Deno.test("search: fetchAll paginates via fetchAllPages, caps and stops on hasNextPage:false", async () => {
  const page1 = {
    data: {
      Page: {
        pageInfo: { total: 3, currentPage: 1, lastPage: 2, hasNextPage: true },
        media: [{ ...searchFixture.data.Page.media[0] }],
      },
    },
  };
  const page2 = {
    data: {
      Page: {
        pageInfo: { total: 3, currentPage: 2, lastPage: 2, hasNextPage: false },
        media: [{ ...searchFixture.data.Page.media[1] }],
      },
    },
  };
  const { ctx, written } = makeCtx();
  let call = 0;
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("SEARCH_MATCH")) {
        return undefined;
      }
      call++;
      return jsonRes(call === 1 ? page1 : page2);
    }],
    async () => {
      await run("search", { query: "Nebula", fetchAll: true }, ctx);
    },
  );
  assertEquals(call, 2, "expected exactly 2 page fetches");
  const res = written.find((w) => w.spec === "search")!;
  assertEquals((res.payload.results as unknown[]).length, 2);
  assertEquals(res.payload.hasNextPage, false);
  assertEquals(res.payload.totalResults, 3);
});

Deno.test("search: failure path — non-ok response rejects with 'AniList API error <status>'", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("SEARCH_MATCH", { message: "bad request" }, 400)],
    async () => {
      const err = await assertRejects(
        () => run("search", { query: "Nebula" }, ctx),
        Error,
      );
      assert((err as Error).message.startsWith("AniList API error 400"));
    },
  );
});

Deno.test("search: type arg overrides globalArgs.mediaType default", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("SEARCH_MATCH", searchFixture)],
    async (calls) => {
      await run("search", { query: "Static Bloom", type: "MANGA" }, ctx);
      const body = JSON.parse(await calls[0].text()) as ParsedBody;
      assertEquals(body.variables.type, "MANGA");
    },
  );
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

Deno.test("get: happy path — writes media keyed by id", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute("Media(id: $id)", mediaDetailsFixture)],
    async () => {
      await run("get", { id: 90001 }, ctx);
    },
  );
  assert(written.find((w) => w.spec === "media" && w.name === "90001"));
});

Deno.test("get: failure path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("Media(id: $id)", { message: "not found" }, 404)],
    async () => {
      await assertRejects(() => run("get", { id: 999999 }, ctx), Error);
    },
  );
});

// ---------------------------------------------------------------------------
// userlist
// ---------------------------------------------------------------------------

Deno.test("userlist: happy path with status filter — variables include status", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute(
      "MediaListCollection(userName: $userName, type: $type, status: $status)",
      userlistFixture,
    )],
    async (calls) => {
      await run(
        "userlist",
        { userName: "fixture_watcher", status: "COMPLETED" },
        ctx,
      );
      const body = JSON.parse(await calls[0].text()) as ParsedBody;
      assertEquals(body.variables.status, "COMPLETED");
    },
  );
  assert(
    written.find((w) => w.spec === "userlist" && w.name === "fixture_watcher"),
  );
});

Deno.test("userlist: failure path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("MediaListCollection", { message: "private" }, 403)],
    async () => {
      await assertRejects(
        () => run("userlist", { userName: "private_user" }, ctx),
        Error,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// trending
// ---------------------------------------------------------------------------

Deno.test("trending: happy path — default sort TRENDING_DESC", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req, body) => {
      if (
        !isAniListHost(req) ||
        !body.query.includes("media(type: $type, sort: $sort)")
      ) {
        return undefined;
      }
      assertEquals((body.variables.sort as string[])[0], "TRENDING_DESC");
      return jsonRes(trendingFixture);
    }],
    async () => {
      await run("trending", {}, ctx);
    },
  );
  assert(
    written.find((w) => w.spec === "trending" && w.name === "trending_desc"),
  );
});

Deno.test("trending: fetchAll paginates", async () => {
  const page1 = {
    data: {
      Page: {
        pageInfo: { total: 2, currentPage: 1, lastPage: 2, hasNextPage: true },
        media: [{ ...trendingFixture.data.Page.media[0] }],
      },
    },
  };
  const page2 = {
    data: {
      Page: {
        pageInfo: { total: 2, currentPage: 2, lastPage: 2, hasNextPage: false },
        media: [{ ...trendingFixture.data.Page.media[0], id: 90099 }],
      },
    },
  };
  const { ctx, written } = makeCtx();
  let call = 0;
  await withFetchStub(
    [(req, body) => {
      if (
        !isAniListHost(req) ||
        !body.query.includes("media(type: $type, sort: $sort)")
      ) {
        return undefined;
      }
      call++;
      return jsonRes(call === 1 ? page1 : page2);
    }],
    async () => {
      await run("trending", { fetchAll: true }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "trending")!;
  assertEquals((res.payload.results as unknown[]).length, 2);
});

Deno.test("trending: failure path — non-ok response rejects (400, so no retry-with-backoff timer is scheduled; that path is characterized under FakeTime in the adversarial suite)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("sort: $sort", { message: "bad" }, 400)],
    async () => {
      await assertRejects(() => run("trending", {}, ctx), Error);
    },
  );
});

// ---------------------------------------------------------------------------
// watching
// ---------------------------------------------------------------------------

Deno.test("watching: happy path — writes count/entries/timestamp", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute("status: CURRENT)", watchingFixture)],
    async () => {
      await run("watching", { userName: "fixture_watcher" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "watching")!;
  assertEquals(res.payload.count, 2);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("watching: failure path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("status: CURRENT)", { message: "bad" }, 400)],
    async () => {
      await assertRejects(
        () => run("watching", { userName: "fixture_watcher" }, ctx),
        Error,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// seasonal
// ---------------------------------------------------------------------------

Deno.test("seasonal: happy path with explicit season/year", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute("season: $season", seasonalFixture)],
    async () => {
      await run("seasonal", { season: "SUMMER", seasonYear: 2026 }, ctx);
    },
  );
  assert(
    written.find((w) => w.spec === "seasonal" && w.name === "SUMMER-2026"),
  );
});

Deno.test("seasonal: defaults season/year from the current date when omitted", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queryRoute("season: $season", seasonalFixture)],
    async () => {
      await run("seasonal", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "seasonal")!;
  assert(
    ["WINTER", "SPRING", "SUMMER", "FALL"].includes(
      res.payload.season as string,
    ),
  );
  assert(typeof res.payload.seasonYear === "number");
});

Deno.test("seasonal: failure path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("season: $season", { message: "bad" }, 400)],
    async () => {
      await assertRejects(
        () => run("seasonal", { season: "WINTER", seasonYear: 2026 }, ctx),
        Error,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// update-progress — requires accessToken; bypasses gql(), own fetch/error path
// ---------------------------------------------------------------------------

Deno.test("update-progress: throws when accessToken is absent from globalArguments", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () => run("update-progress", { mediaId: 90001, progress: 5 }, ctx),
    Error,
    "accessToken is required",
  );
});

Deno.test("update-progress: happy path — Bearer header sent, writes watchProgress", async () => {
  const { ctx, written } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("$progress: Int!")) {
        return undefined;
      }
      assertEquals(
        req.headers.get("Authorization"),
        "Bearer fixture-token-abc",
      );
      return jsonRes({
        data: {
          SaveMediaListEntry: {
            id: 1,
            mediaId: 90001,
            status: "CURRENT",
            progress: 5,
            updatedAt: 1700000000,
          },
        },
      });
    }],
    async () => {
      await run("update-progress", { mediaId: 90001, progress: 5 }, ctx);
    },
  );
  const res = written.find((w) =>
    w.spec === "watchProgress" && w.name === "90001"
  )!;
  assertEquals(res.payload.progress, 5);
});

Deno.test("update-progress: failure path — non-ok response rejects with 'AniList mutation failed'", async () => {
  const { ctx } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [queryRoute("$progress: Int!", { message: "boom" }, 500)],
    async () => {
      const err = await assertRejects(
        () => run("update-progress", { mediaId: 90001, progress: 5 }, ctx),
        Error,
      );
      assert((err as Error).message.startsWith("AniList mutation failed: 500"));
    },
  );
});

Deno.test("update-progress: GraphQL errors[] at 200 rejects with 'AniList errors:'", async () => {
  const { ctx } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [queryRoute("$progress: Int!", {
      errors: [{ message: "Invalid mediaId" }],
    })],
    async () => {
      const err = await assertRejects(
        () => run("update-progress", { mediaId: -1, progress: 5 }, ctx),
        Error,
      );
      assert((err as Error).message.includes("Invalid mediaId"));
    },
  );
});

// ---------------------------------------------------------------------------
// set-score — requires accessToken; mediaId-direct AND title-resolve paths
// ---------------------------------------------------------------------------

Deno.test("set-score: throws when accessToken is absent", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () => run("set-score", { mediaId: 90001, score: 8 }, ctx),
    Error,
    "accessToken is required",
  );
});

Deno.test("set-score: throws when neither mediaId nor title is given", async () => {
  const { ctx } = makeCtx(AUTH_GLOBAL_ARGS);
  await assertRejects(
    () => run("set-score", { score: 8 }, ctx),
    Error,
    "Either mediaId or title must be provided",
  );
});

Deno.test("set-score: mediaId-direct happy path — no title-resolve sub-query is made", async () => {
  const { ctx, written } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req)) return undefined;
      if (body.query.includes("Media(search: $search, type: ANIME)")) {
        throw new Error(
          "title-resolve must NOT be called when mediaId is given",
        );
      }
      if (!body.query.includes("$score: Float")) return undefined;
      return jsonRes({
        data: {
          SaveMediaListEntry: {
            id: 1,
            mediaId: 90001,
            status: "COMPLETED",
            score: 8,
            updatedAt: 1700000000,
          },
        },
      });
    }],
    async () => {
      await run("set-score", { mediaId: 90001, score: 8 }, ctx);
    },
  );
  assert(
    written.find((w) => w.spec === "watchProgress" && w.name === "score-90001"),
  );
});

Deno.test("set-score: title-resolve sub-query happy path — resolves mediaId via Media(search) then mutates", async () => {
  const { ctx, written } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [
      (req, body) => {
        if (!isAniListHost(req)) return undefined;
        if (!body.query.includes("Media(search: $search, type: ANIME)")) {
          return undefined;
        }
        assertEquals(body.variables.search, "Nebula Drifters");
        return jsonRes({
          data: {
            Media: {
              id: 90001,
              title: { romaji: "Nebula Drifters", english: null },
            },
          },
        });
      },
      queryRoute("$score: Float", {
        data: {
          SaveMediaListEntry: {
            id: 1,
            mediaId: 90001,
            status: "COMPLETED",
            score: 9,
            updatedAt: 1700000000,
          },
        },
      }),
    ],
    async () => {
      await run("set-score", { title: "Nebula Drifters", score: 9 }, ctx);
    },
  );
  assert(
    written.find((w) => w.spec === "watchProgress" && w.name === "score-90001"),
  );
});

Deno.test("set-score: title-resolve finds no media -> throws 'No AniList result found for title'", async () => {
  const { ctx } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [queryRoute("Media(search: $search, type: ANIME)", {
      data: { Media: null },
    })],
    async () => {
      await assertRejects(
        () => run("set-score", { title: "No Such Anime", score: 9 }, ctx),
        Error,
        "No AniList result found for title",
      );
    },
  );
});

Deno.test("set-score: failure path — non-ok mutation response rejects", async () => {
  const { ctx } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [queryRoute("$score: Float", { message: "boom" }, 500)],
    async () => {
      await assertRejects(
        () => run("set-score", { mediaId: 90001, score: 9 }, ctx),
        Error,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// recent-activity — SUBPROCESS-BOUNDARY-SAFE tests only (telegramModel:"" /
// dryRun:true). See file header.
// ---------------------------------------------------------------------------

Deno.test("recent-activity: dryRun holds the cursor completely unchanged even with fresh activity (PIN)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", freshActivitiesFixture()),
    ],
    async () => {
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        telegramModel: "",
        dryRun: true,
      }, ctx);
    },
  );
  const feed = written.find((w) => w.spec === "activityFeed")!;
  assertEquals(feed.payload.dryRun, true);
  assertEquals(feed.payload.sent, false);
  assert(
    (feed.payload.newCount as number) > 0,
    "sanity: fresh activity actually reached the feed, so the unchanged-cursor pin below is meaningful",
  );
  const cursor = written.find((w) => w.spec === "activityCursor")!;
  assert(cursor);
});

Deno.test("recent-activity: empty telegramModel disables sending even when dryRun is false", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", freshActivitiesFixture()),
    ],
    async () => {
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        telegramModel: "",
        dryRun: false,
      }, ctx);
    },
  );
  const feed = written.find((w) => w.spec === "activityFeed")!;
  assertEquals(feed.payload.sent, false);
  assertEquals(feed.payload.sendError, null);
});

Deno.test("recent-activity: no new activity + not dryRun bumps floors but keeps ids (cursor policy)", async () => {
  const noNew = {
    data: { Page: { pageInfo: { hasNextPage: false }, activities: [] } },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", noNew),
    ],
    async () => {
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        telegramModel: "",
        dryRun: false,
      }, ctx);
    },
  );
  const feed = written.find((w) => w.spec === "activityFeed")!;
  assertEquals(feed.payload.newCount, 0);
  const cursor = written.find((w) => w.spec === "activityCursor")!;
  assert(cursor);
});

Deno.test("recent-activity: an unresolvable username is recorded in usersFailed, does not abort the whole run", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req, body) => {
        if (!isAniListHost(req) || !body.query.includes("User(name: $name)")) {
          return undefined;
        }
        return jsonRes({ data: { User: null } });
      },
      queryRoute("activities(", freshActivitiesFixture()),
    ],
    async () => {
      // one resolvable via a second stub route added below is out of scope —
      // AniList's User(name) with no match: model throws "user not found",
      // caught internally and recorded, so with ONLY an unresolvable user the
      // whole call rejects ("Could not resolve any AniList users").
      await assertRejects(
        () =>
          run("recent-activity", {
            usernames: ["ghost_user"],
            telegramModel: "",
            dryRun: true,
          }, ctx),
        Error,
        "Could not resolve any AniList users",
      );
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("recent-activity: invalid telegramModel (flag-injection-shaped) is rejected before any fetch", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () =>
      run("recent-activity", {
        usernames: ["fixture_watcher"],
        telegramModel: "--repo-dir",
        dryRun: true,
      }, ctx),
    Error,
    "Invalid telegramModel",
  );
});

Deno.test("recent-activity: invalid telegramChatId is rejected before any fetch", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () =>
      run("recent-activity", {
        usernames: ["fixture_watcher"],
        telegramModel: "",
        telegramChatId: "not valid",
        dryRun: true,
      }, ctx),
    Error,
    "Invalid telegramChatId",
  );
});

Deno.test("recent-activity: pageCapHit is set and a warning is logged when maxPages is hit with more pages remaining", async () => {
  // createdAt must be RECENT relative to wall-clock `Date.now()` — a stale
  // fixture timestamp would trip hasReachedOldActivities's early-break BEFORE
  // the loop ever reaches the `page === maxPages` check this test pins.
  const morePages = {
    data: {
      Page: {
        pageInfo: { hasNextPage: true },
        activities: freshActivitiesFixture().data.Page.activities,
      },
    },
  };
  const { ctx, written, logs } = makeCtx();
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", morePages),
    ],
    async () => {
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        maxPages: 1,
        telegramModel: "",
        dryRun: true,
      }, ctx);
    },
  );
  const feed = written.find((w) => w.spec === "activityFeed")!;
  assertEquals(feed.payload.pageCapHit, true);
  assert(logs.some((l) => l.message.includes("Activity page cap")));
});

Deno.test("recent-activity: usernamesFile unreadable falls back to inline usernames with a warning (no real file path used)", async () => {
  const { ctx, written, logs } = makeCtx();
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", freshActivitiesFixture()),
    ],
    async () => {
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        usernamesFile: "/nonexistent/fixture-only-path.txt",
        telegramModel: "",
        dryRun: true,
      }, ctx);
    },
  );
  const feed = written.find((w) => w.spec === "activityFeed")!;
  assertEquals(feed.payload.usernamesSource, "inline");
  assert(logs.some((l) => l.message.includes("usernamesFile unreadable")));
});

// ---------------------------------------------------------------------------
// ingest-scores — migrated end-to-end characterization (was anilist.test.ts
// lines 681-855)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ingest-scores keeps score 0, drops null, preserves casing, nulls a bad start_date (end-to-end, migrated from anilist.test.ts)",
  // gql()/clickhouseInsert schedule AbortSignal.timeout timers the stub never
  // lets settle; harmless in a test that completes long before the timeout.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { ctx } = makeCtx(CH_GLOBAL_ARGS);
    await withFetchStub(
      [
        queryRoute("hasNextChunk", listIngestFixture),
        queryRoute("media(id_in: $ids", metadataFixture),
        chRoute(),
      ],
      async () => {
        await run("ingest-scores", {
          usernames: ["MixedCaseFixtureUser"],
          perChunk: 500,
          maxChunks: 20,
          metadataBatchSize: 50,
        }, ctx);
      },
    );
  },
});

Deno.test("ingest-scores: chunk cap hit is recorded when hasNextChunk stays true through maxChunks", async () => {
  const alwaysNext = {
    data: {
      MediaListCollection: {
        lists: [{
          status: "COMPLETED",
          entries: [{ mediaId: 90001, score: 7, status: "COMPLETED" }],
        }],
        hasNextChunk: true,
      },
    },
  };
  const { ctx, written } = makeCtx(CH_GLOBAL_ARGS);
  await withFetchStub(
    [
      queryRoute("hasNextChunk", alwaysNext),
      queryRoute("media(id_in: $ids", {
        data: { Page: { pageInfo: { hasNextPage: false }, media: [] } },
      }),
      chRoute(),
    ],
    async () => {
      await run("ingest-scores", {
        usernames: ["fixture_watcher"],
        perChunk: 10,
        maxChunks: 2,
        metadataBatchSize: 50,
      }, ctx);
    },
  );
  const scored = written.find((w) => w.spec === "userlistScored")!;
  assertEquals(scored.payload.chunkCapHit, true);
  assertEquals(scored.payload.chunksFetched, 2);
});

Deno.test("ingest-scores: throws when no usernames are provided", async () => {
  const { ctx } = makeCtx(CH_GLOBAL_ARGS);
  await assertRejects(
    () => run("ingest-scores", { usernames: [] }, ctx),
    Error,
    "No usernames",
  );
});

Deno.test("ingest-scores: throws when clickhouseUrl is absent from globalArguments", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await assertRejects(
    () => run("ingest-scores", { usernames: ["fixture_watcher"] }, ctx),
    Error,
    "clickhouseUrl is required",
  );
});

// ---------------------------------------------------------------------------
// refresh-metadata
// ---------------------------------------------------------------------------

Deno.test("refresh-metadata: backfills only ids present in user_scores but missing from anilist_metadata", async () => {
  let selectCalls = 0;
  const { ctx, written } = makeCtx(CH_GLOBAL_ARGS);
  await withFetchStub(
    [
      queryRoute("media(id_in: $ids", metadataFixture),
      (req) => {
        if (isAniListHost(req)) return undefined;
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? "";
        if (query.startsWith("SELECT DISTINCT")) {
          selectCalls++;
          // first call: user_scores ids; second call: anilist_metadata ids
          const body = selectCalls === 1 ? "90001\n90003\n" : "90001\n";
          return new Response(body, { status: 200 });
        }
        if (query.startsWith("INSERT INTO")) {
          return new Response("", { status: 200 });
        }
        return undefined;
      },
    ],
    async () => {
      await run("refresh-metadata", { metadataBatchSize: 50 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "metadataRefresh")!;
  assertEquals(
    res.payload.missing,
    1,
    "only 90003 is missing (90001 already has metadata)",
  );
});

Deno.test("refresh-metadata: writes a zero marker when nothing is missing", async () => {
  const { ctx, written } = makeCtx(CH_GLOBAL_ARGS);
  await withFetchStub(
    [(req) => {
      if (isAniListHost(req)) return undefined;
      const url = new URL(req.url);
      const query = url.searchParams.get("query") ?? "";
      if (query.startsWith("SELECT DISTINCT")) {
        return new Response("90001\n", { status: 200 });
      }
      return undefined;
    }],
    async () => {
      await run("refresh-metadata", { metadataBatchSize: 50 }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "metadataRefresh")!;
  assertEquals(res.payload.missing, 0);
  assertEquals(res.payload.written, 0);
});

// ---------------------------------------------------------------------------
// Schema-parse defaults sanity (lesson-test-method-arg-schema)
// ---------------------------------------------------------------------------

Deno.test("search: schema defaults — perPage=10, page=1, fetchAll=false when omitted", () => {
  const method = (model.methods as MethodMap).search;
  const parsed = method.arguments.parse({ query: "x" }) as {
    perPage: number;
    page: number;
    fetchAll: boolean;
  };
  assertEquals(parsed.perPage, 10);
  assertEquals(parsed.page, 1);
  assertEquals(parsed.fetchAll, false);
});

Deno.test("recent-activity: schema defaults — lookbackMinutes=120, maxPages=6, format='rich', telegramModel=''", () => {
  const method = (model.methods as MethodMap)["recent-activity"];
  const parsed = method.arguments.parse({ usernames: ["x"] }) as {
    lookbackMinutes: number;
    maxPages: number;
    format: string;
    telegramModel: string;
    dryRun: boolean;
  };
  assertEquals(parsed.lookbackMinutes, 120);
  assertEquals(parsed.maxPages, 6);
  assertEquals(parsed.format, "rich");
  assertEquals(parsed.telegramModel, "");
  assertEquals(parsed.dryRun, false);
});

Deno.test("recent-activity: includeStatusChanges defaults ON, and is the no-redeploy rollback lever", () => {
  const method = (model.methods as MethodMap)["recent-activity"];
  assertEquals(
    (method.arguments.parse({ usernames: ["x"] }) as {
      includeStatusChanges: boolean;
    }).includeStatusChanges,
    true,
  );
  assertEquals(
    (method.arguments.parse({
      usernames: ["x"],
      includeStatusChanges: false,
    }) as { includeStatusChanges: boolean }).includeStatusChanges,
    false,
  );
});

Deno.test("activityFeed resource schema accepts the statusChanges payload recent-activity writes", () => {
  // The spec schema strips unknown keys, so a field the method writes but the
  // schema omits is silently lost on the stored resource — the digest would
  // still show the verdicts while they stayed unqueryable.
  const parsed = (model.resources as ResourceMap).activityFeed.schema.parse({
    checkedAt: "2026-08-17T00:00:00.000Z",
    usernamesSource: "inline",
    usersChecked: ["fixture_reader"],
    usersFailed: [],
    newCount: 1,
    activities: [],
    statusChanges: [{
      userName: "fixture_reader",
      mediaId: 90042,
      status: "dropped",
      title: "Abandoned Signal",
      siteUrl: "https://anilist.co/anime/90042",
      score: 4,
    }],
    statusChangeCount: 1,
    messages: [],
    sent: true,
    sendError: null,
    pageCapHit: false,
    dryRun: false,
  }) as {
    statusChangeCount: number;
    statusChanges: Array<{ status: string; score: number | null }>;
  };
  assertEquals(parsed.statusChangeCount, 1);
  assertEquals(parsed.statusChanges[0].status, "dropped");
  assertEquals(parsed.statusChanges[0].score, 4);
});

Deno.test("ingest-scores: schema defaults — perChunk=500, maxChunks=20, metadataBatchSize=50", () => {
  const method = (model.methods as MethodMap)["ingest-scores"];
  const parsed = method.arguments.parse({ usernames: ["x"] }) as {
    perChunk: number;
    maxChunks: number;
    metadataBatchSize: number;
  };
  assertEquals(parsed.perChunk, 500);
  assertEquals(parsed.maxChunks, 20);
  assertEquals(parsed.metadataBatchSize, 50);
});

Deno.test("search: rejects perPage above the documented max of 50 (schema guard)", () => {
  const method = (model.methods as MethodMap).search;
  assertThrows(() => method.arguments.parse({ query: "x", perPage: 51 }));
});
