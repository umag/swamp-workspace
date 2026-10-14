import { z } from "npm:zod@4";

/**
 * @magistr/ryot — import a film history into a self-hosted Ryot
 * (https://github.com/IgnisDa/ryot).
 *
 * Builds one Ryot "generic JSON" export (`CompleteExport`), uploads it to
 * `POST /backend/upload` and starts `deployImportJob(source: GENERIC_JSON)`.
 * Ryot resolves every movie from TMDB itself, so items only carry TMDB ids.
 */

const GlobalArgsSchema = z.object({
  baseUrl: z.string().url().describe(
    "Ryot base URL, e.g. https://ryot.aopab.art",
  ),
  authToken: z.string().meta({ sensitive: true }).describe(
    "Auth token from Ryot Settings → Integrations → Generate auth token",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const LetterboxdFilmSchema = z.object({
  name: z.string(),
  year: z.number().nullable(),
  uri: z.string(),
  date: z.string().nullable(),
});

/** The `exportSnapshot` written by `@jamesakeech/letterboxd` `import_export`. */
const LetterboxdSnapshotSchema = z.object({
  ratings: z.array(LetterboxdFilmSchema.extend({ rating: z.number() })),
  watched: z.array(LetterboxdFilmSchema),
  watchlist: z.array(LetterboxdFilmSchema),
}).passthrough();

const OwnedFilmSchema = z.object({
  tmdbId: z.number().int(),
  title: z.string().optional(),
});

const LetterboxdMapSchema = z.object({
  map: z.record(
    z.string(),
    z.object({
      tmdbId: z.number().nullable(),
      tmdbType: z.string().nullable(),
    }),
  ).describe("Letterboxd URI → TMDB id (null = page had no movie id)"),
  updatedAt: z.iso.datetime(),
});

const ImportResultSchema = z.object({
  dryRun: z.boolean(),
  movies: z.number().int().describe("Distinct movies in the export"),
  seen: z.number().int(),
  rated: z.number().int(),
  watchlist: z.number().int(),
  owned: z.number().int(),
  unresolved: z.array(z.object({ name: z.string(), reason: z.string() })),
  importJobDeployed: z.boolean(),
  finishedAt: z.iso.datetime(),
});

const ImportReportsSchema = z.object({
  reports: z.array(z.record(z.string(), z.unknown())),
  fetchedAt: z.iso.datetime(),
});

type LetterboxdMap = z.infer<typeof LetterboxdMapSchema>["map"];
type ImportResult = z.infer<typeof ImportResultSchema>;
type Unresolved = ImportResult["unresolved"];

/** Letterboxd 0.5–5 stars → Ryot's 0–100 rating scale. */
export function letterboxdToRyotRating(stars: number): number | null {
  if (!Number.isFinite(stars) || stars <= 0) return null;
  return Math.min(100, Math.round(stars * 20));
}

/** TMDB id + type from a Letterboxd film page (`data-tmdb-id`). */
export function parseTmdbFromFilmPage(
  html: string,
): { tmdbId: number | null; tmdbType: string | null } {
  const id = html.match(/data-tmdb-id="(\d+)"/);
  const type = html.match(/data-tmdb-type="([a-z]+)"/);
  return {
    tmdbId: id ? Number(id[1]) : null,
    tmdbType: type ? type[1] : null,
  };
}

const CHALLENGE_NEEDLES = [
  "just a moment...",
  "enable javascript and cookies to continue",
  "_cf_chl_opt",
];

/** True when `html` is a Cloudflare interstitial rather than the real page. */
export function isChallengePage(html: string): boolean {
  const lower = html.toLowerCase();
  return CHALLENGE_NEEDLES.some((n) => lower.includes(n));
}

const LETTERBOXD_HOSTS = new Set([
  "letterboxd.com",
  "www.letterboxd.com",
  "boxd.it",
]);

/**
 * True when `uri` is an https URL on a Letterboxd host. Snapshot URIs are
 * handed to `curl` as an argument, so anything else (an option-looking
 * `-o /path`, a `file://` URL, another host) must never reach it.
 */
export function isLetterboxdUri(uri: string): boolean {
  if (uri.startsWith("-")) return false;
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && LETTERBOXD_HOSTS.has(u.hostname) &&
      u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Retry back-off for Letterboxd fetches; tests set `retryDelayMs` to 0. */
export const curlTiming = { retryDelayMs: 1000 };

/**
 * Fetch a Letterboxd page with the host curl binary: Deno's fetch draws
 * Cloudflare challenges that curl's TLS fingerprint does not.
 */
async function curlLetterboxd(url: string): Promise<string> {
  if (!isLetterboxdUri(url)) {
    throw new Error(`not a Letterboxd https URL: ${JSON.stringify(url)}`);
  }
  const marker = "\n<<<HTTP_STATUS:";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await new Deno.Command("curl", {
      args: [
        "-sL",
        "--max-time",
        "30",
        "-A",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "--proto",
        "=https",
        "-w",
        `${marker}%{http_code}>>>`,
        url,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    const at = text.lastIndexOf(marker);
    const status = at >= 0 ? Number(text.slice(at + marker.length, -3)) : 0;
    const body = at >= 0 ? text.slice(0, at) : text;
    if (out.success && status === 200 && !isChallengePage(body)) return body;
    if (status === 404) throw new Error(`Letterboxd 404 for ${url}`);
    if (attempt < 3) {
      await new Promise((r) =>
        setTimeout(r, curlTiming.retryDelayMs * attempt)
      );
    }
  }
  throw new Error(`Letterboxd fetch failed after 3 attempts: ${url}`);
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

type MovieEntry = {
  title: string;
  seen: boolean;
  rating: number | null;
  collections: Set<string>;
};

/** Ryot `CollectionToEntityDetails`; the importer only reads the name. */
function collectionRef(name: string, now: string) {
  return {
    collection_id: "",
    collection_name: name,
    created_on: now,
    creator_user_id: "",
    last_updated_on: now,
    information: null,
  };
}

/** Build a Ryot `CompleteExport` holding only movie metadata items. */
export function buildCompleteExport(
  movies: Map<number, MovieEntry>,
  now: string,
): Record<string, unknown> {
  const metadata = [...movies].map(([tmdbId, m]) => ({
    identifier: String(tmdbId),
    source: "tmdb",
    lot: "movie",
    source_id: m.title,
    seen_history: m.seen ? [{ ended_on: null, state: "completed" }] : [],
    reviews: m.rating === null ? [] : [{ rating: String(m.rating) }],
    collections: [...m.collections].map((c) => collectionRef(c, now)),
  }));
  return {
    metadata,
    collections: null,
    exercises: null,
    measurements: null,
    metadata_groups: null,
    people: null,
    workouts: null,
    workout_templates: null,
  };
}

class RyotClient {
  constructor(private readonly g: GlobalArgs) {}

  private url(path: string): string {
    return this.g.baseUrl.replace(/\/+$/, "") + path;
  }

  private get auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.g.authToken}` };
  }

  async gql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const res = await fetch(this.url("/backend/graphql"), {
      method: "POST",
      headers: { ...this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Ryot GraphQL HTTP ${res.status}: ${text}`);
    let body: {
      data?: Record<string, unknown>;
      errors?: { message: string }[];
    };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Ryot GraphQL returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (body.errors?.length) {
      throw new Error(
        `Ryot GraphQL: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return body.data ?? {};
  }

  /** Upload a file to Ryot's temp dir; returns the server-side path. */
  async upload(name: string, content: string): Promise<string> {
    const form = new FormData();
    form.append(
      "files[]",
      new Blob([content], { type: "application/json" }),
      name,
    );
    const res = await fetch(this.url("/backend/upload"), {
      method: "POST",
      headers: this.auth,
      body: form,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Ryot upload HTTP ${res.status}: ${text}`);
    let paths: unknown;
    try {
      paths = JSON.parse(text);
    } catch {
      throw new Error(`Ryot upload returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (
      !Array.isArray(paths) || typeof paths[0] !== "string" || paths[0] === ""
    ) {
      throw new Error("Ryot upload returned no path");
    }
    return paths[0];
  }
}

type Ctx = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  logger?: { info: (msg: string, ...args: unknown[]) => void };
};

/** Resolve Letterboxd URIs to TMDB ids, reusing and extending the cache. */
async function resolveLetterboxd(
  uris: string[],
  ctx: Ctx,
  unresolved: Unresolved,
): Promise<{ map: LetterboxdMap; handle: unknown }> {
  const cached = (await ctx.readResource?.("letterboxd-tmdb-map"))?.map as
    | LetterboxdMap
    | undefined;
  const map: LetterboxdMap = { ...(cached ?? {}) };
  const todo = [...new Set(uris)].filter((u) => !(u in map));
  ctx.logger?.info(`Resolving ${todo.length} Letterboxd URIs`);
  await pool(todo, 3, async (uri) => {
    try {
      map[uri] = parseTmdbFromFilmPage(await curlLetterboxd(uri));
    } catch (e) {
      unresolved.push({ name: uri, reason: String(e) });
    }
  });
  const handle = await ctx.writeResource(
    "letterboxdMap",
    "letterboxd-tmdb-map",
    { map, updatedAt: new Date().toISOString() },
  );
  return { map, handle };
}

const DEPLOY_IMPORT = `mutation DeployImport($input: DeployImportJobInput!) {
  deployImportJob(input: $input)
}`;

const IMPORT_REPORTS = `query { userImportReports { id source progress
  startedOn finishedOn wasSuccess details { import { total }
  failedItems { identifier step error } } } }`;

/**
 * The `@magistr/ryot` model: `import_films` sends a Letterboxd snapshot plus
 * owned films to Ryot as one generic-JSON import job; `import_reports` reads
 * Ryot's import job reports back.
 */
export const model = {
  type: "@magistr/ryot",
  version: "2026.10.10.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.10.1",
      description: "Initial release",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    letterboxdMap: {
      description:
        "Cache of Letterboxd URI → TMDB id, scraped from Letterboxd film " +
        "pages so re-imports don't re-fetch them",
      schema: LetterboxdMapSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    importResult: {
      description: "What one import run sent to Ryot, and what it skipped",
      schema: ImportResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    importReports: {
      description: "Ryot's own import job reports (progress, failed items)",
      schema: ImportReportsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    import_films: {
      description:
        "Import a Letterboxd export snapshot plus owned films into Ryot as " +
        "one generic-JSON import job. Watched and rated films get one " +
        "undated seen entry, ratings become 0–100 (stars × 20), watchlist " +
        "films go to the Watchlist collection, owned films to the Owned " +
        "collection (and are marked seen when `ownedAsSeen`). Ryot does not " +
        "dedupe seen entries across imports, so a completed non-dry run " +
        "blocks later runs unless `force` is set.",
      arguments: z.object({
        snapshot: LetterboxdSnapshotSchema.describe(
          "The exportSnapshot attributes, e.g. " +
            '${{ data.latest("letterboxd", "export").attributes }}',
        ),
        owned: z.array(OwnedFilmSchema).default([]).describe(
          "Owned films with a TMDB movie id (e.g. from @magistr/film-library)",
        ),
        ownedAsSeen: z.boolean().default(false),
        dryRun: z.boolean().default(false),
        force: z.boolean().default(false),
      }),
      execute: async (
        args: {
          snapshot: z.infer<typeof LetterboxdSnapshotSchema>;
          owned: z.infer<typeof OwnedFilmSchema>[];
          ownedAsSeen: boolean;
          dryRun: boolean;
          force: boolean;
        },
        ctx: Ctx,
      ) => {
        const previous = await ctx.readResource?.("films");
        if (
          !args.dryRun && !args.force && previous &&
          previous.importJobDeployed === true
        ) {
          throw new Error(
            `Films were already imported at ${previous.finishedAt}; ` +
              "re-importing would duplicate seen entries. Pass force=true " +
              "to import anyway.",
          );
        }

        const s = args.snapshot;
        const unresolved: Unresolved = [];
        const { map, handle: mapHandle } = await resolveLetterboxd(
          [...s.watched, ...s.ratings, ...s.watchlist].map((f) => f.uri),
          ctx,
          unresolved,
        );

        const movies = new Map<number, MovieEntry>();
        const entry = (tmdbId: number, title: string) => {
          let m = movies.get(tmdbId);
          if (!m) {
            m = { title, seen: false, rating: null, collections: new Set() };
            movies.set(tmdbId, m);
          }
          return m;
        };
        const tmdb = (f: { name: string; uri: string }) => {
          const m = map[f.uri];
          if (!m) return null;
          if (m.tmdbId === null || m.tmdbType !== "movie") {
            unresolved.push({
              name: f.name,
              reason: m.tmdbId === null ? "no TMDB id" : `TMDB ${m.tmdbType}`,
            });
            return null;
          }
          return m.tmdbId;
        };
        for (const f of s.watched) {
          const t = tmdb(f);
          if (t) entry(t, f.name).seen = true;
        }
        for (const f of s.ratings) {
          const t = tmdb(f);
          if (!t) continue;
          const m = entry(t, f.name);
          m.seen = true;
          m.rating = letterboxdToRyotRating(f.rating);
        }
        for (const f of s.watchlist) {
          const t = tmdb(f);
          if (t) entry(t, f.name).collections.add("Watchlist");
        }
        for (const f of args.owned) {
          const m = entry(f.tmdbId, f.title ?? String(f.tmdbId));
          m.collections.add("Owned");
          if (args.ownedAsSeen) m.seen = true;
        }
        // A watched film does not belong on the watchlist.
        for (const m of movies.values()) {
          if (m.seen) m.collections.delete("Watchlist");
        }

        let deployed = false;
        if (!args.dryRun) {
          const client = new RyotClient(ctx.globalArgs);
          const now = new Date().toISOString();
          const path = await client.upload(
            "swamp-films.json",
            JSON.stringify(buildCompleteExport(movies, now)),
          );
          await client.gql(DEPLOY_IMPORT, {
            input: { source: "GENERIC_JSON", path: { exportPath: path } },
          });
          deployed = true;
        }

        const all = [...movies.values()];
        const result: ImportResult = {
          dryRun: args.dryRun,
          movies: movies.size,
          seen: all.filter((m) => m.seen).length,
          rated: all.filter((m) => m.rating !== null).length,
          watchlist: all.filter((m) => m.collections.has("Watchlist")).length,
          owned: all.filter((m) => m.collections.has("Owned")).length,
          unresolved: dedupe(unresolved),
          importJobDeployed: deployed,
          finishedAt: new Date().toISOString(),
        };
        const resultHandle = await ctx.writeResource(
          "importResult",
          args.dryRun ? "films-dry-run" : "films",
          result,
        );
        return { dataHandles: [mapHandle, resultHandle] };
      },
    },
    import_reports: {
      description:
        "Fetch Ryot's import job reports (progress, success, failed items)",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const data = await new RyotClient(ctx.globalArgs).gql(IMPORT_REPORTS);
        const handle = await ctx.writeResource("importReports", "reports", {
          reports: (data.userImportReports ?? []) as Record<string, unknown>[],
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

function dedupe(items: Unresolved): Unresolved {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.name}|${i.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
