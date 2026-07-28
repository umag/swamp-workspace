/**
 * Adversarial suite: hostile/malformed responses, the destructive maintenance
 * surface (run-action, remove-missing-files, rescan-folder), the
 * authenticate missing-apikey credential-leak branch, and a mechanical
 * fixtures-secret-scan over shoko/fixtures/*.json.
 *
 * shoko.ts is UNMODIFIED — every test here PINS current behavior (including
 * behavior that is arguably risky) rather than proposing a fix. Where a test
 * documents a real gap, it is labeled "pin" and says so explicitly.
 *
 * The list-actions /Action/ prefix-mismatch is pinned as FIXTURE-OBSERVABLE
 * behavior only (round-1 plan review MEDIUM finding) — this suite makes no
 * claim about what Shoko's real, live OpenAPI document actually looks like;
 * live capture is forbidden by fixtures/PROVENANCE.md, so the real path
 * style is unobserved.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
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

const HOST = "http://203.0.113.10:8111";
const API_KEY = "fixture-shoko-key-0001";

const GLOBAL_ARGS = {
  host: HOST,
  apiKey: API_KEY,
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

function textResponse(body: string, status = 200, contentType = "text/plain") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A response with an empty body — http()'s `if (!text) return null` branch. */
function emptyBody(status = 200) {
  return new Response("", { status });
}

// ---------------------------------------------------------------------------
// list-actions: the /Action/ prefix mismatch — FIXTURE-OBSERVABLE ONLY
// ---------------------------------------------------------------------------

Deno.test("pin: list-actions matches a bare /Action/-prefixed swagger path but SKIPS a /api/v3/Action/-prefixed one — a claim about this code's filter, not about Shoko's live spec", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json(swagger)], async () => {
    await run("list-actions", {}, ctx);
  });
  const res = written.find((w) => w.spec === "actions")!;
  const actions = res.payload.actions as Array<{ Name: string }>;
  assertEquals(
    actions.length,
    1,
    "only the bare /Action/Foo path matches — /api/v3/Action/RunImport does not",
  );
  assertEquals(actions[0].Name, "Foo");
  assert(
    !actions.some((a) => a.Name === "RunImport"),
    "RunImport must NOT appear: its swagger path carries the /api/v3 prefix, which startsWith('/Action/') does not match",
  );
});

Deno.test("pin: a /Action/ path with no GET method is skipped regardless of path shape", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json(swagger)], async () => {
    await run("list-actions", {}, ctx);
  });
  const res = written.find((w) => w.spec === "actions")!;
  const actions = res.payload.actions as Array<{ Name: string }>;
  assert(!actions.some((a) => a.Name === "NoGet"));
});

Deno.test("pin: an empty-body (null) swagger response makes list-actions throw a TypeError BEFORE 'spec.paths ?? {}' can apply", async () => {
  // http() returns null for an empty body; `spec.paths` then dereferences
  // a null spec, which throws synchronously — the `?? {}` only guards
  // spec.paths being undefined on a DEFINED spec object, never a null spec
  // itself. Documented gap, not fixed here (shoko.ts unmodified).
  const { ctx } = makeCtx();
  await withFetchStub([() => emptyBody(200)], async () => {
    await assertRejects(() => run("list-actions", {}, ctx), TypeError);
  });
});

Deno.test("contrast: a defined-but-empty spec object ({} with no 'paths' key) does NOT throw — 'paths ?? {}' handles this side fine", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({})], async () => {
    await run("list-actions", {}, ctx);
  });
  const res = written.find((w) => w.spec === "actions")!;
  assertEquals(res.payload.actions, []);
  assertEquals(res.payload.total, 0);
});

// ---------------------------------------------------------------------------
// authenticate: missing-apikey branch — the response-echo credential-leak path
// ---------------------------------------------------------------------------

Deno.test("pin: authenticate rejects with an error that echoes the raw response (sliced to 200 chars) when 'apikey' is absent from an otherwise-200 response", async () => {
  const { ctx } = makeCtx();
  const noApikeyResponse = { message: "please contact your administrator" };
  await withFetchStub([() => json(noApikeyResponse)], async () => {
    const err = await assertRejects(
      () => run("authenticate", { user: "a", pass: "b" }, ctx),
      Error,
      "auth response missing apikey:",
    );
    assert(err.message.includes(JSON.stringify(noApikeyResponse)));
  });
});

