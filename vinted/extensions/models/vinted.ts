import { z } from "npm:zod@4";

// =============================================================================
// @magistr/vinted
// Search Vinted and read listings without an account. Vinted's web app embeds
// its data in the page: catalog results live in the Next.js RSC payload
// (`self.__next_f.push([1,"..."])` chunks → `"items":[...]`), and item pages
// carry `"photos":[...]`, a `"plugins":[...]` array (summary, attributes,
// description, seller) plus a schema.org `ld+json` Product with the price.
// A session cookie from the homepage is enough; no API token.
// =============================================================================

const GlobalArgsSchema = z.object({
  domain: z.string().regex(/^www\.vinted\.[a-z.]{2,6}$/).default(
    "www.vinted.nl",
  ).describe("Vinted country site, e.g. www.vinted.nl, www.vinted.fr"),
  userAgent: z.string().min(10).max(500).optional().describe(
    "User-Agent to send. Must match the browser a cookieFile came from (Cloudflare binds cf_clearance to UA + IP)",
  ),
  cookieFile: z.string().regex(/^\//).optional().describe(
    "Absolute path to a file holding your browser's Cookie header for the Vinted site (incl. cf_clearance); re-read on every request",
  ),
  requestDelayMs: z.number().int().min(0).default(1500).describe(
    "Politeness delay between page requests",
  ),
});

// ---------- Schemas ------------------------------------------------------------

const MoneySchema = z.object({ amount: z.number(), currency: z.string() });

const ListingSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  price: MoneySchema,
  totalPrice: MoneySchema.nullable().describe("Incl. buyer protection fee"),
  brand: z.string().nullable(),
  size: z.string().nullable(),
  condition: z.string().nullable(),
  favouriteCount: z.number(),
  photo: z.string().nullable(),
  sellerId: z.string().nullable(),
  isBusiness: z.boolean(),
  isNew: z.boolean().describe("Not present in this search's previous run"),
});

const SearchSchema = z.object({
  name: z.string(),
  query: z.string(),
  url: z.string(),
  totalEntries: z.number().nullable(),
  pagesFetched: z.number(),
  itemCount: z.number(),
  newCount: z.number(),
  items: z.array(ListingSchema),
  timestamp: z.string(),
});

const MeasurementsSchema = z.object({
  shouldersCm: z.number().optional(),
  chestCm: z.number().optional().describe(
    "Full chest circumference (flat pit-to-pit values are doubled)",
  ),
  chestFlatCm: z.number().optional().describe("Pit-to-pit as stated"),
  lengthCm: z.number().optional(),
  sleeveCm: z.number().optional(),
  waistCm: z.number().optional(),
  hipsCm: z.number().optional(),
  inseamCm: z.number().optional(),
  riseCm: z.number().optional(),
});

const ItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().describe(
    "Seller text; UNTRUSTED — escape before rendering",
  ),
  price: MoneySchema.nullable(),
  availability: z.string().nullable(),
  canBuy: z.boolean().nullable(),
  isReserved: z.boolean().nullable(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  size: z.string().nullable(),
  condition: z.string().nullable(),
  material: z.string().nullable(),
  color: z.string().nullable(),
  uploaded: z.string().nullable(),
  seller: z.object({
    name: z.string().nullable(),
    feedbackCount: z.number().nullable(),
    reputation: z.number().nullable(),
  }),
  photos: z.array(z.string()),
  measurements: MeasurementsSchema,
  fetchedAt: z.string(),
});

/** One search result card. */
export type Listing = z.infer<typeof ListingSchema>;
/** Garment measurements parsed from a description. */
export type Measurements = z.infer<typeof MeasurementsSchema>;
/** A full listing. */
export type Item = z.infer<typeof ItemSchema>;

// ---------- RSC / HTML parsing (pure) -------------------------------------------

/** Concatenate the decoded strings of every `self.__next_f.push([1,"..."])`. */
export function decodeRsc(html: string): string {
  let out = "";
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of html.matchAll(re)) {
    try {
      out += JSON.parse(m[1]) as string;
    } catch { /* skip malformed chunk */ }
  }
  return out;
}

