/**
 * Coverage suite for @magistr/ns-international: one test per guard, so
 * deleting the guard turns a test red.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  bookingUrl,
  buildUrl,
  cheapestFare,
  fmtTime,
  model,
  parseStations,
  parseTrip,
  resolveStation,
  type Station,
} from "./ns_international.ts";
import {
  json,
  makeCtx,
  table,
  withFetch,
} from "./ns_international_harness_test.ts";

const S: Station[] = [
  { code: "ASD", uic: "8400058", name: "Amsterdam Centraal", country: "NL" },
  { code: "ASA", uic: "8400057", name: "Amsterdam Amstel", country: "NL" },
  { code: "ASDZ", uic: "8400061", name: "Amsterdam Zuid", country: "NL" },
  { code: "ZD", uic: "8400750", name: "Zaandam", country: "NL" },
  { code: "ZDK", uic: "8400751", name: "Zaandam Kogerveld", country: "NL" },
  { code: "BRUSSEL", uic: "8814001", name: "Brussel-Zuid", country: "B" },
];

Deno.test("buildUrl strips trailing slashes on the base", () => {
  assertEquals(
    buildUrl("https://h/api///", "/v3/trips").toString(),
    "https://h/api/v3/trips",
  );
});

Deno.test("buildUrl drops empty query values", () => {
  const u = buildUrl("https://h/api", "/v3/trips", { a: "1", b: "" });
  assertEquals([...u.searchParams.keys()], ["a"]);
});

Deno.test("parseStations drops rows without a UIC code", () => {
  assertEquals(
    parseStations({ payload: [{ code: "X" }, { UICCode: "1234567" }] }).length,
    1,
  );
});

Deno.test("parseStations name falls back lang → middel → code", () => {
  const rows = parseStations({
    payload: [
      { UICCode: "1", namen: { middel: "Mid" } },
      { UICCode: "2", code: "CD" },
    ],
  });
  assertEquals(rows.map((r) => r.name), ["Mid", "CD"]);
});

Deno.test("resolveStation: blank input throws", () => {
  assertThrows(() => resolveStation("   ", S), Error, "must not be blank");
});

Deno.test("resolveStation: a known UIC resolves to the directory entry", () => {
  assertEquals(resolveStation("8400058", S).code, "ASD");
});

Deno.test("resolveStation: UIC regex needs 6-7 digits", () => {
  // 5 digits is not a UIC — treated as a name and not found.
  assertThrows(() => resolveStation("12345", S), Error, "No station matched");
  assertEquals(resolveStation("123456", S).country, "?");
});

Deno.test("resolveStation: code match is case-insensitive", () => {
  assertEquals(resolveStation(" asdz ", S).name, "Amsterdam Zuid");
});

Deno.test("resolveStation: exact name beats substring", () => {
  // "Zaandam" is a substring of "Zaandam Kogerveld" too.
  assertEquals(resolveStation("zaandam", S).code, "ZD");
});

Deno.test("resolveStation: a unique substring resolves", () => {
  assertEquals(resolveStation("Kogerveld", S).code, "ZDK");
});

Deno.test("resolveStation: an ambiguous name lists candidates", () => {
  assertThrows(
    () => resolveStation("Amsterdam", S),
    Error,
    "Ambiguous station",
  );
});

Deno.test("resolveStation: a unique starts-with breaks a substring tie", () => {
  const T: Station[] = [
    { code: "A", uic: "1000001", name: "Brussel-Zuid", country: "B" },
    { code: "B", uic: "1000002", name: "Luchthaven Brussel", country: "B" },
  ];
  assertEquals(resolveStation("brussel", T).code, "A");
});

Deno.test("cheapestFare ignores zero and non-numeric prices", () => {
  assertEquals(
    cheapestFare({
      productFare: { priceInCents: 0 },
      fares: [{ priceInCents: 1200, travelClass: "FIRST_CLASS" }],
    }),
    { euro: 12, label: "FIRST_CLASS" },
  );
  assertEquals(cheapestFare({}), {});
});

Deno.test("cheapestFare drops NO_DISCOUNT from the label", () => {
  assertEquals(
    cheapestFare({
      productFare: { priceInCents: 100, discountType: "NO_DISCOUNT" },
    }),
    { euro: 1, label: undefined },
  );
});

Deno.test("parseTrip: transfers default to legs - 1", () => {
  const o = parseTrip({ legs: [{}, {}, {}] });
  assertEquals(o.transfers, 2);
  assertEquals(parseTrip({}).transfers, 0);
});

Deno.test("parseTrip: depart/arrive come from first/last leg", () => {
  const o = parseTrip({
    legs: [
      {
        origin: { plannedDateTime: "A" },
        destination: { plannedDateTime: "B" },
      },
      {
        origin: { plannedDateTime: "C" },
        destination: { plannedDateTime: "D" },
      },
    ],
  });
  assertEquals([o.departPlanned, o.arrivePlanned], ["A", "D"]);
});

Deno.test("bookingUrl: either side outside NL is international", () => {
  const nl = S[0];
  const be = S[5];
  assertEquals(bookingUrl(nl, nl).includes("ns.nl"), true);
  assertEquals(bookingUrl(be, nl).includes("nsinternational"), true);
  assertEquals(bookingUrl(nl, be).includes("nsinternational"), true);
});

Deno.test("fmtTime: blank → em dash, garbage echoed, ISO → HH:MM UTC", () => {
  assertEquals(fmtTime(""), "—");
  assertEquals(fmtTime("not-a-date"), "not-a-date");
  assertEquals(fmtTime("2026-09-22T08:04:00+02:00"), "06:04");
});

Deno.test("disruptions never writes the reserved data name 'latest'", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "/v3/disruptions": () => json([]) }),
    () => model.methods.disruptions.execute({ isActive: true }, ctx),
  );
  assertEquals(written.map((w) => w.name), ["current"]);
});

Deno.test("model version matches the last upgrades[] terminus", () => {
  assertEquals(model.upgrades.at(-1)?.toVersion, model.version);
});
