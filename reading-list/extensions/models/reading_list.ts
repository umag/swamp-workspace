/**
 * Curated reading list — fetches new writing from a prioritised set of authors.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { DOMParser } from "npm:linkedom@0.16.11";

// ---------------------------------------------------------------------------
// @magistr/reading-list
//
// A tiered feed reader for a hand-picked set of writers. Tier 1 is read first
// (the Swamp Club feed), tier 2 is the Wardley-mapping crowd. One `fetch`
// method fans out over every source in a single execution and produces a
// merged, tier-ordered digest.
//
// Two source kinds:
//   - `rss`      — RSS 2.0 or Atom. Feeds are CDATA-unwrapped before parsing
//                  because Substack/Medium/WordPress wrap titles and
//                  descriptions in CDATA, which the XML parser reports as
//                  empty text content.
//   - `linkedin` — LinkedIn publishes no RSS. The public guest profile does
//                  embed a JSON-LD `@graph` containing `DiscussionForumPosting`
//                  (short posts) and `Article` (Pulse) nodes, which is what
//                  this reads. It is unauthenticated and therefore fragile:
//                  LinkedIn can change or gate that markup at any time. A
//                  failing source is recorded as `ok: false` and never aborts
//                  the run.
//
// Only metadata and a short plain-text excerpt are stored per article, not
// full article bodies.
// ---------------------------------------------------------------------------

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SUMMARY_LIMIT = 400;

const SourceSchema = z.object({
  name: z
    .string()
    .describe("Short stable identifier, used in the data artifact name."),
  kind: z
    .enum(["rss", "linkedin"])
    .default("rss")
    .describe("`rss` for RSS/Atom feeds, `linkedin` for a public profile URL."),
  url: z.string().describe("Feed URL, or LinkedIn public profile URL."),
  author: z
    .string()
    .optional()
    .describe("Display name, used when the feed omits a per-item author."),
  tier: z
    .number()
    .int()
    .default(2)
    .describe("Read priority. Lower sorts first; tier 1 leads the digest."),
  enabled: z.boolean().default(true).describe("Set false to skip the source."),
});

/** A configured source to read from. */
export type Source = z.infer<typeof SourceSchema>;

/** The sources used when the model definition does not specify its own. */
export const DEFAULT_SOURCES: Source[] = [
  {
    name: "swamp-club",
    kind: "rss",
    url: "https://swamp.club/feed.xml",
    author: "Swamp Club",
    tier: 1,
    enabled: true,
  },
  {
    name: "joapen",
    kind: "rss",
    url: "https://joapen.com/blog/feed/",
    author: "Joaquin Peña Fernández",
    tier: 2,
    enabled: true,
  },
  {
    name: "kdaniel",
    kind: "rss",
    url: "https://krzys.substack.com/feed",
    author: "Chris Daniel",
    tier: 2,
    enabled: true,
  },
  {
    name: "jon-ayre",
    kind: "rss",
    url: "https://jonayre.uk/blog/feed/",
    author: "Jon Ayre",
    tier: 2,
    enabled: true,
  },
  {
    name: "adrianco",
    kind: "rss",
    url: "https://medium.com/feed/@adrianco",
    author: "Adrian Cockcroft",
    tier: 2,
    enabled: true,
  },
  {
    name: "simon-wardley-linkedin",
    kind: "linkedin",
    url: "https://www.linkedin.com/in/simonwardley/",
    author: "Simon Wardley",
    tier: 2,
    enabled: true,
  },
  {
    name: "simon-wardley-blog",
    kind: "rss",
    url: "https://blog.gardeviance.org/feeds/posts/default?alt=rss",
    author: "Simon Wardley",
    tier: 2,
    enabled: true,
  },
];

const GlobalArgsSchema = z.object({
  sources: z
    .array(SourceSchema)
    .optional()
    .describe(
      "Sources to read. Omit to use the built-in curated set (Swamp Club " +
        "at tier 1, Wardley mappers at tier 2).",
    ),
  userAgent: z
    .string()
    .optional()
    .describe("Override the HTTP User-Agent used for all requests."),
  maxPerSource: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap articles kept per source (default 25)."),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ArticleSchema = z.object({
  title: z.string(),
  url: z.string(),
  source: z.string(),
  tier: z.number().int(),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  summary: z.string().optional(),
  firstSeenAt: z.string(),
  isNew: z.boolean(),
  read: z
    .boolean()
    .optional()
    .describe("True when this URL is in the persisted read set."),
});

/** One article surfaced from a source. */
export type Article = z.infer<typeof ArticleSchema>;

const ReadStateSchema = z.object({
  urls: z
    .record(z.string(), z.string())
    .describe("Map of read article URL → the ISO timestamp it was marked."),
  count: z.number().int(),
  updatedAt: z.string(),
});

const MessageSchema = z.object({
  text: z.string().describe("Rendered Telegram-ready message body (HTML)."),
  count: z.number().int(),
  windowHours: z.number(),
  generatedAt: z.string(),
});

const FeedSchema = z.object({
  source: z.string(),
  kind: z.string(),
  url: z.string(),
  tier: z.number().int(),
  author: z.string().optional(),
  ok: z.boolean(),
  error: z.string().optional(),
  fetchedAt: z.string(),
  count: z.number().int(),
  newCount: z.number().int(),
  articles: z.array(ArticleSchema),
});

