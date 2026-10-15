import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// @magistr/habr
//
// Read a Habr user's publications and full article bodies from Habr's public
// JSON API (habr.com/kek/v2), no credentials required.
//
// Habr's web pages are React-rendered, but the same data that hydrates them is
// served as clean JSON by the /kek/v2 API:
//   - GET /kek/v2/articles/?user=<alias>&fl=<lang>&hl=<lang>&page=<n>
//       -> { pagesCount, publicationIds[], publicationRefs{ id: ref } }
//   - GET /kek/v2/articles/<id>/?fl=<lang>&hl=<lang>
//       -> a single publication ref including the full `textHtml` body.
// So this model calls the API directly rather than scraping markup.
//
// `list-articles` is a fan-out read: it loops every page of the user's feed
// internally (one method run, one model-lock acquisition) instead of asking
// the caller to page N times.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = "https://habr.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LANG = "ru";
const MAX_REDIRECT_HOPS = 5;

const GlobalArgsSchema = z.object({
  baseUrl: z
    .string()
    .optional()
    .describe(
      "Habr base URL (default https://habr.com). Override for a mirror.",
    ),
  userAgent: z
    .string()
    .optional()
    .describe("Override the HTTP User-Agent used for requests."),
  timeoutMs: z
    .number()
    .optional()
    .describe(
      "Per-request timeout in milliseconds (default 15000). Spans every " +
        "redirect hop of a single request, not each hop individually.",
    ),
  lang: z
    .string()
    .optional()
    .describe(
      "Content/interface language passed as the fl & hl API params " +
        "(default 'ru'). Use 'en' for the English feed.",
    ),
});

// --- host allowlist (SSRF guard) --------------------------------------------
//
// Every URL fetched is built internally from the configured base host plus a
// fixed API path, and the caller-supplied `user`/`id` are shape-validated
// before use (see sanitizeAlias / assertNumericId). This guard is the
// defence-in-depth backstop: the resolved host must be the configured base
// host, or habr.com / *.habr.com. The check is exact-match or dot-suffixed —
// never a naive substring/endsWith without a dot boundary, which would wrongly
// admit lookalikes like "evilhabr.com" or "habr.com.attacker.example".

function hostAllowed(
  url: string,
  context: { globalArgs?: { baseUrl?: string } },
): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const configuredBase = context.globalArgs?.baseUrl || DEFAULT_BASE;
  let configuredHost = "";
  try {
    configuredHost = new URL(configuredBase).hostname.toLowerCase();
  } catch {
    // Malformed configured base — fall through to the habr.com check.
  }
  if (configuredHost && host === configuredHost) return true;
  if (host === "habr.com" || host.endsWith(".habr.com")) return true;
  return false;
}

function assertHostAllowed(
  url: string,
  context: { globalArgs?: { baseUrl?: string } },
): void {
  if (!hostAllowed(url, context)) {
    throw new Error(
      `Refusing to fetch disallowed host for "${url}" — only the configured ` +
        "base host or habr.com/*.habr.com are allowed.",
    );
  }
}

// --- input validation -------------------------------------------------------

/**
 * Validate a Habr user alias. Aliases are ASCII letters, digits, underscore and
 * hyphen only; anything else (slashes, dots, query chars) is rejected so it can
 * never smuggle path or query segments into the API URL.
 */
export function sanitizeAlias(user: string): string {
  const trimmed = (user ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(
      `Invalid Habr user alias "${user}" — expected only letters, digits, ` +
        "underscore or hyphen.",
    );
  }
  return trimmed;
}

/**
 * Validate a Habr publication id: a non-empty run of digits. Rejects anything
 * else before it reaches the API URL.
 */
