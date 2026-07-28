/**
 * Method-level tests for @magistr/seanime — every one of the 8 methods
 * (status, library-collection, missing-episodes, library-scan, torrent-list,
 * auto-download, sync-planning-rules, set-planning-watching), happy path +
 * error path, driven through `model.methods.<m>.arguments.parse()` +
 * `.execute()` against a stubbed `globalThis.fetch` and a fake context.
 *
 * seanime.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Credential-leak assertions run for every method: a distinct sentinel token
 * must never appear in a written resource payload or a logger call. A
 * separate pin proves the model performs NO redaction of the response body
 * it embeds into a thrown error — a server response that itself echoes the
 * token surfaces it verbatim (documented trust boundary, not fixed here).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./seanime.ts";
import anilistCollection from "../../fixtures/anilist-collection.json" with {
  type: "json",
};
import autoDownloaderRules from "../../fixtures/auto-downloader-rules.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SENTINEL_TOKEN = "sntl_leak_check_do_not_log_1234567890";

const GLOBAL_ARGS = {
  baseUrl: "http://seanime.example.com:3211",
  token: SENTINEL_TOKEN,
};

const GLOBAL_ARGS_NO_TOKEN = {
  baseUrl: "http://seanime.example.com:3211",
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

Deno.test("status: happy path — GET /status with the token header, writes status/current", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { data: { os: "linux", version: "2.5.0" } },
    200,
    async (calls) => {
      await run("status", {}, ctx);
      assertEquals(new URL(calls[0].url).pathname, "/api/v1/status");
      assertEquals(calls[0].method, "GET");
      assertEquals(calls[0].headers.get("X-Seanime-Token"), SENTINEL_TOKEN);
    },
  );
  const res = written.find((w) => w.spec === "status");
  assert(res);
  assertEquals(res.payload.os, "linux");
  assertEquals(res.payload.version, "2.5.0");
});

Deno.test("status: error path — non-ok response rejects with the mapped message", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(
      () => run("status", {}, ctx),
      Error,
      "Seanime API GET /status returned 500",
    );
  });
});

Deno.test("X-Seanime-Token header is OMITTED entirely when no token is configured", async () => {
  const { ctx } = makeCtx(GLOBAL_ARGS_NO_TOKEN);
  await withOneResponse({ data: {} }, 200, async (calls) => {
    await run("status", {}, ctx);
    assertEquals(calls[0].headers.has("X-Seanime-Token"), false);
  });
});

// ---------------------------------------------------------------------------
// library-collection
// ---------------------------------------------------------------------------

Deno.test("library-collection: happy path — GET /library/collection, writes collection/current", async () => {
  const { ctx, written } = makeCtx();
  const lists = [{ type: "anime", status: "CURRENT", entries: [] }];
  await withOneResponse({ data: { lists } }, 200, async (calls) => {
    await run("library-collection", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v1/library/collection",
    );
  });
  const res = written.find((w) => w.spec === "collection");
  assert(res);
  assertEquals(res.payload.lists, lists);
});

Deno.test("library-collection: error path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 503, async () => {
    await assertRejects(
      () => run("library-collection", {}, ctx),
      Error,
      "Seanime API GET /library/collection returned 503",
    );
  });
});

// ---------------------------------------------------------------------------
// missing-episodes
// ---------------------------------------------------------------------------

Deno.test("missing-episodes: happy path — GET /library/missing-episodes, writes missingEpisodes/current", async () => {
  const { ctx, written } = makeCtx();
  const episodes = [{ episodeNumber: 3, aniDBEpisode: "S1E3" }];
  await withOneResponse({ data: { episodes } }, 200, async (calls) => {
    await run("missing-episodes", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v1/library/missing-episodes",
    );
  });
  const res = written.find((w) => w.spec === "missingEpisodes");
  assert(res);
  assertEquals(res.payload.episodes, episodes);
});

Deno.test("missing-episodes: error path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("missing-episodes", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// library-scan
// ---------------------------------------------------------------------------

Deno.test("library-scan: happy path — defaults enhanced=false, POSTs {enhanced:false}, writes scanResult/result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ data: {} }, 200, async (calls) => {
    await run("library-scan", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/v1/library/scan");
    assertEquals(calls[0].method, "POST");
    const body = await requestBody(calls[0]);
    assertEquals(body.enhanced, false);
  });
  const res = written.find((w) => w.spec === "scanResult");
  assert(res);
  assertEquals(res.payload.success, true);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("library-scan: enhanced=true is threaded into the POST body", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ data: {} }, 200, async (calls) => {
    await run("library-scan", { enhanced: true }, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body.enhanced, true);
  });
});

Deno.test("library-scan: error path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("library-scan", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// torrent-list
// ---------------------------------------------------------------------------

Deno.test("torrent-list: happy path — GET /torrent-client/list, writes torrents/current", async () => {
  const { ctx, written } = makeCtx();
  const torrents = [{ name: "fixture.torrent", hash: "aaaa" }];
  await withOneResponse({ data: torrents }, 200, async (calls) => {
    await run("torrent-list", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v1/torrent-client/list",
    );
  });
  const res = written.find((w) => w.spec === "torrents");
  assert(res);
  assertEquals(res.payload.torrents, torrents);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("torrent-list: error path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("torrent-list", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// auto-download
// ---------------------------------------------------------------------------

Deno.test("auto-download: happy path — POST /auto-downloader/run with no body, writes autoDownloaderResult/result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ data: {} }, 200, async (calls) => {
    await run("auto-download", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/v1/auto-downloader/run",
    );
    assertEquals(calls[0].method, "POST");
    assertEquals(await calls[0].text(), "");
  });
  const res = written.find((w) => w.spec === "autoDownloaderResult");
  assert(res);
  assertEquals(res.payload.success, true);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("auto-download: error path — non-ok response rejects", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(() => run("auto-download", {}, ctx), Error);
  });
});

// ---------------------------------------------------------------------------
// sync-planning-rules
// ---------------------------------------------------------------------------

function withAniListRoutes(
  ruleRoute: Route,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(anilistCollection);
      }
      if (url.pathname === "/api/v1/auto-downloader/rules") {
        return json(autoDownloaderRules);
      }
      if (url.pathname === "/api/v1/auto-downloader/rule") {
        return ruleRoute(req);
      }
      return undefined;
    }],
    fn,
  );
}

Deno.test("sync-planning-rules: happy path — creates a rule for the eligible, not-yet-ruled entry", async () => {
  const { ctx, written } = makeCtx();
  await withAniListRoutes(
    () => json({ data: { success: true } }),
    async () => {
      await run("sync-planning-rules", { libraryPath: "/anime/tv" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "ruleSyncResult");
  assert(res);
  const created = res.payload.created as Array<{ mediaId: number }>;
  assertEquals(created.length, 1);
  assertEquals(created[0].mediaId, 200002);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("sync-planning-rules: error path — a failing pre-loop /anilist/collection read rejects", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(
      () => run("sync-planning-rules", {}, ctx),
      Error,
      "Seanime API GET /anilist/collection returned 500",
    );
  });
});

// ---------------------------------------------------------------------------
// set-planning-watching
// ---------------------------------------------------------------------------

Deno.test("set-planning-watching: happy path — flips eligible PLANNING entries to CURRENT", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/anilist/collection") {
        return json(anilistCollection);
      }
      if (url.pathname === "/api/v1/anilist/list-entry") {
        return json({ data: { success: true } });
      }
      return undefined;
    }],
    async () => {
      await run("set-planning-watching", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "statusChangeResult");
  assert(res);
  const updated = res.payload.updated as Array<{ mediaId: number }>;
  assertEquals(updated.map((u) => u.mediaId), [200001, 200002]);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("set-planning-watching: error path — a failing pre-loop /anilist/collection read rejects", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 500, async () => {
    await assertRejects(
      () => run("set-planning-watching", {}, ctx),
      Error,
      "Seanime API GET /anilist/collection returned 500",
    );
  });
});

// ---------------------------------------------------------------------------
// Credential-leak assertions across every method
// ---------------------------------------------------------------------------

Deno.test("the token never leaks into any written resource across all 8 methods", async () => {
  const scenarios: Array<[string, Record<string, unknown>]> = [
    ["status", {}],
    ["library-collection", {}],
    ["missing-episodes", {}],
    ["library-scan", {}],
    ["torrent-list", {}],
    ["auto-download", {}],
  ];
  for (const [name, args] of scenarios) {
    const { ctx, written, logs } = makeCtx();
    await withOneResponse({ data: {} }, 200, async () => {
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

  // The two bulk methods, driven through the AniList fixtures.
  for (const name of ["sync-planning-rules", "set-planning-watching"]) {
    const { ctx, written, logs } = makeCtx();
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/anilist/collection") {
          return json(anilistCollection);
        }
        if (url.pathname === "/api/v1/auto-downloader/rules") {
          return json(autoDownloaderRules);
        }
        return json({ data: { success: true } });
      }],
      async () => {
        await run(name, {}, ctx);
      },
    );
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

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneResponse({ data: {} }, 200, async () => {
    await run("status", {}, ctx);
  });
  assertEquals(logs.length, 0);
});

Deno.test("pin: a server response echoing the token surfaces it VERBATIM in the thrown error — the model performs no redaction", async () => {
  // seanimeRequest embeds resp.text() verbatim into the thrown Error message.
  // A hostile or misconfigured server that echoes the caller's own token in
  // an error body would leak it right back into whatever surfaces that
  // error (logs, an issue tracker, a CI failure). This test pins the
  // mechanism with a distinct sentinel so it cannot pass by accident.
  const { ctx } = makeCtx();
  const leakyBody = `Invalid session for token=${SENTINEL_TOKEN}`;
  await withFetchStub(
    [() => new Response(leakyBody, { status: 401 })],
    async () => {
      const err = await assertRejects(() => run("status", {}, ctx));
      assert(
        String(err).includes(SENTINEL_TOKEN),
        "sanity: the fixture actually echoes the token",
      );
    },
  );
});
