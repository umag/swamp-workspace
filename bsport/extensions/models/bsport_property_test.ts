/**
 * Property suite for @magistr/bsport (fast-check, FC_NUM_RUNS knob).
 *
 *  (a) backoffMs is always within [0, MAX_BACKOFF_MS] for any header text.
 *  (b) redactSecrets never returns a string containing the token or the
 *      password, for any body.
 *  (c) any companyId round-trips through the query string unchanged.
 *  (d) paginate flow — for any sequence of pages (duplicate ids, id-less
 *      items, any maxResults/pageSize), the request count is bounded, the
 *      summary's ids are unique, total ≤ maxResults, and `truncated` is set
 *      exactly when the cap was hit.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { backoffMs, MAX_BACKOFF_MS, model, redactSecrets } from "./bsport.ts";
import {
  GLOBAL_ARGS,
  json,
  makeCtx,
  withFetch,
} from "./bsport_harness_test.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");

Deno.test("property: backoffMs stays within [0, MAX_BACKOFF_MS]", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 40 }), fc.integer(), (h, now) => {
      let headers: HeadersInit = {};
      try {
        headers = new Headers({ "Retry-After": h });
      } catch {
        return; // not a legal header value; fetch could never deliver it
      }
      const ms = backoffMs(new Response(null, { status: 429, headers }), now);
      assert(ms >= 0 && ms <= MAX_BACKOFF_MS, `${h} → ${ms}`);
    }),
    { numRuns },
  );
});

const secret = fc.stringMatching(/^[A-Za-z0-9]{6,24}$/);

Deno.test("property: redactSecrets never leaks the token or password", () => {
  fc.assert(
    fc.property(
      secret,
      secret,
      fc.array(
        fc.oneof(
          fc.string({ maxLength: 30 }),
          fc.constant("§T"),
          fc.constant("§P"),
        ),
        { maxLength: 20 },
      ),
      (token, password, parts) => {
        const body = parts.map((p) =>
          p === "§T" ? token : p === "§P" ? password : p
        ).join("");
        const out = redactSecrets(body, { password }, token);
        assert(!out.includes(token));
        assert(!out.includes(password));
        assert(out.length <= 300);
      },
    ),
    { numRuns },
  );
});

Deno.test("property: companyId round-trips through the query string", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 30 }), async (id) => {
      const { ctx } = makeCtx({ ...GLOBAL_ARGS, companyId: id });
      await withFetch(
        () => json({ results: [] }),
        async (calls) => {
          await model.methods.listEstablishments.execute({}, ctx);
          assertEquals(calls[0].url.searchParams.get("company"), id);
        },
      );
    }),
    { numRuns },
  );
});

// One page: items that are either `{id}` (ids drawn from a small range so
// duplicates are common) or id-less.
const item = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.integer({ min: 1, max: 15 }).map((id) => ({ id })),
  },
  { weight: 1, arbitrary: fc.constant({ note: "no id" }) },
);
const pages = fc.array(fc.array(item, { maxLength: 6 }), {
  minLength: 1,
  maxLength: 6,
});

Deno.test("property: paginate flow is bounded, deduplicated and honest about truncation", async () => {
  await fc.assert(
    fc.asyncProperty(
      pages,
      fc.integer({ min: 1, max: 20 }),
      async (served, maxResults) => {
        const { ctx, written } = makeCtx();
        await withFetch(
          (call) => {
            const p = Number(call.url.searchParams.get("page"));
            const results = served[p - 1] ?? [];
            const next = p < served.length ? "more" : null;
            return json({ results, next });
          },
          async (calls) => {
            await model.methods.listFutureBookings.execute(
              model.methods.listFutureBookings.arguments.parse({ maxResults }),
              ctx,
            );
            assert(calls.length <= served.length);
          },
        );
        const summary = written.at(-1)!.payload as {
          total: number;
          ids: number[];
          truncated: boolean;
        };
        const items = written.slice(0, -1);
        assertEquals(items.length, summary.total);
        assert(summary.total <= maxResults);
        assertEquals(new Set(summary.ids).size, summary.ids.length);
        assertEquals(new Set(items.map((w) => w.name)).size, items.length);
        const expected = referencePaginate(served, maxResults);
        assertEquals(summary.total, expected.count);
        assertEquals(summary.truncated, expected.truncated);
        if (summary.truncated) assertEquals(summary.total, maxResults);
      },
    ),
    { numRuns },
  );
});

/** Independent oracle for the paginate stop rules. */
function referencePaginate(
  served: Array<Array<{ id?: number; note?: string }>>,
  maxResults: number,
): { count: number; truncated: boolean } {
  const seen = new Set<number>();
  let count = 0;
  for (const [i, p] of served.entries()) {
    if (p.length === 0) break;
    let fresh = 0;
    for (const it of p) {
      if (it.id !== undefined) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
      }
      count += 1;
      fresh += 1;
      if (count >= maxResults) return { count, truncated: true };
    }
    if (fresh === 0 || i === served.length - 1) break;
  }
  return { count, truncated: false };
}
