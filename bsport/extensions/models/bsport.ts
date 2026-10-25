/**
 * bsport — client for the bsport member/consumer API that powers the studio
 * customer portal (backoffice.bsport.io/c/<company>/booking). It reads the class
 * calendar, the signed-in member's own bookings, and their waitlist positions.
 *
 * Auth: every request carries `Authorization: Token <token>` (a DRF token). The
 * recommended setup is to configure `token` directly (from the portal's
 * localStorage `bsport:http:token`) — set it via a vault ref. Email/password
 * login (`authPath` + /authentication/signin/with-login/) is supported as a
 * fallback but the exact login path varies by tenant; the token path is what is
 * validated. The token is never stored in swamp data.
 *
 * Read methods (fan-out factories — one invocation writes one resource per item
 * plus a single `summary`, so the model lock is acquired once):
 *   - `listOffers`           — GET /book/v1/offer/            (calendar events,
 *                              filtered by date window / establishment / level)
 *   - `getOffers`            — GET /book/v1/offer/?id__in=…   (specific classes)
 *   - `listEstablishments`   — GET /book/v1/establishment/    (venues → names)
 *   - `listFutureBookings`   — GET /book/v1/booking/ (before_date_end; my
 *                              upcoming). Needs `memberId`.
 *   - `listPastBookings`     — GET /book/v1/booking/ (after_date_end; my
 *                              history). Needs `memberId`.
 *   - `listMyWaitlist`       — GET /book/v1/waiting-list/booking-option/ +
 *                              waiting_list_position_list (my waitlist, no offer
 *                              ids needed). Needs `consumerId`.
 *   - `listWaitlist`         — GET /book/v1/offer/waiting_list_position_list/
 *                              ?id__in=… (positions for given offer ids)
 *   - `listRegisteredOffers` — GET /book/v1/offer/registered/ (offers I'm on)
 *
 * Each `offer` carries capacity and waitlist fields (`effectif` = capacity,
 * `validated_booking_count` = booked, `full`, `waiting_list_max_size`,
 * `is_waiting_list_full`), so a full class and its waitlist are visible without
 * a separate call. `level` 2 = Beginner (Débutant), 3 = Intermediate, 4 =
 * Advanced.
 *
 * Booking and cancellation (writes) go through bsport's basket/funnel endpoints
 * (`/book/v1/offer/user_registration/`, `/book/v1/booking/cancel_multiple_offers/`)
 * and are intentionally NOT implemented here yet: their payloads must be
 * captured from a live, supervised booking before they can be trusted against a
 * real member account.
 *
 * The shared HTTP helper retries transparently on HTTP 429, backing off per the
 * `Retry-After` header, and never echoes the token or password in an error.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ============================================================================
// Global arguments
// ============================================================================

const GlobalArgsSchema = z.object({
  token: z.string().min(1).meta({ sensitive: true }).optional().describe(
    "A DRF auth token (sent as `Authorization: Token <token>`). When set, the " +
      "model uses it directly and skips the email/password login. Grab it from " +
      "the portal (localStorage `bsport:http:token`). Use a vault reference: " +
      "${{ vault.get(bsport, TOKEN) }}",
  ),
  email: z.string().min(1).optional().describe(
    "Member login email (used only when `token` is not set). Vault ref: " +
      "${{ vault.get(bsport, EMAIL) }}",
  ),
  password: z.string().min(1).meta({ sensitive: true }).optional().describe(
    "Member login password (used only when `token` is not set). Vault ref: " +
      "${{ vault.get(bsport, PASSWORD) }}",
  ),
  companyId: z.string().min(1).describe(
    'Studio company id (the `company` filter on the calendar), e.g. "1234".',
  ),
  memberId: z.string().min(1).optional().describe(
    "This member's numeric id (the `member` filter on /booking/). Required by " +
      "listMyBookings. Find it in the portal network traffic (member=…).",
  ),
  consumerId: z.string().min(1).optional().describe(
    "This member's numeric consumer id (the `consumer` filter on the waitlist " +
      "endpoint). Required by listMyWaitlist. Find it in the portal network " +
      "traffic (consumer=…).",
  ),
  baseUrl: z.string().url().default("https://api.production.bsport.io")
    .describe(
      "API host without trailing slash (production shown by default).",
    ),
  authPath: z.string().default("/api-v0").describe(
    "Path prefix of the authentication service under baseUrl.",
  ),
  timeoutMs: z.number().int().positive().default(15_000).describe(
    "Per-request fetch timeout in milliseconds.",
  ),
  maxRetries: z.number().int().min(0).max(10).default(5).describe(
    "How many times to retry a request after an HTTP 429 rate-limit response.",
  ),
  userAgent: z.string().default(
    "swamp-bsport/1.0 (+https://swamp-club.com)",
  ).describe("User-Agent header sent on all outbound requests."),
});
/** Parsed, defaulted global arguments of the bsport model. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ============================================================================
// Resource schemas (passthrough preserves any field bsport adds later)
// ============================================================================

const OfferSchema = z.object({
  id: z.number(),
  name: z.string().nullable().optional(),
  date_start: z.string().nullable().optional(),
  date_end: z.string().nullable().optional(),
  company: z.number().nullable().optional(),
  establishment: z.number().nullable().optional(),
  level: z.union([z.number(), z.array(z.number())]).nullable().optional(),
  coaches: z.array(z.number()).nullable().optional(),
  meta_activity: z.number().nullable().optional(),
  max_booking: z.number().nullable().optional(),
  booking_count: z.number().nullable().optional(),
  full: z.boolean().nullable().optional(),
  waiting_list_disabled: z.boolean().nullable().optional(),
  waiting_list_max_size: z.number().nullable().optional(),
  fetchedAt: z.string(),
}).passthrough();

const BookingSchema = z.object({
  id: z.number(),
  offer: z.number().nullable().optional(),
  offer_id: z.number().nullable().optional(),
  status: z.union([z.string(), z.number()]).nullable().optional(),
  is_cancelled: z.boolean().nullable().optional(),
  date_start: z.string().nullable().optional(),
  date_booking: z.string().nullable().optional(),
  on_waiting_list: z.boolean().nullable().optional(),
  fetchedAt: z.string(),
}).passthrough();

const WaitlistPositionSchema = z.object({
  id: z.number(),
  offer: z.number().nullable().optional(),
  offer_id: z.number().nullable().optional(),
  position: z.number().nullable().optional(),
  waiting_list_position: z.number().nullable().optional(),
  fetchedAt: z.string(),
}).passthrough();

const EstablishmentSchema = z.object({
  id: z.number(),
  name: z.string().nullable().optional(),
  company: z.number().nullable().optional(),
  city: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  fetchedAt: z.string(),
}).passthrough();

const SummarySchema = z.object({
  scope: z.string().describe(
    'Which operation produced this summary, e.g. "offers" or "waitlist".',
  ),
  endpoint: z.string().describe("Resolved request path the items came from."),
  filters: z.record(z.string(), z.string()).default({}),
  total: z.number().describe("Number of items written by this run."),
  ids: z.array(z.number()).default([]),
  truncated: z.boolean().default(false).describe(
    "True if maxResults capped the result set before exhausting the listing.",
  ),
  fetchedAt: z.string(),
}).passthrough();

// ============================================================================
// Method argument schemas
// ============================================================================

const IsoDate = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "must be a calendar date in YYYY-MM-DD form",
);

const ListOffersArgs = z.object({
  minDate: IsoDate.describe(
    "Calendar window start, YYYY-MM-DD (maps to min_date).",
  ),
  maxDate: IsoDate.describe(
    "Calendar window end, YYYY-MM-DD (maps to max_date).",
  ),
  establishments: z.array(z.number().int().positive()).optional().describe(
    "Filter by establishment id(s) (maps to establishments=…).",
  ),
  levels: z.array(z.number().int().positive()).optional().describe(
    "Filter by level id(s) (maps to levels=…).",
  ),
  activities: z.array(z.number().int().positive()).optional().describe(
    "Filter by meta-activity id(s) (maps to activity__in=…).",
  ),
  coaches: z.array(z.number().int().positive()).optional().describe(
    "Filter by coach id(s) (maps to coaches=…).",
  ),
  onlyFutureStrict: z.boolean().default(false).describe(
    "Restrict to strictly-future offers (maps to only_future_strict).",
  ),
  maxResults: z.number().int().positive().max(10_000).default(500).describe(
    "Upper bound on offers retrieved across all pages.",
  ),
  pageSize: z.number().int().min(1).max(300).default(100).describe(
    "Offers per page request.",
  ),
});

const GetOffersArgs = z.object({
  ids: z.array(z.number().int().positive()).min(1).describe(
    "Offer id(s) to fetch (maps to id__in=…).",
  ),
});

const MyBookingsArgs = z.object({
  maxResults: z.number().int().positive().max(10_000).default(500).describe(
    "Upper bound on bookings retrieved across all pages.",
  ),
  pageSize: z.number().int().min(1).max(300).default(100).describe(
    "Bookings per page request.",
  ),
});

const ListWaitlistArgs = z.object({
  offerIds: z.array(z.number().int().positive()).optional().describe(
    "Offer id(s) to check waitlist position for. When omitted, the method " +
      "first fetches the member's registered offers and queries those.",
  ),
});

// ============================================================================
// Execution context
// ============================================================================

interface ExecCtx {
  globalArgs: Record<string, unknown>;
  writeResource: (
    specName: string,
    instanceName: string,
    payload: unknown,
  ) => Promise<unknown>;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Resolve and validate the API host (without trailing slash). */
