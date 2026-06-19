// RED-phase tests for the NEW @magistr/swamp-go-brr/otlp-export model (issue
// gobrr-observability) — the ONLY network egress. gobrr stays pure; this model
// POSTs OTLP/HTTP to a configurable endpoint. Pure helpers are unit-tested here;
// the network is stubbed (no real egress). Endpoint + token are method args (the
// workflow wires them via a vault CEL); the resolved URL/key are NEVER persisted
// or logged.
// Run: /home/zeroclaw/.swamp/deno/deno test extensions/models/otlp_export.test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildExportRequest,
  classifyResult,
  model,
  redactEndpoint,
  validateEndpoint,
} from "./otlp_export.ts";

Deno.test("validateEndpoint requires https (rejects http/empty/no-scheme/ftp)", () => {
  assert(validateEndpoint("https://collector.example.com/v1/traces").ok);
  assert(!validateEndpoint("http://collector.example.com/v1/traces").ok);
  assert(!validateEndpoint("").ok);
  assert(!validateEndpoint("ftp://collector.example.com").ok);
  assert(!validateEndpoint("collector.example.com/v1/traces").ok); // no scheme
});

Deno.test("buildExportRequest puts the token in the Authorization header, never in the URL or body", () => {
  const payload = { resourceSpans: [] };
  const req = buildExportRequest(
    "https://collector.example.com/v1/traces",
    "supersecrettoken123",
    payload,
  );
  assertEquals(req.url, "https://collector.example.com/v1/traces");
  assertEquals(req.headers["Content-Type"], "application/json");
  assert(req.headers["Authorization"].includes("supersecrettoken123"));
  assert(!req.url.includes("supersecrettoken123"), "token leaked into URL");
  assert(!req.body.includes("supersecrettoken123"), "token leaked into body");
  assertEquals(JSON.parse(req.body), payload);
});

Deno.test("buildExportRequest serializes a resourceMetrics payload (not only traces)", () => {
  const req = buildExportRequest(
    "https://collector.example.com/v1/metrics",
    "t",
    { resourceMetrics: [] },
  );
  assertEquals(JSON.parse(req.body).resourceMetrics, []);
  assertEquals(req.headers["Content-Type"], "application/json");
});

Deno.test("redactEndpoint strips userinfo + query so a logged endpoint cannot leak creds", () => {
  const red = redactEndpoint(
    "https://user:pass123@collector.example.com/v1/traces?apikey=abc123",
  );
  assert(!red.includes("pass123"), "basic-auth password leaked");
  assert(!red.includes("abc123"), "query apikey leaked");
  assert(
    red.includes("collector.example.com"),
    "host should remain for diagnostics",
  );
});

Deno.test("classifyResult maps 2xx->ok and others->error", () => {
  assertEquals(classifyResult(200), "ok");
  assertEquals(classifyResult(204), "ok");
  assertEquals(classifyResult(401), "error");
  assertEquals(classifyResult(500), "error");
});

Deno.test("model type is @magistr/swamp-go-brr/otlp-export with an export_run method", () => {
  assertEquals(model.type, "@magistr/swamp-go-brr/otlp-export");
  assert(
    typeof (model.methods as Record<string, unknown>).export_run === "object",
  );
});

// ── export_run typed status: skipped / ok / error (best-effort, never throws) ─

interface FakeCtx {
  ctx: Record<string, unknown>;
  writes: Array<{ name: string; data: Record<string, unknown> }>;
}
function fakeCtx(
  globalArgs: Record<string, unknown>,
  payload: Record<string, unknown> = { resourceSpans: [] },
): FakeCtx {
  const writes: Array<{ name: string; data: Record<string, unknown> }> = [];
  return {
    writes,
    ctx: {
      logger: { info: () => {} },
      globalArgs,
      readResource: (_n: string) => Promise.resolve(payload),
      writeResource: (_s: string, n: string, d: Record<string, unknown>) => {
        writes.push({ name: n, data: d });
        return Promise.resolve(d);
      },
      definition: { name: "x" },
    },
  };
}
function recordedStatus(writes: FakeCtx["writes"]): unknown {
  for (const w of writes) {
    if (w.data && typeof w.data.status !== "undefined") return w.data.status;
  }
  return undefined;
}

Deno.test("export_run with no endpoint configured records status=skipped (never throws)", async () => {
  const { ctx, writes } = fakeCtx({ endpoint: "", token: "" });
  // deno-lint-ignore no-explicit-any
  await (model.methods as any).export_run.execute({}, ctx);
  assertEquals(recordedStatus(writes), "skipped");
});

Deno.test("export_run records status=ok on a 2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 200 }));
  try {
    const { ctx, writes } = fakeCtx({
      endpoint: "https://c.example.com/v1/traces",
      token: "t",
    });
    // deno-lint-ignore no-explicit-any
    await (model.methods as any).export_run.execute({}, ctx);
    assertEquals(recordedStatus(writes), "ok");
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("export_run records status=error on a 5xx and does NOT throw/abort", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("boom", { status: 500 }));
  try {
    const { ctx, writes } = fakeCtx({
      endpoint: "https://c.example.com/v1/traces",
      token: "t",
    });
    // deno-lint-ignore no-explicit-any
    await (model.methods as any).export_run.execute({}, ctx);
    assertEquals(recordedStatus(writes), "error");
  } finally {
    globalThis.fetch = orig;
  }
});
