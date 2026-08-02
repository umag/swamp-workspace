/**
 * Adversarial suite: hostile WebSocket scenarios (id correlation, close
 * handling, auth_invalid, error events, malformed frames, mid-sequence
 * connection drops driven by FakeTime), unencoded REST path injection,
 * hostile-echo token-leak scenarios on both the WS and REST error paths, and
 * a mechanical fixtures-secret-scan over homeassistant/fixtures/*.json.
 *
 * homeassistant.ts v2026.08.01.1 folds in fixes for the two HIGH items
 * tracked in the local `homeassistant-latent-bugs` issue-lifecycle model:
 * `fetchStatistics` now correlates `type:"result"` frames against the id it
 * sent (ignoring foreign ids) and registers a `close` listener so a clean
 * server-side close rejects immediately instead of hanging for 60s. Those
 * two behaviors are exercised as FIX tests below (labeled "fix:"), not pins.
 * Every other item — including the remaining MED/LOW findings — is still
 * characterized rather than fixed and is labeled "pin". All 9 originally
 * tracked items are covered somewhere in this file or in
 * homeassistant_coverage_test.ts.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
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
  // A burst of frames delivered synchronously within ONE delivery tick (no
  // intervening `ws.send()`) — needed to script "ignore this frame, keep
  // waiting" followed by the frame that actually settles the call, since
  // the model issues no further `send()` between them.
  | { kind: "messages"; frames: WSFrame[] }
  | { kind: "raw"; data: string }
  | { kind: "error"; message?: string }
  | { kind: "close" }
  | { kind: "none" };

function msg(frame: WSFrame): WSStep {
  return { kind: "message", frame };
}

function msgBurst(frames: WSFrame[]): WSStep {
  return { kind: "messages", frames };
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
    // Deliberately a no-op: the fake only ever fires a "close" event when a
    // test explicitly scripts { kind: "close" } — matching what this suite
    // needs to pin (fetchStatistics never registers a close listener at
    // all; see closeListenerCount above).
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
    } else if (step.kind === "messages") {
      for (const frame of step.frames) {
        for (const l of this.#messageListeners) {
          l({ data: JSON.stringify(frame) });
        }
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
 * FakeWebSocket instance created (one per `new WebSocket()` call). */
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

const TEMP_POINTS = statisticsResult.result["sensor.example_temperature"];

function statisticsArgs(overrides: Record<string, unknown> = {}) {
  return {
    statisticId: "sensor.example_temperature",
    startTime: "2026-01-01T00:00:00Z",
    endTime: "2026-01-01T02:00:00Z",
    ...overrides,
  };
}

// =============================================================================
// Hostile WebSocket scenarios
// =============================================================================

Deno.test("fix: a foreign id:999 result is IGNORED — only the matching id:1 result resolves the call (flip of the former no-correlation pin)", async () => {
  const { ctx, written } = makeCtx();
  const steps: WSStep[] = [
    AUTH_REQUIRED,
    AUTH_OK,
    // The command frame the model sends carries id:1 (see the wire
    // assertion in the methods suite). The model issues no further `send()`
    // after AUTH_OK, so both frames below must land in the SAME delivery
    // tick (msgBurst) — a foreign id (999) arrives first and must be
    // ignored entirely (no resolve, no reject, no close), leaving the call
    // pending until the matching id:1 result, delivered right after it,
    // settles the promise.
    msgBurst([
      {
        id: 999,
        type: "result",
        success: true,
        result: { "sensor.example_temperature": [{ start: 0, mean: 999 }] },
      },
      {
        id: 1,
        type: "result",
        success: true,
        result: { "sensor.example_temperature": TEMP_POINTS },
      },
    ]),
  ];
  await withWebSocketStub(
    steps,
    () => run("get-statistics", statisticsArgs(), ctx),
  );
  const res = written.find((w) => w.spec === "statistics")!;
  assertEquals(
    res.payload.count,
    TEMP_POINTS.length,
    "must resolve on the MATCHING id:1 result — the foreign id:999 result " +
      "must be silently ignored, not resolved on",
  );
});

Deno.test("pin: auth_invalid rejects with 'Auth invalid: <server message>'", async () => {
  const { ctx } = makeCtx();
  const steps: WSStep[] = [
    AUTH_REQUIRED,
    msg({ type: "auth_invalid", message: "Invalid access token" }),
  ];
  await withWebSocketStub(steps, () =>
    assertRejects(
      () => run("get-statistics", statisticsArgs(), ctx),
      Error,
      "Auth invalid: Invalid access token",
    ));
});

