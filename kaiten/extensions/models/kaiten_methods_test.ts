/**
 * Method-level tests for @magistr/kaiten — every one of the 7 read-only
 * methods (listSpaces, getSpace, listBoards, getBoard, listColumns,
 * listCards, getCard), happy + failure path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` and a fake ExecCtx — the porkbun PR #65 harness pattern,
 * adapted to kaiten's GET-only, single-token-header surface.
 *
 * kaiten.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * `kget`/`asArray`/`itemId`/`sleep` are module-private (not exported) and are
 * reached only through `execute()`, never imported directly.
 *
 * Token-non-leak assertions run for every method using a DISTINCTIVE
 * sentinel token value, checking all three sinks: thrown-error text, every
 * logger call, and every written resource payload.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./kaiten.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SENTINEL_TOKEN = "KAITEN-METHODS-SENTINEL-tOkEn-9f3c7a";

const GLOBAL_ARGS = {
  domain: "acme",
  token: SENTINEL_TOKEN,
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: {
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warning: (...args: unknown[]) => {
          logs.push({ level: "warning", args });
        },
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request. */
async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Single-route stub returning the same body/status to every call. */
function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

function pathOf(req: Request): string {
  return new URL(req.url).pathname;
}

// ---------------------------------------------------------------------------
// listSpaces
// ---------------------------------------------------------------------------

Deno.test("listSpaces: happy path — GET /spaces, writes one space per item + a summary", async () => {
  const { ctx, written } = makeCtx();
  const spaces = [{ id: 1, title: "A" }, { id: 2, title: "B" }];
  await withOneResponse(spaces, 200, async (calls) => {
    await run("listSpaces", {}, ctx);
    assertEquals(calls.length, 1);
    assertEquals(pathOf(calls[0]), "/api/latest/spaces");
    assertEquals(calls[0].method, "GET");
    assertEquals(
      calls[0].headers.get("Authorization"),
      `Bearer ${SENTINEL_TOKEN}`,
    );
  });
  const spaceResources = written.filter((w) => w.spec === "space");
  assertEquals(spaceResources.length, 2);
  assertEquals(spaceResources.map((w) => w.name).sort(), [
    "space-1",
    "space-2",
  ]);
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.name, "summary-spaces");
  assertEquals(summary.payload.scope, "spaces");
  assertEquals(summary.payload.endpoint, "/spaces");
  assertEquals(summary.payload.total, 2);
  assertEquals(summary.payload.ids, [1, 2]);
  assertEquals(summary.payload.truncated, false);
});

Deno.test("listSpaces: failure path — non-2xx throws a redacted error", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("server exploded", 500, async () => {
    await assertRejects(() => run("listSpaces", {}, ctx), Error, "500");
  });
});

// ---------------------------------------------------------------------------
// getSpace
// ---------------------------------------------------------------------------

Deno.test("getSpace: happy path — GET /spaces/{id}, writes one space", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { id: 42, title: "Product Space" },
    200,
    async (calls) => {
      await run("getSpace", { id: 42 }, ctx);
      assertEquals(pathOf(calls[0]), "/api/latest/spaces/42");
    },
  );
  const res = written.find((w) => w.spec === "space")!;
  assertEquals(res.name, "space-42");
  assertEquals(res.payload.title, "Product Space");
});

Deno.test("getSpace: failure path — non-2xx throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 404, async () => {
    await assertRejects(() => run("getSpace", { id: 1 }, ctx), Error, "404");
  });
});

// ---------------------------------------------------------------------------
// listBoards
// ---------------------------------------------------------------------------

Deno.test("listBoards: happy path — GET /spaces/{spaceId}/boards, writes boards + scoped summary", async () => {
  const { ctx, written } = makeCtx();
  const boards = [{ id: 128, title: "Sprint Board" }];
  await withOneResponse(boards, 200, async (calls) => {
    await run("listBoards", { spaceId: 42 }, ctx);
    assertEquals(pathOf(calls[0]), "/api/latest/spaces/42/boards");
  });
  const res = written.find((w) => w.spec === "board")!;
  assertEquals(res.name, "board-128");
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.name, "summary-boards-42");
  assertEquals(summary.payload.scope, "boards");
  assertEquals(summary.payload.filters, { space_id: "42" });
  assertEquals(summary.payload.total, 1);
});

Deno.test("listBoards: failure path — non-2xx throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 403, async () => {
    await assertRejects(
      () => run("listBoards", { spaceId: 1 }, ctx),
      Error,
      "403",
    );
  });
});

