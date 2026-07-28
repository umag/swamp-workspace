// Coverage tests for @magistr/pihole — reviewer-GUARD regressions distinct
// from pihole_dns_test.ts (pure encode/decode/diff logic) and from
// pihole_methods_test.ts (the six-method success/idempotency matrix). Every
// test here pins a guard that a code reviewer could otherwise delete without
// any test going red.
//
// Guards pinned:
//  - the FTL session is released, and the HTTP client closed, even when the
//    session callback throws a genuinely unexpected exception (not a
//    captured per-record failure)
//  - converge (sync / sync-clean) refuses before ANY HTTP call when
//    globalArguments.records is empty or absent
//  - deleteExtras defaults to false when the sync argument is omitted
//  - a failed delete inside sync-clean is captured in failed[] and the
//    sync-clean-result artifact is written BEFORE the method throws
//  - parseHostsEntries skips a non-matching host-file line instead of
//    mis-parsing it (previously unexercised branch)

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { encodeEntry, parseHostsEntries } from "./lib/dns.ts";
import { model } from "./pihole.ts";

const HOST = "pihole.test";
const PASSWORD = "swamp-test-pw-01";
const SID = "test-sid-0123456789";
const CSRF = "test-csrf-9876543210";

function baseGlobalArgs(overrides: Record<string, unknown> = {}) {
  return {
    host: HOST,
    password: PASSWORD,
    scheme: "http" as const,
    ...overrides,
  };
}

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve();
      },
    },
  };
}

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as Record<string, {
    arguments: { parse: (a: unknown) => unknown };
    execute: (a: unknown, c: unknown) => Promise<unknown>;
  }>)[name];
  assert(method, `method ${name} must exist on the model`);
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
    throw new Error(`fetch stub: unrouted ${req.method} ${req.url}`);
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

interface RouteState {
  hosts: string[];
  authValid?: boolean;
  failPuts?: Set<string>;
  failDeletes?: Set<string>;
}

function piholeRoutes(state: RouteState): Route[] {
  const authValid = state.authValid ?? true;
  return [
    (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/auth") {
        if (!authValid) {
          return new Response(
            JSON.stringify({ session: { valid: false, message: "invalid" } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ session: { valid: true, sid: SID, csrf: CSRF } }),
          { status: 200 },
        );
      }
      return undefined;
    },
    (req) => {
      const url = new URL(req.url);
      if (req.method === "DELETE" && url.pathname === "/api/auth") {
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
    (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/config/dns/hosts") {
        return new Response(
          JSON.stringify({ config: { dns: { hosts: state.hosts } } }),
          { status: 200 },
        );
      }
      return undefined;
    },
    (req) => {
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/api\/config\/dns\/hosts\/(.+)$/);
      if (!m) return undefined;
      const seg = m[1];
      if (req.method === "PUT") {
        if (state.failPuts?.has(seg)) {
          return new Response("upstream rejected", { status: 400 });
        }
        return new Response(null, { status: 201 });
      }
      if (req.method === "DELETE") {
        if (state.failDeletes?.has(seg)) {
          return new Response("upstream rejected", { status: 400 });
        }
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
  ];
}

function hostDeletes(calls: Request[]): Request[] {
  return calls.filter((c) =>
    c.method === "DELETE" && new URL(c.url).pathname !== "/api/auth"
  );
}

function logouts(calls: Request[]): Request[] {
  return calls.filter((c) =>
    c.method === "DELETE" && new URL(c.url).pathname === "/api/auth"
  );
}

// ---------------------------------------------------------------------------
// Guard: the session is released (and the client closed) even on a genuinely
// unexpected exception inside the session callback.
// ---------------------------------------------------------------------------

Deno.test("list: a genuinely thrown exception inside the session (invalid JSON, not a captured per-record failure) still releases the FTL session", async () => {
  const { ctx } = makeCtx(baseGlobalArgs());
  const routes: Route[] = [
    (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/config/dns/hosts") {
        // Malformed JSON: res.json() throws a SyntaxError, distinct from the
        // res.ok===false branch already covered by the adversarial suite.
        return new Response("not-json{{{", { status: 200 });
      }
      return undefined;
    },
    ...piholeRoutes({ hosts: [] }),
  ];
  await withFetchStub(routes, async (calls) => {
    await assertRejects(() => run("list", {}, ctx));
    assertEquals(
      logouts(calls).length,
      1,
      "session released even on an unexpected exception",
    );
  });
});

Deno.test("the HTTP client is closed even when the session callback throws (https + caCert path)", async () => {
  const original = Deno.createHttpClient;
  let closeCalls = 0;
  // Replace Deno.createHttpClient with a fake so this test never depends on
  // a real certificate; fetch itself is stubbed below, so the `client`
  // object is never dereferenced for an actual TLS handshake — only its
  // `close()` guarantee (called from withSession's finally block) matters.
  Deno.createHttpClient = ((_opts: Deno.CreateHttpClientOptions) => {
    return {
      close: () => {
        closeCalls++;
      },
    } as unknown as Deno.HttpClient;
  }) as typeof Deno.createHttpClient;

  try {
    const { ctx } = makeCtx(baseGlobalArgs({
      scheme: "https",
      caCert:
        "-----BEGIN CERTIFICATE-----\nFAKEDONOTUSE\n-----END CERTIFICATE-----",
    }));
    const routes: Route[] = [
      (req) => {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/api/config/dns/hosts") {
          throw new TypeError("simulated unexpected exception");
        }
        return undefined;
      },
      ...piholeRoutes({ hosts: [] }),
    ];
    await withFetchStub(routes, async () => {
      await assertRejects(() => run("list", {}, ctx));
    });
    assertEquals(closeCalls, 1, "client.close() must run even after a throw");
  } finally {
    Deno.createHttpClient = original;
  }
});