Deno.test("sanity: the synthetic auth.json fixture used elsewhere carries no secret-shaped value that this echo path could leak", () => {
  assert(
    !/^[A-Za-z0-9]{32,}$/.test(auth.apikey),
    "auth.json's apikey must stay short/hyphenated, evading the high-entropy pattern",
  );
});

// ---------------------------------------------------------------------------
// Hostile server echoes the caller's OWN apikey back into a non-ok error body
// ---------------------------------------------------------------------------

Deno.test("pin: a hostile/buggy server that echoes the request's apikey into a non-ok error body leaks it into the thrown Error message", async () => {
  // http() builds its error message from the raw response text
  // (`text.slice(0, 300)`), with no redaction. This is NOT the client
  // leaking its own secret via its own code paths — it is a trust-boundary
  // note: shoko.ts performs no filtering of what a malicious/misconfigured
  // server echoes back. Pinned as a documented mechanism, not fixed here.
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      textResponse(
        `Forbidden: header apikey=${API_KEY} rejected`,
        403,
      )],
    async () => {
      const err = await assertRejects(() => run("dashboard", {}, ctx), Error);
      assert(
        err.message.includes(API_KEY),
        "sanity: fixture actually leaks — confirms the echo mechanism is real",
      );
    },
  );
});

Deno.test("pin: a 200 OK dashboard/status response that echoes the caller's own apikey is written VERBATIM into that (non-auth) resource — NOT covered by the auth-resource-by-design carve-out", async () => {
  // Round-1 test-review MEDIUM finding: the prior test above only pins the
  // ERROR-body echo path. dashboard/status write their entire parsed
  // response body straight through with no filtering or redaction — a
  // hostile or misconfigured Shoko instance (or a debug/echo reverse proxy
  // in front of it) that reflects the request's apikey header into a 200 OK
  // response body would have it persisted into the dashboard/status
  // resource, neither of which is the auth resource the "mints the key in
  // BY DESIGN" carve-out applies to, and neither of which is marked
  // sensitive. Documented gap, not fixed here (shoko.ts unmodified).
  const { ctx, written } = makeCtx();
  const echoingResponse = {
    CollectionStats: { SeriesCount: 1 },
    DebugRequestHeaders: { apikey: API_KEY },
  };
  await withFetchStub([() => json(echoingResponse)], async () => {
    await run("dashboard", {}, ctx);
  });
  const res = written.find((w) => w.spec === "dashboard")!;
  assert(
    JSON.stringify(res.payload).includes(API_KEY),
    "sanity: fixture actually echoes the apikey into the dashboard resource",
  );
  assertEquals(res.payload, echoingResponse);
});

// ---------------------------------------------------------------------------
// Non-JSON / malformed responses
// ---------------------------------------------------------------------------

Deno.test("pin: a non-JSON response body (e.g. an HTML error page) is swallowed to {raw: text}, never thrown as a SyntaxError", async () => {
  const { ctx, written } = makeCtx();
  const html = "<html><body>502 Bad Gateway</body></html>";
  await withFetchStub(
    [() => textResponse(html, 200, "text/html")],
    async () => {
      await run("dashboard", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "dashboard")!;
  assertEquals(res.payload, { raw: html });
});

Deno.test("pin: an empty-body 200 on list-series (data.List ?? []) DEREFERENCES A NULL data and throws a TypeError", async () => {
  // http() returns null for an empty body. list-series then does
  // `data.List ?? []` — `??` only guards `List` being nullish on a DEFINED
  // object; it does nothing when `data` itself is null. Documented gap
  // (shoko.ts unmodified); the full sweep across every List-keyed method is
  // in shoko_coverage_test.ts.
  const { ctx } = makeCtx();
  await withFetchStub([() => emptyBody(200)], async () => {
    await assertRejects(() => run("list-series", {}, ctx), TypeError);
  });
});

Deno.test("a tampered/hostile items array (script-tag content, unexpected extra keys) passes through unfiltered", async () => {
  // shoko.ts performs no sanitization or shape validation on List/array
  // items beyond the loose passthrough zod schemas; it is a thin proxy.
  // This documents that fact rather than treating it as a vulnerability —
  // item content is never interpreted/rendered by this model, only stored.
  const { ctx, written } = makeCtx();
  const hostileItems = [{
    IDs: { ID: 1 },
    Name: "<script>alert(1)</script>",
    unexpectedExtraField: { nested: true },
  }];
  await withFetchStub(
    [() => json({ Total: 1, List: hostileItems })],
    async () => {
      await run("list-series", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "series")!;
  assertEquals(res.payload.items, hostileItems);
});

// ---------------------------------------------------------------------------
// Destructive maintenance surface — no confirmation, no idempotency guard
// ---------------------------------------------------------------------------

Deno.test("pin: remove-missing-files fires the GET-triggered side effect and discards whatever the server returns — no confirmation prompt, no result surfaced", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ ThisResponseBody: "is entirely discarded" })],
    async () => {
      await run("remove-missing-files", { removeFromMyList: true }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "task")!;
  assertEquals(
    res.payload.message,
    "Triggered RemoveMissingFiles (removeFromMyList=true)",
    "the written message is a static template, independent of the actual response body",
  );
});

Deno.test("pin: run-action has no idempotency guard — firing the same action twice makes two independent GET requests", async () => {
  const { ctx } = makeCtx();
  let hits = 0;
  await withFetchStub(
    [() => {
      hits++;
      return json({});
    }],
    async () => {
      await run("run-action", { action: "RunImport" }, ctx);
      await run("run-action", { action: "RunImport" }, ctx);
    },
  );
  assertEquals(hits, 2, "no dedup — two independent GETs for the same action");
});

Deno.test("pin: run-action's writeResource name is templated by ACTION NAME only — the same action fired twice clobbers the prior task resource; two different actions do not", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({})], async () => {
    await run("run-action", { action: "RunImport" }, ctx);
    await run("run-action", { action: "RunImport" }, ctx);
    await run("run-action", { action: "SyncMyList" }, ctx);
  });
  const names = written.filter((w) => w.spec === "task").map((w) => w.name);
  assertEquals(
    names,
    [
      "action-RunImport",
      "action-RunImport",
      "action-SyncMyList",
    ],
    "repeating the same action writes the identical resource name twice — the second clobbers the first in a real instance",
  );
});

