import { z } from "npm:zod@4";
import { DOMParser } from "npm:linkedom@0.16.11";

// ---------------------------------------------------------------------------
// @magistr/fragrantica
//
// Search perfumes, list them by designer/house or by note, fetch full perfume
// details (accords, notes pyramid, rating, perfumers), and read the "People who
// like this also like" similar-perfumes list — all from the public Fragrantica
// pages, no credentials required.
//
// Fragrantica's own on-site search box is served behind a Cloudflare Turnstile
// challenge and a referer-locked Algolia key, so it is not reachable from a
// plain HTTP client. The `search` method therefore resolves a free-text query
// to Fragrantica perfume URLs through a web search engine (DuckDuckGo HTML),
// then every other method reads the perfume/designer/note pages directly.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = "https://www.fragrantica.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const GlobalArgsSchema = z.object({
  baseUrl: z
    .string()
    .optional()
    .describe(
      "Fragrantica base URL (default https://www.fragrantica.com). Override for a locale domain.",
    ),
  userAgent: z
    .string()
    .optional()
    .describe("Override the HTTP User-Agent used for requests."),
});

// --- HTML helpers ----------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Doc = any;

function parse(html: string): Doc {
  return new DOMParser().parseFromString(html, "text/html");
}

async function fetchPage(
  url: string,
  context: { globalArgs?: { userAgent?: string } },
): Promise<string> {
  const ua = context.globalArgs?.userAgent || DEFAULT_UA;
  const response = await fetch(url, {
    headers: {
      "User-Agent": ua,
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const challenged =
      /cloudflare|cf-chl|turnstile|attention required|just a moment/i.test(
        body,
      );
    throw new Error(
      `Fetch failed (${response.status}) for ${url}` +
        (challenged
          ? " — Fragrantica returned a Cloudflare challenge (rate-limited/blocked). Retry later or slow down."
          : ""),
    );
  }
  return response.text();
}

function absUrl(href: string, base: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("/")) return base.replace(/\/$/, "") + href;
  return base.replace(/\/$/, "") + "/" + href;
}

function perfumeIdFromUrl(url: string): number | undefined {
  const m = url.match(/-(\d+)\.html/);
  return m ? Number(m[1]) : undefined;
}

function slugToText(slug: string): string {
  return decodeURIComponent(slug).replace(/-/g, " ").replace(/\s+/g, " ")
    .trim();
}

const PERFUME_HREF = /\/perfume\/([^/]+)\/(.+?)-(\d+)\.html/;

/** Build a lightweight perfume reference from a /perfume/<Brand>/<Name>-<id>.html URL. */
export function refFromPerfumeUrl(
  href: string,
  base: string,
): {
  name: string;
  brand?: string;
  url: string;
  id?: number;
  thumbnail?: string;
} {
  const url = absUrl(href, base);
  const m = url.match(PERFUME_HREF);
  const brand = m ? slugToText(m[1]) : undefined;
  const slugName = m ? slugToText(m[2]) : undefined;
  const id = m ? Number(m[3]) : perfumeIdFromUrl(url);
  return {
    name: slugName ?? "",
    brand,
    url,
    id,
    thumbnail: id
      ? `https://fimgs.net/mdimg/perfume-thumbs/375x500.${id}.jpg`
      : undefined,
  };
}

/**
 * Prefer the perfume name from the link's own text over the URL slug when it is
 * clean. In the "also like" carousel the anchor renders as "<Brand>\n<Name>",
 * so the last line is the name (with proper diacritics). On designer/note
 * listing cards the last line is instead a stat number, and image alts use an
 * unreliable "perfume <Name> <Brand>" form — in those cases we fall back to the
 * clean URL slug name.
 */
export function preferLinkName(
  anchor: Doc,
  ref: { name: string; brand?: string },
) {
  const lines = (anchor.textContent ?? "")
    .split("\n")
    .map((s: string) => s.replace(/\s+/g, " ").trim())
    .filter((s: string) => s.length > 0);
  let candidate = lines.length > 0 ? lines[lines.length - 1] : "";
  if (/^perfume\s/i.test(candidate)) candidate = ""; // image-alt convention
  if (/^[\d.,%\s]+$/.test(candidate)) candidate = ""; // listing stat number
  if (candidate.length > 60) candidate = ""; // review snippet, not a name
  if (ref.brand && candidate.toLowerCase() === ref.brand.toLowerCase()) {
    candidate = "";
  }
  return candidate || ref.name;
}

function uniqueStrings(values: (string | null | undefined)[]): string[] {
  return [
    ...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v)),
  ];
}

