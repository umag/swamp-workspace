import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildDigest,
  DEFAULT_SOURCES,
  extractUrls,
  hostOf,
  model,
  parseFeedXml,
  parseLinkedInProfile,
  rankHosts,
  readUrlSet,
  renderTelegramHtml,
  resolveSources,
  selectUrls,
  sortArticles,
  type Source,
  stripHtml,
  suggestName,
  toIso,
  truncate,
  unwrapCdata,
  windowArticles,
} from "./reading_list.ts";

const src = (over: Partial<Source> = {}): Source => ({
  name: "test",
  kind: "rss",
  url: "https://example.com/feed",
  author: "Fallback Author",
  tier: 2,
  enabled: true,
  ...over,
});

// --- unwrapCdata -----------------------------------------------------------

Deno.test("unwrapCdata replaces CDATA with escaped character data", () => {
  const out = unwrapCdata("<title><![CDATA[Tom & Jerry <b>hi</b>]]></title>");
  assertEquals(out, "<title>Tom &amp; Jerry &lt;b&gt;hi&lt;/b&gt;</title>");
});

Deno.test("unwrapCdata leaves plain XML untouched", () => {
  const xml = "<title>plain</title>";
  assertEquals(unwrapCdata(xml), xml);
});

// --- stripHtml / truncate / toIso ------------------------------------------

Deno.test("stripHtml removes tags and decodes entities", () => {
  assertEquals(
    stripHtml("<p>Tom &amp; Jerry &rarr; <b>go</b></p>"),
    "Tom & Jerry → go",
  );
});

Deno.test("stripHtml drops script and style bodies", () => {
  assertEquals(
    stripHtml("<style>a{}</style><p>keep</p><script>x()</script>"),
    "keep",
  );
});

Deno.test("truncate breaks on a word boundary and adds an ellipsis", () => {
  const out = truncate("alpha beta gamma delta", 12);
  assert(out.endsWith("…"), `expected ellipsis, got ${out}`);
  assert(!out.includes("gamma"), `cut too late: ${out}`);
});

Deno.test("truncate leaves short text alone", () => {
  assertEquals(truncate("short", 20), "short");
});

Deno.test("toIso normalises RFC-822 and ISO, rejects junk", () => {
  assertEquals(
    toIso("Thu, 23 Jul 2026 22:24:27 GMT"),
    "2026-07-23T22:24:27.000Z",
  );
  assertEquals(
    toIso("2026-02-19T18:26:59.000+00:00"),
    "2026-02-19T18:26:59.000Z",
  );
  assertEquals(toIso("not a date"), undefined);
  assertEquals(toIso(undefined), undefined);
});

// --- parseFeedXml ----------------------------------------------------------

