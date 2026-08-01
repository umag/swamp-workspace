/**
 * Method-level tests for @magistr/dawarich — every one of the 10 methods,
 * happy path + error path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` and a fake context.
 *
 * dawarich.ts hardened its api_key transport (dawarich-hardening, 2026.08.01.1):
 * every test here is a characterization test that PINS the model's current,
 * already-shipped behavior. It is not red-green TDD: there is no new behavior
 * to drive out.
 *
 * Token-leak assertions run for every method: the `apiKey` global arg must
 * never appear in a thrown error, a written resource payload, or a logger
 * call. A standalone pin also asserts that NO method calls the logger today,
 * and a dedicated sweep asserts the api_key rides in an Authorization: Bearer
 * HEADER (never the request URL query) for every method — like
 * tubearchivist's Authorization-header token.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./dawarich.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const API_KEY = "dw_test_stub_do_not_log";
const BASE_URL = "https://dawarich.example.com";

const GLOBAL_ARGS = { baseUrl: BASE_URL, apiKey: API_KEY };

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
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
      logger: {
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warning: (...args: unknown[]) => {
          logs.push({ level: "warning", args });
        },
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied,
 * optionals resolved) before execute is invoked — never call execute() with
 * raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request.
 * Uses the plan-mandated `as unknown as typeof globalThis.fetch` bridge
 * (not a direct `as typeof globalThis.fetch` cast) — CI runs deno 2.8.3 while
 * local dev may be on 2.7.x, and the direct cast risks a CI-only
 * deno-check-only break. */
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

/** Single-route stub returning the same body/status to every call. */
function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

Deno.test("health: happy path — GETs /api/v1/health with api_key in an Authorization: Bearer header, never the query", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ status: "ok" }, 200, async (calls) => {
    await run("health", {}, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/v1/health");
    assertEquals(url.searchParams.get("api_key"), null);
    assertEquals(calls[0].method, "GET");
    assertEquals(
      calls[0].headers.get("Authorization"),
      `Bearer ${API_KEY}`,
      "api_key must ride as an Authorization: Bearer header",
    );
  });
  const res = written.find((w) => w.spec === "health");
  assert(res);
  assertEquals(res.payload.status, JSON.stringify({ status: "ok" }));
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("health: a non-object body uses String(data), not JSON.stringify", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })],
    async () => {
      await run("health", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.status, "ok");
});

Deno.test("health: error path — non-ok HTTP status throws with the status + body text", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("service unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })],
    async () => {
      await assertRejects(
        () => run("health", {}, ctx),
        Error,
        "Dawarich API error 503: service unavailable",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

Deno.test("stats: happy path, year only — GETs /api/v1/stats?year=Y, instance name is the bare year", async () => {
  const { ctx, written } = makeCtx();
  const fixture = { totalDistanceKm: 100 };
  await withOneResponse(fixture, 200, async (calls) => {
    await run("stats", { year: 2026 }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/v1/stats");
    assertEquals(url.searchParams.get("year"), "2026");
    assert(!url.searchParams.has("month"));
  });
  const res = written.find((w) => w.spec === "stats");
  assert(res);
  assertEquals(res.name, "2026");
  assertEquals(res.payload.stats, fixture);
  assertEquals(res.payload.month, undefined);
});

Deno.test("stats: happy path, year + month — instance name is zero-padded YYYY-MM", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("stats", { year: 2026, month: 3 }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("month"), "3");
  });
  const res = written.find((w) => w.spec === "stats");
  assert(res);
  assertEquals(res.name, "2026-03");
});

Deno.test("stats: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("stats", { year: 2026 }, ctx),
      Error,
      "Dawarich API error 500",
    );
  });
});

Deno.test("stats: omitting the required `year` argument fails at the parse boundary, before any fetch call", async () => {
  // `arguments.parse()` throws SYNCHRONOUSLY here (zod rejects the missing
  // required field before execute() is ever invoked) — wrap in an async
  // callback so assertRejects sees a rejection, not a bare synchronous throw.
  const { ctx } = makeCtx();
  await assertRejects(async () => await run("stats", {}, ctx));
});

// ---------------------------------------------------------------------------
// points
// ---------------------------------------------------------------------------

Deno.test("points: happy path, no filters — GETs /api/v1/points with no query string at all (api_key rides the header)", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [{ id: 1, latitude: -33.8568, longitude: 151.2153 }];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("points", {}, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/v1/points");
    assertEquals([...url.searchParams.keys()], []);
    assertEquals(calls[0].headers.get("Authorization"), `Bearer ${API_KEY}`);
  });
  const res = written.find((w) => w.spec === "points");
  assert(res);
  assertEquals(res.payload.points, fixture);
  assertEquals(res.payload.count, 1);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("points: with startAt/endAt/page/perPage/order — builds the matching query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("points", {
      startAt: "2026-01-01T00:00:00Z",
      endAt: "2026-02-01T00:00:00Z",
      page: 2,
      perPage: 50,
      order: "desc",
    }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("start_at"), "2026-01-01T00:00:00Z");
    assertEquals(url.searchParams.get("end_at"), "2026-02-01T00:00:00Z");
    assertEquals(url.searchParams.get("page"), "2");
    assertEquals(url.searchParams.get("per_page"), "50");
    assertEquals(url.searchParams.get("order"), "desc");
  });
});

