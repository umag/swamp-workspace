import { z } from "npm:zod@4";
import { DOMParser } from "npm:linkedom@0.16.11";

const GlobalArgsSchema = z.object({
  userAgent: z
    .string()
    .describe(
      "User-Agent string (e.g., MyApp/1.0.0 (contact@example.com)) — required by MusicBrainz",
    ),
});

const BASE = "https://musicbrainz.org/ws/2";

// rate limit: 1 req/sec
let lastRequest = 0;

async function mbFetch(
  userAgent: string,
  path: string,
  params: Record<string, string> = {},
) {
  const now = Date.now();
  const wait = 1100 - (now - lastRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("fmt", "json");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const response = await fetch(url.toString(), {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `MusicBrainz ${path} failed: ${response.status} - ${body.slice(0, 300)}`,
    );
  }
  return response.json();
}

// --- bandcamp scraping helpers ---

async function fetchPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SwampBot/1.0)",
      Accept: "text/html",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function parseBandcampAlbumPage(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const ldScript = doc.querySelector('script[type="application/ld+json"]');
  // deno-lint-ignore no-explicit-any -- dynamic schema.org JSON-LD payload
  let ld: any = {};
  if (ldScript?.textContent) {
    try {
      ld = JSON.parse(ldScript.textContent);
    } catch { /* ignore */ }
  }

  const title = ld.name ||
    doc.querySelector(".trackTitle, #name-section h2")?.textContent?.trim() ||
    "";
  const artist = ld.byArtist?.name ||
    doc.querySelector("#band-name-location .title, span[itemprop='byArtist'] a")
      ?.textContent?.trim() ||
    "";
  const releaseDate = ld.datePublished || "";

  const tagEls = doc.querySelectorAll(".tralbumData.tralbum-tags a.tag");
  const tags = Array.from(tagEls).map(
    // deno-lint-ignore no-explicit-any -- linkedom DOM node, no global Element type
    (t: any) => t.textContent?.trim(),
  ).filter(
    Boolean,
  );

  // deno-lint-ignore no-explicit-any -- track entries assembled from dynamic JSON
  const tracks: any[] = [];
  const trackItems = ld.track?.itemListElement || [];
  for (const t of trackItems) {
    const item = t.item || t;
    tracks.push({
      position: t.position || 0,
      title: item.name || "",
      duration: item.duration || "",
    });
  }

  // fallback: parse tralbum data
  if (tracks.length === 0) {
    const scripts = doc.querySelectorAll("script");
    for (const s of scripts) {
      const text = s.textContent || "";
      const match = text.match(/var\s+TralbumData\s*=\s*(\{[\s\S]*?\});?\s*$/m);
      if (match) {
        try {
          const cleaned = match[1].replace(/\/\/.*/g, "").replace(/,\s*}/g, "}")
            .replace(/,\s*]/g, "]");
          const tralbum = JSON.parse(cleaned);
          for (const t of tralbum.trackinfo || []) {
            tracks.push({
              position: t.track_num || 0,
              title: t.title || "",
              duration: t.duration
                ? `${Math.floor(t.duration / 60)}:${
                  String(Math.floor(t.duration % 60)).padStart(2, "0")
                }`
                : "",
              durationMs: t.duration
                ? Math.round(t.duration * 1000)
                : undefined,
            });
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    // parse ISO 8601 durations to ms
    for (const t of tracks) {
      if (t.duration && t.duration.startsWith("P")) {
        const m = t.duration.match(
          /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/,
        );
        if (m) {
          t.durationMs =
            ((parseInt(m[1] || "0") * 3600) + (parseInt(m[2] || "0") * 60) +
              parseFloat(m[3] || "0")) * 1000;
          t.duration = `${parseInt(m[2] || "0")}:${
            String(Math.floor(parseFloat(m[3] || "0"))).padStart(2, "0")
          }`;
        }
      }
    }
  }

  return { title, artist, releaseDate, tags, tracks };
}

function parseBandcampArtistPage(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const name = doc.querySelector(
    "#band-name-location .title, p#band-name-location span.title",
  )?.textContent?.trim() || "";

  const ldScript = doc.querySelector('script[type="application/ld+json"]');
  // deno-lint-ignore no-explicit-any -- dynamic schema.org JSON-LD payload
  let ld: any = {};
  if (ldScript?.textContent) {
    try {
      ld = JSON.parse(ldScript.textContent);
    } catch { /* ignore */ }
  }

  // deno-lint-ignore no-explicit-any -- album entries from dynamic JSON-LD
  const discography = (ld.album || ld.discography || []).map((a: any) => ({
    title: a.name || "",
    url: a["@id"] || "",
    releaseDate: a.datePublished || "",
    numTracks: a.numTracks || a.track?.numberOfItems || 0,
  }));

  if (discography.length === 0) {
    const items = doc.querySelectorAll(
      "#music-grid .music-grid-item, .music-grid li",
    );
    for (const item of items) {
      const link = item.querySelector("a");
      const titleEl = item.querySelector(".title, p.title");
      discography.push({
        title: titleEl?.textContent?.trim() || "",
        url: link?.getAttribute("href") || "",
        releaseDate: "",
        numTracks: 0,
      });
    }
  }

  return { name: name || ld.name || "", discography };
}

function buildSeedUrl(
  // deno-lint-ignore no-explicit-any -- parsed Bandcamp album with dynamic fields
  album: any,
  artistMbid: string | undefined,
  bandcampUrl: string,
) {
  const params = new URLSearchParams();
  params.set("name", album.title);
  params.set("type", "album");
  params.set("status", "official");

  // artist credit
  if (artistMbid) {
    params.set("artist_credit.names.0.mbid", artistMbid);
  }
  params.set("artist_credit.names.0.artist.name", album.artist);

  // release date
  if (album.releaseDate) {
    const parts = album.releaseDate.split(/[-/]/);
    if (parts[0]) params.set("events.0.date.year", parts[0]);
    if (parts[1]) params.set("events.0.date.month", parts[1]);
    if (parts[2]) params.set("events.0.date.day", parts[2]);
  }

  // medium: Digital Media
  params.set("mediums.0.format", "Digital Media");

  // tracks
  for (let i = 0; i < album.tracks.length; i++) {
    const t = album.tracks[i];
    params.set(`mediums.0.track.${i}.name`, t.title);
    params.set(`mediums.0.track.${i}.number`, String(t.position || i + 1));
    if (t.durationMs) {
      params.set(
        `mediums.0.track.${i}.length`,
        String(Math.round(t.durationMs)),
      );
    }
  }

  // bandcamp URL as source
  params.set("urls.0.url", bandcampUrl);
  params.set("urls.0.link_type", "85"); // 85 = free streaming

  params.set("edit_note", `Seeded from Bandcamp: ${bandcampUrl}`);

  return `https://musicbrainz.org/release/add?${params.toString()}`;
}

function normalizeTitle(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// --- resource schemas ---

const ArtistSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    "sort-name": z.string().optional(),
    type: z.string().optional(),
    country: z.string().optional(),
    disambiguation: z.string().optional(),
  })
  .passthrough();

const ReleaseGroupSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    "primary-type": z.string().optional(),
    "first-release-date": z.string().optional(),
  })
  .passthrough();

const ReleaseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string().optional(),
    date: z.string().optional(),
    country: z.string().optional(),
    barcode: z.string().optional(),
  })
  .passthrough();

const RecordingSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    length: z.number().optional(),
    "first-release-date": z.string().optional(),
  })
  .passthrough();

const LabelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    country: z.string().optional(),
    disambiguation: z.string().optional(),
  })
  .passthrough();

const SearchResultsSchema = z.object({
  query: z.string(),
  entity: z.string(),
  results: z.array(z.object({}).passthrough()),
  count: z.number(),
  offset: z.number(),
  timestamp: z.string(),
});

const EntityDetailSchema = z.object({
  entity: z.string(),
  data: z.object({}).passthrough(),
  timestamp: z.string(),
});

const BrowseResultsSchema = z.object({
  entity: z.string(),
  linkedEntity: z.string(),
  linkedId: z.string(),
  results: z.array(z.object({}).passthrough()),
  count: z.number(),
  offset: z.number(),
  timestamp: z.string(),
});

/**
 * MusicBrainz metadata model — search and look up artists, release groups,
 * releases, recordings, and labels via the MusicBrainz Web Service v2, with
 * Bandcamp-to-MusicBrainz release-editor seeding helpers.
 */
export const model = {
  type: "@magistr/musicbrainz",
  version: "2026.07.16.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    search: {
      description: "Search results",
      schema: SearchResultsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    entity: {
      description: "Entity lookup detail",
      schema: EntityDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    browse: {
      description: "Browse results for linked entities",
      schema: BrowseResultsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    artists: {
      description: "Artist results",
      schema: z.object({
        artists: z.array(ArtistSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    releaseGroups: {
      description: "Release group results",
      schema: z.object({
        releaseGroups: z.array(ReleaseGroupSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    releases: {
      description: "Release results",
      schema: z.object({
        releases: z.array(ReleaseSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    recordings: {
      description: "Recording results",
      schema: z.object({
        recordings: z.array(RecordingSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    labels: {
      description: "Label results",
      schema: z.object({
        labels: z.array(LabelSchema),
        count: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    seedUrls: {
      description:
        "MusicBrainz release editor seed URLs generated from Bandcamp",
      schema: z.object({
        artist: z.string(),
        artistMbid: z.string().optional(),
        bandcampUrl: z.string(),
        releases: z.array(
          z.object({
            title: z.string(),
            bandcampUrl: z.string(),
            seedUrl: z.string(),
            trackCount: z.number(),
            releaseDate: z.string().optional(),
            status: z.string(),
          }),
        ),
        total: z.number(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    missingReleases: {
      description: "Releases found on Bandcamp but missing from MusicBrainz",
      schema: z.object({
        artist: z.string(),
        artistMbid: z.string().optional(),
        bandcampUrl: z.string(),
        mbReleaseCount: z.number(),
        bcReleaseCount: z.number(),
        missing: z.array(
          z.object({
            title: z.string(),
            bandcampUrl: z.string(),
            releaseDate: z.string().optional(),
            numTracks: z.number().optional(),
            seedUrl: z.string(),
          }),
        ),
        matched: z.array(
          z.object({
            bcTitle: z.string(),
            mbTitle: z.string(),
            mbId: z.string(),
          }),
        ),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    // --- Search methods ---

    "search-artist": {
      description: "Search for artists by name or query",
      arguments: z.object({
        query: z.string().describe("Search query (Lucene syntax supported)"),
        limit: z.number().optional().describe(
          "Max results (1-100, default 25)",
        ),
        offset: z.number().optional().describe("Offset for pagination"),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/artist/", params);
        const artists = data.artists || [];
        const handle = await context.writeResource("artists", "search", {
          artists,
          count: data.count || artists.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-release-group": {
      description: "Search for release groups (albums/EPs/singles)",
      arguments: z.object({
        query: z.string().describe(
          "Search query (e.g., 'releasegroup:name AND artist:name')",
        ),
        limit: z.number().optional().describe(
          "Max results (1-100, default 25)",
        ),
        offset: z.number().optional().describe("Offset for pagination"),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/release-group/", params);
        const rgs = data["release-groups"] || [];
        const handle = await context.writeResource("releaseGroups", "search", {
          releaseGroups: rgs,
          count: data.count || rgs.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-release": {
      description: "Search for releases",
      arguments: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/release/", params);
        const releases = data.releases || [];
        const handle = await context.writeResource("releases", "search", {
          releases,
          count: data.count || releases.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-recording": {
      description: "Search for recordings (tracks)",
      arguments: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/recording/", params);
        const recordings = data.recordings || [];
        const handle = await context.writeResource("recordings", "search", {
          recordings,
          count: data.count || recordings.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "search-label": {
      description: "Search for record labels",
      arguments: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, "/label/", params);
        const labels = data.labels || [];
        const handle = await context.writeResource("labels", "search", {
          labels,
          count: data.count || labels.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Lookup methods ---

    "lookup-artist": {
      description: "Look up an artist by MBID with optional includes",
      arguments: z.object({
        id: z.string().describe("MusicBrainz artist ID"),
        inc: z
          .string()
          .optional()
          .describe(
            "Include params (e.g., 'releases+release-groups+recordings+aliases+tags+genres')",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, `/artist/${args.id}`, params);
        const handle = await context.writeResource(
          "entity",
          `artist-${args.id}`,
          {
            entity: "artist",
            data,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "lookup-release-group": {
      description: "Look up a release group by MBID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz release group ID"),
        inc: z
          .string()
          .optional()
          .describe(
            "Include params (e.g., 'releases+artist-credits+tags+genres')",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(
          userAgent,
          `/release-group/${args.id}`,
          params,
        );
        const handle = await context.writeResource("entity", `rg-${args.id}`, {
          entity: "release-group",
          data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "lookup-release": {
      description: "Look up a release by MBID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz release ID"),
        inc: z
          .string()
          .optional()
          .describe(
            "Include params (e.g., 'recordings+artist-credits+labels')",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, `/release/${args.id}`, params);
        const handle = await context.writeResource(
          "entity",
          `release-${args.id}`,
          {
            entity: "release",
            data,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "lookup-recording": {
      description: "Look up a recording by MBID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz recording ID"),
        inc: z
          .string()
          .optional()
          .describe(
            "Include params (e.g., 'releases+artist-credits+isrcs+tags')",
          ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, `/recording/${args.id}`, params);
        const handle = await context.writeResource(
          "entity",
          `recording-${args.id}`,
          {
            entity: "recording",
            data,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "lookup-label": {
      description: "Look up a label by MBID",
      arguments: z.object({
        id: z.string().describe("MusicBrainz label ID"),
        inc: z.string().optional().describe(
          "Include params (e.g., 'releases+aliases+tags')",
        ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, `/label/${args.id}`, params);
        const handle = await context.writeResource(
          "entity",
          `label-${args.id}`,
          {
            entity: "label",
            data,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Browse methods ---

    "browse-release-groups": {
      description: "Browse release groups by artist MBID",
      arguments: z.object({
        artist: z.string().describe("Artist MBID"),
        type: z
          .string()
          .optional()
          .describe("Filter by type (album, single, ep, etc.)"),
        limit: z.number().optional().describe(
          "Max results (1-100, default 25)",
        ),
        offset: z.number().optional(),
        inc: z.string().optional().describe(
          "Include params (e.g., 'tags+genres')",
        ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { artist: args.artist };
        if (args.type) params.type = args.type;
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, "/release-group/", params);
        const rgs = data["release-groups"] || [];
        const handle = await context.writeResource(
          "browse",
          `rg-by-artist-${args.artist}`,
          {
            entity: "release-group",
            linkedEntity: "artist",
            linkedId: args.artist,
            results: rgs,
            count: data["release-group-count"] || rgs.length,
            offset: data["release-group-offset"] || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "browse-releases": {
      description: "Browse releases by artist, label, or release-group MBID",
      arguments: z.object({
        artist: z.string().optional().describe("Artist MBID"),
        label: z.string().optional().describe("Label MBID"),
        releaseGroup: z.string().optional().describe("Release group MBID"),
        status: z.string().optional().describe(
          "Filter by status (official, bootleg, etc.)",
        ),
        type: z.string().optional().describe("Filter by type"),
        limit: z.number().optional(),
        offset: z.number().optional(),
        inc: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        let linkedEntity = "";
        let linkedId = "";
        if (args.artist) {
          params.artist = args.artist;
          linkedEntity = "artist";
          linkedId = args.artist;
        }
        if (args.label) {
          params.label = args.label;
          linkedEntity = "label";
          linkedId = args.label;
        }
        if (args.releaseGroup) {
          params["release-group"] = args.releaseGroup;
          linkedEntity = "release-group";
          linkedId = args.releaseGroup;
        }
        if (args.status) params.status = args.status;
        if (args.type) params.type = args.type;
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, "/release/", params);
        const releases = data.releases || [];
        const handle = await context.writeResource(
          "browse",
          `releases-by-${linkedEntity}-${linkedId}`,
          {
            entity: "release",
            linkedEntity,
            linkedId,
            results: releases,
            count: data["release-count"] || releases.length,
            offset: data["release-offset"] || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "browse-recordings": {
      description: "Browse recordings by artist or release MBID",
      arguments: z.object({
        artist: z.string().optional().describe("Artist MBID"),
        release: z.string().optional().describe("Release MBID"),
        limit: z.number().optional(),
        offset: z.number().optional(),
        inc: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = {};
        let linkedEntity = "";
        let linkedId = "";
        if (args.artist) {
          params.artist = args.artist;
          linkedEntity = "artist";
          linkedId = args.artist;
        }
        if (args.release) {
          params.release = args.release;
          linkedEntity = "release";
          linkedId = args.release;
        }
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        if (args.inc) params.inc = args.inc;
        const data = await mbFetch(userAgent, "/recording/", params);
        const recordings = data.recordings || [];
        const handle = await context.writeResource(
          "browse",
          `recordings-by-${linkedEntity}-${linkedId}`,
          {
            entity: "recording",
            linkedEntity,
            linkedId,
            results: recordings,
            count: data["recording-count"] || recordings.length,
            offset: data["recording-offset"] || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Bandcamp → MusicBrainz seeding ---

    "seed-from-bandcamp": {
      description:
        "Fetch a Bandcamp album and generate a MusicBrainz release editor seed URL",
      arguments: z.object({
        bandcampUrl: z.string().describe("Bandcamp album URL"),
        artistMbid: z.string().optional().describe(
          "MusicBrainz artist MBID to link",
        ),
      }),
      execute: async (args, context) => {
        const html = await fetchPage(args.bandcampUrl);
        const album = parseBandcampAlbumPage(html);
        const seedUrl = buildSeedUrl(album, args.artistMbid, args.bandcampUrl);
        const handle = await context.writeResource("seedUrls", `seed-single`, {
          artist: album.artist,
          artistMbid: args.artistMbid,
          bandcampUrl: args.bandcampUrl,
          releases: [{
            title: album.title,
            bandcampUrl: args.bandcampUrl,
            seedUrl,
            trackCount: album.tracks.length,
            releaseDate: album.releaseDate,
            status: "ready",
          }],
          total: 1,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    "find-missing": {
      description:
        "Compare an artist's Bandcamp discography against MusicBrainz and find missing releases with seed URLs",
      arguments: z.object({
        bandcampUrl: z.string().describe(
          "Bandcamp artist URL (e.g., https://artist.bandcamp.com)",
        ),
        artistMbid: z.string().optional().describe(
          "MusicBrainz artist MBID (auto-searched if omitted)",
        ),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;

        // 1. Get Bandcamp discography
        let bcUrl = args.bandcampUrl.replace(/\/$/, "");
        if (!bcUrl.endsWith("/music")) bcUrl += "/music";
        const bcHtml = await fetchPage(bcUrl);
        const bcArtist = parseBandcampArtistPage(bcHtml);

        // 2. Resolve artist MBID
        let artistMbid = args.artistMbid;
        let artistName = bcArtist.name;
        if (!artistMbid && artistName) {
          const searchData = await mbFetch(userAgent, "/artist/", {
            query: artistName,
            limit: "5",
          });
          const artists = searchData.artists || [];
          // try exact match first
          // deno-lint-ignore no-explicit-any -- dynamic MusicBrainz artist record
          const exact = artists.find((a: any) =>
            normalizeTitle(a.name) === normalizeTitle(artistName)
          );
          if (exact) {
            artistMbid = exact.id;
            artistName = exact.name;
          }
        }

        // 3. Get MusicBrainz release groups
        // deno-lint-ignore no-explicit-any -- dynamic MusicBrainz release groups
        const mbReleases: any[] = [];
        if (artistMbid) {
          let offset = 0;
          while (true) {
            const data = await mbFetch(userAgent, "/release-group/", {
              artist: artistMbid,
              limit: "100",
              offset: String(offset),
            });
            const rgs = data["release-groups"] || [];
            mbReleases.push(...rgs);
            if (rgs.length < 100) break;
            offset += 100;
          }
        }

        // 4. Match and find missing
        const mbTitlesNorm = mbReleases.map((r) => ({
          norm: normalizeTitle(r.title),
          title: r.title,
          id: r.id,
        }));

        // deno-lint-ignore no-explicit-any -- assembled missing-release records
        const missing: any[] = [];
        // deno-lint-ignore no-explicit-any -- assembled matched-release records
        const matched: any[] = [];

        for (const bc of bcArtist.discography) {
          const bcNorm = normalizeTitle(bc.title);
          const match = mbTitlesNorm.find((mb) => mb.norm === bcNorm);
          if (match) {
            matched.push({
              bcTitle: bc.title,
              mbTitle: match.title,
              mbId: match.id,
            });
          } else {
            // build seed URL — fetch album page for track data
            let seedUrl = "";
            let trackCount = bc.numTracks || 0;
            const albumUrl = bc.url.startsWith("http")
              ? bc.url
              : `${args.bandcampUrl.replace(/\/$/, "")}${bc.url}`;
            try {
              const albumHtml = await fetchPage(albumUrl);
              const albumData = parseBandcampAlbumPage(albumHtml);
              seedUrl = buildSeedUrl(albumData, artistMbid, albumUrl);
              trackCount = albumData.tracks.length || trackCount;
            } catch {
              // if fetch fails, build a minimal seed URL
              const params = new URLSearchParams();
              params.set("name", bc.title);
              params.set("type", "album");
              params.set("artist_credit.names.0.artist.name", artistName);
              if (artistMbid) {
                params.set("artist_credit.names.0.mbid", artistMbid);
              }
              if (bc.releaseDate) {
                const parts = bc.releaseDate.split(/[-/]/);
                if (parts[0]) params.set("events.0.date.year", parts[0]);
                if (parts[1]) params.set("events.0.date.month", parts[1]);
                if (parts[2]) params.set("events.0.date.day", parts[2]);
              }
              params.set("urls.0.url", albumUrl);
              params.set("urls.0.link_type", "85");
              params.set("edit_note", `Seeded from Bandcamp: ${albumUrl}`);
              seedUrl =
                `https://musicbrainz.org/release/add?${params.toString()}`;
            }

            missing.push({
              title: bc.title,
              bandcampUrl: albumUrl,
              releaseDate: bc.releaseDate || "",
              numTracks: trackCount,
              seedUrl,
            });
          }
        }

        const handle = await context.writeResource(
          "missingReleases",
          artistMbid || "unknown",
          {
            artist: artistName,
            artistMbid,
            bandcampUrl: args.bandcampUrl,
            mbReleaseCount: mbReleases.length,
            bcReleaseCount: bcArtist.discography.length,
            missing,
            matched,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "seed-all-missing": {
      description:
        "Generate MusicBrainz seed URLs for ALL missing releases of an artist (Bandcamp vs MusicBrainz)",
      arguments: z.object({
        bandcampUrl: z.string().describe("Bandcamp artist URL"),
        artistMbid: z.string().optional().describe("MusicBrainz artist MBID"),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;

        // Fetch bandcamp discography
        let bcUrl = args.bandcampUrl.replace(/\/$/, "");
        if (!bcUrl.endsWith("/music")) bcUrl += "/music";
        const bcHtml = await fetchPage(bcUrl);
        const bcArtist = parseBandcampArtistPage(bcHtml);

        let artistMbid = args.artistMbid;
        let artistName = bcArtist.name;
        if (!artistMbid && artistName) {
          const searchData = await mbFetch(userAgent, "/artist/", {
            query: artistName,
            limit: "5",
          });
          // deno-lint-ignore no-explicit-any -- dynamic MusicBrainz artist record
          const exact = (searchData.artists || []).find((a: any) =>
            normalizeTitle(a.name) === normalizeTitle(artistName)
          );
          if (exact) {
            artistMbid = exact.id;
            artistName = exact.name;
          }
        }

        // Get MB releases
        // deno-lint-ignore no-explicit-any -- dynamic MusicBrainz release groups
        const mbReleases: any[] = [];
        if (artistMbid) {
          let offset = 0;
          while (true) {
            const data = await mbFetch(userAgent, "/release-group/", {
              artist: artistMbid,
              limit: "100",
              offset: String(offset),
            });
            const rgs = data["release-groups"] || [];
            mbReleases.push(...rgs);
            if (rgs.length < 100) break;
            offset += 100;
          }
        }

        const mbTitlesNorm = new Set(
          mbReleases.map((r) => normalizeTitle(r.title)),
        );
        // deno-lint-ignore no-explicit-any -- assembled seed-URL release records
        const releases: any[] = [];

        for (const bc of bcArtist.discography) {
          if (mbTitlesNorm.has(normalizeTitle(bc.title))) continue;

          const albumUrl = bc.url.startsWith("http")
            ? bc.url
            : `${args.bandcampUrl.replace(/\/$/, "")}${bc.url}`;
          let seedUrl = "";
          let trackCount = bc.numTracks || 0;
          let releaseDate = bc.releaseDate || "";

          try {
            const albumHtml = await fetchPage(albumUrl);
            const albumData = parseBandcampAlbumPage(albumHtml);
            seedUrl = buildSeedUrl(albumData, artistMbid, albumUrl);
            trackCount = albumData.tracks.length || trackCount;
            releaseDate = albumData.releaseDate || releaseDate;
          } catch {
            const params = new URLSearchParams();
            params.set("name", bc.title);
            params.set("type", "album");
            params.set("artist_credit.names.0.artist.name", artistName);
            if (artistMbid) {
              params.set("artist_credit.names.0.mbid", artistMbid);
            }
            params.set("urls.0.url", albumUrl);
            params.set("urls.0.link_type", "85");
            params.set("edit_note", `Seeded from Bandcamp: ${albumUrl}`);
            seedUrl =
              `https://musicbrainz.org/release/add?${params.toString()}`;
          }

          releases.push({
            title: bc.title,
            bandcampUrl: albumUrl,
            seedUrl,
            trackCount,
            releaseDate,
            status: "ready",
          });
        }

        const handle = await context.writeResource(
          "seedUrls",
          artistMbid || "all-missing",
          {
            artist: artistName,
            artistMbid,
            bandcampUrl: args.bandcampUrl,
            releases,
            total: releases.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Generic search ---

    search: {
      description:
        "Search any entity type (area, event, instrument, place, series, work, etc.)",
      arguments: z.object({
        entity: z
          .enum([
            "area",
            "artist",
            "event",
            "instrument",
            "label",
            "place",
            "recording",
            "release",
            "release-group",
            "series",
            "work",
            "tag",
          ])
          .describe("Entity type to search"),
        query: z.string().describe("Lucene search query"),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { userAgent } = context.globalArgs;
        const params: Record<string, string> = { query: args.query };
        if (args.limit) params.limit = String(args.limit);
        if (args.offset) params.offset = String(args.offset);
        const data = await mbFetch(userAgent, `/${args.entity}/`, params);
        // MusicBrainz returns results in a key that varies by entity type
        const keys = Object.keys(data).filter((k) =>
          k !== "count" && k !== "offset" && k !== "created"
        );
        const resultsKey = keys[0] || args.entity;
        const results = Array.isArray(data[resultsKey]) ? data[resultsKey] : [];
        const handle = await context.writeResource(
          "search",
          `${args.entity}-search`,
          {
            query: args.query,
            entity: args.entity,
            results,
            count: data.count || results.length,
            offset: data.offset || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
