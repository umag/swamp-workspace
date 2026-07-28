/**
 * Coverage suite: sweeps every guard/branch in porkbun.ts that the methods
 * and adversarial suites don't already exercise on both sides, so deleting
 * any one of these guards turns a test red (STANDARD.md's coverage role —
 * a behavioral regression guard, not a numeric percentage).
 *
 * porkbun.ts is UNMODIFIED; every test PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { model } from "./porkbun.ts";

const GLOBAL_ARGS = {
  domain: "example.com",
  apiKey: "pk1_stub",
  secretApiKey: "sk1_stub",
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

type Route = (req: Request) => Response | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = r(req);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unrouted ${req.url}`));
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

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
}

// --- Guard: `data.records || []` (list) — both sides -----------------------

Deno.test("list: records ABSENT from the response -> [] and count 0", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ status: "SUCCESS" })], async () => {
    await run("list", {}, ctx);
  });
  const res = written.find((w) => w.spec === "dns-records")!;
  assertEquals(res.payload.records, []);
  assertEquals(res.payload.count, 0);
});

Deno.test("list: records PRESENT and non-empty -> passed through with matching count", async () => {
  const { ctx, written } = makeCtx();
  const records = [{ id: "1" }, { id: "2" }];
  await withFetchStub(
    [() => json({ status: "SUCCESS", records })],
    async () => {
      await run("list", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "dns-records")!;
  assertEquals(res.payload.records, records);
  assertEquals(res.payload.count, 2);
});

// --- Guard: `data.records || []` (get) — both sides -------------------------

Deno.test("get: records ABSENT from the response -> []", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ status: "SUCCESS" })], async () => {
    await run("get", { type: "A" }, ctx);
  });
  const res = written.find((w) => w.spec === "dns-record")!;
  assertEquals(res.payload.records, []);
});

Deno.test("get: records PRESENT -> passed through", async () => {
  const { ctx, written } = makeCtx();
  const records = [{ id: "1" }];
  await withFetchStub(
    [() => json({ status: "SUCCESS", records })],
    async () => {
      await run("get", { type: "A" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "dns-record")!;
  assertEquals(res.payload.records, records);
});

// --- Guard: subdomain "" (empty string, falsy) collapses same as undefined -

Deno.test("get: subdomain='' (empty string) takes the root-endpoint branch, same as omitted", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", records: [] })],
    async (calls) => {
      await run("get", { subdomain: "", type: "A" }, ctx);
      assertEquals(
        new URL(calls[0].url).pathname,
        "/api/json/v3/dns/retrieveByNameType/example.com/A",
      );
    },
  );
  const res = written.find((w) => w.spec === "dns-record")!;
  assertEquals(res.payload.subdomain, "(root)");
});

Deno.test("deleteByNameType: subdomain='' takes the root-endpoint branch, same as omitted", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ status: "SUCCESS" })], async (calls) => {
    await run("deleteByNameType", { subdomain: "", type: "A" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/json/v3/dns/deleteByNameType/example.com/A",
    );
  });
});

Deno.test("create: subdomain='' omits `name` from the body and writes '(root)'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async (calls) => {
      await run(
        "create",
        { subdomain: "", type: "A", content: "192.0.2.1" },
        ctx,
      );
      const body = await requestBody(calls[0]);
      assert(!("name" in body));
    },
  );
  const res = written.find((w) => w.spec === "dns-created")!;
  assertEquals(res.payload.subdomain, "(root)");
});

Deno.test("update: subdomain='' omits `name` from the body and writes '(root)'", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ status: "SUCCESS" })], async (calls) => {
    await run(
      "update",
      { recordId: "1", subdomain: "", type: "A", content: "192.0.2.1" },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assert(!("name" in body));
  });
  const res = written.find((w) => w.spec === "dns-updated")!;
  assertEquals(res.payload.subdomain, "(root)");
});

// --- Guard: create's `if (notes)` truthy check (not `!== undefined`) -------

Deno.test("create: notes='' (empty, falsy) is omitted from the body — same guard shape as ttl", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async (calls) => {
      await run(
        "create",
        { type: "A", content: "192.0.2.1", notes: "" },
        ctx,
      );
      const body = await requestBody(calls[0]);
      assert(
        !("notes" in body),
        "empty-string notes must be omitted (falsy check)",
      );
    },
  );
});

Deno.test("create: a non-empty notes value IS sent", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async (calls) => {
      await run(
        "create",
        { type: "A", content: "192.0.2.1", notes: "keep me" },
        ctx,
      );
      const body = await requestBody(calls[0]);
      assertEquals(body.notes, "keep me");
    },
  );
});

// --- Guard: create's `prio !== undefined` (existence, not truthy) ----------

Deno.test("create: prio omitted (undefined) -> absent from the body", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async (calls) => {
      await run("create", { type: "A", content: "192.0.2.1" }, ctx);
      const body = await requestBody(calls[0]);
      assert(!("prio" in body));
    },
  );
});

// --- Guard: update's `ttl !== undefined` / `prio !== undefined` -----------

Deno.test("update: ttl omitted (undefined) -> absent from the body (no default injected)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ status: "SUCCESS" })], async (calls) => {
    await run(
      "update",
      { recordId: "1", type: "A", content: "192.0.2.1" },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assert(!("ttl" in body));
  });
});

Deno.test("update: prio omitted (undefined) -> absent from the body", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ status: "SUCCESS" })], async (calls) => {
    await run(
      "update",
      { recordId: "1", type: "A", content: "192.0.2.1" },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assert(!("prio" in body));
  });
});

// --- Guard: `data.message || fallback` — both sides, incl. empty string ---

Deno.test("error mapping: message PRESENT -> used verbatim", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "ERROR", message: "quota exceeded" })],
    async () => {
      let threw: unknown;
      try {
        await run("ping", {}, ctx);
      } catch (err) {
        threw = err;
      }
      assertEquals((threw as Error).message, "quota exceeded");
    },
  );
});

Deno.test("error mapping: message ABSENT -> generic 'Porkbun API error: <status>' fallback", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ status: "ERROR" })], async () => {
    let threw: unknown;
    try {
      await run("ping", {}, ctx);
    } catch (err) {
      threw = err;
    }
    assertEquals((threw as Error).message, "Porkbun API error: ERROR");
  });
});

Deno.test("error mapping: message is an empty string (falsy) -> ALSO falls back to the generic message", async () => {
  // `data.message || fallback` treats "" as falsy — an explicit-but-empty
  // message string is silently discarded in favor of the generic fallback.
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "ERROR", message: "" })],
    async () => {
      let threw: unknown;
      try {
        await run("ping", {}, ctx);
      } catch (err) {
        threw = err;
      }
      assertEquals((threw as Error).message, "Porkbun API error: ERROR");
    },
  );
});

// --- Guard: status === "SUCCESS" does not throw -----------------------------

Deno.test("status exactly 'SUCCESS' does not throw; any other value does", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", yourIp: "203.0.113.1" })],
    async () => {
      await run("ping", {}, ctx); // must not throw
    },
  );
  for (const badStatus of ["success", "Success", "PENDING", ""]) {
    await withFetchStub([() => json({ status: badStatus })], async () => {
      let threw = false;
      try {
        await run("ping", {}, ctx);
      } catch {
        threw = true;
      }
      assert(threw, `status ${JSON.stringify(badStatus)} must throw`);
    });
  }
});

// --- Guard: the full DnsRecordType enum is intact ---------------------------

// --- Security-review finding: credential fields are NOT marked sensitive --

Deno.test("pin: apiKey/secretApiKey are NOT marked `.meta({ sensitive: true })` today — documented security-hardening gap", () => {
  // Unlike stripe-mpp's secretKey/serverSecret, porkbun.ts's globalArguments
  // schema never calls `.meta({ sensitive: true })` on apiKey/secretApiKey.
  // This is a real gap surfaced during the test-backfill security review,
  // but porkbun.ts is deliberately UNMODIFIED by this change (no manifest
  // version bump; the plan is test-authoring only) — fixing it belongs to a
  // follow-up issue. This test pins the CURRENT (regrettable) state so a
  // future fix flips it from failing to passing, rather than silently
  // slipping by unnoticed.
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  for (const field of ["apiKey", "secretApiKey"]) {
    const meta = z.globalRegistry.get(shape[field]) as
      | { sensitive?: boolean }
      | undefined;
    assertEquals(
      meta?.sensitive,
      undefined,
      `${field} is not yet marked sensitive — if this starts failing, ` +
        `porkbun.ts added the annotation; update this pin to assert true`,
    );
  }
});

Deno.test("every documented DnsRecordType value is still accepted by the schema", () => {
  const method = (model.methods as MethodMap).get;
  const types = [
    "A",
    "AAAA",
    "MX",
    "CNAME",
    "ALIAS",
    "TXT",
    "NS",
    "SRV",
    "TLSA",
    "CAA",
    "HTTPS",
    "SVCB",
    "SSHFP",
  ];
  for (const type of types) {
    const parsed = method.arguments.parse({ type }) as { type: string };
    assertEquals(parsed.type, type);
  }
});
