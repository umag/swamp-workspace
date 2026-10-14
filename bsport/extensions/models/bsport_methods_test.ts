/**
 * Methods suite for @magistr/bsport: every model method's success and
 * failure paths, with `fetch` stubbed.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { model } from "./bsport.ts";
import {
  GLOBAL_ARGS,
  json,
  makeCtx,
  page,
  table,
  text,
  withFetch,
} from "./bsport_harness_test.ts";

const m = model.methods;
const offer = (id: number) => ({ id, name: `class ${id}` });

Deno.test("listEstablishments: skips items without a numeric id", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/establishment/": () =>
        json(page([{ id: 1, name: "A" }, { name: "no id" }, { id: "x" }])),
    }),
    () => m.listEstablishments.execute({}, ctx),
  );
  assertEquals(written.map((w) => w.name), [
    "establishment-1",
    "summary-establishments",
  ]);
  assertEquals(written[1].payload.total, 1);
});

Deno.test("listEstablishments: an empty listing still writes a summary", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/establishment/": () => json(page([])) }),
    () => m.listEstablishments.execute({}, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].payload.total, 0);
});

Deno.test("listEstablishments: a 500 fails the method", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/establishment/": () => text("boom", 500) }),
    async () => {
      const err = await assertRejects(() =>
        m.listEstablishments.execute({}, ctx)
      );
      assertStringIncludes(String(err), "500");
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("listOffers: paginates until next is absent", async () => {
  const { ctx, written, logs } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/": (c) => {
        const p = c.url.searchParams.get("page");
        return p === "1"
          ? json(page([offer(1), offer(2)], "more"))
          : json(page([offer(3)]));
      },
    }),
    async (calls) => {
      await m.listOffers.execute(
        m.listOffers.arguments.parse({
          minDate: "2026-09-01",
          maxDate: "2026-09-30",
          pageSize: 2,
        }),
        ctx,
      );
      assertEquals(calls.length, 2);
    },
  );
  const summary = written.at(-1)!.payload;
  assertEquals(summary.total, 3);
  assertEquals(summary.ids, [1, 2, 3]);
  assertEquals(summary.truncated, false);
  assertEquals(logs, ["Fetched {n} offers"]);
});

Deno.test("listOffers: maxResults truncates and stops paging", async () => {
  const { ctx, written, logs } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/": () =>
        json(page([offer(1), offer(2), offer(3)], "more")),
    }),
    async (calls) => {
      await m.listOffers.execute(
        m.listOffers.arguments.parse({
          minDate: "2026-09-01",
          maxDate: "2026-09-30",
          maxResults: 2,
        }),
        ctx,
      );
      assertEquals(calls.length, 1);
    },
  );
  assertEquals(written.length, 3);
  assertEquals(written[2].payload.truncated, true);
  assertEquals(logs, ["Fetched {n} offers (truncated)"]);
});

Deno.test("listOffers: rejects a non-YYYY-MM-DD date at argument parse", () => {
  const r = m.listOffers.arguments.safeParse({
    minDate: "next week",
    maxDate: "2026-09-30",
  });
  assert(!r.success);
});

Deno.test("getOffers: requires at least one id", () => {
  assert(!m.getOffers.arguments.safeParse({ ids: [] }).success);
  assert(m.getOffers.arguments.safeParse({ ids: [1] }).success);
});

Deno.test("getOffers: writes each returned offer", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/offer/": () => json([offer(5), offer(6)]) }),
    () => m.getOffers.execute({ ids: [5, 6] }, ctx),
  );
  assertEquals(written.map((w) => w.name), [
    "offer-5",
    "offer-6",
    "summary-getOffers-5-6",
  ]);
});

Deno.test("listFutureBookings: missing memberId fails before any request", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, memberId: undefined });
  await withFetch(table({}), async (calls) => {
    await assertRejects(
      () =>
        m.listFutureBookings.execute(
          m.listFutureBookings.arguments.parse({}),
          ctx,
        ),
      Error,
      "memberId",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("listPastBookings: missing memberId fails before login", async () => {
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    memberId: undefined,
    token: undefined,
    email: "e@x",
    password: "p",
  });
  await withFetch(table({}), async (calls) => {
    await assertRejects(
      () =>
        m.listPastBookings.execute(m.listPastBookings.arguments.parse({}), ctx),
      Error,
      "memberId",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("listPastBookings: writes bookings and a past summary", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/booking/": () => json(page([{ id: 1, offer: 9 }])),
    }),
    () =>
      m.listPastBookings.execute(m.listPastBookings.arguments.parse({}), ctx),
  );
  assertEquals(written.map((w) => w.name), [
    "booking-1",
    "summary-bookings-past",
  ]);
  assertEquals(written[1].payload.scope, "pastBookings");
});

Deno.test("listMyWaitlist: missing consumerId fails before any request", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, consumerId: undefined });
  await withFetch(table({}), async (calls) => {
    await assertRejects(
      () => m.listMyWaitlist.execute(m.listMyWaitlist.arguments.parse({}), ctx),
      Error,
      "consumerId",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("listMyWaitlist: no entries → no position lookup", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/waiting-list/booking-option/": () => json(page([])),
    }),
    async (calls) => {
      await m.listMyWaitlist.execute(
        m.listMyWaitlist.arguments.parse({}),
        ctx,
      );
      assertEquals(calls.length, 1);
    },
  );
  assertEquals(written.map((w) => w.name), ["summary-my-waitlist"]);
  assertEquals(written[0].payload.total, 0);
});

Deno.test("listMyWaitlist: follows next across pages", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/waiting-list/booking-option/": (c) =>
        c.url.searchParams.get("page") === "1"
          ? json(page([{ id: 1, offer: 10 }], "more"))
          : json(page([{ id: 2, offer: 20 }])),
      "GET /book/v1/offer/waiting_list_position_list/": () =>
        json([{ id: 10, position: 1 }, { id: 20, position: 4 }]),
    }),
    async (calls) => {
      await m.listMyWaitlist.execute(
        m.listMyWaitlist.arguments.parse({}),
        ctx,
      );
      assertEquals(calls.length, 3);
      assertEquals(calls[2].url.searchParams.get("id__in"), "10,20");
    },
  );
  assertEquals(written.at(-1)!.payload.ids, [10, 20]);
});

Deno.test("listRegisteredOffers: writes each registered offer", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () => json(page([offer(3)])),
    }),
    () => m.listRegisteredOffers.execute({}, ctx),
  );
  assertEquals(written.map((w) => w.name), ["offer-3", "summary-registered"]);
});

Deno.test("listWaitlist: without offerIds, falls back to registered offers", async () => {
  const { ctx, written, logs } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () => json(page([offer(4), offer(8)])),
      "GET /book/v1/offer/waiting_list_position_list/": () =>
        json([{ id: 4, position: 2 }]),
    }),
    async (calls) => {
      await m.listWaitlist.execute({}, ctx);
      assertEquals(calls.length, 2);
      assertEquals(calls[1].url.searchParams.get("id__in"), "4,8");
    },
  );
  assertEquals(written.map((w) => w.name), ["waitlist-4", "summary-waitlist"]);
  assertEquals(logs, ["Fetched {n} waitlist positions"]);
});

Deno.test("listWaitlist: nothing registered → empty summary, one request", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/offer/registered/": () => json(page([])) }),
    async (calls) => {
      const r = await m.listWaitlist.execute({ offerIds: [] }, ctx);
      assertEquals(calls.length, 1);
      assertEquals(r.dataHandles.length, 1);
    },
  );
  assertEquals(written[0].payload.total, 0);
  assertEquals(written[0].payload.filters, {});
});

Deno.test("login: no token and no credentials is a clear error", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, token: undefined });
  await withFetch(table({}), async (calls) => {
    await assertRejects(
      () => m.listRegisteredOffers.execute({}, ctx),
      Error,
      "either `token` or both `email` and `password`",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("login: a response without token is rejected", async () => {
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    token: undefined,
    email: "e@x",
    password: "p",
  });
  await withFetch(
    table({
      "POST /api-v0/authentication/signin/with-login/": () =>
        json({ is_manager: false }),
    }),
    async () => {
      await assertRejects(
        () => m.listRegisteredOffers.execute({}, ctx),
        Error,
        "no `token` field",
      );
    },
  );
});

Deno.test("login: a 401 from signin fails the method", async () => {
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    token: undefined,
    email: "e@x",
    password: "p",
  });
  await withFetch(
    table({
      "POST /api-v0/authentication/signin/with-login/": () =>
        text('{"detail":"bad credentials"}', 401),
    }),
    async () => {
      const err = await assertRejects(() =>
        m.listRegisteredOffers.execute({}, ctx)
      );
      assertStringIncludes(String(err), "401");
    },
  );
});

Deno.test("http: 204 yields no items", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () =>
        new Response(null, { status: 204 }),
    }),
    () => m.listRegisteredOffers.execute({}, ctx),
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].payload.total, 0);
});

Deno.test("http: 429 with Retry-After: 0 is retried", async () => {
  const { ctx, written } = makeCtx();
  let n = 0;
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () =>
        ++n === 1
          ? text("slow down", 429, { "Retry-After": "0" })
          : json(page([offer(1)])),
    }),
    async (calls) => {
      await m.listRegisteredOffers.execute({}, ctx);
      assertEquals(calls.length, 2);
    },
  );
  assertEquals(written.length, 2);
});

Deno.test("http: 429 past maxRetries surfaces the 429", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, maxRetries: 1 });
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () =>
        text("slow down", 429, { "Retry-After": "0" }),
    }),
    async (calls) => {
      const err = await assertRejects(() =>
        m.listRegisteredOffers.execute({}, ctx)
      );
      assertStringIncludes(String(err), "429");
      assertEquals(calls.length, 2);
    },
  );
});