/**
 * Find `key` (which must end with `[` or `{`) in `text` and JSON-parse the
 * balanced value that follows. Returns null when absent or unbalanced.
 */
export function grabJson(text: string, key: string): unknown {
  const i = text.indexOf(key);
  if (i < 0) return null;
  const start = i + key.length - 1;
  let depth = 0;
  let inStr = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v && typeof v === "object" ? v as Rec : {} as Rec;
// RSC placeholders ("$undefined", "$f7", "$L1e") are references, not values.
const str = (v: unknown): string | null =>
  typeof v === "string" && !/^\$[A-Za-z0-9@]{1,12}$/.test(v) ? v : null;

function money(v: unknown): z.infer<typeof MoneySchema> | null {
  const m = rec(v);
  const amount = Number(m.amount);
  return Number.isFinite(amount) && typeof m.currencyCode === "string"
    ? { amount, currency: m.currencyCode }
    : null;
}

/** Parse catalog search results out of a catalog page. */
export function parseCatalog(
  html: string,
  domain: string,
): { items: Omit<Listing, "isNew">[]; totalEntries: number | null } {
  const rsc = decodeRsc(html);
  const raw = grabJson(rsc, '"items":[');
  if (!Array.isArray(raw)) {
    throw new Error(
      "No catalog items in page (layout change or anti-bot page)",
    );
  }
  const items: Omit<Listing, "isNew">[] = [];
  for (const entry of raw) {
    const p = rec(rec(entry).productItem);
    const id = p.id != null ? String(p.id) : null;
    const price = money(p.priceWithDiscount) ?? money(p.price);
    if (!id || !price) continue;
    const box = rec(p.itemBox);
    // secondLine is "<size> · <condition>"; either part may be missing.
    const parts = (str(box.secondLine) ?? "").split(" · ").map((s) => s.trim())
      .filter(Boolean);
    const user = rec(p.user);
    items.push({
      id,
      title: str(p.title) ?? "",
      url: `https://${domain}${str(p.url) ?? `/items/${id}`}`,
      price,
      totalPrice: money(p.totalItemPrice),
      brand: str(box.firstLine),
      size: parts.length > 1 ? parts[0] : null,
      condition: parts.length > 1 ? parts[1] : parts[0] ?? null,
      favouriteCount: Number(p.favouriteCount) || 0,
      photo: str(p.thumbnailUrl),
      sellerId: user.id != null ? String(user.id) : null,
      isBusiness: user.isBusiness === true,
    });
  }
  const total = rsc.match(/"total_entries":(\d+)/);
  return { items, totalEntries: total ? Number(total[1]) : null };
}

const MEASURE_KEYS: [keyof Measurements, RegExp][] = [
  ["shouldersCm", /carrure|[ée]paules?|shoulders?|schouders?|schulter|spalle/],
  [
    "chestFlatCm",
    /aisselle|pit|ok[s]?el|achsel|ascella|largeur\s+poitrine|half\s*chest/,
  ],
  ["chestCm", /poitrine|chest|bust|borst|brust|petto|torace/],
  ["sleeveCm", /manches?|bras|sleeves?|mouw(en)?|[äa]rmel|manica|\barm\b/],
  ["inseamCm", /entre-?jambes?|inseam|binnenbeen|innenbein|cavallo interno/],
  ["riseCm", /montant|fourche|\brise\b|kruis|leibh[öo]he|cavallo/],
  [
    "waistCm",
    /tour\s+de\s+taille|waist|taillewijdte|bundweite|girovita|\bvita\b|\btaille\b(?=[^\d]*\d+(?:[.,]\d)?\s*cm)/,
  ],
  ["hipsCm", /hanches?|hips?|heupen?|h[üu]fte|fianchi|bassin/],
  [
    "lengthCm",
    /longueur|length|lengte|l[äa]nge|lunghezza|long\b|hauteur|du col jusqu|ruglengte|r[üu]ckenl/,
  ],
];

// A measurement taken across a garment laid flat ("largeur", "width", "à
// plat"): girths in such a clause are doubled.
const FLAT = /largeur|width|breedte|breite|larghezza|flat|[àa] plat|\bplat\b/;
const GIRTHS = new Set<keyof Measurements>(["chestCm", "waistCm", "hipsCm"]);
// Number-first phrasing: "63cm de large", "130 cm long".
const NUMBER_FIRST: [keyof Measurements, RegExp][] = [
  [
    "chestFlatCm",
    /(\d{2,3}(?:[.,]\d)?)\s*cm\s+(?:de\s+|of\s+)?(?:large|wide|breed|breit)/,
  ],
  [
    "lengthCm",
    /(\d{2,3}(?:[.,]\d)?)\s*cm\s+(?:de\s+|of\s+)?(?:long|length|lang)\b/,
  ],
];

/**
 * Pull garment measurements out of free-text descriptions in FR/EN/NL/DE/IT.
 * Each line (or clause) is matched to the first keyword family it contains,
 * then the first number followed by "cm" (or bare number) is taken. Chest
 * values below 75 cm are treated as flat pit-to-pit and doubled.
 */
export function parseMeasurements(text: string): Measurements {
  const out: Measurements = {};
  const clauses = text.toLowerCase().split(
    /[\n;•|/]+|\s[-–—]\s|,(?!\d)|\.\s/,
  );
  clauses: for (const clause of clauses) {
    for (const [key, re] of NUMBER_FIRST) {
      const m = clause.match(re);
      if (m) {
        out[key] ??= Number(m[1].replace(",", "."));
        continue clauses;
      }
    }
    const num = clause.match(/(\d{2,3}(?:[.,]\d)?)\s*(cm)?/);
    if (!num) continue;
    let value = Number(num[1].replace(",", "."));
    if (!(value >= 10 && value <= 250)) continue;
    for (const [key, re] of MEASURE_KEYS) {
      if (!re.test(clause)) continue;
      if (GIRTHS.has(key) && key !== "chestCm" && FLAT.test(clause)) {
        value *= 2;
      }
      if (out[key] === undefined) out[key] = value;
      break;
    }
  }
  if (out.chestCm !== undefined && out.chestCm < 75) {
    out.chestFlatCm ??= out.chestCm;
    out.chestCm = out.chestCm * 2;
  } else if (out.chestCm === undefined && out.chestFlatCm !== undefined) {
    out.chestCm = out.chestFlatCm * 2;
  }
  // No adult waist/hip girth is this small: the seller measured it flat.
  if (out.waistCm !== undefined && out.waistCm < 60) out.waistCm *= 2;
  if (out.hipsCm !== undefined && out.hipsCm < 70) out.hipsCm *= 2;
  return out;
}

/** Parse a Vinted item page. */
export function parseItem(
  html: string,
  id: string,
  domain: string,
): Omit<Item, "fetchedAt"> {
  const ldRaw = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  let ld: Rec = {};
  if (ldRaw) {
    try {
      ld = rec(JSON.parse(ldRaw[1]));
    } catch { /* ignore */ }
  }
  const rsc = decodeRsc(html);
  const plugins = grabJson(rsc, '"plugins":[');
  if (!Array.isArray(plugins) && ld["@type"] !== "Product") {
    throw new Error(`No item data in page for ${id} (removed or anti-bot)`);
  }
  const byName = new Map<string, Rec>();
  for (const p of Array.isArray(plugins) ? plugins : []) {
    const r = rec(p);
    if (typeof r.name === "string") byName.set(r.name, rec(r.data));
  }
  const attrs = new Map<string, string>();
  const attrList = byName.get("attributes")?.attributes;
  for (const a of Array.isArray(attrList) ? attrList : []) {
    const r = rec(a);
    const v = str(rec(r.data).value);
    if (typeof r.code === "string" && v) attrs.set(r.code, v);
  }
  const summaryTitle = (() => {
    const lines = byName.get("summary")?.lines;
    if (!Array.isArray(lines)) return null;
    const els = rec(lines[0]).elements;
    return Array.isArray(els) ? str(rec(els[0]).value) : null;
  })();
  const description = str(byName.get("description")?.description) ??
    str(ld.description) ?? "";
  const offers = rec(ld.offers);
  const priceNum = Number(offers.price);
  const seller = byName.get("user_info_header") ?? {};
  const photosRaw = grabJson(rsc, '"photos":[');
  const photos = (Array.isArray(photosRaw) ? photosRaw : [])
    .map((p) => str(rec(p).url) ?? str(rec(p).full_size_url))
    .filter((u): u is string => !!u);
  if (photos.length === 0 && typeof ld.image === "string") {
    photos.push(ld.image);
  }
  const flag = (k: string) => {
    const m = rsc.match(new RegExp(`"${k}":(true|false)`));
    return m ? m[1] === "true" : null;
  };
  return {
    id,
    url: str(offers.url) ?? `https://${domain}/items/${id}`,
    title: summaryTitle ?? str(ld.name) ?? "",
    description,
    price: Number.isFinite(priceNum) && typeof offers.priceCurrency === "string"
      ? { amount: priceNum, currency: offers.priceCurrency }
      : null,
    availability: str(offers.availability),
    canBuy: flag("can_buy"),
    isReserved: flag("is_reserved"),
    category: str(ld.category),
    brand: attrs.get("brand") ?? str(rec(ld.brand).name),
    size: attrs.get("size") ?? null,
    condition: attrs.get("status") ?? null,
    material: attrs.get("material") ?? null,
    color: attrs.get("color") ?? str(ld.color),
    uploaded: attrs.get("upload_date") ?? null,
    seller: {
      name: str(seller.name),
      feedbackCount: typeof seller.feedback_count === "number"
        ? seller.feedback_count
        : null,
      reputation: typeof seller.feedback_reputation === "number"
        ? seller.feedback_reputation
        : null,
    },
    photos: [...new Set(photos)],
    measurements: parseMeasurements(description),
  };
}

/** Extract a numeric item id from an id or a Vinted item URL. */
export function itemIdOf(ref: string): string {
  const m = ref.trim().match(/^(\d{5,15})$|\/items\/(\d{5,15})/);
  if (!m) throw new Error(`Not a Vinted item id or URL: ${ref}`);
  return m[1] ?? m[2];
}

const ORDERS = [
  "relevance",
  "newest_first",
  "price_low_to_high",
  "price_high_to_low",
] as const;

/** Build a catalog URL from search arguments. */
export function catalogUrl(
  domain: string,
  a: {
    query: string;
    order: (typeof ORDERS)[number];
    priceFrom?: number;
    priceTo?: number;
    catalogIds: number[];
    brandIds: number[];
    sizeIds: number[];
    statusIds: number[];
    colorIds?: number[];
  },
  page: number,
): string {
  const p = new URLSearchParams();
  p.set("search_text", a.query);
  p.set("order", a.order);
  if (a.priceFrom != null) p.set("price_from", String(a.priceFrom));
  if (a.priceTo != null) p.set("price_to", String(a.priceTo));
  for (const id of a.catalogIds) p.append("catalog[]", String(id));
  for (const id of a.brandIds) p.append("brand_ids[]", String(id));
  for (const id of a.sizeIds) p.append("size_ids[]", String(id));
  for (const id of a.statusIds) p.append("status_ids[]", String(id));
  for (const id of a.colorIds ?? []) p.append("color_ids[]", String(id));
  if (page > 1) p.set("page", String(page));
  return `https://${domain}/catalog?${p}`;
}

/** Slug for a saved-search resource name. */
export function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 60) || "search";
}

