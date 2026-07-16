/**
 * Kaiten — read-only client for the Kaiten work-management REST API
 * (https://developers.kaiten.ru).
 *
 * Every Kaiten account is reachable at `https://<domain>.kaiten.ru/api/<ver>`
 * (default version `latest`) and authenticates with a personal API token sent
 * as `Authorization: Bearer <token>`. The token is obtained from the user's
 * profile API-key settings inside Kaiten.
 *
 * This model is strictly read-only — it never creates, mutates, or deletes
 * anything in Kaiten. It exposes:
 *   - `listSpaces` / `getSpace`     — GET /spaces, GET /spaces/{id}
 *   - `listBoards` / `getBoard`     — GET /spaces/{id}/boards, GET /boards/{id}
 *   - `listColumns`                 — GET /boards/{id}/columns
 *   - `listCards`  / `getCard`      — GET /cards (paginated), GET /cards/{id}
 *
 * Each `list*` method is a fan-out factory: it writes one resource per item
 * plus a single `summary`, so a single invocation acquires the model lock once
 * and produces all outputs (no per-item method loops). `listCards` paginates
 * internally via offset/limit up to `maxResults`. The shared HTTP helper backs
 * off and retries transparently on HTTP 429 using the `Retry-After` /
 * `X-RateLimit-Reset` headers (Kaiten allows 50 req/s).
 *
 * @module
 */
import { z } from "npm:zod@4";

// ============================================================================
// Global arguments
// ============================================================================