Deno.test("pin: a ws.close() failure is swallowed silently by every close() call site's try/catch — the caller still sees the ORIGINAL rejection reason, never a close-time error", async () => {
  // A standalone (non-shared) fake, deliberately NOT the harness FakeWebSocket
  // above: its close() THROWS, to prove the model's `try { ws.close() }
  // catch { /* ignore close errors */ }` wrapper actually swallows a
  // close-time failure rather than letting it clobber the real rejection
  // reason (auth_invalid, in this scenario).
  const original = globalThis.WebSocket;
  class ThrowingCloseSocket {
    url: string;
    #messageListeners: MessageListener[] = [];
    constructor(url: string) {
      this.url = url;
      queueMicrotask(() => this.#emit({ type: "auth_required" }));
    }
    addEventListener(type: "message", listener: MessageListener) {
      if (type === "message") this.#messageListeners.push(listener);
    }
    send(_raw: string) {
      queueMicrotask(() =>
        this.#emit({ type: "auth_invalid", message: "bad token" })
      );
    }
    close() {
      throw new Error("close failed: simulated transport error");
    }
    #emit(frame: WSFrame) {
      for (const l of this.#messageListeners) {
        l({ data: JSON.stringify(frame) });
      }
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).WebSocket = ThrowingCloseSocket;
  try {
    const { ctx } = makeCtx();
    await assertRejects(
      () => run("get-statistics", statisticsArgs(), ctx),
      Error,
      "Auth invalid: bad token",
    );
  } finally {
    globalThis.WebSocket = original;
  }
});

Deno.test("fix: a ws.close() failure is now SURFACED via logger.warning (redacted) — the rejection reason is still unchanged, never clobbered by the close-time error", async () => {
  // Same shape as the pin above, but the close() failure ECHOES the caller's
  // own token — proving closeQuietly's logger.warning call is redacted, not
  // just added.
  const original = globalThis.WebSocket;
  class ThrowingCloseSocket {
    url: string;
    #messageListeners: MessageListener[] = [];
    constructor(url: string) {
      this.url = url;
      queueMicrotask(() => this.#emit({ type: "auth_required" }));
    }
    addEventListener(type: "message", listener: MessageListener) {
      if (type === "message") this.#messageListeners.push(listener);
    }
    send(_raw: string) {
      queueMicrotask(() =>
        this.#emit({ type: "auth_invalid", message: "bad token" })
      );
    }
    close() {
      throw new Error(`close failed: leaked token ${FAKE_TOKEN}`);
    }
    #emit(frame: WSFrame) {
      for (const l of this.#messageListeners) {
        l({ data: JSON.stringify(frame) });
      }
    }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).WebSocket = ThrowingCloseSocket;
  try {
    const { ctx, logs } = makeCtx();
    await assertRejects(
      () => run("get-statistics", statisticsArgs(), ctx),
      Error,
      "Auth invalid: bad token",
    );
    const warnings = logs.filter((l) => l.level === "warning");
    assertEquals(warnings.length, 1, "exactly one close-failure warning");
    const logged = JSON.stringify(warnings[0].args);
    assert(
      logged.includes("WebSocket close failed"),
      "the warning must identify the close failure",
    );
    assert(
      !logged.includes(FAKE_TOKEN),
      "the close-time error's token echo must be redacted before logging",
    );
  } finally {
    globalThis.WebSocket = original;
  }
});

Deno.test("fix: wsTimeoutMs global arg overrides the 60s default — a 1000ms timeout rejects with 'WebSocket timeout after 1s'", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx({
    host: "ha.example.test",
    token: FAKE_TOKEN,
    protocol: "https",
    wsTimeoutMs: 1000,
  });
  const promise = withWebSocketStub(
    [AUTH_REQUIRED, AUTH_OK, { kind: "none" }],
    () => run("get-statistics", statisticsArgs(), ctx),
  );
  const rejects = assertRejects(
    () => promise,
    Error,
    "WebSocket timeout after 1s",
  );
  await time.tickAsync(1000);
  await rejects;
});