Deno.test("points: pagination headers are parsed to numbers", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Current-Page": "2",
          "X-Total-Pages": "9",
        },
      })],
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.currentPage, 2);
  assertEquals(res.payload.totalPages, 9);
});

Deno.test("points: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("bad request", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      })],
    async () => {
      await assertRejects(
        () => run("points", {}, ctx),
        Error,
        "Dawarich API error 400: bad request",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// tracked-months
// ---------------------------------------------------------------------------

Deno.test("tracked-months: happy path — GETs /api/v1/points/tracked_months", async () => {
  const { ctx, written } = makeCtx();
  const fixture = ["2026-01", "2026-02"];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("tracked-months", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v1/points/tracked_months",
    );
  });
  const res = written.find((w) => w.spec === "trackedMonths");
  assert(res);
  assertEquals(res.payload.months, fixture);
  assertEquals(res.name, "all");
});

Deno.test("tracked-months: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("tracked-months", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// visits
// ---------------------------------------------------------------------------

Deno.test("visits: happy path, no filters — GETs /api/v1/visits", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [{ id: 1, latitude: -22.9519, longitude: -43.2105 }];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("visits", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/v1/visits");
  });
  const res = written.find((w) => w.spec === "visits");
  assert(res);
  assertEquals(res.payload.visits, fixture);
  assertEquals(res.payload.count, 1);
});

Deno.test("visits: with startAt/endAt/page/perPage — builds the matching query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("visits", {
      startAt: "2026-01-01T00:00:00Z",
      endAt: "2026-02-01T00:00:00Z",
      page: 3,
      perPage: 25,
    }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("start_at"), "2026-01-01T00:00:00Z");
    assertEquals(url.searchParams.get("end_at"), "2026-02-01T00:00:00Z");
    assertEquals(url.searchParams.get("page"), "3");
    assertEquals(url.searchParams.get("per_page"), "25");
  });
});

Deno.test("visits: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("visits", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// tracks
// ---------------------------------------------------------------------------

Deno.test("tracks: happy path, no filters — GETs /api/v1/tracks", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [{ id: 1, latitude: 27.9881, longitude: 86.9250 }];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("tracks", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/v1/tracks");
  });
  const res = written.find((w) => w.spec === "tracks");
  assert(res);
  assertEquals(res.payload.tracks, fixture);
  assertEquals(res.payload.count, 1);
});

Deno.test("tracks: with startAt/endAt/page — builds the matching query string (no perPage arg exists for tracks)", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("tracks", {
      startAt: "2026-01-01T00:00:00Z",
      endAt: "2026-02-01T00:00:00Z",
      page: 1,
    }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("start_at"), "2026-01-01T00:00:00Z");
    assertEquals(url.searchParams.get("end_at"), "2026-02-01T00:00:00Z");
    assertEquals(url.searchParams.get("page"), "1");
  });
});

Deno.test("tracks: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("tracks", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

Deno.test("settings: happy path — GETs /api/v1/settings, stores the whole body verbatim", async () => {
  const { ctx, written } = makeCtx();
  const fixture = {
    settings: { timezone: "Europe/Amsterdam" },
    status: "success",
  };
  await withOneResponse(fixture, 200, async (calls) => {
    await run("settings", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/v1/settings");
    assertEquals(calls[0].method, "GET");
  });
  const res = written.find((w) => w.spec === "settings");
  assert(res);
  assertEquals(res.payload.settings, fixture);
});

Deno.test("settings: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("settings", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// update-settings
// ---------------------------------------------------------------------------

Deno.test("update-settings: happy path — PATCHes /api/v1/settings with {timezone, live_map_enabled}", async () => {
  const { ctx, written } = makeCtx();
  const fixture = {
    message: "Settings updated",
    settings: {},
    status: "success",
  };
  await withOneResponse(fixture, 200, async (calls) => {
    await run(
      "update-settings",
      { timezone: "Europe/Amsterdam", liveMapEnabled: true },
      ctx,
    );
    assertEquals(new URL(calls[0].url).pathname, "/api/v1/settings");
    assertEquals(calls[0].method, "PATCH");
    const body = await requestBody(calls[0]);
    assertEquals(body.timezone, "Europe/Amsterdam");
    assertEquals(body.live_map_enabled, true);
  });
  const res = written.find((w) => w.spec === "settings");
  assert(res);
  assertEquals(res.payload.settings, fixture);
});

Deno.test("update-settings: liveMapEnabled=false is still sent (existence guard, not truthy guard)", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("update-settings", { liveMapEnabled: false }, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body.live_map_enabled, false);
    assert(!("timezone" in body));
  });
});

Deno.test("update-settings: no args sends an empty body", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("update-settings", {}, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body, {});
  });
});

Deno.test("update-settings: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(
      () => run("update-settings", { timezone: "UTC" }, ctx),
      Error,
    );
  });
});

