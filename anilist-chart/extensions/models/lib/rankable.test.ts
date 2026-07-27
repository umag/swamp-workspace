import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertFinite,
  CURATED_AWARDS,
  curatedNote,
  groupRows,
  newWarn,
  pairCurated,
  pickOrSkip,
  type Row,
  titleOf,
} from "./rankable.ts";

function row(p: Partial<Row> & { user: string; media_id: number }): Row {
  return {
    score: 0,
    romaji: null,
    english: null,
    genres: null,
    year: null,
    format: null,
    episodes: null,
    duration: null,
    world: null,
    popularity: null,
    cover: null,
    ...p,
  };
}

// ── per-user stats: `list` UNFILTERED, `rated` = score>0 ─────────────────────
Deno.test("groupRows: list is the UNFILTERED count, rated excludes score 0", () => {
  const rows = [
    row({ user: "u", media_id: 1, score: 0 }), // in list, not rated
    row({ user: "u", media_id: 2, score: 5 }),
    row({ user: "u", media_id: 3, score: 10 }),
  ];
  const { per, users } = groupRows(rows);
  assertEquals(users, ["u"]);
  const p = per.get("u")!;
  // CRITICAL: if `list` were filtered to score>0, nrated/list would pin at 1.0
  // and «Совесть чата» would be broken.
  assertEquals(p.list, 3);
  assertEquals(p.nrated, 2);
  assertEquals(p.avg, 7.5);
  assertEquals(p.tens, 1);
  assertEquals(p.distinct, 2);
});

Deno.test("groupRows: users sorted, owners track cross-user ownership", () => {
  const rows = [
    row({ user: "b", media_id: 1, score: 8 }),
    row({ user: "a", media_id: 1, score: 9 }),
    row({ user: "a", media_id: 2, score: 7 }),
  ];
  const { users, owners } = groupRows(rows);
  assertEquals(users, ["a", "b"]);
  assertEquals([...owners.get(1)!].sort(), ["a", "b"]);
  assertEquals([...owners.get(2)!], ["a"]);
});

Deno.test("titleOf: romaji, then english, then #id", () => {
  assertEquals(
    titleOf(row({ user: "u", media_id: 5, romaji: "R", english: "E" })),
    "R",
  );
  assertEquals(
    titleOf(row({ user: "u", media_id: 5, romaji: null, english: "E" })),
    "E",
  );
  assertEquals(titleOf(row({ user: "u", media_id: 5 })), "#5");
});

// ── pickOrSkip: the single min/max site ──────────────────────────────────────
Deno.test("pickOrSkip: max/min pick, first-seen on ties (matches Python max/min)", () => {
  const warn = newWarn();
  const items = [{ id: "a", v: 5 }, { id: "b", v: 9 }, { id: "c", v: 9 }];
  assertEquals(pickOrSkip(items, (x) => x.v, "max", "t", warn)!.id, "b"); // first 9
  assertEquals(pickOrSkip(items, (x) => x.v, "min", "t", warn)!.id, "a");
  assertEquals(warn.skips.length, 0);
});

Deno.test("pickOrSkip: empty candidates -> null + one skip warn", () => {
  const warn = newWarn();
  const got = pickOrSkip(
    [] as { v: number }[],
    (x) => x.v,
    "max",
    "award-X",
    warn,
  );
  assertEquals(got, null);
  assertEquals(warn.skips.length, 1);
  assert(warn.skips[0].includes("award-X"));
});

Deno.test("pickOrSkip: non-finite winning key -> null + skip (fail closed)", () => {
  const warn = newWarn();
  const got = pickOrSkip([{ v: NaN }], (x) => x.v, "max", "award-Y", warn);
  assertEquals(got, null);
  assertEquals(warn.skips.length, 1);
});

// ── assertFinite: data-layer guard with field + media_id ─────────────────────
Deno.test("assertFinite returns finite values, throws with field+media_id", () => {
  assertEquals(assertFinite(3.5, "avg", 42), 3.5);
  const err = assertThrows(() => assertFinite(NaN, "sport_share", 7));
  assert(String(err).includes("sport_share"));
  assert(String(err).includes("7"));
  assertThrows(() => assertFinite(Infinity, "pop", 1));
});

// ── CURATED: exact holder vs holder-changed, separate warn channel ───────────
Deno.test("curatedNote: exact (award,holder) returns the hand note", () => {
  const warn = newWarn();
  assertEquals(
    curatedNote("sport", "LetoDeWirre", "computed", warn),
    "держит четверть велоспорта чата",
  );
  assertEquals(warn.curated.length, 0);
  assertEquals(warn.skips.length, 0);
});

Deno.test("curatedNote: holder changed -> computed text + ONE curated warn (separate channel)", () => {
  const warn = newWarn();
  const note = curatedNote(
    "flop",
    "someoneElse",
    "computed neutral text",
    warn,
  );
  assertEquals(note, "computed neutral text");
  assertEquals(warn.curated.length, 1); // curated channel
  assertEquals(warn.skips.length, 0); // NOT the pickOrSkip channel
  assert(warn.curated[0].includes("flop"));
});

Deno.test("curatedNote: conscience is a {rated}/{total} template", () => {
  const warn = newWarn();
  const note = curatedNote("conscience", "lizken", "computed", warn, {
    rated: "500",
    total: "512",
  });
  assertEquals(note, "оценил 500 из 512");
});

Deno.test("curatedNote: a key with no curated string at all never warns", () => {
  const warn = newWarn();
  curatedNote("archivist", "whoever", "computed", warn);
  assertEquals(warn.curated.length, 0);
});

// ── pair CURATED key is order-independent ────────────────────────────────────
Deno.test("pairCurated: order-independent membership (frozenset in oracle)", () => {
  const ab = pairCurated("akemiv", "nanavi42");
  const ba = pairCurated("nanavi42", "akemiv");
  assertEquals(ab, ba);
  assertEquals(ab!.title, "Муж и жена");
  assertEquals(ab!.caption, "кажется, один диван");
  assertEquals(pairCurated("akemiv", "someoneElse"), null);
});

Deno.test("CURATED_AWARDS holds exactly the four keyed notes", () => {
  assertEquals(
    Object.keys(CURATED_AWARDS).sort(),
    ["conscience|lizken", "flop|stakanVpechen", "sport|LetoDeWirre"].sort(),
  );
});
