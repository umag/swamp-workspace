/**
 * Contract-fixture suite: pins the CONCRETE Dawarich API wire shape from
 * dawarich/fixtures/*.json directly, independent of dawarich.ts's resource
 * schemas (several of which use `z.unknown()` and would happily accept a
 * drifted shape). This suite hardcodes the expected field mapping from the
 * documented Dawarich REST API so a real wire-format drift turns a test red
 * (see STANDARD.md's contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made.
 *
 * dawarich.ts is BYTE-FROZEN by this change — every test characterizes
 * already-shipped behavior. It is not red-green TDD.
 *
 * This module also defines and exports SYNTHETIC_COORDS — the single,
 * canonical set of allowed GPS coordinate values. It is enumerated exactly
 * ONCE here and re-used (imported, never redefined) by the coordinate scan in
 * dawarich_adversarial_test.ts, per the plan-review HIGH finding (round 1,
 * ADV-2) that this must be an exact-value membership set, not a region.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./dawarich.ts";
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
// SYNTHETIC_COORDS — the canonical, exact-value coordinate allowlist.
//
// Five globally documented, public tourist landmarks, each about as far from
// the Netherlands/Italy as the globe allows. Equality membership only — never
// a bounding box or region (see fixtures/PROVENANCE.md, "PRIMARY control").
// ---------------------------------------------------------------------------

export const SYNTHETIC_COORDS: ReadonlySet<number> = new Set<number>([
  -33.8568,
  151.2153, // Sydney Opera House, Australia
  -22.9519,
  -43.2105, // Christ the Redeemer, Rio de Janeiro, Brazil
  27.9881,
  86.9250, // Mount Everest summit, Nepal/China border
  -25.3444,
  131.0369, // Uluru / Ayers Rock, Australia
  -54.8019,
  -68.3030, // Ushuaia, Argentina (world's southernmost city)
]);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "https://dawarich.example.com",
  apiKey: "dw_test_stub_do_not_log",
};

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

/** Install a fetch stub that returns `body` as a 200 JSON response for the
 * duration of `fn`. Uses the plan-mandated `as unknown as typeof
 * globalThis.fetch` bridge (not a direct `as typeof globalThis.fetch` cast) —
 * CI runs deno 2.8.3 while local dev may be on 2.7.x, and the direct cast
 * risks a CI-only deno-check break. */
function withFixture(body: unknown, fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as unknown as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

/** Recursively collect every number found under a coordinate-shaped key. */
function collectCoordinateValues(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const v of value) collectCoordinateValues(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        /^(lat|lng|lon|latitude|longitude)$/i.test(k) &&
        typeof v === "number"
      ) {
        out.push(v);
      } else {
        collectCoordinateValues(v, out);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// health.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: health.json — health's status is JSON.stringify(data) for an object body", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(health, () => run("health", {}, ctx));
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.status, JSON.stringify(health));
  assert(typeof res.payload.timestamp === "string");
});

// ---------------------------------------------------------------------------
// stats.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: stats.json — stats stores the whole StatsSerializer response verbatim under `stats`", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(stats, () => run("stats", { year: 2026 }, ctx));
  const res = written.find((w) => w.spec === "stats")!;
  assertEquals(res.payload.stats, stats);
  assertEquals(res.payload.year, 2026);
  assertEquals(res.name, "2026");
});

Deno.test("contract: stats.json has no coordinate-shaped fields (sanity — this fixture is exempt from the coordinate scan)", () => {
  assertEquals(collectCoordinateValues(stats), []);
});

// ---------------------------------------------------------------------------
// points.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: points.json — points stores the bare array verbatim, count == length", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(points, () => run("points", {}, ctx));
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.points, points);
  assertEquals(res.payload.count, points.length);
});

Deno.test("contract: points.json — every latitude/longitude leaf is a member of SYNTHETIC_COORDS", () => {
  const coords = collectCoordinateValues(points);
  assert(coords.length > 0, "sanity: points.json must contain coordinates");
  for (const c of coords) {
    assert(SYNTHETIC_COORDS.has(c), `${c} is not in SYNTHETIC_COORDS`);
  }
});

// ---------------------------------------------------------------------------
// tracked-months.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: tracked-months.json — tracked-months stores the bare array verbatim under `months`", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(trackedMonths, () => run("tracked-months", {}, ctx));
  const res = written.find((w) => w.spec === "trackedMonths")!;
  assertEquals(res.payload.months, trackedMonths);
  assertEquals(res.name, "all");
});

// ---------------------------------------------------------------------------
// visits.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: visits.json — visits stores the bare array verbatim, count == length", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(visits, () => run("visits", {}, ctx));
  const res = written.find((w) => w.spec === "visits")!;
  assertEquals(res.payload.visits, visits);
  assertEquals(res.payload.count, visits.length);
});