/**
 * Collect deduped, valid perfume references from all matching links in a scope.
 * `preferText` uses the anchor's own text for the name (good for the "also like"
 * carousel, which renders clean accented names); listing/note/designer pages
 * embed stat numbers or review snippets in the anchor, so they keep the URL
 * slug name instead.
 */
function collectPerfumeRefs(
  scope: Doc,
  base: string,
  cap = 500,
  preferText = false,
) {
  const seen = new Set<string>();
  const refs: ReturnType<typeof refFromPerfumeUrl>[] = [];
  for (const a of scope.querySelectorAll('a[href*="/perfume/"]')) {
    const href = a.getAttribute("href") ?? "";
    if (!PERFUME_HREF.test(href)) continue;
    const url = absUrl(href, base);
    if (seen.has(url)) continue;
    seen.add(url);
    const ref = refFromPerfumeUrl(url, base);
    if (preferText) ref.name = preferLinkName(a, ref);
    refs.push(ref);
    if (refs.length >= cap) break;
  }
  return refs;
}

// --- perfume page parsing --------------------------------------------------

function classifyLevel(label: string): "top" | "middle" | "base" | "general" {
  if (/top/i.test(label)) return "top";
  if (/(middle|heart)/i.test(label)) return "middle";
  if (/base/i.test(label)) return "base";
  return "general";
}

/**
 * Parse the notes pyramid into top/middle/base (or `general` when the perfume
 * lists a single un-tiered block). Takes the `#pyramid` element (or null).
 */
export function parseNotes(pyramid: Doc) {
  const notes = {
    top: [] as string[],
    middle: [] as string[],
    base: [] as string[],
    general: [] as string[],
  };
  if (!pyramid) return notes;
  const noteTexts = (el: Doc) =>
    uniqueStrings(
      [...el.querySelectorAll('a[href*="/notes/"]')].map((a: Doc) =>
        a.textContent
      ),
    );
  const containers = [...pyramid.querySelectorAll(".pyramid-level-container")];
  const headings = [...pyramid.querySelectorAll("h3, h4, b")]
    .map((h: Doc) => h.textContent?.trim() ?? "")
    .filter((t: string) => /(top|middle|heart|base)\s*notes?/i.test(t));

  if (containers.length > 0 && headings.length === containers.length) {
    containers.forEach((c: Doc, i: number) => {
      notes[classifyLevel(headings[i])].push(...noteTexts(c));
    });
  } else if (containers.length === 1) {
    notes.general = noteTexts(containers[0]);
  } else if (containers.length > 1) {
    const order: ("top" | "middle" | "base")[] = ["top", "middle", "base"];
    containers.slice(0, 3).forEach((c: Doc, i: number) => {
      notes[order[i]].push(...noteTexts(c));
    });
  } else {
    notes.general = noteTexts(pyramid);
  }
  return notes;
}

/**
 * Parse the main accords (name + strength %) from the colored accord bars,
 * which are `div`s with an inline `width:NN%` and a `background` colour.
 */
export function parseAccords(doc: Doc) {
  const accords: { name: string; strength: number }[] = [];
  const seen = new Set<string>();
  for (const el of doc.querySelectorAll('div[style*="width"]')) {
    const style = el.getAttribute("style") ?? "";
    const text = el.textContent?.trim() ?? "";
    if (!/background/.test(style)) continue;
    const wm = style.match(/width:\s*([\d.]+)%/);
    if (!wm) continue;
    if (text.length === 0 || text.length > 40) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    accords.push({ name: text, strength: Math.round(parseFloat(wm[1])) });
    if (accords.length >= 30) break;
  }
  return accords;
}

function parseAlsoLike(doc: Doc, base: string, selfUrl: string) {
  const heads = [...doc.querySelectorAll("h1, h2, h3, h4")];
  const heading = heads.find((h: Doc) =>
    /also like|reminds/i.test(h.textContent ?? "")
  );
  if (!heading) return [];
  const container = heading.closest("div")?.parentElement ?? doc;
  return collectPerfumeRefs(container, base, 40, true).filter((r) =>
    r.url !== selfUrl
  );
}

