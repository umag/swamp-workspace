/**
 * Property-based tests (fast-check) for @magistr/homeassistant.
 *
 * homeassistant.ts is UNMODIFIED — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed fetch / stubbed
 * WebSocket and reading back the written resource (and, for backfill-to-vm,
 * the captured VM `/api/v1/import` POST body — the only place `values`/
 * `timestamps` are ever observable from outside the method).
 *
 * Properties:
 *  (a) WS handshake round-trip — for any synthetic points array the scripted
 *      server returns, get-statistics resolves to exactly that array and its
 *      CSV has a header + N rows.
 *  (b) get-history CSV row-count + timestamp-mapping invariant.
 *  (c) backfill-to-vm sample-inclusion invariant, stated to mirror the
 *      model's REAL guard exactly: a sample is emitted iff
 *      `v != null (and != undefined)` AND `typeof start === "number"` — NOT
 *      "v is numeric". A non-numeric-but-non-null `v` still passes the
 *      guard and becomes `Number(v)` (NaN for garbage strings); the general
 *      property is stated over NUMERIC mean values (where Number(v) is the
 *      identity and no NaN/JSON-serialization wrinkle applies), with a
 *      separate named example pinning the NaN-passthrough edge case
 *      (round-1 review finding: don't over-tighten to "numeric").
 *  (d) statistic-id / period pass-through determinism, modulo the
 *      documented `period` default ("hour" when omitted).
 *
 * The WS fake is re-created FRESH on every property run (a new
 * `withWebSocketStub` call per iteration) so no scripted-responder state
 * bleeds across fast-check iterations.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./homeassistant.ts";
import states from "../../fixtures/states.json" with { type: "json" };

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "FAKE_HA_TOKEN_never_a_real_jwt";

const GLOBAL_ARGS = {
  host: "ha.example.test",
  token: FAKE_TOKEN,
  protocol: "https",
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

// ---------------------------------------------------------------------------
// fetch stub — no-cast idiom (mirrors victorialogs, not porkbun)
// ---------------------------------------------------------------------------

type Route = (req: Request) => Response | Promise<Response> | undefined;

// Eager plain-object snapshot instead of `.clone()` — cloning a body-bearing
// Request tees its body into a ReadableStream that is never consumed or
// cancelled, leaking ~6KB per stubbed fetch call (see
// fix/soak-property-harness-heap-leak). The body is read ONCE via
// `await req.text()`; routes get a freshly reconstructed Request built from
// the captured text so existing route logic (which may itself read the
// body) keeps working.
type CapturedRequest = {
  method: string;
  url: string;
  headers: Headers;
  body: string;
};

async function withFetchStub(
  routes: Route[],
  fn: (calls: CapturedRequest[]) => Promise<unknown>,
) {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const body = await req.text();
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    const routable = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    for (const route of routes) {
      const res = await route(routable);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = stub;
  try {
    return await fn(calls);
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

function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: CapturedRequest[]) => Promise<unknown>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

// ---------------------------------------------------------------------------
// FakeWebSocket — a SCRIPTED RESPONDER for the ONE WS path (fetchStatistics,
// reached via get-statistics / backfill-to-vm).
// ---------------------------------------------------------------------------

type WSFrame = Record<string, unknown>;

type WSStep =
  | { kind: "message"; frame: WSFrame }
  | { kind: "raw"; data: string }
  | { kind: "error"; message?: string }
  | { kind: "close" }
  | { kind: "none" };

function msg(frame: WSFrame): WSStep {
  return { kind: "message", frame };
}

const AUTH_REQUIRED: WSStep = msg({ type: "auth_required" });
const AUTH_OK: WSStep = msg({ type: "auth_ok" });

type MessageListener = (ev: { data: string }) => void;
type ErrorListener = (ev: { type: string; message?: string }) => void;
type CloseListener = (ev: { type: string }) => void;

class FakeWebSocket {
  readonly url: string;
  readonly sentFrames: WSFrame[] = [];
  #messageListeners: MessageListener[] = [];
  #errorListeners: ErrorListener[] = [];
  #closeListeners: CloseListener[] = [];
  #steps: WSStep[];
  #cursor = 0;

  constructor(url: string, steps: WSStep[]) {
    this.url = url;
    this.#steps = steps;
    queueMicrotask(() => this.#deliver());
  }

  get closeListenerCount(): number {
    return this.#closeListeners.length;
  }

  addEventListener(
    type: "message" | "error" | "close",
    listener: MessageListener | ErrorListener | CloseListener,
  ) {
    if (type === "message") {
      this.#messageListeners.push(listener as MessageListener);
    } else if (type === "error") {
      this.#errorListeners.push(listener as ErrorListener);
    } else {
      this.#closeListeners.push(listener as CloseListener);
    }
  }

  send(raw: string) {
    const frame = JSON.parse(raw) as WSFrame;
    this.sentFrames.push(frame);
    queueMicrotask(() => this.#deliver());
  }

  close() {
    // no-op — see homeassistant_test.ts for the full rationale.
  }

  #deliver() {
    const step = this.#steps[this.#cursor];
    if (!step) return;
    this.#cursor++;
    if (step.kind === "none") return;
    if (step.kind === "message") {
      for (const l of this.#messageListeners) {
        l({ data: JSON.stringify(step.frame) });
      }
    } else if (step.kind === "raw") {
      for (const l of this.#messageListeners) l({ data: step.data });
    } else if (step.kind === "error") {
      for (const l of this.#errorListeners) {
        l({ type: "error", message: step.message });
      }
    } else if (step.kind === "close") {
      for (const l of this.#closeListeners) l({ type: "close" });
    }
  }
}

type WSStepSource = WSStep[] | ((socketIndex: number) => WSStep[]);

/** Installs a FRESH FakeWebSocket-backed global for the duration of `fn`.
 * Called anew on every fast-check iteration below — no scripted-responder
 * state (cursor position, sent frames) survives across iterations. */
