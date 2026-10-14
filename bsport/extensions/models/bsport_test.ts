/**
 * Contract-fixture suite for @magistr/bsport: pins the member-API wire
 * format — request paths, query parameters, the `Authorization: Token`
 * header, the login request, DRF page/page_size pagination — and the mapping
 * of the fixtures under `fixtures/` (see fixtures/PROVENANCE.md) into stored
 * resources. If a test here breaks, the contract with bsport changed.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./bsport.ts";
import {
  BASE,
  GLOBAL_ARGS,
  json,
  makeCtx,
  table,
  TOKEN,
  withFetch,
} from "./bsport_harness_test.ts";
import offersFixture from "../../fixtures/offers.json" with { type: "json" };
import bookingsPage1 from "../../fixtures/bookings_page1.json" with {
  type: "json",
};
import bookingsPage2 from "../../fixtures/bookings_page2.json" with {
  type: "json",
};
import establishmentsFixture from "../../fixtures/establishments.json" with {
  type: "json",
};
import waitlistOptions from "../../fixtures/waitlist_booking_options.json" with {
  type: "json",
};
import waitlistPositions from "../../fixtures/waitlist_positions.json" with {
  type: "json",
};
import loginFixture from "../../fixtures/login.json" with { type: "json" };

const m = model.methods;

Deno.test("every request carries Token auth, JSON Accept and User-Agent", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/establishment/": () => json(establishmentsFixture) }),
    async (calls) => {
      await m.listEstablishments.execute({}, ctx);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].headers["authorization"], `Token ${TOKEN}`);
      assertEquals(calls[0].headers["accept"], "application/json");
      assertEquals(
        calls[0].headers["user-agent"],
        "swamp-bsport/1.0 (+https://swamp-club.com)",
      );
      assertEquals(calls[0].headers["content-type"], undefined);
    },
  );
});

Deno.test("listEstablishments: GET /book/v1/establishment/?company&page_size=300", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/establishment/": () => json(establishmentsFixture) }),
    async (calls) => {
      await m.listEstablishments.execute({}, ctx);
      const p = calls[0].url.searchParams;
      assertEquals(calls[0].url.origin, BASE);
      assertEquals(p.get("company"), "1234");
      assertEquals(p.get("page_size"), "300");
    },
  );
  assertEquals(written.map((w) => `${w.spec}/${w.name}`), [
    "establishment/establishment-1001",
    "establishment/establishment-1002",
    "summary/summary-establishments",
  ]);
  assertEquals(written[0].payload.name, "North");
  assertEquals(written[2].payload.ids, [1001, 1002]);
  assertEquals(written[2].payload.endpoint, "/book/v1/establishment/");
});

Deno.test("listOffers: calendar query parameters", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/offer/": () => json(offersFixture) }),
    async (calls) => {
      await m.listOffers.execute(
        m.listOffers.arguments.parse({
          minDate: "2026-09-15",
          maxDate: "2026-09-22",
          establishments: [1001],
          levels: [2, 3],
          activities: [801],
          coaches: [5512],
        }),
        ctx,
      );
      assertEquals(calls.length, 1);
      const p = calls[0].url.searchParams;
      assertEquals(Object.fromEntries(p), {
        company: "1234",
        min_date: "2026-09-15",
        max_date: "2026-09-22",
        only_future_strict: "false",
        with_tags: "true",
        establishments: "1001",
        levels: "2,3",
        activity__in: "801",
        coaches: "5512",
        establishment_group__in: "",
        page: "1",
        page_size: "100",
      });
    },
  );
});

Deno.test("listOffers: fixture offers keep capacity and waitlist fields", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/offer/": () => json(offersFixture) }),
    () =>
      m.listOffers.execute(
        m.listOffers.arguments.parse({
          minDate: "2026-09-15",
          maxDate: "2026-09-22",
        }),
        ctx,
      ),
  );
  assertEquals(written.map((w) => w.name), [
    "offer-90211",
    "offer-90212",
    "summary-offers-2026-09-15-2026-09-22",
  ]);
  const full = written[0].payload;
  assertEquals(full.effectif, 12);
  assertEquals(full.validated_booking_count, 12);
  assertEquals(full.full, true);
  assertEquals(full.waiting_list_max_size, 5);
  assertEquals(full.is_waiting_list_full, false);
  assert(typeof full.fetchedAt === "string");
  // Every stored offer validates against the declared resource schema.
  for (const w of written.slice(0, 2)) {
    model.resources.offer.schema.parse(w.payload);
  }
  model.resources.summary.schema.parse(written[2].payload);
  assertEquals(written[2].payload.filters, {
    min_date: "2026-09-15",
    max_date: "2026-09-22",
  });
});

Deno.test("getOffers: id__in and ignore_manager_only", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/offer/": () => json(offersFixture) }),
    async (calls) => {
      await m.getOffers.execute({ ids: [90211, 90212] }, ctx);
      const p = calls[0].url.searchParams;
      assertEquals(p.get("id__in"), "90211,90212");
      assertEquals(p.get("ignore_manager_only"), "true");
    },
  );
  assertEquals(written.at(-1)?.name, "summary-getOffers-90211-90212");
});

Deno.test("listFutureBookings: member filters and DRF page walk", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/booking/": (c) =>
        json(
          c.url.searchParams.get("page") === "1"
            ? bookingsPage1
            : bookingsPage2,
        ),
    }),
    async (calls) => {
      await m.listFutureBookings.execute(
        m.listFutureBookings.arguments.parse({ pageSize: 2 }),
        ctx,
      );
      assertEquals(calls.length, 2);
      const p = calls[0].url.searchParams;
      assertEquals(p.get("member"), "777");
      assertEquals(p.get("mine_as_consumer"), "true");
      assertEquals(p.get("offer_is_workshop"), "false");
      assertEquals(p.get("before_date_end"), "true");
      assertEquals(p.get("after_date_end"), null);
      assertEquals(p.get("ordering"), "offer__date_start");
      assertEquals(p.get("page_size"), "2");
      assertEquals(calls.map((c) => c.url.searchParams.get("page")), [
        "1",
        "2",
      ]);
    },
  );
  assertEquals(written.map((w) => w.name), [
    "booking-7001",
    "booking-7002",
    "booking-7003",
    "summary-bookings-future",
  ]);
  for (const w of written.slice(0, 3)) {
    model.resources.booking.schema.parse(w.payload);
  }
  assertEquals(written[3].payload.total, 3);
  assertEquals(written[3].payload.truncated, false);
});

Deno.test("listPastBookings: after_date_end, newest first", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/booking/": () => json(bookingsPage2) }),
    async (calls) => {
      await m.listPastBookings.execute(
        m.listPastBookings.arguments.parse({}),
        ctx,
      );
      const p = calls[0].url.searchParams;
      assertEquals(p.get("after_date_end"), "true");
      assertEquals(p.get("before_date_end"), null);
      assertEquals(p.get("ordering"), "-offer__date_start");
    },
  );
  assertEquals(written.at(-1)?.payload.filters, {
    member: "777",
    when: "past",
  });
});

Deno.test("listMyWaitlist: booking-option listing then positions", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/waiting-list/booking-option/": () => json(waitlistOptions),
      "GET /book/v1/offer/waiting_list_position_list/": () =>
        json(waitlistPositions),
    }),
    async (calls) => {
      await m.listMyWaitlist.execute(
        m.listMyWaitlist.arguments.parse({}),
        ctx,
      );
      assertEquals(calls.length, 2);
      assertEquals(Object.fromEntries(calls[0].url.searchParams), {
        company: "1234",
        consumer: "88001",
        mine: "true",
        offer_is_workshop: "false",
        ordering: "offer__date_start",
        page: "1",
        page_size: "100",
      });
      assertEquals(calls[1].url.searchParams.get("id__in"), "90211,90500");
    },
  );
  assertEquals(written.map((w) => `${w.spec}/${w.name}`), [
    "waitlistEntry/waitlistentry-333",
    "waitlistEntry/waitlistentry-334",
    "waitlistPosition/waitlist-90211",
    "waitlistPosition/waitlist-90500",
    "summary/summary-my-waitlist",
  ]);
  model.resources.waitlistPosition.schema.parse(written[2].payload);
  assertEquals(written[2].payload.position, 2);
  assertEquals(written[4].payload.ids, [90211, 90500]);
});

Deno.test("listRegisteredOffers: GET /book/v1/offer/registered/ without query", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/offer/registered/": () => json(offersFixture) }),
    async (calls) => {
      await m.listRegisteredOffers.execute({}, ctx);
      assertEquals(calls[0].url.search, "");
    },
  );
  assertEquals(written.at(-1)?.name, "summary-registered");
  assertEquals(written.at(-1)?.payload.ids, [90211, 90212]);
});

Deno.test("listWaitlist: explicit offerIds go straight to positions", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/waiting_list_position_list/": () =>
        json(waitlistPositions),
    }),
    async (calls) => {
      await m.listWaitlist.execute({ offerIds: [90211, 90500] }, ctx);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url.searchParams.get("id__in"), "90211,90500");
    },
  );
  assertEquals(written.at(-1)?.payload.filters, { id__in: "90211,90500" });
});

Deno.test("login: POST {email,password} to authPath signin, then Token", async () => {
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    token: undefined,
    email: "me@example.com",
    password: "pw-SECRET",
  });
  await withFetch(
    table({
      "POST /api-v0/authentication/signin/with-login/": () =>
        json(loginFixture),
      "GET /book/v1/offer/registered/": () => json({ results: [] }),
    }),
    async (calls) => {
      await m.listRegisteredOffers.execute({}, ctx);
      assertEquals(calls.length, 2);
      assertEquals(calls[0].method, "POST");
      assertEquals(calls[0].headers["content-type"], "application/json");
      assertEquals(calls[0].headers["authorization"], undefined);
      assertEquals(calls[0].body, {
        email: "me@example.com",
        password: "pw-SECRET",
      });
      assertEquals(
        calls[1].headers["authorization"],
        `Token ${loginFixture.token}`,
      );
    },
  );
});

Deno.test("DRF envelope: results, data, items and bare arrays all parse", async () => {
  for (
    const body of [
      { results: establishmentsFixture.results },
      { data: establishmentsFixture.results },
      { items: establishmentsFixture.results },
      establishmentsFixture.results,
    ]
  ) {
    const { ctx, written } = makeCtx();
    await withFetch(
      table({ "GET /book/v1/establishment/": () => json(body) }),
      () => m.listEstablishments.execute({}, ctx),
    );
    assertEquals(written.length, 3);
  }
});
