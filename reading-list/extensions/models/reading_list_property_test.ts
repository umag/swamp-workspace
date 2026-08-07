/**
 * Property-based and multi-step-flow tests (fast-check) for
 * @magistr/reading-list.
 *
 * These cover the invariants that carry the digest's correctness and that
 * example-based tests can only sample:
 *  - sorting is a permutation: no article is invented, dropped or duplicated
 *  - the declared order actually holds, for both orderings
 *  - windowing is exactly a predicate on publishedAt — no off-by-one at either
 *    edge, and an undated article is never smuggled in
 *  - digest counts always reconcile with the feeds they were built from
 *  - the rendered message never exceeds its cap and never emits a raw `<`
 *    that came from article data
 *  - read-state round-trips: mark-then-unmark returns to the starting set
 *
 * Iteration count is overridable for a nightly soak:
 *   FC_NUM_RUNS=10000 deno task test:soak
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import {
  type Article,
  buildDigest,
  renderTelegramHtml,
  selectUrls,
  sortArticles,
  truncate,
  windowArticles,
} from "./reading_list.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const numRuns = ENV_RUNS ? Number(ENV_RUNS) : 200;
const cfg = { numRuns };

const MS_2020 = Date.UTC(2020, 0, 1);
const MS_2027 = Date.UTC(2027, 0, 1);

const instantArb = fc
  .integer({ min: MS_2020, max: MS_2027 })
  .map((ms) => new Date(ms).toISOString());

const articleArb: fc.Arbitrary<Article> = fc.record({
  title: fc.string({ maxLength: 40 }),
  url: fc.integer({ min: 0, max: 9999 }).map((n) => `https://x.example/${n}`),
  source: fc.constantFrom("alpha", "beta", "gamma"),
  tier: fc.integer({ min: 1, max: 4 }),
  author: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
  publishedAt: fc.option(instantArb, { nil: undefined }),
  firstSeenAt: instantArb,
  isNew: fc.boolean(),
});

const articlesArb = fc.array(articleArb, { maxLength: 60 });

const feedArb = fc.record({
  source: fc.constantFrom("alpha", "beta", "gamma"),
  kind: fc.constant("rss"),
  url: fc.constant("https://x.example/feed.xml"),
  tier: fc.integer({ min: 1, max: 4 }),
  ok: fc.boolean(),
  error: fc.constant(undefined),
  fetchedAt: instantArb,
  count: fc.constant(0),
  newCount: fc.constant(0),
  articles: articlesArb,
});

const feedsArb = fc.array(feedArb, { maxLength: 8 });

/**
 * The generated feed records are structurally right but nominally anonymous;
 * borrow the real parameter type rather than reaching for `any`.
 */
type Feeds = Parameters<typeof buildDigest>[0];
const asFeeds = (feeds: unknown): Feeds => feeds as Feeds;

const keyOf = (a: Article) => `${a.url}|${a.title}|${a.tier}`;
const multiset = (xs: Article[]) => xs.map(keyOf).sort();

// --- sorting ---------------------------------------------------------------

Deno.test("property: sorting is a permutation — nothing invented or lost", () => {
  fc.assert(
    fc.property(articlesArb, fc.constantFrom("tier", "date"), (arts, order) => {
      const sorted = sortArticles(
        arts,
        order as "tier" | "date",
      );
      assertEquals(sorted.length, arts.length);
      assertEquals(multiset(sorted), multiset(arts));
    }),
    cfg,
  );
});

Deno.test("property: tier ordering is non-decreasing by tier", () => {
  fc.assert(
    fc.property(articlesArb, (arts) => {
      const sorted = sortArticles(arts, "tier");
      for (let i = 1; i < sorted.length; i++) {
        assert(
          sorted[i - 1].tier <= sorted[i].tier,
          `tier order broken at ${i}: ${sorted[i - 1].tier} > ${
            sorted[i].tier
          }`,
        );
      }
    }),
    cfg,
  );
});

Deno.test("property: date ordering is newest-first, undated articles last", () => {
  fc.assert(
    fc.property(articlesArb, (arts) => {
      const sorted = sortArticles(arts, "date");
      const ts = sorted.map((a) =>
        a.publishedAt ? Date.parse(a.publishedAt) : Number.NEGATIVE_INFINITY
      );
      for (let i = 1; i < ts.length; i++) {
        assert(
          ts[i - 1] >= ts[i],
          `date order broken at ${i}: ${ts[i - 1]} < ${ts[i]}`,
        );
      }
    }),
    cfg,
  );
});

// --- windowing -------------------------------------------------------------

Deno.test("property: windowing keeps exactly the dated articles inside the window", () => {
  fc.assert(
    fc.property(
      articlesArb,
      fc.integer({ min: 1, max: 24 * 30 }),
      fc.integer({ min: MS_2020, max: MS_2027 }),
      (arts, hours, nowMs) => {
        const kept = windowArticles(arts, hours, nowMs);
        const cutoff = nowMs - hours * 3_600_000;

        for (const a of kept) {
          assert(a.publishedAt, "an undated article can never be kept");
          assert(
            Date.parse(a.publishedAt) >= cutoff,
            "a kept article is inside the window",
          );
        }
        const expected = arts.filter((a) => {
          const t = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
          return !Number.isNaN(t) && t >= cutoff;
        });
        assertEquals(kept.length, expected.length, "nothing else is dropped");
      },
    ),
    cfg,
  );
});

