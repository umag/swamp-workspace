/**
 * Coverage suite: sweeps every guard/branch in dawarich.ts that the methods
 * and adversarial suites don't already exercise on both sides, so deleting
 * any one of these guards turns a test red (STANDARD.md's coverage role — a
 * behavioral regression guard, not a numeric percentage).
 *
 * dawarich.ts hardened its api_key transport (dawarich-hardening,
 * 2026.08.01.1); every test here PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { model } from "./dawarich.ts";

const GLOBAL_ARGS = {
  baseUrl: "https://dawarich.example.com",
  apiKey: "dw_stub",
};

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

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

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = r(req);
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

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// Guard: Array.isArray(result.data) ? result.data : [] — swept across ALL
// FIVE array-returning methods, both sides, table-driven
// ---------------------------------------------------------------------------

const ARRAY_GUARD_METHODS: Array<
  { name: string; spec: string; field: string }
> = [
  { name: "points", spec: "points", field: "points" },
  { name: "visits", spec: "visits", field: "visits" },
  { name: "tracks", spec: "tracks", field: "tracks" },
  { name: "photos", spec: "photos", field: "photos" },
  { name: "tracked-months", spec: "trackedMonths", field: "months" },
];

Deno.test("Array.isArray guard: TRUE side — an actual array body passes through unchanged, for all five array-returning methods", async () => {
  for (const { name, spec, field } of ARRAY_GUARD_METHODS) {
    const { ctx, written } = makeCtx();
    const body = [{ id: 1 }, { id: 2 }];
    await withFetchStub(
      [() =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })],
      async () => {
        await run(name, {}, ctx);
      },
    );
    const res = written.find((w) => w.spec === spec)!;
    assertEquals(
      res.payload[field],
      body,
      `${name}: array body must pass through`,
    );
  }
});

Deno.test("Array.isArray guard: FALSE side — a non-array truthy body (object) coerces to [], for all five array-returning methods", async () => {
  for (const { name, spec, field } of ARRAY_GUARD_METHODS) {
    const { ctx, written } = makeCtx();
    await withFetchStub(
      [() =>
        new Response(JSON.stringify({ unexpected: "shape" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })],
      async () => {
        await run(name, {}, ctx);
      },
    );
    const res = written.find((w) => w.spec === spec)!;
    assertEquals(
      res.payload[field],
      [],
      `${name}: non-array body must coerce to []`,
    );
  }
});

// ---------------------------------------------------------------------------
// Guard: pagination headers — both present / both absent / current present
// only / total present only / both non-numeric — swept for `points` (the
// only method that reads them)
// ---------------------------------------------------------------------------

Deno.test("pagination headers: both present -> both parsed", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Current-Page": "4",
          "X-Total-Pages": "12",
        },
      })],
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.currentPage, 4);
  assertEquals(res.payload.totalPages, 12);
});

Deno.test("pagination headers: both absent -> both undefined", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })],
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.currentPage, undefined);
  assertEquals(res.payload.totalPages, undefined);
});

Deno.test("pagination headers: X-Current-Page present, X-Total-Pages absent — independent guards", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Current-Page": "1",
        },
      })],
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.currentPage, 1);
  assertEquals(res.payload.totalPages, undefined);
});

Deno.test("pagination headers: X-Total-Pages present, X-Current-Page absent — independent guards", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Total-Pages": "7",
        },
      })],
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  assertEquals(res.payload.currentPage, undefined);
  assertEquals(res.payload.totalPages, 7);
});

Deno.test("pagination headers: both non-numeric -> both parse to NaN", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Current-Page": "garbage",
          "X-Total-Pages": "also-garbage",
        },
      })],
    async () => {
      await run("points", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "points")!;
  assert(Number.isNaN(res.payload.currentPage));
  assert(Number.isNaN(res.payload.totalPages));
});

// ---------------------------------------------------------------------------
// Guard: apiRequest's content-type / status branching — json / text / 204
// ---------------------------------------------------------------------------

Deno.test("apiRequest: content-type application/json -> body is JSON-parsed", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      })],
    async () => {
      await run("health", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.status, JSON.stringify({ status: "ok" }));
});

Deno.test("apiRequest: a non-JSON content-type -> body is read as plain text, headers object is empty", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("plain text body", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })],
    async () => {
      await run("health", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.status, "plain text body");
});

Deno.test("apiRequest: status 204 -> data is null and headers object is empty, regardless of content-type", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => new Response(null, { status: 204 })],
    async () => {
      await run("health", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.status, "null");
});

// ---------------------------------------------------------------------------
// Guard: api_key transport is a header, never joined into the query —
// no-existing-query vs already-has-query endpoints (formerly the `sep`
// local's guard; `sep` was removed once api_key left the query entirely)
// ---------------------------------------------------------------------------

Deno.test("transport guard: an endpoint with NO own query params gets no query string at all — api_key rides the Authorization header instead (points, no filters)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })],
    async (calls) => {
      await run("points", {}, ctx);
      assertEquals(new URL(calls[0].url).search, "");
      assertEquals(
        calls[0].headers.get("Authorization"),
        `Bearer ${GLOBAL_ARGS.apiKey}`,
      );
    },
  );
});

Deno.test("transport guard: an endpoint that already has its OWN query string (stats' ?year=) keeps it unchanged — no api_key joined in with `&`", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })],
    async (calls) => {
      await run("stats", { year: 2026 }, ctx);
      const search = new URL(calls[0].url).search;
      assertEquals(search, "?year=2026");
      assertEquals(
        calls[0].headers.get("Authorization"),
        `Bearer ${GLOBAL_ARGS.apiKey}`,
      );
    },
  );
});

Deno.test("transport guard: points WITH filters keeps only its own query params — api_key is never joined with `&`", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })],
    async (calls) => {
      await run("points", { page: 2 }, ctx);
      const search = new URL(calls[0].url).search;
      assertEquals(search, "?page=2");
      assertEquals(
        calls[0].headers.get("Authorization"),
        `Bearer ${GLOBAL_ARGS.apiKey}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Guard: stats' instance-name — <year> vs <year>-<zero-padded-month>
// ---------------------------------------------------------------------------

Deno.test("stats instance-name: month omitted -> bare year", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ], async () => {
    await run("stats", { year: 2026 }, ctx);
  });
  const res = written.find((w) => w.spec === "stats")!;
  assertEquals(res.name, "2026");
});

Deno.test("stats instance-name: single-digit month is zero-padded (month=1 -> '2026-01')", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ], async () => {
    await run("stats", { year: 2026, month: 1 }, ctx);
  });
  const res = written.find((w) => w.spec === "stats")!;
  assertEquals(res.name, "2026-01");
});

Deno.test("stats instance-name: double-digit month is used as-is (month=12 -> '2026-12')", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ], async () => {
    await run("stats", { year: 2026, month: 12 }, ctx);
  });
  const res = written.find((w) => w.spec === "stats")!;
  assertEquals(res.name, "2026-12");
});

// ---------------------------------------------------------------------------
// Guard: digests' instance-name is ALWAYS the bare year, regardless of
// periodType — asymmetric with stats
// ---------------------------------------------------------------------------

Deno.test("digests instance-name: stays the bare year even WITH a periodType — unlike stats, no month-suffix shape", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([
    () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ], async () => {
    await run("digests", { year: 2026, periodType: "monthly" }, ctx);
  });
  const res = written.find((w) => w.spec === "digests")!;
  assertEquals(res.name, "2026");
});

// ---------------------------------------------------------------------------
// Guard: update-settings body-key presence is independent per field
// ---------------------------------------------------------------------------

Deno.test("update-settings: timezone provided alone -> live_map_enabled key is absent (not just falsy)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([
    () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ], async (calls) => {
    await run("update-settings", { timezone: "UTC" }, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body, { timezone: "UTC" });
    assert(!("live_map_enabled" in body));
  });
});

Deno.test("update-settings: liveMapEnabled provided alone -> timezone key is absent", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([
    () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ], async (calls) => {
    await run("update-settings", { liveMapEnabled: true }, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body, { live_map_enabled: true });
    assert(!("timezone" in body));
  });
});

// ---------------------------------------------------------------------------
// Guard: health's typeof result.data === "object" ? JSON.stringify(...) :
// String(...) — BOTH branches, dedicated coverage (round-1 ADV-3 finding)
// ---------------------------------------------------------------------------

Deno.test("health status guard: an OBJECT body -> status is JSON.stringify(data)", async () => {
  const { ctx, written } = makeCtx();
  const body = { status: "ok", extra: "field" };
  await withFetchStub(
    [() =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })],
    async () => {
      await run("health", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.status, JSON.stringify(body));
});

Deno.test("health status guard: a NON-OBJECT body (plain string via non-JSON content-type) -> status is String(data)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("degraded", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })],
    async () => {
      await run("health", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "health")!;
  assertEquals(res.payload.status, "degraded");
});

// ---------------------------------------------------------------------------
// Security-review finding: apiKey is NOT marked sensitive
// ---------------------------------------------------------------------------

Deno.test("pin: `apiKey` IS marked `.meta({ sensitive: true })` — security-hardening gap closed", () => {
  // The plan v2 security-review HIGH finding: apiKey is a Dawarich API-key
  // credential but GlobalArgsSchema never called `.meta({ sensitive: true })`
  // on it, so swamp CLI/log surfaces could render it in cleartext. Fixed in
  // dawarich-hardening (2026.08.01.1): GlobalArgsSchema now marks apiKey
  // sensitive, routing it through the vault instead of plaintext instance
  // YAML. Mirrors porkbun_coverage_test.ts's apiKey/secretApiKey pin and
  // telegram_send_coverage_test.ts's POSITIVE botToken pin.
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.apiKey) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    true,
    "apiKey should be marked sensitive — if this starts failing, " +
      "dawarich.ts dropped the annotation; that is a regression",
  );
});

Deno.test("every documented enum value is still accepted by the schema (order, periodType)", () => {
  const points = (model.methods as MethodMap).points;
  for (const order of ["asc", "desc"]) {
    assertEquals(
      (points.arguments.parse({ order }) as { order: string }).order,
      order,
    );
  }
  const digests = (model.methods as MethodMap).digests;
  for (const periodType of ["yearly", "monthly"]) {
    assertEquals(
      (digests.arguments.parse({ year: 2026, periodType }) as {
        periodType: string;
      }).periodType,
      periodType,
    );
  }
});
