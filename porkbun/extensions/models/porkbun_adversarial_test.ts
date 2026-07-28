/**
 * Adversarial suite: hostile/boundary inputs, tampered/malformed responses,
 * TTL/type/prio edge cases, create/delete idempotency semantics, and a
 * mechanical fixtures-secret-scan over porkbun/fixtures/*.json.
 *
 * porkbun.ts is UNMODIFIED — every test here PINS current behavior (including
 * behavior that is arguably risky) rather than proposing a fix. Where a test
 * documents a real gap, it is labeled "pin" and says so explicitly.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./porkbun.ts";
import ping from "../../fixtures/ping.json" with { type: "json" };
import retrieve from "../../fixtures/retrieve.json" with { type: "json" };
import retrieveByNameType from "../../fixtures/retrieveByNameType.json" with {
  type: "json",
};
import create from "../../fixtures/create.json" with { type: "json" };
import editFixture from "../../fixtures/edit.json" with { type: "json" };
import deleteFixture from "../../fixtures/delete.json" with { type: "json" };
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Hostile / malformed responses
// ---------------------------------------------------------------------------

Deno.test("pin: a non-JSON (HTML 502) response body surfaces as an unmapped SyntaxError", async () => {
  // porkbunRequest calls `await response.json()` unconditionally, without
  // ever checking `response.ok` or `response.status`. A reverse-proxy 502
  // (or any non-JSON body) throws a raw SyntaxError from JSON parsing — it
  // is NOT mapped to a Porkbun-domain error. Documented gap, not fixed here
  // (porkbun.ts is unmodified by this change).
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      })],
    async () => {
      await assertRejects(() => run("ping", {}, ctx), SyntaxError);
    },
  );
});

Deno.test("pin: HTTP status is IGNORED — a 502 carrying a valid JSON error envelope is handled identically to a 200", async () => {
  // porkbunRequest never inspects response.status; only the JSON body's
  // `status` field decides success/failure. This test proves that a 502
  // with a well-formed {status:"ERROR",...} body is mapped the SAME way as
  // a 200 with that body — the HTTP status code carries no information to
  // this client at all.
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "ERROR", message: "server hiccup" }, 502)],
    async () => {
      await assertRejects(() => run("ping", {}, ctx), Error, "server hiccup");
    },
  );
});

Deno.test("pin: a response missing the status field entirely produces the generic fallback message", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({})], async () => {
    await assertRejects(
      () => run("ping", {}, ctx),
      Error,
      "Porkbun API error: undefined",
    );
  });
});

Deno.test("a tampered/hostile record array (script-tag content, unexpected extra keys) passes through unfiltered", async () => {
  // porkbun.ts performs no sanitization or shape validation on records; it
  // is a thin proxy. This documents that fact rather than treating it as a
  // vulnerability — the record content is never interpreted/rendered by
  // this model, only stored in a resource.
  const { ctx, written } = makeCtx();
  const hostileRecords = [
    {
      id: "999",
      name: "example.com",
      type: "TXT",
      content: "<script>alert(1)</script>",
      ttl: "600",
      prio: "0",
      notes: "'; DROP TABLE records; --",
      unexpectedExtraField: { nested: true },
    },
  ];
  await withFetchStub(
    [() => json({ status: "SUCCESS", records: hostileRecords })],
    async () => {
      await run("list", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "dns-records")!;
  assertEquals(res.payload.records, hostileRecords);
});

Deno.test("pin: a non-array truthy `records` (hostile/malformed response) type-confuses `list`'s derived count", async () => {
  // `records: data.records || []` only guards the FALSY case (undefined/null/
  // ""/0). A hostile or buggy server that sends a non-array truthy `records`
  // (a string, or a plain object) sails through unchanged, and `count:
  // (data.records || []).length` then reads `.length` off whatever that
  // value is — a string yields its character count; a plain object yields
  // `undefined` (no `.length` property). Documented type-confusion gap, not
  // fixed here (porkbun.ts unmodified).
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", records: "not-an-array" })],
    async () => {
      await run("list", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "dns-records")!;
  assertEquals(res.payload.records, "not-an-array");
  assertEquals(
    res.payload.count,
    "not-an-array".length,
    "count silently becomes the STRING LENGTH, not a record count",
  );
});

Deno.test("pin: a plain-object truthy `records` makes `list`'s count `undefined` (no `.length` on an object)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", records: { unexpected: "shape" } })],
    async () => {
      await run("list", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "dns-records")!;
  assertEquals(res.payload.records, { unexpected: "shape" });
  assertEquals(res.payload.count, undefined);
});

// ---------------------------------------------------------------------------
// Injection via URL path interpolation (subdomain is NOT encoded)
// ---------------------------------------------------------------------------

Deno.test("pin: a subdomain containing '/' is interpolated RAW into the URL path (no encoding)", async () => {
  // get()'s endpoint template interpolates `subdomain` directly into the URL
  // string with no encodeURIComponent. A subdomain of "a/b" therefore adds
  // an EXTRA path segment rather than being treated as one opaque label.
  // Pinned as a documented gap: callers must not pass attacker-controlled
  // subdomain values without their own validation.
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", records: [] })],
    async (calls) => {
      await run("get", { subdomain: "a/b", type: "A" }, ctx);
      assertEquals(
        new URL(calls[0].url).pathname,
        "/api/json/v3/dns/retrieveByNameType/example.com/A/a/b",
      );
    },
  );
});

Deno.test("record content/notes with quote and injection characters are JSON-escaped safely in the request body", async () => {
  // Unlike the URL-path case above, content/notes travel through
  // JSON.stringify — structurally safe from injection regardless of
  // content, since JSON encoding escapes quotes/backslashes.
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async (calls) => {
      await run("create", {
        type: "TXT",
        content: '"; DROP TABLE records; --',
        notes: 'line1\nline2\\backslash"quote',
      }, ctx);
      const body = await requestBody(calls[0]);
      assertEquals(body.content, '"; DROP TABLE records; --');
      assertEquals(body.notes, 'line1\nline2\\backslash"quote');
    },
  );
});

// ---------------------------------------------------------------------------
// TTL / prio boundary collapses (named, per round-2 review finding)
// ---------------------------------------------------------------------------

Deno.test("pin: create ttl=0 is coerced to 600 (falsy `ttl || 600`, not `ttl ?? 600`)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async (calls) => {
      await run("create", { type: "A", content: "192.0.2.1", ttl: 0 }, ctx);
      const body = await requestBody(calls[0]);
      assertEquals(
        body.ttl,
        600,
        "explicit ttl:0 is silently overridden to 600",
      );
    },
  );
  const res = written.find((w) => w.spec === "dns-created")!;
  assertEquals(res.payload.ttl, 600);
});

Deno.test("pin: update ttl=0 is PRESERVED as 0 — asymmetric with create's coercion", async () => {
  // update()'s guard is `if (ttl !== undefined) body.ttl = ttl` (existence
  // check), not `ttl || default` (truthiness check) — so 0 survives here,
  // unlike create(). This asymmetry is real in porkbun.ts today; pinned so
  // a "harmonizing" refactor cannot silently change either behavior.
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ status: "SUCCESS" })], async (calls) => {
    await run(
      "update",
      { recordId: "1", type: "A", content: "192.0.2.1", ttl: 0 },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assertEquals(body.ttl, 0, "update preserves an explicit ttl:0");
  });
});

Deno.test("prio=0 is preserved (NOT falsy-collapsed) in both create and update — contrast with ttl", async () => {
  // Both create and update guard prio with `prio !== undefined`, so 0 (a
  // legitimate MX/SRV priority) survives in both methods — unlike create's
  // ttl handling above.
  const { ctx } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async (calls) => {
      await run(
        "create",
        { type: "MX", content: "mail.example.com", prio: 0 },
        ctx,
      );
      const body = await requestBody(calls[0]);
      assertEquals(body.prio, 0);
    },
  );
  await withFetchStub([() => json({ status: "SUCCESS" })], async (calls) => {
    await run(
      "update",
      { recordId: "1", type: "MX", content: "mail.example.com", prio: 0 },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assertEquals(body.prio, 0);
  });
});

// ---------------------------------------------------------------------------
// create / delete idempotency semantics — Porkbun has no idempotency-key API
// ---------------------------------------------------------------------------

Deno.test("pin: create is NOT idempotent — repeating identical args sends two POSTs and would duplicate the record", async () => {
  // Porkbun's create endpoint has no client-supplied idempotency-key
  // mechanism (unlike e.g. Stripe). porkbun.ts adds none either. Repeating
  // the exact same create call therefore issues two independent POSTs; a
  // real Porkbun API would create two duplicate records. This is NOT a bug
  // to fix here (porkbun.ts unmodified) — it documents the absence of any
  // dedup layer so a caller building on top of this model knows to add its
  // own guard if needed.
  const { ctx } = makeCtx();
  let creates = 0;
  await withFetchStub(
    [(req) => {
      if (new URL(req.url).pathname.includes("/dns/create/")) {
        creates++;
        return json({ status: "SUCCESS", id: 1000 + creates });
      }
      return undefined;
    }],
    async (calls) => {
      await run("create", { type: "A", content: "192.0.2.1" }, ctx);
      await run("create", { type: "A", content: "192.0.2.1" }, ctx);
      assertEquals(calls.length, 2, "no dedup — two independent POSTs");
    },
  );
  assertEquals(creates, 2);
});

Deno.test("pin: create's writeResource uses the SAME fixed resource name on every call — no per-record audit trail", async () => {
  // context.writeResource("dns-created", "dns-created", ...) — the NAME is
  // a literal constant, never templated with the record id. In the real
  // swamp runtime (writeResource is keyed on instance name), a second
  // create call would overwrite the first call's persisted resource. Our
  // fake context here just appends to an array, so we assert on the NAMES
  // passed to writeResource, which is the actual clobbering mechanism.
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async () => {
      await run("create", { type: "A", content: "192.0.2.1" }, ctx);
      await run("create", { type: "AAAA", content: "2001:db8::1" }, ctx);
    },
  );
  const names = written.filter((w) => w.spec === "dns-created").map((w) =>
    w.name
  );
  assertEquals(
    names,
    ["dns-created", "dns-created"],
    "both calls write the identical resource name — the second clobbers the first in a real instance",
  );
});

Deno.test("pin: delete-by-id has no existence check — deleting the same id twice makes two identical requests", async () => {
  // porkbun.ts issues the delete POST unconditionally; whatever the server
  // returns on the second call (SUCCESS again, or an ERROR for "already
  // gone") is what surfaces. There is no client-side "already deleted"
  // short-circuit — deletion is only as idempotent as the live Porkbun API
  // happens to be.
  const { ctx } = makeCtx();
  let calls = 0;
  await withFetchStub(
    [() => {
      calls++;
      return json({ status: "SUCCESS" });
    }],
    async () => {
      await run("delete", { recordId: "1000000001" }, ctx);
      await run("delete", { recordId: "1000000001" }, ctx);
    },
  );
  assertEquals(
    calls,
    2,
    "no idempotency short-circuit — the client always calls through",
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "porkbun API key prefix", re: /pk1_[a-z0-9]{20,}/i },
  { name: "porkbun secret API key prefix", re: /sk1_[a-z0-9]{20,}/i },
  { name: "vault key name API_KEY", re: /\bAPI_KEY\b/ },
  { name: "vault key name SECRET_API_KEY", re: /\bSECRET_API_KEY\b/ },
  // Generic high-entropy blob: a value that is ENTIRELY 32+ alnum/base64url
  // characters with no separators — none of our authored fixture values
  // (domains, IPs, ttl/prio digit-strings, short notes) match this shape.
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9+/_=-]{32,}$/ },
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
  "ping.json": ping,
  "retrieve.json": retrieve,
  "retrieveByNameType.json": retrieveByNameType,
  "create.json": create,
  "edit.json": editFixture,
  "delete.json": deleteFixture,
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
  const poisoned = { key: "pk1_" + "a".repeat(32) };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real pk1_ shape",
  );
});