Deno.test("rescan-folder: repeated calls for the SAME folder id make two independent requests, no idempotency short-circuit", async () => {
  const { ctx } = makeCtx();
  let calls = 0;
  await withFetchStub(
    [() => {
      calls++;
      return json({});
    }],
    async () => {
      await run("rescan-folder", { importFolderId: 7 }, ctx);
      await run("rescan-folder", { importFolderId: 7 }, ctx);
    },
  );
  assertEquals(calls, 2);
});

// ---------------------------------------------------------------------------
// Injection via run-action's action name — CONTRAST with porkbun's gap:
// shoko.ts DOES encodeURIComponent the path segment
// ---------------------------------------------------------------------------

Deno.test("run-action: a hostile action name is encodeURIComponent-escaped in the URL path (neutralized) but kept RAW in the written task message", async () => {
  const { ctx, written } = makeCtx();
  const hostile = "../../etc/passwd";
  await withFetchStub([() => json({})], async (calls) => {
    await run("run-action", { action: hostile }, ctx);
    const pathname = new URL(calls[0].url).pathname;
    assertEquals(
      pathname,
      `/api/v3/Action/${encodeURIComponent(hostile)}`,
      "encodeURIComponent neutralizes path-traversal-shaped segments — no extra path segments appear",
    );
    assert(
      !pathname.includes("/../"),
      "the URL must not contain a literal path-traversal segment",
    );
  });
  const res = written.find((w) => w.spec === "task")!;
  assertEquals(
    res.payload.message,
    `Triggered ${hostile}`,
    "the written audit message keeps the raw, unescaped action name",
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "shoko-secrets vault name", re: /shoko-secrets/i },
  { name: "vault key name API_KEY", re: /\bAPI_KEY\b/ },
  // Generic high-entropy blob: a value that is ENTIRELY 32+ alnum characters
  // with no separators — none of our authored fixture values (hosts, ids,
  // names, hex checksums, error text) match this shape. Real Shoko apikeys
  // and GUIDs both fall in this shape.
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9]{32,}$/ },
  {
    name: "GUID shape",
    re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
];

/** Recursively collect every string leaf value in a parsed JSON structure. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

const FIXTURES: Record<string, unknown> = {
  "auth.json": auth,
  "status.json": status,
  "dashboard.json": dashboard,
  "series.json": series,
  "files.json": files,
  "missing-episodes.json": missingEpisodes,
  "duplicate-files.json": duplicateFiles,
  "import-folders.json": importFolders,
  "queue.json": queue,
  "queue-single.json": queueSingle,
  "swagger.json": swagger,
  "error.json": errorFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected secret shape", () => {
  // Guards against the scan test above being vacuously true (e.g. broken
  // regexes that never match anything).
  const violations: string[] = [];
  const poisoned = { key: "a".repeat(40) };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real 32+ char alnum shape",
  );
});
