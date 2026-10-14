/**
 * Property suite for @magistr/ns-international (fast-check, FC_NUM_RUNS knob).
 *
 *  (a) resolveStation — any station resolves to itself by code and by UIC.
 *  (b) cheapestFare — the euro price is the minimum positive fare / 100, and
 *      absent iff no fare is positively priced.
 *  (c) buildUrl — every non-empty param round-trips through the query string
 *      exactly once, whatever it contains, and trailing slashes on the base
 *      never change the result.
 *  (d) parseTrip — never throws on arbitrary JSON and transfers are >= 0.
 *  (e) plan flow — against a cached index, the stored option count equals the
 *      number of object trips returned, and the api key never lands in data.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  buildUrl,
  cheapestFare,
  isIsoDateTime,
  model,
  parseTrip,
  type RawTrip,
  resolveStation,
  type Station,
} from "./ns_international.ts";
import {
  API_KEY,
  json,
  makeCtx,
  withFetch,
} from "./ns_international_harness_test.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");

// Unique codes (letters only) and unique 7-digit UICs per directory.
const directory: fc.Arbitrary<Station[]> = fc.uniqueArray(
  fc.record({
    code: fc.stringMatching(/^[A-Z]{2,6}$/),
    uic: fc.integer({ min: 1000000, max: 9999999 }).map(String),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    country: fc.constantFrom("NL", "B", "D", "F"),
  }),
  {
    minLength: 1,
    maxLength: 12,
    selector: (s) => s.code,
  },
).filter((ss) => new Set(ss.map((s) => s.uic)).size === ss.length);

Deno.test("property: resolveStation finds every station by code and UIC", () => {
  fc.assert(
    fc.property(directory, fc.nat(), (stations, i) => {
      const s = stations[i % stations.length];
      assertEquals(resolveStation(s.code, stations), s);
      assertEquals(resolveStation(s.code.toLowerCase(), stations), s);
      assertEquals(resolveStation(s.uic, stations), s);
    }),
    { numRuns },
  );
});

Deno.test("property: cheapestFare is the minimum positive fare", () => {
  const fare = fc.record({
    priceInCents: fc.integer({ min: -500, max: 100000 }),
    travelClass: fc.constantFrom("FIRST_CLASS", "SECOND_CLASS"),
  });
  fc.assert(
    fc.property(
      fc.option(fare, { nil: undefined }),
      fc.array(fare, { maxLength: 6 }),
      (productFare, fares) => {
        const r = cheapestFare({ productFare, fares });
        const prices = [...(productFare ? [productFare] : []), ...fares]
          .map((f) => f.priceInCents).filter((p) => p > 0);
        if (prices.length === 0) {
          assertEquals(r, {});
        } else {
          assertEquals(r.euro, Math.min(...prices) / 100);
        }
      },
    ),
    { numRuns },
  );
});

Deno.test("property: buildUrl round-trips every non-empty param", () => {
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,8}$/),
        fc.string({ maxLength: 30 }),
        { maxKeys: 6 },
      ),
      fc.integer({ min: 0, max: 4 }),
      (params, slashes) => {
        const base = "https://ns.example/api";
        const u = buildUrl(base + "/".repeat(slashes), "/v3/trips", params);
        assertEquals(u.pathname, "/api/v3/trips");
        for (const [k, v] of Object.entries(params)) {
          if (v === "") assertEquals(u.searchParams.has(k), false);
          else assertEquals(u.searchParams.getAll(k), [v]);
        }
        assertEquals(
          new Set(u.searchParams.keys()).size,
          Object.values(params).filter((v) => v !== "").length,
        );
      },
    ),
    { numRuns },
  );
});

Deno.test("property: parseTrip never throws and transfers >= 0", () => {
  fc.assert(
    fc.property(
      fc.array(fc.anything(), { maxLength: 5 }),
      fc.anything(),
      (legs, fares) => {
        const r = parseTrip({ legs, fares } as unknown as RawTrip);
        const objectLegs = legs.filter((l) => !!l && typeof l === "object");
        assertEquals(r.legs.length, objectLegs.length);
        assertEquals(r.transfers, Math.max(0, objectLegs.length - 1));
        assert(r.transfers >= 0);
      },
    ),
    { numRuns },
  );
});

Deno.test("property: isIsoDateTime accepts every real ISO instant", () => {
  fc.assert(
    fc.property(
      fc.date({
        min: new Date("1970-01-01T00:00:00Z"),
        max: new Date("2100-01-01T00:00:00Z"),
        noInvalidDate: true,
      }),
      (d) => {
        assert(isIsoDateTime(d.toISOString()));
        assert(isIsoDateTime(d.toISOString().slice(0, 10)));
      },
    ),
    { numRuns },
  );
});

Deno.test("property: plan flow stores one option per object trip", async () => {
  const cached = {
    stations: [
      {
        code: "ASD",
        uic: "8400058",
        name: "Amsterdam Centraal",
        country: "NL",
      },
      { code: "UT", uic: "8400621", name: "Utrecht Centraal", country: "NL" },
    ],
  };
  const trip = fc.record({
    plannedDurationInMinutes: fc.integer({ min: 1, max: 600 }),
    transfers: fc.integer({ min: 0, max: 5 }),
    legs: fc.array(
      fc.record({
        product: fc.record({ displayName: fc.string({ maxLength: 10 }) }),
      }),
      { maxLength: 4 },
    ),
  });
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.oneof(trip, fc.constant(null)), { maxLength: 8 }),
      async (trips) => {
        const { ctx, written } = makeCtx({
          stored: { "station-index": cached },
        });
        const r = await withFetch(
          () => json({ trips }),
          () =>
            model.methods.plan.execute(
              { from: "ASD", to: "UT", searchForArrival: false },
              ctx,
            ),
        );
        const objects = trips.filter((t) => t !== null).length;
        assertEquals(r.count, objects);
        assertEquals(written.length, 1);
        assertEquals(written[0].spec, "trip-plan");
        assert(written[0].name !== "latest");
        assert(!JSON.stringify(written).includes(API_KEY));
      },
    ),
    { numRuns },
  );
});
