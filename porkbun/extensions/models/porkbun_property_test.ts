/**
 * Property-based tests (fast-check) for @magistr/porkbun.
 *
 * porkbun.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch and reading
 * back the captured POST body / written resource, per the approved plan.
 *
 * Properties:
 *  (a) record-shape round-trip — `list`'s written records preserve every
 *      generated record, in order, with count == records.length; absent and
 *      empty both yield [] with count 0.
 *  (b) name normalization — subdomain "" <-> the root endpoint + "(root)"
 *      written value, consistent across methods.
 *  (c) request-builder injectivity, stated MODULO the documented
 *      normalization (falsy subdomain/notes -> omitted, ttl 0 -> 600) — the
 *      arbitrary is restricted to the canonical/non-collapsing input subset,
 *      per the round-1 review finding that naive injectivity is FALSE over
 *      the raw input space.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./porkbun.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

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

/** Run `create` with the given args against a stubbed fetch and return the
 * exact parsed POST body sent to Porkbun. */
async function createBodyFor(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { ctx } = makeCtx();
  let body: Record<string, unknown> = {};
  await withFetchStub(
    [() => json({ status: "SUCCESS", id: 1 })],
    async (calls) => {
      await run("create", args, ctx);
      body = JSON.parse(await calls[0].text());
    },
  );
  return body;
}

// ---------------------------------------------------------------------------
// (a) record-shape round-trip
// ---------------------------------------------------------------------------

const arbRecord = fc.record({
  id: fc.stringMatching(/^[0-9]{1,10}$/),
  name: fc.stringMatching(/^[a-z0-9.-]{1,30}$/),
  type: fc.constantFrom("A", "AAAA", "CNAME", "MX", "TXT"),
  content: fc.stringMatching(/^[a-z0-9.:-]{1,30}$/),
  ttl: fc.stringMatching(/^[0-9]{1,6}$/),
  prio: fc.stringMatching(/^[0-9]{1,3}$/),
  notes: fc.stringMatching(/^[a-z0-9 ]{0,20}$/),
});

Deno.test("property: list preserves every generated record, in order, with count == length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbRecord, { minLength: 1, maxLength: 12 }),
      async (records) => {
        const { ctx, written } = makeCtx();
        await withFetchStub(
          [() => json({ status: "SUCCESS", records })],
          async () => {
            await run("list", {}, ctx);
          },
        );
        const res = written.find((w) => w.spec === "dns-records")!;
        return (
          JSON.stringify(res.payload.records) === JSON.stringify(records) &&
          res.payload.count === records.length
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: list — absent and empty records both yield [] with count 0", async () => {
  for (
    const response of [{ status: "SUCCESS" }, {
      status: "SUCCESS",
      records: [],
    }]
  ) {
    const { ctx, written } = makeCtx();
    await withFetchStub([() => json(response)], async () => {
      await run("list", {}, ctx);
    });
    const res = written.find((w) => w.spec === "dns-records")!;
    assertEquals(res.payload.records, []);
    assertEquals(res.payload.count, 0);
  }
});

// ---------------------------------------------------------------------------
// (b) name normalization
// ---------------------------------------------------------------------------

Deno.test("property: get's written subdomain == (subdomain || '(root)') for any string", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 40 }), async (subdomain) => {
      const { ctx, written } = makeCtx();
      await withFetchStub(
        [() => json({ status: "SUCCESS", records: [] })],
        async () => {
          await run("get", { subdomain, type: "A" }, ctx);
        },
      );
      const res = written.find((w) => w.spec === "dns-record")!;
      return res.payload.subdomain === (subdomain || "(root)");
    }),
    FC_RUNS,
  );
});

