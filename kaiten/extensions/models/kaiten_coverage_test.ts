/**
 * Coverage suite: sweeps every guard/branch in kaiten.ts that the contract,
 * methods, and adversarial suites don't already exercise on both sides, so
 * deleting any one of these guards turns a test red (STANDARD.md's coverage
 * role — a behavioral regression guard, not a numeric percentage).
 *
 * kaiten.ts is UNMODIFIED; every test PINS existing behavior.
 *
 * `resolveBase` is ALREADY fully covered by kaiten_test.ts (bare/full host,
 * protocol/path strip, apiVersion, traversal, illegal charset) — it is
 * deliberately NOT re-tested here.
 *
 * Genuine gaps targeted:
 *  - asArray's {data|items|results} wrapper branches + the [] fallback for a
 *    non-array/non-object body
 *  - itemId's null-skip for a non-numeric/absent id
 *  - backoffMs's X-RateLimit-Reset branch (kaiten_test.ts covers only
 *    Retry-After)
 *  - kget's empty-value query-param drop
 *  - listCards's condition/archived string mapping (both branches each)
 *  - listCards's summary resource naming (slug of the filter set)
 *  - a security-review pin: globalArguments.token is NOT `.meta({
 *    sensitive })` today — a documented hardening gap, mirroring the
 *    porkbun precedent. Not fixed here (kaiten.ts is byte-frozen).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { backoffMs, model } from "./kaiten.ts";

const GLOBAL_ARGS = { domain: "acme", token: "coverage-stub-token" };

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// asArray: {data|items|results} wrapper branches — both sides + fallback
// ---------------------------------------------------------------------------

Deno.test("asArray: {data:[...]} wrapper is unwrapped", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ data: [{ id: 1 }, { id: 2 }] })],
    async () => {
      await run("listSpaces", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "space").length, 2);
});

Deno.test("asArray: {items:[...]} wrapper is unwrapped", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ items: [{ id: 1 }] })],
    async () => {
      await run("listSpaces", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "space").length, 1);
});

Deno.test("asArray: {results:[...]} wrapper is unwrapped", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ results: [{ id: 1 }] })],
    async () => {
      await run("listSpaces", {}, ctx);
    },
  );
  assertEquals(written.filter((w) => w.spec === "space").length, 1);
});

Deno.test("asArray: a plain object with none of data/items/results -> [] fallback, summary total 0", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ unrelated: "shape" })], async () => {
    await run("listSpaces", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "space").length, 0);
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 0);
  assertEquals(summary.payload.ids, []);
});

Deno.test("asArray: a bare JSON null -> [] fallback (not a crash)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json(null)], async () => {
    await run("listSpaces", {}, ctx);
  });
  assertEquals(written.filter((w) => w.spec === "space").length, 0);
});

// ---------------------------------------------------------------------------
// itemId: null-skip for a non-numeric / absent id
// ---------------------------------------------------------------------------

Deno.test("itemId: an item whose id is a STRING (not a number) is skipped, not coerced", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      json([{ id: "not-a-number", title: "bad" }, { id: 7, title: "good" }])],
    async () => {
      await run("listSpaces", {}, ctx);
    },
  );
  const spaces = written.filter((w) => w.spec === "space");
  assertEquals(spaces.length, 1);
  assertEquals(spaces[0].name, "space-7");
});

Deno.test("itemId: an item with NO id field at all is skipped", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json([{ title: "no id here" }, { id: 3 }])],
    async () => {
      await run("listSpaces", {}, ctx);
    },
  );
  const spaces = written.filter((w) => w.spec === "space");
  assertEquals(spaces.length, 1);
  assertEquals(spaces[0].name, "space-3");
});

// ---------------------------------------------------------------------------
// backoffMs: X-RateLimit-Reset branch (kaiten_test.ts covers only Retry-After)
// ---------------------------------------------------------------------------

Deno.test("backoffMs: falls back to X-RateLimit-Reset (epoch seconds) when Retry-After is absent", () => {
  const resetAt = Math.floor(Date.now() / 1000) + 5; // 5s in the future
  const ms = backoffMs(
    new Response(null, { headers: { "X-RateLimit-Reset": String(resetAt) } }),
  );
  // resetMs + 500 buffer, roughly 5000-5500ms; allow generous scheduling slack.
  assert(ms >= 4000 && ms <= 6000, `expected ~5000ms, got ${ms}`);
});

Deno.test("backoffMs: X-RateLimit-Reset in the PAST yields a non-positive resetMs, falling through to the 1s default", () => {
  const pastEpoch = Math.floor(Date.now() / 1000) - 100;
  const ms = backoffMs(
    new Response(null, {
      headers: { "X-RateLimit-Reset": String(pastEpoch) },
    }),
  );
  assertEquals(ms, 1000);
});

Deno.test("backoffMs: Retry-After takes priority over X-RateLimit-Reset when both are present", () => {
  const ms = backoffMs(
    new Response(null, {
      headers: {
        "Retry-After": "3",
        "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 999),
      },
    }),
  );
  assertEquals(ms, 3000);
});

// ---------------------------------------------------------------------------
// kget: empty-value query-param drop
// ---------------------------------------------------------------------------

Deno.test("kget: an empty-string filter value is DROPPED from the query string, not sent as ''", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", { additionalParams: { tag_ids: "" } }, ctx);
    const url = new URL(calls[0].url);
    assert(
      !url.searchParams.has("tag_ids"),
      "an empty-string additionalParams value must be omitted, per kget's guard",
    );
  });
});

Deno.test("kget: a non-empty filter value IS sent", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", { additionalParams: { tag_ids: "9" } }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(url.searchParams.get("tag_ids"), "9");
  });
});

// ---------------------------------------------------------------------------
// listCards: condition mapping — both branches
// ---------------------------------------------------------------------------

Deno.test("listCards: condition='live' -> numeric '1'", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", { condition: "live" }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("condition"), "1");
  });
});

Deno.test("listCards: condition omitted -> no condition param at all", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", {}, ctx);
    assert(!new URL(calls[0].url).searchParams.has("condition"));
  });
});

// ---------------------------------------------------------------------------
// listCards: archived mapping — both branches
// ---------------------------------------------------------------------------

Deno.test("listCards: archived=true -> 'true' string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", { archived: true }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("archived"), "true");
  });
});

Deno.test("listCards: archived=false -> 'false' string (not omitted — false is a real filter, not absence)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", { archived: false }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("archived"), "false");
  });
});

Deno.test("listCards: archived omitted -> no archived param at all", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json([])], async (calls) => {
    await run("listCards", {}, ctx);
    assert(!new URL(calls[0].url).searchParams.has("archived"));
  });
});

// ---------------------------------------------------------------------------
// listCards: summary resource naming (slug of the JSON-stringified filters)
// ---------------------------------------------------------------------------

Deno.test("listCards: summary resource name is 'summary-cards-<slug(filters)>'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json([{ id: 1 }])], async () => {
    await run("listCards", { boardId: 128 }, ctx);
  });
  const summary = written.find((w) => w.spec === "summary")!;
  assert(summary.name.startsWith("summary-cards-"));
  assert(
    summary.name.includes("board") ||
      summary.name.length > "summary-cards-".length,
    "the slug must be derived from the actual filter set, not a constant",
  );
});

Deno.test("listCards: summary resource name with NO filters slugs to 'summary-cards-all'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json([])], async () => {
    await run("listCards", {}, ctx);
  });
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.name, "summary-cards-all");
});

// ---------------------------------------------------------------------------
// Schema-boundary rejection: invalid ids / enum values never reach execute()
// ---------------------------------------------------------------------------

Deno.test("schema boundary: getSpace/getBoard/getCard/listBoards/listColumns reject a non-positive id at parse time", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["getSpace", { id: 0 }],
    ["getSpace", { id: -1 }],
    ["getBoard", { id: 0 }],
    ["getCard", { id: -5 }],
    ["listBoards", { spaceId: 0 }],
    ["listColumns", { boardId: -1 }],
  ];
  for (const [name, args] of cases) {
    const method = (model.methods as MethodMap)[name];
    let threw = false;
    try {
      method.arguments.parse(args);
    } catch {
      threw = true;
    }
    assert(
      threw,
      `${name} must reject ${JSON.stringify(args)} at the schema boundary`,
    );
  }
});

Deno.test("schema boundary: listCards rejects a condition value outside the live/done enum at parse time", () => {
  const method = (model.methods as MethodMap).listCards;
  let threw = false;
  try {
    method.arguments.parse({ condition: "urgent" });
  } catch {
    threw = true;
  }
  assert(threw, "an unknown condition value must be rejected before execute()");
});

// ---------------------------------------------------------------------------
// Security-review pin: token is not marked sensitive today
// ---------------------------------------------------------------------------

Deno.test("pin: globalArguments.token is NOT marked `.meta({ sensitive: true })` today — documented security-hardening gap", () => {
  // kaiten.ts's GlobalArgsSchema never calls `.meta({ sensitive: true })` on
  // `token`. This is a real gap surfaced during the test-backfill security
  // review, but kaiten.ts is deliberately UNMODIFIED by this change (no
  // manifest version bump; test-authoring only) — fixing it belongs to a
  // follow-up issue. This test pins the CURRENT (regrettable) state so a
  // future fix flips it from failing to passing, rather than silently
  // slipping by unnoticed.
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.token) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    undefined,
    "token is not yet marked sensitive — if this starts failing, kaiten.ts " +
      "added the annotation; update this pin to assert true",
  );
});
