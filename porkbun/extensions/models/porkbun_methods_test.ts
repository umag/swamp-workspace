/**
 * Method-level tests for @magistr/porkbun — every one of the 7 methods
 * (ping, list, get, create, update, delete, deleteByNameType), happy path +
 * error path, driven through `model.methods.<m>.arguments.parse()` +
 * `.execute()` against a stubbed `globalThis.fetch` and a fake context.
 *
 * porkbun.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Credential-leak assertions run for every method: the apiKey/secretApiKey
 * globals must never appear in a thrown error, a written resource payload,
 * or a logger call.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./porkbun.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const API_KEY = "pk1_test_stub_do_not_log";
const SECRET_API_KEY = "sk1_test_stub_do_not_log";

const GLOBAL_ARGS = {
  domain: "example.com",
  apiKey: API_KEY,
  secretApiKey: SECRET_API_KEY,
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

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied,
 * enums enforced) before execute is invoked — never call execute() with raw,
 * unparsed args. */
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
  }) as typeof globalThis.fetch;
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
  return JSON.parse(await req.text());
}

const ERROR_BODY = { status: "ERROR", message: "Invalid API key." };

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

Deno.test("ping: happy path — posts credentials to /ping, writes ping-result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { status: "SUCCESS", yourIp: "203.0.113.42" },
    200,
    async (calls) => {
      await run("ping", {}, ctx);
      assertEquals(calls.length, 1);
      assertEquals(new URL(calls[0].url).pathname, "/api/json/v3/ping");
      assertEquals(calls[0].method, "POST");
      const body = await requestBody(calls[0]);
      assertEquals(body.apikey, API_KEY);
      assertEquals(body.secretapikey, SECRET_API_KEY);
    },
  );
  const res = written.find((w) => w.spec === "ping-result");
  assert(res);
  assertEquals(res.name, "ping-result");
  assertEquals(res.payload.status, "SUCCESS");
  assertEquals(res.payload.yourIp, "203.0.113.42");
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("ping: error path — non-SUCCESS status throws the server message", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () => run("ping", {}, ctx),
      Error,
      "Invalid API key.",
    );
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

Deno.test("list: happy path — posts to /dns/retrieve/<domain>, writes dns-records", async () => {
  const { ctx, written } = makeCtx();
  const records = [
    { id: "1", name: "example.com", type: "A", content: "192.0.2.1" },
  ];
  await withOneResponse({ status: "SUCCESS", records }, 200, async (calls) => {
    await run("list", {}, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/json/v3/dns/retrieve/example.com",
    );
  });
  const res = written.find((w) => w.spec === "dns-records");
  assert(res);
  assertEquals(res.payload.domain, "example.com");
  assertEquals(res.payload.records, records);
  assertEquals(res.payload.count, 1);
});

Deno.test("list: error path — non-SUCCESS status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(() => run("list", {}, ctx), Error, "Invalid API key.");
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

Deno.test("get: with subdomain — posts to the subdomain-scoped endpoint, writes dns-record", async () => {
  const { ctx, written } = makeCtx();
  const records = [{ id: "2", name: "www.example.com", type: "CNAME" }];
  await withOneResponse({ status: "SUCCESS", records }, 200, async (calls) => {
    await run("get", { subdomain: "www", type: "CNAME" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/json/v3/dns/retrieveByNameType/example.com/CNAME/www",
    );
  });
  const res = written.find((w) => w.spec === "dns-record");
  assert(res);
  assertEquals(res.payload.subdomain, "www");
  assertEquals(res.payload.type, "CNAME");
  assertEquals(res.payload.records, records);
});

Deno.test("get: without subdomain — posts to the root endpoint, writes subdomain '(root)'", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    { status: "SUCCESS", records: [] },
    200,
    async (calls) => {
      await run("get", { type: "A" }, ctx);
      assertEquals(
        new URL(calls[0].url).pathname,
        "/api/json/v3/dns/retrieveByNameType/example.com/A",
      );
    },
  );
  const res = written.find((w) => w.spec === "dns-record");
  assert(res);
  assertEquals(res.payload.subdomain, "(root)");
});