Deno.test("property: get's endpoint path includes the subdomain segment iff it is non-empty (safe-charset subdomains)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.stringMatching(/^[a-z0-9-]{0,20}$/),
      async (subdomain) => {
        const { ctx } = makeCtx();
        let pathname = "";
        await withFetchStub(
          [() => json({ status: "SUCCESS", records: [] })],
          async (calls) => {
            await run("get", { subdomain, type: "A" }, ctx);
            pathname = new URL(calls[0].url).pathname;
          },
        );
        const base = "/api/json/v3/dns/retrieveByNameType/example.com/A";
        return subdomain
          ? pathname === `${base}/${subdomain}`
          : pathname === base;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) request-builder injectivity, MODULO the documented normalization
// ---------------------------------------------------------------------------

// Restricted to the CANONICAL subset: subdomain/notes either undefined or
// non-empty (excludes the "" vs undefined collapse), ttl either undefined or
// a positive nonzero integer (excludes the 0 -> 600 collapse). Within this
// subset, the request builder is genuinely injective.
const arbCanonicalCreateInput = fc.record({
  subdomain: fc.option(fc.stringMatching(/^[a-z0-9-]{1,10}$/), {
    nil: undefined,
  }),
  type: fc.constantFrom("A", "AAAA", "CNAME", "MX", "TXT"),
  content: fc.stringMatching(/^[a-z0-9.:-]{1,20}$/),
  ttl: fc.option(fc.integer({ min: 1, max: 999999 }), { nil: undefined }),
  prio: fc.option(fc.integer({ min: 0, max: 65535 }), { nil: undefined }),
  notes: fc.option(fc.stringMatching(/^[a-z0-9 ]{1,20}$/), {
    nil: undefined,
  }),
});

function canonicalSignature(input: Record<string, unknown>): string {
  return JSON.stringify([
    input.subdomain,
    input.type,
    input.content,
    input.ttl,
    input.prio,
    input.notes,
  ]);
}

Deno.test("property: create's request body is deterministic — same canonical input -> same body", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalCreateInput, async (input) => {
      const a = await createBodyFor(input);
      const b = await createBodyFor(input);
      return JSON.stringify(a) === JSON.stringify(b);
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: create's request body is INJECTIVE over the canonical (non-collapsing) input subset", async () => {
  // Two canonical inputs that differ (by their full tuple signature) must
  // produce different POST bodies; two identical inputs must produce the
  // same body. This is the round-1 MEDIUM fix: injectivity stated over the
  // restricted, non-collapsing subset rather than the raw input space.
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalCreateInput,
      arbCanonicalCreateInput,
      async (a, b) => {
        const sigA = canonicalSignature(a);
        const sigB = canonicalSignature(b);
        const bodyA = JSON.stringify(await createBodyFor(a));
        const bodyB = JSON.stringify(await createBodyFor(b));
        return sigA === sigB ? bodyA === bodyB : bodyA !== bodyB;
      },
    ),
    { numRuns: NIGHT(300) },
  );
});

// --- Explicit named collapse examples (round-2 review finding) ------------
// The injectivity property above deliberately EXCLUDES these from its
// canonical domain; these tests pin the collapses themselves so the
// normalization behavior cannot silently change without a red test.

Deno.test("collapse: create subdomain '' and undefined produce the IDENTICAL body (both omit `name`)", async () => {
  const withEmpty = await createBodyFor({
    type: "A",
    content: "192.0.2.1",
    subdomain: "",
  });
  const withUndefined = await createBodyFor({
    type: "A",
    content: "192.0.2.1",
  });
  assertEquals(withEmpty, withUndefined);
});

Deno.test("collapse: create notes '' and undefined produce the IDENTICAL body (both omit `notes`)", async () => {
  const withEmpty = await createBodyFor({
    type: "A",
    content: "192.0.2.1",
    notes: "",
  });
  const withUndefined = await createBodyFor({
    type: "A",
    content: "192.0.2.1",
  });
  assertEquals(withEmpty, withUndefined);
});

Deno.test("collapse: create ttl=0 and ttl=600 produce the IDENTICAL body (both send ttl:600)", async () => {
  const withZero = await createBodyFor({
    type: "A",
    content: "192.0.2.1",
    ttl: 0,
  });
  const withSix00 = await createBodyFor({
    type: "A",
    content: "192.0.2.1",
    ttl: 600,
  });
  assertEquals(withZero, withSix00);
});
