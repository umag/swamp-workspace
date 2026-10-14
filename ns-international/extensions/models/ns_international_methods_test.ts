/**
 * Methods suite for @magistr/ns-international: every method's success and
 * failure paths, with `fetch` stubbed.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./ns_international.ts";
import {
  json,
  makeCtx,
  table,
  text,
  withFetch,
} from "./ns_international_harness_test.ts";
import stationsFixture from "../../fixtures/stations.json" with {
  type: "json",
};
import tripsFixture from "../../fixtures/trips.json" with { type: "json" };

const CACHED = {
  syncedAt: "2026-09-01T00:00:00.000Z",
  count: 2,
  stations: [
    { code: "ASD", uic: "8400058", name: "Amsterdam Centraal", country: "NL" },
    { code: "UT", uic: "8400621", name: "Utrecht Centraal", country: "NL" },
  ],
};

// ─── stations ────────────────────────────────────────────────────────────────

Deno.test("stations: query filters by name or code, case-insensitive", async () => {
  const { ctx } = makeCtx();
  const result = await withFetch(
    table({ "/v2/stations": () => json(stationsFixture) }),
    () => model.methods.stations.execute({ query: "AMSTERDAM" }, ctx),
  );
  assertEquals(result.count, 4);
  assertEquals(result.matched, 2);
});

Deno.test("stations: query matches on code too", async () => {
  const { ctx } = makeCtx();
  const result = await withFetch(
    table({ "/v2/stations": () => json(stationsFixture) }),
    () => model.methods.stations.execute({ query: "berhbt" }, ctx),
  );
  assertEquals(result.matched, 1);
});

Deno.test("stations: an empty payload caches zero stations", async () => {
  const { ctx, written } = makeCtx();
  const result = await withFetch(
    table({ "/v2/stations": () => json({}) }),
    () => model.methods.stations.execute({}, ctx),
  );
  assertEquals(result.count, 0);
  assertEquals(written[0].payload.stations, []);
});

Deno.test("stations: HTTP 401 rejects and writes nothing", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "/v2/stations": () => text("Access denied", 401) }),
    async () => {
      await assertRejects(
        () => model.methods.stations.execute({}, ctx),
        Error,
        "NS API 401 for /v2/stations: Access denied",
      );
    },
  );
  assertEquals(written.length, 0);
});

// ─── plan ────────────────────────────────────────────────────────────────────

Deno.test("plan: uses the cached station-index instead of fetching", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  await withFetch(
    table({ "/v3/trips": () => json(tripsFixture) }),
    async (calls) => {
      const r = await model.methods.plan.execute(
        { from: "asd", to: "Utrecht Centraal", searchForArrival: false },
        ctx,
      );
      assertEquals(calls.length, 1);
      assert(calls[0].url.pathname.endsWith("/v3/trips"));
      assertEquals(r.count, 2);
    },
  );
});

Deno.test("plan: an empty cached index falls back to a live fetch", async () => {
  const { ctx } = makeCtx({
    stored: { "station-index": { ...CACHED, stations: [] } },
  });
  await withFetch(
    table({
      "/v2/stations": () => json(stationsFixture),
      "/v3/trips": () => json(tripsFixture),
    }),
    async (calls) => {
      await model.methods.plan.execute(
        { from: "ASD", to: "UT", searchForArrival: false },
        ctx,
      );
      assertEquals(calls.length, 2);
    },
  );
});

Deno.test("plan: a failing datastore read falls back to a live fetch", async () => {
  const { ctx } = makeCtx({ getContentThrows: true });
  const r = await withFetch(
    table({
      "/v2/stations": () => json(stationsFixture),
      "/v3/trips": () => json(tripsFixture),
    }),
    () =>
      model.methods.plan.execute(
        { from: "ASD", to: "UT", searchForArrival: false },
        ctx,
      ),
  );
  assertEquals(r.count, 2);
});

Deno.test("plan: blank dateTime means now", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  const before = Date.now();
  await withFetch(
    table({ "/v3/trips": () => json({ trips: [] }) }),
    async (calls) => {
      const r = await model.methods.plan.execute(
        { from: "ASD", to: "UT", dateTime: "   ", searchForArrival: false },
        ctx,
      );
      const sent = calls[0].url.searchParams.get("dateTime")!;
      assert(new Date(sent).getTime() >= before - 1000);
      assertEquals(r.dateTime, sent);
      assertEquals(r.count, 0);
      assertEquals(calls[0].url.searchParams.has("travelClass"), false);
    },
  );
});

Deno.test("plan: an unknown UIC passes through as international", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  const r = await withFetch(
    table({ "/v3/trips": () => json({ trips: [] }) }),
    async (calls) => {
      const res = await model.methods.plan.execute(
        { from: "ASD", to: "8727100", searchForArrival: false },
        ctx,
      );
      assertEquals(
        calls[0].url.searchParams.get("destinationUicCode"),
        "8727100",
      );
      return res;
    },
  );
  assertEquals(r.to, "UIC 8727100");
  assertEquals(r.international, true);
});

Deno.test("plan: an unmatched station rejects before any trip call", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  await withFetch(table({}), async (calls) => {
    await assertRejects(
      () =>
        model.methods.plan.execute(
          { from: "Atlantis", to: "UT", searchForArrival: false },
          ctx,
        ),
      Error,
      'No station matched "Atlantis"',
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("plan: HTTP 500 from /v3/trips rejects and writes nothing", async () => {
  const { ctx, written } = makeCtx({ stored: { "station-index": CACHED } });
  await withFetch(
    table({ "/v3/trips": () => text("boom", 500) }),
    async () => {
      await assertRejects(
        () =>
          model.methods.plan.execute(
            { from: "ASD", to: "UT", searchForArrival: false },
            ctx,
          ),
        Error,
        "NS API 500 for /v3/trips",
      );
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("plan: a missing trips array yields zero options", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  const r = await withFetch(
    table({ "/v3/trips": () => json({ message: "too far in the future" }) }),
    () =>
      model.methods.plan.execute(
        { from: "ASD", to: "UT", searchForArrival: false },
        ctx,
      ),
  );
  assertEquals(r.count, 0);
  assertEquals(r.options, []);
});

// ─── disruptions ─────────────────────────────────────────────────────────────

Deno.test("disruptions: omits type when not given", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "/v3/disruptions": () => json([]) }),
    async (calls) => {
      const r = await model.methods.disruptions.execute(
        { isActive: true },
        ctx,
      );
      assertEquals(calls[0].url.searchParams.get("isActive"), "true");
      assertEquals(calls[0].url.searchParams.has("type"), false);
      assertEquals(r.count, 0);
    },
  );
});

Deno.test("disruptions: a non-array body yields zero items", async () => {
  const { ctx, written } = makeCtx();
  const r = await withFetch(
    table({ "/v3/disruptions": () => json({ payload: [] }) }),
    () => model.methods.disruptions.execute({ isActive: true }, ctx),
  );
  assertEquals(r.count, 0);
  assertEquals(written.length, 1);
});

Deno.test("disruptions: HTTP 429 rejects", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "/v3/disruptions": () => text("Rate limit is exceeded", 429) }),
    async () => {
      await assertRejects(
        () => model.methods.disruptions.execute({ isActive: true }, ctx),
        Error,
        "NS API 429",
      );
    },
  );
});