// ---------------------------------------------------------------------------
// Guard: converge refuses before any HTTP call when records is empty/absent.
// ---------------------------------------------------------------------------

Deno.test("sync-clean: empty records[] refuses before any HTTP call (zero I/O, not just zero deletes)", async () => {
  const { ctx } = makeCtx(baseGlobalArgs({ records: [] }));
  await withFetchStub([], async (calls) => {
    await assertRejects(
      () => run("sync-clean", {}, ctx),
      Error,
      "No records specified",
    );
    assertEquals(calls.length, 0, "no auth or any HTTP call attempted");
  });
});

Deno.test("add: empty/absent records[] refuses before any HTTP call (the add method has its own guard, separate from runSync's)", async () => {
  const { ctx } = makeCtx(baseGlobalArgs({ records: [] }));
  await withFetchStub([], async (calls) => {
    await assertRejects(
      () => run("add", {}, ctx),
      Error,
      "No records specified",
    );
    assertEquals(calls.length, 0, "no auth or any HTTP call attempted");
  });
});

Deno.test("sync-clean: an absent records field refuses before any HTTP call", async () => {
  const { ctx } = makeCtx(baseGlobalArgs());
  await withFetchStub([], async (calls) => {
    await assertRejects(
      () => run("sync-clean", {}, ctx),
      Error,
      "No records specified",
    );
    assertEquals(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Guard: deleteExtras defaults to false when the sync argument is omitted.
// ---------------------------------------------------------------------------

Deno.test("sync: deleteExtras defaults to false when the argument is omitted — an extra record is never deleted", async () => {
  const { ctx } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.1", hostname: "keep.test" }],
  }));
  const state: RouteState = {
    hosts: ["10.0.0.1 keep.test", "10.0.0.9 extra.test"],
  };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("sync", {}, ctx);
    assertEquals(
      hostDeletes(calls).length,
      0,
      "an omitted deleteExtras must never delete",
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: a failed delete inside sync-clean is captured, and the artifact is
// written BEFORE the method throws.
// ---------------------------------------------------------------------------

Deno.test("sync-clean: a failed delete is captured in failed[] and the sync-clean-result artifact is written before the throw", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.1", hostname: "keep.test" }],
  }));
  const state: RouteState = {
    hosts: ["10.0.0.1 keep.test", "10.0.0.9 extra.test"],
    failDeletes: new Set([encodeEntry("10.0.0.9", "extra.test")]),
  };
  await withFetchStub(piholeRoutes(state), async () => {
    await assertRejects(
      () => run("sync-clean", {}, ctx),
      Error,
      "1 operation(s) failed",
    );
  });
  const res = written.find((w) => w.spec === "sync-result");
  assert(res, "sync-clean-result written before the throw");
  assertEquals(res.name, "sync-clean-result");
  assertEquals(res.payload.summary as unknown, {
    added: 0,
    deleted: 0,
    unchanged: 1,
    failed: 1,
  });
  assertEquals(
    res.payload.deleted,
    [],
    "a failed delete must never be counted as deleted",
  );
});

// ---------------------------------------------------------------------------
// Guard: parseHostsEntries skips a non-matching line instead of mis-parsing.
// ---------------------------------------------------------------------------

Deno.test("parseHostsEntries: a line with no whitespace-delimited hostname is skipped, not mis-parsed", () => {
  const out = parseHostsEntries([
    "not-a-valid-entry-with-no-hostname",
    "",
    "   ",
    "10.0.0.1 good.test",
  ]);
  assertEquals(out, [{ ip: "10.0.0.1", hostname: "good.test" }]);
});
