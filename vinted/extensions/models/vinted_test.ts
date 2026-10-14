/** Contract-fixture tests: parsers against trimmed REAL Vinted pages (2026-10-09). */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseCatalog, parseItem } from "./vinted.ts";
import { fixture } from "../../fixtures/ctx.ts";

Deno.test("parseCatalog: real RSC catalog payload", () => {
  const { items, totalEntries } = parseCatalog(
    fixture("catalog.html"),
    "www.vinted.nl",
  );
  assertEquals(items.length, 4);
  assertEquals(totalEntries, 960);
  const a = items[0];
  assertEquals(a.id, "10298802242");
  assertEquals(a.price, { amount: 20, currency: "EUR" });
  assertEquals(a.totalPrice, { amount: 21.7, currency: "EUR" });
  assertEquals([a.brand, a.size, a.condition], ["Burberry", "L", "Goed"]);
  assert(a.url.startsWith("https://www.vinted.nl/items/10298802242-"));
});

Deno.test("parseItem: Burberrys raincoat listing", () => {
  const it = parseItem(
    fixture("item_10107271840.html"),
    "10107271840",
    "www.vinted.nl",
  );
  assertEquals(it.title, "Impers burberrys homme");
  assertEquals(it.price, { amount: 118, currency: "EUR" });
  assertEquals([it.brand, it.size, it.condition], [
    "Burberrys",
    "L",
    "Heel goed",
  ]);
  assertEquals(it.material, "Katoen, Polyester");
  assertEquals(it.seller.name, "ame3266");
  assertEquals(it.seller.feedbackCount, 292);
  assertEquals(it.availability, "InStock");
  assert(it.photos.length >= 5);
  assertEquals(it.measurements, {
    shouldersCm: 52,
    chestCm: 110,
    lengthCm: 110,
    sleeveCm: 78,
  });
});