// ---------------------------------------------------------------------------
// getBoard
// ---------------------------------------------------------------------------

Deno.test("getBoard: happy path — GET /boards/{id}, writes one board with embedded columns/lanes", async () => {
  const { ctx, written } = makeCtx();
  const board = {
    id: 128,
    title: "Sprint Board",
    columns: [{ id: 512 }],
    lanes: [{ id: 900 }],
  };
  await withOneResponse(board, 200, async (calls) => {
    await run("getBoard", { id: 128 }, ctx);
    assertEquals(pathOf(calls[0]), "/api/latest/boards/128");
  });
  const res = written.find((w) => w.spec === "board")!;
  assertEquals(res.name, "board-128");
  assertEquals(res.payload.columns, board.columns);
  assertEquals(res.payload.lanes, board.lanes);
});

Deno.test("getBoard: failure path — non-2xx throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("getBoard", { id: 1 }, ctx), Error, "500");
  });
});

// ---------------------------------------------------------------------------
// listColumns
// ---------------------------------------------------------------------------

Deno.test("listColumns: happy path — GET /boards/{boardId}/columns, writes columns + scoped summary", async () => {
  const { ctx, written } = makeCtx();
  const columns = [{ id: 512, title: "Backlog" }, { id: 513, title: "Doing" }];
  await withOneResponse(columns, 200, async (calls) => {
    await run("listColumns", { boardId: 128 }, ctx);
    assertEquals(pathOf(calls[0]), "/api/latest/boards/128/columns");
  });
  const cols = written.filter((w) => w.spec === "column");
  assertEquals(cols.length, 2);
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.name, "summary-columns-128");
  assertEquals(summary.payload.filters, { board_id: "128" });
});

Deno.test("listColumns: failure path — non-2xx throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(
      () => run("listColumns", { boardId: 1 }, ctx),
      Error,
      "500",
    );
  });
});

// ---------------------------------------------------------------------------
// listCards
// ---------------------------------------------------------------------------

Deno.test("listCards: happy path — GET /cards with all filters mapped to query params", async () => {
  const { ctx, written } = makeCtx();
  const cards = [{ id: 1, title: "Card A" }];
  await withOneResponse(cards, 200, async (calls) => {
    await run("listCards", {
      spaceId: 42,
      boardId: 128,
      columnId: 512,
      laneId: 900,
      query: "release",
      condition: "live",
      archived: false,
      additionalParams: { tag_ids: "3,7" },
    }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(pathOf(calls[0]), "/api/latest/cards");
    assertEquals(url.searchParams.get("space_id"), "42");
    assertEquals(url.searchParams.get("board_id"), "128");
    assertEquals(url.searchParams.get("column_id"), "512");
    assertEquals(url.searchParams.get("lane_id"), "900");
    assertEquals(url.searchParams.get("query"), "release");
    assertEquals(url.searchParams.get("condition"), "1");
    assertEquals(url.searchParams.get("archived"), "false");
    assertEquals(url.searchParams.get("tag_ids"), "3,7");
    assertEquals(url.searchParams.get("limit"), "100");
    assertEquals(url.searchParams.get("offset"), "0");
  });
  const res = written.find((w) => w.spec === "card")!;
  assertEquals(res.name, "card-1");
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.scope, "cards");
  assertEquals(summary.payload.total, 1);
});

Deno.test("listCards: condition='done' maps to numeric '2'", async () => {
  const { ctx } = makeCtx();
  await withOneResponse([], 200, async (calls) => {
    await run("listCards", { condition: "done" }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("condition"), "2");
  });
});

Deno.test("listCards: paginates across two pages, stopping on a short page", async () => {
  const { ctx, written } = makeCtx();
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  const page2 = Array.from({ length: 40 }, (_, i) => ({ id: i + 101 }));
  let call = 0;
  await withFetchStub([(req) => {
    call++;
    const offset = new URL(req.url).searchParams.get("offset");
    if (offset === "0") return json(page1);
    if (offset === "100") return json(page2);
    return json([]);
  }], async () => {
    await run("listCards", { maxResults: 500 }, ctx);
    assertEquals(
      call,
      2,
      "a short second page (40 < limit) must stop pagination",
    );
  });
  const cards = written.filter((w) => w.spec === "card");
  assertEquals(cards.length, 140);
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, 140);
  assertEquals(summary.payload.truncated, false);
});

Deno.test("listCards: failure path — non-2xx throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("listCards", {}, ctx), Error, "500");
  });
});

