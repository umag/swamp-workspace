import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildRenderTasks, model, type RenderInputs } from "./anilist_chart.ts";
import {
  type RawBoardRow,
  type RawChartMeta,
  runFanOut,
} from "./lib/render_run.ts";
import type { LandingStats } from "./lib/render_landing.ts";

// A tiny but internally-consistent dataset: three users, a handful of titles,
// enough that the board + charts all render clean.
function inputs(over: Partial<RenderInputs> = {}): RenderInputs {
  const users = ["alice", "bob", "carol"];
  const boardRows: RawBoardRow[] = [];
  for (let mid = 1; mid <= 6; mid++) {
    for (const u of users) {
      boardRows.push({
        user_name: u,
        media_id: mid,
        score: 6 + (mid % 4),
        title_romaji: `Title ${mid}`,
        title_english: `T${mid}`,
        genres: ["Comedy", "Action"],
        start_year: 2010 + mid,
        format: "TV",
        episodes: 12,
        duration: 24,
        average_score: 70 + mid,
        popularity: 1000 * mid,
        cover_image_large: `https://cdn/${mid}.jpg`,
      });
    }
  }
  const chartScores = boardRows.map((r) => ({
    user_name: r.user_name,
    media_id: r.media_id,
    score: r.score,
  }));
  const chartMeta: RawChartMeta[] = [];
  for (let mid = 1; mid <= 6; mid++) {
    chartMeta.push({
      media_id: mid,
      title_romaji: `Title ${mid}`,
      title_english: `T${mid}`,
      genres: ["Comedy", "Action"],
      format: "TV",
      start_year: 2010 + mid,
      start_date: `${2010 + mid}-07-05`,
      cover_image_large: `https://cdn/${mid}.jpg`,
    });
  }
  const landing: LandingStats = {
    users: 3,
    rows: boardRows.length,
    rated: boardRows.length,
    titles: 6,
    genres: 2,
    cur_titles: 1,
    cur_users: 1,
    movies: 0,
    y_min: 2011,
    y_max: 2016,
    season: "лето 2026",
  };
  return {
    boardRows,
    boardNrows: boardRows.length,
    chartScores,
    chartMeta,
    landing,
    topK: 13,
    bayesMinVotes: 5,
    penaltyRate: 0.05,
    now: new Date("2026-07-21T12:00:00Z"),
    ...over,
  };
}

Deno.test("render fans out exactly seven artifacts", () => {
  const { tasks } = buildRenderTasks(inputs());
  assertEquals(tasks.map((t) => t.key), [
    "board",
    "landing",
    "chart",
    "fresh",
    "bayes",
    "bayes-json",
    "current",
  ]);
});

Deno.test("all seven artifacts publish clean on a healthy dataset", () => {
  const { tasks } = buildRenderTasks(inputs());
  const r = runFanOut(tasks);
  assertEquals(r.failed, []);
  assertEquals(r.refused, []);
  assertEquals(r.published.length, 7);
});

Deno.test("topK is threaded into BOTH the chart and the landing copy", () => {
  const { tasks } = buildRenderTasks(inputs({ topK: 10 }));
  const r = runFanOut(tasks);
  const landing = r.published.find((p) => p.key === "landing")!;
  const chart = r.published.find((p) => p.key === "chart")!;
  assertStringIncludes(landing.html, "жанров, по 10 тайтлов"); // landing advertises 10
  assertStringIncludes(chart.html, "Top 10 Anime by Genre"); // chart built at 10
});

Deno.test("bayesMinVotes is threaded into the /bayes info line", () => {
  const { tasks } = buildRenderTasks(inputs({ bayesMinVotes: 9 }));
  const r = runFanOut(tasks);
  const bayes = r.published.find((p) => p.key === "bayes")!;
  assertStringIncludes(bayes.html, "m=9,");
});

Deno.test("a board that throws still lets the landing publish (fallback count)", () => {
  // Corrupt the board input so the board renderer throws; the landing must
  // still render, falling back to the 15-record count.
  // boardRows null makes the board task's `.map` throw; typed via unknown, no any.
  const bad: RenderInputs = {
    ...inputs(),
    boardRows: null as unknown as RawBoardRow[],
  };
  const { tasks } = buildRenderTasks(bad);
  const r = runFanOut(tasks);
  assert(r.failed.some((f) => f.key === "board"));
  assert(r.published.some((p) => p.key === "landing"));
});

Deno.test("model exposes render + settings and >=30d marker lifetimes", () => {
  assertEquals(model.type, "@magistr/anilist-chart");
  assert("render" in model.methods);
  assert("settings" in model.methods);
  // markers must outlive the weekly cadence, not use the 1h default
  assertEquals(model.resources.renderedPage.lifetime, "45d");
  assertEquals(model.resources.renderRun.lifetime, "90d");
  assertEquals(model.resources.settings.lifetime, "30d");
});
