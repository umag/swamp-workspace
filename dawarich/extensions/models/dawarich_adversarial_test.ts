/**
 * Adversarial suite: api_key exposure (doubled — testable URL-query proof +
 * server-echo trust-boundary pin), hostile/malformed responses (including
 * the CONFIRMED-real GeoJSON tracks defect), coordinate/timestamp parsing
 * edges, pagination edges, raw query-param injection, update-settings
 * mutation asymmetry/idempotency pins, and the mechanical
 * fixtures-secret-scan + EXACT-VALUE coordinate-allowlist scan over
 * dawarich/fixtures/*.json.
 *
 * dawarich.ts is BYTE-FROZEN — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Where a test documents a real gap, it is labeled "pin" and says so
 * explicitly. See fixtures/PROVENANCE.md for the doubled GPS-data-discipline
 * rationale and the local `dawarich-hardening` bug for the tracked follow-up.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./dawarich.ts";
import { SYNTHETIC_COORDS } from "./dawarich_test.ts";
import health from "../../fixtures/health.json" with { type: "json" };
import stats from "../../fixtures/stats.json" with { type: "json" };
import points from "../../fixtures/points.json" with { type: "json" };
import trackedMonths from "../../fixtures/tracked-months.json" with {
  type: "json",
};
import visits from "../../fixtures/visits.json" with { type: "json" };
import tracks from "../../fixtures/tracks.json" with { type: "json" };
import settings from "../../fixtures/settings.json" with { type: "json" };
import digests from "../../fixtures/digests.json" with { type: "json" };
import photos from "../../fixtures/photos.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const BASE_URL = "https://dawarich.example.com";
const API_KEY = "dw_stub_api_key";

const GLOBAL_ARGS = { baseUrl: BASE_URL, apiKey: API_KEY };

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

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

function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

// ---------------------------------------------------------------------------
// api_key exposure — DOUBLED (testable proof + documented residual gap)
// ---------------------------------------------------------------------------

Deno.test("pin: the api_key is present in the captured request URL query — proves it rides on the URL, hence any URL-bearing surface (proxy log, fetch network error, CLI trace) would expose it", async () => {
  // This is the TESTABLE half of the exposure. The other half — that a real
  // fetch-level network rejection propagates Deno's own error message, which
  // contains the URL and hence the key — is NOT offline-testable: every test
  // in this suite REPLACES globalThis.fetch with our own stub, so a
  // thrown/rejected error here would be OUR sentinel string, not Deno's real
  // "error sending request for url (...)" message. A test that asserted the
  // key leaks via a network-level rejection would only be asserting a leak
  // we hand-authored into the stub — self-fulfilling and misleading. That
  // consequence is instead documented in CHANGELOG.md and fixtures/PROVENANCE.md
  // as a residual, non-offline-testable gap (round-1 plan-review HIGH finding
  // ADV-1, resolved in plan v2).
  const { ctx } = makeCtx();
  await withOneResponse({ status: "ok" }, 200, async (calls) => {
    await run("health", {}, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("api_key"), API_KEY);
  });
});

Deno.test("pin: a hostile server echoing the api_key in an error response body surfaces it via the thrown error's <text>", async () => {
  // apiRequest() does not sanitize the SERVER's response body before
  // embedding it in the thrown `Dawarich API error <status>: <text>` message.
  // A hostile or misconfigured server that echoes the key back (e.g. a
  // verbose auth-failure page) would have that echoed value surfaced to
  // whatever reads the error. Distinct sentinel key from the rest of this
  // suite so this test cannot pass by accident.
  const sentinelKey = "dw_trust_boundary_sentinel_0001";
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(
        `Unauthorized: your api_key '${sentinelKey}' was rejected`,
        { status: 401, headers: { "Content-Type": "text/plain" } },
      )],
    async () => {
      const err = await assertRejects(
        () =>
          run("health", {}, {
            ...ctx,
            globalArgs: { baseUrl: BASE_URL, apiKey: sentinelKey },
          }),
        Error,
      );
      assert(
        String(err).includes(sentinelKey),
        "sanity: the hostile server's echoed key must actually surface — proves the trust-boundary gap exists",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Hostile / malformed responses — the silent Array.isArray(...) ? data : []
// coercion, across every array-returning method
// ---------------------------------------------------------------------------

Deno.test("pin: points silently coerces a non-array truthy object body to []", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ unexpected: "shape" }, 200, async () => {
    await run("points", {}, ctx);
  });
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.points, []);
  assertEquals(res.payload.count, 0);
});

Deno.test("pin: points silently coerces a non-array truthy STRING body to []", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse("not-an-array", 200, async () => {
    await run("points", {}, ctx);
  });
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.points, []);
});

Deno.test("pin: visits silently coerces a non-array truthy body to []", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ unexpected: "shape" }, 200, async () => {
    await run("visits", {}, ctx);
  });
  const res = written.find((w) => w.spec === "visits")!;
  assertEquals(res.payload.visits, []);
  assertEquals(res.payload.count, 0);
});

Deno.test("pin: photos silently coerces a non-array truthy body to []", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ unexpected: "shape" }, 200, async () => {
    await run("photos", {}, ctx);
  });
  const res = written.find((w) => w.spec === "photos")!;
  assertEquals(res.payload.photos, []);
});

Deno.test("pin: tracked-months silently coerces a non-array truthy body to []", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ unexpected: "shape" }, 200, async () => {
    await run("tracked-months", {}, ctx);
  });
  const res = written.find((w) => w.spec === "trackedMonths")!;
  assertEquals(res.payload.months, []);
});

Deno.test("tracks: a FALSY (null) body does NOT crash — the coercion catches exactly this case, contrast with the truthy cases above", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(null, 200, async () => {
    await run("tracks", {}, ctx);
  });
  const res = written.find((w) => w.spec === "tracks")!;
  assertEquals(res.payload.tracks, []);
});

Deno.test("ESCALATED pin: the REAL live Dawarich GET /api/v1/tracks response (a GeoJSON FeatureCollection object) silently collapses tracks to [] — confirmed, not hypothetical", async () => {
  // Unlike the generic hostile-response pins above, this is not a made-up
  // malformed shape. Freika/dawarich's actual serializer
  // (app/serializers/tracks/geojson_serializer.rb) returns
  // `{ type: "FeatureCollection", features: [...] }` for GET /api/v1/tracks —
  // confirmed by reading the live source, not inferred. dawarich.ts's guard
  // `Array.isArray(result.data) ? result.data : []` is ALWAYS false against
  // this real, currently-shipped response shape, so the `tracks` method
  // silently and permanently returns zero tracks against production Dawarich
  // today, with no error surfaced. See fixtures/PROVENANCE.md and the local
  // `dawarich-hardening` bug (escalated MEDIUM item). This inline literal
  // (not a committed fixture file) is deliberately the REAL envelope shape —
  // tracks.json itself stays a simplified array for consistency with its
  // fixture siblings.
  const realGeoJsonTracksResponse = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[86.9250, 27.9881]] },
        properties: { id: 9001, distance: 15234 },
      },
    ],
  };
  const { ctx, written } = makeCtx();
  await withOneResponse(realGeoJsonTracksResponse, 200, async () => {
    await run("tracks", {}, ctx);
  });
  const res = written.find((w) => w.spec === "tracks")!;
  assertEquals(
    res.payload.tracks,
    [],
    "the real GeoJSON envelope is an object, not an array — Array.isArray is false and every track is silently dropped",
  );
  assertEquals(res.payload.count, 0);
});

// ---------------------------------------------------------------------------
// Coordinate / timestamp parsing edges — hostile point shapes pass through
// UNFILTERED (dawarich.ts never parses or validates coordinates)
// ---------------------------------------------------------------------------

Deno.test("pin: a point with missing latitude/longitude passes through unfiltered", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    [{ id: 1, timestamp: "2026-01-01T00:00:00Z" }],
    200,
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  const stored = (res.payload.points as Array<Record<string, unknown>>)[0];
  assert(!("latitude" in stored));
  assert(!("longitude" in stored));
});

Deno.test("pin: a point with STRING-typed coordinates passes through unfiltered (no type coercion or validation)", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    [{ id: 1, latitude: "not-a-number", longitude: "also-not-a-number" }],
    200,
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  const stored = (res.payload.points as Array<Record<string, unknown>>)[0];
  assertEquals(stored.latitude, "not-a-number");
  assertEquals(stored.longitude, "also-not-a-number");
});

Deno.test("pin: a point with OUT-OF-RANGE latitude/longitude (e.g. lat=999) passes through unfiltered — no bounds checking", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    [{ id: 1, latitude: 999, longitude: -999 }],
    200,
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  const stored = (res.payload.points as Array<Record<string, unknown>>)[0];
  assertEquals(stored.latitude, 999);
  assertEquals(stored.longitude, -999);
});

Deno.test("pin: 'null island' (0, 0) — a real-world GPS-glitch sentinel, not a synthetic fixture value — passes through unfiltered", async () => {
  // 0/0 is a well-known GPS anomaly sentinel (equator/prime-meridian
  // intersection), deliberately never used as a SYNTHETIC_COORDS member —
  // this is a HOSTILE/edge-case probe value, not fixture data, so it is an
  // inline literal here rather than anything committed to fixtures/.
  const { ctx, written } = makeCtx();
  await withOneResponse(
    [{ id: 1, latitude: 0, longitude: 0 }],
    200,
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  const stored = (res.payload.points as Array<Record<string, unknown>>)[0];
  assertEquals(stored.latitude, 0);
  assertEquals(stored.longitude, 0);
});

Deno.test("pin: an injection string in a place_name/address-shaped field passes through unfiltered and is stored raw", async () => {
  const { ctx, written } = makeCtx();
  const hostilePlaceName = "'; DROP TABLE visits; --<script>alert(1)</script>";
  await withOneResponse(
    [{
      id: 1,
      latitude: -22.9519,
      longitude: -43.2105,
      place_name: hostilePlaceName,
    }],
    200,
    async () => {
      await run("visits", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "visits")!;
  const stored = (res.payload.visits as Array<Record<string, unknown>>)[0];
  assertEquals(stored.place_name, hostilePlaceName);
});

Deno.test("pin: the model never parses response timestamps — it stamps its OWN new Date().toISOString(), independent of any timestamp in the response body", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    [{
      id: 1,
      latitude: -33.8568,
      longitude: 151.2153,
      timestamp: "not-a-real-date",
    }],
    200,
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  assert(typeof res.payload.timestamp === "string");
  assert(
    !Number.isNaN(Date.parse(res.payload.timestamp as string)),
    "the resource's own timestamp is always a valid ISO string regardless of hostile data in the response body",
  );
});

Deno.test("pin: photos' startAt/endAt are OPTIONAL in the schema even though the real documented GET /api/v1/photos endpoint requires start_date/end_date — calling photos() with no args sends a request the live API would likely reject", async () => {
  // The Dawarich OpenAPI spec documents `start_date`/`end_date` as REQUIRED
  // query parameters for GET /api/v1/photos. dawarich.ts's `photos` method
  // schema makes startAt/endAt both `.optional()` with no cross-field
  // requirement — calling `photos({})` builds a request with NEITHER param,
  // which a real Dawarich instance would likely reject. Not offline-testable
  // against the real API (this stub always returns 200), so this pin
  // documents the SCHEMA-vs-DOCS mismatch: the client-side schema is looser
  // than the server's actual contract. Filed as an addendum on the local
  // `dawarich-hardening` bug.
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("photos", {}, ctx);
    const url = new URL(calls[0].url);
    assert(
      !url.searchParams.has("start_at") && !url.searchParams.has("end_at"),
      "photos() with no args sends neither start_at nor end_at, despite the real API documenting both as required",
    );
  });
});

// ---------------------------------------------------------------------------
// Pagination edges
// ---------------------------------------------------------------------------

Deno.test("pin: X-Current-Page/X-Total-Pages ABSENT -> currentPage/totalPages are undefined", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse([], 200, async () => {
    await run("points", {}, ctx);
  });
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.currentPage, undefined);
  assertEquals(res.payload.totalPages, undefined);
});

Deno.test("pin: a NON-NUMERIC X-Current-Page header silently parses to NaN, not an error", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Current-Page": "not-a-number",
        },
      })],
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  assert(
    Number.isNaN(res.payload.currentPage),
    "parseInt of garbage yields NaN, not undefined or a thrown error",
  );
});

Deno.test("pin: visits/tracks/photos accept a `page` ARGUMENT but never read response pagination HEADERS — asymmetric with points", async () => {
  for (const method of ["visits", "tracks", "photos"] as const) {
    const { ctx, written } = makeCtx();
    await withFetchStub(
      [() =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Current-Page": "3",
            "X-Total-Pages": "10",
          },
        })],
      async () => {
        await run(method, { page: 2 }, ctx);
      },
    );
    const specByMethod: Record<string, string> = {
      visits: "visits",
      tracks: "tracks",
      photos: "photos",
    };
    const res = written.find((w) => w.spec === specByMethod[method])!;
    assert(
      !("currentPage" in res.payload) && !("totalPages" in res.payload),
      `${method}: unlike points, it must never expose pagination header fields`,
    );
  }
});

// ---------------------------------------------------------------------------
// Query-param injection — raw interpolation, no encodeURIComponent
// ---------------------------------------------------------------------------

Deno.test("pin: startAt containing '&' INJECTS an extra query parameter (no encodeURIComponent)", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("points", { startAt: "2026-01-01&admin=1" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("start_at"), "2026-01-01");
    assertEquals(
      url.searchParams.get("admin"),
      "1",
      "an unescaped '&' in startAt injected a sibling query param",
    );
  });
});

Deno.test("pin: endAt containing '&' injects an extra query parameter on visits", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("visits", { endAt: "2026-02-01&per_page=99999" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("per_page"), "99999");
  });
});

Deno.test("pin: digests year containing an injected string is NOT possible (year is typed number) but period_type has no such guard — a raw string flows straight into the query", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    // periodType's zod enum blocks arbitrary strings at the argument-parse
    // boundary (only "yearly"/"monthly" are accepted) — but this pin proves
    // there is no SECOND layer of escaping in the URL-building code itself:
    // an accepted enum value is interpolated raw, same as every other param.
    await run("digests", { year: 2026, periodType: "monthly" }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.search.includes("period_type=monthly"), true);
  });
});

Deno.test("pin: order='asc&page=999' is rejected by the zod enum BEFORE it ever reaches the URL (order has no injection surface, unlike startAt/endAt)", async () => {
  // `arguments.parse()` throws SYNCHRONOUSLY (zod validation runs before
  // `execute()` is ever invoked, so no Promise exists yet at that point) —
  // wrap in an async callback so assertRejects sees a rejection rather than
  // a synchronous throw (which it treats as a distinct failure mode: "Function
  // throws when expected to reject").
  const { ctx } = makeCtx();
  await assertRejects(
    async () => await run("points", { order: "asc&page=999" }, ctx),
  );
});

// ---------------------------------------------------------------------------
// update-settings — guard asymmetry + mutation idempotency pins
// ---------------------------------------------------------------------------

Deno.test("pin: update-settings' timezone uses a TRUTHY guard — an explicit empty string is OMITTED from the body", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("update-settings", { timezone: "" }, ctx);
    const body = JSON.parse(await calls[0].text() || "{}");
    assert(
      !("timezone" in body),
      "an empty-string timezone is falsy — dropped, not sent as ''",
    );
  });
});

Deno.test("pin: update-settings' liveMapEnabled uses an EXISTENCE guard (!== undefined) — false is PRESERVED, asymmetric with timezone's truthy guard", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("update-settings", { liveMapEnabled: false }, ctx);
    const body = JSON.parse(await calls[0].text() || "{}");
    assertEquals(
      body.live_map_enabled,
      false,
      "false is sent, unlike an empty-string timezone",
    );
  });
});

Deno.test("pin: update-settings is NOT idempotent in the ordinary sense — repeating identical args sends two independent PATCHes", async () => {
  const { ctx } = makeCtx();
  let patches = 0;
  await withFetchStub(
    [(req) => {
      if (new URL(req.url).pathname === "/api/v1/settings") {
        patches++;
        return json({});
      }
      return undefined;
    }],
    async (calls) => {
      await run("update-settings", { timezone: "UTC" }, ctx);
      await run("update-settings", { timezone: "UTC" }, ctx);
      assertEquals(calls.length, 2, "no dedup — two independent PATCHes");
    },
  );
});

Deno.test("pin: update-settings' writeResource uses the SAME fixed name (current) on every call — the second call clobbers the first in a real instance", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, async () => {
    await run("update-settings", { timezone: "UTC" }, ctx);
    await run("update-settings", { timezone: "Europe/Amsterdam" }, ctx);
  });
  const names = written.filter((w) => w.spec === "settings").map((w) => w.name);
  assertEquals(names, ["current", "current"]);
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan + EXACT-VALUE coordinate-allowlist scan — mechanical
// backstops over the committed corpus (see fixtures/PROVENANCE.md)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "vault key name API_KEY", re: /\bAPI_KEY\b/ },
  { name: "vault key name DAWARICH_ prefix", re: /\bDAWARICH_[A-Z_]*\b/ },
  {
    name: "dawarich api_key shape (20+ alnum, high-entropy)",
    re: /^[A-Za-z0-9]{20,}$/,
  },
  {
    name: "generic high-entropy token-shaped value (32+, base64url-ish)",
    re: /^[A-Za-z0-9+/_=]{32,}$/,
  },
];

/** Recursively collect every string leaf value in a parsed JSON structure. */
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