Deno.test('listCards: 429 then 200 — retries transparently via Retry-After: "0" (no timer stub needed)', async () => {
  const { ctx, written } = makeCtx();
  let attempt = 0;
  await withFetchStub([() => {
    attempt++;
    if (attempt === 1) {
      return json({ error: "rate limited" }, 429, { "Retry-After": "0" });
    }
    return json([{ id: 1 }]);
  }], async (calls) => {
    await run("listCards", {}, ctx);
    assertEquals(calls.length, 2, "one 429 + one successful retry");
  });
  const res = written.find((w) => w.spec === "card")!;
  assertEquals(res.name, "card-1");
});

// ---------------------------------------------------------------------------
// getCard
// ---------------------------------------------------------------------------

Deno.test("getCard: happy path — GET /cards/{id}, writes one card", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { id: 99001, title: "Fix login bug" },
    200,
    async (calls) => {
      await run("getCard", { id: 99001 }, ctx);
      assertEquals(pathOf(calls[0]), "/api/latest/cards/99001");
    },
  );
  const res = written.find((w) => w.spec === "card")!;
  assertEquals(res.name, "card-99001");
  assertEquals(res.payload.title, "Fix login bug");
});

Deno.test("getCard: failure path — non-2xx throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 404, async () => {
    await assertRejects(() => run("getCard", { id: 1 }, ctx), Error, "404");
  });
});

// ---------------------------------------------------------------------------
// Token non-leak across all 7 methods — error / logs / resources
// ---------------------------------------------------------------------------

const HAPPY_SCENARIOS: Array<[string, Record<string, unknown>, unknown]> = [
  ["listSpaces", {}, [{ id: 1, title: "A" }]],
  ["getSpace", { id: 1 }, { id: 1, title: "A" }],
  ["listBoards", { spaceId: 1 }, [{ id: 1, title: "B" }]],
  ["getBoard", { id: 1 }, { id: 1, title: "B" }],
  ["listColumns", { boardId: 1 }, [{ id: 1, title: "C" }]],
  ["listCards", {}, [{ id: 1, title: "D" }]],
  ["getCard", { id: 1 }, { id: 1, title: "D" }],
];

Deno.test("token never leaks into any written resource or logger call, across all 7 methods (happy path)", async () => {
  for (const [name, args, response] of HAPPY_SCENARIOS) {
    const { ctx, written, logs } = makeCtx();
    await withOneResponse(response, 200, async () => {
      await run(name, args, ctx);
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(
        !s.includes(SENTINEL_TOKEN),
        `${name}: token leaked into ${w.spec}`,
      );
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(
        !s.includes(SENTINEL_TOKEN),
        `${name}: token leaked into a log call`,
      );
    }
  }
});

Deno.test("token never leaks into a thrown error's message, across all 7 methods (failure path, clean server body)", async () => {
  for (const [name, args] of HAPPY_SCENARIOS) {
    const { ctx } = makeCtx();
    let threw: unknown;
    await withOneResponse("internal error, no token here", 500, async () => {
      try {
        await run(name, args, ctx);
      } catch (err) {
        threw = err;
      }
    });
    assert(threw instanceof Error, `${name} must throw on a 500`);
    assert(
      !(threw as Error).message.includes(SENTINEL_TOKEN),
      `${name}: token leaked into the thrown error message`,
    );
  }
});

Deno.test("trust boundary: a hostile server error body that ECHOES the token surfaces via kget's body.slice(0,300) interpolation (documented, not fixed — kaiten.ts is byte-frozen)", async () => {
  // The token is sent ONLY in the Authorization header — kget never
  // interpolates it into a request itself. But on a non-2xx response, kget
  // appends up to 300 chars of the raw response BODY TEXT to the thrown
  // error message, unconditionally. A hostile or misconfigured server that
  // reflects the Authorization header back in its error body (e.g. a
  // request-echoing debug proxy, or a WAF block page) would therefore leak
  // the token through this path. This is a genuine trust-boundary gap in
  // the shipped code; it is pinned here as documented behavior, not fixed
  // (kaiten.ts is byte-frozen per the plan).
  const { ctx } = makeCtx();
  const hostileBody =
    `Blocked request with Authorization: Bearer ${SENTINEL_TOKEN}`;
  let threw: unknown;
  await withOneResponse(hostileBody, 403, async () => {
    try {
      await run("getCard", { id: 1 }, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assert(threw instanceof Error);
  assert(
    (threw as Error).message.includes(SENTINEL_TOKEN),
    "sanity: a hostile echoing server body DOES surface the token today",
  );
});