const RSS_WITH_CDATA = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>A blog</title>
    <item>
      <title><![CDATA[First post]]></title>
      <link>https://example.com/first</link>
      <dc:creator><![CDATA[Jon Ayre]]></dc:creator>
      <pubDate>Sat, 04 Jul 2026 08:01:48 +0000</pubDate>
      <description><![CDATA[<p>Body &amp; more</p>]]></description>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/second</link>
      <pubDate>Wed, 01 Jul 2026 10:00:00 +0000</pubDate>
      <content:encoded><![CDATA[<p>Richer body</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

Deno.test("parseFeedXml reads CDATA titles, authors and bodies", () => {
  const [first, second] = parseFeedXml(RSS_WITH_CDATA, src());
  assertEquals(first.title, "First post");
  assertEquals(first.url, "https://example.com/first");
  assertEquals(first.author, "Jon Ayre");
  assertEquals(first.publishedAt, "2026-07-04T08:01:48.000Z");
  assertEquals(first.summary, "Body & more");
  // content:encoded is preferred, and the source author fills the gap.
  assertEquals(second.summary, "Richer body");
  assertEquals(second.author, "Fallback Author");
});

Deno.test("parseFeedXml carries source name and tier onto every article", () => {
  const articles = parseFeedXml(
    RSS_WITH_CDATA,
    src({ name: "joapen", tier: 1 }),
  );
  assert(articles.length > 0);
  for (const a of articles) {
    assertEquals(a.source, "joapen");
    assertEquals(a.tier, 1);
  }
});

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" href="https://example.com/atom-1"/>
    <published>2026-05-01T12:00:00Z</published>
    <summary>Atom summary</summary>
  </entry>
</feed>`;

Deno.test("parseFeedXml reads Atom link href when element text is empty", () => {
  const [entry] = parseFeedXml(ATOM, src());
  assertEquals(entry.url, "https://example.com/atom-1");
  assertEquals(entry.title, "Atom entry");
  assertEquals(entry.publishedAt, "2026-05-01T12:00:00.000Z");
});

Deno.test("parseFeedXml skips items with no resolvable link", () => {
  const xml =
    `<rss><channel><item><title>No link</title></item></channel></rss>`;
  assertEquals(parseFeedXml(xml, src()).length, 0);
});

Deno.test("parseFeedXml returns empty for a feed with no items", () => {
  assertEquals(parseFeedXml("<rss><channel/></rss>", src()).length, 0);
});

// --- parseLinkedInProfile --------------------------------------------------

const LINKEDIN = `<html><head>
<script type="application/ld+json">
{"@graph":[
 {"@type":"Article","headline":"A good enough map",
  "url":"https://www.linkedin.com/pulse/good-enough-map-simon-wardley-kivee",
  "datePublished":"2024-02-02T15:02:34.000+00:00",
  "author":{"@type":"Person","name":"Simon Wardley"}},
 {"@type":"DiscussionForumPosting",
  "url":"https://www.linkedin.com/posts/simonwardley_activity-7485987181283487746-iHS1",
  "datePublished":"2026-07-23T09:20:26.915Z",
  "text":"The architectural question of our age is how much you value a human in the loop.",
  "author":{"@type":"Person","name":"Simon Wardley"}},
 {"@type":"Person","name":"Simon Wardley"}
]}
</script></head><body></body></html>`;

Deno.test("parseLinkedInProfile reads Articles and posts, skips other nodes", () => {
  const out = parseLinkedInProfile(LINKEDIN, src({ name: "wardley" }));
  assertEquals(out.length, 2);

  const article = out.find((a) => a.url.includes("/pulse/"))!;
  assertEquals(article.title, "A good enough map");
  assertEquals(article.author, "Simon Wardley");
  assertEquals(article.publishedAt, "2024-02-02T15:02:34.000Z");

  // A short post has no headline, so the title is derived from its text.
  const post = out.find((a) => a.url.includes("/posts/"))!;
  assert(post.title.startsWith("The architectural question"), post.title);
  assertEquals(post.source, "wardley");
});

Deno.test("parseLinkedInProfile deduplicates repeated urls", () => {
  const dup = LINKEDIN.replace(
    '{"@type":"Person","name":"Simon Wardley"}',
    `{"@type":"Article","headline":"A good enough map",
      "url":"https://www.linkedin.com/pulse/good-enough-map-simon-wardley-kivee",
      "datePublished":"2024-02-02T15:02:34.000+00:00"}`,
  );
  assertEquals(parseLinkedInProfile(dup, src()).length, 2);
});

Deno.test("parseLinkedInProfile returns empty on gated or changed markup", () => {
  assertEquals(
    parseLinkedInProfile("<html><body>login</body></html>", src()).length,
    0,
  );
  assertEquals(
    parseLinkedInProfile(
      '<script type="application/ld+json">{bad</script>',
      src(),
    ).length,
    0,
  );
});

// --- ordering --------------------------------------------------------------

Deno.test("sortArticles puts lower tiers first, then newest", () => {
  const a = (over: Record<string, unknown>) =>
    ({
      title: "t",
      url: "u",
      source: "s",
      tier: 2,
      firstSeenAt: "",
      isNew: true,
      ...over,
    }) as Parameters<typeof sortArticles>[0][number];

  const sorted = sortArticles([
    a({ url: "old-t2", tier: 2, publishedAt: "2026-01-01T00:00:00Z" }),
    a({ url: "new-t2", tier: 2, publishedAt: "2026-07-01T00:00:00Z" }),
    a({ url: "old-t1", tier: 1, publishedAt: "2020-01-01T00:00:00Z" }),
  ]);

  // Tier 1 leads even though it is the oldest item in the set.
  assertEquals(sorted.map((x) => x.url), ["old-t1", "new-t2", "old-t2"]);
});

Deno.test("sortArticles orderBy=date ignores tier and sorts purely by recency", () => {
  const a = (over: Record<string, unknown>) =>
    ({
      title: "t",
      url: "u",
      source: "s",
      tier: 2,
      firstSeenAt: "",
      isNew: true,
      ...over,
    }) as Parameters<typeof sortArticles>[0][number];

  const sorted = sortArticles([
    a({ url: "old-t1", tier: 1, publishedAt: "2020-01-01T00:00:00Z" }),
    a({ url: "new-t3", tier: 3, publishedAt: "2026-07-25T00:00:00Z" }),
    a({ url: "mid-t2", tier: 2, publishedAt: "2026-01-01T00:00:00Z" }),
  ], "date");

  // A tier-3 item leads because it is the newest, tier notwithstanding.
  assertEquals(sorted.map((x) => x.url), ["new-t3", "mid-t2", "old-t1"]);
});

Deno.test("sortArticles treats a missing date as oldest", () => {
  const base = {
    title: "t",
    source: "s",
    tier: 1,
    firstSeenAt: "",
    isNew: true,
  };
  const sorted = sortArticles([
    { ...base, url: "undated" },
    { ...base, url: "dated", publishedAt: "2026-01-01T00:00:00Z" },
  ]);
  assertEquals(sorted[0].url, "dated");
});

// --- buildDigest -----------------------------------------------------------

const feed = (over: Record<string, unknown> = {}) =>
  ({
    source: "s",
    kind: "rss",
    url: "u",
    tier: 2,
    ok: true,
    fetchedAt: "2026-07-24T00:00:00Z",
    count: 0,
    newCount: 0,
    articles: [],
    ...over,
  }) as Parameters<typeof buildDigest>[0][number];

Deno.test("buildDigest counts failures and reports them with reasons", () => {
  const digest = buildDigest([
    feed({ source: "ok-one" }),
    feed({
      source: "broken",
      ok: false,
      error: "HTTP 503 Service Unavailable",
    }),
  ]);
  assertEquals(digest.sourceCount, 2);
  assertEquals(digest.okCount, 1);
  assertEquals(digest.failedCount, 1);
  assertEquals(digest.failed, ["broken: HTTP 503 Service Unavailable"]);
});

Deno.test("buildDigest merges and counts new articles", () => {
  const mk = (url: string, isNew: boolean, tier: number) => ({
    title: url,
    url,
    source: "s",
    tier,
    firstSeenAt: "2026-07-24T00:00:00Z",
    isNew,
    publishedAt: "2026-07-01T00:00:00Z",
  });
  const digest = buildDigest([
    feed({ tier: 2, articles: [mk("b", false, 2)] }),
    feed({ tier: 1, articles: [mk("a", true, 1)] }),
  ]);
  assertEquals(digest.totalArticles, 2);
  assertEquals(digest.newCount, 1);
  assertEquals(digest.articles[0].url, "a", "tier 1 must lead the digest");
});

// --- read state ------------------------------------------------------------

const readArticle = (url: string, over: Record<string, unknown> = {}) => ({
  title: url,
  url,
  source: "s",
  tier: 2,
  firstSeenAt: "2026-07-24T00:00:00Z",
  isNew: false,
  publishedAt: "2026-07-20T00:00:00Z",
  ...over,
});

Deno.test("readUrlSet builds a set from stored read state, tolerating null", () => {
  assertEquals([...readUrlSet(null)], []);
  const set = readUrlSet({
    urls: { "https://a/1": "2026-07-26T00:00:00Z", "https://a/2": "x" },
    count: 2,
    updatedAt: "x",
  });
  assertEquals(set.has("https://a/1"), true);
  assertEquals(set.size, 2);
});

Deno.test("selectUrls includes explicit urls even when not in feeds", () => {
  const feeds = [feed({ articles: [readArticle("https://a/1")] })];
  const got = selectUrls(feeds, { urls: ["https://gone/x"] });
  assertEquals(got, ["https://gone/x"]);
});

Deno.test("selectUrls with no selector matches nothing from feeds", () => {
  const feeds = [feed({ articles: [readArticle("https://a/1")] })];
  assertEquals(selectUrls(feeds, {}), []);
});

Deno.test("selectUrls resolves source and tier against stored feeds", () => {
  const feeds = [
    feed({
      articles: [
        readArticle("https://sc/1", { source: "swamp-club", tier: 1 }),
        readArticle("https://ad/1", { source: "adrianco", tier: 2 }),
      ],
    }),
  ];
  assertEquals(selectUrls(feeds, { source: "swamp-club" }), ["https://sc/1"]);
  assertEquals(selectUrls(feeds, { tier: 2 }), ["https://ad/1"]);
});

Deno.test("selectUrls before is an exclusive publish cutoff", () => {
  const feeds = [
    feed({
      articles: [
        readArticle("https://old", { publishedAt: "2026-07-25T12:00:00Z" }),
        readArticle("https://cutoff", { publishedAt: "2026-07-26T00:00:00Z" }),
        readArticle("https://new", { publishedAt: "2026-07-26T09:00:00Z" }),
      ],
    }),
  ];
  // before=2026-07-26 (midnight) keeps only what published strictly earlier.
  assertEquals(selectUrls(feeds, { before: "2026-07-26" }), ["https://old"]);
});

Deno.test("selectUrls combines source and before (the 'read swamp-club as of yesterday' case)", () => {
  const feeds = [
    feed({
      articles: [
        readArticle("https://sc/old", {
          source: "swamp-club",
          publishedAt: "2026-07-25T00:00:00Z",
        }),
        readArticle("https://sc/today", {
          source: "swamp-club",
          publishedAt: "2026-07-27T08:00:00Z",
        }),
        readArticle("https://ad/old", {
          source: "adrianco",
          publishedAt: "2026-07-25T00:00:00Z",
        }),
      ],
    }),
  ];
  assertEquals(
    selectUrls(feeds, { source: "swamp-club", before: "2026-07-27" }),
    ["https://sc/old"],
  );
});

Deno.test("selectUrls all matches every stored article", () => {
  const feeds = [
    feed({
      articles: [readArticle("https://a/1"), readArticle("https://a/2")],
    }),
  ];
  assertEquals(selectUrls(feeds, { all: true }).sort(), [
    "https://a/1",
    "https://a/2",
  ]);
});

Deno.test("buildDigest annotates read flags and counts unread when given a read set", () => {
  const feeds = [
    feed({
      tier: 1,
      articles: [
        readArticle("https://a/1", { tier: 1 }),
        readArticle("https://a/2", { tier: 1 }),
      ],
    }),
  ];
  const digest = buildDigest(feeds, "tier", new Set(["https://a/1"]));
  assertEquals(digest.unreadCount, 1);
  const a1 = digest.articles.find((a) => a.url === "https://a/1")!;
  const a2 = digest.articles.find((a) => a.url === "https://a/2")!;
  assertEquals(a1.read, true);
  assertEquals(a2.read, false);
});

Deno.test("buildDigest leaves read undefined when no read set is given", () => {
  const digest = buildDigest([
    feed({ articles: [readArticle("https://a/1")] }),
  ]);
  assertEquals(digest.unreadCount, undefined);
  assertEquals(digest.articles[0].read, undefined);
});

// --- digest message (Telegram) ---------------------------------------------

const msgArticle = (over: Record<string, unknown> = {}) =>
  ({
    title: "A title",
    url: "https://example.com/post",
    source: "swamp-club",
    tier: 1,
    author: "someone",
    firstSeenAt: "2026-08-03T00:00:00Z",
    isNew: true,
    publishedAt: "2026-08-03T09:00:00Z",
    ...over,
  }) as Parameters<typeof renderTelegramHtml>[0][number];

Deno.test("windowArticles keeps only items within the look-back window", () => {
  const now = Date.parse("2026-08-03T10:00:00Z");
  const arts = [
    msgArticle({ url: "in", publishedAt: "2026-08-02T12:00:00Z" }), // 22h ago
    msgArticle({ url: "edge", publishedAt: "2026-08-02T08:00:00Z" }), // 26h ago
    msgArticle({ url: "out", publishedAt: "2026-08-01T09:00:00Z" }), // 49h ago
    msgArticle({ url: "undated", publishedAt: undefined }),
  ];
  const kept = windowArticles(arts, 26, now).map((a) => a.url);
  assertEquals(kept.sort(), ["edge", "in"]);
});

Deno.test("renderTelegramHtml escapes titles and builds one link per item", () => {
  const html = renderTelegramHtml([
    msgArticle({
      title: "Tom & Jerry <b>",
      url: "https://x/y?a=1&b=2",
      author: "A",
      source: "s",
      publishedAt: "2026-08-03T09:00:00Z",
    }),
  ], { windowHours: 26 });
  assert(html.includes("📚 <b>1 new post</b> · last 26h"), html);
  assert(
    html.includes(
      '<a href="https://x/y?a=1&amp;b=2">Tom &amp; Jerry &lt;b&gt;</a>',
    ),
    html,
  );
  assert(html.includes("A · s · 2026-08-03"), html);
});

Deno.test("renderTelegramHtml pluralizes and truncates to maxChars", () => {
  const many = Array.from(
    { length: 50 },
    (_, i) =>
      msgArticle({
        url: `https://example.com/${i}`,
        title: `Post number ${i}`,
      }),
  );
  const html = renderTelegramHtml(many, { windowHours: 26, maxChars: 400 });
  assert(html.includes("50 new posts"), "should pluralize");
  assert(/…and \d+ more/.test(html), "should note the overflow");
  assert(html.length <= 460, `stayed near the cap: ${html.length}`);
});

