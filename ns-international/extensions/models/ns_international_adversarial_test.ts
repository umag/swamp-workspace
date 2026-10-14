/**
 * Adversarial suite for @magistr/ns-international: hostile input and hostile
 * network — query-parameter injection, malformed / spec-violating bodies,
 * oversized error bodies, and credential handling.
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
} from "jsr:@std/assert@1";
import { model } from "./ns_international.ts";
import {
  API_KEY,
  GLOBAL_ARGS,
  json,
  makeCtx,
  table,
  text,
  withFetch,
} from "./ns_international_harness_test.ts";

const CACHED = {
  stations: [
    { code: "ASD", uic: "8400058", name: "Amsterdam Centraal", country: "NL" },
    { code: "UT", uic: "8400621", name: "Utrecht Centraal", country: "NL" },
  ],
};

Deno.test("adversarial: a type filter cannot inject extra query params", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "/v3/disruptions": () => json([]) }),
    async (calls) => {
      await model.methods.disruptions.execute(
        { isActive: true, type: "MAINTENANCE&isActive=false#x" },
        ctx,
      );
      const p = calls[0].url.searchParams;
      assertEquals(p.getAll("isActive"), ["true"]);
      assertEquals(p.get("type"), "MAINTENANCE&isActive=false#x");
      assertEquals(calls[0].url.hash, "");
    },
  );
});

Deno.test("adversarial: a hostile dateTime is rejected before any request", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  await withFetch(table({}), async (calls) => {
    await assertRejects(
      () =>
        model.methods.plan.execute({
          from: "ASD",
          to: "UT",
          dateTime: "now&originUicCode=0",
          searchForArrival: false,
        }, ctx),
      Error,
      "dateTime is not ISO-8601",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("adversarial: travelClass outside 1|2 is rejected", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  await withFetch(table({}), async (calls) => {
    for (const travelClass of [0, 3, 1.5, -1]) {
      await assertRejects(
        () =>
          model.methods.plan.execute({
            from: "ASD",
            to: "UT",
            searchForArrival: false,
            travelClass,
          }, ctx),
        Error,
        "travelClass must be 1 or 2",
      );
    }
    assertEquals(calls.length, 0);
  });
});

Deno.test("adversarial: non-JSON 200 body rejects with a bounded excerpt", async () => {
  const { ctx } = makeCtx();
  const html = "<html>" + "x".repeat(5000) + "</html>";
  await withFetch(
    table({ "/v3/disruptions": () => text(html) }),
    async () => {
      const err = await assertRejects(
        () => model.methods.disruptions.execute({ isActive: true }, ctx),
        Error,
        "non-JSON",
      );
      assert(err.message.length < 400);
    },
  );
});

Deno.test("adversarial: an oversized error body is truncated in the message", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "/v2/stations": () => text("E".repeat(10000), 502) }),
    async () => {
      const err = await assertRejects(
        () => model.methods.stations.execute({}, ctx),
        Error,
      );
      assert(err.message.length < 400);
    },
  );
});

Deno.test("adversarial: the api key never appears in errors or stored data", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "/v2/stations": () => text("bad gateway", 502) }),
    async () => {
      const err = await assertRejects(
        () => model.methods.stations.execute({}, ctx),
        Error,
      );
      assertFalse(err.message.includes(API_KEY));
    },
  );
  await withFetch(
    table({ "/v3/disruptions": () => json([]) }),
    () => model.methods.disruptions.execute({ isActive: true }, ctx),
  );
  assertFalse(JSON.stringify(written).includes(API_KEY));
});

Deno.test("adversarial: the api key is never sent in the URL", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "/v3/disruptions": () => json([]) }),
    async (calls) => {
      await model.methods.disruptions.execute({ isActive: true }, ctx);
      assertFalse(calls[0].url.toString().includes(API_KEY));
    },
  );
});

Deno.test("adversarial: an empty api key is rejected before any request", async () => {
  const { ctx } = makeCtx({ globalArgs: { ...GLOBAL_ARGS, apiKey: "  " } });
  await withFetch(table({}), async (calls) => {
    await assertRejects(
      () => model.methods.disruptions.execute({ isActive: true }, ctx),
      Error,
      "apiKey is empty",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("adversarial: null / garbage entries in trips and legs are skipped", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  const r = await withFetch(
    table({
      "/v3/trips": () =>
        json({
          trips: [
            null,
            42,
            "trip",
            {
              legs: [null, { product: null }, "x"],
              fares: { not: "an array" },
              productFare: { priceInCents: "940" },
            },
          ],
        }),
    }),
    () =>
      model.methods.plan.execute(
        { from: "ASD", to: "UT", searchForArrival: false },
        ctx,
      ),
  );
  assertEquals(r.count, 1);
  assertEquals(r.options[0].legs.length, 1);
  assertEquals(r.options[0].legs[0].product, "?");
  assertEquals(r.options[0].priceEuro, undefined);
});

Deno.test("adversarial: a JSON null body does not crash plan or disruptions", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": CACHED } });
  const r = await withFetch(
    table({
      "/v3/trips": () => json(null),
      "/v3/disruptions": () => json([null, 7, { id: 1 }]),
    }),
    async () => ({
      plan: await model.methods.plan.execute(
        { from: "ASD", to: "UT", searchForArrival: false },
        ctx,
      ),
      dis: await model.methods.disruptions.execute({ isActive: true }, ctx),
    }),
  );
  assertEquals(r.plan.count, 0);
  assertEquals(r.dis.count, 1);
  assertEquals(r.dis.items[0].id, "1");
});

Deno.test("adversarial: a corrupt cached station-index falls back to live", async () => {
  const { ctx } = makeCtx({ stored: { "station-index": "{not json" } });
  await withFetch(
    table({
      "/v2/stations": () =>
        json({
          payload: [
            {
              code: "ASD",
              UICCode: "8400058",
              namen: { lang: "A" },
              land: "NL",
            },
            {
              code: "UT",
              UICCode: "8400621",
              namen: { lang: "U" },
              land: "NL",
            },
          ],
        }),
      "/v3/trips": () => json({ trips: [] }),
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

Deno.test("adversarial: a garbage stations payload yields no stations", async () => {
  const { ctx } = makeCtx();
  const r = await withFetch(
    table({ "/v2/stations": () => json({ payload: "nope" }) }),
    () => model.methods.stations.execute({}, ctx),
  );
  assertEquals(r.count, 0);
});
