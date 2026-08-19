import { z } from "npm:zod@4";
import { DOMParser } from "npm:linkedom@0.16.11";

const GlobalArgsSchema = z.object({
  clientId: z
    .string()
    .optional()
    .describe(
      "Bandcamp OAuth client ID (optional, only for sales/merch API)",
    ),
  clientSecret: z
    .string()
    .optional()
    .describe(
      "Bandcamp OAuth client secret (optional, only for sales/merch API)",
    ),
});

const API_BASE = "https://bandcamp.com/api";
const TOKEN_URL = "https://bandcamp.com/oauth_token";

// --- token cache ---
// Keyed on credential identity (clientId + clientSecret) so that two swamp
// instances of @magistr/bandcamp configured with DIFFERENT OAuth credentials
// but sharing one running process (one extension bundle load) never bleed a
// bearer/refresh token across identities (bandcamp-latent-bugs #2). A single
// credential always maps to the same key, so the time-based validity check,
// the refresh_token branch, and the write-back are all unchanged for the
// common single-instance case.
const tokenCache = new Map<
  string,
  { token: string; expiresAt: number; refreshToken: string }
>();

function tokenCacheKey(clientId: string, clientSecret: string): string {
  // JSON-array serialization is collision-proof for any pair of strings
  // (unlike a raw "::"-joined separator, which a clientId/clientSecret
  // containing colons could exploit to collide with a DIFFERENT pair --
  // e.g. ("a::", "b") and ("a:", ":b") would otherwise both key to
  // "a::::b").
  return JSON.stringify([clientId, clientSecret]);
}

// Bounded fetch timeout (bandcamp-latent-bugs #5): every fetch site
// (getToken, bcPost, and each redirect hop in fetchPage) routes through this
// helper instead of calling `fetch` directly, so a hung/slow upstream can
// never block a call -- and the model's lock -- indefinitely. `clearTimeout`
// runs in `finally`, so the timer is always cleared on success, on a thrown
// error, AND on every redirect hop, never just the happy path.
const FETCH_TIMEOUT_MS = 30_000;

async function timedFetch(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(clientId: string, clientSecret: string) {
  const now = Date.now();
  const key = tokenCacheKey(clientId, clientSecret);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now + 60000) {
    return cached.token;
  }

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  if (cached?.refreshToken) {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", cached.refreshToken);
  } else {
    body.set("grant_type", "client_credentials");
  }

  const response = await timedFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Token request failed: ${response.status} - ${text.slice(0, 200)}`,
    );
  }

  const data = await response.json();
  if (!data.ok && !data.access_token) {
    throw new Error(
      `Token request failed: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  const entry = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
    refreshToken: data.refresh_token || cached?.refreshToken || "",
  };
  tokenCache.set(key, entry);
  return entry.token;
}

async function bcPost(
  clientId: string,
  clientSecret: string,
  path: string,
  body: Record<string, unknown> = {},
) {
  if (!clientId || !clientSecret) {
    throw new Error(
      "clientId and clientSecret required for this method. Set them in globalArguments.",
    );
  }
  const token = await getToken(clientId, clientSecret);
  const response = await timedFetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Bandcamp ${path} failed: ${response.status} - ${text.slice(0, 300)}`,
    );
  }
  return response.json();
}

// --- HTML scraping helpers ---

const MAX_REDIRECT_HOPS = 5;

/**
 * SSRF guard (bandcamp-latent-bugs #1): only bandcamp.com or a
 * *.bandcamp.com subdomain may ever be fetched. Rejects unparseable URLs,
 * non-http(s) protocols, and any other host outright -- including
 * link-local/loopback targets and userinfo tricks (new URL().hostname
 * already normalizes "bandcamp.com@169.254.169.254" to the real internal
 * host, which is then rejected).
 */
function assertAllowedHost(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Refusing to fetch: invalid URL "${rawUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing to fetch ${rawUrl}: unsupported protocol "${parsed.protocol}"`,
    );
  }
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".")) {
    hostname = hostname.slice(0, -1);
  }
  const allowed = hostname === "bandcamp.com" ||
    hostname.endsWith(".bandcamp.com");
  if (!allowed) {
    throw new Error(
      `Refusing to fetch ${rawUrl}: host "${hostname}" is not bandcamp.com or a *.bandcamp.com subdomain`,
    );
  }
  return parsed;
}

