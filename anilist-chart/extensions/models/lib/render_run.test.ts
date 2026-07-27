import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  aggregateGenres,
  evaluateFreshness,
  mapBoardRow,
  runFanOut,
  seasonWindow,
} from "./render_run.ts";

// ── freshness gate ──────────────────────────────────────────────────────────

const fresh = {
  scoreRowCount: 100,
  metadataRowCount: 90,
  metadataCoverage: 0.99,
  newestDataAgeMs: 3 * 86400000,
  priorRunExists: true,
};

Deno.test("freshness: healthy data publishes with no anomalies", () => {
  const v = evaluateFreshness(fresh);
  assertEquals(v.ok, true);
  assertEquals(v.anomalies, []);
});

Deno.test("freshness: zero score rows refuses", () => {
  const v = evaluateFreshness({ ...fresh, scoreRowCount: 0 });
  assertEquals(v.ok, false);
  assert(v.refuseReason!.includes("no score rows"));
});

Deno.test("freshness: empty metadata refuses on a non-first run", () => {
  const v = evaluateFreshness({ ...fresh, metadataRowCount: 0 });
  assertEquals(v.ok, false);
  assert(v.refuseReason!.includes("metadata is empty"));
});

Deno.test("freshness: empty metadata is EXEMPT on the first run", () => {
  const v = evaluateFreshness({
    ...fresh,
    metadataRowCount: 0,
    priorRunExists: false,
  });
  assertEquals(v.ok, true);
  assert(v.anomalies.some((a) => a.includes("first run")));
});

Deno.test("freshness: stale data past the wide window is an anomaly, not a refusal", () => {
  // A frozen corpus must still publish last-known-good rather than wedge.
  const v = evaluateFreshness({ ...fresh, newestDataAgeMs: 40 * 86400000 });
  assertEquals(v.ok, true);
  assertEquals(v.refuseReason, null);
  assert(v.anomalies.some((a) => a.includes("window")));
});

Deno.test("freshness: low coverage is an anomaly, never a refusal", () => {
  const v = evaluateFreshness({ ...fresh, metadataCoverage: 0.4 });
  assertEquals(v.ok, true);
  assert(v.anomalies.some((a) => a.includes("coverage")));
});

// ── fan-out ─────────────────────────────────────────────────────────────────

Deno.test("one throwing renderer still yields the other five artifacts", () => {
  const tasks = [
    { key: "board", render: () => ({ key: "board", html: "<p>ok</p>" }) },
    { key: "landing", render: () => ({ key: "landing", html: "<p>ok</p>" }) },
    { key: "chart", render: () => ({ key: "chart", html: "<p>ok</p>" }) },
    {
      key: "fresh",
      render: (): { key: string; html: string } => {
        throw new Error("boom");
      },
    },
    { key: "bayes", render: () => ({ key: "bayes", html: "<p>ok</p>" }) },
    { key: "current", render: () => ({ key: "current", html: "<p>ok</p>" }) },
  ];
  const r = runFanOut(tasks);
  assertEquals(r.published.length, 5);
  assertEquals(r.failed.length, 1);
  assertEquals(r.failed[0].key, "fresh");
  assert(!r.published.some((p) => p.key === "fresh"));
});

Deno.test("a page failing the publish backstop is refused, not published", () => {
  const tasks = [
    { key: "good", render: () => ({ key: "good", html: "<p>fine</p>" }) },
    {
      key: "bad",
      render: () => ({ key: "bad", html: "<span>undefined</span>" }),
    },
  ];
  const r = runFanOut(tasks);
  assertEquals(r.published.map((p) => p.key), ["good"]);
  assertEquals(r.refused.map((p) => p.key), ["bad"]);
});

Deno.test("tasks run in order so a later task sees an earlier task's value", () => {
  let shared = 15;
  const tasks = [
    {
      key: "board",
      render: () => {
        shared = 13; // board lowers the record count
        return { key: "board", html: "<p>b</p>", recordCount: 13 };
      },
    },
    {
      key: "landing",
      render: () => ({ key: "landing", html: `<b>${shared}</b>` }),
    },
  ];
  const r = runFanOut(tasks);
  assertEquals(r.published[1].html, "<b>13</b>");
});

// ── board row coercion ──────────────────────────────────────────────────────

Deno.test("mapBoardRow coerces Int64-as-string and null-safes metadata", () => {
  const row = mapBoardRow({
    user_name: "Mag",
    media_id: "12345",
    score: "8.5",
    title_romaji: null,
    title_english: "English",
    genres: ["Comedy"],
    start_year: "2001",
    format: null,
    episodes: "12",
    duration: null,
    average_score: "77",
    popularity: null,
    cover_image_large: null,
  });
  assertEquals(row.media_id, 12345);
  assertEquals(row.score, 8.5);
  assertEquals(row.romaji, null);
  assertEquals(row.english, "English");
  assertEquals(row.year, 2001);
  assertEquals(row.episodes, 12);
  assertEquals(row.world, 77);
  assertEquals(row.duration, null);
});

// ── chart aggregation ───────────────────────────────────────────────────────

const meta = (over: Record<string, unknown> = {}) => ({
  media_id: 1,
  title_romaji: "T1",
  genres: ["Comedy"],
  format: "TV",
  ...over,
});

Deno.test("aggregate counts only score>0 as votes", () => {
  const scores = [
    { media_id: 1, score: 8 },
    { media_id: 1, score: 0 }, // unrated, not a vote
    { media_id: 1, score: 6 },
  ];
  const { genreMap } = aggregateGenres(scores, [meta()], {
    mode: "chart",
    topK: 5,
  });
  assertEquals(genreMap.Comedy[0].votes, 2);
  assertEquals(genreMap.Comedy[0].average_score, 7);
});

Deno.test("chart mode keeps null-format but bayes drops it", () => {
  const scores = [{ media_id: 1, score: 9 }];
  const nullFmt = [meta({ format: null })];
  assert(
    aggregateGenres(scores, nullFmt, { mode: "chart", topK: 5 }).genreMap
      .Comedy,
  );
  const bayes = aggregateGenres(scores, nullFmt, { mode: "bayes", topK: 5 });
  assertEquals(Object.keys(bayes.genreMap).length, 0); // null-format excluded
});

Deno.test("both chart and bayes drop explicit MOVIE", () => {
  const scores = [{ media_id: 1, score: 9 }];
  const movie = [meta({ format: "MOVIE" })];
  assertEquals(
    Object.keys(
      aggregateGenres(scores, movie, { mode: "chart", topK: 5 }).genreMap,
    )
      .length,
    0,
  );
});

Deno.test("fresh mode attaches an (unclamped) penalized score", () => {
  const scores = [{ media_id: 1, score: 8 }];
  const old = [meta({ start_year: 1990 })];
  const { genreMap } = aggregateGenres(scores, old, {
    mode: "fresh",
    topK: 5,
    now: new Date("2026-07-21T00:00:00Z"),
    penaltyRate: 0.05,
  });
  const row = genreMap.Comedy[0];
  assert(row.penalized_score !== undefined);
  assert(row.penalized_score! < row.average_score); // old title is penalized down
});

Deno.test("seasonWindow gives summer 2026 quarter bounds", () => {
  const w = seasonWindow(new Date("2026-07-21T12:00:00Z"));
  assertEquals(w.start, "2026-07-01");
  assertEquals(w.end, "2026-10-01");
  assertEquals(w.label, "лето 2026");
});
