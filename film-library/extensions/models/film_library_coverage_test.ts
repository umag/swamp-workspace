/**
 * Coverage suite for @magistr/film-library: guards found in review —
 * disc structures, samples, two-part films, collections, quality ranking,
 * newest-row selection, and Jev kind overriding the folder heuristic.
 */
import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  buildFacts,
  buildMatchQueries,
  buildReadings,
  classifyRoot,
  decideNames,
  IMPORT_SCRIPT,
  newestNamed,
  parseListing,
  parsePin,
  qualityRank,
  REMOVE_SCRIPT,
  scoreHitTrusted,
  staleFactNames,
} from "./film_library.ts";
import { listing } from "./film_library_test_helpers.ts";
import { looksTranslit, toCyrillic } from "../lib/translit.ts";

const GB = 1024 ** 3;
const items = (rows: Parameters<typeof listing>[1], depth = 2) =>
  classifyRoot(
    "/r",
    "library",
    parseListing(listing("/r", rows)).entries,
    depth,
  );

Deno.test("BDMV folder is a bluray film with incomplete size", () => {
  const [i] = items([["Dune (1984)", "d"], ["Dune (1984)/BDMV", "d"]]);
  assertEquals([i.class, i.disc, i.sizeComplete, i.year], [
    "film",
    "bluray",
    false,
    1984,
  ]);
});

Deno.test("samples and extras do not count as the main video", () => {
  const [i] = items([
    ["Heat (1995)", "d"],
    ["Heat (1995)/heat-sample.mkv", "f", 100 * 1024 ** 2],
    ["Heat (1995)/Heat.1995.1080p.BluRay.mkv", "f", 12 * GB],
  ]);
  assertEquals([i.class, i.videoFiles, i.resolution], ["film", 1, "1080p"]);
});

Deno.test("two halves of one film stay one item", () => {
  const r = items([["OLIMPIA", "d"], ["OLIMPIA/OLIMPIA1.mkv", "f", 3 * GB], [
    "OLIMPIA/OLIMPIA2.mkv",
    "f",
    3 * GB,
  ]]);
  assertEquals(r.map((i) => [i.class, i.title, i.videoFiles]), [[
    "film",
    "OLIMPIA",
    2,
  ]]);
});

Deno.test("a trilogy folder splits into collection members with index stripped", () => {
  const r = items([
    ["Qatsi_Trilogy", "d"],
    ["Qatsi_Trilogy/1.Koyaanisqatsi_BDRip 1080p.mkv", "f", 8 * GB],
    ["Qatsi_Trilogy/2.Powwaqatsi_ BDRip1080p24.mkv", "f", 8 * GB],
    ["Qatsi_Trilogy/3.Naqoyqatsi_BDRip1080p.mkv", "f", 8 * GB],
  ]);
  assertEquals(r.map((i) => i.title).sort(), [
    "Koyaanisqatsi",
    "Naqoyqatsi",
    "Powwaqatsi",
  ]);
  assertEquals(r.every((i) => i.collection === "Qatsi_Trilogy"), true);
});

Deno.test("a folder with only unlisted subfolders is unknown", () => {
  const [i] = items([["CHESS 2xDVD5_rus", "d"], [
    "CHESS 2xDVD5_rus/DVD1",
    "d",
  ]]);
  assertEquals(i.class, "unknown");
});

Deno.test("qualityRank orders 2160p remux > 1080p bluray > 720p web", () => {
  const q = (resolution: string, source: string, hdr: string[] = []) =>
    qualityRank({ resolution, source, hdr, codec: null, disc: null });
  assertEquals(q("2160p", "remux", ["dv"]) > q("1080p", "bluray"), true);
  assertEquals(q("1080p", "bluray") > q("720p", "web-dl"), true);
});

Deno.test("newestNamed picks the highest version of the named row", () => {
  const rows = [{ name: "a", version: 1 }, { name: "a", version: 3 }, {
    name: "b",
    version: 9,
  }];
  assertEquals((newestNamed(rows, "a") as { version: number }).version, 3);
  assertEquals(newestNamed(rows, "c"), null);
});