async function fetchPage(url: string) {
  let current = assertAllowedHost(url).toString();
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const response = await timedFetch(current, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SwampBot/1.0)",
        Accept: "text/html",
      },
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error(
          `Failed to fetch ${current}: too many redirects (>${MAX_REDIRECT_HOPS})`,
        );
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `Failed to fetch ${current}: ${response.status} redirect with no Location header`,
        );
      }
      // Re-validate the redirect target's host on EVERY hop -- a 3xx bounce
      // to a link-local/loopback target must be rejected exactly like a
      // direct request to it.
      current = assertAllowedHost(new URL(location, current).toString())
        .toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch ${current}: ${response.status}`);
    }
    return response.text();
  }
  throw new Error(`Failed to fetch ${current}: too many redirects`);
}

function parseSearchResults(html: string, itemType: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const results: Record<string, unknown>[] = [];
  const items = doc.querySelectorAll(".searchresult.data-search");
  // fallback: try .result-items .searchresult
  const resultItems = items.length > 0
    ? items
    : doc.querySelectorAll(".result-items li");

  for (const item of resultItems) {
    const heading = item.querySelector(".heading a") ||
      item.querySelector(".itemurl a");
    const subhead = item.querySelector(".subhead")?.textContent?.trim() || "";
    const released = item.querySelector(".released")?.textContent?.trim() || "";
    const tags = item.querySelector(".tags")?.textContent?.trim() || "";
    const genre =
      item.querySelector(".genre")?.textContent?.replace("genre:", "").trim() ||
      "";
    const artImg = item.querySelector(".art img");
    const artUrl = artImg?.getAttribute("src") || "";
    const itemUrl = heading?.getAttribute("href") || "";
    const title = heading?.textContent?.trim() || "";
    const length = item.querySelector(".length")?.textContent?.trim() || "";

    const entry: Record<string, unknown> = {
      title,
      url: itemUrl,
      type: itemType,
    };
    if (subhead) entry.subhead = subhead;
    if (released) entry.released = released.replace("released ", "");
    if (tags) entry.tags = tags.replace("tags:", "").trim();
    if (genre) entry.genre = genre;
    if (artUrl) entry.artUrl = artUrl;
    if (length) entry.length = length;

    // parse artist from subhead
    if (itemType === "album" || itemType === "track") {
      const byMatch = subhead.match(/^by\s+(.+)/i);
      if (byMatch) entry.artist = byMatch[1].trim();
      const fromMatch = subhead.match(/from\s+(.+)/i);
      if (fromMatch) entry.album = fromMatch[1].trim();
    }
    if (itemType === "artist") {
      const loc = item.querySelector(".subhead")?.textContent?.trim();
      if (loc) entry.location = loc;
    }

    if (title) results.push(entry);
  }

  // parse total from page
  const totalMatch = html.match(/of\s+(\d+)\s+result/i);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : results.length;

  return { results, total };
}

function parseAlbumPage(html: string, warn?: (msg: string) => void) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // extract JSON-LD
  const ldScript = doc.querySelector('script[type="application/ld+json"]');
  // deno-lint-ignore no-explicit-any
  let ld: any = {};
  if (ldScript?.textContent) {
    try {
      ld = JSON.parse(ldScript.textContent);
    } catch (err) {
      // Real failure (script present, parse threw) -- surface it instead of
      // silently resolving as if the blob had simply been absent
      // (bandcamp-latent-bugs #4). Message is generic: never interpolate the
      // raw textContent (could carry injected content) or any credential.
      warn?.(`bandcamp: album JSON-LD parse failed: ${(err as Error).name}`);
    }
  }

  // extract tralbum data from embedded script
  // deno-lint-ignore no-explicit-any
  let tralbum: any = {};
  const scripts = doc.querySelectorAll("script");
  for (const s of scripts) {
    const text = s.textContent || "";
    const match = text.match(/var\s+TralbumData\s*=\s*(\{[\s\S]*?\});?\s*$/m);
    if (match) {
      // Real Bandcamp TralbumData is valid JSON -- try a direct parse FIRST.
      // Only on failure fall back to a cleanup pass that strips `//`-style
      // comments while PROTECTING any `scheme://` value: the old
      // unconditional `.replace(/\/\/.*/g, "")` truncated the blob at the
      // first "https://" it contained, losing everything after it --
      // including the JSON's own closing brackets -- and silently dropping
      // every track (bandcamp-latent-bugs #3).
      try {
        tralbum = JSON.parse(match[1]);
      } catch {
        try {
          const cleaned = match[1]
            .replace(/(^|[^:])\/\/.*$/gm, "$1")
            .replace(/,\s*}/g, "}")
            .replace(/,\s*]/g, "]");
          tralbum = JSON.parse(cleaned);
        } catch (err) {
          // Both the direct parse AND the cleanup fallback failed -- a
          // genuine parse failure, not merely a comment/trailing-comma
          // quirk. Surface it (bandcamp-latent-bugs #4) instead of silently
          // resolving with tracks=[].
          warn?.(
            `bandcamp: album TralbumData parse failed: ${(err as Error).name}`,
          );
        }
      }
    }
  }

  const title = ld.name ||
    doc.querySelector(".trackTitle, #name-section h2")?.textContent?.trim() ||
    "";
  const artist = ld.byArtist?.name ||
    doc.querySelector("#band-name-location .title, span[itemprop='byArtist'] a")
      ?.textContent?.trim() ||
    "";
  const releaseDate = ld.datePublished ||
    doc.querySelector(
      ".tralbumData.tralbum-credits meta[itemprop='datePublished']",
    )?.getAttribute("content") || "";
  const artUrl = ld.image ||
    doc.querySelector(".popupImage a img, #tralbumArt img")?.getAttribute(
      "src",
    ) || "";
  const about = ld.description ||
    doc.querySelector(".tralbumData.tralbum-about")?.textContent?.trim() || "";

  // tags
  const tagEls = doc.querySelectorAll(".tralbumData.tralbum-tags a.tag");
  // deno-lint-ignore no-explicit-any
  const tags = Array.from(tagEls).map((t: any) => t.textContent?.trim()).filter(
    Boolean,
  );

  // tracks from JSON-LD
  const tracks: Record<string, unknown>[] = [];
  const trackItems = ld.track?.itemListElement || [];
  for (const t of trackItems) {
    const item = t.item || t;
    tracks.push({
      position: t.position || 0,
      title: item.name || "",
      url: item["@id"] || "",
      duration: item.duration || "",
      recordingOf: item.recordingOf?.name || "",
    });
  }

  // fallback tracks from tralbum data
  if (tracks.length === 0 && tralbum.trackinfo) {
    for (const t of tralbum.trackinfo) {
      tracks.push({
        position: t.track_num || 0,
        title: t.title || "",
        duration: t.duration
          ? `${Math.floor(t.duration / 60)}:${
            String(Math.floor(t.duration % 60)).padStart(2, "0")
          }`
          : "",
        url: "",
      });
    }
  }

  return {
    title,
    artist,
    releaseDate,
    artUrl,
    // Code-point-safe truncation (bandcamp-latent-bugs #7): a plain
    // `.slice(0, 500)` cuts on UTF-16 code UNITS and can split a surrogate
    // pair straddling the boundary, emitting a lone unpaired high surrogate.
    // `Array.from` iterates by code point, so an astral character at the
    // boundary is kept or dropped WHOLE. The invariant this now upholds is
    // "<= 500 code points", not "<= 500 UTF-16 code units" -- for astral
    // input the returned string's `.length` (code units) can exceed 500.
    about: Array.from(about).slice(0, 500).join(""),
    tags,
    tracks,
    trackCount: tracks.length,
  };
}

