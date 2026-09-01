/**
 * Coverage suite: sweeps every guard/branch in homeassistant.ts that the
 * methods and adversarial suites don't already exercise on both sides, so
 * deleting any one of these guards turns a test red (STANDARD.md's coverage
 * role — a behavioral regression guard, not a numeric percentage).
 *
 * homeassistant.ts v2026.08.02.1 real-fixes LB3-LB9 (see CHANGELOG.md); the
 * guards below that changed shape (the statistics missing-key/empty
 * distinction, the sensitive token meta) are flipped to prove-fixed tests
 * ("fix:"/"new:"), every other guard here still PINS unchanged behavior.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { model } from "./homeassistant.ts";
import states from "../../fixtures/states.json" with { type: "json" };
import services from "../../fixtures/services.json" with { type: "json" };

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

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
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
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// fetch stub — no-cast idiom (mirrors victorialogs, not porkbun)
// ---------------------------------------------------------------------------

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
  fn: (calls: Request[]) => Promise<unknown>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
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
  #armed = false;

  constructor(url: string, steps: WSStep[]) {
    this.url = url;
    this.#steps = steps;
    this.#schedule();
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
    // Re-arm: a premature attempt (see #deliver) left the step unconsumed.
    this.#schedule();
  }

  send(raw: string) {
    const frame = JSON.parse(raw) as WSFrame;
    this.sentFrames.push(frame);
    this.#schedule();
  }

  close() {
    // no-op — see homeassistant_test.ts for the full rationale.
  }

  /** Queue one delivery attempt, coalescing multiple requests into a single
   * microtask so re-arming from each addEventListener call cannot over-deliver. */
  #schedule() {
    if (this.#armed) return;
    this.#armed = true;
    queueMicrotask(() => {
      this.#armed = false;
      this.#deliver();
    });
  }

  /** True once the listener this step needs has been attached. */
  #canDeliver(step: WSStep): boolean {
    if (step.kind === "message" || step.kind === "raw") {
      return this.#messageListeners.length > 0;
    }
    if (step.kind === "error") return this.#errorListeners.length > 0;
    if (step.kind === "close") return this.#closeListeners.length > 0;
    return true;
  }

  #deliver() {
    const step = this.#steps[this.#cursor];
    if (!step) return;
    // Never consume a step no one can receive yet: the constructor's microtask
    // can land BEFORE the caller attaches its listeners, because Deno 2.9
    // drains the microtask queue while lazy-loading the `setTimeout` global —
    // which the model touches between `new WebSocket()` and addEventListener.
    // Consuming here dropped the frame into the void and stalled the socket
    // until the model's own 60s timeout fired.
    if (!this.#canDeliver(step)) return;
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

function resultFrame(result: unknown, success = true): WSStep {
  return msg({ id: 1, type: "result", success, result });
}

// =============================================================================
// Guard: `(msg.result && msg.result[statisticId]) || []` — all three sides
// =============================================================================

Deno.test("get-statistics: msg.result PRESENT and HAS the statisticId key -> the array passes through", async () => {
  const { ctx, written } = makeCtx();
  const points = [{ start: 1, end: 2, mean: 5 }];
  await withWebSocketStub(
    [
      AUTH_REQUIRED,
      AUTH_OK,
      resultFrame({ "sensor.example_temperature": points }),
    ],
    () =>
      run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T01:00:00Z",
      }, ctx),
  );
  assertEquals(written.find((w) => w.spec === "statistics")!.payload.count, 1);
});

Deno.test("fix: get-statistics: msg.result PRESENT but with OTHER keys, missing the requested statisticId -> rejects 'omitted requested statistic' (flip of the former []-masking pin)", async () => {
  const { ctx } = makeCtx();
  await withWebSocketStub(
    [
      AUTH_REQUIRED,
      AUTH_OK,
      resultFrame({ "sensor.other_entity": [{ start: 1 }] }),
    ],
    () =>
      assertRejects(
        () =>
          run("get-statistics", {
            statisticId: "sensor.example_temperature",
            startTime: "2026-01-01T00:00:00Z",
            endTime: "2026-01-01T01:00:00Z",
          }, ctx),
        Error,
        "omitted requested statistic",
      ),
  );
});