async function withWebSocketStub<T>(
  stepsSource: WSStepSource,
  fn: (sockets: FakeWebSocket[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.WebSocket;
  const sockets: FakeWebSocket[] = [];
  let nextIndex = 0;
  class ScriptedWebSocket extends FakeWebSocket {
    constructor(url: string) {
      const steps = typeof stepsSource === "function"
        ? stepsSource(nextIndex)
        : stepsSource;
      super(url, steps);
      nextIndex++;
      sockets.push(this);
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).WebSocket = ScriptedWebSocket;
  try {
    return await fn(sockets);
  } finally {
    globalThis.WebSocket = original;
  }
}

function resultFrame(result: unknown): WSStep {
  return msg({ id: 1, type: "result", success: true, result });
}

function statesRoute(): Route {
  return (req) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/states/")) return undefined;
    const entityId = url.pathname.replace("/api/states/", "");
    const fixture = states.find((s) => s.entity_id === entityId);
    return fixture ? json(fixture, 200) : json({ message: "not found" }, 404);
  };
}

function vmImportRoute(bodies: string[]): Route {
  return (req) => {
    const url = new URL(req.url);
    if (url.hostname !== "203.0.113.10" || url.pathname !== "/api/v1/import") {
      return undefined;
    }
    return req.text().then((text) => {
      bodies.push(text);
      return json({ status: "ok" }, 200);
    });
  };
}

// ---------------------------------------------------------------------------
// (a) WS handshake round-trip
// ---------------------------------------------------------------------------

const arbStatPoint = fc.record({
  start: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  end: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  mean: fc.double({ noNaN: true, min: -1000, max: 1000 }),
  min: fc.double({ noNaN: true, min: -1000, max: 1000 }),
  max: fc.double({ noNaN: true, min: -1000, max: 1000 }),
  last_reset: fc.constant(null),
  state: fc.double({ noNaN: true, min: -1000, max: 1000 }),
  sum: fc.constant(null),
});

Deno.test("property: get-statistics resolves to exactly the scripted result[statisticId] array; CSV is header + N rows", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbStatPoint, { maxLength: 20 }),
      async (points) => {
        const { ctx, written } = makeCtx();
        await withWebSocketStub(
          () => [
            AUTH_REQUIRED,
            AUTH_OK,
            resultFrame({ "sensor.example_temperature": points }),
          ],
          () =>
            run("get-statistics", {
              statisticId: "sensor.example_temperature",
              startTime: "2026-01-01T00:00:00Z",
              endTime: "2026-01-01T02:00:00Z",
            }, ctx),
        );
        const res = written.find((w) => w.spec === "statistics")!;
        const csvLines = (res.payload.csv as string).trim().split("\n").length;
        return (
          res.payload.count === points.length &&
          csvLines === 1 + points.length &&
          JSON.stringify(res.payload.points) === JSON.stringify(points)
        );
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) get-history CSV row-count + timestamp-mapping invariant
// ---------------------------------------------------------------------------

const arbHistoryRow = fc.record({
  entity_id: fc.constant("sensor.example_temperature"),
  state: fc.stringMatching(/^[a-zA-Z0-9._ -]{0,15}$/),
  last_changed: fc.date({
    min: new Date("2020-01-01T00:00:00Z"),
    max: new Date("2030-01-01T00:00:00Z"),
    noInvalidDate: true,
  }).map((d) => d.toISOString()),
});

Deno.test("property: get-history maps every history row to a {t, state} point in order, with header + N CSV rows", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbHistoryRow, { maxLength: 20 }),
      async (rows) => {
        const { ctx, written } = makeCtx();
        await withOneResponse([rows], 200, () =>
          run("get-history", {
            entityId: "sensor.example_temperature",
            startTime: "2026-01-01T00:00:00Z",
            endTime: "2026-01-02T00:00:00Z",
          }, ctx));
        const historyRes = written.find((w) => w.spec === "history")!;
        const points = historyRes.payload.points as Array<
          { t: string; state: string }
        >;
        const csvRes = written.find((w) => w.spec === "history-csv")!;
        const csvLines =
          (csvRes.payload.csv as string).trim().split("\n").length;
        if (points.length !== rows.length) return false;
        if (csvLines !== 1 + rows.length) return false;
        for (let i = 0; i < rows.length; i++) {
          if (points[i].t !== rows[i].last_changed) return false;
          if (points[i].state !== rows[i].state) return false;
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) backfill-to-vm sample-inclusion invariant — mirrors the REAL guard
// ---------------------------------------------------------------------------

const arbBackfillPoint = fc.record({
  start: fc.oneof(
    fc.integer({ min: 0, max: 2_000_000_000_000 }),
    fc.constant("not-a-timestamp"),
  ),
  end: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  mean: fc.oneof(
    fc.constant(null),
    fc.double({ noNaN: true, min: -1000, max: 1000 }),
  ),
});

Deno.test("property: backfill-to-vm emits a sample iff v != null AND typeof start === 'number' — over NUMERIC mean values (Number(v) is the identity, no NaN/JSON wrinkle)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbBackfillPoint, { minLength: 1, maxLength: 15 }),
      async (points) => {
        const expectedValues: number[] = [];
        const expectedTimestamps: number[] = [];
        for (const p of points) {
          if (p.mean === null) continue;
          if (typeof p.start !== "number") continue;
          expectedValues.push(Number(p.mean));
          expectedTimestamps.push(p.start);
        }
        const importBodies: string[] = [];
        const { ctx } = makeCtx();
        await withFetchStub(
          [statesRoute(), vmImportRoute(importBodies)],
          () =>
            withWebSocketStub(
              () => [
                AUTH_REQUIRED,
                AUTH_OK,
                resultFrame({ "sensor.example_temperature": points }),
              ],
              () =>
                run("backfill-to-vm", {
                  entities: [
                    {
                      entityId: "sensor.example_temperature",
                      metricName: "ha_temp",
                    },
                  ],
                  startTime: "2026-01-01T00:00:00Z",
                  endTime: "2026-01-01T03:00:00Z",
                }, ctx),
            ),
        );
        if (expectedValues.length === 0) {
          return importBodies.length === 0;
        }
        const line = JSON.parse(importBodies[0].trim());
        return (
          JSON.stringify(line.values) === JSON.stringify(expectedValues) &&
          JSON.stringify(line.timestamps) === JSON.stringify(expectedTimestamps)
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("edge case: a NON-NUMERIC mean value still passes the v!=null guard (NOT excluded, per round-1 review) — Number(v) is NaN in-memory, which serializes to `null` over the JSON wire", async () => {
  const { ctx, written } = makeCtx();
  const importBodies: string[] = [];
  const points = [
    { start: 1735689600000, end: 1735693200000, mean: "not-a-number" },
  ];
  await withFetchStub(
    [statesRoute(), vmImportRoute(importBodies)],
    () =>
      withWebSocketStub(
        () => [
          AUTH_REQUIRED,
          AUTH_OK,
          resultFrame({ "sensor.example_temperature": points }),
        ],
        () =>
          run("backfill-to-vm", {
            entities: [
              { entityId: "sensor.example_temperature", metricName: "ha_temp" },
            ],
            startTime: "2026-01-01T00:00:00Z",
            endTime: "2026-01-01T03:00:00Z",
          }, ctx),
      ),
  );
  const line = JSON.parse(importBodies[0].trim());
  assertEquals(
    line.values,
    [null],
    "Number('not-a-number') is NaN in-memory; JSON.stringify(NaN) is `null` on the wire",
  );
  const res = written.find((w) => w.spec === "backfill-report")!;
  const entities = res.payload.entities as Array<{ points: number }>;
  assertEquals(
    entities[0].points,
    1,
    "the guard let the non-numeric value through as a COUNTED sample — not excluded, just NaN-valued",
  );
});

// ---------------------------------------------------------------------------
// (d) statistic-id / period pass-through determinism
// ---------------------------------------------------------------------------

const PERIODS = ["5minute", "hour", "day", "week", "month"] as const;

Deno.test("property: get-statistics echoes statisticId verbatim; period is the arg when given, else defaults to 'hour'", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.stringMatching(/^sensor\.[a-z_]{1,20}$/),
      fc.option(fc.constantFrom(...PERIODS), { nil: undefined }),
      async (statisticId, period) => {
        const { ctx, written } = makeCtx();
        const args: Record<string, unknown> = {
          statisticId,
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T02:00:00Z",
        };
        if (period !== undefined) args.period = period;
        await withWebSocketStub(
          () => [
            AUTH_REQUIRED,
            AUTH_OK,
            resultFrame({ [statisticId]: [] }),
          ],
          () => run("get-statistics", args, ctx),
        );
        const res = written.find((w) => w.spec === "statistics")!;
        return (
          res.payload.statisticId === statisticId &&
          res.payload.period === (period ?? "hour")
        );
      },
    ),
    FC_RUNS,
  );
});
