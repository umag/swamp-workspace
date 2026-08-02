/**
 * Method-level tests for @magistr/homeassistant — every one of the 10
 * methods (list-entities, get-state, call-service, list-services,
 * list-automations, get-automation-config, update-automation, get-history,
 * get-statistics, backfill-to-vm), happy path + error path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` / a stubbed `WebSocket`, and a fake context.
 *
 * homeassistant.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * backfill-to-vm gets its FULL success AND failure/branch matrix: the happy
 * path, a non-ok VM import rejection, the "no numeric samples -> no import
 * POST issued at all" silent no-op branch, and the swallow-vs-reject
 * asymmetry between its per-entity /states haFetch (try/catch) and its
 * per-entity WS fetchStatistics (unguarded).
 *
 * Token-non-leak is asserted across all 10 methods (never in a written
 * resource, a model-constructed thrown error, or a logger call), PLUS a wire
 * assertion that the token appears in EXACTLY the WS auth frame and NEVER in
 * the recorder/statistics_during_period command frame.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
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

function text(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
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

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
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

  constructor(url: string, steps: WSStep[]) {
    this.url = url;
    this.#steps = steps;
    // The model does `new WebSocket(url)` THEN `addEventListener(...)` — a
    // REAL microtask (not a synchronous call, not a FakeTime timer)
    // guarantees listeners are attached before this fires.
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

function happySteps(
  statisticId: string,
  points: Array<Record<string, unknown>>,
): WSStep[] {
  return [
    AUTH_REQUIRED,
    AUTH_OK,
    msg({
      id: 1,
      type: "result",
      success: true,
      result: { [statisticId]: points },
    }),
  ];
}

const TEMP_POINTS = statisticsResult.result["sensor.example_temperature"];

// ---------------------------------------------------------------------------
// list-entities
// ---------------------------------------------------------------------------

Deno.test("list-entities: happy path — GETs /api/states, writes states.entities", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(states, 200, async (calls) => {
    await run("list-entities", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/states");
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[0].headers.get("Authorization"), `Bearer ${FAKE_TOKEN}`);
  });
  const res = written.find((w) => w.spec === "states")!;
  assertEquals(res.payload.count, states.length);
});

Deno.test("list-entities: domain filter narrows to the matching domain", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    states,
    200,
    () => run("list-entities", { domain: "light" }, ctx),
  );
  const res = written.find((w) => w.spec === "states")!;
  const entities = res.payload.entities as Array<{ domain: string }>;
  assertEquals(entities.length, 1);
  assertEquals(entities[0].domain, "light");
});

Deno.test("list-entities: error path — non-ok status throws 'HA API GET /states failed: <status> - <body>'", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("Internal Server Error", 500, async () => {
    await assertRejects(
      () => run("list-entities", {}, ctx),
      Error,
      "HA API GET /states failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// get-state
// ---------------------------------------------------------------------------

Deno.test("get-state: happy path — GETs /api/states/<id>, writes entity-state", async () => {
  const { ctx, written } = makeCtx();
  const fixture = states[0];
  await withOneResponse(fixture, 200, async (calls) => {
    await run("get-state", { entityId: fixture.entity_id }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      `/api/states/${fixture.entity_id}`,
    );
  });
  const res = written.find((w) => w.spec === "entity-state")!;
  assertEquals(res.payload.entityId, fixture.entity_id);
  assertEquals(res.payload.state, fixture.state);
  assertEquals(res.payload.attributes, fixture.attributes);
});

Deno.test("get-state: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("Not Found", 404, async () => {
    await assertRejects(
      () => run("get-state", { entityId: "sensor.does_not_exist" }, ctx),
      Error,
      "failed: 404",
    );
  });
});

// ---------------------------------------------------------------------------
// call-service
// ---------------------------------------------------------------------------

Deno.test("call-service: happy path — POSTs /api/services/<domain>/<service> with merged data + entity_id, writes service-result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ ok: true }, 200, async (calls) => {
    await run("call-service", {
      domain: "light",
      service: "turn_on",
      entityId: "light.example_lamp",
      data: { brightness: 200 },
    }, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/services/light/turn_on");
    assertEquals(calls[0].method, "POST");
    const body = await requestBody(calls[0]);
    assertEquals(body.brightness, 200);
    assertEquals(body.entity_id, "light.example_lamp");
  });
  const res = written.find((w) => w.spec === "service-result")!;
  assertEquals(res.payload.domain, "light");
  assertEquals(res.payload.service, "turn_on");
  assertEquals(res.payload.result, { ok: true });
});

Deno.test("call-service: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("boom", 500, async () => {
    await assertRejects(
      () => run("call-service", { domain: "light", service: "turn_on" }, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// list-services
// ---------------------------------------------------------------------------

Deno.test("list-services: happy path — GETs /api/services, writes services.domains", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(services, 200, async (calls) => {
    await run("list-services", {}, ctx);
    assertEquals(new URL(calls[0].url).pathname, "/api/services");
  });
  const res = written.find((w) => w.spec === "services")!;
  assertEquals(res.payload.count, services.length);
});

Deno.test("list-services: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("boom", 503, async () => {
    await assertRejects(
      () => run("list-services", {}, ctx),
      Error,
      "failed: 503",
    );
  });
});

// ---------------------------------------------------------------------------
// list-automations
// ---------------------------------------------------------------------------

Deno.test("list-automations: happy path — GETs /api/states, filters to automation.*", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(states, 200, () => run("list-automations", {}, ctx));
  const res = written.find((w) => w.spec === "automations")!;
  assertEquals(res.payload.count, 1);
});

Deno.test("list-automations: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("boom", 500, async () => {
    await assertRejects(
      () => run("list-automations", {}, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// get-automation-config
// ---------------------------------------------------------------------------

Deno.test("get-automation-config: happy path — GETs /api/config/automation/config/<id>, writes automation-config", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(automationConfig, 200, async (calls) => {
    await run("get-automation-config", { automationId: "1700000000000" }, ctx);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/config/automation/config/1700000000000",
    );
  });
  const res = written.find((w) => w.spec === "service-result")!;
  assertEquals(res.name, "automation-config");
  assertEquals(res.payload.data, automationConfig);
});

Deno.test("get-automation-config: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("boom", 404, async () => {
    await assertRejects(
      () => run("get-automation-config", { automationId: "999" }, ctx),
      Error,
      "failed: 404",
    );
  });
});

// ---------------------------------------------------------------------------
// update-automation
// ---------------------------------------------------------------------------

Deno.test("update-automation: happy path — POSTs the full config to /api/config/automation/config/<id>, writes update-automation-result", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse({ result: "ok" }, 200, async (calls) => {
    await run(
      "update-automation",
      { automationId: "1700000000000", config: automationConfig },
      ctx,
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/config/automation/config/1700000000000",
    );
    assertEquals(calls[0].method, "POST");
    const body = await requestBody(calls[0]);
    assertEquals(body, automationConfig);
  });
  const res = written.find((w) => w.spec === "service-result")!;
  assertEquals(res.name, "update-automation-result");
  assertEquals(res.payload.result, { result: "ok" });
});

Deno.test("update-automation: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("boom", 400, async () => {
    await assertRejects(
      () =>
        run(
          "update-automation",
          { automationId: "1", config: {} },
          ctx,
        ),
      Error,
      "failed: 400",
    );
  });
});

// ---------------------------------------------------------------------------
// get-history
// ---------------------------------------------------------------------------

Deno.test("get-history: happy path — writes both history (JSON) and history-csv resources", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(history, 200, async (calls) => {
    await run("get-history", {
      entityId: "sensor.example_temperature",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T03:00:00Z",
    }, ctx);
    const url = new URL(calls[0].url);
    assert(url.pathname.startsWith("/api/history/period/"));
    assertEquals(
      url.searchParams.get("filter_entity_id"),
      "sensor.example_temperature",
    );
  });
  assertEquals(
    written.find((w) => w.spec === "history")!.payload.count,
    history[0].length,
  );
  assertEquals(
    written.find((w) => w.spec === "history-csv")!.payload.count,
    history[0].length,
  );
});

Deno.test("get-history: error path — non-ok status throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse("boom", 500, async () => {
    await assertRejects(
      () =>
        run("get-history", {
          entityId: "sensor.example_temperature",
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T03:00:00Z",
        }, ctx),
      Error,
      "failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// get-statistics
// ---------------------------------------------------------------------------

Deno.test("get-statistics: happy path — WS handshake resolves to the scripted points, writes statistics", async () => {
  const { ctx, written } = makeCtx();
  await withWebSocketStub(
    happySteps("sensor.example_temperature", TEMP_POINTS),
    () =>
      run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T02:00:00Z",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "statistics")!;
  assertEquals(res.payload.count, TEMP_POINTS.length);
  assertEquals(res.payload.period, "hour");
});

Deno.test("get-statistics: error path — a WS result with success:false rejects with 'WS error: <JSON error>'", async () => {
  const { ctx } = makeCtx();
  const steps: WSStep[] = [
    AUTH_REQUIRED,
    AUTH_OK,
    msg({
      id: 1,
      type: "result",
      success: false,
      error: { code: "invalid_format", message: "boom" },
    }),
  ];
  await withWebSocketStub(steps, async () => {
    await assertRejects(
      () =>
        run("get-statistics", {
          statisticId: "sensor.example_temperature",
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T02:00:00Z",
        }, ctx),
      Error,
      `WS error: ${
        JSON.stringify({ code: "invalid_format", message: "boom" })
      }`,
    );
  });
});

// ---------------------------------------------------------------------------
// backfill-to-vm — full success + failure/branch matrix
// ---------------------------------------------------------------------------

const VM_URL = "http://203.0.113.10:8428";

function backfillRoutes(vmStatus = 200, vmBody: unknown = { status: "ok" }) {
  return [
    (req: Request) => {
      const url = new URL(req.url);
      if (
        url.hostname === "203.0.113.10" && url.pathname === "/api/v1/import"
      ) {
        return typeof vmBody === "string"
          ? text(vmBody, vmStatus)
          : json(vmBody, vmStatus);
      }
      if (url.pathname.startsWith("/api/states/")) {
        const entityId = url.pathname.replace("/api/states/", "");
        const fixture = states.find((s) => s.entity_id === entityId);
        return fixture
          ? json(fixture, 200)
          : json({ message: "not found" }, 404);
      }
      return undefined;
    },
  ];
}

Deno.test("backfill-to-vm: happy path — WS stats + REST /states per entity, one VM /api/v1/import POST, writes backfill-report", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(backfillRoutes(), (calls) =>
    withWebSocketStub(
      () => happySteps("sensor.example_temperature", TEMP_POINTS),
      () =>
        run("backfill-to-vm", {
          entities: [
            { entityId: "sensor.example_temperature", metricName: "ha_temp" },
          ],
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T03:00:00Z",
        }, ctx).then(() => {
          const importCall = calls.find((c) =>
            new URL(c.url).pathname === "/api/v1/import"
          );
          assert(importCall, "exactly one VM import POST must be issued");
          assertEquals(importCall!.method, "POST");
        }),
    ));
  const res = written.find((w) => w.spec === "backfill-report")!;
  assertEquals(res.payload.vmUrl, VM_URL);
  assertEquals(res.payload.totalSamples, TEMP_POINTS.length);
  const entities = res.payload.entities as Array<{ points: number }>;
  assertEquals(entities[0].points, TEMP_POINTS.length);
});

Deno.test("backfill-to-vm: pin — VM import returning non-ok rejects with 'VM import failed: <status> - <text>'", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    backfillRoutes(502, "vm down"),
    () =>
      withWebSocketStub(
        () => happySteps("sensor.example_temperature", TEMP_POINTS),
        () =>
          assertRejects(
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
            Error,
            "VM import failed: 502 - vm down",
          ),
      ),
  );
});

Deno.test("backfill-to-vm: pin — no numeric samples across all entities -> lines stay empty -> NO import POST is issued at all (silent no-op)", async () => {
  const { ctx, written } = makeCtx();
  const emptyPoints = [{
    start: 1735689600000,
    end: 1735693200000,
    mean: null,
  }];
  await withFetchStub(backfillRoutes(), (calls) =>
    withWebSocketStub(
      () => happySteps("sensor.example_temperature", emptyPoints),
      () =>
        run("backfill-to-vm", {
          entities: [
            { entityId: "sensor.example_temperature", metricName: "ha_temp" },
          ],
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T03:00:00Z",
        }, ctx).then(() => {
          const importCall = calls.find((c) =>
            new URL(c.url).pathname === "/api/v1/import"
          );
          assert(
            !importCall,
            "no numeric samples -> the VM import POST must never be issued",
          );
        }),
    ));
  const res = written.find((w) => w.spec === "backfill-report")!;
  assertEquals(res.payload.totalSamples, 0);
});

Deno.test("fix: backfill-to-vm: a per-entity WS rejection is now GUARDED — the fan-out CONTINUES, recording a redacted `error` on that entity's summary instead of tearing down the WHOLE method (flip of the former whole-fan-out-rejects pin)", async () => {
  // Entity 1: WS happy, /states succeeds normally -> fully imported.
  // Entity 2: WS rejects (auth_invalid, echoing the caller's own token) --
  // NOW guarded: fetchStatistics's rejection is caught, a redacted `error`
  // is recorded on entity 2's summary (0 points), and the loop CONTINUES
  // instead of tearing down the whole method (headphones onboard-artists /
  // seadex summary.errors precedent).
  const { ctx, written } = makeCtx();
  const importBodies: string[] = [];
  const routes: Route[] = [
    (req) => {
      const url = new URL(req.url);
      if (
        url.hostname === "203.0.113.10" && url.pathname === "/api/v1/import"
      ) {
        return req.text().then((body) => {
          importBodies.push(body);
          return json({ status: "ok" }, 200);
        });
      }
      if (url.pathname.startsWith("/api/states/")) {
        const entityId = url.pathname.replace("/api/states/", "");
        const fixture = states.find((s) => s.entity_id === entityId);
        return fixture
          ? json(fixture, 200)
          : json({ message: "not found" }, 404);
      }
      return undefined;
    },
  ];
  await withFetchStub(routes, () =>
    withWebSocketStub(
      (index: number) =>
        index === 0 ? happySteps("sensor.example_temperature", TEMP_POINTS) : [
          AUTH_REQUIRED,
          msg({
            type: "auth_invalid",
            message: `bad token: ${FAKE_TOKEN}`,
          }),
        ],
      () =>
        run("backfill-to-vm", {
          entities: [
            { entityId: "sensor.example_temperature", metricName: "ha_temp" },
            { entityId: "light.example_lamp", metricName: "ha_lamp" },
          ],
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T03:00:00Z",
        }, ctx),
    ));
  assertEquals(
    importBodies.length,
    1,
    "entity 1's samples still get imported despite entity 2's failure",
  );
  const res = written.find((w) => w.spec === "backfill-report")!;
  const entities = res.payload.entities as Array<
    { entityId: string; points: number; error?: string }
  >;
  const e1 = entities.find((e) => e.entityId === "sensor.example_temperature")!;
  const e2 = entities.find((e) => e.entityId === "light.example_lamp")!;
  assertEquals(e1.points, TEMP_POINTS.length, "entity 1 is fully imported");
  assert(!e1.error, "entity 1 has no error");
  assertEquals(e2.points, 0, "entity 2 contributes zero points");
  assert(e2.error, "entity 2's summary carries the recorded error");
  assert(
    !e2.error!.includes(FAKE_TOKEN),
    "the recorded error must be redacted, never leak the token",
  );
});

// ---------------------------------------------------------------------------
// Token non-leak — across all 10 methods
// ---------------------------------------------------------------------------

Deno.test("token never appears in any written resource or logger call across the 8 REST-only methods", async () => {
  const scenarios: Array<[string, Record<string, unknown>, unknown]> = [
    ["list-entities", {}, states],
    ["get-state", { entityId: "light.example_lamp" }, states[0]],
    [
      "call-service",
      { domain: "light", service: "turn_on", entityId: "light.example_lamp" },
      { ok: true },
    ],
    ["list-services", {}, services],
    ["list-automations", {}, states],
    [
      "get-automation-config",
      { automationId: "1700000000000" },
      automationConfig,
    ],
    [
      "update-automation",
      { automationId: "1700000000000", config: automationConfig },
      { ok: true },
    ],
    [
      "get-history",
      {
        entityId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T03:00:00Z",
      },
      history,
    ],
  ];
  for (const [name, args, response] of scenarios) {
    const { ctx, written, logs } = makeCtx();
    await withOneResponse(response, 200, () => run(name, args, ctx));
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(!s.includes(FAKE_TOKEN), `${name}: token leaked into ${w.spec}`);
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(!s.includes(FAKE_TOKEN), `${name}: token leaked into a log call`);
    }
  }
});

Deno.test("token never appears in a written resource across the 2 WS methods (get-statistics, backfill-to-vm)", async () => {
  const { ctx, written } = makeCtx();
  await withWebSocketStub(
    happySteps("sensor.example_temperature", TEMP_POINTS),
    () =>
      run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T02:00:00Z",
      }, ctx),
  );
  await withFetchStub(backfillRoutes(), () =>
    withWebSocketStub(
      () => happySteps("sensor.example_temperature", TEMP_POINTS),
      () =>
        run("backfill-to-vm", {
          entities: [
            { entityId: "sensor.example_temperature", metricName: "ha_temp" },
          ],
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T03:00:00Z",
        }, ctx),
    ));
  for (const w of written) {
    const s = JSON.stringify(w.payload);
    assert(!s.includes(FAKE_TOKEN), `token leaked into ${w.spec}/${w.name}`);
  }
});

Deno.test("wire assertion: the token appears in EXACTLY the WS auth frame, and NEVER in the recorder/statistics_during_period command frame", async () => {
  const { ctx } = makeCtx();
  const sockets = await withWebSocketStub(
    happySteps("sensor.example_temperature", TEMP_POINTS),
    async (sockets) => {
      await run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T02:00:00Z",
      }, ctx);
      return sockets;
    },
  );
  const frames = sockets[0].sentFrames;
  const authFrame = frames.find((f) => f.type === "auth")!;
  const commandFrame = frames.find((f) =>
    f.type === "recorder/statistics_during_period"
  )!;
  assert(authFrame, "an auth frame must have been sent");
  assert(
    commandFrame,
    "a recorder/statistics_during_period frame must have been sent",
  );
  assertEquals(authFrame.access_token, FAKE_TOKEN);
  assert(
    !JSON.stringify(commandFrame).includes(FAKE_TOKEN),
    "the token must never ride the command frame",
  );
});

// ---------------------------------------------------------------------------
// Logger — pin the absence of any logging today
// ---------------------------------------------------------------------------

Deno.test("no method calls the logger at all today on the HAPPY path (pin — a future change that starts logging must add its own leak test — see the new LB7 logging test below)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneResponse(states, 200, () => run("list-entities", {}, ctx));
  await withWebSocketStub(
    happySteps("sensor.example_temperature", TEMP_POINTS),
    () =>
      run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T02:00:00Z",
      }, ctx),
  );
  assertEquals(logs.length, 0);
});

Deno.test("new: LB7's per-entity backfill failure DOES log a warning — and that warning is token-redacted, never leaking the raw token (honors the pin above's own contract)", async () => {
  const { ctx, logs } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/states/")) {
        const entityId = url.pathname.replace("/api/states/", "");
        const fixture = states.find((s) => s.entity_id === entityId);
        return fixture
          ? json(fixture, 200)
          : json({ message: "not found" }, 404);
      }
      return undefined;
    }],
    () =>
      withWebSocketStub(
        [
          AUTH_REQUIRED,
          msg({
            type: "auth_invalid",
            message: `bad token: ${FAKE_TOKEN}`,
          }),
        ],
        () =>
          run("backfill-to-vm", {
            entities: [
              { entityId: "light.example_lamp", metricName: "ha_lamp" },
            ],
            startTime: "2026-01-01T00:00:00Z",
            endTime: "2026-01-01T03:00:00Z",
          }, ctx),
      ),
  );
  const warnings = logs.filter((l) => l.level === "warning");
  assert(
    warnings.length > 0,
    "the guarded per-entity failure must log a warning",
  );
  for (const l of logs) {
    assert(
      !JSON.stringify(l.args).includes(FAKE_TOKEN),
      "a logger call leaked the raw token",
    );
  }
});