Deno.test("a confident Jev kind overrides the folder heuristic", () => {
  const [film] = items([["Swan.Lake.Bolshoi.2015.mkv", "f", 4 * GB]]);
  const facts = (kind: string, confidence: number) => {
    const jev = {
      pairs: new Map(),
      names: new Map(),
      kinds: new Map([[film.key, { kind, confidence }]]),
    };
    const names = decideNames([film], jev, {}, {
      nameThreshold: 0.6,
      rejectBelow: 0.3,
      kindThreshold: 0.85,
    });
    return buildFacts(
      [film],
      new Map(names.map((n) => [n.key, n])),
      new Map(),
      new Map(),
    );
  };
  assertEquals(facts("not_video", 0.9).length, 0);
  assertEquals(facts("tv_series", 0.9).length, 0);
  assertEquals(facts("not_video", 0.6).length, 1);
  // Concerts and shorts stay searchable: TMDB lists many of them.
  assertEquals(facts("stage_or_concert", 0.95).length, 1);
  assertEquals(facts("feature_film", 0.9).length, 1);
});

Deno.test("readings: Russian and English titles both offered, then both confirmed", () => {
  const [it] = items([[
    "Большие спорщики_The Great Debaters [2007.BDRip.720p.AVO.Eng]-HQFans.mkv",
    "f",
    4 * GB,
  ]]);
  const r = buildReadings(it);
  assertEquals(r.map((x) => [x.title, x.year]), [["Большие спорщики", 2007], [
    "The Great Debaters",
    2007,
  ]]);
  const jev = {
    pairs: new Map(),
    kinds: new Map(),
    names: new Map(
      r.map((x, i) => [`${it.key}::n::${x.id}`, i === 0 ? 0.7 : 0.95]),
    ),
  };
  const [n] = decideNames([it], jev, {}, {
    nameThreshold: 0.6,
    rejectBelow: 0.3,
    kindThreshold: 0.85,
  });
  assertEquals([n.status, n.title, n.altTitles, n.year], [
    "confirmed",
    "The Great Debaters",
    ["Большие спорщики"],
    2007,
  ]);
});

Deno.test("unanswered entries fall back to the parser's reading", () => {
  const [it] = items([["Heat.1995.1080p.mkv", "f", 4 * GB]]);
  const [n] = decideNames(
    [it],
    { pairs: new Map(), kinds: new Map(), names: new Map() },
    {},
    { nameThreshold: 0.6, rejectBelow: 0.3, kindThreshold: 0.85 },
  );
  assertEquals([n.status, n.title, n.year], ["parser", "Heat", 1995]);
});

Deno.test("a kinds pin skips the TMDB search, even for a film-class kind", () => {
  const [it] = items([["Hamilton.2020.2160p.WEB.mkv", "f", 4 * GB]]);
  const opts = { nameThreshold: 0.6, rejectBelow: 0.3, kindThreshold: 0.85 };
  const none = { pairs: new Map(), kinds: new Map(), names: new Map() };
  const [n] = decideNames([it], none, {}, {
    ...opts,
    kinds: { [it.path]: "stage_or_concert" },
  });
  assertEquals([n.status, n.kind, n.kindConfidence], [
    "not-film",
    "stage_or_concert",
    1,
  ]);
  assertEquals(buildMatchQueries([it], [n], {}), []);
  // an overrides pin wins over a kinds pin
  const [p] = decideNames([it], none, { [it.path]: 556574 }, {
    ...opts,
    kinds: { [it.path]: "stage_or_concert" },
  });
  assertEquals(p.status, "pinned");
});

Deno.test("translit: romanised Russian gets a Cyrillic reading, English does not", () => {
  assertEquals(toCyrillic("Gadkiy ya 2"), "Гадкий я 2");
  assertEquals(toCyrillic("Horoshiy Plohoy Zloy"), "Хороший плохой злой");
  assertEquals(toCyrillic("Sijanie"), "Сияние");
  assertEquals(toCyrillic("Yulenjka"), "Юленька");
  assertEquals(looksTranslit("Gadkiy ya 2"), true);
  assertEquals(looksTranslit("Liki smerti"), true);
  assertEquals(looksTranslit("Forrest Gump"), false);
  assertEquals(looksTranslit("The Way of Water"), false);
  const [it] = items([["Gadkiy.ya.2.2013.D.BDRip.1080p.mkv", "f", 4 * GB]]);
  assertEquals(buildReadings(it).map((r) => r.title), [
    "Gadkiy ya 2",
    "Гадкий я 2",
  ]);
});

