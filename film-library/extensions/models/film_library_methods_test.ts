/**
 * Methods suite for @magistr/film-library: scan (ssh stubbed), names,
 * resolve and catalog (fake readModelData), success and failure paths.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { buildReadings, type Item, model } from "./film_library.ts";
import {
  fakeContext,
  jevRow,
  listing,
  matchRow,
  stubSsh,
} from "./film_library_test_helpers.ts";

const GB = 1024 ** 3;
const LIB = "/mnt/user/films/cinema";
const INC = "/mnt/user/downloads/complete";
const roots = [
  { path: LIB, role: "library" },
  { path: INC, role: "incoming" },
];
const raw = listing(LIB, [
  ["Forrest.Gump.1994.1080p.BluRay.x264.mkv", "f", 8 * GB],
  ["Anora (2024)", "d"],
  ["Anora (2024)/Anora.2024.2160p.WEB-DL.mkv", "f", 20 * GB],
  ["Anora (2024)/Anora.2024.srt", "f", 1000],
  ["Swan.Lake.Bolshoi.2015.mkv", "f", 4 * GB],
  ["Sherlock.S01.720p", "d"],
  ["Sherlock.S01.720p/Sherlock.S01E01.mkv", "f", GB],
  ["Sherlock.S01.720p/Sherlock.S01E02.mkv", "f", GB],
]) + listing(INC, [
  ["Forrest.Gump.1994.2160p.UHD.BluRay.REMUX.mkv", "f", 60 * GB],
  ["Adobe Photoshop 26.2.dmg", "f", 5 * GB],
  ["New.Film.2025.1080p.WEB-DL.mkv", "f", 4 * GB],
]);
const nameArgs = {
  nameThreshold: 0.6,
  rejectBelow: 0.3,
  kindThreshold: 0.85,
  batchSize: 100,
  maxBatches: 0,
  refresh: false,
};
const resolveArgs = {
  threshold: 0.7,
  margin: 0.2,
  batchSize: 100,
  maxBatches: 0,
  refresh: false,
};

async function scanned() {
  const s = stubSsh(raw);
  try {
    const f = fakeContext({ roots });
    await model.methods.scan.execute({}, f.context);
    return { ...f, ssh: s.seen };
  } finally {
    s.restore();
  }
}

const inv = (store: Record<string, unknown>) =>
  (store.inventory as { items: Item[] }).items;
const keyOf = (store: Record<string, unknown>, title: string, role: string) =>
  inv(store).find((i) => i.title === title && i.role === role)!;

/** Jev answers: kinds for everything, the first reading of each film right. */
function jevAnswers(store: Record<string, unknown>) {
  const items = inv(store);
  const results: { id: string; answers: Record<string, unknown> }[] = [];
  for (const it of items) {
    if (!["film", "series", "episode", "unknown"].includes(it.class)) continue;
    const kind = it.title.startsWith("Swan")
      ? "not_video"
      : it.class === "series"
      ? "tv_series"
      : "feature_film";
    results.push({
      id: it.key,
      answers: { kind: { type: "choice", choice: kind, confidence: 0.9 } },
    });
    buildReadings(it).forEach((r, i) =>
      results.push({
        id: `${it.key}::n::${r.id}`,
        answers: {
          correct_title: { type: "noul", noul: i === 0 ? 0.95 : 0.2 },
        },
      })
    );
  }
  return [jevRow("triage-batch-films-names-r1-0", results)];
}

Deno.test("scan classifies and parses every entry", async () => {
  const { writes, ssh } = await scanned();
  const d = writes[0].data as { stats: Record<string, Record<string, number>> };
  assertEquals(writes[0].spec, "inventory");
  assertEquals(d.stats, {
    library: { film: 3, series: 1 },
    incoming: { film: 2, other: 1 },
  });
  assert(
    ssh[0].args.at(-1)!.startsWith("bash -s -- 2 '/mnt/user/films/cinema'"),
  );
  assert(ssh[0].stdin.includes("stat --printf"));
});

