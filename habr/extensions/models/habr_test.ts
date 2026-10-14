/**
 * Contract-fixture suite for @magistr/habr: pins the /kek/v2 wire format —
 * request paths and query params, and the mapping of the hand-authored
 * response fixtures (see fixtures/PROVENANCE.md) into stored resources.
 * If a test here breaks, the contract with Habr's JSON API changed.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./habr.ts";
import { BASE, habrRoute, makeCtx, withFetch } from "./habr_harness_test.ts";
import page1 from "../../fixtures/feed_page1.json" with { type: "json" };
import page2 from "../../fixtures/feed_page2.json" with { type: "json" };
import article from "../../fixtures/article.json" with { type: "json" };

const route = habrRoute({
  pages: { "1": page1, "2": page2 },
  articles: { "900001": article },
});

Deno.test("list-articles: requests /kek/v2/articles/ with user, fl, hl, page", async () => {
  const { ctx } = makeCtx();
  await withFetch(route, async (calls) => {
    await model.methods["list-articles"].execute(
      { user: "fixture_author" },
      ctx,
    );
    assertEquals(calls.length, 2);
    for (const [i, c] of calls.entries()) {
      assertEquals(c.url.origin, BASE);
      assertEquals(c.url.pathname, "/kek/v2/articles/");
      assertEquals(c.url.searchParams.get("user"), "fixture_author");
      assertEquals(c.url.searchParams.get("fl"), "ru");
      assertEquals(c.url.searchParams.get("hl"), "ru");
      assertEquals(c.url.searchParams.get("page"), String(i + 1));
    }
  });
});

Deno.test("list-articles: sends a browser UA, JSON accept and manual redirects", async () => {
  const { ctx } = makeCtx();
  await withFetch(route, async (calls) => {
    await model.methods["list-articles"].execute(
      { user: "fixture_author" },
      ctx,
    );
    const h = calls[0].headers;
    assertEquals(h["accept"], "application/json, text/plain, */*");
    assertEquals(h["user-agent"].startsWith("Mozilla/5.0"), true);
    assertEquals(calls[0].redirect, "manual");
  });
});

Deno.test("list-articles: fixture maps to the stored articles shape", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    route,
    () =>
      model.methods["list-articles"].execute({ user: "fixture_author" }, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "articles");
  assertEquals(written[0].name, "fixture_author");
  const p = model.resources.articles.schema.parse(written[0].payload);
  assertEquals(p.user, "fixture_author");
  assertEquals(p.pagesCount, 2);
  assertEquals(p.pagesFetched, 2);
  // 900404 has no ref and is skipped.
  assertEquals(p.total, 3);
  assertEquals(p.articles.map((a) => a.id), ["900001", "900002", "900003"]);
  assertEquals(p.articles[0], {
    id: "900001",
    title: "Fixture «one» — first post",
    url: `${BASE}/ru/articles/900001/`,
    lang: "ru",
    timePublished: "2026-09-01T10:00:00+00:00",
    readingTime: 7,
    complexity: "medium",
    postType: "article",
    tags: ["testing", "deno & ts"],
    hubs: ["programming"],
    author: "fixture_author",
    statistics: {
      reads: 1234,
      comments: 5,
      score: 12,
      votesPlus: 14,
      votesMinus: 2,
      bookmarks: 30,
    },
  });
  // Empty statistics default to zero, null complexity stays null.
  assertEquals(p.articles[1].statistics.reads, 0);
  assertEquals(p.articles[1].complexity, null);
  // Per-ref lang wins for the URL; plain `title` tags are accepted.
  assertEquals(p.articles[2].url, `${BASE}/en/articles/900003/`);
  assertEquals(p.articles[2].tags, ["plain-title-tag"]);
});

Deno.test("get-article: requests /kek/v2/articles/<id>/ with fl and hl", async () => {
  const { ctx } = makeCtx();
  await withFetch(route, async (calls) => {
    await model.methods["get-article"].execute({ id: "900001" }, ctx);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url.pathname, "/kek/v2/articles/900001/");
    assertEquals(calls[0].url.searchParams.get("fl"), "ru");
    assertEquals(calls[0].url.searchParams.get("hl"), "ru");
  });
});

Deno.test("get-article: fixture maps to the stored article shape", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    route,
    () => model.methods["get-article"].execute({ id: "900001" }, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "article");
  assertEquals(written[0].name, "900001");
  const a = model.resources.article.schema.parse(written[0].payload);
  assertEquals(a.title, "Fixture «one» — first post");
  assertEquals(a.textHtml, article.textHtml);
  assertEquals(
    a.text,
    "Intro\nHello world & friends.\n\n• one\n• two\n\nLine\nbreak",
  );
});

Deno.test("lang global argument flows into fl/hl and the article URL", async () => {
  const { ctx, written } = makeCtx({ baseUrl: BASE, lang: "en" });
  await withFetch(
    (c) =>
      habrRoute({ articles: { "900001": { ...article, lang: undefined } } })(c),
    async (calls) => {
      await model.methods["get-article"].execute({ id: "900001" }, ctx);
      assertEquals(calls[0].url.searchParams.get("fl"), "en");
    },
  );
  assertEquals(written[0].payload.url, `${BASE}/en/articles/900001/`);
});
