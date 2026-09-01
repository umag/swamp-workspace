/**
 * Contract-fixture suite: pins the CONCRETE Home Assistant REST + WebSocket
 * wire shape from homeassistant/fixtures/*.json directly — independent of
 * homeassistant.ts's resource schemas, which use `z.any()` for entities,
 * domains, automations, and statistics points. A suite that only asserted
 * "the written resource validates against the model's schema" would be
 * toothless (z.any() accepts anything); this suite hardcodes the expected
 * keyset + value types from the Home Assistant docs so a real wire-format
 * drift turns a test red (see STANDARD.md's contract-fixture role).
 *
 * All fixtures are PURE doc-derived synthetic data — see
 * fixtures/PROVENANCE.md. Every test here is offline: fixtures are fed
 * through a stubbed fetch / stubbed WebSocket, no network call is made.
 *
 * TOOLCHAIN: every global swap uses the no-cast idiom
 * (`// deno-lint-ignore no-explicit-any` + `(globalThis as any).X = stub`,
 * restoring the already-typed original in `finally`) — mirrors victorialogs'
 * `withFetchStub`, NOT porkbun's banned `as typeof globalThis.fetch` cast.
 * The WebSocket seam (`FakeWebSocket` + `withWebSocketStub`) is the novel
 * part: it is a SCRIPTED RESPONDER whose first frame is deferred via
 * `queueMicrotask` (a REAL microtask), because `fetchStatistics()` does
 * `new WebSocket(url)` and only THEN calls `addEventListener` — the fake
 * must not deliver anything until listeners are attached.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./homeassistant.ts";
import states from "../../fixtures/states.json" with { type: "json" };
import services from "../../fixtures/services.json" with { type: "json" };
import automationConfig from "../../fixtures/automation-config.json" with {
  type: "json",
};
import history from "../../fixtures/history.json" with { type: "json" };
import statisticsResult from "../../fixtures/statistics-result.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };

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

/** Single-route stub returning the same body/status to every call. */
function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<unknown>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

// ---------------------------------------------------------------------------
// FakeWebSocket — a SCRIPTED RESPONDER for the ONE WS path (fetchStatistics,
// reached via get-statistics / backfill-to-vm). Frames deliver on REAL
// microtasks (never a FakeTime timer), so `FakeTime` in tests that need it
// governs ONLY the model's 60s `setTimeout` — a setTimeout-delivered frame
// would deadlock under FakeTime, since nothing would ever advance it.
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
    // The model does `new WebSocket(url)` THEN `addEventListener(...)` — a
    // REAL microtask (not a synchronous call, not a FakeTime timer)
    // guarantees listeners are attached before this fires.
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
    // Deliberately a no-op: the fake only ever fires a "close" event when a
    // test explicitly scripts { kind: "close" } — matching what the
    // adversarial suite needs to pin (fetchStatistics never registers a
    // close listener at all; see closeListenerCount above).
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

/** Install a WebSocket stub for the duration of `fn`; returns every
 * FakeWebSocket instance created (one per `new WebSocket()` call — a fresh
 * scripted responder each time, e.g. once per entity in backfill-to-vm). */
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

/** The full happy-path handshake ending in a `type: "result"` frame carrying
 * `statisticsResult.result` for the given statisticId. */
function happyStatisticsSteps(statisticId: string): WSStep[] {
  const result = statisticsResult.result as Record<string, unknown>;
  return [
    AUTH_REQUIRED,
    AUTH_OK,
    msg({
      id: 1,
      type: "result",
      success: true,
      result: { [statisticId]: result["sensor.example_temperature"] },
    }),
  ];
}

// ---------------------------------------------------------------------------
// states.json contract — GET /api/states
// ---------------------------------------------------------------------------

Deno.test("contract: states.json — entity_id/state are wire STRINGS, attributes is a wire OBJECT", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(states, 200, () => run("list-entities", {}, ctx));
  const res = written.find((w) => w.spec === "states")!;
  const entities = res.payload.entities as Array<Record<string, unknown>>;
  assertEquals(entities.length, states.length);
  assertEquals(res.payload.count, states.length);
  for (const e of entities) {
    assertEquals(typeof e.entityId, "string");
    assertEquals(typeof e.state, "string");
    assertEquals(typeof e.friendlyName, "string");
    assertEquals(typeof e.domain, "string");
    assert(
      typeof e.attributes === "object" && e.attributes !== null,
      "attributes must round-trip as an object",
    );
  }
});

Deno.test("contract: states.json — list-entities derives domain from the entity_id prefix, verbatim from the fixture", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(states, 200, () => run("list-entities", {}, ctx));
  const res = written.find((w) => w.spec === "states")!;
  const entities = res.payload.entities as Array<
    { entityId: string; domain: string }
  >;
  for (const fixtureEntity of states) {
    const [expectedDomain] = fixtureEntity.entity_id.split(".");
    const match = entities.find((e) => e.entityId === fixtureEntity.entity_id);
    assert(match, `entity ${fixtureEntity.entity_id} must round-trip`);
    assertEquals(match.domain, expectedDomain);
  }
});