Deno.test("scan surfaces ssh failure", async () => {
  const s = stubSsh("", false);
  try {
    const { context } = fakeContext({ roots });
    await assertRejects(
      () => model.methods.scan.execute({}, context),
      Error,
      "ssh command failed",
    );
  } finally {
    s.restore();
  }
});

Deno.test("names: without Jev answers, every video entry is asked and parser readings are searched", async () => {
  const { store } = await scanned();
  const f = fakeContext({ roots }, {}, store);
  await model.methods.names.execute(nameArgs, f.context);
  const n = f.writes[0].data as {
    stats: Record<string, number>;
    matchQueries: { title: string }[];
    kindBatches: unknown[][];
    nameBatches: unknown[][];
  };
  assertEquals(n.stats.parser, 5);
  assertEquals(n.kindBatches.flat().length, 6);
  assert(n.nameBatches.flat().length >= 5);
  assertEquals(n.matchQueries.length, 5);
});

Deno.test("names: Jev confirms titles and drops a confident not_video entry before TMDB", async () => {
  const { store } = await scanned();
  const f = fakeContext(
    { roots },
    { jev: { triageBatch: jevAnswers(store) } },
    store,
  );
  await model.methods.names.execute(nameArgs, f.context);
  const n = f.writes[0].data as {
    stats: Record<string, number>;
    matchQueries: { title: string }[];
    kindBatches: unknown[][];
    nameBatches: unknown[][];
  };
  assertEquals([n.stats.confirmed, n.stats.notFilm], [4, 2]);
  assertEquals(n.matchQueries.map((q) => q.title).sort(), [
    "Anora",
    "Forrest Gump",
    "Forrest Gump",
    "New Film",
  ]);
  assertEquals([n.kindBatches.length, n.nameBatches.length], [0, 0]);
});

Deno.test("resolve: clear hits accepted, ambiguous decided by Jev", async () => {
  const { store } = await scanned();
  const models = { jev: { triageBatch: jevAnswers(store) } } as Record<
    string,
    Record<string, unknown[]>
  >;
  await model.methods.names.execute(
    nameArgs,
    fakeContext({ roots }, models, store).context,
  );
  const gumpL = keyOf(store, "Forrest Gump", "library").key;
  const gumpI = keyOf(store, "Forrest Gump", "incoming").key;
  const anora = keyOf(store, "Anora", "library").key;
  const cand = (id: number, title: string, year: number) => ({
    id,
    kind: "movie" as const,
    title,
    originalTitle: null,
    year,
    overview: null,
    score: 0.9,
  });
  models.tmdb = {
    match: [matchRow("films", [
      {
        key: gumpL,
        status: "matched",
        tmdbId: 13,
        candidates: [cand(13, "Forrest Gump", 1994)],
      },
      {
        key: gumpI,
        status: "ambiguous",
        candidates: [cand(13, "Forrest Gump", 1994), cand(99, "Gump", 1994)],
      },
      {
        key: anora,
        status: "ambiguous",
        candidates: [cand(1064213, "Anora", 2024), cand(5, "Anora", 1990)],
      },
    ])],
  };
  models.jev.triageBatch.push(jevRow("triage-batch-films-pairs-r1-0", [
    {
      id: `${gumpI}::13`,
      answers: { same_film: { type: "noul", noul: 0.97 } },
    },
    {
      id: `${gumpI}::99`,
      answers: { same_film: { type: "noul", noul: 0.05 } },
    },
  ]));
  const f = fakeContext({ roots }, models, store);
  await model.methods.resolve.execute(resolveArgs, f.context);
  const res = f.writes[0].data as {
    decisions: { key: string; via: string; tmdbId: number | null }[];
    enrichIds: { id: number; kind: string }[];
    pairBatches: { id: string }[][];
  };
  const d = (key: string) => res.decisions.find((x) => x.key === key)!;
  assertEquals([d(gumpL).via, d(gumpL).tmdbId], ["score", 13]);
  assertEquals([d(gumpI).via, d(gumpI).tmdbId], ["jev", 13]);
  assertEquals([d(anora).via, d(anora).tmdbId], ["none", null]);
  assertEquals(res.enrichIds, [{ id: 13, kind: "movie" }]);
  const asked = res.pairBatches.flat().map((p) => p.id);
  assertEquals(asked.sort(), [`${anora}::1064213`, `${anora}::5`].sort());
});

