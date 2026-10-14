/**
 * Property / invariant suite for @magistr/film-library (fast-check).
 * FC_NUM_RUNS raises the run count for the nightly soak.
 */
import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { isTagToken, parseReleaseName } from "../lib/release.ts";
import { classifyRoot, hash8, itemKey, parseListing } from "./film_library.ts";
import { listing } from "./film_library_test_helpers.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const numRuns = ENV_RUNS ? Number(ENV_RUNS) : 200;
const TECH = /\b(1080p|2160p|720p|x264|x265|bdrip|web-dl|bluray|remux|hevc)\b/i;

Deno.test("parse never throws and never keeps a tech tag in the title", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 120 }), (s) => {
      const r = parseReleaseName(s);
      assert(typeof r.title === "string");
      assert(r.year === null || (r.year >= 1888 && r.year <= 2100));
    }),
    { numRuns },
  );
  fc.assert(
    fc.property(
      // Title words exclude the tag vocabulary itself (a film titled "Web" is
      // indistinguishable from a WEB tag; see release.ts LEADING_TECH).
      fc.stringMatching(/^[A-Z][a-z]{2,8}( [A-Z][a-z]{2,8}){0,3}$/).filter((
        t,
      ) => t.split(" ").every((w) => !isTagToken(w))),
      fc.integer({ min: 1920, max: 2030 }),
      fc.constantFrom(
        "1080p.BluRay.x264",
        "2160p.WEB-DL.DV.HDR.H.265",
        "720p.HDTV",
        "BDRip.1080p",
      ),
      fc.constantFrom(".", "_", " "),
      (title, year, tech, sep) => {
        const name = `${
          title.replaceAll(" ", sep)
        }${sep}${year}${sep}${tech}.mkv`;
        const r = parseReleaseName(name);
        assertEquals(r.title, title);
        assertEquals(r.year, year);
        assert(!TECH.test(r.title));
      },
    ),
    { numRuns },
  );
});

Deno.test("item keys are stable and unique per path", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 40 }), {
        minLength: 2,
        maxLength: 20,
      }),
      (paths) => {
        const keys = paths.map((p) => itemKey(`/r/${p}`, "t"));
        assertEquals(
          new Set(keys).size >=
            new Set(paths.map((p) => hash8(`/r/${p}`))).size,
          true,
        );
        assertEquals(itemKey(`/r/${paths[0]}`, "t"), keys[0]);
      },
    ),
    { numRuns },
  );
});

Deno.test("flow: every top-level entry yields at least one item", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9 ._-]{1,30}$/), {
        minLength: 1,
        maxLength: 15,
      }),
      fc.array(fc.constantFrom("mkv", "srt", "dmg", "nfo", "d"), {
        minLength: 15,
        maxLength: 15,
      }),
      (names, kinds) => {
        const rows = names.map((n, i) =>
          kinds[i] === "d" ? [n, "d"] : [`${n}.${kinds[i]}`, "f", 2e9]
        ) as Parameters<typeof listing>[1];
        const entries = parseListing(listing("/r", rows)).entries;
        const items = classifyRoot("/r", "library", entries, 2);
        assertEquals(items.length, rows.length);
      },
    ),
    { numRuns },
  );
});
