/**
 * Adversarial suite: attacker's/hostile-network perspective over
 * `@magistr/anilist`'s single upstream contract (the public AniList GraphQL
 * API) plus its ClickHouse charting sink. Covers the two HTTP-200 "hostile
 * success" crash classes, the 429/5xx retry-with-backoff paths (under
 * FakeTime), the fragile 429-in-body detection + module-level shared
 * rate-limit state (both filed as latent bugs in the local
 * `anilist-latent-bugs` issue-lifecycle model — pinned here, NOT fixed),
 * argv-injection guards for the `swamp` subprocess boundary, credential
 * non-leak across every response-body-echoing throw site, hostile activity
 * payload guards, and a fixtures-secret-scan over the full committed corpus.
 *
 * anilist.ts is UNMODIFIED (byte-frozen) — every test here PINS current
 * behavior, including behavior that is a documented latent bug. See
 * `CHANGELOG.md`'s "Follow-up issues" section and the local
 * `anilist-latent-bugs` model for the bug catalogue this suite backs.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { isValidModelName, model } from "./anilist.ts";
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

const GLOBAL_ARGS = { mediaType: "ANIME" as const };
const ACCESS_TOKEN_SENTINEL = "SENTINEL-ACCESS-TOKEN-4b3c2a1f9e8d7c6b";
const CH_PASSWORD_SENTINEL = "SENTINEL-CH-PASSWORD-9f8e7d6c5b4a3928";
const AUTH_GLOBAL_ARGS = { ...GLOBAL_ARGS, accessToken: ACCESS_TOKEN_SENTINEL };
const CH_GLOBAL_ARGS = {
  ...GLOBAL_ARGS,
  clickhouseUrl: "http://ch.fixtures.example:8123",
  clickhouseDatabase: "default",
  clickhouseUser: "default",
  clickhousePassword: CH_PASSWORD_SENTINEL,
};
const FULL_GLOBAL_ARGS = { ...AUTH_GLOBAL_ARGS, ...CH_GLOBAL_ARGS };

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

function queryRoute(
  match: string,
  fixture: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Route {
  return (req, body) => {
    if (!isAniListHost(req)) return undefined;
    if (!body.query.includes(match)) return undefined;
    return jsonRes(fixture, status, headers);
  };
}

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

/** Asserts an elapsed-time measurement is AT LEAST `expectedMs` and within
 * one drain tick (`tickAsync(200)`, see `drainAndAwait` below) of it — never
 * an exact equality. `drainAndAwait`'s 200ms tick granularity means a sleep
 * that resolves mid-tick is only OBSERVED at the next 200ms boundary, so the
 * measured elapsed time is `expectedMs + [0, 200)` in practice, never exactly
 * `expectedMs`. Mirrors the musicbrainz rate-limiter precedent (`>=`
 * assertions, never `===`) for exactly this reason. */
function assertElapsedAtLeast(
  actualMs: number,
  expectedMs: number,
  label: string,
) {
  assert(
    actualMs >= expectedMs && actualMs < expectedMs + 400,
    `${label}: expected elapsed time in [${expectedMs}, ${
      expectedMs + 400
    }), got ${actualMs}`,
  );
}

/** Drains a FakeTime-scheduled promise regardless of how many sequential
 * sleeps it needs (gql()'s 429/5xx retry backoffs, up to 3x60s). Same
 * loop-then-tick shape as the musicbrainz precedent: flush microtasks first
 * (a call needing no wait resolves via microtasks alone), then tick the fake
 * clock in bounded steps so a real hang fails loudly instead of silently
 * truncating. */
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
// (a) HTTP-200 + errors[] — gql() correctly THROWS (anilist got this right,
// unlike the seadex/seanime swallow-bug class). Full narrative pin.
// ---------------------------------------------------------------------------

