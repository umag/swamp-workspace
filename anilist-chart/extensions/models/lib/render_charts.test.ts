import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type ChartRow,
  renderBayesJson,
  renderChart,
} from "./render_charts.ts";
import { findUnpublishable } from "./publish_gate.ts";

function row(over: Partial<ChartRow>): ChartRow {
  return {
    media_id: 1,
    title: "A",
    votes: 3,
    average_score: 80,
    cover_url: "https://cdn/x.jpg",
    ...over,
  };
}

Deno.test("chart renders one filled cell and one empty cell per rank", () => {
  const html = renderChart({
    mode: "chart",
    topK: 2,
    final: {
      Comedy: [row({ media_id: 1, title: "One" }), null],
    },
  });
  assertStringIncludes(html, "<title>Top 2 Anime by Genre");
  assertStringIncludes(html, ">One<"); // title-text node
  assertStringIncludes(html, "Avg: 80.00 (3 votes)");
  assertStringIncludes(html, "<td></td>"); // the null rank-2 slot
  assertEquals(findUnpublishable(html), []);
});

Deno.test("topK is threaded into title and H1", () => {
  const html = renderChart({ mode: "chart", topK: 13, final: { A: [] } });
  assertStringIncludes(html, "Top 13 Anime by Genre");
});

Deno.test("fresh tooltip carries penalized score and year", () => {
  const html = renderChart({
    mode: "fresh",
    topK: 1,
    final: {
      Action: [
        row({ penalized_score: 61.2, average_score: 80, start_year: 2001 }),
      ],
    },
  });
  assertStringIncludes(html, "Score: 61.20 (80.00)");
  assertStringIncludes(html, "Year: 2001");
});

Deno.test("bayes chart shows m/C info line and bayesian tooltip", () => {
  const html = renderChart({
    mode: "bayes",
    topK: 1,
    m: 5,
    c: 72.5,
    now: new Date("2026-07-21T00:00:00Z"),
    final: { Drama: [row({ bayesian_rating: 77.7, average_score: 82 })] },
  });
  assertStringIncludes(html, "m=5, global avg C=72.50/100");
  assertStringIncludes(html, "Bayesian: 77.70/100");
  assertStringIncludes(html, "Generated on: 2026-07-21T00:00:00.000Z");
});

Deno.test("current chart capitalises the season", () => {
  const html = renderChart({
    mode: "current",
    topK: 1,
    season: "summer",
    year: 2026,
    final: { Comedy: [row({})] },
  });
  assertStringIncludes(html, "Top 1 Anime of Summer 2026 by Genre");
});

Deno.test("a title with HTML metacharacters is escaped, not injected", () => {
  const html = renderChart({
    mode: "chart",
    topK: 1,
    final: { Comedy: [row({ title: `<script>"&` })] },
  });
  assert(!html.includes("<script>"));
  assertStringIncludes(html, "&lt;script&gt;&quot;&amp;");
});

Deno.test("a non-finite score throws (fails loud into the fan-out)", () => {
  let threw = false;
  try {
    renderChart({
      mode: "chart",
      topK: 1,
      final: { Comedy: [row({ average_score: NaN })] },
    });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("bayes JSON serialises the pre-dedup map with anilist_url", () => {
  const json = renderBayesJson({
    Comedy: [row({ media_id: 42, title: "X", bayesian_rating: 70, votes: 9 })],
  });
  const parsed = JSON.parse(json);
  assertEquals(parsed.Comedy[0].id, 42);
  assertEquals(parsed.Comedy[0].anilist_url, "https://anilist.co/anime/42");
  assertEquals(parsed.Comedy[0].bayesian_rating, 70);
});