const GlobalArgsSchema = z.object({
  domain: z.string().min(1).describe(
    'Kaiten account domain. Either a bare subdomain (e.g. "acme" -> ' +
      "acme.kaiten.ru) or a full host (e.g. acme.kaiten.ru / self-hosted host).",
  ),
  apiVersion: z.string().default("latest").describe(
    'API version segment in the base path, e.g. "latest" or "v1".',
  ),
  token: z.string().min(1).describe(
    "Personal API token (Bearer). Use a vault reference: " +
      "${{ vault.get(kaiten, API_TOKEN) }}",
  ),
  timeoutMs: z.number().int().positive().default(15_000).describe(
    "Per-request fetch timeout in milliseconds.",
  ),
  maxRetries: z.number().int().min(0).max(10).default(5).describe(
    "How many times to retry a request after an HTTP 429 rate-limit response.",
  ),
  userAgent: z.string().default(
    "swamp-kaiten/1.0 (+https://swamp-club.com)",
  ).describe("User-Agent header sent on all outbound requests."),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ============================================================================
// Resource schemas (passthrough preserves any field Kaiten adds later)
// ============================================================================

const SpaceSchema = z.object({
  id: z.number(),
  uid: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  parent_entity_uuid: z.string().nullable().optional(),
  archived: z.boolean().nullable().optional(),
  sort_order: z.number().nullable().optional(),
  created: z.string().nullable().optional(),
  updated: z.string().nullable().optional(),
  fetchedAt: z.string(),
}).passthrough();

const BoardSchema = z.object({
  id: z.number(),
  title: z.string().nullable().optional(),
  space_id: z.number().nullable().optional(),
  created: z.string().nullable().optional(),
  updated: z.string().nullable().optional(),
  columns: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  lanes: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  fetchedAt: z.string(),
}).passthrough();

const ColumnSchema = z.object({
  id: z.number(),
  title: z.string().nullable().optional(),
  board_id: z.number().nullable().optional(),
  type: z.number().nullable().optional(),
  col_count: z.number().nullable().optional(),
  sort_order: z.number().nullable().optional(),
  fetchedAt: z.string(),
}).passthrough();

const CardSchema = z.object({
  id: z.number(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  board_id: z.number().nullable().optional(),
  column_id: z.number().nullable().optional(),
  lane_id: z.number().nullable().optional(),
  owner_id: z.number().nullable().optional(),
  type_id: z.number().nullable().optional(),
  condition: z.number().nullable().optional(),
  state: z.number().nullable().optional(),
  archived: z.boolean().nullable().optional(),
  asap: z.boolean().nullable().optional(),
  due_date: z.string().nullable().optional(),
  created: z.string().nullable().optional(),
  updated: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
  size: z.number().nullable().optional(),
  fetchedAt: z.string(),
}).passthrough();

const SummarySchema = z.object({
  scope: z.string().describe('Which list produced this summary, e.g. "cards".'),
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

const ListSpacesArgs = z.object({});

const GetSpaceArgs = z.object({
  id: z.number().int().positive().describe("Space id."),
});

const ListBoardsArgs = z.object({
  spaceId: z.number().int().positive().describe(
    "Space id whose boards to list.",
  ),
});

const GetBoardArgs = z.object({
  id: z.number().int().positive().describe(
    "Board id. The response embeds the board's columns and lanes.",
  ),
});

const ListColumnsArgs = z.object({
  boardId: z.number().int().positive().describe(
    "Board id whose columns to list.",
  ),
});

const ListCardsArgs = z.object({
  spaceId: z.number().int().positive().optional().describe(
    "Filter by space id.",
  ),
  boardId: z.number().int().positive().optional().describe(
    "Filter by board id.",
  ),
  columnId: z.number().int().positive().optional().describe(
    "Filter by column id.",
  ),
  laneId: z.number().int().positive().optional().describe("Filter by lane id."),
  query: z.string().optional().describe("Free-text search over card titles."),
  condition: z.enum(["live", "done"]).optional().describe(
    "Card condition filter: live (active) or done. Mapped to Kaiten's " +
      "numeric `condition` (live=1, done=2).",
  ),
  archived: z.boolean().optional().describe(
    "Include only archived (true) or only non-archived (false) cards.",
  ),
  additionalParams: z.record(z.string(), z.string()).default({}).describe(
    "Extra raw query parameters passed through to GET /cards verbatim, e.g. " +
      '{"tag_ids": "3,7", "type_id": "2"}.',
  ),
  maxResults: z.number().int().positive().max(10_000).default(500).describe(
    "Upper bound on cards retrieved across all pages.",
  ),
  pageSize: z.number().int().min(1).max(100).default(100).describe(
    "Cards per page request (offset/limit pagination).",
  ),
});

const GetCardArgs = z.object({
  id: z.number().int().positive().describe("Card id."),
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

/**
 * Resolve the API base URL (without trailing slash) from the configured domain
 * and api version. Accepts a bare subdomain or a full host, strips any
 * protocol / path / trailing slash, and validates the host charset to avoid
 * building a request against an unexpected target.
 */
export function resolveBase(g: GlobalArgs): string {
  let host = g.domain.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\/+$/, "");
  if (!host) {
    throw new Error("Kaiten `domain` resolves to an empty host.");
  }
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error(
      `Invalid Kaiten domain "${g.domain}": only letters, digits, dots and ` +
        "hyphens are allowed.",
    );
  }
  if (!host.includes(".")) host = `${host}.kaiten.ru`;
  const ver = encodeURIComponent(g.apiVersion.trim() || "latest");
  return `https://${host}/api/${ver}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute how long to back off (ms) from rate-limit headers, capped at 60s. */
export function backoffMs(res: Response): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, 60_000);
    }
  }
  const reset = res.headers.get("X-RateLimit-Reset");
  if (reset) {
    const resetMs = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.min(resetMs + 500, 60_000);
    }
  }
  return 1_000;
}

/**
 * Perform an authenticated GET against the Kaiten API and return parsed JSON.
 * Retries transparently on HTTP 429 up to `maxRetries`, backing off per the
 * rate-limit headers. Throws a redacted error (never echoing the token) on any
 * other non-2xx response.
 */
async function kget(
  g: GlobalArgs,
  path: string,
  search?: Record<string, string>,
): Promise<unknown> {
  const base = resolveBase(g);
  const url = new URL(base + path);
  if (search) {
    for (const [k, v] of Object.entries(search)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }

  for (let attempt = 0;; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), g.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${g.token}`,
          "Accept": "application/json",
          "User-Agent": g.userAgent,
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 && attempt < g.maxRetries) {
      await res.body?.cancel().catch(() => {});
      await sleep(backoffMs(res));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Kaiten GET ${path} failed: ${res.status} ${res.statusText}` +
          (body ? ` — ${body.slice(0, 300)}` : ""),
      );
    }

    return await res.json();
  }
}

function asArray(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  // Some Kaiten endpoints wrap lists; tolerate {data:[...]} / {items:[...]}.
  if (json && typeof json === "object") {
    for (const key of ["data", "items", "results"]) {
      const v = (json as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** Sanitize an arbitrary string into a stable, safe instance-name slug. */
export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 48);
  return out || "all";
}

/** Stable numeric id from an item, or a fallback when absent. */
function itemId(item: Record<string, unknown>): number | null {
  return typeof item.id === "number" ? item.id : null;
}

// ============================================================================
// Model
// ============================================================================

/** Read-only Kaiten REST API model: spaces, boards, columns, and cards. */
export const model = {
  type: "@magistr/kaiten",
  version: "2026.06.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    space: {
      description: "One Kaiten space (factory output).",
      schema: SpaceSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    board: {
      description: "One Kaiten board, with embedded columns and lanes.",
      schema: BoardSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    column: {
      description: "One board column (factory output).",
      schema: ColumnSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    card: {
      description: "One Kaiten card (factory output).",
      schema: CardSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    summary: {
      description: "Per-listing summary: scope, filters, count, and item ids.",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    listSpaces: {
      description:
        "List all spaces (GET /spaces). Writes one `space` per space plus a " +
        "`summary`.",
      arguments: ListSpacesArgs,
      execute: async (
        _args: z.infer<typeof ListSpacesArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const json = await kget(g, "/spaces");
        const spaces = asArray(json);

        const handles: unknown[] = [];
        const ids: number[] = [];
        for (const sp of spaces) {
          const id = itemId(sp);
          if (id === null) continue;
          handles.push(
            await context.writeResource("space", `space-${id}`, {
              ...sp,
              fetchedAt,
            }),
          );
          ids.push(id);
        }
        handles.push(
          await context.writeResource("summary", "summary-spaces", {
            scope: "spaces",
            endpoint: "/spaces",
            filters: {},
            total: ids.length,
            ids,
            truncated: false,
            fetchedAt,
          }),
        );
        context.logger?.info("Fetched {n} Kaiten spaces", { n: ids.length });
        return { dataHandles: handles };
      },
    },

    getSpace: {
      description: "Fetch a single space by id (GET /spaces/{id}).",
      arguments: GetSpaceArgs,
      execute: async (
        args: z.infer<typeof GetSpaceArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const sp = await kget(g, `/spaces/${args.id}`) as Record<
          string,
          unknown
        >;
        const handle = await context.writeResource(
          "space",
          `space-${args.id}`,
          { ...sp, fetchedAt },
        );
        return { dataHandles: [handle] };
      },
    },

    listBoards: {
      description:
        "List boards within a space (GET /spaces/{spaceId}/boards). Writes one " +
        "`board` per board plus a `summary`.",
      arguments: ListBoardsArgs,
      execute: async (
        args: z.infer<typeof ListBoardsArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const endpoint = `/spaces/${args.spaceId}/boards`;
        const boards = asArray(await kget(g, endpoint));

        const handles: unknown[] = [];
        const ids: number[] = [];
        for (const b of boards) {
          const id = itemId(b);
          if (id === null) continue;
          handles.push(
            await context.writeResource("board", `board-${id}`, {
              ...b,
              fetchedAt,
            }),
          );
          ids.push(id);
        }
        handles.push(
          await context.writeResource(
            "summary",
            `summary-boards-${args.spaceId}`,
            {
              scope: "boards",
              endpoint,
              filters: { space_id: String(args.spaceId) },
              total: ids.length,
              ids,
              truncated: false,
              fetchedAt,
            },
          ),
        );
        context.logger?.info("Fetched {n} boards for space {space}", {
          n: ids.length,
          space: args.spaceId,
        });
        return { dataHandles: handles };
      },
    },

    getBoard: {
      description:
        "Fetch a single board by id (GET /boards/{id}); the response embeds " +
        "the board's columns and lanes.",
      arguments: GetBoardArgs,
      execute: async (
        args: z.infer<typeof GetBoardArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const b = await kget(g, `/boards/${args.id}`) as Record<
          string,
          unknown
        >;
        const handle = await context.writeResource(
          "board",
          `board-${args.id}`,
          { ...b, fetchedAt },
        );
        return { dataHandles: [handle] };
      },
    },

    listColumns: {
      description:
        "List the columns of a board (GET /boards/{boardId}/columns). Writes " +
        "one `column` per column plus a `summary`.",
      arguments: ListColumnsArgs,
      execute: async (
        args: z.infer<typeof ListColumnsArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const endpoint = `/boards/${args.boardId}/columns`;
        const columns = asArray(await kget(g, endpoint));

        const handles: unknown[] = [];
        const ids: number[] = [];
        for (const c of columns) {
          const id = itemId(c);
          if (id === null) continue;
          handles.push(
            await context.writeResource("column", `column-${id}`, {
              ...c,
              fetchedAt,
            }),
          );
          ids.push(id);
        }
        handles.push(
          await context.writeResource(
            "summary",
            `summary-columns-${args.boardId}`,
            {
              scope: "columns",
              endpoint,
              filters: { board_id: String(args.boardId) },
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

    listCards: {
      description:
        "List cards (GET /cards), paginating through all pages up to " +
        "maxResults. Writes one `card` per card plus a `summary`. Supports " +
        "space/board/column/lane, free-text, condition, and archived filters.",
      arguments: ListCardsArgs,
      execute: async (
        args: z.infer<typeof ListCardsArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();

        // Build the stable filter set (offset/limit are added per page).
        const filters: Record<string, string> = { ...args.additionalParams };
        if (args.spaceId !== undefined) filters.space_id = String(args.spaceId);
        if (args.boardId !== undefined) filters.board_id = String(args.boardId);
        if (args.columnId !== undefined) {
          filters.column_id = String(args.columnId);
        }
        if (args.laneId !== undefined) filters.lane_id = String(args.laneId);
        if (args.query !== undefined) filters.query = args.query;
        if (args.condition !== undefined) {
          filters.condition = args.condition === "live" ? "1" : "2";
        }
        if (args.archived !== undefined) {
          filters.archived = args.archived ? "true" : "false";
        }

        const handles: unknown[] = [];
        const ids: number[] = [];
        const seen = new Set<number>();
        let offset = 0;
        let truncated = false;

        while (ids.length < args.maxResults) {
          const limit = Math.min(args.pageSize, args.maxResults - ids.length);
          const page = asArray(
            await kget(g, "/cards", {
              ...filters,
              limit: String(limit),
              offset: String(offset),
            }),
          );
          if (page.length === 0) break;

          for (const card of page) {
            const id = itemId(card);
            if (id === null || seen.has(id)) continue;
            seen.add(id);
            handles.push(
              await context.writeResource("card", `card-${id}`, {
                ...card,
                fetchedAt,
              }),
            );
            ids.push(id);
            if (ids.length >= args.maxResults) {
              truncated = true;
              break;
            }
          }

          offset += page.length;
          // Short page => listing exhausted.
          if (page.length < limit) break;
        }

        handles.push(
          await context.writeResource(
            "summary",
            `summary-cards-${slug(JSON.stringify(filters))}`,
            {
              scope: "cards",
              endpoint: "/cards",
              filters,
              total: ids.length,
              ids,
              truncated,
              fetchedAt,
            },
          ),
        );
        context.logger?.info(
          truncated
            ? "Fetched {n} cards (truncated at maxResults)"
            : "Fetched {n} cards",
          { n: ids.length },
        );
        return { dataHandles: handles };
      },
    },

    getCard: {
      description: "Fetch a single card by id (GET /cards/{id}).",
      arguments: GetCardArgs,
      execute: async (
        args: z.infer<typeof GetCardArgs>,
        context: ExecCtx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const fetchedAt = new Date().toISOString();
        const card = await kget(g, `/cards/${args.id}`) as Record<
          string,
          unknown
        >;
        const handle = await context.writeResource(
          "card",
          `card-${args.id}`,
          { ...card, fetchedAt },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