// --- source resolution -----------------------------------------------------

Deno.test("resolveSources defaults to the curated set with Swamp Club at tier 1", () => {
  const resolved = resolveSources({});
  assertEquals(resolved.length, DEFAULT_SOURCES.length);
  const club = resolved.find((s) => s.name === "swamp-club")!;
  assertEquals(club.tier, 1);
  assert(
    resolved.filter((s) => s.name !== "swamp-club").every((s) => s.tier === 2),
    "every non-club default should sit at tier 2",
  );
});

Deno.test("resolveSources honours overrides and drops disabled sources", () => {
  const resolved = resolveSources({
    sources: [
      {
        name: "keep",
        kind: "rss",
        url: "https://a/feed",
        tier: 1,
        enabled: true,
      },
      {
        name: "drop",
        kind: "rss",
        url: "https://b/feed",
        tier: 1,
        enabled: false,
      },
    ],
  });
  assertEquals(resolved.map((s) => s.name), ["keep"]);
});

Deno.test("resolveSources applies schema defaults for omitted fields", () => {
  const [only] = resolveSources({
    // deno-lint-ignore no-explicit-any
    sources: [{ name: "minimal", url: "https://c/feed" } as any],
  });
  assertEquals(only.kind, "rss");
  assertEquals(only.tier, 2);
  assertEquals(only.enabled, true);
});

