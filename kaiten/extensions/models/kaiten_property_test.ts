/**
 * Property-based tests (fast-check) for @magistr/kaiten.
 *
 * kaiten.ts exports no pure request-builder helper — the request-builder
 * property is observed by driving `model.methods.listCards.execute()`
 * against a stubbed fetch and reading back the captured query string.
 * `slug` IS exported and is exercised directly.
 *
 * Properties:
 *  (a) request-builder injectivity, stated MODULO the documented
 *      normalization (an additionalParams key that collides with a named
 *      filter is OVERRIDDEN by the named filter — see the "collapse"
 *      example below; the empty-string-value drop is pinned separately in
 *      kaiten_coverage_test.ts) — restricted to a canonical, non-colliding
 *      arbitrary per the plan's round-1 review finding that naive
 *      injectivity is FALSE over the raw input space.
 *  (b) response-parser round-trip + dedup — listCards preserves every
 *      generated card's fields verbatim (plus fetchedAt) and writes exactly
 *      one resource per DISTINCT id, first-occurrence-wins.
 *  (c) pagination-count invariant — written count == min(supply, maxResults);
 *      truncated == (written count == maxResults).
 *  (d) slug: the charset property (/^[a-z0-9-]*$/) holds UNIVERSALLY;
 *      idempotence holds ONLY for inputs whose normalized form is <=48
 *      chars (no truncation) — a >48-char input can truncate to a value
 *      ending in "-", and a second slug() call then strips that trailing
 *      dash, so slug(slug(s)) != slug(s) in general (pinned as a named
 *      example, per the round-1 review finding).
 *
 * No timer stubbing anywhere — the property suite drives execute() against
 * the fetch stub only; the retry path is exercised in
 * kaiten_methods_test.ts / kaiten_adversarial_test.ts via Retry-After: "0".
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model, slug } from "./kaiten.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = { domain: "acme", token: "property-stub-token" };

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | undefined;

// Eager plain-object snapshot instead of `.clone()` — cloning a body-bearing
// Request tees its body into a ReadableStream that is never consumed or
// cancelled, leaking ~6KB per stubbed fetch call (see
// fix/soak-property-harness-heap-leak). The body is read ONCE via
// `await req.text()`; routes get a freshly reconstructed Request built from
// the captured text so existing route logic (which may itself read the
// body) keeps working.
type CapturedRequest = {
  method: string;
  url: string;
  headers: Headers;
  body: string;
};

async function withFetchStub(
  routes: Route[],
  fn: (calls: CapturedRequest[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const body = await req.text();
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    const routable = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    for (const r of routes) {
      const res = r(routable);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unrouted ${req.url}`));
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Run `listCards` with the given args against an empty-first-page stub and
 * return the sorted query-string entries of the FIRST (only) request. */
async function queryFor(args: Record<string, unknown>): Promise<string> {
  const { ctx } = makeCtx();
  let out = "";
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", args, ctx);
    const url = new URL(calls[0].url);
    out = Array.from(url.searchParams.entries())
      .filter(([k]) => k !== "limit" && k !== "offset") // pagination is constant across all inputs here
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
  });
  return out;
}

// ---------------------------------------------------------------------------
// (a) request-builder injectivity, MODULO documented normalization
// ---------------------------------------------------------------------------

// Canonical, non-colliding domain: additionalParams keys are namespaced
// ("custom_*") so they can never collide with a named filter's wire key
// (space_id/board_id/column_id/lane_id/query/condition/archived), and
// additionalParams values are always non-empty (excludes the
// empty-string-drop collapse pinned separately in kaiten_coverage_test.ts).
const arbCanonicalListCardsInput = fc.record({
  spaceId: fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: undefined }),
  boardId: fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: undefined }),
  columnId: fc.option(fc.integer({ min: 1, max: 100_000 }), {
    nil: undefined,
  }),
  laneId: fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: undefined }),
  query: fc.option(fc.stringMatching(/^[a-z0-9 ]{1,20}$/), {
    nil: undefined,
  }),
  condition: fc.option(fc.constantFrom("live", "done"), { nil: undefined }),
  archived: fc.option(fc.boolean(), { nil: undefined }),
  additionalParams: fc.dictionary(
    fc.stringMatching(/^custom_[a-z0-9]{1,8}$/),
    fc.stringMatching(/^[a-z0-9]{1,10}$/),
    { maxKeys: 3 },
  ),
});

