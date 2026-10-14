import { z } from "npm:zod@4";

// ─── NS / NS International trip planner ──────────────────────────────────────
//
// Wraps the official NS Reisinformatie API (apiportal.ns.nl). It is the only
// public, supported NS interface and it covers PLANNING only — journey advice,
// prices, live departures and disruptions — for domestic NL trains AND the
// international connections NS International sells (to BE/DE/FR, Eurostar, ICE).
//
// There is NO public booking/payment API for NS or NS International, so this
// model does not (and cannot) purchase tickets. Each planned option carries a
// `bookingUrl` deep-link into the NS / NS International site where the user
// completes the booking with their own account and payment method.
//
// Auth: a free "Reisinformatie API" subscription key from
// https://apiportal.ns.nl (header `Ocp-Apim-Subscription-Key`). Store it in a
// vault and pass it into globalArguments.apiKey via a `${{ vault.get(...) }}`
// expression — never a literal.

/** Default NS Reisinformatie API base URL. */
export const DEFAULT_BASE =
  "https://gateway.apiportal.ns.nl/reisinformatie-api/api";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  apiKey: z.string().describe(
    "NS Reisinformatie API subscription key (Ocp-Apim-Subscription-Key). " +
      "Supply via ${{ vault.get(<vault>, NS_API_KEY) }}, never a literal.",
  ),
  baseUrl: z.string().default(DEFAULT_BASE).describe(
    "Reisinformatie API base URL.",
  ),
  userAgent: z.string().default("swamp-ns-international/1.0").describe(
    "User-Agent header.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StationSchema = z.object({
  code: z.string(),
  uic: z.string(),
  name: z.string(),
  country: z.string(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});
/** One entry of the NS station directory, normalised. */
export type Station = z.infer<typeof StationSchema>;

const LegSchema = z.object({
  product: z.string(), // e.g. "Intercity direct", "ICE International"
  operator: z.string(),
  fromName: z.string(),
  fromTrack: z.string().optional(),
  departPlanned: z.string(),
  departActual: z.string().optional(),
  toName: z.string(),
  toTrack: z.string().optional(),
  arrivePlanned: z.string(),
  arriveActual: z.string().optional(),
  direction: z.string().optional(),
  crowdForecast: z.string().optional(),
  cancelled: z.boolean().optional(),
});

const OptionSchema = z.object({
  departPlanned: z.string(),
  arrivePlanned: z.string(),
  durationMinutes: z.number().optional(),
  transfers: z.number(),
  status: z.string().optional(),
  crowdForecast: z.string().optional(),
  priceEuro: z.number().optional(), // cheapest fare found, in EUR
  priceLabel: z.string().optional(), // which fare that price is
  optimal: z.boolean().optional(),
  legs: z.array(LegSchema),
});

// ─── HTTP ────────────────────────────────────────────────────────────────────

/**
 * Join the configured base URL and an API path, tolerating trailing slashes
 * on the base (so `https://h/api/` + `/v3/trips` never yields `//v3/trips`)
 * and setting every non-empty query parameter.
 */
export function buildUrl(
  base: string,
  path: string,
  params: Record<string, string> = {},
): URL {
  const url = new URL(`${base.replace(/\/+$/, "")}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url;
}

async function nsFetch(
  ga: GlobalArgs,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  if (!ga.apiKey || !ga.apiKey.trim()) {
    throw new Error(
      "NS apiKey is empty — set globalArguments.apiKey via a vault expression",
    );
  }
  const url = buildUrl(ga.baseUrl, path, params);
  const resp = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": ga.apiKey,
      "User-Agent": ga.userAgent,
      "Accept": "application/json",
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `NS API ${resp.status} for ${path}: ${text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `NS API returned non-JSON for ${path}: ${text.slice(0, 200)}`,
    );
  }
}

// ─── Station resolution ──────────────────────────────────────────────────────

interface RawStation {
  code?: string;
  UICCode?: string;
  namen?: { lang?: string; middel?: string; kort?: string };
  land?: string;
  lat?: number;
  lng?: number;
}

/**
 * Normalise the raw `/v2/stations` payload into {@link Station} rows. Rows
 * without a UIC code are dropped (the journey planner routes by UIC only).
 */
