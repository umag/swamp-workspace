/**
 * Adversarial suite for @magistr/film-library: hostile file names, broken
 * listings, path arguments, and Jev answers that try to over-decide.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import {
  buildMatchQueries,
  buildReadings,
  classifyRoot,
  collectJev,
  decide,
  decideNames,
  type MatchEntry,
  model,
  parseListing,
} from "./film_library.ts";
import { jevRow, listing } from "./film_library_test_helpers.ts";
import { parseReleaseName } from "../lib/release.ts";

Deno.test("roots with .. or relative paths are rejected by the schema", () => {
  const g = model.globalArguments;
  assert(
    !g.safeParse({
      host: "h",
      roots: [{ path: "/mnt/user/../etc", role: "library" }],
    }).success,
  );
  assert(
    !g.safeParse({ host: "h", roots: [{ path: "films", role: "library" }] })
      .success,
  );
});

Deno.test("shell metacharacters in names survive as data", () => {
  const evil = "$(rm -rf ~); `id` 'x'\"y\".mkv";
  const l = parseListing(listing("/r", [[evil, "f", 1e9]]));
  assertEquals(l.entries[0].name, evil);
  const items = classifyRoot("/r", "library", l.entries, 2);
  assertEquals(items[0].path, `/r/${evil}`);
});

Deno.test("a truncated listing record fails loudly", () => {
  assertThrows(
    () => parseListing("R\x1f/r\x1eE\x1fregular file\x1f12\x1e"),
    Error,
    "malformed",
  );
});

Deno.test("entries outside the announced root are ignored", () => {
  const raw = "R\x1f/r\x1eE\x1fregular file\x1f1\x1f1\x1f/elsewhere/x.mkv\x1e";
  assertEquals(parseListing(raw).entries, []);
});

Deno.test("parser never throws on pathological names", () => {
  for (
    const n of [
      "",
      ".",
      "..mkv",
      "[[[(((",
      "\u0000\u0000",
      "-".repeat(500),
      "(1999)",
      "[]()",
      "S01E01",
    ]
  ) {
    parseReleaseName(n);
  }
});

Deno.test("Jev cannot accept two candidates at once (margin rule)", () => {
  const m = new Map<string, MatchEntry>([["k", {
    key: "k",
    status: "ambiguous",
    score: 0.9,
    tmdbId: null,
    error: null,
    candidates: [
      {
        id: 1,
        kind: "movie",
        title: "Dune",
        originalTitle: null,
        year: 1984,
        overview: null,
      },
      {
        id: 2,
        kind: "movie",
        title: "Dune",
        originalTitle: null,
        year: 2021,
        overview: null,
      },
    ],
  }]]);
  const jev = collectJev([jevRow("triage-batch-films-pairs-x-0", [
    { id: "k::1", answers: { same_film: { type: "noul", noul: 0.9 } } },
    { id: "k::2", answers: { same_film: { type: "noul", noul: 0.85 } } },
  ])], "films");
  const [d] = decide(m, new Map(), jev, { threshold: 0.8, margin: 0.2 });
  assertEquals([d.via, d.tmdbId, d.jevVerdict], ["none", null, "undecided"]);
});

Deno.test("Jev rows for another set name are ignored", () => {
  const jev = collectJev([jevRow("triage-batch-other-pairs-0", [
    { id: "k::1", answers: { same_film: { type: "noul", noul: 1 } } },
  ])], "films");
  assertEquals(jev.pairs.size, 0);
});

Deno.test("Jev rejecting every reading stops the entry before TMDB", () => {
  const [it] = classifyRoot(
    "/r",
    "library",
    parseListing(listing("/r", [["Strange.Name.2001.mkv", "f", 2e9]])).entries,
    2,
  );
  const readings = buildReadings(it);
  const jev = collectJev([
    jevRow(
      "triage-batch-films-names-x-0",
      readings.map((r) => ({
        id: `${it.key}::n::${r.id}`,
        answers: { correct_title: { type: "noul", noul: 0.1 } },
      })),
    ),
  ], "films");
  const [n] = decideNames([it], jev, {}, {
    nameThreshold: 0.6,
    rejectBelow: 0.3,
    kindThreshold: 0.85,
  });
  assertEquals(n.status, "rejected");
  assertEquals(buildMatchQueries([it], [n], {}), []);
});

Deno.test("malformed Jev answers are skipped, not trusted", () => {
  const jev = collectJev([{
    name: "triage-batch-films-kinds-0",
    attributes: {
      results: [
        { id: 5, answers: {} },
        { id: "a", answers: { kind: { choice: 7 } } },
        { id: "b", answers: { same_film: { noul: "yes" } } },
      ],
    },
  }], "films");
  assertEquals([jev.pairs.size, jev.kinds.size, jev.names.size], [0, 0, 0]);
});