Deno.test("fix: get-statistics: msg.result is FALSY (absent from the frame entirely) -> rejects 'missing result payload' (flip of the former []-masking pin)", async () => {
  const { ctx } = makeCtx();
  await withWebSocketStub(
    [AUTH_REQUIRED, AUTH_OK, msg({ id: 1, type: "result", success: true })],
    () =>
      assertRejects(
        () =>
          run("get-statistics", {
            statisticId: "sensor.example_temperature",
            startTime: "2026-01-01T00:00:00Z",
            endTime: "2026-01-01T01:00:00Z",
          }, ctx),
        Error,
        "missing result payload",
      ),
  );
});

Deno.test("new: get-statistics: msg.result is an EMPTY OBJECT ({}) -> resolves [] / count 0 — a legitimately empty range (HA omits the key entirely), NOT an error", async () => {
  const { ctx, written } = makeCtx();
  await withWebSocketStub(
    [AUTH_REQUIRED, AUTH_OK, resultFrame({})],
    () =>
      run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T01:00:00Z",
      }, ctx),
  );
  assertEquals(written.find((w) => w.spec === "statistics")!.payload.count, 0);
});

// =============================================================================
// Guard: protocol default (https -> wss / http -> ws)
// =============================================================================

Deno.test("get-statistics: protocol OMITTED defaults to https -> wss://", async () => {
  const { ctx } = makeCtx({ host: "ha.example.test", token: FAKE_TOKEN });
  const sockets = await withWebSocketStub(
    [AUTH_REQUIRED, AUTH_OK, resultFrame({})],
    async (sockets) => {
      await run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T01:00:00Z",
      }, ctx);
      return sockets;
    },
  );
  assertEquals(sockets[0].url, "wss://ha.example.test/api/websocket");
});

Deno.test("get-statistics: protocol='http' -> ws:// (not wss)", async () => {
  const { ctx } = makeCtx({
    host: "ha.example.test",
    token: FAKE_TOKEN,
    protocol: "http",
  });
  const sockets = await withWebSocketStub(
    [AUTH_REQUIRED, AUTH_OK, resultFrame({})],
    async (sockets) => {
      await run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T01:00:00Z",
      }, ctx);
      return sockets;
    },
  );
  assertEquals(sockets[0].url, "ws://ha.example.test/api/websocket");
});

Deno.test("get-statistics: protocol='https' explicit -> wss:// (same as the default)", async () => {
  const { ctx } = makeCtx({
    host: "ha.example.test",
    token: FAKE_TOKEN,
    protocol: "https",
  });
  const sockets = await withWebSocketStub(
    [AUTH_REQUIRED, AUTH_OK, resultFrame({})],
    async (sockets) => {
      await run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T01:00:00Z",
      }, ctx);
      return sockets;
    },
  );
  assertEquals(sockets[0].url, "wss://ha.example.test/api/websocket");
});

// =============================================================================
// backfill-to-vm guards
// =============================================================================

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

Deno.test("backfill-to-vm: a point with a non-numeric `start` (typeof ts !== 'number') is skipped, a sibling numeric-start point is kept", async () => {
  const { ctx, written } = makeCtx();
  const points = [
    { start: "not-a-number", end: 2, mean: 10 },
    { start: 1735689600000, end: 1735693200000, mean: 20 },
  ];
  const importBodies: string[] = [];
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
  const res = written.find((w) => w.spec === "backfill-report")!;
  const entities = res.payload.entities as Array<{ points: number }>;
  assertEquals(
    entities[0].points,
    1,
    "only the point with a numeric start survives",
  );
});