/** Recursively collect {path, key, value} for every NUMBER found under a
 * coordinate-shaped key name (lat/lng/lon/latitude/longitude) — keyed on
 * FIELD NAME, never on "every numeric leaf", so year/month/count/pagination
 * integers elsewhere in these fixtures are never false-flagged (round-2
 * plan-review LOW finding, folded in). */
function collectCoordinateLeaves(
  value: unknown,
  path = "$",
  out: Array<{ path: string; value: number }> = [],
): Array<{ path: string; value: number }> {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectCoordinateLeaves(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        /^(lat|lng|lon|latitude|longitude)$/i.test(k) &&
        typeof v === "number"
      ) {
        out.push({ path: `${path}.${k}`, value: v });
      } else {
        collectCoordinateLeaves(v, `${path}.${k}`, out);
      }
    }
  }
  return out;
}

// Secondary tripwire only — a COARSE, country-level Netherlands bounding box.
// The exact-value SYNTHETIC_COORDS allowlist above is the PRIMARY control;
// this box exists purely as defense-in-depth and is deliberately kept at
// whole-country granularity so it never itself commits a precise coordinate.
const NL_COUNTRY_BOX = {
  minLat: 50.75,
  maxLat: 53.7,
  minLng: 3.2,
  maxLng: 7.22,
};

