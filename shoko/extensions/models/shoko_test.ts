/**
 * Contract-fixture suite: pins the CONCRETE Shoko REST v3 wire shape from
 * shoko/fixtures/*.json directly — independent of shoko.ts's resource
 * schemas, which use loose `.passthrough()` zod objects for almost every
 * field. A suite that only asserted "the written resource validates against
 * the model's schema" would be toothless (passthrough accepts anything);
 * this suite hardcodes the expected keyset + value types from the Shoko docs
 * so a real wire-format drift turns a test red (see STANDARD.md's
 * contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./shoko.ts";
import auth from "../../fixtures/auth.json" with { type: "json" };
import status from "../../fixtures/status.json" with { type: "json" };
import dashboard from "../../fixtures/dashboard.json" with { type: "json" };
import series from "../../fixtures/series.json" with { type: "json" };
import files from "../../fixtures/files.json" with { type: "json" };
import missingEpisodes from "../../fixtures/missing-episodes.json" with {
  type: "json",
};
import duplicateFiles from "../../fixtures/duplicate-files.json" with {
  type: "json",
};
import importFolders from "../../fixtures/import-folders.json" with {
  type: "json",
};
import queue from "../../fixtures/queue.json" with { type: "json" };
import queueSingle from "../../fixtures/queue-single.json" with {
  type: "json",
};
import swagger from "../../fixtures/swagger.json" with { type: "json" };
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  host: "http://203.0.113.10:8111",
  apiKey: "fixture-shoko-key-0001",
  userAgent: "swamp-shoko-test/1.0",
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
  return method.execute(method.arguments.parse(args), ctx);
}

/** Feed a single fixture body through a stubbed fetch for the duration of fn. */
function withFixture(
  body: unknown,
  fn: () => Promise<unknown>,
  status = 200,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        body === null ? "" : JSON.stringify(body),
        {
          status,
          headers: { "Content-Type": "application/json" },
        },
      ),
    )) as unknown as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// auth.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: auth.json — authenticate writes {apikey, device, timestamp}", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    auth,
    () => run("authenticate", { user: "u", pass: "p", device: "swamp" }, ctx),
  );
  const res = written.find((w) => w.spec === "auth")!;
  assertEquals(res.payload.apikey, auth.apikey);
  assertEquals(res.payload.device, "swamp");
  assertEquals(typeof res.payload.timestamp, "string");
});

// ---------------------------------------------------------------------------
// status.json contract — server init status, echoed whole
// ---------------------------------------------------------------------------

Deno.test("contract: status.json — status writes the fixture object verbatim, State stays a NUMBER", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(status, () => run("status", {}, ctx));
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload, status);
  assertEquals(typeof res.payload.State, "number");
  assertEquals(res.payload.StartupMessage, null);
});

// ---------------------------------------------------------------------------
// dashboard.json contract — passthrough stats object, echoed whole
// ---------------------------------------------------------------------------

Deno.test("contract: dashboard.json — dashboard writes the fixture object verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(dashboard, () => run("dashboard", {}, ctx));
  const res = written.find((w) => w.spec === "dashboard")!;
  assertEquals(res.payload, dashboard);
});

// ---------------------------------------------------------------------------
// series.json contract — the wrapped {Total, List} shape (list-series)
// ---------------------------------------------------------------------------

const EXPECTED_SERIES_ITEM_KEYS = ["IDs", "Name", "Sizes"].sort();

Deno.test("contract: series.json — list-series writes {items, total, timestamp}; every item keeps the documented keyset", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(series, () => run("list-series", {}, ctx));
  const res = written.find((w) => w.spec === "series")!;
  const items = res.payload.items as Array<Record<string, unknown>>;
  assertEquals(items.length, series.List.length);
  assertEquals(res.payload.total, series.Total);
  for (const item of items) {
    assertEquals(Object.keys(item).sort(), EXPECTED_SERIES_ITEM_KEYS);
    assertEquals(typeof item.Name, "string");
  }
});

Deno.test("contract: series.json's List, fed BARE (unwrapped) — search-series writes {items, total, timestamp}; total is items.length, NOT any Total field", async () => {
  // search-series's endpoint returns a raw array, never the {Total, List}
  // envelope list-series uses. This test reuses the same item corpus under
  // that different wire envelope, per the fixture's provenance mapping.
  const { ctx, written } = makeCtx();
  await withFixture(
    series.List,
    () => run("search-series", { query: "Example" }, ctx),
  );
  const res = written.find((w) => w.spec === "series")!;
  assertEquals(res.payload.items, series.List);
  assertEquals(res.payload.total, series.List.length);
});

// ---------------------------------------------------------------------------
// files.json contract
// ---------------------------------------------------------------------------

const EXPECTED_FILE_ITEM_KEYS = ["ID", "Size", "CRC32", "Locations"].sort();