Deno.test("pin: a native 'error' event rejects with 'WS error: <message>', falling back to the event type when no message is present", async () => {
  const { ctx } = makeCtx();
  await withWebSocketStub(
    [{ kind: "error", message: "connection refused" }],
    () =>
      assertRejects(
        () => run("get-statistics", statisticsArgs(), ctx),
        Error,
        "WS error: connection refused",
      ),
  );
  const { ctx: ctx2 } = makeCtx();
  await withWebSocketStub(
    [{ kind: "error" }], // no message -> falls back to the event's `.type`
    () =>
      assertRejects(
        () => run("get-statistics", statisticsArgs(), ctx2),
        Error,
        "WS error: error",
      ),
  );
});

Deno.test("fix: a malformed (non-JSON) frame fast-rejects with 'WebSocket received a non-JSON frame' — no 60s wait, no FakeTime needed (flip of the former silent-swallow pin)", async () => {
  const { ctx } = makeCtx();
  await withWebSocketStub(
    [{ kind: "raw", data: "not-json{" }],
    () =>
      assertRejects(
        () => run("get-statistics", statisticsArgs(), ctx),
        Error,
        "WebSocket received a non-JSON frame",
      ),
  );
});

Deno.test("fix: a non-JSON frame arriving mid-handshake (after auth_ok) also fast-rejects, not just a first-frame malformed reply", async () => {
  const { ctx } = makeCtx();
  const steps: WSStep[] = [AUTH_REQUIRED, AUTH_OK, {
    kind: "raw",
    data: "still-not-json",
  }];
  await withWebSocketStub(
    steps,
    () =>
      assertRejects(
        () => run("get-statistics", statisticsArgs(), ctx),
        Error,
        "WebSocket received a non-JSON frame",
      ),
  );
});

Deno.test("fix: an explicit close before any result rejects fast with 'WebSocket closed before result' — no 60s wait — and registers exactly one close listener", async () => {
  const { ctx } = makeCtx();
  const steps: WSStep[] = [AUTH_REQUIRED, AUTH_OK, { kind: "close" }];
  const sockets = await withWebSocketStub(steps, async (sockets) => {
    await assertRejects(
      () => run("get-statistics", statisticsArgs(), ctx),
      Error,
      "WebSocket closed before result",
    );
    return sockets;
  });
  assertEquals(
    sockets[0].closeListenerCount,
    1,
    "fetchStatistics must register exactly one close listener so a clean " +
      "server-side close rejects immediately instead of hanging for 60s",
  );
});

Deno.test("pin: a mid-sequence connection drop (no close, no error, no result) still hangs until the 60s timeout — a close listener IS registered, but a silent drop never fires a close event", async () => {
  using time = new FakeTime();
  const { ctx } = makeCtx();
  const steps: WSStep[] = [AUTH_REQUIRED, AUTH_OK, { kind: "none" }];
  const sockets = await withWebSocketStub(steps, async (sockets) => {
    const promise = run("get-statistics", statisticsArgs(), ctx);
    const rejects = assertRejects(
      () => promise,
      Error,
      "WebSocket timeout after 60s",
    );
    await time.tickAsync(60_000);
    await rejects;
    return sockets;
  });
  assertEquals(
    sockets[0].closeListenerCount,
    1,
    "fetchStatistics now registers a close listener (see the close-before-" +
      "result fix test above) — but a SILENT drop never fires a close " +
      "event, so the listener never runs and the call still hangs until " +
      "the 60s timeout",
  );
});

Deno.test("fix: a server that echoes the caller's own token back inside auth_invalid.message is now REDACTED in the thrown error (flip of the former token-leak pin)", async () => {
  const { ctx } = makeCtx();
  const steps: WSStep[] = [
    AUTH_REQUIRED,
    msg({
      type: "auth_invalid",
      message: `Invalid token: ${FAKE_TOKEN}`,
    }),
  ];
  await withWebSocketStub(steps, async () => {
    const err = await assertRejects(() =>
      run("get-statistics", statisticsArgs(), ctx)
    );
    assert(
      !String(err).includes(FAKE_TOKEN),
      "the token must never appear in the thrown error's message",
    );
    assert(
      String(err).includes("<redacted>"),
      "the redacted placeholder must stand in for the scrubbed token",
    );
  });
});

// =============================================================================
// Hostile REST: unencoded path interpolation
// =============================================================================