function parsePerfume(html: string, url: string, base: string) {
  const doc = parse(html);
  const og = (prop: string) =>
    doc.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") ??
      "";

  const ref = refFromPerfumeUrl(url, base);
  const brand = doc.querySelector('[itemprop="brand"] [itemprop="name"]')
    ?.textContent?.trim() ||
    doc.querySelector('span[itemprop="name"]')?.textContent?.trim() ||
    ref.brand;

  const ogTitle = og("og:title");
  const gender = /for women and men/i.test(ogTitle)
    ? "unisex"
    : /for men/i.test(ogTitle)
    ? "men"
    : /for women/i.test(ogTitle)
    ? "women"
    : undefined;
  const yearMatch = ogTitle.match(/\b(?:19|20)\d{2}\b/g);
  const year = yearMatch ? Number(yearMatch[yearMatch.length - 1]) : undefined;

  const ratingValue = parseFloat(
    doc.querySelector('[itemprop="ratingValue"]')?.textContent?.trim() ?? "",
  );
  const ratingCount = parseInt(
    (doc.querySelector('[itemprop="ratingCount"]')?.textContent ?? "").replace(
      /[^\d]/g,
      "",
    ),
    10,
  );

  const perfumers = uniqueStrings(
    [...doc.querySelectorAll('a[href*="/noses/"]')]
      .filter((a: Doc) =>
        (a.getAttribute("href") ?? "").length > "/noses/".length
      )
      .map((a: Doc) => a.textContent),
  );

  const id = ref.id;
  return {
    url,
    id,
    name: ref.name,
    brand: brand || undefined,
    gender,
    year,
    ratingValue: Number.isFinite(ratingValue) ? ratingValue : undefined,
    ratingCount: Number.isFinite(ratingCount) && ratingCount > 0
      ? ratingCount
      : undefined,
    description: og("og:description") || undefined,
    thumbnail: id
      ? `https://fimgs.net/mdimg/perfume-thumbs/375x500.${id}.jpg`
      : (og("og:image") || undefined),
    perfumers,
    accords: parseAccords(doc),
    notes: parseNotes(doc.querySelector("#pyramid")),
    similar: parseAlsoLike(doc, base, url),
    timestamp: new Date().toISOString(),
  };
}

// --- DuckDuckGo resolver ---------------------------------------------------

/** Run a DuckDuckGo HTML search and return the de-referenced result URLs. */
async function duckDuckGo(
  query: string,
  context: { globalArgs?: { userAgent?: string } },
): Promise<string[]> {
  const ua = context.globalArgs?.userAgent || DEFAULT_UA;
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `DuckDuckGo search failed (${response.status}). It may be rate-limiting; retry shortly.`,
    );
  }
  const doc = parse(await response.text());
  const urls: string[] = [];
  for (const a of doc.querySelectorAll("a.result__a")) {
    let href = a.getAttribute("href") ?? "";
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    if (href) urls.push(href);
  }
  return urls;
}

/**
 * Resolve a note argument to a Fragrantica /notes/<Name>-<id>.html URL. Accepts
 * a full URL, an id-bearing slug (e.g. "Vetiver-4"), or a plain note name — the
 * latter (and id-less slugs, which the note pages reject) is resolved via web
 * search, since a note page is keyed by its numeric id.
 */
async function resolveNoteUrl(
  input: string,
  base: string,
  // deno-lint-ignore no-explicit-any
  context: any,
): Promise<string> {
  const v = input.trim();
  if (/^https?:\/\//i.test(v) || v.includes("/notes/")) {
    return absUrl(v.replace(/^\/+/, "/"), base);
  }
  if (/-\d+$/.test(v)) return `${base.replace(/\/$/, "")}/notes/${v}.html`;
  const hits = await duckDuckGo(`fragrantica notes ${v}`, context);
  const found = hits.find((u) => /\/notes\/[^/]+-\d+\.html/.test(u)) ??
    hits.find((u) => /\/notes\/[^/]+\.html/.test(u));
  if (!found) {
    throw new Error(
      `Could not resolve note "${v}" to a /notes/ page. Pass the exact slug (e.g. Vetiver-4) or the full URL.`,
    );
  }
  return found.split("#")[0].split("?")[0];
}

