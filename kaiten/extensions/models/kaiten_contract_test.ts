/**
 * Contract-fixture suite (wire-format half): pins the CONCRETE Kaiten REST
 * wire shape from kaiten/fixtures/*.json — independent of kaiten.ts's
 * resource schemas, which use `.passthrough()` and would happily accept a
 * drifted shape. This suite hardcodes the expected keyset/value types so a
 * real wire-format drift turns a test red (STANDARD.md's contract-fixture
 * role).
 *
 * kaiten_test.ts (kept byte-unchanged) already pins the SDK surface —
 * method names, arg defaults, and the pure helpers (resolveBase/backoffMs/
 * slug). This file is deliberately scoped to the wire-format half that
 * kaiten_test.ts does not touch: one fixture per documented endpoint (see
 * fixtures/PROVENANCE.md), the bare-array list shape, the numeric
 * `condition` field, and offset/limit pagination params. It does NOT
 * duplicate the {data|items|results} wrapper-envelope tolerance or the `[]`
 * fallback — those asArray branches are covered exhaustively in
 * kaiten_coverage_test.ts, per the plan's minimal-corpus decision.
 *
 * kaiten.ts is UNMODIFIED — every test here is a characterization test that
 * PINS already-shipped behavior. All fixtures are pure doc/schema-derived
 * synthetic data (see fixtures/PROVENANCE.md); every test is offline — a
 * fixture is fed through a stubbed globalThis.fetch, no network call is made.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./kaiten.ts";
import spaces from "../../fixtures/spaces.json" with { type: "json" };
import boards from "../../fixtures/boards.json" with { type: "json" };
import columns from "../../fixtures/columns.json" with { type: "json" };
import cards from "../../fixtures/cards.json" with { type: "json" };
import card from "../../fixtures/card.json" with { type: "json" };
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  domain: "acme",
  token: "contract-fixture-sentinel-token",
};

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
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

/** Fixed-response fetch stub: every call returns the same fixture body,
 * regardless of URL/method — routing is pinned in kaiten_methods_test.ts. */
function withFixture(
  body: unknown,
  status: number,
  fn: (calls: string[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: Request | URL | string) => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
      ? input.toString()
      : input;
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const SPACE_KEYS = [
  "archived",
  "created",
  "id",
  "parent_entity_uuid",
  "sort_order",
  "title",
  "uid",
  "updated",
].sort();

const COLUMN_KEYS = [
  "board_id",
  "col_count",
  "id",
  "sort_order",
  "title",
  "type",
].sort();

const CARD_KEYS = [
  "archived",
  "asap",
  "board_id",
  "column_id",
  "condition",
  "created",
  "description",
  "due_date",
  "id",
  "lane_id",
  "owner_id",
  "size",
  "sort_order",
  "state",
  "title",
  "type_id",
  "updated",
].sort();

function keysOf(obj: Record<string, unknown>, drop: string[] = ["fetchedAt"]) {
  return Object.keys(obj).filter((k) => !drop.includes(k)).sort();
}

// ---------------------------------------------------------------------------
// spaces.json contract — GET /spaces, bare array
// ---------------------------------------------------------------------------

Deno.test("contract: spaces.json — bare array, documented Space keyset", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(spaces, 200, () => run("listSpaces", {}, ctx));
  const writtenSpaces = written.filter((w) => w.spec === "space");
  assertEquals(writtenSpaces.length, spaces.length);
  for (const w of writtenSpaces) {
    assertEquals(keysOf(w.payload), SPACE_KEYS);
  }
  const summary = written.find((w) => w.spec === "summary")!;
  assertEquals(summary.payload.total, spaces.length);
  assertEquals(summary.payload.endpoint, "/spaces");
});

Deno.test("contract: spaces.json — id stays a wire NUMBER, uid/title are strings or null", () => {
  for (const sp of spaces) {
    assertEquals(typeof sp.id, "number");
    assert(sp.uid === null || typeof sp.uid === "string");
    assert(sp.title === null || typeof sp.title === "string");
  }
});

// ---------------------------------------------------------------------------
// boards.json contract — a single Board object (GET /boards/{id} shape;
// the same shape recurs as each item of the GET /spaces/{id}/boards list)
// ---------------------------------------------------------------------------

Deno.test("contract: boards.json — getBoard writes the documented Board keyset with embedded columns/lanes", async () => {
  const { ctx, written } = makeCtx();
  const board = boards[0];
  await withFixture(board, 200, () => run("getBoard", { id: board.id }, ctx));
  const res = written.find((w) => w.spec === "board")!;
  assertEquals(res.payload.id, board.id);
  assertEquals(res.payload.title, board.title);
  assertEquals(res.payload.space_id, board.space_id);
  assert(Array.isArray(res.payload.columns));
  assert(Array.isArray(res.payload.lanes));
  assertEquals(
    (res.payload.columns as Array<unknown>).length,
    board.columns.length,
  );
});

// ---------------------------------------------------------------------------
// columns.json contract — GET /boards/{boardId}/columns, bare array
// ---------------------------------------------------------------------------

Deno.test("contract: columns.json — bare array, documented Column keyset", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    columns,
    200,
    () => run("listColumns", { boardId: 128 }, ctx),
  );
  const writtenColumns = written.filter((w) => w.spec === "column");
  assertEquals(writtenColumns.length, columns.length);
  for (const w of writtenColumns) {
    assertEquals(keysOf(w.payload), COLUMN_KEYS);
  }
});

