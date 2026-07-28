// Method-level tests for @magistr/pihole — drives all six model methods
// against a stubbed globalThis.fetch (schema-parse-then-execute, mirroring
// the swamp runtime). Pure encode/decode/diff/redact logic is pinned by
// pihole_dns_test.ts (contract-fixture); this suite exercises the
// lib/client.ts I/O layer + pihole.ts orchestration that the pure suite
// cannot reach.
//
// Invariants under test:
//  - every method authenticates first (POST /api/auth) and ALWAYS releases
//    the FTL session (DELETE /api/auth) — success or failure
//  - add uses PUT, delete uses DELETE, both at
//    /api/config/dns/hosts/<encodeEntry(ip, hostname)>
//  - exact writeResource spec+name per method
//  - idempotency: an already-present record is reported unchanged/success
//    with NO write call; an absent record deletes as a no-op success
//  - a failed per-record operation is captured in the result resource, and
//    the method throws only AFTER writing that resource
//  - the web password never appears in any written resource

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

function puts(calls: Request[]): Request[] {
  return calls.filter((c) => c.method === "PUT");
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

Deno.test("list: writes dns-records with parsed records; auth brackets the call with a logout", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs());
  const state: RouteState = {
    hosts: ["10.0.0.1 nas.test", "10.0.0.2 printer.test"],
  };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("list", {}, ctx);
    assertEquals(calls[0].method, "POST");
    assertEquals(new URL(calls[0].url).pathname, "/api/auth");
    const last = calls[calls.length - 1];
    assertEquals(last.method, "DELETE");
    assertEquals(new URL(last.url).pathname, "/api/auth");
  });
  const rec = written.find((w) => w.spec === "dns-records");
  assert(rec, "dns-records resource written");
  assertEquals(rec.name, "dns-records");
  assertEquals(rec.payload.count, 2);
  assertEquals(rec.payload.records, [
    { ip: "10.0.0.1", hostname: "nas.test" },
    { ip: "10.0.0.2", hostname: "printer.test" },
  ]);
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

Deno.test("add: PUTs only the missing records; an already-present record is reported unchanged with no PUT", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [
      { ip: "10.0.0.1", hostname: "existing.test" },
      { ip: "10.0.0.9", hostname: "new.test" },
    ],
  }));
  const state: RouteState = { hosts: ["10.0.0.1 existing.test"] };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("add", {}, ctx);
    const putCalls = puts(calls);
    assertEquals(putCalls.length, 1, "only the missing record gets a PUT");
    assertStringIncludes(putCalls[0].url, encodeEntry("10.0.0.9", "new.test"));
  });
  const res = written.find((w) => w.spec === "add-result");
  assert(res);
  assertEquals(res.name, "add-result");
  assertEquals(res.payload.succeeded, 2);
  assertEquals(res.payload.failed, 0);
});

Deno.test("add: a failed PUT is captured in the result and the method throws AFTER writing it", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [
      { ip: "10.0.0.5", hostname: "ok.test" },
      { ip: "10.0.0.6", hostname: "bad.test" },
    ],
  }));
  const state: RouteState = {
    hosts: [],
    failPuts: new Set([encodeEntry("10.0.0.6", "bad.test")]),
  };
  await withFetchStub(piholeRoutes(state), async () => {
    await assertRejects(
      () => run("add", {}, ctx),
      Error,
      "1 of 2 record(s) failed",
    );
  });
  const res = written.find((w) => w.spec === "add-result");
  assert(res, "add-result written even though the method threw");
  assertEquals(res.payload.succeeded, 1);
  assertEquals(res.payload.failed, 1);
});

// ---------------------------------------------------------------------------
// add-record
// ---------------------------------------------------------------------------

Deno.test("add-record: idempotent — already-present record succeeds with no PUT", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs());
  const state: RouteState = { hosts: ["10.0.0.1 a.test"] };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("add-record", { ip: "10.0.0.1", hostname: "a.test" }, ctx);
    assertEquals(puts(calls).length, 0);
  });
  const res = written.find((w) => w.spec === "add-result");
  assert(res);
  assertEquals(res.name, "add-record-result");
  assertEquals(res.payload.succeeded, 1);
});

Deno.test("add-record: absent record issues exactly one PUT at the encoded path and succeeds", async () => {
  const { ctx } = makeCtx(baseGlobalArgs());
  const state: RouteState = { hosts: [] };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("add-record", { ip: "10.0.0.2", hostname: "b.test" }, ctx);
    const putCalls = puts(calls);
    assertEquals(putCalls.length, 1);
    assertStringIncludes(putCalls[0].url, encodeEntry("10.0.0.2", "b.test"));
  });
});

Deno.test("add-record: a failed PUT is captured in add-result and the method throws", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs());
  const state: RouteState = {
    hosts: [],
    failPuts: new Set([encodeEntry("10.0.0.9", "bad.test")]),
  };
  await withFetchStub(piholeRoutes(state), async () => {
    await assertRejects(
      () => run("add-record", { ip: "10.0.0.9", hostname: "bad.test" }, ctx),
      Error,
      "add-record failed",
    );
  });
  const res = written.find((w) => w.spec === "add-result");
  assert(res, "add-result written even though add-record threw");
  assertEquals(res.name, "add-record-result");
  assertEquals(res.payload.succeeded, 0);
  assertEquals(res.payload.failed, 1);
});