Deno.test("PIN (anilist got this right): a 200 response with errors[] present causes gql() to THROW, embedding every error message joined — this is the MILDER residual class relative to seadex/seanime, which silently swallow the identical shape", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("Media(id: $id)", graphqlErrorFixture)],
    async () => {
      const err = await assertRejects(
        () => run("get", { id: 90001 }, ctx),
        Error,
      );
      assert((err as Error).message.startsWith("AniList GraphQL errors:"));
      assert(
        (err as Error).message.includes(
          "Something went wrong. Please contact support for more information.",
        ),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (b) HTTP-200 + data:null + NO errors[] — uncaught TypeError downstream
// (BUG, filed in anilist-latent-bugs). Pinned on `search` (non-fetchAll) AND
// on `recent-activity`'s activities loop (which is NOT wrapped in a
// try/catch, unlike the user-id resolution step — this crashes the WHOLE
// fan-out, not just one user).
// ---------------------------------------------------------------------------

Deno.test("BUG PIN: search — 200+data:null+no-errors is NOT special-cased by gql() (only json.errors is checked); the caller's `data.Page.pageInfo` dereference then crashes with an uncaught TypeError", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("SEARCH_MATCH", { data: null })],
    async () => {
      await assertRejects(
        () => run("search", { query: "Nebula" }, ctx),
        TypeError,
      );
    },
  );
});

Deno.test("BUG PIN: recent-activity's per-page activities fetch (unlike the user-id resolution step, which IS try/caught) is not guarded — a 200+data:null+no-errors response on the activities query crashes the ENTIRE fan-out for every tracked user, not just the one whose page returned it", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", { data: null }),
    ],
    async () => {
      await assertRejects(
        () =>
          run("recent-activity", {
            usernames: ["fixture_watcher"],
            telegramModel: "",
            dryRun: true,
          }, ctx),
        TypeError,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (c) Non-JSON 200 body — uncaught SyntaxError (BUG, filed). resp.ok is
// checked before .json() is ever called, so a WAF/CDN error page served at
// HTTP 200 is never mapped into the "AniList API error <status>" message the
// contract suite pins for actual HTTP failures.
// ---------------------------------------------------------------------------

Deno.test("BUG PIN: a 200-OK response with a non-JSON body crashes gql() with an uncaught SyntaxError, not a handled AniList-specific error", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("Media(id: $id)")) {
        return undefined;
      }
      return new Response("<html>not json</html>", {
        status: 200,
        headers: { "X-RateLimit-Remaining": "90", "X-RateLimit-Reset": "0" },
      });
    }],
    async () => {
      await assertRejects(
        () => run("get", { id: 90001 }, ctx),
        SyntaxError,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (d) 429 / 5xx retry-with-backoff, under FakeTime
// ---------------------------------------------------------------------------

Deno.test("RETRY: a 429 status with Retry-After succeeds on the second attempt after sleeping the exact Retry-After duration", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  let calls = 0;
  const t0 = time.now;
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("Media(id: $id)")) {
        return undefined;
      }
      calls++;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "7" },
        });
      }
      return jsonRes(mediaDetailsFixture);
    }],
    () => drainAndAwait(time, run("get", { id: 90001 }, ctx)),
  );
  assertEquals(calls, 2);
  assertElapsedAtLeast(time.now - t0, 7000, "must sleep Retry-After * 1000 ms");
  assert(written.find((w) => w.spec === "media"));
});

Deno.test("RETRY: 429 with no Retry-After header defaults to a 60s wait", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  let calls = 0;
  const t0 = time.now;
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("Media(id: $id)")) {
        return undefined;
      }
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return jsonRes(mediaDetailsFixture);
    }],
    () => drainAndAwait(time, run("get", { id: 90001 }, ctx)),
  );
  assertElapsedAtLeast(time.now - t0, 60_000, "default 429 wait");
});

Deno.test("RETRY: persistent 429 exhausts MAX_RATE_LIMIT_RETRIES(3) and throws — exactly 4 attempts made", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  let calls = 0;
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("Media(id: $id)")) {
        return undefined;
      }
      calls++;
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "1" },
      });
    }],
    () =>
      drainAndAwait(
        time,
        assertRejects(
          () => run("get", { id: 90001 }, ctx),
          Error,
          "retries exhausted",
        ),
      ),
  );
  assertEquals(
    calls,
    4,
    "attempts 0,1,2,3 — the 4th is where attempt>=3 fires",
  );
});

Deno.test("RETRY: persistent 5xx exhausts retries and throws the ORIGINAL 'AniList API error 500' message, not the rate-limit message", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  let calls = 0;
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("Media(id: $id)")) {
        return undefined;
      }
      calls++;
      return new Response("server exploded", { status: 500 });
    }],
    async () => {
      const err = await drainAndAwait(
        time,
        assertRejects(() => run("get", { id: 90001 }, ctx), Error),
      );
      assert((err as Error).message.startsWith("AniList API error 500"));
    },
  );
  assertEquals(calls, 4);
});