Deno.test("contract: files.json — find-unrecognized-files writes {items, total, category, timestamp}", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(files, () => run("find-unrecognized-files", {}, ctx));
  const res = written.find((w) => w.spec === "files")!;
  const items = res.payload.items as Array<Record<string, unknown>>;
  assertEquals(items.length, files.List.length);
  assertEquals(res.payload.total, files.Total);
  assertEquals(res.payload.category, "unrecognized");
  for (const item of items) {
    assertEquals(Object.keys(item).sort(), EXPECTED_FILE_ITEM_KEYS);
    assertEquals(typeof item.ID, "number");
    assertEquals(typeof item.Size, "number");
    assertEquals(typeof item.CRC32, "string");
    assert(Array.isArray(item.Locations));
  }
});

// ---------------------------------------------------------------------------
// missing-episodes.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: missing-episodes.json — find-missing-episodes (default scope=series) writes {items, total, category:'missing-series', timestamp}", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    missingEpisodes,
    () => run("find-missing-episodes", {}, ctx),
  );
  const res = written.find((w) => w.spec === "episodes")!;
  const items = res.payload.items as Array<Record<string, unknown>>;
  assertEquals(items.length, missingEpisodes.List.length);
  assertEquals(res.payload.total, missingEpisodes.Total);
  assertEquals(res.payload.category, "missing-series");
  for (const item of items) {
    assertEquals(Object.keys(item).sort(), ["IDs", "Name"].sort());
    assertEquals(typeof item.Name, "string");
  }
});

// ---------------------------------------------------------------------------
// duplicate-files.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: duplicate-files.json — find-duplicate-files (default scope=series) writes {items, total, category:'duplicates-series', timestamp}", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    duplicateFiles,
    () => run("find-duplicate-files", {}, ctx),
  );
  const res = written.find((w) => w.spec === "files")!;
  const items = res.payload.items as Array<Record<string, unknown>>;
  assertEquals(items.length, duplicateFiles.List.length);
  assertEquals(res.payload.total, duplicateFiles.Total);
  assertEquals(res.payload.category, "duplicates-series");
  assertEquals((items[0].Locations as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// import-folders.json contract — bare array (list-import-folders)
// ---------------------------------------------------------------------------

Deno.test("contract: import-folders.json — list-import-folders writes {folders, total, timestamp}, folders pass through verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    importFolders,
    () => run("list-import-folders", {}, ctx),
  );
  const res = written.find((w) => w.spec === "importFolders")!;
  assertEquals(res.payload.folders, importFolders);
  assertEquals(res.payload.total, importFolders.length);
  for (const folder of res.payload.folders as Array<Record<string, unknown>>) {
    assertEquals(typeof folder.ID, "number");
    assertEquals(typeof folder.Path, "string");
    assertEquals(typeof folder.Name, "string");
  }
});

// ---------------------------------------------------------------------------
// queue.json contract — multi-item array response
// ---------------------------------------------------------------------------

Deno.test("contract: queue.json — queue-status (array response) writes {items, timestamp} passed through verbatim", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(queue, () => run("queue-status", {}, ctx));
  const res = written.find((w) => w.spec === "queue")!;
  assertEquals(res.payload.items, queue);
});

// ---------------------------------------------------------------------------
// queue-single.json contract — bare-object response, wrapped as [data]
// ---------------------------------------------------------------------------

Deno.test("contract: queue-single.json — queue-status (bare-object response) wraps it as a single-element array", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(queueSingle, () => run("queue-status", {}, ctx));
  const res = written.find((w) => w.spec === "queue")!;
  const items = res.payload.items as unknown[];
  assertEquals(items.length, 1);
  assertEquals(items[0], queueSingle);
});

// ---------------------------------------------------------------------------
// swagger.json contract — list-actions discovery, prefix-filter pin
// ---------------------------------------------------------------------------

Deno.test("contract: swagger.json — list-actions matches ONLY the bare /Action/ prefixed path (fixture-observable, not a live-spec claim)", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(swagger, () => run("list-actions", {}, ctx));
  const res = written.find((w) => w.spec === "actions")!;
  const actions = res.payload.actions as Array<
    { Name: string; Description?: string }
  >;
  assertEquals(res.payload.total, 1);
  assertEquals(actions.length, 1);
  assertEquals(actions[0].Name, "Foo");
});

// ---------------------------------------------------------------------------
// error.json contract — the non-ok HTTP envelope (resp.ok honored)
// ---------------------------------------------------------------------------

Deno.test("contract: error.json — a non-ok response throws, embedding the response body text verbatim (sliced to 300 chars)", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withFixture(errorFixture, async () => {
    try {
      await run("dashboard", {}, ctx);
    } catch (err) {
      threw = err;
    }
  }, 500);
  assert(threw instanceof Error);
  const message = (threw as Error).message;
  assert(message.startsWith("Shoko GET /api/v3/Dashboard/Stats → 500: "));
  assert(message.includes(errorFixture.Message));
});