export function parseStations(data: unknown): Station[] {
  const payload = (data && typeof data === "object")
    ? (data as { payload?: unknown }).payload
    : undefined;
  const rows: RawStation[] = Array.isArray(payload) ? payload : [];
  return rows.filter((r) => r && typeof r === "object").map((r) => ({
    code: r.code ?? "",
    uic: r.UICCode ?? "",
    name: r.namen?.lang ?? r.namen?.middel ?? r.code ?? "",
    country: r.land ?? "",
    lat: r.lat,
    lng: r.lng,
  })).filter((s) => s.uic);
}

async function fetchStations(ga: GlobalArgs): Promise<Station[]> {
  return parseStations(await nsFetch(ga, "/v2/stations", {}));
}

// Load stored station index if a `stations` sync ran; else fetch live.
async function loadStations(
  ga: GlobalArgs,
  context: ExecContext,
): Promise<Station[]> {
  try {
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      "station-index",
    );
    if (raw) {
      const idx = JSON.parse(new TextDecoder().decode(raw)) as {
        stations?: Station[];
      };
      if (idx.stations && idx.stations.length) return idx.stations;
    }
  } catch { /* fall through to live fetch */ }
  return await fetchStations(ga);
}

/**
 * Resolve a user-supplied "from"/"to" (UIC digits, station code, or name) to
 * a station. Exact code/UIC first, then case-insensitive exact name, then a
 * unique substring match. Ambiguous, blank or missing input throws.
 */
export function resolveStation(input: string, stations: Station[]): Station {
  const q = input.trim();
  if (!q) throw new Error("Station must not be blank");
  if (/^\d{6,7}$/.test(q)) {
    const byUic = stations.find((s) => s.uic === q);
    if (byUic) return byUic;
    // Unknown UIC: the journey planner routes to any European UIC even when the
    // (NL-centric) station name directory doesn't list it. Pass it through.
    // country "?" flags it international so the booking link points to NS Int'l.
    return { code: q, uic: q, name: `UIC ${q}`, country: "?" };
  }
  const upper = q.toUpperCase();
  const byCode = stations.find((s) => s.code && s.code.toUpperCase() === upper);
  if (byCode) return byCode;

  const lower = q.toLowerCase();
  const exact = stations.filter((s) => s.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];

  const subs = stations.filter((s) => s.name.toLowerCase().includes(lower));
  if (subs.length === 1) return subs[0];
  if (subs.length > 1) {
    // Prefer an exact-word start match to disambiguate "Amsterdam" etc.
    const starts = subs.filter((s) => s.name.toLowerCase().startsWith(lower));
    if (starts.length === 1) return starts[0];
    throw new Error(
      `Ambiguous station "${input}" — matches: ${
        subs.slice(0, 8).map((s) => `${s.name} (${s.code || s.uic})`).join(", ")
      }${subs.length > 8 ? " …" : ""}. Use a code/UIC or a more specific name.`,
    );
  }
  throw new Error(
    `No station matched "${input}". Run the \`stations\` method with a query to find the code.`,
  );
}

// ─── Trip parsing ──────────────────────────────────────────────────────────

/** A fare as returned on a raw `/v3/trips` trip. */
export interface RawFare {
  priceInCents?: number;
  product?: string;
  travelClass?: string;
  discountType?: string;
}
/** A leg as returned on a raw `/v3/trips` trip. */
export interface RawLeg {
  product?: { displayName?: string; operatorName?: string };
  origin?: {
    name?: string;
    plannedDateTime?: string;
    actualDateTime?: string;
    plannedTrack?: string;
  };
  destination?: {
    name?: string;
    plannedDateTime?: string;
    actualDateTime?: string;
    plannedTrack?: string;
  };
  direction?: string;
  crowdForecast?: string;
  cancelled?: boolean;
}
/** A trip as returned by `/v3/trips`. */
export interface RawTrip {
  legs?: RawLeg[];
  plannedDurationInMinutes?: number;
  transfers?: number;
  status?: string;
  crowdForecast?: string;
  optimal?: boolean;
  productFare?: RawFare;
  fares?: RawFare[];
}

