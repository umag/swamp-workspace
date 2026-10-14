/**
 * Contract-fixture suite for @magistr/film-library: pins the release-name
 * parser against real names taken from the share (fixtures/names.json) and
 * the LIST_SCRIPT wire format.
 */
import { assertEquals } from "jsr:@std/assert@1.0.13";
import { parseReleaseName } from "../lib/release.ts";
import { parseListing } from "./film_library.ts";
import { listing } from "./film_library_test_helpers.ts";

type Case = {
  name: string;
  title: string;
  year: number | null;
  alt?: string[];
  resolution?: string | null;
  source?: string | null;
  series?: boolean;
};

const cases: Case[] = JSON.parse(
  Deno.readTextFileSync(new URL("../../fixtures/names.json", import.meta.url)),
);

for (const c of cases) {
  Deno.test(`parse: ${c.name}`, () => {
    const r = parseReleaseName(c.name);
    assertEquals(r.title, c.title);
    assertEquals(r.year, c.year);
    if (c.alt) assertEquals(r.altTitles, c.alt);
    if (c.resolution !== undefined) assertEquals(r.resolution, c.resolution);
    if (c.source !== undefined) assertEquals(r.source, c.source);
    if (c.series !== undefined) assertEquals(r.isSeries, c.series);
  });
}

Deno.test("parseListing decodes the LIST_SCRIPT record format", () => {
  const raw = listing("/r", [["A (2001)", "d"], ["A (2001)/a.mkv", "f", 5]], [
    "/gone",
  ]);
  const l = parseListing(raw);
  assertEquals(l.roots, ["/r"]);
  assertEquals(l.missingRoots, ["/gone"]);
  assertEquals(l.entries.map((e) => [e.rel, e.depth, e.isDir, e.size]), [
    ["A (2001)", 1, true, 0],
    ["A (2001)/a.mkv", 2, false, 5],
  ]);
});