export function resolveHost(g: GlobalArgs): string {
  const raw = g.baseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid bsport baseUrl "${g.baseUrl}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Invalid bsport baseUrl protocol "${parsed.protocol}" (http/https only).`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("bsport baseUrl must not embed credentials.");
  }
  const host = parsed.host;
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) {
    throw new Error(`Invalid bsport baseUrl host "${host}".`);
  }
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Upper bound on a single 429 back-off, in milliseconds. */
export const MAX_BACKOFF_MS = 60_000;

/** Back-off used when a 429 carries no usable `Retry-After`, in milliseconds. */
export const DEFAULT_BACKOFF_MS = 1_000;

/**
 * Compute how long to back off (ms) from the Retry-After header, capped at
 * {@link MAX_BACKOFF_MS}. Accepts both RFC 9110 forms: delay-seconds and an
 * HTTP-date (relative to `now`). Anything else yields
 * {@link DEFAULT_BACKOFF_MS}.
 */
export function backoffMs(res: Response, now: number = Date.now()): number {
  const retryAfter = res.headers.get("Retry-After")?.trim();
  if (retryAfter) {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) {
      return Math.min(Number(retryAfter) * 1000, MAX_BACKOFF_MS);
    }
    // An HTTP-date always names a weekday/month; a bare number like "-5" is
    // not one, even though Date.parse would accept it as a year.
    const at = /[A-Za-z]/.test(retryAfter) ? Date.parse(retryAfter) : NaN;
    if (Number.isFinite(at)) {
      return Math.min(Math.max(at - now, 0), MAX_BACKOFF_MS);
    }
  }
  return DEFAULT_BACKOFF_MS;
}