function parseArtistPage(html: string, warn?: (msg: string) => void) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const name = doc.querySelector(
    "#band-name-location .title, p#band-name-location span.title",
  )?.textContent?.trim() || "";
  const location =
    doc.querySelector("#band-name-location .location")?.textContent?.trim() ||
    "";
  const bio =
    doc.querySelector(".bio-text, .signed-out-artists-bio-text p")?.textContent
      ?.trim() || "";
  const imgEl = doc.querySelector(".band-photo, .popupImage img");
  const imageUrl = imgEl?.getAttribute("src") || "";

  // discography
  const albums: Record<string, unknown>[] = [];
  const discItems = doc.querySelectorAll(
    "#music-grid .music-grid-item, .music-grid li",
  );
  for (const item of discItems) {
    const link = item.querySelector("a");
    const titleEl = item.querySelector(".title, p.title");
    albums.push({
      title: titleEl?.textContent?.trim() || "",
      url: link?.getAttribute("href") || "",
    });
  }

  // JSON-LD for more structured data
  const ldScript = doc.querySelector('script[type="application/ld+json"]');
  // deno-lint-ignore no-explicit-any
  let ld: any = {};
  if (ldScript?.textContent) {
    try {
      ld = JSON.parse(ldScript.textContent);
    } catch (err) {
      // Real failure (script present, parse threw) -- surface it instead of
      // silently resolving as if the blob had simply been absent
      // (bandcamp-latent-bugs #4). Message is generic: never interpolate the
      // raw textContent (could carry injected content) or any credential.
      warn?.(`bandcamp: artist JSON-LD parse failed: ${(err as Error).name}`);
    }
  }

  const discographyFromLd = (ld.album || ld.discography || []).map((
    // deno-lint-ignore no-explicit-any
    a: any,
  ) => ({
    title: a.name || "",
    url: a["@id"] || "",
    releaseDate: a.datePublished || "",
    numTracks: a.numTracks || a.track?.numberOfItems || 0,
  }));

  return {
    name: name || ld.name || "",
    location,
    // Code-point-safe truncation (bandcamp-latent-bugs #7) -- see the
    // matching comment in parseAlbumPage's `about` field.
    bio: Array.from(bio).slice(0, 500).join(""),
    imageUrl,
    url: ld["@id"] || "",
    discography: discographyFromLd.length > 0 ? discographyFromLd : albums,
    albumCount: Math.max(discographyFromLd.length, albums.length),
  };
}

