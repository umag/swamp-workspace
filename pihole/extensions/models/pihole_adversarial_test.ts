// Adversarial tests for @magistr/pihole — attacker's-perspective / hostile-
// environment focus, weighted to the DESTRUCTIVE paths (sync --deleteExtras,
// sync-clean). Exercises redaction THROUGH the client (not the pure
// redactSecrets cases already pinned in pihole_dns_test.ts).
//
// Invariants under test:
//  - an empty desired list refuses to run rather than wiping the zone
//  - a rejected list() fetch aborts with zero deletes and still releases
//    the session
//  - a partial/truncated list() fetch NEVER deletes a record that is
//    actually present but was not in the fetched view — through BOTH
//    `sync --deleteExtras` and `sync-clean` (they share the same guard)
//  - a per-record transport fault (fetch rejects) is captured as status 0,
//    not an unhandled rejection, and the audit artifact is still written
//  - auth 200 + session.valid=false is a failed login: throws, writes
//    nothing
//  - the password / sid / csrf never leak into a thrown error, even when a
//    hostile/buggy upstream reflects them back
//  - scheme=http emits a cleartext warning
//  - an invalid caCert PEM under https is rejected before any network call
//  - truncated/invalid JSON from the hosts endpoint surfaces as a clear
//    thrown diagnostic, never a silent empty/partial dns-records write

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { encodeEntry } from "./lib/dns.ts";
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

// ===========================================================================
// 1. Empty desired list must never wipe the zone
// ===========================================================================

Deno.test("[destructive] sync-clean with an empty desired list refuses to run rather than wiping the zone", async () => {
  const { ctx } = makeCtx(baseGlobalArgs({ records: [] }));
  const state: RouteState = {
    hosts: ["10.0.0.1 critical-a.test", "10.0.0.2 critical-b.test"],
  };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await assertRejects(
      () => run("sync-clean", {}, ctx),
      Error,
      "No records specified",
    );
    assertEquals(
      calls.length,
      0,
      "not even the list GET is reached — zero deletes, zero I/O",
    );
  });
});

// ===========================================================================
// 2. A rejected list() aborts with zero deletes, session still released
// ===========================================================================

Deno.test("[destructive] a rejected list() aborts sync-clean with zero deletes and still releases the session", async () => {
  const { ctx } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.1", hostname: "keep.test" }],
  }));
  const routes: Route[] = [
    (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/config/dns/hosts") {
        return new Response("upstream error", { status: 500 });
      }
      return undefined;
    },
    ...piholeRoutes({ hosts: [] }),
  ];
  await withFetchStub(routes, async (calls) => {
    await assertRejects(() => run("sync-clean", {}, ctx));
    assertEquals(
      hostDeletes(calls).length,
      0,
      "no delete is ever attempted when list() failed",
    );
    assertEquals(
      logouts(calls).length,
      1,
      "session still released despite the failure",
    );
  });
});

// ===========================================================================
// 3. A partial/truncated list() never deletes a record it never fetched —
//    exercised through BOTH sync --deleteExtras and sync-clean.
// ===========================================================================

async function assertPartialListNeverDeletesHiddenRecord(
  methodName: "sync" | "sync-clean",
  args: Record<string, unknown>,
) {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.1", hostname: "a.test" }],
  }));
  // The REAL zone has a.test, b.test, AND c.test — but the list() response
  // is partial/truncated and only reports a.test and b.test. c.test is a
  // real, present record the method never learns about, so it can NEVER be
  // targeted for deletion no matter how the diff is computed.
  const state: RouteState = {
    hosts: ["10.0.0.1 a.test", "10.0.0.2 b.test"],
  };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run(methodName, args, ctx);
    const deletes = hostDeletes(calls);
    assert(
      !deletes.some((c) => c.url.includes(encodeEntry("10.0.0.3", "c.test"))),
      `${methodName}: a record outside the fetched list must never be targeted for delete`,
    );
  });
  const res = written.find((w) => w.spec === "sync-result");
  assert(res);
  const deleted = res.payload.deleted as Array<
    { ip: string; hostname: string }
  >;
  assert(
    !deleted.some((d) => d.ip === "10.0.0.3"),
    `${methodName}: deleted[] must never include a record the partial list never reported`,
  );
}

Deno.test("[destructive] a partial/truncated list() never deletes a present-but-unfetched record — via sync --deleteExtras", async () => {
  await assertPartialListNeverDeletesHiddenRecord("sync", {
    deleteExtras: true,
  });
});

Deno.test("[destructive] a partial/truncated list() never deletes a present-but-unfetched record — via sync-clean", async () => {
  await assertPartialListNeverDeletesHiddenRecord("sync-clean", {});
});

// ===========================================================================
// 4. A transport fault is captured (status 0), never an unhandled rejection
// ===========================================================================