const DigestSchema = z.object({
  generatedAt: z.string(),
  sourceCount: z.number().int(),
  okCount: z.number().int(),
  failedCount: z.number().int(),
  failed: z.array(z.string()),
  totalArticles: z.number().int(),
  newCount: z.number().int(),
  unreadCount: z.number().int().optional(),
  articles: z.array(ArticleSchema),
});

// --- parsing helpers -------------------------------------------------------

const escapeXmlText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Replace every CDATA section with equivalent escaped character data.
 *
 * Substack, Medium and WordPress wrap titles, authors and descriptions in
 * CDATA. The XML parser reports those nodes as empty `textContent`, so feeds
 * are normalised through this before parsing.
 */
export function unwrapCdata(xml: string): string {
  return xml.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    (_m, inner: string) => escapeXmlText(inner),
  );
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&hellip;": "…",
  "&rarr;": "→",
  "&mdash;": "—",
  "&ndash;": "–",
};

/** Strip HTML tags and decode common entities into a single-line excerpt. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&[a-z#0-9]+;/gi,
      (e) => ENTITIES[e.toLowerCase()] ?? " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate to `limit` characters on a word boundary, adding an ellipsis. */
export function truncate(text: string, limit = SUMMARY_LIMIT): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

/** Normalise a date string to ISO-8601, or undefined when unparseable. */
export function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// deno-lint-ignore no-explicit-any
type El = any;

const text = (el: El, sel: string): string | undefined => {
  const found = el?.querySelector?.(sel);
  const value = found?.textContent?.trim();
  return value ? value : undefined;
};

const tagText = (el: El, tag: string): string | undefined => {
  const found = el?.getElementsByTagName?.(tag)?.[0];
  const value = found?.textContent?.trim();
  return value ? value : undefined;
};

/**
 * Parse an RSS 2.0 or Atom document into articles.
 *
 * Atom `<link>` carries its target in the `href` attribute while RSS puts it
 * in the element text, so both are checked.
 */
/**
 * Accept a link only when it is http(s).
 *
 * Every URL here comes from a third-party feed we do not control, and it ends
 * up inside an `<a href="…">` in the Telegram digest — so `javascript:` and
 * `data:` links are an injection vector, not merely odd data. Escaping the
 * value does not help: `href="javascript:alert(1)"` needs no metacharacter to
 * fire. Reject the scheme at the parse boundary, once, rather than trusting
 * every downstream renderer to re-check it.
 */
function safeLinkUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseFeedXml(xml: string, source: Source): Article[] {
  const doc: El = new DOMParser().parseFromString(unwrapCdata(xml), "text/xml");
  const items: El[] = [
    ...doc.querySelectorAll("item"),
    ...doc.querySelectorAll("entry"),
  ];

  const articles: Article[] = [];
  for (const item of items) {
    const linkEl = item.querySelector("link");
    const url = safeLinkUrl(
      linkEl?.textContent?.trim() ||
        linkEl?.getAttribute?.("href") ||
        text(item, "guid") ||
        text(item, "id"),
    );
    if (!url) continue;

    const rawSummary = tagText(item, "content:encoded") ??
      text(item, "description") ??
      text(item, "summary") ??
      text(item, "content") ??
      "";

    const published = toIso(
      text(item, "pubDate") ??
        text(item, "published") ??
        text(item, "updated") ??
        tagText(item, "dc:date"),
    );

    const author = tagText(item, "dc:creator") ??
      text(item, "author name") ??
      text(item, "author") ??
      source.author;

    articles.push({
      title: stripHtml(text(item, "title") ?? "") || "(untitled)",
      url,
      source: source.name,
      tier: source.tier,
      author: author || undefined,
      publishedAt: published,
      summary: truncate(stripHtml(rawSummary)) || undefined,
      firstSeenAt: "",
      isNew: true,
    });
  }
  return articles;
}