Deno.test("a string-score hit is trusted only with a matching year", () => {
  const m = (year: number | null) => ({
    key: "k",
    status: "matched" as const,
    score: 0.95,
    tmdbId: 1,
    error: null,
    candidates: [{
      id: 1,
      kind: "movie" as const,
      title: "Hamilton",
      originalTitle: null,
      year,
      overview: null,
    }],
  });
  const n = (year: number | null) => ({
    key: "k",
    kind: null,
    kindConfidence: null,
    status: "confirmed" as const,
    title: "Hamilton",
    altTitles: [],
    year,
    readings: [],
  });
  assertEquals(scoreHitTrusted(m(2020), n(2020)), true);
  assertEquals(scoreHitTrusted(m(2021), n(2020)), true);
  assertEquals(scoreHitTrusted(m(2025), n(2020)), false);
  assertEquals(scoreHitTrusted(m(2020), n(null)), false);
});

Deno.test("a tv:<id> pin searches TMDB as tv with that id", () => {
  const [it] = items([["Langoliers_DVDRip", "d"], [
    "Langoliers_DVDRip/a.avi",
    "f",
    4 * GB,
  ]]);
  const none = { pairs: new Map(), kinds: new Map(), names: new Map() };
  const opts = { nameThreshold: 0.6, rejectBelow: 0.3, kindThreshold: 0.85 };
  for (
    const [pin, want] of [["tv:18197", ["tv", 18197]], [18197, [
      "movie",
      18197,
    ]]] as const
  ) {
    const o = { [it.path]: pin };
    const names = decideNames([it], none, o, opts);
    const [q] = buildMatchQueries([it], names, o);
    assertEquals<unknown[]>([q.kind, q.tmdbId], [...want]);
  }
  assertEquals(parsePin("tv:0"), null);
  assertEquals(parsePin("show:5"), null);
});

Deno.test("IMPORT_SCRIPT moves, never overwrites, and is idempotent", async () => {
  const d = await Deno.makeTempDir();
  await Deno.mkdir(`${d}/in/Dir A`, { recursive: true });
  await Deno.mkdir(`${d}/lib`);
  await Deno.writeTextFile(`${d}/in/it's.mkv`, "x");
  await Deno.writeTextFile(`${d}/in/clash.mkv`, "new");
  await Deno.writeTextFile(`${d}/lib/clash.mkv`, "old");
  await Deno.writeTextFile(`${d}/lib/done.mkv`, "x");
  const srcs = ["Dir A", "it's.mkv", "clash.mkv", "done.mkv", "nope.mkv"];
  const p = new Deno.Command("bash", {
    args: ["-s", "--", `${d}/lib`, ...srcs.map((s) => `${d}/in/${s}`)],
    stdin: "piped",
    stdout: "piped",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(IMPORT_SCRIPT));
  await w.close();
  const out = new TextDecoder().decode((await p.output()).stdout);
  assertEquals(out.trim().split("\n").map((l) => l.split("\t")[0]), [
    "MOVED",
    "MOVED",
    "CONFLICT",
    "ALREADY",
    "MISSING",
  ]);
  assertEquals(await Deno.readTextFile(`${d}/lib/clash.mkv`), "old");
  await Deno.remove(d, { recursive: true });
});

Deno.test("REMOVE_SCRIPT deletes only downloads whose library copy exists", async () => {
  const d = await Deno.makeTempDir();
  await Deno.mkdir(`${d}/in/Dir A`, { recursive: true });
  await Deno.mkdir(`${d}/lib`);
  await Deno.writeTextFile(`${d}/in/Dir A/a.mkv`, "xx");
  await Deno.writeTextFile(`${d}/in/orphan.mkv`, "x");
  await Deno.writeTextFile(`${d}/lib/A.mkv`, "xx");
  const p = new Deno.Command("bash", {
    args: [
      "-s",
      "--",
      `${d}/in/Dir A`,
      `${d}/lib/A.mkv`,
      `${d}/in/orphan.mkv`,
      `${d}/lib/gone.mkv`,
      `${d}/in/nope.mkv`,
      `${d}/lib/A.mkv`,
    ],
    stdin: "piped",
    stdout: "piped",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(REMOVE_SCRIPT));
  await w.close();
  const out = new TextDecoder().decode((await p.output()).stdout);
  assertEquals(out.trim().split("\n").map((l) => l.split("\t")[0]), [
    "DELETED",
    "NO_LIBRARY_COPY",
    "MISSING",
  ]);
  assertEquals(await Deno.readTextFile(`${d}/in/orphan.mkv`), "x");
  await Deno.remove(d, { recursive: true });
});

Deno.test("staleFactNames: facts no longer catalogued are dropped", () => {
  assertEquals(
    staleFactNames(
      [{ name: "film-a" }, { name: "film-b" }, { name: "film-b" }, {
        name: "film-c",
      }],
      [{ key: "film-a" }, { key: "film-d" }],
    ),
    ["film-b", "film-c"],
  );
});
