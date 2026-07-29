/**
 * Contract-fixture suite: pins the CONCRETE VictoriaLogs NDJSON wire shape
 * from victorialogs/fixtures/*.json directly, AND re-validates every written
 * resource payload against the model's own `model.resources.<r>.schema` —
 * so a future code/schema drift (e.g. a field renamed in victorialogs.ts but
 * not in its resource schema, or vice versa) turns a test red (STANDARD.md's
 * contract-fixture role; see also plan finding P5).
 *
 * All fixtures are PURE doc-derived synthetic data — see
 * fixtures/PROVENANCE.md. Every test here is offline: fixtures are fed
 * through a stubbed fetch (or, for container-log-status, a stubbed
 * Deno.Command too), no network call is ever made.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./victorialogs.ts";
import queryFixture from "../../fixtures/query.json" with { type: "json" };
import statsFixture from "../../fixtures/stats.json" with { type: "json" };
import containerStatsFixture from "../../fixtures/container-stats.json" with {
  type: "json",
};
import errorLinesFixture from "../../fixtures/error-lines.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = { host: "vlogs.example.test", port: 9428 };

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

type ResourceMap = Record<
  string,
  { schema: { parse: (v: unknown) => unknown } }
>;

function validate(spec: string, payload: unknown) {
  (model.resources as ResourceMap)[spec].schema.parse(payload);
}

function ndjson(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = stub;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function queueRoute(bodies: Array<{ text: string; status?: number }>): Route {
  const queue = [...bodies];
  return () => {
    const item = queue.shift() ?? { text: "", status: 200 };
    return new Response(item.text, { status: item.status ?? 200 });
  };
}

type CmdResp = { success: boolean; stdout: string; stderr: string };

function installCmdStub(queue: CmdResp[]) {
  const invocations: Array<{ command: string; args: string[] }> = [];
  const original = Deno.Command;
  const enc = new TextEncoder();
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts: { args: string[] }) {
      this.#cmd = cmd;
      this.#args = opts.args;
    }
    output() {
      invocations.push({ command: this.#cmd, args: this.#args });
      const r = queue.shift() ?? { success: true, stdout: "", stderr: "" };
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        signal: null,
        stdout: enc.encode(r.stdout),
        stderr: enc.encode(r.stderr),
      });
    }
  };
  return {
    invocations,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

// ---------------------------------------------------------------------------
// query.json contract — the entry-mapping shape, incl. the P7 `_stream` drop
// ---------------------------------------------------------------------------

Deno.test("contract: query.json — entries keep _time/_msg/container_name, DROP _stream entirely (P7)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture) }])],
    () => run("query", {}, ctx),
  );
  const res = written.find((w) => w.spec === "queryResult")!;
  validate("queryResult", res.payload);
  const entries = res.payload.entries as Array<Record<string, unknown>>;
  assertEquals(entries.length, queryFixture.length);
  entries.forEach((e, i) => {
    assertEquals(e.time, queryFixture[i]._time);
    assertEquals(e.container, queryFixture[i].container_name);
    assertEquals(e.message, queryFixture[i]._msg.slice(0, 500));
    assertEquals(
      e.stream,
      undefined,
      "the fixture's _stream field must NOT survive the mapping — the model " +
        "reads `e.stream` (no underscore), which is always undefined for a " +
        "real VictoriaLogs row shaped like _stream",
    );
  });
});

Deno.test("contract: query response is fed through as REAL NDJSON text (multi-line, one JSON object per line)", async () => {
  const body = ndjson(queryFixture);
  assertEquals(body.split("\n").length, queryFixture.length);
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: body }])],
    () => run("query", {}, ctx),
  );
  const res = written.find((w) => w.spec === "queryResult")!;
  assertEquals(res.payload.totalEntries, queryFixture.length);
});

// ---------------------------------------------------------------------------
// resp.ok IS checked — contrast with porkbun (which ignores HTTP status)
// ---------------------------------------------------------------------------

Deno.test("contract: a non-2xx HTTP status throws even when the body is well-formed NDJSON — unlike porkbun, which only inspects the JSON body", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture), status: 503 }])],
    async () => {
      await assertRejects(
        () => run("query", {}, ctx),
        Error,
        "VLogs query failed: 503",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Plaintext http:// target (P11)
// ---------------------------------------------------------------------------

Deno.test("contract: the request target is plaintext http:// (no TLS) — pinned homelab reality", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture) }])],
    async (calls) => {
      await run("query", {}, ctx);
      assertEquals(new URL(calls[0].url).protocol, "http:");
    },
  );
});

// ---------------------------------------------------------------------------
// stats.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: stats.json — passed through verbatim under `stats`, schema-valid", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(statsFixture) }])],
    () => run("stats", {}, ctx),
  );
  const res = written.find((w) => w.spec === "stats")!;
  validate("stats", res.payload);
  assertEquals(res.payload.stats, statsFixture);
});

// ---------------------------------------------------------------------------
// container-stats.json contract — the string-total parseInt quirk (P5 happy path)
// ---------------------------------------------------------------------------

Deno.test("contract: container-stats.json — wire `total` is a STRING, `containerStatus.logging[].count` is the parseInt'd NUMBER", async () => {
  for (const row of containerStatsFixture) {
    assertEquals(
      typeof row.total,
      "string",
      "fixture must keep total as a wire string",
    );
  }
  const cmdStub = installCmdStub([
    { success: true, stdout: "svc-alpha\nsvc-beta", stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson(containerStatsFixture) }])],
      () => run("container-log-status", {}, ctx),
    );
  } finally {
    cmdStub.restore();
  }
  const res = written.find((w) => w.spec === "containerStatus")!;
  validate("containerStatus", res.payload);
  const logging = res.payload.logging as Array<{ name: string; count: number }>;
  for (const l of logging) {
    assertEquals(
      typeof l.count,
      "number",
      "count must be the parsed number, not the wire string",
    );
  }
  assertEquals(logging.find((l) => l.name === "svc-alpha")?.count, 1024);
});

Deno.test("contract: P5 — a stats row missing container_name yields logging[].name === undefined, which FAILS ContainerStatusSchema (z.string())", () => {
  // This is the schema-vs-code drift the plan calls out: the fake context in
  // the methods suite does NOT validate writeResource payloads, so this gap
  // is invisible there. Only an explicit schema.parse() call (as done
  // throughout this file) can catch it.
  const malformedPayload = {
    logging: [{ name: undefined, count: 5 }],
    notLogging: [],
    period: "-1h",
    timestamp: new Date().toISOString(),
  };
  let threw = false;
  try {
    validate("containerStatus", malformedPayload);
  } catch {
    threw = true;
  }
  assert(
    threw,
    "a logging[].name of undefined must be rejected by ContainerStatusSchema",
  );
});

// ---------------------------------------------------------------------------
// error-lines.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: error-lines.json — errorSummary is schema-valid, totalErrors matches the fixture length", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(errorLinesFixture) }])],
    () => run("error-summary", {}, ctx),
  );
  const res = written.find((w) => w.spec === "errorSummary")!;
  validate("errorSummary", res.payload);
  assertEquals(res.payload.totalErrors, errorLinesFixture.length);
});

// ---------------------------------------------------------------------------
// compare-periods contract — reuses the `stats` resource type
// ---------------------------------------------------------------------------

Deno.test("contract: compare-periods reuses the `stats` resource shape, schema-valid, each row has name/baseline/current/status", async () => {
  const baseline = [{ container_name: "svc-alpha", total: "100" }];
  const compare = [{ container_name: "svc-alpha", total: "110" }];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson(compare) }])],
    () => run("compare-periods", {}, ctx),
  );
  const res = written.find((w) => w.spec === "stats")!;
  validate("stats", res.payload);
  const rows = res.payload.stats as Array<Record<string, unknown>>;
  for (const row of rows) {
    assertEquals(
      Object.keys(row).sort(),
      ["baseline", "current", "name", "status"],
    );
  }
});