/**
 * Pick the cheapest positively-priced fare among `productFare` and `fares[]`,
 * returned in EUR with a human label (class / product / discount).
 */
export function cheapestFare(trip: RawTrip): { euro?: number; label?: string } {
  const candidates: RawFare[] = [];
  if (trip.productFare) candidates.push(trip.productFare);
  if (Array.isArray(trip.fares)) candidates.push(...trip.fares);
  const priced = candidates.filter((f) =>
    !!f && typeof f.priceInCents === "number" && f.priceInCents > 0
  );
  if (!priced.length) return {};
  priced.sort((a, b) => (a.priceInCents ?? 0) - (b.priceInCents ?? 0));
  const best = priced[0];
  const label = [best.travelClass, best.product, best.discountType]
    .filter((x) => x && x !== "NO_DISCOUNT").join(" / ");
  return { euro: (best.priceInCents ?? 0) / 100, label: label || undefined };
}

/** Map one raw `/v3/trips` trip into the stored journey-option shape. */
export function parseTrip(trip: RawTrip): z.infer<typeof OptionSchema> {
  const rawLegs = Array.isArray(trip.legs) ? trip.legs : [];
  const legs = rawLegs.filter((l) => !!l && typeof l === "object").map((l) => ({
    product: l.product?.displayName ?? "?",
    operator: l.product?.operatorName ?? "?",
    fromName: l.origin?.name ?? "?",
    fromTrack: l.origin?.plannedTrack,
    departPlanned: l.origin?.plannedDateTime ?? "",
    departActual: l.origin?.actualDateTime,
    toName: l.destination?.name ?? "?",
    toTrack: l.destination?.plannedTrack,
    arrivePlanned: l.destination?.plannedDateTime ?? "",
    arriveActual: l.destination?.actualDateTime,
    direction: l.direction,
    crowdForecast: l.crowdForecast,
    cancelled: l.cancelled,
  }));
  const fare = cheapestFare(trip);
  return {
    departPlanned: legs[0]?.departPlanned ?? "",
    arrivePlanned: legs[legs.length - 1]?.arrivePlanned ?? "",
    durationMinutes: trip.plannedDurationInMinutes,
    transfers: trip.transfers ?? Math.max(0, legs.length - 1),
    status: trip.status,
    crowdForecast: trip.crowdForecast,
    priceEuro: fare.euro,
    priceLabel: fare.label,
    optimal: trip.optimal,
    legs,
  };
}

// International (cross-border) options should be booked on nsinternational.com;
// purely domestic NL on ns.nl. Both open the planner/booking flow for the user.
/** Booking deep-link: NS International for cross-border trips, else ns.nl. */
export function bookingUrl(from: Station, to: Station): string {
  const international = from.country !== "NL" || to.country !== "NL";
  return international
    ? "https://www.nsinternational.com/en/book-a-train-ticket"
    : "https://www.ns.nl/en/travel-information/travel-planner";
}

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * True for an ISO-8601 date or date-time (`2026-09-22`,
 * `2026-09-22T08:00:00+02:00`, `…Z`) that also parses to a real instant.
 * `Date` alone is too lenient — it accepts strings like `now&x=0`.
 */
export function isIsoDateTime(s: string): boolean {
  return ISO_DATE_TIME.test(s) && !isNaN(new Date(s).getTime());
}

/** Format an ISO timestamp as UTC `HH:MM`; unparseable input is echoed. */
export function fmtTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 16); // HH:MM (UTC-normalised for logs)
}

// ─── Execute context (minimal surface we use) ────────────────────────────────

interface ExecContext {
  globalArgs: GlobalArgs;
  modelType: string;
  modelId: string;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  dataRepository: {
    getContent: (
      type: string,
      id: string,
      name: string,
    ) => Promise<Uint8Array | null>;
  };
}

// ─── Model ───────────────────────────────────────────────────────────────────