Deno.test("RETRY: a transient 5xx followed by a 200 succeeds after the backoff sleep (attempt+1)*5000ms", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  let calls = 0;
  const t0 = time.now;
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("Media(id: $id)")) {
        return undefined;
      }
      calls++;
      if (calls === 1) return new Response("down", { status: 503 });
      return jsonRes(mediaDetailsFixture);
    }],
    () => drainAndAwait(time, run("get", { id: 90001 }, ctx)),
  );
  assertEquals(calls, 2);
  assertElapsedAtLeast(time.now - t0, 5000, "attempt 0 backoff (0+1)*5000ms");
  assert(written.find((w) => w.spec === "media"));
});

Deno.test("RETRY: a 429-in-body (200 status, errors[] contains status:429) sleeps 60s then retries", async () => {
  using time = new FakeTime();
  const { ctx, written } = makeCtx();
  let calls = 0;
  const t0 = time.now;
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("Media(id: $id)")) {
        return undefined;
      }
      calls++;
      if (calls === 1) {
        return jsonRes({
          errors: [{ message: "Too Many Requests.", status: 429 }],
          data: null,
        });
      }
      return jsonRes(mediaDetailsFixture);
    }],
    () => drainAndAwait(time, run("get", { id: 90001 }, ctx)),
  );
  assertEquals(calls, 2);
  assertElapsedAtLeast(time.now - t0, 60_000, "429-in-body wait");
  assert(written.find((w) => w.spec === "media"));
});

// ---------------------------------------------------------------------------
// BUG PIN: 429-in-body detection is FRAGILE — keys on an EXACT `e.status ===
// 429` equality (a strict number comparison). Any shape drift (status as a
// string, or the field renamed/absent) silently bypasses the dedicated retry
// path and falls through to the generic "AniList GraphQL errors" throw
// instead. Filed in anilist-latent-bugs.
// ---------------------------------------------------------------------------

Deno.test('BUG PIN: a 429-in-body whose `status` field is the STRING "429" (not the number 429) is NOT recognized by the exact `e.status === 429` check — it falls through to the generic errors-throw instead of retrying', async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("Media(id: $id)", {
      errors: [{ message: "Too Many Requests.", status: "429" }],
      data: null,
    })],
    async () => {
      const err = await assertRejects(
        () => run("get", { id: 90001 }, ctx),
        Error,
      );
      assert(
        (err as Error).message.startsWith("AniList GraphQL errors:"),
        `expected the generic errors-throw (retry path bypassed) since status is a string, got: ${
          (err as Error).message
        }`,
      );
    },
  );
});

Deno.test("BUG PIN: a 429-in-body with NO `status` field at all (message says 'rate limit' but the shape omits status) also bypasses the dedicated retry path", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queryRoute("Media(id: $id)", {
      errors: [{ message: "You are being rate limited." }],
      data: null,
    })],
    async () => {
      const err = await assertRejects(
        () => run("get", { id: 90001 }, ctx),
        Error,
      );
      assert((err as Error).message.startsWith("AniList GraphQL errors:"));
    },
  );
});

// ---------------------------------------------------------------------------
// BUG PIN: module-level rateLimit COUPLES unrelated requests within one
// process — a low-remaining/future-reset response from one call forces an
// UNRELATED later call to pre-flight-sleep. Filed in anilist-latent-bugs.
// ---------------------------------------------------------------------------