// ---------- IO (injectable for tests) ------------------------------------------

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

/**
 * Backoff for HTTP 429: honour Retry-After (seconds) when present, else
 * exponential 10s, 20s, 40s, 80s. Capped at 120s.
 */
export function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
): number {
  const secs = Number(retryAfter);
  const ms = Number.isFinite(secs) && secs > 0
    ? secs * 1000
    : 10_000 * 2 ** attempt;
  return Math.min(ms, 120_000);
}

/**
 * Parse a browser Cookie header ("a=1; b=2", optionally prefixed "Cookie:",
 * or one cookie per line) into a map. Values keep any '=' they contain.
 */
export function parseCookieHeader(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = text.trim().replace(/^cookie:\s*/i, "");
  for (const part of body.split(/;|\n/)) {
    const kv = part.trim();
    const eq = kv.indexOf("=");
    if (eq > 0) out.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
  return out;
}

function absorbSetCookie(res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const eq = kv.indexOf("=");
    if (eq > 0) deps.cookies.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
}

/** A cookie file that does not exist yet reads as empty. */
async function readOptional(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
}

/** HTTP session with a cookie jar; tests replace `deps.fetchPage`.
 * Exported via `export { deps }` (not `export const`) so the upgrade-chain
 * gate does not mistake this plain object for a model declaration. */
const deps = {
  cookies: new Map<string, string>(),
  session: { userAgent: UA, cookieFile: undefined as string | undefined },
  /** Point the session at the instance's UA / cookie file. */
  configure: (g: { userAgent?: string; cookieFile?: string }): void => {
    deps.session = { userAgent: g.userAgent ?? UA, cookieFile: g.cookieFile };
  },
  fetchPage: async (url: string): Promise<string> => {
    const origin = new URL(url).origin;
    const { userAgent, cookieFile } = deps.session;
    const fileCookies = cookieFile
      ? parseCookieHeader(await readOptional(cookieFile))
      : new Map<string, string>();
    const header = () =>
      [...new Map([...deps.cookies, ...fileCookies])]
        .map(([k, v]) => `${k}=${v}`).join("; ");
    if (deps.cookies.size === 0 && fileCookies.size === 0) {
      const home = await fetch(origin + "/", {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(30_000),
      });
      await home.body?.cancel();
      absorbSetCookie(home);
    }
    for (let attempt = 0;; attempt++) {
      const res = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
          "Cookie": header(),
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      absorbSetCookie(res);
      if (res.ok) return await res.text();
      await res.body?.cancel();
      if (
        res.status === 403 && res.headers.get("cf-mitigated") === "challenge"
      ) {
        throw new Error(
          `GET ${url} -> HTTP 403 Cloudflare challenge: open ${origin} in your browser, copy its Cookie request header into ${
            cookieFile ?? "a file set as the cookieFile global argument"
          }, and set userAgent to that browser's User-Agent`,
        );
      }
      if (res.status === 403 || res.status === 401) deps.cookies.clear();
      if (res.status === 429 && attempt < deps.maxRetries) {
        await deps.sleep(retryDelayMs(res.headers.get("retry-after"), attempt));
        continue;
      }
      throw new Error(`GET ${url} -> HTTP ${res.status}`);
    }
  },
  maxRetries: 4,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};
export { deps };

type Ctx = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  definition: { name: string };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
  definitionRepository: {
    findByNameGlobal: (
      name: string,
    ) => Promise<{ type: string; definition: { id: string } } | null>;
  };
  dataRepository: {
    getContent: (
      type: string,
      id: string,
      name: string,
    ) => Promise<Uint8Array | null>;
  };
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
};