Deno.test("backfill-to-vm: a per-entity /states failure is swallowed to {} -> the VM import metric's friendly_name falls back to the entityId itself", async () => {
  const { ctx } = makeCtx();
  const importBodies: string[] = [];
  const failingStatesRoute: Route = (req) => {
    const url = new URL(req.url);
    return url.pathname === "/api/states/sensor.example_temperature"
      ? new Response("down", { status: 500 })
      : undefined;
  };
  await withFetchStub(
    [failingStatesRoute, vmImportRoute(importBodies)],
    () =>
      withWebSocketStub(
        () => [
          AUTH_REQUIRED,
          AUTH_OK,
          resultFrame({
            "sensor.example_temperature": [
              { start: 1735689600000, end: 1735693200000, mean: 21 },
            ],
          }),
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
  assertEquals(importBodies.length, 1);
  const line = JSON.parse(importBodies[0].trim());
  assertEquals(
    line.metric.friendly_name,
    "sensor.example_temperature",
    "a swallowed /states failure -> stateAttrs is {} -> friendly_name falls back to the entityId",
  );
});

Deno.test("backfill-to-vm: a successful /states lookup -> the VM import metric's friendly_name is the fixture's attributes.friendly_name", async () => {
  const { ctx } = makeCtx();
  const importBodies: string[] = [];
  await withFetchStub(
    [statesRoute(), vmImportRoute(importBodies)],
    () =>
      withWebSocketStub(
        () => [
          AUTH_REQUIRED,
          AUTH_OK,
          resultFrame({
            "sensor.example_temperature": [
              { start: 1735689600000, end: 1735693200000, mean: 21 },
            ],
          }),
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
  assertEquals(line.metric.friendly_name, "Example Temperature");
});

Deno.test("backfill-to-vm: aggregator override 'max' reads p.max instead of the default p.mean", async () => {
  const { ctx, written } = makeCtx();
  const points = [{
    start: 1735689600000,
    end: 1735693200000,
    mean: 10,
    max: 99,
  }];
  await withFetchStub(
    [statesRoute(), vmImportRoute([])],
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
            aggregator: "max",
          }, ctx),
      ),
  );
  const res = written.find((w) => w.spec === "backfill-report")!;
  assertEquals(res.payload.aggregator, "max");
});

Deno.test("backfill-to-vm: period default is 'hour' when omitted", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [statesRoute(), vmImportRoute([])],
    () =>
      withWebSocketStub(
        () => [
          AUTH_REQUIRED,
          AUTH_OK,
          resultFrame({ "sensor.example_temperature": [] }),
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
  const res = written.find((w) => w.spec === "backfill-report")!;
  assertEquals(res.payload.period, "hour");
});

Deno.test("backfill-to-vm: a MIXED single entity (one null point, one numeric point) still triggers the import — the >0 gate is per-entity total, not all-or-nothing per point", async () => {
  const { ctx, written } = makeCtx();
  const importBodies: string[] = [];
  const points = [
    { start: 1735689600000, end: 1735693200000, mean: null },
    { start: 1735693200000, end: 1735696800000, mean: 15 },
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
  assertEquals(
    importBodies.length,
    1,
    "the null point is filtered but the import still fires",
  );
  const res = written.find((w) => w.spec === "backfill-report")!;
  const entities = res.payload.entities as Array<{ points: number }>;
  assertEquals(entities[0].points, 1);
  assertEquals(res.payload.totalSamples, 1);
});

// =============================================================================
// get-history: minimal_response empty / non-array result
// =============================================================================

Deno.test("get-history: result is an EMPTY array ([]) -> points [] and count 0", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse([], 200, () =>
    run("get-history", {
      entityId: "sensor.example_temperature",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T01:00:00Z",
    }, ctx));
  const res = written.find((w) => w.spec === "history")!;
  assertEquals(res.payload.points, []);
  assertEquals(res.payload.count, 0);
});

Deno.test("get-history: a non-array result (malformed response) also falls back to points [] / count 0", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({}, 200, () =>
    run("get-history", {
      entityId: "sensor.example_temperature",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T01:00:00Z",
    }, ctx));
  const res = written.find((w) => w.spec === "history")!;
  assertEquals(res.payload.points, []);
  assertEquals(res.payload.count, 0);
});

Deno.test("get-history: a state value containing a double-quote is escaped to two double-quotes in the CSV (the ONLY escaping the builder does)", async () => {
  const { ctx, written } = makeCtx();
  const rows = [{
    entity_id: "sensor.example_temperature",
    state: 'say "hi"',
    last_changed: "2026-01-01T00:00:00Z",
  }];
  await withOneResponse([rows], 200, () =>
    run("get-history", {
      entityId: "sensor.example_temperature",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T01:00:00Z",
    }, ctx));
  const res = written.find((w) => w.spec === "history-csv")!;
  const csvLines = (res.payload.csv as string).trim().split("\n");
  assertEquals(csvLines[1], '2026-01-01T00:00:00Z,say ""hi""');
});

// =============================================================================
// list-entities / list-services / list-automations: the `search`/`domain`
// substring filters (untested branches — a real guard, not just the domain
// derivation already pinned by the contract suite)
// =============================================================================

Deno.test("list-entities: search filter matches on entityId OR friendlyName substring, case-insensitively", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    states,
    200,
    () => run("list-entities", { search: "temperature" }, ctx),
  );
  const res = written.find((w) => w.spec === "states")!;
  const entities = res.payload.entities as Array<{ entityId: string }>;
  assertEquals(entities.length, 1);
  assertEquals(entities[0].entityId, "sensor.example_temperature");
});

Deno.test("list-entities: search filter also matches on friendlyName (not just entityId)", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    states,
    200,
    () => run("list-entities", { search: "EXAMPLE MOTION" }, ctx),
  );
  const res = written.find((w) => w.spec === "states")!;
  const entities = res.payload.entities as Array<{ entityId: string }>;
  assertEquals(entities.length, 1);
  assertEquals(entities[0].entityId, "binary_sensor.example_motion");
});