/**
 * Perform an HTTP request against bsport and return parsed JSON. Retries on 429
 * up to `maxRetries`. Throws a redacted error (never echoing token/password) on
 * any other non-2xx response.
 */
async function httpJson(
  g: GlobalArgs,
  method: "GET" | "POST",
  url: string,
  opts?: { token?: string; body?: unknown },
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": g.userAgent,
  };
  if (opts?.token) headers["Authorization"] = `Token ${opts.token}`;
  let bodyStr: string | undefined;
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }

  for (let attempt = 0;; attempt++) {
    // The timer stays armed until the body has been read, so a server that
    // sends headers and then stalls the body still hits `timeoutMs`.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), g.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: ctrl.signal,
      });

      if (res.status === 429 && attempt < g.maxRetries) {
        await res.body?.cancel().catch(() => {});
        clearTimeout(timer);
        await sleep(backoffMs(res));
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          `bsport ${method} ${redactUrl(url)} failed: ${res.status} ` +
            `${res.statusText}${
              errBody ? ` — ${redactSecrets(errBody, g, opts?.token)}` : ""
            }`,
        );
      }

      if (res.status === 204) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(
          `bsport ${method} ${redactUrl(url)} returned a non-JSON body ` +
            `(${res.status}).`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Remove the token and password from a server-supplied string and cap its
 * length, so an error message can never leak a credential the server echoed.
 */
export function redactSecrets(
  body: string,
  g: Pick<GlobalArgs, "password">,
  token?: string,
): string {
  let safe = body;
  if (token) safe = safe.replaceAll(token, "***");
  if (g.password) safe = safe.replaceAll(g.password, "***");
  return safe.slice(0, 300);
}

/** Strip query string from a URL for safe logging. */
function redactUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Authenticate with email + password and return the DRF auth token. The token
 * is used only in-memory for the current invocation and never persisted.
 */
export async function login(g: GlobalArgs): Promise<string> {
  if (!g.email || !g.password) {
    throw new Error(
      "bsport needs either `token` or both `email` and `password` set.",
    );
  }
  const host = resolveHost(g);
  const url = `${host}${g.authPath}/authentication/signin/with-login/`;
  const json = await httpJson(g, "POST", url, {
    body: { email: g.email, password: g.password },
  });
  const token = (json as Record<string, unknown> | null)?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      "bsport login succeeded but no `token` field was returned.",
    );
  }
  return token;
}