/**
 * Derives a swamp resource instance name from a source URL (bandcamp-latent
 * -bugs #6): a readable 47-char sanitized slug plus a 12-hex-char SHA-256
 * suffix of the FULL raw URL. Two different URLs sharing the same first
 * 47 sanitized characters no longer collide on the identical resource name
 * -- each gets its own collision-resistant suffix (<= 47 + 1 + 12 = 60
 * chars total). The same URL always hashes to the same suffix, so
 * re-running a get-* method against the same URL still idempotently
 * overwrites its own prior resource, never a different URL's.
 */
async function urlResourceName(raw: string): Promise<string> {
  const slug = raw.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]/g, "-")
    .slice(0, 47);
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  const hex = Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("").slice(0, 12);
  return `${slug}-${hex}`;
}

// --- resource schemas ---

const BandSchema = z
  .object({
    band_id: z.number(),
    name: z.string(),
    subdomain: z.string(),
  })
  .passthrough();

const SaleItemSchema = z
  .object({
    item_type: z.string().optional(),
    item_name: z.string().optional(),
    artist: z.string().optional(),
    currency: z.string().optional(),
    amount_paid: z.number().optional(),
    date: z.string().optional(),
  })
  .passthrough();

const MerchItemSchema = z
  .object({
    package_id: z.number().optional(),
    title: z.string().optional(),
    album_title: z.string().optional(),
    quantity_available: z.number().optional(),
    quantity_sold: z.number().optional(),
    price: z.number().optional(),
    currency: z.string().optional(),
    sku: z.string().optional(),
  })
  .passthrough();