Deno.test("BUG PIN: the module-level `rateLimit` object couples completely unrelated calls — a low-remaining response from ONE method forces the NEXT, logically independent method call to pre-flight-sleep", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  // Prime to a known-healthy baseline regardless of what any earlier test (in
  // this file or a sibling suite sharing the same module instance for the
  // whole `deno test` run) left behind.
  await withFetchStub(
    [queryRoute("Media(id: $id)", mediaDetailsFixture, 200, {
      "X-RateLimit-Remaining": "90",
      "X-RateLimit-Reset": "0",
    })],
    () => drainAndAwait(time, run("get", { id: 90001 }, ctx)),
  );

  const futureResetSec = Math.floor(time.now / 1000) + 5;
  await withFetchStub(
    [queryRoute("Media(id: $id)", mediaDetailsFixture, 200, {
      "X-RateLimit-Remaining": "1",
      "X-RateLimit-Reset": String(futureResetSec),
    })],
    () => drainAndAwait(time, run("get", { id: 90001 }, ctx)),
  );

  const t0 = time.now;
  await withFetchStub(
    [queryRoute("SEARCH_MATCH", searchFixture)],
    () => drainAndAwait(time, run("search", { query: "Nebula" }, ctx)),
  );
  const waited = time.now - t0;
  assert(
    waited > 0,
    `expected the second, UNRELATED search() call to incur a pre-flight wait purely because a PRIOR, different method left rateLimit.remaining<=1 with a future resetAt; waited ${waited}ms`,
  );
});

// ---------------------------------------------------------------------------
// (e) Hostile activity payload — user/media absent yields guarded defaults,
// no crash (anilist.ts already guards this with `?? 0` / `?? "?"`)
// ---------------------------------------------------------------------------

Deno.test("PIN: an activity item with user AND media entirely absent does not crash — mapper falls back to userId:0/userName:''/mediaId:0/title:'?'", async () => {
  // createdAt must be RECENT relative to wall-clock `Date.now()` — recent-
  // activity computes its lookback cutoff from the real current time, so a
  // fixed/stale epoch value would eventually fall outside the default
  // 120-minute window and get filtered out before the guarded-defaults
  // mapping is even reached, making this pin flaky-by-calendar-date.
  const recentCreatedAt = Math.floor(Date.now() / 1000) - 60;
  const hostileActivities = {
    data: {
      Page: {
        pageInfo: { hasNextPage: false },
        activities: [
          {
            id: 800001,
            createdAt: recentCreatedAt,
            status: "watched episode",
            progress: "1",
            user: null,
            media: null,
          },
        ],
      },
    },
  };
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", hostileActivities),
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
  const activities = feed.payload.activities as Array<Record<string, unknown>>;
  assertEquals(activities.length, 1);
  assertEquals(activities[0].userId, 0);
  assertEquals(activities[0].userName, "");
  assertEquals(activities[0].mediaId, 0);
  assertEquals(activities[0].title, "?");
});

Deno.test("PIN: a metadata-batch media entry missing `id` is silently filtered out by refreshMetadata's typeof guard, not a crash", async () => {
  const hostileMetadata = {
    data: {
      Page: {
        pageInfo: { hasNextPage: false },
        media: [
          { id: 90001, title: { romaji: "Nebula Drifters" } },
          { title: { romaji: "No Id Here" } }, // hostile: id entirely absent
        ],
      },
    },
  };
  const { ctx, written } = makeCtx(CH_GLOBAL_ARGS);
  await withFetchStub(
    [
      queryRoute("media(id_in: $ids", hostileMetadata),
      (req) => {
        if (isAniListHost(req)) return undefined;
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? "";
        if (query.startsWith("SELECT DISTINCT")) {
          // user_scores has both ids; anilist_metadata only has 90001
          // already -> 90099 is the gap refresh-metadata must fetch.
          const body = query.includes("user_scores")
            ? "90001\n90099\n"
            : "90001\n";
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
    res.payload.written,
    1,
    "only the media entry WITH a numeric id is written",
  );
});

// ---------------------------------------------------------------------------
// (g) argv-injection guards — isValidModelName + telegramChatId regex, at the
// `swamp` subprocess trust boundary
// ---------------------------------------------------------------------------

Deno.test("INJECTION: isValidModelName rejects flag-injection, semicolon, and space-shaped model names before any subprocess could be spawned", () => {
  assert(!isValidModelName("--repo-dir"));
  assert(!isValidModelName("tg;rm"));
  assert(!isValidModelName("tg bot"));
  assert(!isValidModelName(""));
  assert(isValidModelName("tg-bot"));
  assert(isValidModelName("tg_bot2"));
});

Deno.test("INJECTION: recent-activity rejects a flag-shaped telegramModel via the isValidModelName guard before touching the network", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([], async () => {
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
});

Deno.test("INJECTION: recent-activity's telegramChatId regex accepts numeric ids and @channel handles, rejects everything else", async () => {
  const { ctx } = makeCtx();
  for (const bad of ["not valid", "@ab", "; rm -rf", "12a34"]) {
    await assertRejects(
      () =>
        run("recent-activity", {
          usernames: ["fixture_watcher"],
          telegramModel: "",
          telegramChatId: bad,
          dryRun: true,
        }, ctx),
      Error,
      "Invalid telegramChatId",
      `expected "${bad}" to be rejected`,
    );
  }
  // Valid shapes must NOT throw the validation error (they may still reach
  // the network — routed with fixtures so the call completes).
  await withFetchStub(
    [
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", freshActivitiesFixture()),
    ],
    async () => {
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        telegramModel: "",
        telegramChatId: "-100123456789",
        dryRun: true,
      }, ctx);
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        telegramModel: "",
        telegramChatId: "@fixture_channel",
        dryRun: true,
      }, ctx);
    },
  );
});