Deno.test("fix: get-state now encodeURIComponent()s entityId — a '/' is escaped to %2F into ONE opaque path segment, not an extra one (flip of the former no-encoding pin)", async () => {
  // NOTE: a payload using "/../" would be collapsed by the URL parser's own
  // dot-segment normalization (RFC 3986) regardless of what homeassistant.ts
  // does — that would test URL(), not the model. A plain extra "/" segment
  // (no dot-navigation) isolates the model's encoding specifically.
  const { ctx } = makeCtx();
  await withOneResponse(states[0], 200, async (calls) => {
    await run(
      "get-state",
      { entityId: "sensor.example_id/extra_segment" },
      ctx,
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/states/sensor.example_id%2Fextra_segment",
    );
  });
});

Deno.test("fix: call-service now encodeURIComponent()s domain/service — a '/' is escaped to %2F (flip of the former no-encoding pin)", async () => {
  const { ctx } = makeCtx();
  await withOneResponse({}, 200, async (calls) => {
    await run(
      "call-service",
      { domain: "light/extra_segment", service: "turn_on" },
      ctx,
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/services/light%2Fextra_segment/turn_on",
    );
  });
});

Deno.test("fix: get-automation-config / update-automation now encodeURIComponent() automationId — a '/' is escaped to %2F (flip of the former no-encoding pin)", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(automationConfig, 200, async (calls) => {
    await run(
      "get-automation-config",
      { automationId: "1/extra_segment" },
      ctx,
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/config/automation/config/1%2Fextra_segment",
    );
  });
  await withOneResponse({}, 200, async (calls) => {
    await run(
      "update-automation",
      { automationId: "1/extra_segment", config: {} },
      ctx,
    );
    assertEquals(
      new URL(calls[0].url).pathname,
      "/api/config/automation/config/1%2Fextra_segment",
    );
  });
});

Deno.test("contrast: get-history DOES encodeURIComponent its entityId (and start/end) — the same hostile value stays inside ONE query param, unlike the raw path interpolation above", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(history, 200, async (calls) => {
    await run("get-history", {
      entityId: "sensor.example/../secret",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T03:00:00Z",
    }, ctx);
    const url = new URL(calls[0].url);
    assertEquals(
      url.searchParams.get("filter_entity_id"),
      "sensor.example/../secret",
      "encodeURIComponent round-trips through URL parsing back to the original string",
    );
    assert(
      !url.pathname.includes("secret"),
      "the hostile value must never appear as an extra PATH segment — it stays inside the query string",
    );
  });
});

// =============================================================================
// Hostile REST: a 401 body echoing the token leaks
// =============================================================================

Deno.test("fix: a hostile 401 response body echoing the caller's token is now REDACTED in the thrown error (mirrors the WS auth_invalid.message fix above; flip of the former token-leak pin)", async () => {
  const { ctx } = makeCtx();
  const hostileBody = { message: `Unauthorized: token ${FAKE_TOKEN} rejected` };
  await withOneResponse(hostileBody, 401, async () => {
    const err = await assertRejects(
      () => run("get-state", { entityId: "sensor.example_temperature" }, ctx),
    );
    assert(
      !String(err).includes(FAKE_TOKEN),
      "the token must never appear in the thrown error's message",
    );
    assert(
      String(err).includes("<redacted>"),
      "the redacted placeholder must stand in for the scrubbed token",
    );
  });
});

// =============================================================================
// Hostile CSV content: get-history / get-statistics builders do NOT escape
// commas — only get-history escapes quotes (see the coverage suite's
// quote-escaping pin). A comma in a wire value corrupts the column count.
// =============================================================================

Deno.test("pin: a get-history state value containing a comma corrupts the CSV column count (no comma-escaping, only quote-escaping exists)", async () => {
  const { ctx, written } = makeCtx();
  const rows = [{
    entity_id: "sensor.example_temperature",
    state: "on, but flickering",
    last_changed: "2026-01-01T00:00:00Z",
  }];
  await withOneResponse([rows], 200, () =>
    run("get-history", {
      entityId: "sensor.example_temperature",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T01:00:00Z",
    }, ctx));
  const res = written.find((w) => w.spec === "history-csv")!;
  const dataLine = (res.payload.csv as string).trim().split("\n")[1];
  assertEquals(
    dataLine.split(",").length,
    3,
    "the unescaped comma inside the state value splits into an EXTRA column " +
      "(timestamp, 'on', ' but flickering') instead of the intended 2",
  );
});