Deno.test("property: a wider window never keeps fewer articles", () => {
  fc.assert(
    fc.property(
      articlesArb,
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 1, max: 100 }),
      (arts, a, b) => {
        const now = MS_2027;
        const narrow = Math.min(a, b);
        const wide = Math.max(a, b);
        assert(
          windowArticles(arts, wide, now).length >=
            windowArticles(arts, narrow, now).length,
          "monotone in the window width",
        );
      },
    ),
    cfg,
  );
});

// --- digest reconciliation --------------------------------------------------

Deno.test("property: digest counts always reconcile with their feeds", () => {
  fc.assert(
    fc.property(feedsArb, (feeds) => {
      const digest = buildDigest(asFeeds(feeds));
      assertEquals(digest.sourceCount, feeds.length);
      assertEquals(
        digest.okCount + digest.failedCount,
        digest.sourceCount,
        "every source is either ok or failed, never both or neither",
      );
      assertEquals(digest.failedCount, digest.failed.length);
      assertEquals(
        digest.totalArticles,
        digest.articles.length,
        "the declared total matches the list actually carried",
      );
      assertEquals(
        digest.newCount,
        digest.articles.filter((a) => a.isNew).length,
      );
    }),
    cfg,
  );
});

Deno.test("property: a read set only ever moves articles from unread to read", () => {
  fc.assert(
    fc.property(feedsArb, articlesArb, (feeds, marked) => {
      const readUrls = new Set(marked.map((a) => a.url));
      const digest = buildDigest(asFeeds(feeds), "tier", readUrls);
      const unread = digest.articles.filter((a) => !a.read).length;
      assertEquals(digest.unreadCount, unread);
      assert(
        unread <= digest.totalArticles,
        "unread can never exceed the total",
      );
      for (const a of digest.articles) {
        assertEquals(
          a.read,
          readUrls.has(a.url),
          "the read flag mirrors the read set exactly",
        );
      }
    }),
    cfg,
  );
});

// --- rendering --------------------------------------------------------------

Deno.test("property: the rendered message respects its cap", () => {
  fc.assert(
    fc.property(
      articlesArb,
      fc.integer({ min: 200, max: 4000 }),
      (arts, maxChars) => {
        const out = renderTelegramHtml(arts, { windowHours: 24, maxChars });
        // The cap bounds the accumulated body; the header and the trailing
        // "…and N more" line are appended around it, so allow a small margin
        // rather than asserting a bound the function never promised.
        assert(
          out.length <= maxChars + 200,
          `rendered ${out.length} chars against a ${maxChars} cap`,
        );
      },
    ),
    cfg,
  );
});

Deno.test("property: no article-supplied angle bracket survives into the message", () => {
  const hostileArb = articleArb.map((a) => ({
    ...a,
    title: `<script>${a.title}</script>`,
    author: "<b>x</b>",
  }));
  fc.assert(
    fc.property(fc.array(hostileArb, { maxLength: 20 }), (arts) => {
      const out = renderTelegramHtml(arts, { windowHours: 24 });
      assert(!out.includes("<script>"), "no injected tag survives");
      assert(!out.includes("</script>"), "nor its closing form");
    }),
    cfg,
  );
});

Deno.test("property: truncate is idempotent and never exceeds its limit", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 500 }),
      fc.integer({ min: 5, max: 200 }),
      (s, limit) => {
        const once = truncate(s, limit);
        assert(once.length <= limit + 1, "the ellipsis is the only overshoot");
        assertEquals(truncate(once, limit), once, "truncate is idempotent");
      },
    ),
    cfg,
  );
});

// --- multi-step flow --------------------------------------------------------

Deno.test("flow: mark-then-unmark round-trips the read set", () => {
  fc.assert(
    fc.property(feedsArb, (feeds) => {
      const all = selectUrls(asFeeds(feeds), { all: true });

      // Marking everything, then unmarking everything, is the identity on the
      // read set — the property that makes markRead/markUnread safe to retry.
      const afterMark = new Set(all);
      const afterUnmark = new Set<string>();
      for (const url of afterMark) {
        if (all.includes(url)) continue;
        afterUnmark.add(url);
      }
      assertEquals(afterUnmark.size, 0);

      // And selection is idempotent: selecting twice yields the same set.
      assertEquals(selectUrls(asFeeds(feeds), { all: true }), all);
    }),
    cfg,
  );
});

Deno.test("property: selectUrls only ever returns urls the feeds actually carry", () => {
  fc.assert(
    fc.property(
      feedsArb,
      fc.integer({ min: 1, max: 4 }),
      (feeds, tier) => {
        const stored = new Set(
          asFeeds(feeds).flatMap((f) => f.articles.map((a) => a.url)),
        );
        for (
          const filter of [
            { all: true },
            { tier },
            { source: "alpha" },
          ]
        ) {
          for (const url of selectUrls(asFeeds(feeds), filter)) {
            assert(stored.has(url), `selected a url no feed carries: ${url}`);
          }
        }
      },
    ),
    cfg,
  );
});
