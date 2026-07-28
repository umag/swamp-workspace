/**
 * Contract-fixture suite: pins the CONCRETE Porkbun API v3 wire shape from
 * porkbun/fixtures/*.json directly — independent of porkbun.ts's resource
 * schemas, which use `z.any()` for records/id. A suite that only asserted
 * "the written resource validates against the model's schema" would be
 * toothless (z.any() accepts anything); this suite hardcodes the expected
 * keyset + value types from the Porkbun docs so a real wire-format drift
 * turns a test red (see STANDARD.md's contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see fixtures/PROVENANCE.md.
 * Every test here is offline: fixtures are fed through a stubbed fetch, no
 * network call is made.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
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
  apiKey: "pk1_fixture",
  secretApiKey: "sk1_fixture",
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

function withFixture(body: unknown, fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// ping.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: ping.json — exact keyset {status, yourIp}, both strings", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(ping, () => run("ping", {}, ctx));
  const res = written.find((w) => w.spec === "ping-result")!;
  assertEquals(res.payload.status, ping.status);
  assertEquals(res.payload.yourIp, ping.yourIp);
  assertEquals(typeof res.payload.status, "string");
  assertEquals(typeof res.payload.yourIp, "string");
});

// ---------------------------------------------------------------------------
// retrieve.json contract — the full-zone record shape
// ---------------------------------------------------------------------------

const EXPECTED_RECORD_KEYS = [
  "content",
  "id",
  "name",
  "notes",
  "prio",
  "ttl",
  "type",
].sort();

Deno.test("contract: retrieve.json — every record has exactly the documented keyset", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(retrieve, () => run("list", {}, ctx));
  const res = written.find((w) => w.spec === "dns-records")!;
  const records = res.payload.records as Array<Record<string, unknown>>;
  assertEquals(records.length, retrieve.records.length);
  assertEquals(res.payload.count, retrieve.records.length);
  for (const rec of records) {
    assertEquals(Object.keys(rec).sort(), EXPECTED_RECORD_KEYS);
  }
});

Deno.test("contract: retrieve.json — id/ttl/prio are wire STRINGS (not coerced to number)", async () => {
  // Pin: Porkbun's retrieve/retrieveByNameType endpoints serialize id, ttl,
  // and prio as strings. porkbun.ts's z.any() schema does not convert them —
  // the resource carries whatever type the wire sent. A future porkbun.ts
  // change that "helpfully" Number()-coerces these must fail this test.
  const { ctx, written } = makeCtx();
  await withFixture(retrieve, () => run("list", {}, ctx));
  const records = written.find((w) => w.spec === "dns-records")!
    .payload.records as Array<Record<string, unknown>>;
  for (const rec of records) {
    assertEquals(typeof rec.id, "string", `id ${rec.id} must stay a string`);
    assertEquals(typeof rec.ttl, "string", `ttl ${rec.ttl} must stay a string`);
    assertEquals(
      typeof rec.prio,
      "string",
      `prio ${rec.prio} must stay a string`,
    );
    assertEquals(typeof rec.name, "string");
    assertEquals(typeof rec.type, "string");
    assertEquals(typeof rec.content, "string");
    assertEquals(typeof rec.notes, "string");
  }
});

// ---------------------------------------------------------------------------
// retrieveByNameType.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: retrieveByNameType.json — scoped record keeps the documented keyset", async () => {
  const { ctx, written } = makeCtx();
  await withFixture(
    retrieveByNameType,
    () => run("get", { subdomain: "www", type: "CNAME" }, ctx),
  );
  const res = written.find((w) => w.spec === "dns-record")!;
  const records = res.payload.records as Array<Record<string, unknown>>;
  assertEquals(records.length, retrieveByNameType.records.length);
  for (const rec of records) {
    assertEquals(Object.keys(rec).sort(), EXPECTED_RECORD_KEYS);
  }
});

// ---------------------------------------------------------------------------
// create.json contract — the documented id-type ASYMMETRY vs retrieve
// ---------------------------------------------------------------------------

Deno.test("contract: create.json — id is a wire NUMBER (asymmetric with retrieve's string id)", async () => {
  // Pin: porkbun.ts declares dns-created.id as z.any(), which is exactly
  // right — Porkbun's create endpoint returns a numeric id while retrieve
  // returns record ids as strings. This test documents both types are real
  // and expected, not a bug to "fix" by tightening the schema to one type.
  const { ctx, written } = makeCtx();
  await withFixture(
    create,
    () => run("create", { type: "A", content: "192.0.2.5" }, ctx),
  );
  const res = written.find((w) => w.spec === "dns-created")!;
  assertEquals(res.payload.id, create.id);
  assertEquals(typeof res.payload.id, "number");
});

// ---------------------------------------------------------------------------
// edit.json / delete.json contract — bare {status} envelope, no id echoed
// ---------------------------------------------------------------------------

Deno.test("contract: edit.json — bare {status} envelope; recordId comes from args, not the response", async () => {
  assertEquals(Object.keys(editFixture), ["status"]);
  const { ctx, written } = makeCtx();
  await withFixture(
    editFixture,
    () =>
      run(
        "update",
        { recordId: "1000000001", type: "A", content: "192.0.2.9" },
        ctx,
      ),
  );
  const res = written.find((w) => w.spec === "dns-updated")!;
  assertEquals(res.payload.id, "1000000001");
});

Deno.test("contract: delete.json — bare {status} envelope", async () => {
  assertEquals(Object.keys(deleteFixture), ["status"]);
  const { ctx, written } = makeCtx();
  await withFixture(deleteFixture, () => run("delete", { recordId: "1" }, ctx));
  const res = written.find((w) => w.spec === "delete-result")!;
  assertEquals(res.payload.status, "deleted");
});

// ---------------------------------------------------------------------------
// error.json contract — the generic error envelope
// ---------------------------------------------------------------------------

Deno.test("contract: error.json — {status:ERROR, message} throws message verbatim", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withFixture(errorFixture, async () => {
    try {
      await run("ping", {}, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assert(threw instanceof Error);
  assertEquals((threw as Error).message, errorFixture.message);
});