Deno.test("pin: a get-statistics point whose `state` field is a comma-containing string ALSO corrupts its CSV row (the row builder does .join(',') with zero escaping)", async () => {
  const { ctx, written } = makeCtx();
  const points = [{
    start: 1735689600000,
    end: 1735693200000,
    mean: 1,
    min: 1,
    max: 1,
    last_reset: null,
    state: "flickering, unstable",
    sum: null,
  }];
  const steps: WSStep[] = [
    AUTH_REQUIRED,
    AUTH_OK,
    msg({
      id: 1,
      type: "result",
      success: true,
      result: { "sensor.example_temperature": points },
    }),
  ];
  await withWebSocketStub(
    steps,
    () =>
      run("get-statistics", {
        statisticId: "sensor.example_temperature",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T02:00:00Z",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "statistics")!;
  const dataLine = (res.payload.csv as string).trim().split("\n")[1];
  assertEquals(
    dataLine.split(",").length,
    9,
    "8 documented columns + 1 extra from the unescaped comma inside `state`",
  );
});

// =============================================================================
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// =============================================================================

// A real Home Assistant long-lived access token is a JWT: three base64url
// segments, `eyJ`-prefixed (the base64 encoding of `{"`).
const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/;
const HA_TOKEN_NAME_RE = /\bHA_TOKEN\b/;
const BEARER_RE = /Bearer\s/;
// Entirely 32+ alnum/base64url characters, no separators — none of our
// authored fixture values (entity ids, timestamps, short descriptions)
// match this shape.
const HIGH_ENTROPY_RE = /^[A-Za-z0-9+/_=-]{32,}$/;
const REAL_HOST_RE = /\.aopab\.art\b/i;
const RFC1918_RE =
  /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;

// Real container/extension/host names from this homelab (defense-in-depth,
// mirrors the victorialogs precedent's REAL_NAME_DENYLIST). Kept to tokens
// of 4+ characters to avoid noisy short-substring false positives.
const REAL_NAME_DENYLIST: string[] = [
  "aopab",
  "zeroclaw",
  "unraid",
  "traefik",
  "mikrotik",
  "unifi",
  "pihole",
  "grafana",
  "prometheus",
  "victoriametrics",
  "kandev",
  "kaiten",
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
  "states.json": states,
  "services.json": services,
  "automation-config.json": automationConfig,
  "history.json": history,
  "statistics-result.json": statisticsResult,
  "error.json": errorFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a JWT-shaped token, the HA_TOKEN vault key name, a Bearer prefix, a high-entropy blob, a real *.aopab.art host, or an RFC1918 address", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      if (JWT_RE.test(str)) {
        violations.push(`${file}: "${str}" matches JWT shape`);
      }
      if (HA_TOKEN_NAME_RE.test(str)) {
        violations.push(
          `${file}: "${str}" contains the HA_TOKEN vault key name`,
        );
      }
      if (BEARER_RE.test(str)) {
        violations.push(`${file}: "${str}" contains a Bearer prefix`);
      }
      if (HIGH_ENTROPY_RE.test(str)) {
        violations.push(
          `${file}: "${str}" is a high-entropy token-shaped value`,
        );
      }
      if (REAL_HOST_RE.test(str)) {
        violations.push(`${file}: "${str}" contains a real *.aopab.art host`);
      }
      if (RFC1918_RE.test(str)) {
        violations.push(`${file}: "${str}" contains an RFC1918 address`);
      }
      const lower = str.toLowerCase();
      for (const real of REAL_NAME_DENYLIST) {
        if (lower.includes(real)) {
          violations.push(
            `${file}: "${str}" contains denylisted name "${real}"`,
          );
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret/real-name content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected JWT, a denylisted real name, and a high-entropy shape (anti-vacuity)", () => {
  const poisonedJwt = {
    token:
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.dGhpc2lzYXNpZ25hdHVyZXBhcnQ",
  };
  const poisonedName = { note: "the mikrotik router restarted" };
  const poisonedEntropy = { blob: "a".repeat(40) };
  const jwtViolations = collectStrings(poisonedJwt).filter((s) =>
    JWT_RE.test(s)
  );
  const nameViolations = collectStrings(poisonedName).filter((s) =>
    REAL_NAME_DENYLIST.some((real) => s.toLowerCase().includes(real))
  );
  const entropyViolations = collectStrings(poisonedEntropy).filter((s) =>
    HIGH_ENTROPY_RE.test(s)
  );
  assert(
    jwtViolations.length > 0,
    "sanity: scanner must flag a real JWT shape",
  );
  assert(
    nameViolations.length > 0,
    "sanity: scanner must flag a real denylisted name",
  );
  assert(
    entropyViolations.length > 0,
    "sanity: scanner must flag a high-entropy shape",
  );
});
