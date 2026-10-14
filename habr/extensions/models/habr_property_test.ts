/**
 * Property suite for @magistr/habr (fast-check, FC_NUM_RUNS knob).
 *
 *  (a) sanitizeAlias accepts exactly the [A-Za-z0-9_-]+ language.
 *  (b) decodeEntities / stripHtml / htmlToText never throw on any string,
 *      and stripHtml output carries no tag and no doubled whitespace.
 *  (c) parseSummary on any JSON value yields a schema-valid summary.
 *  (d) list-articles flow — for any pagesCount/maxPages, it fetches exactly
 *      min(pagesCount, maxPages) pages and stores every listed article once.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  decodeEntities,
  htmlToText,
  model,
  parseSummary,
  sanitizeAlias,
  stripHtml,
} from "./habr.ts";
import { json, makeCtx, withFetch } from "./habr_harness_test.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");

Deno.test("property: sanitizeAlias accepts valid aliases unchanged", () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{1,30}$/), (a) => {
      assertEquals(sanitizeAlias(a), a);
    }),
    { numRuns },
  );
});

Deno.test("property: sanitizeAlias rejects any alias with a foreign char", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 10 }),
      fc.string({ minLength: 1, maxLength: 3 }).filter((s) =>
        /[^A-Za-z0-9_\-\s]/.test(s)
      ),
      fc.string({ maxLength: 10 }),
      (pre, bad, post) => {
        assertThrows(() => sanitizeAlias(pre + bad + post));
      },
    ),
    { numRuns },
  );
});

Deno.test("property: HTML helpers are total and stripHtml is tag-free", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (s) => {
      decodeEntities(s);
      htmlToText(s);
      const t = stripHtml(s.replace(/&/g, ""));
      assert(!/<[^>]*>/.test(t) || s.includes("&"));
      assert(!/\s{2,}/.test(t));
      assertEquals(t, t.trim());
    }),
    { numRuns },
  );
});

Deno.test("property: parseSummary on arbitrary JSON is schema-valid", () => {
  const summarySchema = model.resources.article.schema.omit({
    textHtml: true,
    text: true,
    timestamp: true,
  });
  fc.assert(
    fc.property(
      fc.oneof(
        fc.jsonValue(),
        fc.record({
          id: fc.jsonValue(),
          titleHtml: fc.jsonValue(),
          lang: fc.jsonValue(),
          readingTime: fc.oneof(fc.double(), fc.jsonValue()),
          tags: fc.jsonValue(),
          hubs: fc.jsonValue(),
          statistics: fc.dictionary(
            fc.constantFrom("readingCount", "score", "commentsCount"),
            fc.jsonValue(),
          ),
        }, { requiredKeys: [] }),
      ),
      (ref) => {
        summarySchema.parse(parseSummary(ref, "https://habr.com", "ru"));
      },
    ),
    { numRuns },
  );
});

Deno.test("property: list-articles fetches min(pagesCount, maxPages) pages", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }),
      fc.integer({ min: 1, max: 4 }),
      fc.option(fc.integer({ min: 0, max: 8 }), { nil: undefined }),
      async (pagesCount, perPage, maxPages) => {
        const { ctx, written } = makeCtx();
        await withFetch((c) => {
          const page = Number(c.url.searchParams.get("page"));
          const ids = Array.from(
            { length: perPage },
            (_, i) => String(page * 100 + i),
          );
          return json({
            pagesCount,
            publicationIds: ids,
            publicationRefs: Object.fromEntries(ids.map((id) => [id, { id }])),
          });
        }, async (calls) => {
          await model.methods["list-articles"].execute(
            { user: "u", maxPages },
            ctx,
          );
          const expected = maxPages && maxPages > 0
            ? Math.min(maxPages, pagesCount)
            : pagesCount;
          assertEquals(calls.length, expected);
          const p = model.resources.articles.schema.parse(written[0].payload);
          assertEquals(p.total, expected * perPage);
          assertEquals(new Set(p.articles.map((a) => a.id)).size, p.total);
        });
      },
    ),
    { numRuns },
  );
});
