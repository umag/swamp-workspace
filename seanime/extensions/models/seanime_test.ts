/**
 * Contract-fixture suite: pins the CONCRETE Seanime `/api/v1` wire shape from
 * seanime/fixtures/*.json directly — independent of seanime.ts's resource
 * schemas, which use `.passthrough()` almost everywhere. A suite that only
 * asserted "the written resource validates against the model's schema" would
 * be toothless (passthrough accepts extra keys); this suite hardcodes the
 * expected fields from the doc-derived fixtures so a real wire-format drift
 * turns a test red (see STANDARD.md's contract-fixture role).
 *
 * Pins the json.data envelope unwrap (`json.data !== undefined ? json.data :
 * json`) AND the resp.ok error mapping
 * (`Seanime API <method> <path> returned <status>: <body>`) — the key
 * contract diff vs porkbun (porkbun ignores HTTP status entirely; seanime
 * checks resp.ok and unwraps .data).
 *
 * All fixtures are PURE doc-derived synthetic data — see
 * fixtures/PROVENANCE.md. Every test here is offline: fixtures are fed
 * through a stubbed fetch, no network call is made.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./seanime.ts";
import status from "../../fixtures/status.json" with { type: "json" };
import libraryCollection from "../../fixtures/library-collection.json" with {
  type: "json",
};
import missingEpisodes from "../../fixtures/missing-episodes.json" with {
  type: "json",
};
import torrentList from "../../fixtures/torrent-list.json" with {
  type: "json",
};
import anilistCollection from "../../fixtures/anilist-collection.json" with {
  type: "json",
};
import autoDownloaderRules from "../../fixtures/auto-downloader-rules.json" with {
  type: "json",
};
import listEntry from "../../fixtures/list-entry.json" with { type: "json" };
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  baseUrl: "http://seanime.example.com:3211",
  token: "fixture-token",
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

type Route = (req: Request) => Response | Promise<Response> | undefined;

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withFixture(body: unknown, fn: () => Promise<unknown>) {
  return withFetchStub([() => json(body)], () => fn().then(() => {}));
}

// ---------------------------------------------------------------------------
// status.json contract — json.data unwrap
// ---------------------------------------------------------------------------

Deno.test("contract: status.json — json.data envelope is unwrapped, fields pinned to the fixture", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(status, () => run("status", {}, ctx));
  const res = written.find((w) => w.spec === "status")!;
  const expected = (status as { data: Record<string, unknown> }).data;
  assertEquals(res.payload.os, expected.os);
  assertEquals(res.payload.version, expected.version);
  assertEquals(res.payload.isOffline, expected.isOffline);
  assertEquals(res.payload.user, expected.user);
  assertEquals(res.payload.settings, expected.settings);
  assertEquals(res.payload.themeSettings, expected.themeSettings);
  // Pin: the wrapper key itself never leaks into the written resource.
  assert(
    !("data" in res.payload),
    "the outer {data: ...} envelope must be unwrapped, not stored verbatim",
  );
});

Deno.test("contract: status.json — settings carries no token/password field (fixture-authoring pin, mirrors PROVENANCE.md)", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(status, () => run("status", {}, ctx));
  const res = written.find((w) => w.spec === "status")!;
  const settingsStr = JSON.stringify(res.payload.settings).toLowerCase();
  assert(
    !settingsStr.includes("token"),
    "settings must not carry a token field",
  );
  assert(
    !settingsStr.includes("password"),
    "settings must not carry a password field",
  );
});

// ---------------------------------------------------------------------------
// library-collection.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: library-collection.json — lists[].entries[] preserve mediaId as a number + the full title object", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    libraryCollection,
    () => run("library-collection", {}, ctx),
  );
  const res = written.find((w) => w.spec === "collection")!;
  const expected = (libraryCollection as { data: { lists: unknown[] } }).data;
  assertEquals(res.payload.lists, expected.lists);
  const entries =
    (res.payload.lists as Array<{ entries: Array<{ mediaId: unknown }> }>)[0]
      .entries;
  assertEquals(typeof entries[0].mediaId, "number");
});

// ---------------------------------------------------------------------------
// missing-episodes.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: missing-episodes.json — episodes[] shape preserved exactly", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    missingEpisodes,
    () => run("missing-episodes", {}, ctx),
  );
  const res = written.find((w) => w.spec === "missingEpisodes")!;
  const expected = (missingEpisodes as { data: { episodes: unknown[] } }).data;
  assertEquals(res.payload.episodes, expected.episodes);
});

// ---------------------------------------------------------------------------
// torrent-list.json contract — array-form normalization
// ---------------------------------------------------------------------------

Deno.test("contract: torrent-list.json — bare-array data normalizes to {torrents, timestamp}, fields preserved", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(torrentList, () => run("torrent-list", {}, ctx));
  const res = written.find((w) => w.spec === "torrents")!;
  const expected = (torrentList as { data: unknown[] }).data;
  assertEquals(res.payload.torrents, expected);
  assertEquals(typeof res.payload.timestamp, "string");
});

// ---------------------------------------------------------------------------
// error.json contract — resp.ok-false error mapping (NOT resp.json())
// ---------------------------------------------------------------------------

Deno.test("contract: error.json — a non-ok response throws 'Seanime API <method> <path> returned <status>: <body>' verbatim", async () => {
  const { ctx } = makeCtx();
  const text = JSON.stringify(errorFixture);
  await withFetchStub(
    [() =>
      new Response(text, {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })],
    async () => {
      let threw: unknown;
      try {
        await run("status", {}, ctx);
      } catch (err) {
        threw = err;
      }
      assert(threw instanceof Error);
      assertEquals(
        (threw as Error).message,
        `Seanime API GET /status returned 401: ${text}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// anilist-collection.json + auto-downloader-rules.json — sync-planning-rules
// ---------------------------------------------------------------------------

Deno.test("contract: sync-planning-rules partitions the concrete AniList wire shape (created/skipped, destination path)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(anilistCollection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json(autoDownloaderRules);
      }
      if (url.pathname === "/api/v1/auto-downloader/rule") {
        return json({ data: { success: true } });
      }
      return undefined;
    }],
    async () => {
      await run("sync-planning-rules", { libraryPath: "/anime/tv" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "ruleSyncResult")!;
  const created = res.payload.created as Array<
    { mediaId: number; title: string; destination: string }
  >;
  const skipped = res.payload.skipped as Array<
    { mediaId: number; reason: string }
  >;
  assertEquals(created, [
    {
      mediaId: 200002,
      title: "Fixture Horizon",
      destination: "/anime/tv/Fixture Horizon",
    },
  ]);
  assertEquals(
    skipped.find((s) => s.mediaId === 200001)?.reason,
    "rule already exists",
  );
  assertEquals(
    skipped.find((s) => s.mediaId === 200003)?.reason,
    "status is FINISHED",
  );
});

// ---------------------------------------------------------------------------
// anilist-collection.json + list-entry.json — set-planning-watching
// ---------------------------------------------------------------------------

Deno.test("contract: set-planning-watching partitions the concrete AniList wire shape (updated with from/toStatus)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(anilistCollection);
      }
      if (url.pathname === "/api/v1/anilist/list-entry") {
        return json(listEntry);
      }
      return undefined;
    }],
    async () => {
      await run("set-planning-watching", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "statusChangeResult")!;
  const updated = res.payload.updated as Array<
    { mediaId: number; title: string; fromStatus: string; toStatus: string }
  >;
  assertEquals(updated, [
    {
      mediaId: 200001,
      title: "Fixture Wanderers",
      fromStatus: "PLANNING",
      toStatus: "CURRENT",
    },
    {
      mediaId: 200002,
      title: "Fixture Horizon",
      fromStatus: "PLANNING",
      toStatus: "CURRENT",
    },
  ]);
});