// ---------------------------------------------------------------------------
// (f) Credential non-leak across the enumerated response-body-echoing throw
// sites, and across every method's written output/logs
// ---------------------------------------------------------------------------

Deno.test("PIN: gql()'s HTTP-error message embeds the upstream response body VERBATIM — a hostile/compromised server echoing the accessToken back would leak it (trust-boundary pin, no redaction exists)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req, body) => {
      if (!isAniListHost(req) || !body.query.includes("Media(id: $id)")) {
        return undefined;
      }
      return new Response(`echo: apikey=${ACCESS_TOKEN_SENTINEL}`, {
        status: 400,
      });
    }],
    async () => {
      const err = await assertRejects(() => run("get", { id: 90001 }, ctx));
      assert(
        (err as Error).message.includes(ACCESS_TOKEN_SENTINEL),
        "sanity: fixture actually leaks — proves gql() performs no redaction",
      );
    },
  );
});

Deno.test("PIN: update-progress's 'AniList mutation failed' message embeds the upstream body verbatim (truncated at 200 chars) — no redaction", async () => {
  const { ctx } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [queryRoute("$progress: Int!", `leak: ${ACCESS_TOKEN_SENTINEL}`, 400)],
    async () => {
      const err = await assertRejects(
        () => run("update-progress", { mediaId: 90001, progress: 5 }, ctx),
      );
      assert((err as Error).message.includes(ACCESS_TOKEN_SENTINEL));
    },
  );
});

Deno.test("PIN: set-score's 'AniList mutation failed' message embeds the upstream body verbatim — no redaction", async () => {
  const { ctx } = makeCtx(AUTH_GLOBAL_ARGS);
  await withFetchStub(
    [queryRoute("$score: Float", `leak: ${ACCESS_TOKEN_SENTINEL}`, 400)],
    async () => {
      const err = await assertRejects(
        () => run("set-score", { mediaId: 90001, score: 9 }, ctx),
      );
      assert((err as Error).message.includes(ACCESS_TOKEN_SENTINEL));
    },
  );
});

Deno.test("PIN: clickhouseInsert's error message embeds the upstream body verbatim (truncated at 300 chars) — a hostile ClickHouse response echoing the X-ClickHouse-Key header would leak the password", async () => {
  const { ctx } = makeCtx(CH_GLOBAL_ARGS);
  await withFetchStub(
    [
      queryRoute("hasNextChunk", listIngestFixture),
      (req) => {
        if (isAniListHost(req)) return undefined;
        return new Response(`ch error: key=${CH_PASSWORD_SENTINEL}`, {
          status: 403,
        });
      },
    ],
    async () => {
      const err = await assertRejects(
        () =>
          run("ingest-scores", {
            usernames: ["fixture_watcher"],
            perChunk: 500,
            maxChunks: 20,
            metadataBatchSize: 50,
          }, ctx),
      );
      assert((err as Error).message.includes(CH_PASSWORD_SENTINEL));
    },
  );
});

Deno.test("PIN: clickhouseDistinctMediaIds's error message embeds the upstream body verbatim — no redaction", async () => {
  const { ctx } = makeCtx(CH_GLOBAL_ARGS);
  await withFetchStub(
    [(req) => {
      if (isAniListHost(req)) return undefined;
      return new Response(`ch error: key=${CH_PASSWORD_SENTINEL}`, {
        status: 403,
      });
    }],
    async () => {
      const err = await assertRejects(
        () => run("refresh-metadata", { metadataBatchSize: 50 }, ctx),
      );
      assert((err as Error).message.includes(CH_PASSWORD_SENTINEL));
    },
  );
});