function noteKeyFromUrl(url: string, fallback: string): string {
  return (url.match(/\/notes\/([^/]+)\.html/) ?? [])[1] ?? fallback;
}

// --- resource schemas ------------------------------------------------------

const PerfumeRefSchema = z.object({
  name: z.string(),
  brand: z.string().optional(),
  url: z.string(),
  id: z.number().optional(),
  thumbnail: z.string().optional(),
});

const SearchSchema = z.object({
  query: z.string(),
  results: z.array(PerfumeRefSchema),
  total: z.number(),
  timestamp: z.string(),
});

const ListingSchema = z.object({
  source: z.string(), // "designer" | "note"
  key: z.string(),
  url: z.string(),
  results: z.array(PerfumeRefSchema),
  total: z.number(),
  timestamp: z.string(),
});

const SimilarSchema = z.object({
  perfumeUrl: z.string(),
  perfumeName: z.string(),
  results: z.array(PerfumeRefSchema),
  total: z.number(),
  timestamp: z.string(),
});

const NoteMatchSchema = z.object({
  name: z.string(),
  brand: z.string().optional(),
  url: z.string(),
  id: z.number().optional(),
  thumbnail: z.string().optional(),
  matchedNotes: z.number(),
});

const NoteIntersectionSchema = z.object({
  notes: z.array(
    z.object({ key: z.string(), url: z.string(), count: z.number() }),
  ),
  mode: z.string(), // "all" | "any"
  results: z.array(NoteMatchSchema),
  total: z.number(),
  timestamp: z.string(),
});

const PerfumeDetailSchema = z.object({
  url: z.string(),
  id: z.number().optional(),
  name: z.string(),
  brand: z.string().optional(),
  gender: z.string().optional(),
  year: z.number().optional(),
  ratingValue: z.number().optional(),
  ratingCount: z.number().optional(),
  description: z.string().optional(),
  thumbnail: z.string().optional(),
  perfumers: z.array(z.string()),
  accords: z.array(z.object({ name: z.string(), strength: z.number() })),
  notes: z.object({
    top: z.array(z.string()),
    middle: z.array(z.string()),
    base: z.array(z.string()),
    general: z.array(z.string()),
  }),
  similar: z.array(PerfumeRefSchema),
  timestamp: z.string(),
});

// --- input normalisers -----------------------------------------------------

function instanceSlug(input: string): string {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "result";
}

function normalizePerfumeUrl(input: string, base: string): string {
  const v = input.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.includes("/perfume/")) return absUrl(v.replace(/^\/+/, "/"), base);
  return absUrl("/" + v.replace(/^\/+/, ""), base);
}

// ---------------------------------------------------------------------------

/**
 * `@magistr/fragrantica` — reads the public Fragrantica perfume encyclopedia.
 *
 * Methods: `search` (name/brand → perfume refs, resolved via a web search
 * engine because Fragrantica's own search is Cloudflare/Algolia-gated),
 * `get-perfume` (full detail: brand, gender, year, rating, perfumers, accords
 * with strength %, the top/middle/base notes pyramid, and similar perfumes),
 * `similar` (just the "People who like this also like" list), `list-by-designer`
 * and `list-by-note` (enumerate a house or note page), and `find-by-notes`
 * (fan-out that intersects several note pages to hunt a note combination). No
 * credentials required.
 */