const OrderSchema = z
  .object({
    sale_item_id: z.string().optional(),
    payment_id: z.number().optional(),
    order_date: z.string().optional(),
    buyer_name: z.string().optional(),
    payment_state: z.string().optional(),
    sku: z.string().optional(),
  })
  .passthrough();

const ShippingOriginSchema = z
  .object({
    origin_id: z.number().optional(),
    band_id: z.number().optional(),
    country_name: z.string().optional(),
    state_name: z.string().optional(),
  })
  .passthrough();

const SearchResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    type: z.string(),
    artist: z.string().optional(),
    album: z.string().optional(),
    subhead: z.string().optional(),
    released: z.string().optional(),
    tags: z.string().optional(),
    genre: z.string().optional(),
    location: z.string().optional(),
    artUrl: z.string().optional(),
  })
  .passthrough();

const TrackSchema = z.object({
  position: z.number(),
  title: z.string(),
  url: z.string().optional(),
  duration: z.string().optional(),
  recordingOf: z.string().optional(),
});

const AlbumDetailSchema = z.object({
  title: z.string(),
  artist: z.string(),
  releaseDate: z.string().optional(),
  artUrl: z.string().optional(),
  about: z.string().optional(),
  tags: z.array(z.string()),
  tracks: z.array(TrackSchema),
  trackCount: z.number(),
  timestamp: z.string(),
});

const ArtistDetailSchema = z.object({
  name: z.string(),
  location: z.string().optional(),
  bio: z.string().optional(),
  imageUrl: z.string().optional(),
  url: z.string().optional(),
  discography: z.array(
    z.object({
      title: z.string(),
      url: z.string().optional(),
      releaseDate: z.string().optional(),
      numTracks: z.number().optional(),
    }),
  ),
  albumCount: z.number(),
  timestamp: z.string(),
});

const TaskResultSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});

/**
 * Bandcamp model: searches artists, albums, and tracks via the public search
 * page, fetches artist/album/track metadata by URL, and (with optional OAuth
 * credentials) reads bands, sales reports, merch details, and orders.
 */
