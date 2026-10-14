/**
 * Adversarial suite for @magistr/bsport: hostile input and a hostile
 * network — credential echo in error bodies, URL/host injection, instance
 * name injection through method arguments, spec-violating responses, and a
 * server that replays the same page forever.
 */
import {
  assert,
  assertEquals,
  assertFalse,
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
  TOKEN,
  withFetch,
} from "./bsport_harness_test.ts";

const m = model.methods;

Deno.test("error body echoing the token is redacted", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () =>
        text(`invalid token ${TOKEN} for this tenant`, 403),
    }),
    async () => {
      const err = await assertRejects(() =>
        m.listRegisteredOffers.execute({}, ctx)
      );
      assertFalse(String(err).includes(TOKEN));
      assertStringIncludes(String(err), "***");
    },
  );
});

Deno.test("error body echoing the password is redacted", async () => {
  const password = "hunter2-SECRET";
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    token: undefined,
    email: "e@x",
    password,
  });
  await withFetch(
    table({
      "POST /api-v0/authentication/signin/with-login/": () =>
        text(`{"password":"${password}","error":"nope"}`, 400),
    }),
    async () => {
      const err = await assertRejects(() =>
        m.listRegisteredOffers.execute({}, ctx)
      );
      assertFalse(String(err).includes(password));
    },
  );
});

Deno.test("error message drops the query string (ids/filters) from the URL", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({ "GET /book/v1/offer/": () => text("nope", 500) }),
    async () => {
      const err = await assertRejects(() =>
        m.getOffers.execute({ ids: [123456] }, ctx)
      );
      assertFalse(String(err).includes("id__in"));
      assertFalse(String(err).includes("123456"));
    },
  );
});

Deno.test("a huge error body is capped", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () => text("x".repeat(100_000), 500),
    }),
    async () => {
      const err = await assertRejects(() =>
        m.listRegisteredOffers.execute({}, ctx)
      );
      assert(String(err).length < 1000);
    },
  );
});

Deno.test("non-http baseUrl schemes are refused before any request", async () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://evil.example"]) {
    const { ctx } = makeCtx({ ...GLOBAL_ARGS, baseUrl });
    await withFetch(table({}), async (calls) => {
      await assertRejects(() => m.listRegisteredOffers.execute({}, ctx));
      assertEquals(calls.length, 0);
    });
  }
});

Deno.test("baseUrl with embedded credentials is refused", async () => {
  const { ctx } = makeCtx({
    ...GLOBAL_ARGS,
    baseUrl: "https://user:pw@api.bsport.example",
  });
  await withFetch(table({}), async (calls) => {
    await assertRejects(
      () => m.listRegisteredOffers.execute({}, ctx),
      Error,
      "credentials",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("a path-traversal date cannot reach an instance name", () => {
  for (
    const bad of ["../../etc", "2026-09-01/../x", "2026-9-1", "2026-09-01 "]
  ) {
    assertFalse(
      m.listOffers.arguments.safeParse({ minDate: bad, maxDate: "2026-09-30" })
        .success,
      bad,
    );
  }
});

Deno.test("query parameters are URL-encoded, not concatenated", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, companyId: "1&admin=true" });
  await withFetch(
    table({ "GET /book/v1/establishment/": () => json(page([])) }),
    async (calls) => {
      await m.listEstablishments.execute({}, ctx);
      assertEquals(calls[0].url.searchParams.get("company"), "1&admin=true");
      assertEquals(calls[0].url.searchParams.get("admin"), null);
    },
  );
});

Deno.test("a server ignoring `page` while advertising next does not loop forever", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/booking/": () =>
        json(page([{ id: 1 }, { id: 2 }], "https://x/?page=2")),
    }),
    async (calls) => {
      await m.listFutureBookings.execute(
        m.listFutureBookings.arguments.parse({}),
        ctx,
      );
      assertEquals(calls.length, 2);
    },
  );
  assertEquals(written.at(-1)!.payload.total, 2);
});

Deno.test("a 200 with a non-JSON body is a clean error", async () => {
  const { ctx } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () => text("<html>maintenance</html>"),
    }),
    async () => {
      await assertRejects(
        () => m.listRegisteredOffers.execute({}, ctx),
        Error,
        "non-JSON",
      );
    },
  );
});

Deno.test("a JSON body of the wrong shape yields zero items, not a crash", async () => {
  for (const body of [null, 42, "str", { results: "nope" }, { next: "x" }]) {
    const { ctx, written } = makeCtx();
    await withFetch(
      table({ "GET /book/v1/offer/registered/": () => json(body) }),
      () => m.listRegisteredOffers.execute({}, ctx),
    );
    assertEquals(written.length, 1, JSON.stringify(body));
    assertEquals(written[0].payload.total, 0);
  }
});

Deno.test("login token of the wrong type is rejected", async () => {
  for (const token of [123, "", null, ["t"]]) {
    const { ctx } = makeCtx({
      ...GLOBAL_ARGS,
      token: undefined,
      email: "e@x",
      password: "p",
    });
    await withFetch(
      table({
        "POST /api-v0/authentication/signin/with-login/": () => json({ token }),
      }),
      async (calls) => {
        await assertRejects(() => m.listRegisteredOffers.execute({}, ctx));
        assertEquals(calls.length, 1);
      },
    );
  }
});

Deno.test("an empty-string token in globalArgs fails schema validation", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, token: "" });
  await withFetch(table({}), async (calls) => {
    await assertRejects(() => m.listRegisteredOffers.execute({}, ctx));
    assertEquals(calls.length, 0);
  });
});

Deno.test("token and password are declared sensitive", () => {
  const shape = model.globalArguments.shape;
  assertEquals(shape.token.unwrap().meta()?.sensitive, true);
  assertEquals(shape.password.unwrap().meta()?.sensitive, true);
});

Deno.test("the token is never written into a stored resource", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/offer/registered/": () => json(page([{ id: 1 }])),
    }),
    () => m.listRegisteredOffers.execute({}, ctx),
  );
  assertFalse(JSON.stringify(written).includes(TOKEN));
});

Deno.test("waitlist entries without any id do not overwrite each other", async () => {
  const { ctx, written } = makeCtx();
  await withFetch(
    table({
      "GET /book/v1/waiting-list/booking-option/": () =>
        json(page([{ note: "a" }, { note: "b" }])),
    }),
    () => m.listMyWaitlist.execute(m.listMyWaitlist.arguments.parse({}), ctx),
  );
  const names = written.filter((w) => w.spec === "waitlistEntry").map((w) =>
    w.name
  );
  assertEquals(names.length, 2);
  assertEquals(new Set(names).size, 2);
});