// ---------------------------------------------------------------------------
// delete-record
// ---------------------------------------------------------------------------

Deno.test("delete-record: idempotent — absent record succeeds with no DELETE call", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs());
  const state: RouteState = { hosts: [] };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("delete-record", { ip: "10.0.0.1", hostname: "a.test" }, ctx);
    assertEquals(hostDeletes(calls).length, 0);
  });
  const res = written.find((w) => w.spec === "delete-result");
  assert(res);
  assertEquals(res.name, "delete-record-result");
  assertEquals(res.payload.succeeded, 1);
});

Deno.test("delete-record: present record issues exactly one DELETE at the encoded path", async () => {
  const { ctx } = makeCtx(baseGlobalArgs());
  const state: RouteState = { hosts: ["10.0.0.1 a.test"] };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("delete-record", { ip: "10.0.0.1", hostname: "a.test" }, ctx);
    const deletes = hostDeletes(calls);
    assertEquals(deletes.length, 1);
    assertStringIncludes(deletes[0].url, encodeEntry("10.0.0.1", "a.test"));
  });
});

Deno.test("delete-record: a failed DELETE is captured in delete-result and the method throws", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs());
  const state: RouteState = {
    hosts: ["10.0.0.1 a.test"],
    failDeletes: new Set([encodeEntry("10.0.0.1", "a.test")]),
  };
  await withFetchStub(piholeRoutes(state), async () => {
    await assertRejects(
      () => run("delete-record", { ip: "10.0.0.1", hostname: "a.test" }, ctx),
      Error,
      "delete-record failed",
    );
  });
  const res = written.find((w) => w.spec === "delete-result");
  assert(res, "delete-result written even though delete-record threw");
  assertEquals(res.name, "delete-record-result");
  assertEquals(res.payload.succeeded, 0);
  assertEquals(res.payload.failed, 1);
});

// ---------------------------------------------------------------------------
// sync / sync-clean
// ---------------------------------------------------------------------------

Deno.test("sync: writeResource is named sync-result when deleteExtras is omitted (default false — zero deletes)", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.1", hostname: "keep.test" }],
  }));
  const state: RouteState = {
    hosts: ["10.0.0.1 keep.test", "10.0.0.9 extra.test"],
  };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("sync", {}, ctx);
    assertEquals(hostDeletes(calls).length, 0);
  });
  const res = written.find((w) => w.spec === "sync-result");
  assert(res);
  assertEquals(res.name, "sync-result");
  assertEquals(res.payload.deleted, []);
});

Deno.test("sync: deleteExtras=true deletes the extra and writes sync-clean-result", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.1", hostname: "keep.test" }],
  }));
  const state: RouteState = {
    hosts: ["10.0.0.1 keep.test", "10.0.0.9 extra.test"],
  };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("sync", { deleteExtras: true }, ctx);
    const deletes = hostDeletes(calls);
    assertEquals(deletes.length, 1);
    assertStringIncludes(deletes[0].url, encodeEntry("10.0.0.9", "extra.test"));
  });
  const res = written.find((w) => w.spec === "sync-result");
  assert(res);
  assertEquals(res.name, "sync-clean-result");
});

Deno.test("sync-clean: writes sync-clean-result and deletes the extra", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.1", hostname: "keep.test" }],
  }));
  const state: RouteState = {
    hosts: ["10.0.0.1 keep.test", "10.0.0.9 extra.test"],
  };
  await withFetchStub(piholeRoutes(state), async (calls) => {
    await run("sync-clean", {}, ctx);
    assertEquals(hostDeletes(calls).length, 1);
  });
  const res = written.find((w) => w.spec === "sync-result");
  assert(res);
  assertEquals(res.name, "sync-clean-result");
  assertEquals(res.payload.deleted, [{
    ip: "10.0.0.9",
    hostname: "extra.test",
  }]);
});

Deno.test("sync: a failed operation is aggregated into failed[] and the method throws", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.5", hostname: "willfail.test" }],
  }));
  const state: RouteState = {
    hosts: [],
    failPuts: new Set([encodeEntry("10.0.0.5", "willfail.test")]),
  };
  await withFetchStub(piholeRoutes(state), async () => {
    await assertRejects(
      () => run("sync", {}, ctx),
      Error,
      "1 operation(s) failed",
    );
  });
  const res = written.find((w) => w.spec === "sync-result");
  assert(res, "sync-result written even though sync threw");
  assertEquals(res.payload.summary as unknown, {
    added: 0,
    deleted: 0,
    unchanged: 0,
    failed: 1,
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: the password never appears in a written resource
// ---------------------------------------------------------------------------

Deno.test("password never appears in any written resource across list/add/sync", async () => {
  const { ctx, written } = makeCtx(baseGlobalArgs({
    records: [{ ip: "10.0.0.1", hostname: "a.test" }],
  }));
  const state: RouteState = { hosts: ["10.0.0.1 a.test"] };
  await withFetchStub(piholeRoutes(state), async () => {
    await run("list", {}, ctx);
    await run("add", {}, ctx);
    await run("sync", {}, ctx);
  });
  const serialized = JSON.stringify(written);
  assertEquals(serialized.includes(PASSWORD), false);
});