export const model = {
  type: "@magistr/bandcamp",
  version: "2026.08.19.1",
  upgrades: [
    {
      fromVersion: "2026.07.31.1",
      toVersion: "2026.08.02.1",
      description:
        "No-op: internal robustness fixes (TralbumData parse recovery, " +
        "parse-failure warnings, fetch timeouts, hashed resource names, " +
        "code-point-safe truncation); no globalArguments/schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.19.1",
      description: "Version bump and smoke test",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    search: {
      description: "Search results from Bandcamp",
      schema: z.object({
        query: z.string(),
        itemType: z.string(),
        results: z.array(SearchResultSchema),
        total: z.number(),
        page: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    artistDetail: {
      description: "Artist/band page details with discography",
      schema: ArtistDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    albumDetail: {
      description: "Album/release details with track listing",
      schema: AlbumDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    bands: {
      description: "Bands/labels associated with account",
      schema: z.object({
        bands: z.array(BandSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    sales: {
      description: "Sales report data",
      schema: z.object({
        bandId: z.number(),
        items: z.array(SaleItemSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    merch: {
      description: "Merch details",
      schema: z.object({
        bandId: z.number(),
        items: z.array(MerchItemSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    orders: {
      description: "Merch orders",
      schema: z.object({
        bandId: z.number(),
        items: z.array(OrderSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    shippingOrigins: {
      description: "Shipping origin locations",
      schema: z.object({
        origins: z.array(ShippingOriginSchema),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    task: {
      description: "Action result",
      schema: TaskResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    report: {
      description: "Generated report info",
      schema: z.object({
        token: z.string().optional(),
        url: z.string().optional(),
        status: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    // --- Catalog Search (no auth needed) ---

    "search-artist": {
      description: "Search Bandcamp for artists/bands",
      arguments: z.object({
        query: z.string().describe("Search query"),
        page: z.number().optional().describe("Page number (default 1)"),
      }),
      execute: async (args, context) => {
        const page = args.page || 1;
        const html = await fetchPage(
          `https://bandcamp.com/search?q=${
            encodeURIComponent(args.query)
          }&item_type=b&page=${page}`,
        );
        const { results, total } = parseSearchResults(html, "artist");
        const handle = await context.writeResource("search", "search-artist", {
          query: args.query,
          itemType: "artist",
          results,
          total,
          page,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-album": {
      description: "Search Bandcamp for albums/releases",
      arguments: z.object({
        query: z.string().describe("Search query"),
        page: z.number().optional().describe("Page number (default 1)"),
      }),
      execute: async (args, context) => {
        const page = args.page || 1;
        const html = await fetchPage(
          `https://bandcamp.com/search?q=${
            encodeURIComponent(args.query)
          }&item_type=a&page=${page}`,
        );
        const { results, total } = parseSearchResults(html, "album");
        const handle = await context.writeResource("search", "search-album", {
          query: args.query,
          itemType: "album",
          results,
          total,
          page,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-track": {
      description: "Search Bandcamp for tracks",
      arguments: z.object({
        query: z.string().describe("Search query"),
        page: z.number().optional().describe("Page number (default 1)"),
      }),
      execute: async (args, context) => {
        const page = args.page || 1;
        const html = await fetchPage(
          `https://bandcamp.com/search?q=${
            encodeURIComponent(args.query)
          }&item_type=t&page=${page}`,
        );
        const { results, total } = parseSearchResults(html, "track");
        const handle = await context.writeResource("search", "search-track", {
          query: args.query,
          itemType: "track",
          results,
          total,
          page,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Detail pages (no auth needed) ---

    "get-artist": {
      description:
        "Get artist/band page details and discography by Bandcamp URL",
      arguments: z.object({
        url: z
          .string()
          .describe(
            "Bandcamp artist URL (e.g., https://example-artist.bandcamp.com)",
          ),
      }),
      execute: async (args, context) => {
        let url = args.url;
        // ensure we're hitting the music page for full discography
        if (!url.endsWith("/music") && !url.includes("/music?")) {
          url = url.replace(/\/$/, "") + "/music";
        }
        const html = await fetchPage(url);
        const artist = parseArtistPage(
          html,
          (m) => context.logger?.warning?.(m),
        );
        const instanceName = await urlResourceName(url);
        const handle = await context.writeResource(
          "artistDetail",
          instanceName,
          {
            ...artist,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "get-album": {
      description: "Get album details and track listing by Bandcamp URL",
      arguments: z.object({
        url: z
          .string()
          .describe(
            "Bandcamp album URL (e.g., https://example-artist.bandcamp.com/album/example-album)",
          ),
      }),
      execute: async (args, context) => {
        const html = await fetchPage(args.url);
        const album = parseAlbumPage(
          html,
          (m) => context.logger?.warning?.(m),
        );
        const instanceName = await urlResourceName(args.url);
        const handle = await context.writeResource(
          "albumDetail",
          instanceName,
          {
            ...album,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "get-track": {
      description: "Get track details by Bandcamp URL",
      arguments: z.object({
        url: z.string().describe("Bandcamp track URL"),
      }),
      execute: async (args, context) => {
        const html = await fetchPage(args.url);
        // track pages have same structure as album pages
        const album = parseAlbumPage(
          html,
          (m) => context.logger?.warning?.(m),
        );
        const instanceName = await urlResourceName(args.url);
        const handle = await context.writeResource(
          "albumDetail",
          instanceName,
          {
            ...album,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Account (OAuth required) ---

    "my-bands": {
      description: "List all bands/labels on the account (requires OAuth)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { clientId, clientSecret } = context.globalArgs;
        const data = await bcPost(
          clientId!,
          clientSecret!,
          "/account/1/my_bands",
        );
        const bands: Record<string, unknown>[] = [];
        for (const b of data.bands || []) {
          bands.push(b);
          if (b.member_bands) {
            for (const mb of b.member_bands) {
              bands.push(mb);
            }
          }
        }
        const handle = await context.writeResource("bands", "all", {
          bands,
          total: bands.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Sales (OAuth required) ---

    "sales-report": {
      description: "Get sales report for a band (requires OAuth)",
      arguments: z.object({
        bandId: z.number().describe("Band ID"),
        memberBandId: z.number().optional(),
        startTime: z.string().describe("Start time (ISO 8601 UTC)"),
        endTime: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { clientId, clientSecret } = context.globalArgs;
        const body: Record<string, unknown> = {
          band_id: args.bandId,
          start_time: args.startTime,
        };
        if (args.memberBandId) body.member_band_id = args.memberBandId;
        if (args.endTime) body.end_time = args.endTime;
        const data = await bcPost(
          clientId!,
          clientSecret!,
          "/sales/4/sales_report",
          body,
        );
        const items = data.report || [];
        const handle = await context.writeResource(
          "sales",
          `band-${args.bandId}`,
          {
            bandId: args.bandId,
            items,
            total: items.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Merch (OAuth required) ---

    "get-orders": {
      description: "Get merch orders for a band (requires OAuth)",
      arguments: z.object({
        bandId: z.number().describe("Band ID"),
        memberBandId: z.number().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        unshippedOnly: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const { clientId, clientSecret } = context.globalArgs;
        const body: Record<string, unknown> = { band_id: args.bandId };
        if (args.memberBandId) body.member_band_id = args.memberBandId;
        if (args.startTime) body.start_time = args.startTime;
        if (args.endTime) body.end_time = args.endTime;
        if (args.unshippedOnly) body.unshipped_only = args.unshippedOnly;
        const data = await bcPost(
          clientId!,
          clientSecret!,
          "/merchorders/4/get_orders",
          body,
        );
        const items = data.items || [];
        const handle = await context.writeResource(
          "orders",
          `band-${args.bandId}`,
          {
            bandId: args.bandId,
            items,
            total: items.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "get-merch-details": {
      description: "Get merch item details for a band (requires OAuth)",
      arguments: z.object({
        bandId: z.number().describe("Band ID"),
        memberBandId: z.number().optional(),
        startTime: z.string().describe("Start time (ISO 8601 UTC)"),
        endTime: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { clientId, clientSecret } = context.globalArgs;
        const body: Record<string, unknown> = {
          band_id: args.bandId,
          start_time: args.startTime,
        };
        if (args.memberBandId) body.member_band_id = args.memberBandId;
        if (args.endTime) body.end_time = args.endTime;
        const data = await bcPost(
          clientId!,
          clientSecret!,
          "/merchorders/1/get_merch_details",
          body,
        );
        const items = data.items || [];
        const handle = await context.writeResource(
          "merch",
          `band-${args.bandId}`,
          {
            bandId: args.bandId,
            items,
            total: items.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "update-shipped": {
      description: "Mark orders as shipped (requires OAuth)",
      arguments: z.object({
        items: z
          .array(
            z.object({
              id: z.union([z.string(), z.number()]).describe(
                "Sale item or payment ID",
              ),
              idType: z.enum(["p", "s"]).describe("p=payment, s=sale_item"),
              shipped: z.boolean().optional(),
              carrier: z.string().optional(),
              trackingCode: z.string().optional(),
              notification: z.boolean().optional(),
            }),
          )
          .describe("Items to update"),
      }),
      execute: async (args, context) => {
        const { clientId, clientSecret } = context.globalArgs;
        const items = args.items.map((i) => ({
          id: i.id,
          id_type: i.idType,
          shipped: i.shipped,
          carrier: i.carrier,
          tracking_code: i.trackingCode,
          notification: i.notification,
        }));
        await bcPost(
          clientId!,
          clientSecret!,
          "/merchorders/2/update_shipped",
          { items },
        );
        const handle = await context.writeResource("task", "update-shipped", {
          message: `Updated shipping status for ${items.length} items`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