export function assertNumericId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid Habr article id "${id}" — expected a numeric publication id.`,
    );
  }
  return trimmed;
}

// --- HTML helpers -----------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

/**
 * Decode the small set of HTML entities Habr emits in titles, plus numeric
 * (&#123; / &#x1F;) references. Not a full entity table — enough to turn a
 * titleHtml into a clean plain-text title.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // fromCodePoint throws a RangeError above U+10FFFF; an out-of-range
      // reference (e.g. "&#99999999;") is left as-is instead of aborting.
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? m;
  });
}

/**
 * Strip HTML tags and decode entities, collapsing whitespace — used to derive a
 * plain-text `title` from Habr's `titleHtml`.
 */
export function stripHtml(html: string): string {
  return decodeEntities((html ?? "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convert an article body's HTML to readable plain text: block-level tags
 * (p, div, li, headings, br, blockquote, tr) become line breaks, list items get
 * a bullet, then tags are stripped and entities decoded. Runs of blank lines are
 * collapsed to at most one so the result stays compact but keeps paragraphs.
 */
export function htmlToText(html: string): string {
  const withBreaks = (html ?? "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li(\s[^>]*)?>/gi, "\n• ")
    // A closing </li> adds no break of its own (the next <li> does), so list
    // items stay single-spaced; the end of the whole list ends a paragraph.
    .replace(/<\s*\/\s*(ul|ol)\s*>/gi, "\n\n")
    .replace(
      /<\s*\/\s*(p|div|h[1-6]|blockquote|tr|table|figure|figcaption|pre)\s*>/gi,
      "\n",
    )
    .replace(/<\s*(h[1-6]|blockquote)[^>]*>/gi, "\n");
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ""))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- URL builders -----------------------------------------------------------

function base(context: { globalArgs?: { baseUrl?: string } }): string {
  return (context.globalArgs?.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
}

/**
 * Validate a Habr language code ("ru", "en"). It is interpolated into both the
 * `fl`/`hl` query params and the article URL path, so anything other than a
 * short run of letters is rejected rather than allowed to smuggle extra query
 * params or path segments.
 */
export function sanitizeLang(value: string): string {
  const trimmed = (value ?? "").trim();
  if (!/^[A-Za-z]{2,8}$/.test(trimmed)) {
    throw new Error(
      `Invalid Habr language "${value}" — expected a short language code ` +
        "such as 'ru' or 'en'.",
    );
  }
  return trimmed.toLowerCase();
}

function lang(context: { globalArgs?: { lang?: string } }): string {
  return sanitizeLang(context.globalArgs?.lang || DEFAULT_LANG);
}

/** Hard ceiling on feed pages fetched by one list-articles run. */
export const MAX_PAGES = 500;

/**
 * Coerce Habr's `pagesCount` into a page count in [1, MAX_PAGES]. A missing,
 * non-numeric or non-positive value means one page; a hostile huge value is
 * clamped so the fan-out loop cannot run unbounded.
 */
export function normalizePagesCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGES);
}

function count(raw: unknown): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Public web URL for an article, e.g. https://habr.com/ru/articles/845266/. */
export function articleUrl(id: string, baseUrl: string, l: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${l}/articles/${id}/`;
}

// --- HTTP -------------------------------------------------------------------

async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// deno-lint-ignore no-explicit-any
type Ctx = any;

async function fetchJson(url: string, context: Ctx): Promise<unknown> {
  assertHostAllowed(url, context);
  const ua = context.globalArgs?.userAgent || DEFAULT_UA;
  const timeoutMs = context.globalArgs?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    "User-Agent": ua,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ru,en;q=0.9",
  };
  return await withTimeout(timeoutMs, async (signal) => {
    // redirect: "manual" so every hop's Location is re-validated against the
    // host allowlist before it is followed, in a loop bounded to
    // MAX_REDIRECT_HOPS. An opaque redirect (or one with no Location) can't be
    // inspected, so it throws rather than being silently followed.
    let currentUrl = url;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const res = await fetch(currentUrl, {
        headers,
        redirect: "manual",
        signal,
      });
      const isRedirect = res.type === "opaqueredirect" ||
        (res.status >= 300 && res.status < 400);
      if (!isRedirect) {
        response = res;
        break;
      }
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(
          `Redirect from "${currentUrl}" had no Location header (status ` +
            `${res.status}).`,
        );
      }
      const next = new URL(location, currentUrl).toString();
      assertHostAllowed(next, context);
      currentUrl = next;
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error(
          `Too many redirects (>${MAX_REDIRECT_HOPS}) starting from "${url}".`,
        );
      }
    }
    if (!response) {
      throw new Error(`No response fetching "${url}".`);
    }
    if (!response.ok) {
      throw new Error(
        `Habr API request failed: ${response.status} ${response.statusText} ` +
          `for "${currentUrl}".`,
      );
    }
    return await response.json();
  });
}