async function readOwn<T>(ctx: Ctx, dataName: string): Promise<T | null> {
  const ref = await ctx.definitionRepository.findByNameGlobal(
    ctx.definition.name,
  );
  if (!ref) return null;
  const bytes = await ctx.dataRepository.getContent(
    ref.type,
    ref.definition.id,
    dataName,
  );
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) as T : null;
}

// ---------- Model ----------------------------------------------------------------

/** @magistr/vinted model type: catalog search and listing details. */
export const model = {
  type: "@magistr/vinted",
  version: "2026.10.15.6",
  upgrades: [
    {
      toVersion: "2026.10.09.2",
      description:
        "item: 429 backoff, tolerant runs, skip existing; search: colorIds",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.09.3",
      description:
        "Measurement parser fixes, 403 circuit breaker, offline reparse method",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.09.4",
      description: "Optional userAgent + cookieFile to pass Cloudflare",
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
    {
      toVersion: "2026.10.15.6",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    search: {
      description:
        "A saved search's latest results (instance name search-<name>); isNew marks items absent from the previous run.",
      schema: SearchSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    item: {
      description:
        "One listing's full details with parsed measurements (instance name item-<id>).",
      schema: ItemSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    itemRun: {
      description:
        "Outcome of the last `item` run: fetched, skipped (already present) and failed ids.",
      schema: z.object({
        fetched: z.array(z.string()),
        skipped: z.array(z.string()),
        failed: z.array(z.object({ id: z.string(), error: z.string() })),
        notAttempted: z.array(z.string()).describe(
          "Ids left after an anti-bot block (3 consecutive 403s)",
        ),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    search: {
      description:
        "Search the catalog (text + price/brand/size/condition/category filters), up to `pages` pages; writes search-<name> and flags new items vs the previous run.",
      arguments: z.object({
        query: z.string().min(1).max(200),
        name: z.string().max(60).optional().describe(
          "Saved-search name (default: slug of query)",
        ),
        order: z.enum(ORDERS).default("newest_first"),
        priceFrom: z.number().min(0).optional(),
        priceTo: z.number().min(0).optional(),
        catalogIds: z.array(z.number().int()).default([]).describe(
          "Vinted catalog ids (e.g. from a /catalog/<id>-... URL)",
        ),
        brandIds: z.array(z.number().int()).default([]),
        sizeIds: z.array(z.number().int()).default([]),
        statusIds: z.array(z.number().int()).default([]).describe(
          "Condition: 6 new with tags, 1 new, 2 very good, 3 good, 4 satisfactory",
        ),
        colorIds: z.array(z.number().int()).default([]).describe(
          "Colour ids, e.g. 1 black, 2 brown, 3 grey, 4 beige, 16 khaki, 27 navy",
        ),
        pages: z.number().int().min(1).max(10).default(1),
        mustMatch: z.string().max(200).optional().describe(
          "Case-insensitive regex the title must match (drops noise)",
        ),
      }),
      execute: async (args, context) => {
        const ctx = context as unknown as Ctx;
        const { domain, requestDelayMs } = ctx.globalArgs;
        deps.configure(ctx.globalArgs);
        const name = slug(args.name ?? args.query);
        const filter = args.mustMatch ? new RegExp(args.mustMatch, "i") : null;
        const prior = await readOwn<z.infer<typeof SearchSchema>>(
          ctx,
          `search-${name}`,
        ).catch(() => null);
        const seen = new Set((prior?.items ?? []).map((i) => i.id));
        const firstRun = prior === null;
        const byId = new Map<string, Listing>();
        let totalEntries: number | null = null;
        let pages = 0;
        for (let page = 1; page <= args.pages; page++) {
          if (page > 1) await deps.sleep(requestDelayMs);
          const res = parseCatalog(
            await deps.fetchPage(catalogUrl(domain, args, page)),
            domain,
          );
          pages++;
          totalEntries ??= res.totalEntries;
          for (const it of res.items) {
            if (filter && !filter.test(it.title)) continue;
            if (!byId.has(it.id)) {
              byId.set(it.id, { ...it, isNew: !firstRun && !seen.has(it.id) });
            }
          }
          if (res.items.length === 0) break;
        }
        const items = [...byId.values()];
        const newCount = items.filter((i) => i.isNew).length;
        ctx.logger.info("Search {name}: {n} items, {new} new", {
          name,
          n: items.length,
          new: newCount,
        });
        const handle = await ctx.writeResource("search", `search-${name}`, {
          name,
          query: args.query,
          url: catalogUrl(domain, args, 1),
          totalEntries,
          pagesFetched: pages,
          itemCount: items.length,
          newCount,
          items,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    item: {
      description:
        "Fetch full listings (ids or item URLs): description, price, size, condition, material, seller, photos, and measurements parsed from the description.",
      arguments: z.object({
        refs: z.array(z.string().max(500)).min(1).max(200).describe(
          "Item ids or https://www.vinted.*/items/<id>-... URLs",
        ),
        refresh: z.boolean().default(false).describe(
          "Re-fetch items already stored (default: skip them)",
        ),
      }),
      execute: async (args, context) => {
        const ctx = context as unknown as Ctx;
        const { domain, requestDelayMs } = ctx.globalArgs;
        deps.configure(ctx.globalArgs);
        const ids: string[] = [...new Set<string>(args.refs.map(itemIdOf))];
        const handles: unknown[] = [];
        const fetched: string[] = [];
        const skipped: string[] = [];
        const failed: { id: string; error: string }[] = [];
        const blocked: string[] = [];
        let consecutive403 = 0;
        for (const id of ids) {
          if (!args.refresh) {
            const have = await readOwn<Item>(ctx, `item-${id}`).catch(() =>
              null
            );
            if (have) {
              skipped.push(id);
              continue;
            }
          }
          if (fetched.length + failed.length > 0) {
            await deps.sleep(requestDelayMs);
          }
          try {
            const html = await deps.fetchPage(
              `https://${domain}/items/${id}`,
            );
            const item: Item = {
              ...parseItem(html, id, domain),
              fetchedAt: new Date().toISOString(),
            };
            handles.push(
              await ctx.writeResource("item", `item-${id}`, item),
            );
            fetched.push(id);
            consecutive403 = 0;
          } catch (e) {
            failed.push({ id, error: String(e).slice(0, 300) });
            // Anti-bot block: after 3 consecutive 403s stop instead of
            // hammering; the rest are reported as not attempted.
            consecutive403 = String(e).includes("HTTP 403")
              ? consecutive403 + 1
              : 0;
            if (consecutive403 >= 3) {
              const lastOk = fetched.length;
              const done = new Set([
                ...fetched,
                ...skipped,
                ...failed.map((f) => f.id),
              ]);
              blocked.push(...ids.filter((x) => !done.has(x)));
              ctx.logger.info("Blocked by Vinted (403); stopping after {n}", {
                n: lastOk,
              });
              break;
            }
          }
        }
        ctx.logger.info("Items: {f} fetched, {s} skipped, {x} failed", {
          f: fetched.length,
          s: skipped.length,
          x: failed.length,
        });
        handles.push(
          await ctx.writeResource("itemRun", "item-run", {
            fetched,
            skipped,
            failed,
            notAttempted: blocked,
            timestamp: new Date().toISOString(),
          }),
        );
        if (failed.length > 0 && fetched.length + skipped.length === 0) {
          throw new Error(`All item fetches failed: ${failed[0].error}`);
        }
        return { dataHandles: handles };
      },
    },

    reparse: {
      description:
        "Re-derive measurements for stored items from their stored descriptions (no network). Use after parser upgrades or while Vinted is rate-limiting.",
      arguments: z.object({
        refs: z.array(z.string().max(500)).min(1).max(500),
      }),
      execute: async (args, context) => {
        const ctx = context as unknown as Ctx;
        const handles: unknown[] = [];
        let changed = 0;
        for (const id of new Set<string>(args.refs.map(itemIdOf))) {
          const item = await readOwn<Item>(ctx, `item-${id}`).catch(() => null);
          if (!item) continue;
          const measurements = parseMeasurements(item.description);
          if (
            JSON.stringify(measurements) === JSON.stringify(item.measurements)
          ) {
            continue;
          }
          changed++;
          handles.push(
            await ctx.writeResource("item", `item-${id}`, {
              ...item,
              measurements,
            }),
          );
        }
        ctx.logger.info("Reparsed: {n} items changed", { n: changed });
        return { dataHandles: handles };
      },
    },
  },
};