Deno.test("resolve fails clearly without a tmdb match set", async () => {
  const { store } = await scanned();
  await model.methods.names.execute(
    nameArgs,
    fakeContext({ roots }, {}, store).context,
  );
  const f = fakeContext({ roots }, {}, store);
  await assertRejects(
    () => model.methods.resolve.execute(resolveArgs, f.context),
    Error,
    "no match set",
  );
});

Deno.test("catalog builds facts, dimensions and worklists", async () => {
  const { store } = await scanned();
  const models = { jev: { triageBatch: jevAnswers(store) } } as Record<
    string,
    Record<string, unknown[]>
  >;
  await model.methods.names.execute(
    nameArgs,
    fakeContext({ roots }, models, store).context,
  );
  const gump = inv(store).filter((i) => i.title === "Forrest Gump");
  store.resolution = {
    decisions: gump.map((i) => ({
      key: i.key,
      tmdbId: 13,
      tmdbKind: "movie",
      via: "score",
      confidence: 0.9,
      jevVerdict: "unasked",
      candidates: [],
    })),
  };
  models.tmdb = {
    titles: [{
      name: "films",
      version: 1,
      attributes: {
        titles: {
          "movie:13": {
            id: 13,
            kind: "movie",
            title: "Forrest Gump",
            year: 1994,
            runtime: 142,
            genres: ["Drama"],
            countries: ["US"],
            originalLanguage: "en",
            directors: ["Robert Zemeckis"],
            collection: null,
          },
        },
      },
    }],
  };
  store.__specs = { "film-moved-away": "film" };
  const f = fakeContext({ roots }, models, store);
  await model.methods.catalog.execute({ writeFacts: true }, f.context);
  assertEquals(f.deletes, ["film-moved-away"]);
  const by = (spec: string, name?: string) =>
    f.writes.find((w) => w.spec === spec && (!name || w.name === name))!.data;
  const lib = by("library", "summary") as {
    films: number;
    enriched: number;
    totalRuntimeMinutes: number;
  };
  assertEquals([lib.films, lib.enriched, lib.totalRuntimeMinutes], [4, 2, 284]);
  const issues = by("issues") as {
    incomingAlreadyOwned: { isUpgrade: boolean }[];
    incomingToImport: { title: string }[];
    nonFilmInFilmFolders: { jevKind: string }[];
    seriesInLibrary: unknown[];
    nonFilmIncoming: { kind: string }[];
  };
  assertEquals(issues.incomingAlreadyOwned.map((x) => x.isUpgrade), [true]);
  assertEquals(issues.incomingToImport.map((x) => x.title), ["New Film"]);
  assertEquals(issues.nonFilmInFilmFolders.map((x) => x.jevKind), [
    "not_video",
  ]);
  assertEquals(issues.seriesInLibrary.length, 1);
  assertEquals(issues.nonFilmIncoming[0].kind, "other:software");
  const genres = by("dimension", "dim-genres") as {
    entries: { value: string; films: number }[];
  };
  assertEquals(genres.entries.find((e) => e.value === "Drama")!.films, 2);
});

Deno.test("catalog requires names and resolve first", async () => {
  const { store } = await scanned();
  await assertRejects(
    () =>
      model.methods.catalog.execute(
        { writeFacts: false },
        fakeContext({ roots }, {}, store).context,
      ),
    Error,
    "run the names method first",
  );
  await model.methods.names.execute(
    nameArgs,
    fakeContext({ roots }, {}, store).context,
  );
  await assertRejects(
    () =>
      model.methods.catalog.execute(
        { writeFacts: false },
        fakeContext({ roots }, {}, store).context,
      ),
    Error,
    "run resolve first",
  );
});