// --- ref parsing ------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Ref = any;

/**
 * Project a Habr publication ref (from publicationRefs or the single-article
 * endpoint) into a stable article summary. Pure — no I/O.
 */
export function parseSummary(ref: Ref, baseUrl: string, l: string): {
  id: string;
  title: string;
  url: string;
  lang: string;
  timePublished: string | null;
  readingTime: number | null;
  complexity: string | null;
  postType: string | null;
  tags: string[];
  hubs: string[];
  author: string | null;
  statistics: {
    reads: number;
    comments: number;
    score: number;
    votesPlus: number;
    votesMinus: number;
    bookmarks: number;
  };
} {
  const id = String(ref?.id ?? "");
  const tags = Array.isArray(ref?.tags)
    ? ref.tags.map((t: Ref) =>
      stripHtml(String(t?.titleHtml ?? t?.title ?? ""))
    )
      .filter((s: string) => s.length > 0)
    : [];
  const hubs = Array.isArray(ref?.hubs)
    ? ref.hubs.map((h: Ref) => String(h?.alias ?? "")).filter((s: string) =>
      s.length > 0
    )
    : [];
  const st = ref?.statistics ?? {};
  // The server-supplied lang lands in the URL path, so it must pass the same
  // shape check as the configured one; otherwise fall back to the caller's.
  const refLang = typeof ref?.lang === "string" &&
      /^[A-Za-z]{2,8}$/.test(ref.lang)
    ? ref.lang.toLowerCase()
    : l;
  return {
    id,
    title: stripHtml(String(ref?.titleHtml ?? "")),
    url: articleUrl(id, baseUrl, refLang),
    lang: refLang,
    timePublished: ref?.timePublished ? String(ref.timePublished) : null,
    readingTime: typeof ref?.readingTime === "number" &&
        Number.isFinite(ref.readingTime)
      ? ref.readingTime
      : null,
    complexity: ref?.complexity ? String(ref.complexity) : null,
    postType: ref?.postType ? String(ref.postType) : null,
    tags,
    hubs,
    author: ref?.author?.alias ? String(ref.author.alias) : null,
    statistics: {
      reads: count(st?.readingCount),
      comments: count(st?.commentsCount),
      score: count(st?.score),
      votesPlus: count(st?.votesCountPlus),
      votesMinus: count(st?.votesCountMinus),
      bookmarks: count(st?.favoritesCount),
    },
  };
}

// --- resource schemas -------------------------------------------------------

const StatisticsSchema = z.object({
  reads: z.number(),
  comments: z.number(),
  score: z.number(),
  votesPlus: z.number(),
  votesMinus: z.number(),
  bookmarks: z.number(),
});

const SummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  lang: z.string(),
  timePublished: z.string().nullable(),
  readingTime: z.number().nullable(),
  complexity: z.string().nullable(),
  postType: z.string().nullable(),
  tags: z.array(z.string()),
  hubs: z.array(z.string()),
  author: z.string().nullable(),
  statistics: StatisticsSchema,
});

const ArticlesSchema = z.object({
  user: z.string(),
  total: z.number(),
  pagesCount: z.number(),
  pagesFetched: z.number(),
  articles: z.array(SummarySchema),
  timestamp: z.string(),
});

const ArticleSchema = SummarySchema.extend({
  textHtml: z.string(),
  text: z.string(),
  timestamp: z.string(),
});

// --- model ------------------------------------------------------------------

/**
 * The `@magistr/habr` swamp model: `list-articles` (fan-out over a user's
 * feed), `get-article` and `get-articles` (full bodies by numeric id).
 */