/** Return the token to use: the configured one, or a freshly logged-in one. */
export async function getToken(g: GlobalArgs): Promise<string> {
  return g.token ?? await login(g);
}

/** Build a /book/v1 GET URL with a filtered query string. */
export function bookUrl(
  g: GlobalArgs,
  path: string,
  search?: Record<string, string>,
): string {
  const url = new URL(`${resolveHost(g)}/book/v1${path}`);
  if (search) {
    for (const [k, v] of Object.entries(search)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

/** Extract the item array from a DRF paginated body or a bare array. */
export function pageItems(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  if (json && typeof json === "object") {
    for (const key of ["results", "data", "items"]) {
      const v = (json as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** True when a DRF paginated body still has a `next` page. */
export function hasNext(json: unknown): boolean {
  return !!(json && typeof json === "object" &&
    (json as Record<string, unknown>).next);
}

/** Build the query filters for the member's own /booking/ listing. */
export function memberBookingFilters(
  g: GlobalArgs,
  when: "future" | "past",
): Record<string, string> {
  if (!g.memberId) {
    throw new Error(
      "listFutureBookings/listPastBookings require `memberId` to be set.",
    );
  }
  const base: Record<string, string> = {
    member: g.memberId,
    mine_as_consumer: "true",
    offer_is_workshop: "false",
  };
  return when === "future"
    ? { ...base, before_date_end: "true", ordering: "offer__date_start" }
    : { ...base, after_date_end: "true", ordering: "-offer__date_start" };
}

/**
 * The numeric id of a listing item: its own `id`, else `offer`, else
 * `offer_id`. `null` when none is a number.
 */
export function itemId(item: Record<string, unknown>): number | null {
  if (typeof item.id === "number") return item.id;
  if (typeof item.offer === "number") return item.offer;
  if (typeof item.offer_id === "number") return item.offer_id;
  return null;
}

/** Sanitize an arbitrary string into a stable, safe instance-name slug. */
export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 48);
  return out || "all";
}

/**
 * Page through a /book/v1 list endpoint (page/page_size), writing one resource
 * per item, following DRF `next` until absent or maxResults is reached.
 */
async function paginate(
  g: GlobalArgs,
  token: string,
  context: ExecCtx,
  path: string,
  filters: Record<string, string>,
  specName: string,
  instancePrefix: string,
  fetchedAt: string,
  maxResults: number,
  pageSize: number,
): Promise<
  { handles: unknown[]; ids: number[]; count: number; truncated: boolean }
> {
  const handles: unknown[] = [];
  const ids: number[] = [];
  const seen = new Set<number>();
  let count = 0;
  let page = 1;
  let truncated = false;

  while (count < maxResults) {
    const json = await httpJson(
      g,
      "GET",
      bookUrl(g, path, {
        ...filters,
        page: String(page),
        page_size: String(pageSize),
      }),
      { token },
    );
    const items = pageItems(json);
    if (items.length === 0) break;

    let fresh = 0;
    for (const item of items) {
      const id = itemId(item);
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      handles.push(
        await context.writeResource(
          specName,
          `${instancePrefix}-${id ?? `idx${count}`}`,
          { ...item, fetchedAt },
        ),
      );
      if (id !== null) ids.push(id);
      count += 1;
      fresh += 1;
      if (count >= maxResults) {
        truncated = true;
        break;
      }
    }

    // A page that added nothing new means the server ignored `page` and is
    // replaying the same items while still advertising `next` — stop rather
    // than loop forever.
    if (truncated || fresh === 0 || !hasNext(json)) break;
    page += 1;
  }

  return { handles, ids, count, truncated };
}

async function writeSummary(
  context: ExecCtx,
  name: string,
  payload: z.infer<typeof SummarySchema>,
): Promise<unknown> {
  return await context.writeResource("summary", name, payload);
}

// ============================================================================
// Model
// ============================================================================

/** bsport member API model: calendar offers, my bookings, and my waitlist. */
export const model = {
  type: "@magistr/bsport",
  version: "2026.10.25.10",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.15.1",
      description: "Initial release",
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
    {
      toVersion: "2026.10.15.7",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.8",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.9",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.25.10",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    offer: {
      description:
        "One bsport offer (calendar class), including booking counts and " +
        "waitlist sizing.",
      schema: OfferSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    booking: {
      description: "One of the member's own bookings (factory output).",
      schema: BookingSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    waitlistPosition: {
      description: "The member's waitlist position on one offer.",
      schema: WaitlistPositionSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    establishment: {
      description: "One studio establishment (venue) of the company.",
      schema: EstablishmentSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    waitlistEntry: {
      description:
        "One of the member's own waitlist booking-options (from the " +
        "/waiting-list/booking-option/ listing).",
      schema: z.object({ id: z.number(), fetchedAt: z.string() }).passthrough(),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    summary: {
      description:
        "Per-operation summary: scope, filters, count, and item ids.",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    listEstablishments: {
      description:
        "List the company's establishments/venues (GET /book/v1/establishment/" +
        "?company=…). Writes one `establishment` per venue plus a `summary`. " +
        "Use it to resolve establishment ids to names (e.g. North).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const token = await getToken(g);
        const json = await httpJson(
          g,
          "GET",
          bookUrl(g, "/establishment/", {
            company: g.companyId,
            page_size: "300",
          }),
          { token },
        );
        const handles: unknown[] = [];
        const ids: number[] = [];
        for (const e of pageItems(json)) {
          const id = itemId(e);
          if (id === null) continue;
          handles.push(
            await context.writeResource(
              "establishment",
              `establishment-${id}`,
              {
                ...e,
                fetchedAt,
              },
            ),
          );
          ids.push(id);
        }
        handles.push(
          await writeSummary(context, "summary-establishments", {
            scope: "establishments",
            endpoint: "/book/v1/establishment/",
            filters: { company: g.companyId },
            total: ids.length,
            ids,
            truncated: false,
            fetchedAt,
          }),
        );
        return { dataHandles: handles };
      },
    },

    listOffers: {
      description:
        "List calendar offers (GET /book/v1/offer/) in a date window, " +
        "paginating up to maxResults. Writes one `offer` per class plus a " +
        "`summary`. Each offer carries booking_count / max_booking and " +
        "waiting_list_max_size for waitlist visibility.",
      arguments: ListOffersArgs,
      execute: async (
        args: z.infer<typeof ListOffersArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const token = await getToken(g);
        const filters: Record<string, string> = {
          company: g.companyId,
          min_date: args.minDate,
          max_date: args.maxDate,
          only_future_strict: String(args.onlyFutureStrict),
          with_tags: "true",
          establishments: (args.establishments ?? []).join(","),
          levels: (args.levels ?? []).join(","),
          activity__in: (args.activities ?? []).join(","),
          coaches: (args.coaches ?? []).join(","),
          establishment_group__in: "",
        };
        const { handles, ids, count, truncated } = await paginate(
          g,
          token,
          context,
          "/offer/",
          filters,
          "offer",
          "offer",
          fetchedAt,
          args.maxResults,
          args.pageSize,
        );
        handles.push(
          await writeSummary(
            context,
            `summary-offers-${args.minDate}-${args.maxDate}`,
            {
              scope: "offers",
              endpoint: "/book/v1/offer/",
              filters: { min_date: args.minDate, max_date: args.maxDate },
              total: count,
              ids,
              truncated,
              fetchedAt,
            },
          ),
        );
        context.logger?.info(
          truncated ? "Fetched {n} offers (truncated)" : "Fetched {n} offers",
          { n: count },
        );
        return { dataHandles: handles };
      },
    },

    getOffers: {
      description:
        "Fetch specific offers by id (GET /book/v1/offer/?id__in=…). Writes " +
        "one `offer` per id plus a `summary`.",
      arguments: GetOffersArgs,
      execute: async (
        args: z.infer<typeof GetOffersArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const token = await getToken(g);
        const json = await httpJson(
          g,
          "GET",
          bookUrl(g, "/offer/", {
            id__in: args.ids.join(","),
            ignore_manager_only: "true",
          }),
          { token },
        );
        const handles: unknown[] = [];
        const ids: number[] = [];
        for (const o of pageItems(json)) {
          const id = itemId(o);
          if (id === null) continue;
          handles.push(
            await context.writeResource("offer", `offer-${id}`, {
              ...o,
              fetchedAt,
            }),
          );
          ids.push(id);
        }
        handles.push(
          await writeSummary(
            context,
            `summary-getOffers-${args.ids.join("-")}`,
            {
              scope: "getOffers",
              endpoint: "/book/v1/offer/",
              filters: { id__in: args.ids.join(",") },
              total: ids.length,
              ids,
              truncated: false,
              fetchedAt,
            },
          ),
        );
        return { dataHandles: handles };
      },
    },

    listFutureBookings: {
      description:
        "List the member's upcoming bookings (GET /book/v1/booking/ with " +
        "before_date_end). Requires `memberId`. Writes one `booking` per item " +
        "plus a `summary`.",
      arguments: MyBookingsArgs,
      execute: async (
        args: z.infer<typeof MyBookingsArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const filters = memberBookingFilters(g, "future");
        const token = await getToken(g);
        const { handles, ids, count, truncated } = await paginate(
          g,
          token,
          context,
          "/booking/",
          filters,
          "booking",
          "booking",
          fetchedAt,
          args.maxResults,
          args.pageSize,
        );
        handles.push(
          await writeSummary(context, "summary-bookings-future", {
            scope: "futureBookings",
            endpoint: "/book/v1/booking/",
            filters: { member: g.memberId ?? "", when: "future" },
            total: count,
            ids,
            truncated,
            fetchedAt,
          }),
        );
        return { dataHandles: handles };
      },
    },

    listPastBookings: {
      description:
        "List the member's past bookings (GET /book/v1/booking/ with " +
        "after_date_end). Requires `memberId`. Writes one `booking` per item " +
        "plus a `summary`.",
      arguments: MyBookingsArgs,
      execute: async (
        args: z.infer<typeof MyBookingsArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const filters = memberBookingFilters(g, "past");
        const token = await getToken(g);
        const { handles, ids, count, truncated } = await paginate(
          g,
          token,
          context,
          "/booking/",
          filters,
          "booking",
          "booking",
          fetchedAt,
          args.maxResults,
          args.pageSize,
        );
        handles.push(
          await writeSummary(context, "summary-bookings-past", {
            scope: "pastBookings",
            endpoint: "/book/v1/booking/",
            filters: { member: g.memberId ?? "", when: "past" },
            total: count,
            ids,
            truncated,
            fetchedAt,
          }),
        );
        return { dataHandles: handles };
      },
    },

    listMyWaitlist: {
      description: "List the member's own waitlist entries " +
        "(GET /book/v1/waiting-list/booking-option/?consumer=…&mine=true), then " +
        "resolve each entry's waitlist position. Requires `consumerId`. Writes " +
        "one `waitlistEntry` and one `waitlistPosition` per waitlisted class " +
        "plus a `summary`. Unlike `listWaitlist`, no offer ids are needed.",
      arguments: MyBookingsArgs,
      execute: async (
        args: z.infer<typeof MyBookingsArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        if (!g.consumerId) {
          throw new Error("listMyWaitlist requires `consumerId` to be set.");
        }
        const fetchedAt = new Date().toISOString();
        const token = await getToken(g);

        // 1) Enumerate the member's waitlist booking-options.
        const entries: Array<Record<string, unknown>> = [];
        let truncated = false;
        let page = 1;
        while (entries.length < args.maxResults) {
          const json = await httpJson(
            g,
            "GET",
            bookUrl(g, "/waiting-list/booking-option/", {
              company: g.companyId,
              consumer: g.consumerId,
              mine: "true",
              offer_is_workshop: "false",
              ordering: "offer__date_start",
              page: String(page),
              page_size: String(args.pageSize),
            }),
            { token },
          );
          const items = pageItems(json);
          if (items.length === 0) break;
          const room = args.maxResults - entries.length;
          entries.push(...items.slice(0, room));
          if (items.length > room) {
            truncated = true;
            break;
          }
          if (!hasNext(json)) break;
          if (entries.length >= args.maxResults) {
            truncated = true;
            break;
          }
          page += 1;
        }

        const handles: unknown[] = [];
        const offerIds: number[] = [];
        for (const [i, e] of entries.entries()) {
          const eid = itemId(e);
          const oid = typeof e.offer === "number" ? e.offer : eid;
          handles.push(
            await context.writeResource(
              "waitlistEntry",
              `waitlistentry-${eid ?? `idx${i}`}`,
              { ...e, fetchedAt },
            ),
          );
          if (typeof oid === "number" && !offerIds.includes(oid)) {
            offerIds.push(oid);
          }
        }

        // 2) Resolve waitlist positions for the collected offers.
        if (offerIds.length > 0) {
          const posJson = await httpJson(
            g,
            "GET",
            bookUrl(g, "/offer/waiting_list_position_list/", {
              id__in: offerIds.join(","),
            }),
            { token },
          );
          for (const w of pageItems(posJson)) {
            const id = itemId(w);
            if (id === null) continue;
            handles.push(
              await context.writeResource(
                "waitlistPosition",
                `waitlist-${id}`,
                { ...w, fetchedAt },
              ),
            );
          }
        }

        handles.push(
          await writeSummary(context, "summary-my-waitlist", {
            scope: "myWaitlist",
            endpoint: "/book/v1/waiting-list/booking-option/",
            filters: { consumer: g.consumerId },
            total: offerIds.length,
            ids: offerIds,
            truncated,
            fetchedAt,
          }),
        );
        context.logger?.info("Fetched {n} waitlist entries", {
          n: offerIds.length,
        });
        return { dataHandles: handles };
      },
    },

    listRegisteredOffers: {
      description:
        "List offers the member is registered for, booked or waitlisted " +
        "(GET /book/v1/offer/registered/). Writes one `offer` per item plus a " +
        "`summary`.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const token = await getToken(g);
        const json = await httpJson(
          g,
          "GET",
          bookUrl(g, "/offer/registered/"),
          { token },
        );
        const handles: unknown[] = [];
        const ids: number[] = [];
        for (const o of pageItems(json)) {
          const id = itemId(o);
          if (id === null) continue;
          handles.push(
            await context.writeResource("offer", `offer-${id}`, {
              ...o,
              fetchedAt,
            }),
          );
          ids.push(id);
        }
        handles.push(
          await writeSummary(context, "summary-registered", {
            scope: "registeredOffers",
            endpoint: "/book/v1/offer/registered/",
            filters: {},
            total: ids.length,
            ids,
            truncated: false,
            fetchedAt,
          }),
        );
        return { dataHandles: handles };
      },
    },

    listWaitlist: {
      description: "List the member's waitlist positions " +
        "(GET /book/v1/offer/waiting_list_position_list/?id__in=…). When " +
        "offerIds is omitted, it first pulls the registered offers and queries " +
        "those. Writes one `waitlistPosition` per offer plus a `summary`.",
      arguments: ListWaitlistArgs,
      execute: async (
        args: z.infer<typeof ListWaitlistArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const token = await getToken(g);

        let offerIds = args.offerIds ?? [];
        if (offerIds.length === 0) {
          const reg = await httpJson(
            g,
            "GET",
            bookUrl(g, "/offer/registered/"),
            { token },
          );
          offerIds = pageItems(reg)
            .map((o) => itemId(o))
            .filter((v): v is number => v !== null);
        }
        if (offerIds.length === 0) {
          const handle = await writeSummary(context, "summary-waitlist", {
            scope: "waitlist",
            endpoint: "/book/v1/offer/waiting_list_position_list/",
            filters: {},
            total: 0,
            ids: [],
            truncated: false,
            fetchedAt,
          });
          return { dataHandles: [handle] };
        }

        const json = await httpJson(
          g,
          "GET",
          bookUrl(g, "/offer/waiting_list_position_list/", {
            id__in: offerIds.join(","),
          }),
          { token },
        );
        const handles: unknown[] = [];
        const ids: number[] = [];
        for (const w of pageItems(json)) {
          const id = itemId(w);
          if (id === null) continue;
          handles.push(
            await context.writeResource(
              "waitlistPosition",
              `waitlist-${id}`,
              { ...w, fetchedAt },
            ),
          );
          ids.push(id);
        }
        handles.push(
          await writeSummary(context, "summary-waitlist", {
            scope: "waitlist",
            endpoint: "/book/v1/offer/waiting_list_position_list/",
            filters: { id__in: offerIds.join(",") },
            total: ids.length,
            ids,
            truncated: false,
            fetchedAt,
          }),
        );
        context.logger?.info("Fetched {n} waitlist positions", {
          n: ids.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
