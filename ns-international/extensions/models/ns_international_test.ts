/**
 * Contract-fixture suite for @magistr/ns-international: pins the NS
 * Reisinformatie API wire format — request paths, query parameters and auth
 * header — and the mapping of hand-authored response fixtures (see
 * fixtures/PROVENANCE.md) into stored resources. If a test here breaks, the
 * contract with the NS API changed.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./ns_international.ts";
import {
  API_KEY,
  json,
  makeCtx,
  table,
  withFetch,
} from "./ns_international_harness_test.ts";
import stationsFixture from "../../fixtures/stations.json" with {
  type: "json",
};
import tripsFixture from "../../fixtures/trips.json" with { type: "json" };
import disruptionsFixture from "../../fixtures/disruptions.json" with {
  type: "json",
};

const routes = () =>
  table({
    "/v2/stations": () => json(stationsFixture),
    "/v3/trips": () => json(tripsFixture),
    "/v3/disruptions": () => json(disruptionsFixture),
  });

Deno.test("stations: GET /v2/stations with the subscription-key header", async () => {
  const { ctx } = makeCtx();
  await withFetch(routes(), async (calls) => {
    await model.methods.stations.execute({}, ctx);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "GET");
    assertEquals(
      calls[0].url.pathname,
      "/reisinformatie-api/api/v2/stations",
    );
    assertEquals(calls[0].headers["ocp-apim-subscription-key"], API_KEY);
    assertEquals(calls[0].headers["accept"], "application/json");
    assertEquals(
      calls[0].headers["user-agent"],
      "swamp-ns-international/test",
    );
  });
});

Deno.test("stations: fixture maps to the station-index resource", async () => {
  const { ctx, written } = makeCtx();
  const result = await withFetch(
    routes(),
    () => model.methods.stations.execute({}, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "station-index");
  assertEquals(written[0].name, "station-index");
  const stations = written[0].payload.stations as Record<string, unknown>[];
  // The row without a UICCode is dropped.
  assertEquals(stations.length, 4);
  assertEquals(stations[0], {
    code: "ASD",
    uic: "8400058",
    name: "Amsterdam Centraal",
    country: "NL",
    lat: 52.3788871765137,
    lng: 4.90027761459351,
  });
  assertEquals(written[0].payload.count, 4);
  assertEquals(result.count, 4);
  assertEquals(result.matched, 4);
});

Deno.test("plan: GET /v3/trips with UIC codes and search flags", async () => {
  const { ctx } = makeCtx();
  await withFetch(routes(), async (calls) => {
    await model.methods.plan.execute({
      from: "ASD",
      to: "UT",
      dateTime: "2026-09-22T08:00:00+02:00",
      searchForArrival: true,
      travelClass: 1,
    }, ctx);
    assertEquals(calls.map((c) => c.url.pathname.split("/api")[1]), [
      "/v2/stations",
      "/v3/trips",
    ]);
    const p = calls[1].url.searchParams;
    assertEquals(p.get("originUicCode"), "8400058");
    assertEquals(p.get("destinationUicCode"), "8400621");
    assertEquals(p.get("dateTime"), "2026-09-22T08:00:00+02:00");
    assertEquals(p.get("searchForArrival"), "true");
    assertEquals(p.get("travelClass"), "1");
  });
});

Deno.test("plan: trips fixture maps to the trip-plan resource", async () => {
  const { ctx, written } = makeCtx();
  const result = await withFetch(
    routes(),
    () =>
      model.methods.plan.execute({
        from: "Amsterdam Centraal",
        to: "Utrecht Centraal",
        dateTime: "2026-09-22T08:00:00+02:00",
        searchForArrival: false,
      }, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "trip-plan");
  assertEquals(written[0].name.startsWith("ASD-UT-"), true);
  assertEquals(result.from, "Amsterdam Centraal");
  assertEquals(result.fromCode, "ASD");
  assertEquals(result.toCode, "UT");
  assertEquals(result.international, false);
  assertEquals(
    result.bookingUrl,
    "https://www.ns.nl/en/travel-information/travel-planner",
  );
  assertEquals(result.count, 2);
  const [direct, transfer] = result.options;
  assertEquals(direct.departPlanned, "2026-09-22T08:04:00+0200");
  assertEquals(direct.arrivePlanned, "2026-09-22T08:31:00+0200");
  assertEquals(direct.durationMinutes, 27);
  assertEquals(direct.transfers, 0);
  // Cheapest of productFare + fares[]: the 40% discount fare.
  assertEquals(direct.priceEuro, 5.6);
  assertEquals(
    direct.priceLabel,
    "SECOND_CLASS / OVCHIPKAART_ENKELE_REIS / DISCOUNT_40_PERCENT",
  );
  assertEquals(direct.legs[0], {
    product: "Intercity",
    operator: "NS",
    fromName: "Amsterdam Centraal",
    fromTrack: "5b",
    departPlanned: "2026-09-22T08:04:00+0200",
    departActual: "2026-09-22T08:06:00+0200",
    toName: "Utrecht Centraal",
    toTrack: "18",
    arrivePlanned: "2026-09-22T08:31:00+0200",
    arriveActual: undefined,
    direction: "Nijmegen",
    crowdForecast: "MEDIUM",
    cancelled: false,
  });
  assertEquals(transfer.transfers, 1);
  assertEquals(transfer.status, "DISRUPTION");
  assertEquals(transfer.priceEuro, undefined);
  assertEquals(transfer.legs.length, 2);
  assertEquals(transfer.legs[1].cancelled, true);
});

Deno.test("plan: a cross-border trip books on NS International", async () => {
  const { ctx } = makeCtx();
  const result = await withFetch(
    routes(),
    () =>
      model.methods.plan.execute({
        from: "ASD",
        to: "BERHBT",
        searchForArrival: false,
      }, ctx),
  );
  assertEquals(result.international, true);
  assertEquals(
    result.bookingUrl,
    "https://www.nsinternational.com/en/book-a-train-ticket",
  );
});

Deno.test("disruptions: GET /v3/disruptions with isActive and type", async () => {
  const { ctx } = makeCtx();
  await withFetch(routes(), async (calls) => {
    await model.methods.disruptions.execute(
      { isActive: false, type: "MAINTENANCE" },
      ctx,
    );
    assertEquals(calls.length, 1);
    const p = calls[0].url.searchParams;
    assertEquals(p.get("isActive"), "false");
    assertEquals(p.get("type"), "MAINTENANCE");
  });
});

Deno.test("disruptions: fixture maps to the disruptions resource", async () => {
  const { ctx, written } = makeCtx();
  const result = await withFetch(
    routes(),
    () => model.methods.disruptions.execute({ isActive: true }, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "disruptions");
  assertEquals(written[0].name, "current");
  assertEquals(result.count, 2);
  assertEquals(result.items, [
    {
      id: "7001234",
      type: "MAINTENANCE",
      title: "Amsterdam Centraal - Utrecht Centraal",
      isActive: true,
      phase: "Werkzaamheden",
    },
    {
      id: "7005678",
      type: "DISRUPTION",
      title: "Schiphol Airport - Leiden Centraal",
      isActive: true,
      phase: undefined,
    },
  ]);
});