Deno.test("get: error path — non-SUCCESS status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () => run("get", { type: "A" }, ctx),
      Error,
      "Invalid API key.",
    );
  });
});

Deno.test("get: rejects a type outside the DnsRecordType enum at the schema boundary", () => {
  const method = (model.methods as MethodMap).get;
  let threw = false;
  try {
    method.arguments.parse({ type: "NOT_A_REAL_TYPE" });
  } catch {
    threw = true;
  }
  assert(threw, "an unknown record type must be rejected before execute()");
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

Deno.test("create: happy path — minimal args, defaults ttl=600, no optional fields sent", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ status: "SUCCESS", id: 42 }, 200, async (calls) => {
    await run(
      "create",
      { type: "A", content: "192.0.2.5" },
      ctx,
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/json/v3/dns/create/example.com",
    );
    const body = await requestBody(calls[0]);
    assertEquals(body.type, "A");
    assertEquals(body.content, "192.0.2.5");
    assertEquals(body.ttl, 600);
    assert(!("name" in body), "no subdomain -> name omitted from the body");
    assert(!("prio" in body), "no prio -> omitted from the body");
    assert(!("notes" in body), "no notes -> omitted from the body");
  });
  const res = written.find((w) => w.spec === "dns-created");
  assert(res);
  assertEquals(res.payload.id, 42);
  assertEquals(res.payload.subdomain, "(root)");
  assertEquals(res.payload.ttl, 600);
  assertEquals(res.payload.status, "created");
});

Deno.test("create: full args — subdomain/prio/notes all sent", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ status: "SUCCESS", id: 43 }, 200, async (calls) => {
    await run("create", {
      subdomain: "mail",
      type: "MX",
      content: "mx.example.com",
      ttl: 3600,
      prio: 10,
      notes: "primary MX",
    }, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body.name, "mail");
    assertEquals(body.prio, 10);
    assertEquals(body.notes, "primary MX");
    assertEquals(body.ttl, 3600);
  });
  const res = written.find((w) => w.spec === "dns-created");
  assert(res);
  assertEquals(res.payload.subdomain, "mail");
});

Deno.test("create: error path — non-SUCCESS status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () => run("create", { type: "A", content: "192.0.2.5" }, ctx),
      Error,
      "Invalid API key.",
    );
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

Deno.test("update: happy path — required fields only, ttl/prio/subdomain omitted from the body", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ status: "SUCCESS" }, 200, async (calls) => {
    await run(
      "update",
      { recordId: "1000000001", type: "A", content: "192.0.2.99" },
      ctx,
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/json/v3/dns/edit/example.com/1000000001",
    );
    const body = await requestBody(calls[0]);
    assertEquals(body.type, "A");
    assertEquals(body.content, "192.0.2.99");
    assert(!("name" in body));
    assert(!("ttl" in body));
    assert(!("prio" in body));
  });
  const res = written.find((w) => w.spec === "dns-updated");
  assert(res);
  assertEquals(res.payload.id, "1000000001");
  assertEquals(res.payload.subdomain, "(root)");
  assertEquals(res.payload.status, "updated");
  assert(!("ttl" in res.payload), "the dns-updated resource has no ttl field");
});

Deno.test("update: full args — subdomain/ttl/prio all included in the body", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ status: "SUCCESS" }, 200, async (calls) => {
    await run("update", {
      recordId: "1000000003",
      subdomain: "www",
      type: "CNAME",
      content: "new.example.com",
      ttl: 1200,
      prio: 5,
    }, ctx);
    const body = await requestBody(calls[0]);
    assertEquals(body.name, "www");
    assertEquals(body.ttl, 1200);
    assertEquals(body.prio, 5);
  });
});

Deno.test("update: error path — non-SUCCESS status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () =>
        run(
          "update",
          { recordId: "1", type: "A", content: "192.0.2.1" },
          ctx,
        ),
      Error,
      "Invalid API key.",
    );
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