Deno.test("Bearer header + X-ClickHouse-Key header carry the real credential values (sanity the mechanism under test exists), while normal (non-hostile) written output NEVER contains either", async () => {
  const { ctx, written } = makeCtx(FULL_GLOBAL_ARGS);
  await withFetchStub(
    [
      (req, body) => {
        if (!isAniListHost(req) || !body.query.includes("$progress: Int!")) {
          return undefined;
        }
        assertEquals(
          req.headers.get("Authorization"),
          `Bearer ${ACCESS_TOKEN_SENTINEL}`,
        );
        return jsonRes({
          data: {
            SaveMediaListEntry: {
              id: 1,
              mediaId: 90001,
              status: "CURRENT",
              progress: 3,
              updatedAt: 1700000000,
            },
          },
        });
      },
      (req) => {
        if (isAniListHost(req)) return undefined;
        assertEquals(req.headers.get("X-ClickHouse-Key"), CH_PASSWORD_SENTINEL);
        return new Response("", { status: 200 });
      },
    ],
    async () => {
      await run("update-progress", { mediaId: 90001, progress: 3 }, ctx);
    },
  );
  for (const w of written) {
    const s = JSON.stringify(w.payload);
    assert(
      !s.includes(ACCESS_TOKEN_SENTINEL),
      `${w.spec}/${w.name}: accessToken leaked into written output`,
    );
    assert(
      !s.includes(CH_PASSWORD_SENTINEL),
      `${w.spec}/${w.name}: clickhousePassword leaked into written output`,
    );
  }
});

