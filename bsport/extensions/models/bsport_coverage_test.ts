/**
 * Coverage suite for @magistr/bsport: one test per guard in the pure
 * helpers and the HTTP client, so deleting the guard turns a test red.
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  backoffMs,
  bookUrl,
  DEFAULT_BACKOFF_MS,
  type GlobalArgs,
  hasNext,
  itemId,
  MAX_BACKOFF_MS,
  memberBookingFilters,
  model,
  pageItems,
  redactSecrets,
  resolveHost,
  slug,
} from "./bsport.ts";
import {
  GLOBAL_ARGS,
  json,
  makeCtx,
  page,
  table,
  text,
  withFetch,
} from "./bsport_harness_test.ts";

const g = (over: Record<string, unknown> = {}): GlobalArgs =>
  model.globalArguments.parse({ ...GLOBAL_ARGS, ...over });

const res429 = (retryAfter?: string) =>
  new Response(null, {
    status: 429,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });

Deno.test("resolveHost strips trailing slashes", () => {
  assertEquals(
    resolveHost(g({ baseUrl: "https://h.example///" })),
    "https://h.example",
  );
});

Deno.test("resolveHost keeps a port", () => {
  assertEquals(
    resolveHost(g({ baseUrl: "http://h.example:8080" })),
    "http://h.example:8080",
  );
});

Deno.test("resolveHost rejects a non-http protocol", () => {
  assertThrows(
    () => resolveHost(g({ baseUrl: "ftp://h.example" })),
    Error,
    "protocol",
  );
});

Deno.test("baseUrl defaults to bsport production", () => {
  assertEquals(
    model.globalArguments.parse({ companyId: "1234" }).baseUrl,
    "https://api.production.bsport.io",
  );
});

Deno.test("companyId is required: the extension ships no default studio", () => {
  assertEquals(model.globalArguments.safeParse({}).success, false);
});

Deno.test("backoffMs: delay-seconds", () => {
  assertEquals(backoffMs(res429("3")), 3000);
});

Deno.test("backoffMs: caps at MAX_BACKOFF_MS", () => {
  assertEquals(backoffMs(res429("99999")), MAX_BACKOFF_MS);
});

Deno.test("backoffMs: HTTP-date relative to now", () => {
  const now = Date.parse("2026-09-15T10:00:00Z");
  assertEquals(backoffMs(res429("Tue, 15 Sep 2026 10:00:05 GMT"), now), 5000);
});

Deno.test("backoffMs: an HTTP-date in the past is zero, not negative", () => {
  const now = Date.parse("2026-09-15T10:00:00Z");
  assertEquals(backoffMs(res429("Tue, 15 Sep 2026 09:00:00 GMT"), now), 0);
});

Deno.test("backoffMs: missing or garbage header uses the default", () => {
  assertEquals(backoffMs(res429()), DEFAULT_BACKOFF_MS);
  assertEquals(backoffMs(res429("soon")), DEFAULT_BACKOFF_MS);
  assertEquals(backoffMs(res429("-5")), DEFAULT_BACKOFF_MS);
});

Deno.test("redactSecrets masks token and password and caps length", () => {
  assertEquals(
    redactSecrets("a TOK b PW c", { password: "PW" }, "TOK"),
    "a *** b *** c",
  );
  assertEquals(redactSecrets("y".repeat(500), {}).length, 300);
});

Deno.test("bookUrl prefixes /book/v1 and sets query params", () => {
  const u = new URL(bookUrl(g(), "/offer/", { a: "1", b: "" }));
  assertEquals(u.pathname, "/book/v1/offer/");
  assertEquals(u.searchParams.get("a"), "1");
  assertEquals(u.searchParams.get("b"), "");
});

Deno.test("pageItems prefers results, then data, then items", () => {
  assertEquals(pageItems({ results: [{ id: 1 }], data: [{ id: 2 }] }), [{
    id: 1,
  }]);
  assertEquals(pageItems({ data: [{ id: 2 }] }), [{ id: 2 }]);
  assertEquals(pageItems({ items: [{ id: 3 }] }), [{ id: 3 }]);
  assertEquals(pageItems(null), []);
});

Deno.test("hasNext is false for null/empty next", () => {
  assertEquals(hasNext({ next: null }), false);
  assertEquals(hasNext({ next: "" }), false);
  assertEquals(hasNext({ next: "u" }), true);
  assertEquals(hasNext([]), false);
});

Deno.test("itemId falls back id → offer → offer_id", () => {
  assertEquals(itemId({ id: 1, offer: 2 }), 1);
  assertEquals(itemId({ offer: 2, offer_id: 3 }), 2);
  assertEquals(itemId({ offer_id: 3 }), 3);
  assertEquals(itemId({ id: "1" }), null);
});

Deno.test("memberBookingFilters requires memberId", () => {
  assertThrows(
    () => memberBookingFilters(g({ memberId: undefined }), "future"),
    Error,
    "memberId",
  );
});

Deno.test("memberBookingFilters: future vs past differ only in window + order", () => {
  const f = memberBookingFilters(g(), "future");
  const p = memberBookingFilters(g(), "past");
  assertEquals(f.before_date_end, "true");
  assertEquals(p.after_date_end, "true");
  assertEquals(f.ordering, "offer__date_start");
  assertEquals(p.ordering, "-offer__date_start");
  assertEquals(f.member, p.member);
});

Deno.test("slug lower-cases, collapses separators and falls back to 'all'", () => {
  assertEquals(slug("  North / Beginner!! "), "north-beginner");
  assertEquals(slug("!!!"), "all");
  assertEquals(slug("a".repeat(100)).length, 48);
});

Deno.test("paginate dedups an id repeated across pages", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/booking/": (c) =>
        c.url.searchParams.get("page") === "1"
          ? json(page([{ id: 1 }, { id: 2 }], "more"))
          : json(page([{ id: 2 }, { id: 3 }])),
    }),
    () =>
      model.methods.listFutureBookings.execute(
        model.methods.listFutureBookings.arguments.parse({}),
        ctx,
      ),
  );
  assertEquals(written.at(-1)!.payload.ids, [1, 2, 3]);
});

Deno.test("paginate: id-less items count toward total but not ids", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/booking/": () => json(page([{ id: 1 }, { note: "x" }])),
    }),
    () =>
      model.methods.listFutureBookings.execute(
        model.methods.listFutureBookings.arguments.parse({}),
        ctx,
      ),
  );
  const summary = written.at(-1)!.payload;
  assertEquals(summary.total, 2);
  assertEquals(summary.ids, [1]);
  assertEquals(written[1].name, "booking-idx1");
});

Deno.test("listMyWaitlist caps entries at maxResults and flags truncation", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/waiting-list/booking-option/": () =>
        json(page([{ id: 1, offer: 10 }, { id: 2, offer: 20 }, {
          id: 3,
          offer: 30,
        }], "more")),
      "GET /book/v1/offer/waiting_list_position_list/": () => json([]),
    }),
    async (calls) => {
      await model.methods.listMyWaitlist.execute(
        model.methods.listMyWaitlist.arguments.parse({ maxResults: 2 }),
        ctx,
      );
      assertEquals(calls.length, 2);
      assertEquals(calls[1].url.searchParams.get("id__in"), "10,20");
    },
  );
  const summary = written.at(-1)!.payload;
  assertEquals(summary.truncated, true);
  assertEquals(summary.ids, [10, 20]);
});

Deno.test("listMyWaitlist dedups offer ids before the position lookup", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/waiting-list/booking-option/": () =>
        json(page([{ id: 1, offer: 10 }, { id: 2, offer: 10 }])),
      "GET /book/v1/offer/waiting_list_position_list/": () => json([]),
    }),
    async (calls) => {
      await model.methods.listMyWaitlist.execute(
        model.methods.listMyWaitlist.arguments.parse({}),
        ctx,
      );
      assertEquals(calls[1].url.searchParams.get("id__in"), "10");
    },
  );
});

Deno.test("http: maxRetries 0 means no retry on 429", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, maxRetries: 0 });
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () =>
        text("", 429, { "Retry-After": "0" }),
    }),
    async (calls) => {
      await assertRejects(() =>
        model.methods.listRegisteredOffers.execute({}, ctx)
      );
      assertEquals(calls.length, 1);
    },
  );
});

Deno.test("http: a stalled body is aborted by timeoutMs", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, timeoutMs: 20 });
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":['));
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  try {
    await assertRejects(() =>
      model.methods.listRegisteredOffers.execute({}, ctx)
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("upgrades chain ends at the model version", () => {
  assertEquals(model.upgrades.at(-1)?.toVersion, model.version);
});