Deno.test("contract: visits.json — every latitude/longitude leaf is a member of SYNTHETIC_COORDS", () => {
  const coords = collectCoordinateValues(visits);
  assert(coords.length > 0, "sanity: visits.json must contain coordinates");
  for (const c of coords) {
    assert(SYNTHETIC_COORDS.has(c), `${c} is not in SYNTHETIC_COORDS`);
  }
});

// ---------------------------------------------------------------------------
// tracks.json contract — a deliberately SIMPLIFIED array shape; see
// fixtures/PROVENANCE.md for why the real GeoJSON envelope is exercised via
// an inline literal in the adversarial suite instead of here.
// ---------------------------------------------------------------------------

Deno.test("contract: tracks.json — tracks stores the bare array verbatim, count == length", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(tracks, () => run("tracks", {}, ctx));
  const res = written.find((w) => w.spec === "tracks")!;
  assertEquals(res.payload.tracks, tracks);
  assertEquals(res.payload.count, tracks.length);
});

Deno.test("contract: tracks.json — every latitude/longitude leaf is a member of SYNTHETIC_COORDS", () => {
  const coords = collectCoordinateValues(tracks);
  assert(coords.length > 0, "sanity: tracks.json must contain coordinates");
  for (const c of coords) {
    assert(SYNTHETIC_COORDS.has(c), `${c} is not in SYNTHETIC_COORDS`);
  }
});

// ---------------------------------------------------------------------------
// settings.json contract — the documented double-wrap
// ---------------------------------------------------------------------------

Deno.test("contract: settings.json — settings does NOT unwrap the {settings, status} envelope; the whole response becomes the `settings` field", async () => {
  // Pin: the live Dawarich GET /api/v1/settings response wraps its payload as
  // {settings: {...}, status: "success"} (see PROVENANCE.md). settings.json is
  // authored as that REAL wrapped shape on purpose — dawarich.ts's `settings`
  // method stores `result.data` (the whole wrapped envelope) verbatim under
  // its own `settings` resource field, producing a double-nested shape. If
  // this fixture were "helpfully" flattened to just the inner config object,
  // this test would pin a shape the code never produces.
  const { ctx, written } = makeCtx();
  await withFixture(settings, () => run("settings", {}, ctx));
  const res = written.find((w) => w.spec === "settings")!;
  assertEquals(res.payload.settings, settings);
  assertEquals(
    (res.payload.settings as typeof settings).settings.timezone,
    "Europe/Amsterdam",
  );
});

Deno.test("contract: settings.json has no coordinate-shaped fields (sanity)", () => {
  assertEquals(collectCoordinateValues(settings), []);
});

// ---------------------------------------------------------------------------
// digests.json contract — the documented double-wrap
// ---------------------------------------------------------------------------

Deno.test("contract: digests.json — digests does NOT unwrap the {digests, availableYears} envelope", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(digests, () => run("digests", { year: 2026 }, ctx));
  const res = written.find((w) => w.spec === "digests")!;
  assertEquals(res.payload.digests, digests);
  assertEquals(res.name, "2026");
});

Deno.test("contract: digests.json has no coordinate-shaped fields (sanity)", () => {
  assertEquals(collectCoordinateValues(digests), []);
});

// ---------------------------------------------------------------------------
// photos.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: photos.json — photos stores the bare array verbatim, count == length", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(photos, () => run("photos", {}, ctx));
  const res = written.find((w) => w.spec === "photos")!;
  assertEquals(res.payload.photos, photos);
  assertEquals(res.payload.count, photos.length);
});

Deno.test("contract: photos.json — every latitude/longitude leaf is a member of SYNTHETIC_COORDS", () => {
  const coords = collectCoordinateValues(photos);
  assert(coords.length > 0, "sanity: photos.json must contain coordinates");
  for (const c of coords) {
    assert(SYNTHETIC_COORDS.has(c), `${c} is not in SYNTHETIC_COORDS`);
  }
});

// ---------------------------------------------------------------------------
// Whole-corpus sanity — every fixture that carries any coordinate leaf is
// entirely drawn from SYNTHETIC_COORDS (belt-and-braces over the per-file
// tests above).
// ---------------------------------------------------------------------------

Deno.test("contract: SYNTHETIC_COORDS has exactly 10 values (5 landmark lat/lng pairs)", () => {
  assertEquals(SYNTHETIC_COORDS.size, 10);
});

Deno.test("contract: the full fixture corpus contains no coordinate leaf outside SYNTHETIC_COORDS", () => {
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
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const c of collectCoordinateValues(data)) {
      if (!SYNTHETIC_COORDS.has(c)) violations.push(`${file}: ${c}`);
    }
  }
  assertEquals(violations, []);
});