// --- model shape -----------------------------------------------------------

// --- discovery -------------------------------------------------------------

Deno.test("extractUrls pulls links out of free text and trims punctuation", () => {
  const urls = extractUrls(
    'see https://a.example/post/1, and <https://b.example/x> plus "https://c.example/y".',
  );
  assertEquals(urls, [
    "https://a.example/post/1",
    "https://b.example/x",
    "https://c.example/y",
  ]);
});

Deno.test("extractUrls returns empty when there are no links", () => {
  assertEquals(extractUrls("no links at all"), []);
});

Deno.test("hostOf strips www and rejects junk", () => {
  assertEquals(hostOf("https://www.redmonk.com/sogrady/x/"), "redmonk.com");
  assertEquals(hostOf("https://sunshowers.io/posts/y/"), "sunshowers.io");
  assertEquals(hostOf("not a url"), undefined);
});

Deno.test("suggestName makes a stable kebab-case name from a host", () => {
  assertEquals(suggestName("redmonk.com"), "redmonk");
  assertEquals(
    suggestName("charitydotwtf.substack.com"),
    "charitydotwtf-substack",
  );
  assertEquals(suggestName("blog.sakugabooru.com"), "blog-sakugabooru");
});

Deno.test("rankHosts groups by host and ranks by mentions", () => {
  const ranked = rankHosts(
    [
      "https://sunshowers.io/posts/a/",
      "https://sunshowers.io/posts/b/",
      "https://erikbern.com/2021/x",
    ],
    new Set(),
    1,
  );
  assertEquals(ranked[0].host, "sunshowers.io");
  assertEquals(ranked[0].mentions, 2);
  assertEquals(ranked[1].host, "erikbern.com");
});

