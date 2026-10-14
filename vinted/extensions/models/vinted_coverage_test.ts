/** Coverage tests: measurement parser across languages, URL builder, slug. */
import { assertEquals } from "jsr:@std/assert@1";
import { catalogUrl, parseMeasurements, slug } from "./vinted.ts";

Deno.test("parseMeasurements: EN pit-to-pit doubled", () => {
  assertEquals(
    parseMeasurements("Pit to pit: 58cm\nLength 104 cm\nSleeve 64"),
    { chestFlatCm: 58, chestCm: 116, lengthCm: 104, sleeveCm: 64 },
  );
});
Deno.test("parseMeasurements: NL + chest under 75 treated as flat", () => {
  assertEquals(
    parseMeasurements("Borst 60 cm, schouders 48 cm, lengte 98 cm, mouw 66 cm"),
    {
      chestCm: 120,
      chestFlatCm: 60,
      shouldersCm: 48,
      lengthCm: 98,
      sleeveCm: 66,
    },
  );
});
Deno.test("parseMeasurements: FR trousers; bare 'taille L' is not a waist", () => {
  assertEquals(
    parseMeasurements(
      "Taille 52\nTour de taille 92 cm\nEntrejambe 76 cm\nFourche 30 cm",
    ),
    { waistCm: 92, inseamCm: 76, riseCm: 30 },
  );
});
Deno.test("parseMeasurements: IT flat waist under 60 doubled", () => {
  assertEquals(
    parseMeasurements("Vita 47 cm\nCavallo 30 cm\nLunghezza totale 102 cm"),
    { waistCm: 94, riseCm: 30, lengthCm: 102 },
  );
});
Deno.test("catalogUrl encodes filters and page", () => {
  const u = new URL(
    catalogUrl("www.vinted.nl", {
      query: "a b",
      order: "relevance",
      priceFrom: 10,
      catalogIds: [1],
      brandIds: [],
      sizeIds: [2, 3],
      statusIds: [2],
    }, 2),
  );
  assertEquals(u.searchParams.getAll("size_ids[]"), ["2", "3"]);
  assertEquals([
    u.searchParams.get("search_text"),
    u.searchParams.get("page"),
    u.searchParams.get("price_from"),
  ], ["a b", "2", "10"]);
});
Deno.test("slug", () => {
  assertEquals(slug("Burberry Trench — L!"), "burberry-trench-l");
  assertEquals(slug("!!!"), "search");
});

Deno.test("catalogUrl adds color_ids[]", () => {
  const u = new URL(
    catalogUrl("www.vinted.nl", {
      query: "x",
      order: "relevance",
      catalogIds: [],
      brandIds: [],
      sizeIds: [],
      statusIds: [],
      colorIds: [2],
    }, 1),
  );
  assertEquals(u.searchParams.getAll("color_ids[]"), ["2"]);
});

Deno.test("retryDelayMs honours Retry-After, else exponential, capped", async () => {
  const { retryDelayMs } = await import("./vinted.ts");
  assertEquals(retryDelayMs("7", 0), 7000);
  assertEquals(retryDelayMs(null, 0), 10_000);
  assertEquals(retryDelayMs("junk", 2), 40_000);
  assertEquals(retryDelayMs(null, 9), 120_000);
});

Deno.test("parseMeasurements: real FR listing with ' - ' clauses and flat widths", () => {
  const d =
    "Trench très peu porté - Taille 54 ou XL - Dimension du trench posé à plat - Largeur aux épaules 51 cm - Largeur aux aisselles 58 cm - Largeur à la taille 55 cm - Hauteur du col jusqu'en bas 86 cm - Longueur de manche 65";
  assertEquals(parseMeasurements(d), {
    shouldersCm: 51,
    chestFlatCm: 58,
    chestCm: 116,
    waistCm: 110,
    lengthCm: 86,
    sleeveCm: 65,
  });
});

Deno.test("parseMeasurements: number-first '63cm de large/130cm de long'", () => {
  assertEquals(
    parseMeasurements(
      "Etat: Très bon état\nTaille: 63cm de large/130cm de long",
    ),
    { chestFlatCm: 63, chestCm: 126, lengthCm: 130 },
  );
});

Deno.test("parseCookieHeader: header line, prefix, '=' in values, newlines", async () => {
  const { parseCookieHeader } = await import("./vinted.ts");
  const m = parseCookieHeader(
    "Cookie: cf_clearance=abc.def=; anon_id=1\nv_udt=x==",
  );
  assertEquals([...m], [["cf_clearance", "abc.def="], ["anon_id", "1"], [
    "v_udt",
    "x==",
  ]]);
  assertEquals(parseCookieHeader("  ").size, 0);
});