// ---------------------------------------------------------------------------
// cards.json contract — GET /cards, bare array, numeric `condition`
// ---------------------------------------------------------------------------

Deno.test("contract: cards.json — bare array, documented Card keyset, condition is a wire NUMBER", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(cards, 200, () => run("listCards", {}, ctx));
  const writtenCards = written.filter((w) => w.spec === "card");
  assertEquals(writtenCards.length, cards.length);
  for (const w of writtenCards) {
    assertEquals(keysOf(w.payload), CARD_KEYS);
    assertEquals(typeof w.payload.condition, "number");
  }
  // Pin the documented mapping: listCards condition="live"/"done" maps onto
  // this numeric wire field as 1/2 respectively (see kaiten.ts's
  // ListCardsArgs.condition description). The fixture's own values already
  // demonstrate both: card 99001 is condition 1 (live), 99002 is 2 (done).
  const live = cards.find((c) => c.id === 99001)!;
  const done = cards.find((c) => c.id === 99002)!;
  assertEquals(live.condition, 1);
  assertEquals(done.condition, 2);
});

Deno.test("contract: cards.json — offset/limit pagination params sent on the request, condition mapped to a numeric string", async () => {
  const { ctx } = makeCtx();
  let requestUrl = "";
  await withFixture(cards, 200, async (calls) => {
    await run("listCards", { condition: "live", pageSize: 50 }, ctx);
    requestUrl = calls[0];
  });
  const url = new URL(requestUrl);
  assertEquals(url.searchParams.get("limit"), "50");
  assertEquals(url.searchParams.get("offset"), "0");
  assertEquals(url.searchParams.get("condition"), "1");
});

// ---------------------------------------------------------------------------
// card.json contract — GET /cards/{id}, single object
// ---------------------------------------------------------------------------

Deno.test("contract: card.json — getCard writes the documented single-Card keyset", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(card, 200, () => run("getCard", { id: card.id }, ctx));
  const res = written.find((w) => w.spec === "card")!;
  assertEquals(keysOf(res.payload), CARD_KEYS);
  assertEquals(res.payload.id, card.id);
  assertEquals(res.payload.title, card.title);
  assertEquals(res.payload.condition, card.condition);
});

// ---------------------------------------------------------------------------
// error.json contract — generic non-2xx error envelope
// ---------------------------------------------------------------------------

Deno.test("contract: error.json — a non-2xx response's JSON body is echoed (truncated) in the thrown error, never separately parsed", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withFixture(errorFixture, 404, async () => {
    try {
      await run("listSpaces", {}, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assert(threw instanceof Error);
  const message = (threw as Error).message;
  assert(message.includes("404"));
  // kget appends the raw response text (JSON.stringify'd body, up to 300
  // chars) verbatim — it never parses out a `message` field specifically.
  assert(message.includes(JSON.stringify(errorFixture).slice(0, 50)));
});