Deno.test("rankHosts drops aggregator hosts that are not authors", () => {
  const ranked = rankHosts(
    [
      "https://github.com/lexler/repo",
      "https://arxiv.org/abs/2604.10505",
      "https://www.amazon.com/dp/1942788150",
      "https://gwern.net/guardian-angel",
    ],
    new Set(),
    1,
  );
  assertEquals(ranked.map((h) => h.host), ["gwern.net"]);
});

Deno.test("rankHosts flags hosts already configured as sources", () => {
  const ranked = rankHosts(
    ["https://joapen.com/blog/2026/x", "https://erikbern.com/y"],
    new Set(["joapen.com"]),
    1,
  );
  assertEquals(
    ranked.find((h) => h.host === "joapen.com")?.alreadyConfigured,
    true,
  );
  assertEquals(
    ranked.find((h) => h.host === "erikbern.com")?.alreadyConfigured,
    false,
  );
});

Deno.test("rankHosts honours the minMentions floor", () => {
  const ranked = rankHosts(
    ["https://a.example/1", "https://a.example/2", "https://b.example/1"],
    new Set(),
    2,
  );
  assertEquals(ranked.map((h) => h.host), ["a.example"]);
});

// --- model shape -----------------------------------------------------------

Deno.test("model exposes its methods over declared specs", () => {
  assertEquals(model.type, "@magistr/reading-list");
  assertEquals(Object.keys(model.methods).sort(), [
    "digestMessage",
    "discover",
    "fetch",
    "latest",
    "markRead",
    "markUnread",
    "sources",
  ]);
  assertEquals(Object.keys(model.resources).sort(), [
    "candidate",
    "digest",
    "feed",
    "message",
    "read",
  ]);
  // Spec keys must not contain hyphens.
  for (const key of Object.keys(model.resources)) {
    assert(!key.includes("-"), `spec key ${key} must not contain a hyphen`);
  }
});

Deno.test("every default source has a unique name", () => {
  const names = DEFAULT_SOURCES.map((s) => s.name);
  assertEquals(names.length, new Set(names).size);
});