Deno.test("list-services: domain filter narrows to exactly the matching domain", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    services,
    200,
    () => run("list-services", { domain: "switch" }, ctx),
  );
  const res = written.find((w) => w.spec === "services")!;
  const domains = res.payload.domains as Array<{ domain: string }>;
  assertEquals(domains.length, 1);
  assertEquals(domains[0].domain, "switch");
});

Deno.test("list-automations: search filter matches on entityId OR friendlyName substring", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    states,
    200,
    () => run("list-automations", { search: "alarm" }, ctx),
  );
  const res = written.find((w) => w.spec === "automations")!;
  assertEquals(res.payload.count, 1);
});

Deno.test("list-automations: a search term matching NOTHING yields an empty (not undefined-crashing) result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    states,
    200,
    () => run("list-automations", { search: "no-such-automation" }, ctx),
  );
  const res = written.find((w) => w.spec === "automations")!;
  assertEquals(res.payload.count, 0);
});

// =============================================================================
// call-service: entity_id single/array/absent branches + the data merge
// =============================================================================

Deno.test("call-service: entityId (single) sets serviceData.entity_id to that string", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run(
      "call-service",
      { domain: "light", service: "turn_on", entityId: "light.example_lamp" },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assertEquals(body.entity_id, "light.example_lamp");
  });
});

Deno.test("call-service: entityIds (non-empty array) sets serviceData.entity_id to the array", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run(
      "call-service",
      {
        domain: "light",
        service: "turn_on",
        entityIds: ["light.example_lamp", "switch.example_switch"],
      },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assertEquals(body.entity_id, [
      "light.example_lamp",
      "switch.example_switch",
    ]);
  });
});

Deno.test("call-service: neither entityId nor entityIds -> no entity_id key at all in the body", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run("call-service", { domain: "light", service: "turn_on" }, ctx);
    const body = await requestBody(calls[0]);
    assert(!("entity_id" in body));
  });
});

Deno.test("call-service: entityIds is an EMPTY array -> the `.length > 0` guard is false -> no entity_id key either", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run(
      "call-service",
      { domain: "light", service: "turn_on", entityIds: [] },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assert(!("entity_id" in body));
  });
});

Deno.test("call-service: entityId OVERWRITES an entity_id key already present in `data` (spread happens first, then the explicit assignment)", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run(
      "call-service",
      {
        domain: "light",
        service: "turn_on",
        entityId: "light.example_lamp",
        data: { entity_id: "light.someone_elses_choice", brightness: 5 },
      },
      ctx,
    );
    const body = await requestBody(calls[0]);
    assertEquals(body.entity_id, "light.example_lamp");
    assertEquals(body.brightness, 5);
  });
});

// =============================================================================
// Security-review finding: the token field is NOT marked sensitive
// =============================================================================

Deno.test("fix: token is now marked `.meta({ sensitive: true })` (flip of the former security-hardening-gap pin)", () => {
  // Mirrors stripe-mpp's secretKey/serverSecret and telegram-send's botToken:
  // homeassistant.ts's globalArguments schema now calls
  // `.meta({ sensitive: true })` on `token`, closing the gap the security
  // review surfaced (tracked in the local `homeassistant-latent-bugs` model).
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.token) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    true,
    "token must be marked sensitive now that homeassistant.ts adds the annotation",
  );
});