Deno.test("contract: states.json — list-automations pins the automation.* subset, id/lastTriggered from attributes", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(states, 200, () => run("list-automations", {}, ctx));
  const res = written.find((w) => w.spec === "automations")!;
  const automations = res.payload.automations as Array<
    Record<string, unknown>
  >;
  assertEquals(automations.length, 1, "exactly one automation.* fixture row");
  const fixtureAuto = states.find((s) =>
    s.entity_id === "automation.example_alarm"
  )!;
  assertEquals(automations[0].entityId, "automation.example_alarm");
  assertEquals(automations[0].id, fixtureAuto.attributes.id);
  assertEquals(
    automations[0].lastTriggered,
    fixtureAuto.attributes.last_triggered,
  );
});

// ---------------------------------------------------------------------------
// services.json contract — GET /api/services
// ---------------------------------------------------------------------------

Deno.test("contract: services.json — domain is a wire STRING, services flattened to Object.keys()", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(services, 200, () => run("list-services", {}, ctx));
  const res = written.find((w) => w.spec === "services")!;
  const domains = res.payload.domains as Array<
    { domain: string; services: string[] }
  >;
  assertEquals(domains.length, services.length);
  assertEquals(res.payload.count, services.length);
  for (const d of domains) {
    assertEquals(typeof d.domain, "string");
    const fixtureDomain = services.find((s) => s.domain === d.domain)!;
    assertEquals(d.services.sort(), Object.keys(fixtureDomain.services).sort());
  }
});

// ---------------------------------------------------------------------------
// automation-config.json contract — GET /api/config/automation/config/<id>
// ---------------------------------------------------------------------------

Deno.test("contract: automation-config.json — the full config object round-trips VERBATIM into the written resource's data field", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    automationConfig,
    200,
    () => run("get-automation-config", { automationId: "1700000000000" }, ctx),
  );
  const res = written.find((w) => w.spec === "service-result")!;
  assertEquals(res.name, "automation-config");
  assertEquals(res.payload.data, automationConfig);
});

// ---------------------------------------------------------------------------
// history.json contract — GET /api/history/period/<start> (array-of-arrays)
// ---------------------------------------------------------------------------

Deno.test("contract: history.json — entity_id/state/last_changed are wire STRINGS; get-history maps to {t, state} with a header + N rows CSV", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    history,
    200,
    () =>
      run("get-history", {
        entityId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T03:00:00Z",
      }, ctx),
  );
  const historyRes = written.find((w) => w.spec === "history")!;
  const points = historyRes.payload.points as Array<
    { t: string; state: string }
  >;
  assertEquals(points.length, history[0].length);
  assertEquals(historyRes.payload.count, history[0].length);
  for (let i = 0; i < points.length; i++) {
    assertEquals(points[i].t, history[0][i].last_changed);
    assertEquals(points[i].state, history[0][i].state);
    assertEquals(typeof history[0][i].state, "string");
  }
  const csvRes = written.find((w) => w.spec === "history-csv")!;
  const csvLines = (csvRes.payload.csv as string).trim().split("\n");
  assertEquals(csvLines[0], "timestamp,state");
  assertEquals(csvLines.length, 1 + history[0].length);
});

// ---------------------------------------------------------------------------
// statistics-result.json contract — WS recorder/statistics_during_period
// ---------------------------------------------------------------------------

Deno.test("contract: statistics-result.json — start/end/mean/min/max are wire NUMBERS (asymmetric with states.json's wire-string state); last_reset/sum legitimately null", () => {
  const points = statisticsResult.result["sensor.example_temperature"];
  for (const p of points) {
    assertEquals(typeof p.start, "number");
    assertEquals(typeof p.end, "number");
    assertEquals(typeof p.mean, "number");
    assertEquals(typeof p.min, "number");
    assertEquals(typeof p.max, "number");
    assertEquals(typeof p.state, "number");
    assertEquals(p.last_reset, null);
    assertEquals(p.sum, null);
  }
});

Deno.test("contract: statistics-result.json — get-statistics writes a header + N-row CSV, start/end converted to ISO, null fields render as empty", async () => {
  const { ctx, written } = makeCtx();
  await withWebSocketStub(
    happyStatisticsSteps("sensor.example_temperature"),
    () =>
      run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T02:00:00Z",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "statistics")!;
  const points = statisticsResult.result["sensor.example_temperature"];
  assertEquals(res.payload.count, points.length);
  const csvLines = (res.payload.csv as string).trim().split("\n");
  assertEquals(csvLines[0], "start,end,mean,min,max,last_reset,state,sum");
  assertEquals(csvLines.length, 1 + points.length);
  const firstRow = csvLines[1].split(",");
  assertEquals(firstRow[0], new Date(points[0].start).toISOString());
  assertEquals(firstRow[1], new Date(points[0].end).toISOString());
  assertEquals(firstRow[5], ""); // last_reset: null -> "" via `?? ""`
});

// ---------------------------------------------------------------------------
// error.json contract — generic HA REST error envelope
// ---------------------------------------------------------------------------

Deno.test("contract: error.json — haFetch throws the RAW response text verbatim (never re-parsed/re-serialized)", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withOneResponse(errorFixture, 404, async () => {
    try {
      await run("get-state", { entityId: "sensor.does_not_exist" }, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assert(threw instanceof Error);
  assertEquals(
    (threw as Error).message,
    `HA API GET /states/sensor.does_not_exist failed: 404 - ${
      JSON.stringify(errorFixture)
    }`,
  );
});