// ---------------------------------------------------------------------------
// digests
// ---------------------------------------------------------------------------

Deno.test("digests: happy path, year only — GETs /api/v1/digests?year=Y", async () => {
  const { ctx, written } = makeCtx();
  const fixture = { digests: [], availableYears: [2026] };
  await withOneResponse(fixture, 200, async (calls) => {
    await run("digests", { year: 2026 }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.pathname, "/api/v1/digests");
    assertEquals(url.searchParams.get("year"), "2026");
    assert(!url.searchParams.has("period_type"));
  });
  const res = written.find((w) => w.spec === "digests");
  assert(res);
  assertEquals(res.payload.digests, fixture);
  assertEquals(res.name, "2026");
});

Deno.test("digests: with periodType — includes period_type in the query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("digests", { year: 2026, periodType: "monthly" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("period_type"), "monthly");
  });
});

Deno.test("digests: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("digests", { year: 2026 }, ctx), Error);
  });
});

Deno.test("digests: omitting the required `year` argument fails at the parse boundary, before any fetch call", async () => {
  const { ctx } = makeCtx();
  await assertRejects(async () => await run("digests", {}, ctx));
});

// ---------------------------------------------------------------------------
// photos
// ---------------------------------------------------------------------------

Deno.test("photos: happy path, no filters — GETs /api/v1/photos", async () => {
  const { ctx, written } = makeCtx();
  const fixture = [{ id: "p1", latitude: -33.8568, longitude: 151.2153 }];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("photos", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/v1/photos");
  });
  const res = written.find((w) => w.spec === "photos");
  assert(res);
  assertEquals(res.payload.photos, fixture);
  assertEquals(res.payload.count, 1);
});

Deno.test("photos: with startAt/endAt/page — builds the matching query string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("photos", {
      startAt: "2026-01-01T00:00:00Z",
      endAt: "2026-02-01T00:00:00Z",
      page: 1,
    }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("start_at"), "2026-01-01T00:00:00Z");
    assertEquals(url.searchParams.get("end_at"), "2026-02-01T00:00:00Z");
    assertEquals(url.searchParams.get("page"), "1");
  });
});

Deno.test("photos: error path — non-ok HTTP status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server error", 500, async () => {
    await assertRejects(() => run("photos", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// api_key transport boundary — shared across every method
// ---------------------------------------------------------------------------

const ALL_METHOD_SCENARIOS: Array<
  [string, Record<string, unknown>, unknown]
> = [
  ["health", {}, { status: "ok" }],
  ["stats", { year: 2026 }, {}],
  ["points", {}, []],
  ["tracked-months", {}, []],
  ["visits", {}, []],
  ["tracks", {}, []],
  ["settings", {}, {}],
  ["update-settings", { timezone: "UTC" }, {}],
  ["digests", { year: 2026 }, {}],
  ["photos", {}, []],
];

Deno.test("the api_key rides in an Authorization: Bearer header (never the request URL query) for all 10 methods", async () => {
  assertEquals(
    ALL_METHOD_SCENARIOS.length,
    10,
    "sanity: every method must be covered by the transport-boundary sweep",
  );
  for (const [name, args, response] of ALL_METHOD_SCENARIOS) {
    const { ctx } = makeCtx();
    await withOneResponse(response, 200, async (calls) => {
      await run(name, args, ctx);
      const url = new URL(calls[0].url);
      assertEquals(
        url.searchParams.get("api_key"),
        null,
        `${name}: api_key must not be present in the request URL query`,
      );
      assertEquals(
        calls[0].headers.get("Authorization"),
        `Bearer ${API_KEY}`,
        `${name}: api_key must ride as an Authorization: Bearer header`,
      );
    });
  }
});

Deno.test("the api_key never appears in any written resource across all 10 methods", async () => {
  for (const [name, args, response] of ALL_METHOD_SCENARIOS) {
    const { ctx, written, logs } = makeCtx();
    await withOneResponse(response, 200, async () => {
      await run(name, args, ctx);
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(!s.includes(API_KEY), `${name}: api_key leaked into ${w.spec}`);
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(!s.includes(API_KEY), `${name}: api_key leaked into a log call`);
    }
  }
});

Deno.test("the api_key never appears in a thrown error message for any method's happy-path arguments", async () => {
  for (const [name, args] of ALL_METHOD_SCENARIOS) {
    const { ctx } = makeCtx();
    await withOneResponse(
      `error mentioning nothing sensitive for ${name}`,
      500,
      async () => {
        const err = await assertRejects(() => run(name, args, ctx));
        assert(
          !String(err).includes(API_KEY),
          `${name}: api_key leaked into the thrown error`,
        );
      },
    );
  }
});

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneResponse({ status: "ok" }, 200, async () => {
    await run("health", {}, ctx);
  });
  assertEquals(logs.length, 0);
});

Deno.test("every written resource's timestamp is a string (never asserted by exact value — no Date/timer stub needed)", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ status: "ok" }, 200, async () => {
    await run("health", {}, ctx);
  });
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(typeof res.payload.timestamp, "string");
});
