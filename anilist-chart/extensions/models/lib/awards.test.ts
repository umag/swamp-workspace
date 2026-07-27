import { assert, assertEquals } from "jsr:@std/assert@1";
import { computeAwards } from "./awards.ts";
import { groupRows, newWarn, type Row } from "./rankable.ts";

const GEN = [
  "Comedy",
  "Action",
  "Slice of Life",
  "Drama",
  "Fantasy",
  "Romance",
  "Mystery",
  "Adventure",
];

function meta(id: number) {
  return {
    world: 50 + (id % 40),
    popularity: 100 + id * 10,
    episodes: 12 + (id % 4) * 6,
    duration: 24,
    year: 1970 + (id % 56), // some < 1990
    genres: [GEN[id % 8]].concat(id % 7 === 0 ? ["Sports"] : []),
    romaji: "Title " + id,
  };
}

// A full fixture: 3 users, ~140 titles each, overlapping in the middle with
// solo tails, world/popularity/episodes present — enough for every gate
// (MIN_LIST=100, MIN_RATED=100) to have a holder, so all 15 awards render.
function fullRows(world = true): Row[] {
  const rows: Row[] = [];
  const ranges: Record<string, [number, number]> = {
    aaa: [1, 140],
    bbb: [60, 200],
    ccc: [120, 260],
  };
  for (const [user, [lo, hi]] of Object.entries(ranges)) {
    for (let id = lo; id <= hi; id++) {
      const m = meta(id);
      const score = id % 13 === 0 ? 0 : (id % 10) + 1; // some 0 -> list > nrated
      rows.push({
        user,
        media_id: id,
        score,
        romaji: m.romaji,
        english: null,
        genres: m.genres,
        year: m.year,
        format: id % 20 === 0 ? "MOVIE" : "TV",
        episodes: m.episodes,
        duration: m.duration,
        world: world ? m.world : null,
        popularity: m.popularity,
        cover: "http://c/" + id,
      });
    }
  }
  return rows;
}

Deno.test("computeAwards: 3 top + 12 rest slots; the full fixture renders all 15", () => {
  const rows = fullRows();
  const warn = newWarn();
  const res = computeAwards(groupRows(rows), rows, warn);

  assertEquals(res.top.length, 3);
  assertEquals(res.rest.length, 12);

  const all = [...res.top, ...res.rest];
  const rendered = all.filter((a) => a !== null).length;
  const skipped = all.filter((a) => a === null).length;
  assertEquals(all.length, 15);
  assertEquals(rendered + skipped, 15); // the invariant
  assertEquals(rendered, 15); // this fixture fills every award
  assertEquals(skipped, 0);

  // every genre keeper resolved
  assertEquals(res.keepers.length, 8);
  // keepers sorted by share desc
  for (let i = 1; i < res.keepers.length; i++) {
    assert(res.keepers[i - 1].p >= res.keepers[i].p);
  }

  // spot-check the named awards are present with the expected titles
  const titles = all.filter(Boolean).map((a) => a!.t);
  assert(titles.includes("Археолог"));
  assert(titles.includes("Архивариус"));
  assert(titles.includes("Золотая середина"));
});

// ── CASCADE: skipping «Глас народа» (vox, 10) also skips «Золотая середина»
// (mid, 12). With no world data, devs are empty, so signed/absdev are empty and
// awards 09/10/12 all skip — mid must NOT silently pick a holder. ─────────────
Deno.test("computeAwards: vox skipped -> mid skipped (no silent pick)", () => {
  const rows = fullRows(false); // world = null everywhere
  const warn = newWarn();
  const res = computeAwards(groupRows(rows), rows, warn);

  // rest indices: 0 tl,1 sp,2 co,3 tn,4 st,5 up,6 vox,7 wolf,8 mid,9 ec,10 dg,11 mar
  assertEquals(res.rest[5], null); // up (09) skipped
  assertEquals(res.rest[6], null); // vox (10) skipped
  assertEquals(res.rest[8], null); // mid (12) skipped, cascaded from vox
  assert(
    warn.skips.some((w) => w.toLowerCase().includes("mid")),
    "mid skip should be recorded",
  );
  // rendered + skipped still totals 15
  const all = [...res.top, ...res.rest];
  const rendered = all.filter(Boolean).length;
  const skipped = all.length - rendered;
  assertEquals(rendered + skipped, 15);
});

// ── CURATED holder-changed fallback for «flop» ───────────────────────────────
Deno.test("computeAwards: changed flop holder uses neutral note + one flop warn", () => {
  const rows = fullRows();
  const warn = newWarn();
  const res = computeAwards(groupRows(rows), rows, warn);

  const flop = res.top[0]!; // «Защитник безнадёжных»
  assertEquals(flop.t, "Защитник безнадёжных");
  // holder is one of our synthetic users, never the curated 'stakanVpechen',
  // so the note must be the computed neutral text, not the hand-written joke.
  assert(!flop.s.includes("Boku no Pico"));
  assert(flop.s.includes("у мира"));

  // exactly one 'flop' holder-changed warning, in the SEPARATE curated channel
  const flopWarns = warn.curated.filter((w) => w.startsWith("flop"));
  assertEquals(flopWarns.length, 1);
});
