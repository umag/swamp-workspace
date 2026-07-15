import { assertEquals } from "jsr:@std/assert@1";
import { DOMParser } from "npm:linkedom@0.16.11";
import {
  parseAccords,
  parseNotes,
  preferLinkName,
  refFromPerfumeUrl,
} from "./fragrantica.ts";

const BASE = "https://www.fragrantica.com";
// deno-lint-ignore no-explicit-any
const doc = (html: string): any =>
  new DOMParser().parseFromString(html, "text/html");
// deno-lint-ignore no-explicit-any
const anchor = (html: string): any => doc(html).querySelector("a");

// --- refFromPerfumeUrl ------------------------------------------------------

Deno.test("refFromPerfumeUrl: parses brand, name, id, thumbnail from a path", () => {
  const ref = refFromPerfumeUrl(
    "/perfume/Yves-Saint-Laurent/Y-Eau-de-Parfum-50757.html",
    BASE,
  );
  assertEquals(ref.brand, "Yves Saint Laurent");
  assertEquals(ref.name, "Y Eau de Parfum");
  assertEquals(ref.id, 50757);
  assertEquals(
    ref.url,
    `${BASE}/perfume/Yves-Saint-Laurent/Y-Eau-de-Parfum-50757.html`,
  );
  assertEquals(
    ref.thumbnail,
    "https://fimgs.net/mdimg/perfume-thumbs/375x500.50757.jpg",
  );
});

Deno.test("refFromPerfumeUrl: keeps an absolute URL and collapses no locale", () => {
  const ref = refFromPerfumeUrl(
    "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
    BASE,
  );
  assertEquals(ref.brand, "Dior");
  assertEquals(ref.name, "Sauvage");
  assertEquals(ref.id, 31861);
});

Deno.test("refFromPerfumeUrl: failure path — non-perfume URL yields empty name, no id", () => {
  const ref = refFromPerfumeUrl("/designers/Dior.html", BASE);
  assertEquals(ref.name, "");
  assertEquals(ref.id, undefined);
  assertEquals(ref.brand, undefined);
  assertEquals(ref.thumbnail, undefined);
});

// --- parseAccords -----------------------------------------------------------

Deno.test("parseAccords: reads name + rounded strength from width bars", () => {
  const accords = parseAccords(doc(`
    <div style="background:#83C928;width:100%;">fresh spicy</div>
    <div style="background:#bc4d10;opacity:75%;width:70.888%;">amber</div>
    <div style="width:50%;">no-background-ignored</div>
    <div style="background:#000;width:40%;">fresh spicy</div>
  `));
  assertEquals(accords, [
    { name: "fresh spicy", strength: 100 },
    { name: "amber", strength: 71 },
  ]); // dup name deduped, background-less bar skipped
});

Deno.test("parseAccords: failure path — no bars yields empty array", () => {
  assertEquals(parseAccords(doc("<p>no accords here</p>")), []);
});

// --- parseNotes -------------------------------------------------------------

Deno.test("parseNotes: three containers map to top/middle/base", () => {
  const pyramid = doc(`
    <div id="pyramid">
      <h4>Top Notes</h4>
      <div class="pyramid-level-container"><a href="/notes/Bergamot-75.html">Bergamot</a></div>
      <h4>Middle Notes</h4>
      <div class="pyramid-level-container"><a href="/notes/Rose-3.html">Rose</a></div>
      <h4>Base Notes</h4>
      <div class="pyramid-level-container"><a href="/notes/Musk-99.html">Musk</a></div>
    </div>
  `).querySelector("#pyramid");
  const notes = parseNotes(pyramid);
  assertEquals(notes.top, ["Bergamot"]);
  assertEquals(notes.middle, ["Rose"]);
  assertEquals(notes.base, ["Musk"]);
  assertEquals(notes.general, []);
});

Deno.test("parseNotes: single un-tiered block falls into general", () => {
  const pyramid = doc(`
    <div id="pyramid">
      <div class="pyramid-level-container">
        <a href="/notes/Oud-114.html">Agarwood (Oud)</a>
        <a href="/notes/Licorice-195.html">Black Licorice</a>
      </div>
    </div>
  `).querySelector("#pyramid");
  const notes = parseNotes(pyramid);
  assertEquals(notes.general, ["Agarwood (Oud)", "Black Licorice"]);
  assertEquals(notes.top, []);
});

Deno.test("parseNotes: failure path — null pyramid yields empty levels", () => {
  const notes = parseNotes(null);
  assertEquals(notes, { top: [], middle: [], base: [], general: [] });
});

// --- preferLinkName ---------------------------------------------------------

Deno.test("preferLinkName: carousel uses the last line (accented name)", () => {
  const a = anchor(`<a><img/>Hermès\n\nTerre d'Hermès</a>`);
  assertEquals(
    preferLinkName(a, { name: "Terre d Hermes", brand: "Hermes" }),
    "Terre d'Hermès",
  );
});

Deno.test("preferLinkName: numeric stat line falls back to slug name", () => {
  const a = anchor(`<a>2000 Fleurs\n134</a>`);
  assertEquals(
    preferLinkName(a, { name: "2000 Fleurs", brand: "Creed" }),
    "2000 Fleurs",
  );
});

Deno.test("preferLinkName: long review snippet falls back to slug name", () => {
  const snippet =
    "A classic for a reason. Lovely citrus and blossom, lasts about 2 hrs.";
  const a = anchor(`<a>4711\n${snippet}</a>`);
  assertEquals(
    preferLinkName(a, { name: "4711 Original Eau de Cologne", brand: "4711" }),
    "4711 Original Eau de Cologne",
  );
});