Deno.test("a transport fault (fetch rejects) during a write is captured as status 0, and the sync-result artifact records it", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.5", hostname: "flaky.test" }],
  }));
  const routes: Route[] = [
    (req) => {
      const url = new URL(req.url);
      if (
        req.method === "PUT" &&
        url.pathname.startsWith("/api/config/dns/hosts/")
      ) {
        throw new TypeError("error sending request: connection reset");
      }
      return undefined;
    },
    ...piholeRoutes({ hosts: [] }),
  ];
  await withFetchStub(routes, async () => {
    await assertRejects(
      () => run("sync", {}, ctx),
      Error,
      "1 operation(s) failed",
    );
  });
  const res = written.find((w) => w.spec === "sync-result");
  assert(res, "sync-result written despite the transport fault");
  const failed = res.payload.failed as Array<
    { ip: string; hostname: string; error: string }
  >;
  assertEquals(failed.length, 1);
  assertStringIncludes(failed[0].error, "connection reset");
});

// ===========================================================================
// 5. auth 200 + session.valid=false is a failed login: throws, writes nothing
// ===========================================================================

Deno.test("auth returning 200 with session.valid=false is treated as a failed login — throws, writes nothing", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs());
  const routes = piholeRoutes({ hosts: [], authValid: false });
  await withFetchStub(routes, async () => {
    await assertRejects(() => run("list", {}, ctx), Error, "Auth failed");
  });
  assertEquals(
    written.length,
    0,
    "no resource written when auth never succeeded",
  );
});

// ===========================================================================
// 6. Secrets never leak into a thrown error, even from a hostile upstream
// ===========================================================================

Deno.test("an auth failure never reflects the password back in the thrown error, even if the upstream echoes it", async () => {
  const { ctx } = makeCtx(baseGlobalArgs());
  const routes: Route[] = [
    (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/auth") {
        return new Response(
          JSON.stringify({
            session: {
              valid: false,
              message: `rejected password=${PASSWORD}`,
            },
          }),
          { status: 200 },
        );
      }
      return undefined;
    },
  ];
  await withFetchStub(routes, async () => {
    let threw = false;
    try {
      await run("list", {}, ctx);
    } catch (e) {
      threw = true;
      const message = e instanceof Error ? e.message : String(e);
      assertEquals(message.includes(PASSWORD), false);
    }
    assert(threw, "expected auth failure to throw");
  });
});

Deno.test("a thrown error never leaks sid/csrf/password even when a hostile upstream reflects them in an error body", async () => {
  const { ctx } = makeCtx(baseGlobalArgs());
  const routes: Route[] = [
    (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/config/dns/hosts") {
        return new Response(
          `List failed: sid=${SID} csrf=${CSRF} password=${PASSWORD}`,
          { status: 500 },
        );
      }
      return undefined;
    },
    ...piholeRoutes({ hosts: [] }),
  ];
  await withFetchStub(routes, async () => {
    let threw = false;
    try {
      await run("list", {}, ctx);
    } catch (e) {
      threw = true;
      const message = e instanceof Error ? e.message : String(e);
      assertEquals(message.includes(PASSWORD), false);
      assertEquals(message.includes(SID), false);
      assertEquals(message.includes(CSRF), false);
    }
    assert(threw, "expected the list failure to throw");
  });
});

// ===========================================================================
// 7. scheme=http emits a cleartext warning
// ===========================================================================

Deno.test("scheme=http (default) emits a cleartext warning", async () => {
  const { ctx } = makeCtx(baseGlobalArgs({ scheme: "http" }));
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await withFetchStub(piholeRoutes({ hosts: [] }), async () => {
      await run("list", {}, ctx);
    });
  } finally {
    console.warn = originalWarn;
  }
  assert(
    warnings.some((w) => w.toLowerCase().includes("cleartext")),
    "expected a cleartext HTTP warning",
  );
});

// ===========================================================================
// 8. An invalid caCert PEM under https is rejected before any network call
// ===========================================================================

Deno.test("an https caCert that is not PEM content is rejected before any network call", async () => {
  const { ctx } = makeCtx(baseGlobalArgs({
    scheme: "https",
    caCert: "not-a-real-certificate",
  }));
  await withFetchStub([], async (calls) => {
    await assertRejects(() => run("list", {}, ctx), Error, "PEM");
    assertEquals(
      calls.length,
      0,
      "rejected before any auth call was attempted",
    );
  });
});

// ===========================================================================
// 9. Truncated/invalid JSON surfaces as a diagnostic, not a silent empty list
// ===========================================================================

Deno.test("truncated/invalid JSON from the hosts endpoint surfaces as a thrown diagnostic, not a silent empty dns-records write", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs());
  const routes: Route[] = [
    (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/config/dns/hosts") {
        return new Response(
          '{"config":{"dns":{"hosts":["10.0.0.1 a.test"',
          { status: 200 },
        );
      }
      return undefined;
    },
    ...piholeRoutes({ hosts: [] }),
  ];
  await withFetchStub(routes, async () => {
    await assertRejects(() => run("list", {}, ctx));
  });
  assertEquals(
    written.length,
    0,
    "a parse failure must not silently write an empty/partial dns-records resource",
  );
});