const ldAuthorName = (author: unknown): string | undefined => {
  if (typeof author === "string") return author;
  if (author && typeof author === "object") {
    const name = (author as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return undefined;
};

/**
 * Parse a public LinkedIn profile page into articles.
 *
 * Reads the embedded JSON-LD `@graph`: `DiscussionForumPosting` nodes are
 * short posts (no headline, so a title is derived from the opening text) and
 * `Article` nodes are Pulse pieces.
 */
export function parseLinkedInProfile(html: string, source: Source): Article[] {
  const blocks = [
    ...html.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ];

  const articles: Article[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    const root = parsed as Record<string, unknown>;
    const graph = Array.isArray(root["@graph"])
      ? root["@graph"] as Record<string, unknown>[]
      : [root];

    for (const node of graph) {
      const type = node["@type"];
      const isPost = type === "DiscussionForumPosting";
      const isArticle = type === "Article";
      if (!isPost && !isArticle) continue;

      // Same scheme guard as the RSS path — LinkedIn's JSON-LD is scraped from
      // unauthenticated markup, so `url` is no more trustworthy than a feed's.
      const url = safeLinkUrl(
        typeof node.url === "string" ? node.url : undefined,
      );
      if (!url || seen.has(url)) continue;

      const body = typeof node.text === "string" ? stripHtml(node.text) : "";
      const headline = typeof node.headline === "string"
        ? stripHtml(node.headline)
        : "";
      const title = headline || truncate(body, 90) || "(untitled post)";
      if (title === "(untitled post)" && !body) continue;

      seen.add(url);
      articles.push({
        title,
        url,
        source: source.name,
        tier: source.tier,
        author: ldAuthorName(node.author) ?? source.author,
        publishedAt: toIso(
          typeof node.datePublished === "string"
            ? node.datePublished
            : undefined,
        ),
        summary: body ? truncate(body) : undefined,
        firstSeenAt: "",
        isNew: true,
      });
    }
  }
  return articles;
}

/** How the digest is ordered. */
export type OrderBy = "tier" | "date";

/**
 * Sort articles for the digest.
 *
 * `tier` (default) leads with the highest-priority sources, newest first
 * within a tier — the reading-priority view. `date` ignores tier and sorts
 * purely by publication date, newest first — the "what is latest" view.
 */
export function sortArticles(
  articles: Article[],
  orderBy: OrderBy = "tier",
): Article[] {
  return [...articles].sort((a, b) => {
    if (orderBy === "tier" && a.tier !== b.tier) return a.tier - b.tier;
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    if (at !== bt) return bt - at;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.title.localeCompare(b.title);
  });
}

/** Resolve the effective source list, dropping disabled entries. */
export function resolveSources(globalArgs: GlobalArgs): Source[] {
  const configured = globalArgs.sources?.length
    ? globalArgs.sources.map((s) => SourceSchema.parse(s))
    : DEFAULT_SOURCES;
  return configured.filter((s) => s.enabled);
}

async function fetchText(
  url: string,
  globalArgs: GlobalArgs,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: {
      "User-Agent": globalArgs.userAgent || DEFAULT_UA,
      "Accept":
        "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

type FeedRecord = z.infer<typeof FeedSchema>;

/** Read one source, returning a feed record; never throws. */
async function readSource(
  source: Source,
  globalArgs: GlobalArgs,
  previous: Map<string, string>,
  signal?: AbortSignal,
): Promise<FeedRecord> {
  const fetchedAt = new Date().toISOString();
  const base = {
    source: source.name,
    kind: source.kind,
    url: source.url,
    tier: source.tier,
    author: source.author,
    fetchedAt,
  };

  try {
    const body = await fetchText(source.url, globalArgs, signal);
    const parsed = source.kind === "linkedin"
      ? parseLinkedInProfile(body, source)
      : parseFeedXml(body, source);

    if (parsed.length === 0) {
      throw new Error(
        source.kind === "linkedin"
          ? "no JSON-LD posts found — LinkedIn markup may have changed or be gated"
          : "feed contained no items",
      );
    }

    const limit = globalArgs.maxPerSource ?? 25;
    const stamped = parsed.slice(0, limit).map((a) => {
      const seenAt = previous.get(a.url);
      return { ...a, firstSeenAt: seenAt ?? fetchedAt, isNew: !seenAt };
    });

    return {
      ...base,
      ok: true,
      count: stamped.length,
      newCount: stamped.filter((a) => a.isNew).length,
      articles: stamped,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      count: 0,
      newCount: 0,
      articles: [],
    };
  }
}

/**
 * Build the merged tier-ordered digest from per-source feed records.
 *
 * When `readUrls` is supplied, each article is annotated with a `read` flag and
 * the digest reports an `unreadCount`.
 */
export function buildDigest(
  feeds: FeedRecord[],
  orderBy: OrderBy = "tier",
  readUrls?: Set<string>,
): z.infer<typeof DigestSchema> {
  const flat = feeds.flatMap((f) => f.articles);
  const annotated = readUrls
    ? flat.map((a) => ({ ...a, read: readUrls.has(a.url) }))
    : flat;
  const articles = sortArticles(annotated, orderBy);
  const failed = feeds.filter((f) => !f.ok);
  return {
    generatedAt: new Date().toISOString(),
    sourceCount: feeds.length,
    okCount: feeds.length - failed.length,
    failedCount: failed.length,
    failed: failed.map((f) => `${f.source}: ${f.error ?? "unknown error"}`),
    totalArticles: articles.length,
    newCount: articles.filter((a) => a.isNew).length,
    unreadCount: readUrls
      ? articles.filter((a) => !readUrls.has(a.url)).length
      : undefined,
    articles,
  };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Keep only articles published within the last `sinceHours` (by `nowMs`). */
export function windowArticles(
  articles: Article[],
  sinceHours: number,
  nowMs: number,
): Article[] {
  const cutoff = nowMs - sinceHours * 3_600_000;
  return articles.filter((a) => {
    const t = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
    return !Number.isNaN(t) && t >= cutoff;
  });
}

/**
 * Render articles into a Telegram-ready HTML message.
 *
 * Uses `parse_mode: HTML` (titles/authors escaped, one `<a href>` per item).
 * The body is capped at `maxChars` (Telegram's limit is 4096); the overflow is
 * replaced with an "…and N more" line.
 */
export function renderTelegramHtml(
  articles: Article[],
  opts: { windowHours: number; maxChars?: number },
): string {
  const maxChars = opts.maxChars ?? 3800;
  const n = articles.length;
  const header = `📚 <b>${n} new post${
    n === 1 ? "" : "s"
  }</b> · last ${opts.windowHours}h`;
  const lines = [header, ""];
  let shown = 0;
  for (const a of articles) {
    const when = a.publishedAt ? a.publishedAt.slice(0, 10) : "";
    const meta = [a.author, a.source, when]
      .filter((x): x is string => Boolean(x))
      .map(escapeHtml)
      .join(" · ");
    const line = `• <a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>` +
      (meta ? `\n  ${meta}` : "");
    if ([...lines, line].join("\n").length > maxChars) break;
    lines.push(line);
    shown++;
  }
  if (shown < n) lines.push(`\n…and ${n - shown} more`);
  return lines.join("\n");
}

/** A filter selecting which stored articles to mark read / unread. */
export interface MarkFilter {
  urls?: string[];
  source?: string;
  tier?: number;
  before?: string;
  all?: boolean;
}

/**
 * Resolve the set of article URLs a mark filter selects.
 *
 * Explicit `urls` are always included (even if aged out of the feeds). The
 * `source`/`tier`/`before`/`all` selectors are resolved against the stored
 * feed articles. `before` is an **exclusive** cutoff: an article matches when
 * its `publishedAt` is strictly earlier than the parsed instant.
 */
export function selectUrls(feeds: FeedRecord[], filter: MarkFilter): string[] {
  const explicit = filter.urls ?? [];
  const hasFeedFilter = Boolean(
    filter.all || filter.source || filter.tier !== undefined || filter.before,
  );
  const cut = filter.before ? Date.parse(filter.before) : undefined;
  const matched = hasFeedFilter
    ? feeds
      .flatMap((f) => f.articles)
      .filter((a) => {
        if (filter.all) return true;
        if (filter.source && a.source !== filter.source) return false;
        if (filter.tier !== undefined && a.tier !== filter.tier) return false;
        if (cut !== undefined) {
          const t = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
          if (Number.isNaN(t) || t >= cut) return false;
        }
        return true;
      })
      .map((a) => a.url)
    : [];
  return [...new Set([...explicit, ...matched])];
}

/** Build the URL set from a stored read-state record. */
export function readUrlSet(
  readState: z.infer<typeof ReadStateSchema> | null,
): Set<string> {
  return new Set(Object.keys(readState?.urls ?? {}));
}

// --- source discovery ------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Pull every http(s) URL out of a blob of text. */
export function extractUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, ""));
}

/**
 * Hostname without a leading `www.`, or undefined when unparseable OR not
 * http(s). `new URL("javascript:alert(1)")` parses happily and yields an EMPTY
 * hostname, so a bare try/catch is not enough to reject a hostile scheme —
 * without the protocol check this returns "" and every caller has to remember
 * to treat that as a failure.
 */
export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hosts that aggregate many unrelated authors, or that never carry a
 * per-author feed worth subscribing to. Counting these as "an author" would
 * bury the real writers.
 */
const NON_AUTHOR_HOSTS = new Set([
  "amazon.com",
  "archiveofourown.org",
  "arxiv.org",
  "github.com",
  "ilibrary.ru",
  "lib.ru",
  "linkedin.com",
  "patreon.com",
  "researchgate.net",
  "sciencedirect.com",
  "substack.com",
  "tandfonline.com",
  "x.com",
  "youtube.com",
]);

const FEED_LINK_RE =
  /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi;
const HREF_RE = /href=["']([^"']+)["']/i;
const TITLE_ATTR_RE = /title=["']([^"']*)["']/i;

/** Candidate feed paths to try when a page declares no autodiscovery link. */
const FEED_PATHS = [
  "/feed/",
  "/feed.xml",
  "/index.xml",
  "/rss.xml",
  "/atom.xml",
];

function absolutise(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** True when the body looks like a real RSS/Atom document. */
function looksLikeFeed(body: string): boolean {
  return /<(rss|feed)[\s>]/i.test(body.slice(0, 2000));
}

/**
 * Find a feed for a host: read its homepage for an autodiscovery `<link>`,
 * falling back to the conventional feed paths.
 */
async function discoverFeed(
  host: string,
  globalArgs: GlobalArgs,
  signal?: AbortSignal,
): Promise<{ feedUrl?: string; feedTitle?: string; note?: string }> {
  const home = `https://${host}/`;
  let html = "";
  try {
    html = await fetchText(home, globalArgs, signal);
  } catch (err) {
    return {
      note: `homepage unreachable: ${err instanceof Error ? err.message : err}`,
    };
  }

  for (const tag of html.match(FEED_LINK_RE) ?? []) {
    const href = tag.match(HREF_RE)?.[1];
    if (!href) continue;
    return {
      feedUrl: absolutise(href, home),
      feedTitle: tag.match(TITLE_ATTR_RE)?.[1] || undefined,
    };
  }

  for (const path of FEED_PATHS) {
    const candidate = `https://${host}${path}`;
    try {
      const body = await fetchText(candidate, globalArgs, signal);
      if (looksLikeFeed(body)) return { feedUrl: candidate };
    } catch {
      // try the next conventional path
    }
  }
  return {
    note: "no autodiscovery link and no feed at the conventional paths",
  };
}

/** Run `worker` over `items` with at most `size` in flight at once. */
async function mapPool<T, R>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

const CandidateSchema = z.object({
  host: z.string(),
  mentions: z.number().int(),
  suggestedName: z.string(),
  feedUrl: z.string().optional(),
  feedTitle: z.string().optional(),
  note: z.string().optional(),
  alreadyConfigured: z.boolean(),
  examples: z.array(z.string()),
});

/** Turn a hostname into a stable kebab-case source name. */
export function suggestName(host: string): string {
  return host
    .replace(
      /\.(com|org|net|io|dev|blog|co\.uk|co|ai|me|to|de|ru|nl|wtf|press)$/i,
      "",
    )
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/**
 * Group URLs by host and rank by how often each appears.
 *
 * Aggregator hosts are dropped, as are hosts already configured as sources.
 */
export function rankHosts(
  urls: string[],
  configuredHosts: Set<string>,
  minMentions: number,
): Array<
  {
    host: string;
    mentions: number;
    examples: string[];
    alreadyConfigured: boolean;
  }
> {
  const byHost = new Map<string, string[]>();
  for (const url of urls) {
    const host = hostOf(url);
    if (!host || NON_AUTHOR_HOSTS.has(host)) continue;
    const list = byHost.get(host) ?? [];
    list.push(url);
    byHost.set(host, list);
  }

  return [...byHost.entries()]
    .map(([host, list]) => ({
      host,
      mentions: list.length,
      examples: list.slice(0, 3),
      alreadyConfigured: configuredHosts.has(host),
    }))
    .filter((h) => h.mentions >= minMentions)
    .sort((a, b) => b.mentions - a.mentions || a.host.localeCompare(b.host));
}

const feedInstance = (name: string): string => `feed-${name}`;
const READ_INSTANCE = "read-state";

/** Fetch every enabled source fresh (self-contained; no cross-run state). */
function collectFeeds(
  globalArgs: GlobalArgs,
  signal?: AbortSignal,
): Promise<FeedRecord[]> {
  const sources = resolveSources(globalArgs);
  return Promise.all(
    sources.map((s) => readSource(s, globalArgs, new Map(), signal)),
  );
}

/** Load the stored feed record for every configured source. */
async function loadStoredFeeds(
  context: {
    globalArgs: GlobalArgs;
    readResource: (name: string) => Promise<Record<string, unknown> | null>;
  },
): Promise<FeedRecord[]> {
  const feeds: FeedRecord[] = [];
  for (const s of resolveSources(context.globalArgs)) {
    const stored = await context.readResource(feedInstance(s.name))
      .catch(() => null);
    if (stored) feeds.push(stored as unknown as FeedRecord);
  }
  return feeds;
}

/** Model definition for the curated reading list. */
export const model = {
  type: "@magistr/reading-list",
  version: "2026.08.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "feed": {
      description: "Articles from one configured source",
      schema: FeedSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "digest": {
      description: "Merged reading list across all sources, tier-ordered",
      schema: DigestSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "candidate": {
      description: "A host discovered from saved links, with its feed if found",
      schema: CandidateSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "read": {
      description: "Persisted read state — the set of article URLs marked read",
      schema: ReadStateSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "message": {
      description: "A rendered Telegram-ready digest message",
      schema: MessageSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    fetch: {
      description:
        "Read every enabled source in one execution and write per-source " +
        "feeds plus a merged tier-ordered digest. A failing source is " +
        "recorded and does not abort the run.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          signal?: AbortSignal;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warning: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const sources = resolveSources(context.globalArgs);
        if (sources.length === 0) {
          throw new Error("No enabled sources configured");
        }

        // Carry forward firstSeenAt so re-running does not churn the field.
        const priorSeen = await Promise.all(
          sources.map(async (s) => {
            const prev = await context.readResource(feedInstance(s.name))
              .catch(() => null);
            const articles = (prev?.articles ?? []) as Array<
              { url?: string; firstSeenAt?: string }
            >;
            const map = new Map<string, string>();
            for (const a of articles) {
              if (a.url && a.firstSeenAt) map.set(a.url, a.firstSeenAt);
            }
            return map;
          }),
        );

        const feeds = await Promise.all(
          sources.map((s, i) =>
            readSource(s, context.globalArgs, priorSeen[i], context.signal)
          ),
        );

        const handles: Array<{ name: string }> = [];
        for (const feed of feeds) {
          if (!feed.ok) {
            context.logger?.warning("Source {source} failed: {error}", {
              source: feed.source,
              error: feed.error,
            });
          }
          handles.push(
            await context.writeResource(
              "feed",
              feedInstance(feed.source),
              feed,
            ),
          );
        }

        const readState = await context.readResource(READ_INSTANCE)
          .catch(() => null) as z.infer<typeof ReadStateSchema> | null;
        const digest = buildDigest(feeds, "tier", readUrlSet(readState));
        context.logger?.info(
          "Read {ok}/{total} sources, {articles} articles " +
            "({fresh} new, {unread} unread)",
          {
            ok: digest.okCount,
            total: digest.sourceCount,
            articles: digest.totalArticles,
            fresh: digest.newCount,
            unread: digest.unreadCount ?? digest.totalArticles,
          },
        );
        handles.push(
          await context.writeResource("digest", "digest-latest", digest),
        );

        return { dataHandles: handles };
      },
    },

    latest: {
      description:
        "Rebuild a digest from already-stored feeds without re-fetching. " +
        "Filter by tier, source, recency, or unread.",
      arguments: z.object({
        tier: z
          .number()
          .int()
          .optional()
          .describe("Only include articles at this tier."),
        source: z
          .string()
          .optional()
          .describe("Only include articles from this source name."),
        sinceDays: z
          .number()
          .positive()
          .optional()
          .describe("Only include articles published within this many days."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of articles in the digest."),
        onlyNew: z
          .boolean()
          .optional()
          .describe("Only include articles first seen on the last fetch."),
        unreadOnly: z
          .boolean()
          .optional()
          .describe("Only include articles not marked read (see markRead)."),
        orderBy: z
          .enum(["tier", "date"])
          .optional()
          .describe(
            "`tier` (default) = reading-priority order; `date` = newest " +
              "first across all tiers (a true latest-posts list).",
          ),
      }),
      execute: async (
        args: {
          tier?: number;
          source?: string;
          sinceDays?: number;
          limit?: number;
          onlyNew?: boolean;
          unreadOnly?: boolean;
          orderBy?: OrderBy;
        },
        context: {
          globalArgs: GlobalArgs;
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const sources = resolveSources(context.globalArgs);
        const feeds: FeedRecord[] = [];
        for (const s of sources) {
          const stored = await context.readResource(feedInstance(s.name))
            .catch(() => null);
          if (stored) feeds.push(stored as unknown as FeedRecord);
        }
        if (feeds.length === 0) {
          throw new Error(
            "No stored feeds — run the `fetch` method first.",
          );
        }

        const readState = await context.readResource(READ_INSTANCE)
          .catch(() => null) as z.infer<typeof ReadStateSchema> | null;
        const readUrls = readUrlSet(readState);

        const cutoff = args.sinceDays
          ? Date.now() - args.sinceDays * 86_400_000
          : undefined;

        const filtered = feeds.map((f) => ({
          ...f,
          articles: f.articles.filter((a) => {
            if (args.tier !== undefined && a.tier !== args.tier) return false;
            if (args.source && a.source !== args.source) return false;
            if (args.onlyNew && !a.isNew) return false;
            if (args.unreadOnly && readUrls.has(a.url)) return false;
            if (cutoff !== undefined) {
              const t = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
              if (Number.isNaN(t) || t < cutoff) return false;
            }
            return true;
          }),
        }));

        const digest = buildDigest(filtered, args.orderBy ?? "tier", readUrls);
        if (args.limit !== undefined) {
          digest.articles = digest.articles.slice(0, args.limit);
          digest.totalArticles = digest.articles.length;
          digest.newCount = digest.articles.filter((a) => a.isNew).length;
          digest.unreadCount = digest.articles.filter((a) => !a.read).length;
        }

        const handle = await context.writeResource(
          "digest",
          "digest-latest",
          digest,
        );
        return { dataHandles: [handle] };
      },
    },

    digestMessage: {
      description:
        "Fetch all sources and compose a Telegram-ready HTML digest of posts " +
        "published in the last `sinceHours` hours. Self-contained (fetches " +
        "fresh, no cross-run state), so it is safe under the run-scoped serve " +
        "scheduler. Writes the composed `message` resource; when " +
        "`telegramModel` is set it also sends via that @magistr/telegram/send " +
        "instance (e.g. tg-bot). An empty window is a no-op (nothing sent), so " +
        "quiet days stay silent without any workflow gating.",
      arguments: z.object({
        sinceHours: z
          .number()
          .positive()
          .optional()
          .describe("Look-back window in hours (default 26)."),
        orderBy: z
          .enum(["tier", "date"])
          .optional()
          .describe("`date` (default) or `tier` ordering of the list."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of posts in the message."),
        telegramModel: z
          .string()
          .optional()
          .describe(
            "Name of a @magistr/telegram/send instance to send through " +
              "(omit to compose only, without sending).",
          ),
        chatId: z
          .string()
          .optional()
          .describe("Override the Telegram chat; defaults to the instance's."),
      }),
      execute: async (
        args: {
          sinceHours?: number;
          orderBy?: OrderBy;
          limit?: number;
          telegramModel?: string;
          chatId?: string;
        },
        context: {
          globalArgs: GlobalArgs;
          signal?: AbortSignal;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warning: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          runModel: (
            options: {
              definition: string;
              method: string;
              arguments: Record<string, unknown>;
            },
          ) => Promise<{ resources: Array<{ name: string }> }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const sinceHours = args.sinceHours ?? 26;
        const feeds = await collectFeeds(context.globalArgs, context.signal);

        const failed = feeds.filter((f) => !f.ok);
        for (const f of failed) {
          context.logger?.warning("Source {source} failed: {error}", {
            source: f.source,
            error: f.error,
          });
        }
        if (failed.length === feeds.length) {
          throw new Error(
            `All ${feeds.length} sources failed — refusing to compose a digest.`,
          );
        }

        let windowed = sortArticles(
          windowArticles(
            feeds.flatMap((f) => f.articles),
            sinceHours,
            Date.now(),
          ),
          args.orderBy ?? "date",
        );
        if (args.limit !== undefined) windowed = windowed.slice(0, args.limit);

        if (windowed.length === 0) {
          context.logger?.info(
            "No posts in the last {h}h — nothing to send.",
            { h: sinceHours },
          );
          return { dataHandles: [] };
        }

        const text = renderTelegramHtml(windowed, { windowHours: sinceHours });
        const handle = await context.writeResource(
          "message",
          "digest-message",
          {
            text,
            count: windowed.length,
            windowHours: sinceHours,
            generatedAt: new Date().toISOString(),
          },
        );
        context.logger?.info(
          "Composed digest: {n} post(s) over {h}h from {ok}/{total} sources",
          {
            n: windowed.length,
            h: sinceHours,
            ok: feeds.length - failed.length,
            total: feeds.length,
          },
        );

        if (args.telegramModel) {
          // Send through the existing Telegram instance (e.g. tg-bot).
          //
          // Under `swamp serve` this path has been observed to RETURN WITHOUT
          // EXECUTING the callee: on 2026-08-07 the 08:00 scheduled run logged
          // a successful send 224ms after composing, while tg-bot wrote no log
          // file and no sentMessage artifact in the same container — three days
          // of green runs delivered nothing. Prefer a dedicated tg-bot workflow
          // STEP over this argument (see the reading-list-daily workflow); a
          // step and a direct method run both work where this does not.
          //
          // So do NOT trust `await` returning as proof of delivery. A real send
          // writes a sentMessage resource, so require a returned handle and
          // fail loudly when there is none — a silent no-op here is the exact
          // failure that hid for three days.
          const sendArgs: Record<string, unknown> = {
            text,
            parseMode: "HTML",
            disableWebPagePreview: true,
          };
          if (args.chatId) sendArgs.chatId = args.chatId;
          const sent = await context.runModel({
            definition: args.telegramModel,
            method: "sendMessage",
            arguments: sendArgs,
          });
          const handles = sent?.resources ?? [];
          if (handles.length === 0) {
            throw new Error(
              `Telegram send via "${args.telegramModel}" produced no ` +
                `sentMessage resource — the call returned without delivering. ` +
                `Send through a dedicated ${args.telegramModel} workflow step ` +
                `instead of the telegramModel argument.`,
            );
          }
          context.logger?.info("Sent digest via {tg} ({resource})", {
            tg: args.telegramModel,
            resource: handles[0].name,
          });
        }

        return { dataHandles: [handle] };
      },
    },

    markRead: {
      description:
        "Mark articles as read — persisted by URL so it survives re-fetches. " +
        "Select with `urls`, and/or `source`, `tier`, `before` (exclusive " +
        "publish cutoff), or `all`. Combinable, e.g. source + before.",
      arguments: z.object({
        urls: z
          .array(z.string())
          .optional()
          .describe("Explicit article URLs to mark read."),
        source: z
          .string()
          .optional()
          .describe("Mark every stored article from this source name."),
        tier: z
          .number()
          .int()
          .optional()
          .describe("Mark every stored article at this tier."),
        before: z
          .string()
          .optional()
          .describe(
            "Mark articles published strictly before this date/ISO instant. " +
              "A bare date is midnight UTC, so before=<today> marks through " +
              "yesterday.",
          ),
        all: z
          .boolean()
          .optional()
          .describe("Mark every stored article read."),
      }),
      execute: async (
        args: {
          urls?: string[];
          source?: string;
          tier?: number;
          before?: string;
          all?: boolean;
        },
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const hasSelector = Boolean(
          args.urls?.length || args.source || args.tier !== undefined ||
            args.before || args.all,
        );
        if (!hasSelector) {
          throw new Error(
            "Specify what to mark: urls, source, tier, before, or all.",
          );
        }
        if (args.before && Number.isNaN(Date.parse(args.before))) {
          throw new Error(`Unparseable \`before\` date: ${args.before}`);
        }

        const feeds = await loadStoredFeeds(context);
        const selected = selectUrls(feeds, args);
        if (selected.length === 0) {
          throw new Error(
            "Nothing matched — check the selector, and run `fetch` first if " +
              "you are selecting by source/tier/before.",
          );
        }

        const prior = await context.readResource(READ_INSTANCE)
          .catch(() => null) as z.infer<typeof ReadStateSchema> | null;
        const urls: Record<string, string> = { ...(prior?.urls ?? {}) };
        const now = new Date().toISOString();
        let added = 0;
        for (const url of selected) {
          if (!urls[url]) {
            urls[url] = now; // keep the earliest read time on re-marks
            added++;
          }
        }

        const handle = await context.writeResource("read", READ_INSTANCE, {
          urls,
          count: Object.keys(urls).length,
          updatedAt: now,
        });
        context.logger?.info(
          "Marked {added} newly read ({total} read in total)",
          { added, total: Object.keys(urls).length },
        );
        return { dataHandles: [handle] };
      },
    },

    markUnread: {
      description:
        "Remove articles from the read set. Same selectors as markRead; " +
        "`all` clears the entire read set.",
      arguments: z.object({
        urls: z
          .array(z.string())
          .optional()
          .describe("Explicit article URLs to mark unread."),
        source: z
          .string()
          .optional()
          .describe("Unmark every stored article from this source name."),
        tier: z
          .number()
          .int()
          .optional()
          .describe("Unmark every stored article at this tier."),
        before: z
          .string()
          .optional()
          .describe("Unmark articles published strictly before this instant."),
        all: z
          .boolean()
          .optional()
          .describe("Clear the entire read set."),
      }),
      execute: async (
        args: {
          urls?: string[];
          source?: string;
          tier?: number;
          before?: string;
          all?: boolean;
        },
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const hasSelector = Boolean(
          args.urls?.length || args.source || args.tier !== undefined ||
            args.before || args.all,
        );
        if (!hasSelector) {
          throw new Error(
            "Specify what to unmark: urls, source, tier, before, or all.",
          );
        }
        if (args.before && Number.isNaN(Date.parse(args.before))) {
          throw new Error(`Unparseable \`before\` date: ${args.before}`);
        }

        const prior = await context.readResource(READ_INSTANCE)
          .catch(() => null) as z.infer<typeof ReadStateSchema> | null;
        const urls: Record<string, string> = { ...(prior?.urls ?? {}) };
        const now = new Date().toISOString();

        let removed = 0;
        if (
          args.all && !args.urls?.length && !args.source &&
          args.tier === undefined && !args.before
        ) {
          removed = Object.keys(urls).length;
          for (const key of Object.keys(urls)) delete urls[key];
        } else {
          const feeds = await loadStoredFeeds(context);
          for (const url of selectUrls(feeds, args)) {
            if (urls[url]) {
              delete urls[url];
              removed++;
            }
          }
        }

        const handle = await context.writeResource("read", READ_INSTANCE, {
          urls,
          count: Object.keys(urls).length,
          updatedAt: now,
        });
        context.logger?.info(
          "Unmarked {removed} ({total} read remaining)",
          { removed, total: Object.keys(urls).length },
        );
        return { dataHandles: [handle] };
      },
    },

    discover: {
      description:
        "Find candidate authors from links already saved in another model's " +
        "stored data (e.g. an mk reading board), grouped by host and probed " +
        "for an RSS/Atom feed. Reads stored data — does not re-fetch the " +
        "source model.",
      arguments: z.object({
        fromModelType: z
          .string()
          .optional()
          .describe("Model type holding the saved links (e.g. @magistr/mk)."),
        fromModelId: z
          .string()
          .optional()
          .describe("Model instance id holding the saved links."),
        specName: z
          .string()
          .optional()
          .describe("Only read data artifacts of this spec (e.g. card)."),
        match: z
          .string()
          .optional()
          .describe(
            "Only read records whose JSON contains this string, e.g. a board " +
              "title. Applied before URL extraction.",
          ),
        urls: z
          .array(z.string())
          .optional()
          .describe("Explicit URLs to analyse instead of reading a model."),
        minMentions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Only report hosts seen at least this many times (default 1).",
          ),
        probe: z
          .boolean()
          .optional()
          .describe("Probe each host for a feed (default true)."),
      }),
      execute: async (
        args: {
          fromModelType?: string;
          fromModelId?: string;
          specName?: string;
          match?: string;
          urls?: string[];
          minMentions?: number;
          probe?: boolean;
        },
        context: {
          globalArgs: GlobalArgs;
          signal?: AbortSignal;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          dataRepository: {
            findAllForModel: (
              type: string,
              modelId: string,
            ) => Promise<
              Array<{ name: string; tags?: Record<string, string> }>
            >;
            getContent: (
              type: string,
              modelId: string,
              dataName: string,
            ) => Promise<Uint8Array | null>;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const urls: string[] = [...(args.urls ?? [])];

        if (args.fromModelType && args.fromModelId) {
          const records = await context.dataRepository.findAllForModel(
            args.fromModelType,
            args.fromModelId,
          );
          const decoder = new TextDecoder();
          for (const record of records) {
            if (args.specName) {
              const spec = record.tags?.specName;
              const matchesSpec = spec
                ? spec === args.specName
                : record.name.startsWith(`${args.specName}-`);
              if (!matchesSpec) continue;
            }
            const bytes = await context.dataRepository
              .getContent(args.fromModelType, args.fromModelId, record.name)
              .catch(() => null);
            if (!bytes) continue;
            const body = decoder.decode(bytes);
            if (args.match && !body.includes(args.match)) continue;
            // One record = one mention. A stored card repeats its link in both
            // `notes` and `raw.notes`, which would otherwise double every count.
            urls.push(...new Set(extractUrls(body)));
          }
        }

        if (urls.length === 0) {
          throw new Error(
            "No URLs found — pass `urls`, or a `fromModelType` + `fromModelId` " +
              "whose stored data contains links.",
          );
        }

        const configuredHosts = new Set(
          resolveSources(context.globalArgs)
            .map((s) => hostOf(s.url))
            .filter((h): h is string => Boolean(h)),
        );

        const ranked = rankHosts(urls, configuredHosts, args.minMentions ?? 1);
        context.logger?.info(
          "Extracted {urls} link(s) → {hosts} candidate host(s)",
          { urls: urls.length, hosts: ranked.length },
        );

        const probe = args.probe ?? true;
        const probed = probe
          ? await mapPool(ranked, 6, async (h) => ({
            ...h,
            ...await discoverFeed(h.host, context.globalArgs, context.signal),
          }))
          : ranked.map((h) => ({
            ...h,
            feedUrl: undefined,
            feedTitle: undefined,
            note: "not probed",
          }));

        const handles: Array<{ name: string }> = [];
        for (const c of probed) {
          const record = {
            host: c.host,
            mentions: c.mentions,
            suggestedName: suggestName(c.host),
            feedUrl: (c as { feedUrl?: string }).feedUrl,
            feedTitle: (c as { feedTitle?: string }).feedTitle,
            note: (c as { note?: string }).note,
            alreadyConfigured: c.alreadyConfigured,
            examples: c.examples,
          };
          handles.push(
            await context.writeResource(
              "candidate",
              `candidate-${suggestName(c.host)}`,
              record,
            ),
          );
        }

        const withFeed =
          probed.filter((c) => (c as { feedUrl?: string }).feedUrl).length;
        context.logger?.info(
          "{withFeed}/{total} candidate host(s) have a discoverable feed",
          { withFeed, total: probed.length },
        );

        return { dataHandles: handles };
      },
    },

    sources: {
      description:
        "List the configured sources and their tiers without fetching.",
      arguments: z.object({}),
      execute: (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: [] }> => {
        for (const s of sortSources(resolveSources(context.globalArgs))) {
          context.logger?.info(
            "tier {tier}  {name} ({kind})  {url}",
            { tier: s.tier, name: s.name, kind: s.kind, url: s.url },
          );
        }
        return Promise.resolve({ dataHandles: [] });
      },
    },
  },
};

/** Order sources by tier, then name. */
export function sortSources(sources: Source[]): Source[] {
  return [...sources].sort((a, b) =>
    a.tier !== b.tier ? a.tier - b.tier : a.name.localeCompare(b.name)
  );
}