export const model = {
  type: "@magistr/fragrantica",
  version: "2026.07.15.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    search: {
      description: "Perfume search results (name → Fragrantica perfumes)",
      schema: SearchSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    listing: {
      description: "Perfumes listed by designer/house or by note",
      schema: ListingSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    similar: {
      description: "'People who like this also like' similar perfumes",
      schema: SimilarSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    perfume: {
      description:
        "Full perfume details: accords, notes pyramid, rating, perfumers, similar",
      schema: PerfumeDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    noteIntersection: {
      description:
        "Perfumes that share several notes at once (intersection of note pages)",
      schema: NoteIntersectionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    search: {
      description:
        "Search perfumes by free-text query (name and/or brand). Resolves to " +
        "Fragrantica perfume pages via a web search engine, since Fragrantica's " +
        "own search is Cloudflare/Algolia-gated.",
      arguments: z.object({
        query: z.string().describe(
          "Perfume name and/or brand, e.g. 'Creed Aventus'",
        ),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of results (default 20)"),
      }),
      execute: async (
        args: { query: string; limit?: number },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const base = context.globalArgs?.baseUrl || DEFAULT_BASE;
        const limit = args.limit ?? 20;
        const urls = await duckDuckGo(`fragrantica ${args.query}`, context);
        const seen = new Set<string>();
        const results: ReturnType<typeof refFromPerfumeUrl>[] = [];
        for (const u of urls) {
          const path = u.match(/\/perfume\/[^/]+\/.+?-\d+\.html/);
          if (!path) continue;
          // Collapse locale domains (fragrantica.es/.ru/…) onto the base domain.
          const canonical = base.replace(/\/$/, "") + path[0];
          const ref = refFromPerfumeUrl(canonical, base);
          const key = ref.id !== undefined ? `id:${ref.id}` : canonical;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(ref);
          if (results.length >= limit) break;
        }
        const handle = await context.writeResource(
          "search",
          instanceSlug(args.query),
          {
            query: args.query,
            results,
            total: results.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "get-perfume": {
      description:
        "Fetch a perfume's full details by URL: brand, gender, year, rating, " +
        "perfumers, main accords (with strength %), notes pyramid, and the " +
        "'also like' similar perfumes.",
      arguments: z.object({
        url: z
          .string()
          .describe(
            "Fragrantica perfume URL or /perfume/<Brand>/<Name>-<id>.html path",
          ),
      }),
      execute: async (
        args: { url: string },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const base = context.globalArgs?.baseUrl || DEFAULT_BASE;
        const url = normalizePerfumeUrl(args.url, base);
        const html = await fetchPage(url, context);
        const perfume = parsePerfume(html, url, base);
        const handle = await context.writeResource(
          "perfume",
          instanceSlug(url),
          perfume,
        );
        return { dataHandles: [handle] };
      },
    },

    similar: {
      description:
        "Get the 'People who like this also like' similar perfumes for a given " +
        "perfume URL (lighter than get-perfume when you only want the similar list).",
      arguments: z.object({
        url: z
          .string()
          .describe(
            "Fragrantica perfume URL or /perfume/<Brand>/<Name>-<id>.html path",
          ),
      }),
      execute: async (
        args: { url: string },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const base = context.globalArgs?.baseUrl || DEFAULT_BASE;
        const url = normalizePerfumeUrl(args.url, base);
        const html = await fetchPage(url, context);
        const doc = parse(html);
        const results = parseAlsoLike(doc, base, url);
        const name = refFromPerfumeUrl(url, base).name;
        const handle = await context.writeResource(
          "similar",
          instanceSlug(url),
          {
            perfumeUrl: url,
            perfumeName: name,
            results,
            total: results.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "list-by-designer": {
      description:
        "List all perfumes by a designer/house. Accepts a Fragrantica designer " +
        "slug (e.g. 'Dior', 'Yves-Saint-Laurent'), a full /designers/<Brand>.html " +
        "URL, or a plain house name (resolved via web search).",
      arguments: z.object({
        designer: z
          .string()
          .describe("Designer slug, /designers/ URL, or house name"),
      }),
      execute: async (
        args: { designer: string },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const base = context.globalArgs?.baseUrl || DEFAULT_BASE;
        const v = args.designer.trim();
        let url: string;
        if (/^https?:\/\//i.test(v) || v.includes("/designers/")) {
          url = absUrl(v.replace(/^\/+/, "/"), base);
        } else if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v)) {
          url = `${base.replace(/\/$/, "")}/designers/${v}.html`;
        } else {
          const hits = await duckDuckGo(`fragrantica designers ${v}`, context);
          const found = hits.find((u) => /\/designers\/[^/]+\.html/.test(u));
          if (!found) {
            throw new Error(
              `Could not resolve designer "${v}" to a /designers/ page. Pass the exact slug (e.g. Yves-Saint-Laurent) or the full URL.`,
            );
          }
          url = found.split("#")[0].split("?")[0];
        }
        const html = await fetchPage(url, context);
        const doc = parse(html);
        const results = collectPerfumeRefs(doc, base);
        const key = (url.match(/\/designers\/([^/]+)\.html/) ?? [])[1] ?? v;
        const handle = await context.writeResource(
          "listing",
          `designer-${instanceSlug(key)}`,
          {
            source: "designer",
            key,
            url,
            results,
            total: results.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "list-by-note": {
      description:
        "List perfumes featuring a note. Accepts a Fragrantica note slug " +
        "(e.g. 'Vetiver-4'), a full /notes/<Name>-<id>.html URL, or a plain " +
        "note name (resolved via web search).",
      arguments: z.object({
        note: z.string().describe("Note slug, /notes/ URL, or note name"),
      }),
      execute: async (
        args: { note: string },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const base = context.globalArgs?.baseUrl || DEFAULT_BASE;
        const url = await resolveNoteUrl(args.note, base, context);
        const html = await fetchPage(url, context);
        const doc = parse(html);
        const results = collectPerfumeRefs(doc, base);
        const key = noteKeyFromUrl(url, args.note.trim());
        const handle = await context.writeResource(
          "listing",
          `note-${instanceSlug(key)}`,
          {
            source: "note",
            key,
            url,
            results,
            total: results.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "find-by-notes": {
      description:
        "Find perfumes that share several notes at once by intersecting their " +
        "Fragrantica note-listing pages (fan-out: one call fetches every note " +
        "page). Use it to hunt a specific accord combination, e.g. notes " +
        "['Black Licorice','Agarwood (Oud)']. mode='all' (default) returns only " +
        "perfumes carrying every note; mode='any' returns the union ranked by " +
        "how many of the notes each perfume matches. Each note may be a slug " +
        "(e.g. 'Vetiver-4'), a /notes/ URL, or a plain name (web-resolved). " +
        "Note pages list the most-popular perfumes per note, so very obscure " +
        "matches can fall outside the listing.",
      arguments: z.object({
        notes: z
          .array(z.string())
          .min(1)
          .describe("Notes to combine (slugs, /notes/ URLs, or names)"),
        mode: z
          .enum(["all", "any"])
          .optional()
          .describe("all = intersection (default), any = union"),
        limit: z.number().optional().describe("Cap results (default 50)"),
      }),
      execute: async (
        args: { notes: string[]; mode?: "all" | "any"; limit?: number },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const base = context.globalArgs?.baseUrl || DEFAULT_BASE;
        const mode = args.mode ?? "all";
        const limit = args.limit ?? 50;

        // Fan out: fetch every requested note page.
        const noteMeta: { key: string; url: string; count: number }[] = [];
        // id/url -> { ref, notes matched }
        const acc = new Map<
          string,
          { ref: ReturnType<typeof refFromPerfumeUrl>; matched: number }
        >();
        for (const noteArg of args.notes) {
          const url = await resolveNoteUrl(noteArg, base, context);
          const refs = collectPerfumeRefs(
            parse(await fetchPage(url, context)),
            base,
          );
          noteMeta.push({
            key: noteKeyFromUrl(url, noteArg.trim()),
            url,
            count: refs.length,
          });
          const seenThisNote = new Set<string>();
          for (const ref of refs) {
            const key = ref.id !== undefined ? `id:${ref.id}` : ref.url;
            if (seenThisNote.has(key)) continue; // count each note once per perfume
            seenThisNote.add(key);
            const entry = acc.get(key) ?? { ref, matched: 0 };
            entry.matched += 1;
            acc.set(key, entry);
          }
        }

        const need = mode === "all" ? args.notes.length : 1;
        const results = [...acc.values()]
          .filter((e) => e.matched >= need)
          .sort((a, b) =>
            b.matched - a.matched || a.ref.name.localeCompare(b.ref.name)
          )
          .slice(0, limit)
          .map((e) => ({ ...e.ref, matchedNotes: e.matched }));

        const handle = await context.writeResource(
          "noteIntersection",
          instanceSlug(`${mode}-${noteMeta.map((n) => n.key).join("-")}`),
          {
            notes: noteMeta,
            mode,
            results,
            total: results.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