export const model = {
  type: "@magistr/habr",
  version: "2026.10.15.5",
  upgrades: [
    {
      fromVersion: "2026.09.09.1",
      toVersion: "2026.09.09.2",
      description:
        "Add get-articles fan-out + article.text (block-aware plain text); " +
        "global attributes unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.1",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.2",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.3",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.4",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.5",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    articles: {
      description:
        "A Habr user's publications (all pages of their feed), newest first",
      schema: ArticlesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    article: {
      description: "A single Habr article with its full HTML body",
      schema: ArticleSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    "list-articles": {
      description:
        "List all publications by a Habr user (by alias, e.g. 'Milfgard'). " +
        "Fans out over every page of the user's feed internally and writes " +
        "one `articles` resource with the parsed summaries, newest first.",
      arguments: z.object({
        user: z
          .string()
          .describe("Habr user alias, e.g. 'Milfgard' (not the display name)."),
        maxPages: z
          .number()
          .optional()
          .describe(
            "Cap on how many feed pages to fetch (default: all pages). Each " +
              "page holds up to ~20 articles.",
          ),
      }),
      execute: async (
        args: { user: string; maxPages?: number },
        context: Ctx,
      ) => {
        const user = sanitizeAlias(args.user);
        const b = base(context);
        const l = lang(context);
        const first = await fetchJson(
          `${b}/kek/v2/articles/?user=${
            encodeURIComponent(user)
          }&fl=${l}&hl=${l}&page=1`,
          context,
        ) as Ref;
        const pagesCount = normalizePagesCount(first?.pagesCount);
        const maxPages = Math.floor(Number(args.maxPages ?? 0));
        const cap = Number.isFinite(maxPages) && maxPages > 0
          ? Math.min(maxPages, pagesCount)
          : pagesCount;

        const collect = (payload: Ref): ReturnType<typeof parseSummary>[] => {
          const ids: string[] = Array.isArray(payload?.publicationIds)
            ? payload.publicationIds.map((x: unknown) => String(x))
            : [];
          const refs = payload?.publicationRefs ?? {};
          return ids
            .map((id) => refs[id])
            .filter((r: Ref) => r != null)
            .map((r: Ref) => parseSummary(r, b, l));
        };

        const articles: ReturnType<typeof parseSummary>[] = collect(first);
        for (let page = 2; page <= cap; page++) {
          const payload = await fetchJson(
            `${b}/kek/v2/articles/?user=${
              encodeURIComponent(user)
            }&fl=${l}&hl=${l}&page=${page}`,
            context,
          ) as Ref;
          articles.push(...collect(payload));
        }

        const handle = await context.writeResource("articles", user, {
          user,
          total: articles.length,
          pagesCount,
          pagesFetched: cap,
          articles,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "get-article": {
      description:
        "Fetch a single Habr article by its numeric publication id, including " +
        "its full HTML body (textHtml), plain text, tags, hubs, and statistics.",
      arguments: z.object({
        id: z
          .string()
          .describe("Numeric Habr publication id, e.g. '845266'."),
      }),
      execute: async (args: { id: string }, context: Ctx) => {
        const id = assertNumericId(args.id);
        const handle = await fetchArticle(id, context);
        return { dataHandles: [handle] };
      },
    },

    "get-articles": {
      description:
        "Fetch several Habr articles by their numeric ids in a single run " +
        "(fan-out: one model-lock acquisition, one `article` resource written " +
        "per id). Prefer this over looping get-article when pulling many " +
        "bodies at once.",
      arguments: z.object({
        ids: z
          .array(z.string())
          .describe("Numeric Habr publication ids, e.g. ['845266','828834']."),
      }),
      execute: async (args: { ids: string[] }, context: Ctx) => {
        const ids = (args.ids ?? []).map((id) => assertNumericId(id));
        const dataHandles: unknown[] = [];
        for (const id of ids) {
          dataHandles.push(await fetchArticle(id, context));
        }
        return { dataHandles };
      },
    },
  },
};

/** Fetch one article by id and write it as an `article` resource. */
async function fetchArticle(id: string, context: Ctx) {
  const b = base(context);
  const l = lang(context);
  const ref = await fetchJson(
    `${b}/kek/v2/articles/${id}/?fl=${l}&hl=${l}`,
    context,
  ) as Ref;
  const summary = parseSummary(ref, b, l);
  const textHtml = String(ref?.textHtml ?? "");
  return await context.writeResource("article", id, {
    ...summary,
    textHtml,
    text: htmlToText(textHtml),
    timestamp: new Date().toISOString(),
  });
}