function canonicalSignature(input: Record<string, unknown>): string {
  const ap = input.additionalParams as Record<string, string>;
  return JSON.stringify([
    input.spaceId,
    input.boardId,
    input.columnId,
    input.laneId,
    input.query,
    input.condition,
    input.archived,
    Object.entries(ap).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

Deno.test("property: listCards's built query string is deterministic — same canonical input -> same query", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalListCardsInput, async (input) => {
      const a = await queryFor(input);
      const b = await queryFor(input);
      return a === b;
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: listCards's built query string is INJECTIVE over the canonical (non-colliding) input subset", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalListCardsInput,
      arbCanonicalListCardsInput,
      async (a, b) => {
        const sigA = canonicalSignature(a);
        const sigB = canonicalSignature(b);
        const qa = await queryFor(a);
        const qb = await queryFor(b);
        return sigA === sigB ? qa === qb : qa !== qb;
      },
    ),
    FC_RUNS,
  );
});

// --- Named collapse example (round-1 review finding) -----------------------

Deno.test("collapse: an additionalParams key that collides with a named filter is OVERRIDDEN, not merged — same query as omitting it", async () => {
  const withCollision = await queryFor({
    boardId: 128,
    additionalParams: { board_id: "999" },
  });
  const withoutCollision = await queryFor({ boardId: 128 });
  assertEquals(withCollision, withoutCollision);
});

// ---------------------------------------------------------------------------
// (b) response-parser round-trip + dedup
// ---------------------------------------------------------------------------

const arbCard = fc.record({
  id: fc.integer({ min: 1, max: 20 }),
  title: fc.stringMatching(/^[a-zA-Z0-9 ]{0,20}$/),
});

Deno.test("property: listCards writes exactly one resource per DISTINCT generated id, first-occurrence-wins, fields preserved verbatim", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbCard, { minLength: 0, maxLength: 15 }),
      async (generatedCards) => {
        const { ctx, written } = makeCtx();
        await withFetchStub([() => json(generatedCards)], async () => {
          await run("listCards", {}, ctx);
        });
        const firstOccurrence = new Map<number, string>();
        for (const c of generatedCards) {
          if (!firstOccurrence.has(c.id)) firstOccurrence.set(c.id, c.title);
        }
        const writtenCards = written.filter((w) => w.spec === "card");
        const writtenIds = new Set(
          writtenCards.map((w) => w.payload.id as number),
        );
        const distinctIds = new Set(firstOccurrence.keys());
        if (writtenIds.size !== distinctIds.size) return false;
        for (const id of distinctIds) if (!writtenIds.has(id)) return false;
        for (const w of writtenCards) {
          if (w.payload.title !== firstOccurrence.get(w.payload.id as number)) {
            return false;
          }
        }
        const summary = written.find((w) => w.spec === "summary")!;
        return summary.payload.total === distinctIds.size;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) pagination-count invariant
// ---------------------------------------------------------------------------

const PAGE_SIZE = 7;

/** Emulate a real paginated server holding `total` sequential card ids
 * (1..total), honoring the request's offset/limit exactly. */
function paginatedServer(total: number): Route {
  return (req) => {
    const url = new URL(req.url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const items: Array<{ id: number }> = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      items.push({ id: i + 1 });
    }
    return json(items);
  };
}

Deno.test("property: pagination-count invariant — written == min(supply, maxResults); truncated == (written == maxResults)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 1, max: 40 }),
      async (total, maxResults) => {
        const { ctx, written } = makeCtx();
        await withFetchStub([paginatedServer(total)], async () => {
          await run(
            "listCards",
            { pageSize: PAGE_SIZE, maxResults },
            ctx,
          );
        });
        const cardsWritten = written.filter((w) => w.spec === "card");
        const expectedCount = Math.min(total, maxResults);
        const summary = written.find((w) => w.spec === "summary")!;
        return (
          cardsWritten.length === expectedCount &&
          summary.payload.total === expectedCount &&
          summary.payload.truncated === (expectedCount === maxResults)
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) slug: universal charset property + idempotence modulo truncation
// ---------------------------------------------------------------------------

Deno.test("property: slug's output ALWAYS matches /^[a-z0-9-]*$/, for any input string", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (s) => {
      return /^[a-z0-9-]*$/.test(slug(s));
    }),
    FC_RUNS,
  );
});

Deno.test("property: slug is IDEMPOTENT for inputs whose normalized form is <=48 chars (no truncation)", () => {
  // Restrict to printable ASCII, maxLength 48: toLowerCase/replace/strip on
  // this charset never GROWS the string, so the pre-slice normalized form
  // is guaranteed <=48 chars — slice(0,48) is then a no-op and a second
  // slug() call is idempotent. See the named truncation-edge example below
  // for why this restriction is necessary (idempotence is FALSE beyond it).
  fc.assert(
    fc.property(fc.stringMatching(/^[\x20-\x7E]{0,48}$/), (s) => {
      const once = slug(s);
      return slug(once) === once;
    }),
    FC_RUNS,
  );
});

Deno.test("named collapse: slug's >48-char truncation can end in a dash that a second slug() call strips — NOT idempotent beyond the 48-char boundary", () => {
  // slug() strips leading/trailing dashes BEFORE slice(0,48), so a >48-char
  // input can truncate to a value ENDING in "-"; running slug() again then
  // strips that trailing dash. This is the round-1 adversarial-review
  // finding — pinned as a named example rather than a universal property,
  // per the review's own recommendation.
  const raw = "a".repeat(47) + " b"; // 49 chars: 47 a's, one separator, "b"
  const once = slug(raw);
  const twice = slug(once);
  assertEquals(once, "a".repeat(47) + "-");
  assertEquals(twice, "a".repeat(47));
  assert(
    once !== twice,
    "slug(slug(s)) must differ from slug(s) for this >48-char boundary case",
  );
});