/** The `@magistr/ns-international` swamp model definition. */
export const model = {
  type: "@magistr/ns-international",
  version: "2026.09.19.1",
  upgrades: [
    {
      toVersion: "2026.09.19.1",
      description: "Initial release",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  description:
    "Plan train trips on NS and NS International via the official NS " +
    "Reisinformatie API (journey advice, prices, live departures, " +
    "disruptions). Planning only — NS exposes no public booking API, so each " +
    "option carries a deep-link into the NS / NS International site to complete " +
    "the booking. Needs a free apiportal.ns.nl subscription key.",
  globalArguments: GlobalArgsSchema,
  resources: {
    "station-index": {
      description:
        "Cached station directory (code/UIC/name/country) for name resolution",
      schema: z.object({
        syncedAt: z.string(),
        count: z.number(),
        stations: z.array(StationSchema),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "trip-plan": {
      description: "One journey-planning search result set",
      schema: z.object({
        searchedAt: z.string(),
        from: z.string(),
        to: z.string(),
        fromCode: z.string(),
        toCode: z.string(),
        dateTime: z.string(),
        searchForArrival: z.boolean(),
        international: z.boolean(),
        bookingUrl: z.string(),
        count: z.number(),
        options: z.array(OptionSchema),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    "disruptions": {
      description: "Snapshot of active disruptions / maintenance",
      schema: z.object({
        checkedAt: z.string(),
        count: z.number(),
        items: z.array(z.object({
          id: z.string(),
          type: z.string(),
          title: z.string(),
          isActive: z.boolean(),
          phase: z.string().optional(),
        })),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    stations: {
      description:
        "Fetch the NS station directory and cache it as `station-index` for " +
        "fast name→code resolution. With `query`, also print matching stations " +
        "(code, UIC, name, country) without needing to remember codes.",
      arguments: z.object({
        query: z.string().optional().describe(
          "Case-insensitive substring to list matching stations.",
        ),
      }),
      execute: async (
        args: { query?: string },
        context: ExecContext,
      ) => {
        const ga = context.globalArgs;
        const stations = await fetchStations(ga);
        const now = new Date().toISOString();
        await context.writeResource("station-index", "station-index", {
          syncedAt: now,
          count: stations.length,
          stations,
        });
        console.log(`Cached ${stations.length} stations.`);
        let matches = stations;
        if (args.query) {
          const q = args.query.toLowerCase();
          matches = stations.filter((s) =>
            s.name.toLowerCase().includes(q) ||
            s.code.toLowerCase().includes(q)
          );
          console.log(`\n${matches.length} match "${args.query}":`);
          for (const s of matches.slice(0, 40)) {
            console.log(
              `  ${(s.code || "—").padEnd(6)} ${
                s.uic.padEnd(8)
              } ${s.name} [${s.country}]`,
            );
          }
        }
        return {
          syncedAt: now,
          count: stations.length,
          matched: matches.length,
        };
      },
    },

    plan: {
      description:
        "Plan trips between two stations. `from`/`to` accept a station name, " +
        "NS code (e.g. ASD), or UIC code. Returns ranked journey options with " +
        "times, transfers, per-leg train/operator, crowding, cheapest fare " +
        "found, and a bookingUrl to finish the purchase on NS / NS " +
        "International. Works for domestic NL and NS International routes.",
      arguments: z.object({
        from: z.string().describe("Origin: station name, code, or UIC."),
        to: z.string().describe("Destination: station name, code, or UIC."),
        dateTime: z.string().optional().describe(
          "ISO-8601 departure (or arrival) time. Defaults to now.",
        ),
        searchForArrival: z.boolean().default(false).describe(
          "Treat dateTime as the desired ARRIVAL time instead of departure.",
        ),
        travelClass: z.number().optional().describe(
          "1 or 2 (travel class). Omit for the API default.",
        ),
      }),
      execute: async (
        args: {
          from: string;
          to: string;
          dateTime?: string;
          searchForArrival: boolean;
          travelClass?: number;
        },
        context: ExecContext,
      ) => {
        const ga = context.globalArgs;
        if (
          args.travelClass !== undefined && args.travelClass !== 1 &&
          args.travelClass !== 2
        ) {
          throw new Error(
            `travelClass must be 1 or 2, got ${args.travelClass}`,
          );
        }
        if (
          args.dateTime && args.dateTime.trim() &&
          !isIsoDateTime(args.dateTime.trim())
        ) {
          throw new Error(`dateTime is not ISO-8601: "${args.dateTime}"`);
        }
        const stations = await loadStations(ga, context);
        const from = resolveStation(args.from, stations);
        const to = resolveStation(args.to, stations);
        // Treat empty/blank as "now" so workflow inputs can default dateTime to "".
        const dateTime = args.dateTime && args.dateTime.trim()
          ? args.dateTime
          : new Date().toISOString();

        const params: Record<string, string> = {
          originUicCode: from.uic,
          destinationUicCode: to.uic,
          dateTime,
          searchForArrival: String(args.searchForArrival),
        };
        if (args.travelClass) params.travelClass = String(args.travelClass);

        const data = await nsFetch(ga, "/v3/trips", params);
        const rawTrips = data && typeof data === "object"
          ? (data as { trips?: unknown }).trips
          : undefined;
        const options = (Array.isArray(rawTrips) ? rawTrips : [])
          .filter((t): t is RawTrip => !!t && typeof t === "object")
          .map(parseTrip);
        const international = from.country !== "NL" || to.country !== "NL";
        const url = bookingUrl(from, to);
        const now = new Date().toISOString();

        console.log(
          `\n${from.name} → ${to.name} (${
            args.searchForArrival ? "arrive by" : "depart"
          } ${dateTime})${international ? " [NS International]" : ""}\n`,
        );
        for (const o of options) {
          const price = o.priceEuro !== undefined
            ? `€${o.priceEuro.toFixed(2)}${
              o.priceLabel ? ` (${o.priceLabel})` : ""
            }`
            : "price n/a";
          console.log(
            `  ${fmtTime(o.departPlanned)}→${fmtTime(o.arrivePlanned)}  ` +
              `${o.durationMinutes ?? "?"}min  ${o.transfers} transfer(s)  ` +
              `${price}  ${o.legs.map((l) => l.product).join(" → ")}` +
              `${o.status && o.status !== "NORMAL" ? `  [${o.status}]` : ""}`,
          );
        }
        console.log(`\nBook: ${url}`);

        const result = {
          searchedAt: now,
          from: from.name,
          to: to.name,
          fromCode: from.code || from.uic,
          toCode: to.code || to.uic,
          dateTime,
          searchForArrival: args.searchForArrival,
          international,
          bookingUrl: url,
          count: options.length,
          options,
        };
        await context.writeResource(
          "trip-plan",
          `${from.code || from.uic}-${to.code || to.uic}-${now}`,
          result,
        );
        return result;
      },
    },

    disruptions: {
      description:
        "Fetch active disruptions and maintenance works. Optional `isActive` " +
        "filter (default true) and `type` filter (e.g. DISRUPTION, MAINTENANCE, " +
        "CALAMITY). Useful to sanity-check a route before travel.",
      arguments: z.object({
        isActive: z.boolean().default(true).describe(
          "Only currently active disruptions.",
        ),
        type: z.string().optional().describe(
          "Filter by disruption type (DISRUPTION, MAINTENANCE, CALAMITY).",
        ),
      }),
      execute: async (
        args: { isActive: boolean; type?: string },
        context: ExecContext,
      ) => {
        const ga = context.globalArgs;
        const params: Record<string, string> = {
          isActive: String(args.isActive),
        };
        if (args.type) params.type = args.type;
        const data = await nsFetch(ga, "/v3/disruptions", params) as Array<{
          id?: string;
          type?: string;
          title?: string;
          isActive?: boolean;
          phase?: { label?: string };
        }>;
        const items = (Array.isArray(data) ? data : []).filter((d) =>
          !!d && typeof d === "object"
        ).map((d) => ({
          id: String(d.id ?? ""),
          type: d.type ?? "?",
          title: d.title ?? "",
          isActive: d.isActive ?? false,
          phase: d.phase?.label,
        }));
        const now = new Date().toISOString();
        console.log(`${items.length} disruption(s):`);
        for (const it of items.slice(0, 40)) {
          console.log(
            `  [${it.type}] ${it.title}${it.phase ? ` — ${it.phase}` : ""}`,
          );
        }
        const summary = { checkedAt: now, count: items.length, items };
        // "latest" is a reserved swamp data name — writing it fails the run.
        await context.writeResource("disruptions", "current", summary);
        return summary;
      },
    },
  },
};