function isInDenylistBox(
  lat: number,
  lng: number,
  box: typeof NL_COUNTRY_BOX,
): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng &&
    lng <= box.maxLng;
}

const FIXTURES: Record<string, unknown> = {
  "health.json": health,
  "stats.json": stats,
  "points.json": points,
  "tracked-months.json": trackedMonths,
  "visits.json": visits,
  "tracks.json": tracks,
  "settings.json": settings,
  "digests.json": digests,
  "photos.json": photos,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(str)) {
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

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected secret shape", () => {
  const violations: string[] = [];
  const poisoned = { key: "a".repeat(40) };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a high-entropy 40-char blob",
  );
});

Deno.test("coordinate-allowlist-scan: every latitude/longitude leaf in the committed fixture corpus is an EXACT member of SYNTHETIC_COORDS", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const { path, value } of collectCoordinateLeaves(data)) {
      if (!SYNTHETIC_COORDS.has(value)) {
        violations.push(`${file}${path} = ${value}`);
      }
    }
  }
  assertEquals(
    violations,
    [],
    `coordinate value(s) outside SYNTHETIC_COORDS found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("coordinate-allowlist-scan: sanity — a real-looking coordinate ABSENT from SYNTHETIC_COORDS is flagged", () => {
  // A famous, PUBLIC landmark coordinate (the Eiffel Tower) — real-looking,
  // definitely not a private location, and deliberately NOT a member of
  // SYNTHETIC_COORDS — proves the scan actually rejects membership rather
  // than being vacuously true. Never use the user's own precise location for
  // this poison value (fixtures/PROVENANCE.md's "no precise private
  // coordinate in source" rule applies to test code too).
  const poisoned = { point: { latitude: 48.8584, longitude: 2.2945 } };
  const leaves = collectCoordinateLeaves(poisoned);
  assertEquals(
    leaves.length,
    2,
    "sanity: both fields must be detected as coordinate-shaped",
  );
  const violations = leaves.filter((l) => !SYNTHETIC_COORDS.has(l.value));
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real-looking coordinate outside the allowlist",
  );
});

Deno.test("coordinate-allowlist-scan: field-name selectivity — year/month/count/pagination integers are NEVER treated as coordinates", () => {
  // Guards the round-2 plan-review LOW finding directly: a naive "every
  // numeric leaf" scan would false-flag stats.json's totalDistanceKm=12345.6
  // or points.json's id=1001 as if they were coordinates. This asserts the
  // scanner is selective on FIELD NAME, not blind to shape.
  const nonCoordinateNumbers = {
    year: 2026,
    month: 7,
    count: 42,
    currentPage: 3,
    totalPages: 9,
    id: 1001,
    totalDistanceKm: 12345.6,
  };
  assertEquals(collectCoordinateLeaves(nonCoordinateNumbers), []);
});

Deno.test("denylist-box (secondary tripwire): no committed fixture coordinate falls inside the coarse NL country box", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    // Pair up latitude/longitude siblings within the same object.
    const pairs = collectLatLngPairs(data);
    for (const { path, lat, lng } of pairs) {
      if (isInDenylistBox(lat, lng, NL_COUNTRY_BOX)) {
        violations.push(`${file}${path} = (${lat}, ${lng})`);
      }
    }
  }
  assertEquals(violations, []);
});

Deno.test("denylist-box (secondary tripwire): sanity — a coordinate pair inside the NL box is flagged", () => {
  // A coarse, well-known public reference point roughly in the middle of the
  // Netherlands (Utrecht Dom Tower) — public knowledge at country/city
  // granularity, not a precise private address — proves the box actually
  // catches something.
  assert(isInDenylistBox(52.0907, 5.1214, NL_COUNTRY_BOX));
});

Deno.test("denylist-box (secondary tripwire): sanity — every SYNTHETIC_COORDS landmark falls OUTSIDE the NL box", () => {
  const pairs: Array<[number, number]> = [
    [-33.8568, 151.2153],
    [-22.9519, -43.2105],
    [27.9881, 86.9250],
    [-25.3444, 131.0369],
    [-54.8019, -68.3030],
  ];
  for (const [lat, lng] of pairs) {
    assert(
      !isInDenylistBox(lat, lng, NL_COUNTRY_BOX),
      `(${lat}, ${lng}) unexpectedly inside the NL box`,
    );
  }
});

/** Pairs up sibling `latitude`/`longitude` keys within the same object (does
 * not attempt cross-object pairing). Used only by the secondary denylist
 * tripwire — the primary allowlist scan above checks each field
 * independently. */
function collectLatLngPairs(
  value: unknown,
  path = "$",
  out: Array<{ path: string; lat: number; lng: number }> = [],
): Array<{ path: string; lat: number; lng: number }> {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectLatLngPairs(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const latKey = Object.keys(obj).find((k) => /^(lat|latitude)$/i.test(k));
    const lngKey = Object.keys(obj).find((k) =>
      /^(lng|lon|longitude)$/i.test(k)
    );
    if (
      latKey && lngKey && typeof obj[latKey] === "number" &&
      typeof obj[lngKey] === "number"
    ) {
      out.push({
        path,
        lat: obj[latKey] as number,
        lng: obj[lngKey] as number,
      });
    }
    for (const [k, v] of Object.entries(obj)) {
      collectLatLngPairs(v, `${path}.${k}`, out);
    }
  }
  return out;
}
