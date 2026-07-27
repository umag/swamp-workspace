import { assert, assertEquals } from "jsr:@std/assert@1";
import { computePairs } from "./pairs.ts";
import { groupRows, newWarn, type Row } from "./rankable.ts";

// N shared titles rated by every user; scores chosen so correlations differ.
function rowsFor(
  users: Record<string, (id: number) => number>,
  n = 60,
  withCover = true,
): Row[] {
  const rows: Row[] = [];
  for (const [user, scoreFn] of Object.entries(users)) {
    for (let id = 1; id <= n; id++) {
      rows.push({
        user,
        media_id: id,
        score: scoreFn(id),
        romaji: "Title " + id,
        english: null,
        genres: ["Drama"],
        year: 2000,
        format: "TV",
        episodes: 12,
        duration: 24,
        world: 70,
        popularity: 1000,
        cover: withCover ? "http://c/" + id : null,
      });
    }
  }
  return rows;
}

Deno.test("computePairs: best pair (r=1), worst pair (negative), covers filled", () => {
  const rows = rowsFor({
    aaa: (id) => (id % 10) + 1,
    bbb: (id) => (id % 10) + 1, // identical to aaa -> perfect correlation
    ccc: (id) => 10 - (id % 10), // anti-correlated with aaa
  });
  const warn = newWarn();
  const [pair1, pair2] = computePairs(groupRows(rows), rows, warn);

  // best: aaa & bbb, r = 1.00
  assert(pair1 !== null);
  assertEquals(pair1!.w, "aaa · bbb");
  assertEquals(pair1!.n, "1,00");
  assertEquals(pair1!.t, "Совпали"); // not a curated pair -> neutral title
  assertEquals(pair1!.cap, "вкус — один на двоих");
  assert(pair1!.p.includes("60 общих"));
  assert(pair1!.covers.length === 2);

  // worst: aaa & ccc (first of the tied negatives), title «Непримиримые»
  assert(pair2 !== null);
  assertEquals(pair2!.t, "Непримиримые");
  assertEquals(pair2!.w, "aaa · ccc");
  assert(pair2!.n.startsWith("−"), `expected negative corr, got ${pair2!.n}`);
  assert(pair2!.cap.includes("против"));
});

Deno.test("computePairs: CURATED pair title/caption when the holders match", () => {
  const rows = rowsFor({
    akemiv: (id) => (id % 10) + 1,
    nanavi42: (id) => (id % 10) + 1,
    zzz: (id) => 10 - (id % 10),
  });
  const warn = newWarn();
  const [pair1] = computePairs(groupRows(rows), rows, warn);
  assert(pair1 !== null);
  // best pair is akemiv & nanavi42 -> curated (order-independent)
  assertEquals(pair1!.t, "Муж и жена");
  assertEquals(pair1!.cap, "кажется, один диван");
});

// ── covers2[0] guard: no common title has a cover -> pair2 is skipped, not a
// crash on an undefined `fight`. pair1 still renders (it never derefs cover[0]).
Deno.test("computePairs: covers2[0] guarded when no common cover exists", () => {
  const rows = rowsFor(
    {
      aaa: (id) => (id % 10) + 1,
      bbb: (id) => (id % 10) + 1,
      ccc: (id) => 10 - (id % 10),
    },
    60,
    false, // no covers
  );
  const warn = newWarn();
  const [pair1, pair2] = computePairs(groupRows(rows), rows, warn);
  assert(pair1 !== null); // best pair still renders (empty covers)
  assertEquals(pair1!.covers.length, 0);
  assertEquals(pair2, null); // worst pair skipped: covers2[0] would be undefined
  assert(warn.skips.some((w) => w.includes("pair-worst")));
});

Deno.test("computePairs: below PAIR_MIN_COMMON -> no pairs", () => {
  // only 10 shared titles < 50
  const rows = rowsFor({ aaa: (id) => id, bbb: (id) => id }, 10);
  const warn = newWarn();
  const [pair1, pair2] = computePairs(groupRows(rows), rows, warn);
  assertEquals(pair1, null);
  assertEquals(pair2, null);
});
