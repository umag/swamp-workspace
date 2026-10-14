/**
 * Coverage suite for @magistr/habr: one test per guard, so deleting the guard
 * turns a test red.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  articleUrl,
  assertNumericId,
  decodeEntities,
  htmlToText,
  MAX_PAGES,
  model,
  normalizePagesCount,
  parseSummary,
  sanitizeAlias,
  sanitizeLang,
  stripHtml,
} from "./habr.ts";
import { habrRoute, json, makeCtx, withFetch } from "./habr_harness_test.ts";

Deno.test("sanitizeAlias trims surrounding whitespace", () => {
  assertEquals(sanitizeAlias("  Milfgard "), "Milfgard");
});

Deno.test("sanitizeAlias accepts underscore and hyphen", () => {
  assertEquals(sanitizeAlias("a_b-c9"), "a_b-c9");
});

Deno.test("sanitizeAlias rejects a dot (path traversal guard)", () => {
  assertThrows(() => sanitizeAlias("a.b"));
});

Deno.test("assertNumericId trims and rejects non-digits", () => {
  assertEquals(assertNumericId(" 845266 "), "845266");
  assertThrows(() => assertNumericId("845266/"));
});

Deno.test("sanitizeLang lowercases and rejects separators", () => {
  assertEquals(sanitizeLang("EN"), "en");
  assertThrows(() => sanitizeLang("en-US"));
});

Deno.test("decodeEntities handles hex, decimal, named, and unknown", () => {
  assertEquals(decodeEntities("&#x41;&#66;&amp;&AMP;&bogus;"), "AB&&&bogus;");
});

Deno.test("stripHtml collapses whitespace and tolerates null", () => {
  assertEquals(stripHtml("<b> a </b>\n\n b "), "a b");
  assertEquals(stripHtml(null as unknown as string), "");
});

Deno.test("htmlToText collapses runs of blank lines to one", () => {
  assertEquals(htmlToText("<p>a</p><p></p><p></p><p>b</p>"), "a\n\nb");
});

Deno.test("htmlToText turns br into a newline and li into a bullet", () => {
  assertEquals(htmlToText("x<br>y<ul><li>z</li></ul>"), "x\ny\n• z");
});

Deno.test("articleUrl strips one trailing slash on the base", () => {
  assertEquals(articleUrl("1", "https://h/", "ru"), "https://h/ru/articles/1/");
});

Deno.test("normalizePagesCount floors, defaults and clamps", () => {
  assertEquals(normalizePagesCount(3.9), 3);
  assertEquals(normalizePagesCount(undefined), 1);
  assertEquals(normalizePagesCount(0), 1);
  assertEquals(normalizePagesCount(-4), 1);
  assertEquals(normalizePagesCount(MAX_PAGES + 1), MAX_PAGES);
});

Deno.test("parseSummary drops empty tags and hubs", () => {
  const s = parseSummary(
    {
      id: "1",
      tags: [{ titleHtml: "" }, { titleHtml: "x" }],
      hubs: [{}, { alias: "h" }],
    },
    "https://h",
    "ru",
  );
  assertEquals(s.tags, ["x"]);
  assertEquals(s.hubs, ["h"]);
});

Deno.test("parseSummary falls back to the caller lang when ref has none", () => {
  assertEquals(
    parseSummary({ id: "1" }, "https://h", "en").url,
    "https://h/en/articles/1/",
  );
});

Deno.test("parseSummary null author and timePublished stay null", () => {
  const s = parseSummary({ id: "1" }, "https://h", "ru");
  assertEquals(s.author, null);
  assertEquals(s.timePublished, null);
});

Deno.test("default base URL is habr.com when baseUrl unset", async () => {
  const { ctx } = makeCtx({});
  await withFetch(() => json({ id: "1" }), async (calls) => {
    await model.methods["get-article"].execute({ id: "1" }, ctx);
    assertEquals(calls[0].url.origin, "https://habr.com");
  });
});

Deno.test("userAgent global argument overrides the default UA", async () => {
  const { ctx } = makeCtx({
    baseUrl: "https://habr.com",
    userAgent: "probe/1",
  });
  await withFetch(() => json({ id: "1" }), async (calls) => {
    await model.methods["get-article"].execute({ id: "1" }, ctx);
    assertEquals(calls[0].headers["user-agent"], "probe/1");
  });
});

Deno.test("fractional maxPages is floored", async () => {
  const { ctx, written } = makeCtx();
  const page = (n: string) => ({
    pagesCount: 5,
    publicationIds: [n],
    publicationRefs: { [n]: { id: n } },
  });
  await withFetch(
    habrRoute({ pages: { "1": page("1"), "2": page("2"), "3": page("3") } }),
    async (calls) => {
      await model.methods["list-articles"].execute(
        { user: "u", maxPages: 2.7 },
        ctx,
      );
      assertEquals(calls.length, 2);
    },
  );
  assertEquals(written[0].payload.pagesFetched, 2);
});

Deno.test("dangling publicationIds without a ref are skipped", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    () =>
      json({
        pagesCount: 1,
        publicationIds: ["1", "2"],
        publicationRefs: { "1": { id: "1" } },
      }),
    () => model.methods["list-articles"].execute({ user: "u" }, ctx),
  );
  assertEquals(written[0].payload.total, 1);
});

Deno.test("model upgrades chain ends at the model version", () => {
  assertEquals(
    model.upgrades[model.upgrades.length - 1].toVersion,
    model.version,
  );
});

Deno.test("htmlToText does not treat <link> as a list item", () => {
  assertEquals(htmlToText('<link rel="x">a<li class="c">b'), "a\n• b");
});