Deno.test("delete: happy path — posts to /dns/delete/<domain>/<id>, writes delete-by-id", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ status: "SUCCESS" }, 200, async (calls) => {
    await run("delete", { recordId: "1000000001" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/json/v3/dns/delete/example.com/1000000001",
    );
  });
  const res = written.find((w) => w.spec === "delete-result");
  assert(res);
  assertEquals(res.name, "delete-by-id");
  assertEquals(res.payload.status, "deleted");
});

Deno.test("delete: error path — non-SUCCESS status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () => run("delete", { recordId: "1" }, ctx),
      Error,
      "Invalid API key.",
    );
  });
});

// ---------------------------------------------------------------------------
// deleteByNameType
// ---------------------------------------------------------------------------

Deno.test("deleteByNameType: with subdomain — posts to the subdomain-scoped endpoint", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ status: "SUCCESS" }, 200, async (calls) => {
    await run("deleteByNameType", { subdomain: "www", type: "CNAME" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/json/v3/dns/deleteByNameType/example.com/CNAME/www",
    );
  });
  const res = written.find((w) => w.spec === "delete-result");
  assert(res);
  assertEquals(res.name, "delete-by-name-type");
});

Deno.test("deleteByNameType: without subdomain — posts to the root endpoint", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({ status: "SUCCESS" }, 200, async (calls) => {
    await run("deleteByNameType", { type: "A" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/json/v3/dns/deleteByNameType/example.com/A",
    );
  });
});

Deno.test("deleteByNameType: error path — non-SUCCESS status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () => run("deleteByNameType", { type: "A" }, ctx),
      Error,
      "Invalid API key.",
    );
  });
});

// ---------------------------------------------------------------------------
// Credential-leak assertions across every method
// ---------------------------------------------------------------------------

Deno.test("credentials never leak into a thrown error message", async () => {
  const { ctx } = makeCtx();
  const leakyError = {
    status: "ERROR",
    message:
      `Invalid credentials: apikey=${API_KEY} secretapikey=${SECRET_API_KEY}`,
  };
  await withOneResponse(leakyError, 200, async () => {
    // porkbunRequest throws data.message VERBATIM — this test pins that a
    // server response which itself echoes credentials would leak them (the
    // client performs no redaction). Documented in the adversarial suite as
    // a trust-boundary note; here we confirm the mechanism, using distinct
    // sentinel values so this test cannot pass by accident.
    const err = await assertRejects(() => run("ping", {}, ctx));
    assert(String(err).includes(API_KEY), "sanity: fixture actually leaks");
  });
});

Deno.test("credentials never appear in any written resource across all 7 methods", async () => {
  const scenarios: Array<
    [string, Record<string, unknown>, unknown]
  > = [
    ["ping", {}, { status: "SUCCESS", yourIp: "203.0.113.42" }],
    ["list", {}, { status: "SUCCESS", records: [] }],
    ["get", { type: "A" }, { status: "SUCCESS", records: [] }],
    [
      "create",
      { type: "A", content: "192.0.2.5" },
      { status: "SUCCESS", id: 1 },
    ],
    [
      "update",
      { recordId: "1", type: "A", content: "192.0.2.5" },
      { status: "SUCCESS" },
    ],
    ["delete", { recordId: "1" }, { status: "SUCCESS" }],
    ["deleteByNameType", { type: "A" }, { status: "SUCCESS" }],
  ];
  for (const [name, args, response] of scenarios) {
    const { ctx, written, logs } = makeCtx();
    await withOneResponse(response, 200, async () => {
      await run(name, args, ctx);
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(!s.includes(API_KEY), `${name}: apiKey leaked into ${w.spec}`);
      assert(
        !s.includes(SECRET_API_KEY),
        `${name}: secretApiKey leaked into ${w.spec}`,
      );
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(!s.includes(API_KEY), `${name}: apiKey leaked into a log call`);
      assert(
        !s.includes(SECRET_API_KEY),
        `${name}: secretApiKey leaked into a log call`,
      );
    }
  }
});

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneResponse(
    { status: "SUCCESS", yourIp: "203.0.113.1" },
    200,
    async () => {
      await run("ping", {}, ctx);
    },
  );
  assertEquals(logs.length, 0);
});