Deno.test("credentials never appear in any written resource or log call across every method, given normal (non-hostile) fixture responses", async () => {
  const { ctx, written, logs } = makeCtx(FULL_GLOBAL_ARGS);
  await withFetchStub(
    [
      queryRoute("SEARCH_MATCH", searchFixture),
      queryRoute("Media(id: $id)", mediaDetailsFixture),
      queryRoute(
        "MediaListCollection(userName: $userName, type: $type, status: $status)",
        userlistFixture,
      ),
      queryRoute("media(type: $type, sort: $sort)", trendingFixture),
      queryRoute("season: $season", seasonalFixture),
      queryRoute("status: CURRENT)", watchingFixture),
      queryRoute("$progress: Int!", {
        data: {
          SaveMediaListEntry: {
            id: 1,
            mediaId: 90001,
            status: "CURRENT",
            progress: 1,
            updatedAt: 1700000000,
          },
        },
      }),
      queryRoute("$score: Float", {
        data: {
          SaveMediaListEntry: {
            id: 1,
            mediaId: 90001,
            status: "COMPLETED",
            score: 8,
            updatedAt: 1700000000,
          },
        },
      }),
      queryRoute("User(name: $name)", userIdFixture),
      queryRoute("activities(", freshActivitiesFixture()),
      queryRoute("hasNextChunk", listIngestFixture),
      queryRoute("media(id_in: $ids", metadataFixture),
      (req) => {
        if (isAniListHost(req)) return undefined;
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? "";
        if (query.startsWith("SELECT DISTINCT")) {
          return new Response("90001\n", { status: 200 });
        }
        if (query.startsWith("INSERT INTO")) {
          return new Response("", { status: 200 });
        }
        return undefined;
      },
    ],
    async () => {
      await run("search", { query: "Nebula" }, ctx);
      await run("get", { id: 90001 }, ctx);
      await run("userlist", { userName: "fixture_watcher" }, ctx);
      await run("trending", {}, ctx);
      await run("seasonal", { season: "SUMMER", seasonYear: 2026 }, ctx);
      await run("watching", { userName: "fixture_watcher" }, ctx);
      await run("update-progress", { mediaId: 90001, progress: 1 }, ctx);
      await run("set-score", { mediaId: 90001, score: 8 }, ctx);
      await run("recent-activity", {
        usernames: ["fixture_watcher"],
        telegramModel: "",
        dryRun: true,
      }, ctx);
      await run("ingest-scores", {
        usernames: ["fixture_watcher"],
        perChunk: 500,
        maxChunks: 20,
        metadataBatchSize: 50,
      }, ctx);
      await run("refresh-metadata", { metadataBatchSize: 50 }, ctx);
    },
  );
  for (const w of written) {
    const s = JSON.stringify(w.payload);
    assert(
      !s.includes(ACCESS_TOKEN_SENTINEL),
      `${w.spec}/${w.name}: accessToken leaked into written output`,
    );
    assert(
      !s.includes(CH_PASSWORD_SENTINEL),
      `${w.spec}/${w.name}: clickhousePassword leaked into written output`,
    );
  }
  for (const l of logs) {
    assert(
      !l.includes(ACCESS_TOKEN_SENTINEL),
      `accessToken leaked into a log: ${l}`,
    );
    assert(
      !l.includes(CH_PASSWORD_SENTINEL),
      `clickhousePassword leaked into a log: ${l}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (h) Fixtures-secret-scan — no committed fixture contains a secret-shaped
// string, with a per-pattern poisoned sanity backstop (mirrors
// seadex/musicbrainz precedent). anilist has no hash-shaped field (no
// infoHash equivalent), so only the keyword + high-entropy patterns are
// needed — the hex-40 entropy escape seadex needs is not applicable here.
// ---------------------------------------------------------------------------

function distinctCharCount(s: string): number {
  return new Set(s).size;
}

const SECRET_PATTERNS: Array<{ name: string; test: (s: string) => boolean }> = [
  {
    name: "generic secret/credential keyword",
    test: (s) =>
      /\b(SECRET|PASSWORD|API[_-]?KEY|BEARER|ACCESS[_-]?TOKEN)\b/i
        .test(s),
  },
  {
    name: "high-entropy token-shaped value",
    test: (s) =>
      /^[A-Za-z0-9+/_=-]{32,}$/.test(s) && distinctCharCount(s) >= 10,
  },
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

// SCOPE NOTE (mirrors seadex/musicbrainz precedent): this scan covers only
// the 11 committed fixture JSON files below — it does NOT scan this file's
// (or the other suites') own inline hostile-payload string literals (the
// ACCESS_TOKEN_SENTINEL / CH_PASSWORD_SENTINEL constants above, the inline
// 429-in-body payloads). Those are reviewed manually — see
// `anilist/fixtures/PROVENANCE.md`'s matching SCOPE NOTE.
const FIXTURES: Record<string, unknown> = {
  "search.json": searchFixture,
  "media-details.json": mediaDetailsFixture,
  "userlist.json": userlistFixture,
  "trending.json": trendingFixture,
  "seasonal.json": seasonalFixture,
  "watching.json": watchingFixture,
  "activities.json": activitiesFixture,
  "user-id.json": userIdFixture,
  "list-ingest.json": listIngestFixture,
  "metadata.json": metadataFixture,
  "graphql-error.json": graphqlErrorFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture (all 11, including graphql-error.json) contains a secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, test } of SECRET_PATTERNS) {
        if (test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — each pattern is independently proven to fire against its OWN tailored poison (not just aggregate non-emptiness)", () => {
  const perPatternPoison: Record<string, string> = {
    "generic secret/credential keyword": "API_KEY=abc123def456",
    "high-entropy token-shaped value": "Qx7Lm2Zp9Kv4Tn6Wy1Cs8Dg5Fh0Jr3Ub",
  };
  for (const { name, test } of SECRET_PATTERNS) {
    const poison = perPatternPoison[name];
    assert(poison, `no tailored poison value defined for pattern "${name}"`);
    assert(
      test(poison),
      `pattern "${name}" failed to flag its own tailored poison value "${poison}"`,
    );
  }
});

Deno.test("fixtures-secret-scan: the sentinel constants used elsewhere in THIS suite would themselves be caught by the keyword pattern (proves the scan isn't vacuous against our own test literals, even though they're out of scope per the SCOPE NOTE)", () => {
  assert(SECRET_PATTERNS.some(({ test }) => test(ACCESS_TOKEN_SENTINEL)));
  assert(SECRET_PATTERNS.some(({ test }) => test(CH_PASSWORD_SENTINEL)));
});
