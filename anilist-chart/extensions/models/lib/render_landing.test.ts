import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { type LandingStats, renderLanding } from "./render_landing.ts";
import { findUnpublishable } from "./publish_gate.ts";

function stats(over: Partial<LandingStats> = {}): LandingStats {
  return {
    users: 18,
    rows: 12345,
    rated: 9000,
    titles: 4154,
    genres: 18,
    cur_titles: 7,
    cur_users: 4,
    movies: 321,
    y_min: 1963,
    y_max: 2026,
    season: "лето 2026",
    ...over,
  };
}

/** The /board card is everything from its <a ...href="/board"> up to </a>. */
function boardCard(html: string): string {
  const start = html.indexOf(`href="/board"`);
  assert(start >= 0, "no /board card");
  const end = html.indexOf("</a>", start);
  return html.slice(start, end);
}

Deno.test("15 records advertises пятнадцать and 15 in the /board card", () => {
  const html = renderLanding({ stats: stats(), recordCount: 15, topK: 13 });
  const card = boardCard(html);
  assertStringIncludes(card, "пятнадцать званий");
  assertStringIncludes(card, ">15<"); // the figure
  assertEquals(findUnpublishable(html), []);
});

Deno.test("recordCount=13 => neither пятнадцать nor 15 in the /board card", () => {
  const html = renderLanding({ stats: stats(), recordCount: 13, topK: 13 });
  const card = boardCard(html);
  assert(!card.includes("пятнадцать"), "should not advertise пятнадцать");
  assert(!card.includes("15"), "should not advertise 15");
  assertStringIncludes(card, "13 званий");
  assertStringIncludes(card, ">13<");
});

Deno.test("topK is advertised on the /chart card", () => {
  const html = renderLanding({ stats: stats(), recordCount: 15, topK: 10 });
  assertStringIncludes(html, "жанров, по 10 тайтлов");
});

Deno.test("landing renders clean and includes the season", () => {
  const html = renderLanding({ stats: stats(), recordCount: 15, topK: 13 });
  assertStringIncludes(html, "идёт прямо сейчас, лето 2026");
  assertStringIncludes(html, "1963—2026");
  assertEquals(findUnpublishable(html), []);
});
