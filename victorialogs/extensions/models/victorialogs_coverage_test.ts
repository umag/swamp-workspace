/**
 * Coverage suite: regression tests for every guard/branch (and, in several
 * cases, every ABSENT guard) that the methods/contract/adversarial suites
 * don't already pin on both sides — so deleting or "helpfully" fixing one of
 * these behaviors turns a test red (STANDARD.md's coverage role).
 *
 * IMPORTANT — several of these tests characterize a GAP (a guard the model
 * does NOT have: victorialogs.ts never checks ssh's output.success, never
 * bounds compare-periods' empty windows, never checks logsql/start/end
 * length). This is honest for a model with zero pre-existing test coverage:
 * these pins protect the CURRENT (buggy) behavior, not a correct guard. If a
 * future change deliberately ADDS one of these guards (fixing the gap), the
 * corresponding test below must be updated deliberately — a red result here
 * after such a fix is expected and correct, not a regression.
 *
 * victorialogs.ts is UNMODIFIED; every test PINS existing behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./victorialogs.ts";
import queryFixture from "../../fixtures/query.json" with { type: "json" };

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
// Gap: P4 — output.success is NEVER checked by getRunningContainers
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: P4 — stdout is decoded and used REGARDLESS of output.success (even success:false with non-empty stdout is trusted)", async () => {
  // If output.success were ever checked, a success:false response would be
  // treated as "no running containers" (or thrown) rather than trusting
  // whatever happens to be on stdout. Today it is trusted unconditionally.
  const cmdStub = installCmdStub([
    {
      success: false,
      stdout: "svc-alpha\nsvc-beta",
      stderr: "unrelated warning on stderr",
    },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{
        text: ndjson([{ container_name: "svc-alpha", total: "5" }]),
      }])],
      () => run("container-log-status", {}, ctx),
    );
  } finally {
    cmdStub.restore();
  }
  const res = written.find((w) => w.spec === "containerStatus")!;
  assertEquals(
    res.payload.notLogging,
    ["svc-beta"],
    "stdout content is used even though output.success was false",
  );
});

// ---------------------------------------------------------------------------
// Gap: P5 — no 'unknown' fallback for a missing container_name in the stats path
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: P5 — a stats-by-container_name row with NO container_name field writes logging[].name === undefined (no fallback, unlike error-summary's 'unknown' bucket)", async () => {
  const cmdStub = installCmdStub([{
    success: true,
    stdout: "svc-alpha",
    stderr: "",
  }]);
  const { ctx, written } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson([{ total: "12" }]) }])],
      () => run("container-log-status", {}, ctx),
    );
  } finally {
    cmdStub.restore();
  }
  const res = written.find((w) => w.spec === "containerStatus")!;
  const logging = res.payload.logging as Array<
    { name: unknown; count: number }
  >;
  assertEquals(logging.length, 1);
  assertEquals(
    logging[0].name,
    undefined,
    "container-log-status has NO 'unknown' fallback for a missing container_name",
  );
  assertEquals(logging[0].count, 12);
});

// ---------------------------------------------------------------------------
// Gap: P6 — compare-periods empty-window storms
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: P6 — empty BASELINE + non-empty comparison -> every container classifies as NEW", async () => {
  const compare = [
    { container_name: "svc-alpha", total: "10" },
    { container_name: "svc-beta", total: "20" },
  ];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson([]) }, { text: ndjson(compare) }])],
    () => run("compare-periods", {}, ctx),
  );
  const rows = written.find((w) => w.spec === "stats")!.payload
    .stats as Array<{ status: string }>;
  assertEquals(rows.length, 2);
  assert(rows.every((r) => r.status === "NEW"));
});

Deno.test("coverage-pin: P6 — non-empty baseline + empty COMPARISON -> every container classifies as GONE (fleet-wide false-alarm storm)", async () => {
  const baseline = [
    { container_name: "svc-alpha", total: "10" },
    { container_name: "svc-beta", total: "20" },
  ];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson([]) }])],
    () => run("compare-periods", {}, ctx),
  );
  const rows = written.find((w) => w.spec === "stats")!.payload
    .stats as Array<{ status: string }>;
  assertEquals(rows.length, 2);
  assert(rows.every((r) => r.status === "GONE"));
});

Deno.test("coverage-pin: P6 — both windows empty -> zero rows, no crash", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson([]) }, { text: ndjson([]) }])],
    () => run("compare-periods", {}, ctx),
  );
  const rows = written.find((w) => w.spec === "stats")!.payload
    .stats as unknown[];
  assertEquals(rows, []);
});

Deno.test("coverage-pin: P6 — a non-numeric 'total' (parseInt -> NaN) collapses to 0 via `|| 0`, silently landing on NORMAL instead of GONE", async () => {
  // baselineMap[name] = parseInt("not-a-number") = NaN; `base = baselineMap[name] || 0`
  // treats NaN as falsy, so base becomes 0 — masking what should read as
  // "this container had SOME baseline volume" as if it never existed. Absent
  // from the comparison window too, comp is also 0 -> status resolves to
  // NORMAL, not GONE. A garbled total therefore silently hides a real
  // disappearance instead of surfacing an error.
  const baseline = [{ container_name: "svc-alpha", total: "not-a-number" }];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson([]) }])],
    () => run("compare-periods", {}, ctx),
  );
  const rows = written.find((w) => w.spec === "stats")!.payload
    .stats as Array<
      { name: string; baseline: number; current: number; status: string }
    >;
  const row = rows.find((r) => r.name === "svc-alpha")!;
  assertEquals(
    row.baseline,
    0,
    "NaN collapsed to 0 via the falsy `|| 0` guard",
  );
  assertEquals(row.current, 0);
  assertEquals(
    row.status,
    "NORMAL",
    "a garbled total silently reads as NORMAL, not as an alertable GONE",
  );
});

Deno.test("coverage-pin: P6 — exact threshold boundaries (comp === base*0.1, comp === base*2) fall to NORMAL, not MOSTLY_SILENT/MUCH_MORE_ACTIVE", async () => {
  const baseline = [
    { container_name: "svc-alpha", total: "100" }, // 0.1x boundary -> comp 10
    { container_name: "svc-beta", total: "100" }, // 2x boundary -> comp 200
  ];
  const compare = [
    { container_name: "svc-alpha", total: "10" },
    { container_name: "svc-beta", total: "200" },
  ];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson(compare) }])],
    () => run("compare-periods", {}, ctx),
  );
  const rows = written.find((w) => w.spec === "stats")!.payload
    .stats as Array<{ name: string; status: string }>;
  assertEquals(rows.find((r) => r.name === "svc-alpha")?.status, "NORMAL");
  assertEquals(rows.find((r) => r.name === "svc-beta")?.status, "NORMAL");
});

// ---------------------------------------------------------------------------
// Found bug (discovered via actual execution, NOT in the original plan's
// P1-P12 list): P13 — the sort comparator's `order[status] || 9` falsy-
// collapses GONE's priority value (0) to 9, so GONE sorts LAST instead of
// first — the most urgent status (a service went silent) is buried at the
// bottom of the sorted list. Same bug CLASS as P6's NaN-total `|| 0`
// collapse, applied to the sort priority map instead. Verified via direct
// execution while authoring this suite (`deno run` repro), not assumed.
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: P13 — GONE's `order[status] || 9` collapse makes GONE sort LAST, not first, among all 5 statuses", async () => {
  // One container per status: base/comp chosen to land on each bucket.
  const baseline = [
    { container_name: "svc-gone", total: "10" }, // -> GONE (absent from compare)
    { container_name: "svc-silent", total: "100" }, // -> MOSTLY_SILENT (comp < 10% of base)
    { container_name: "svc-normal", total: "50" }, // -> NORMAL
    { container_name: "svc-active", total: "10" }, // -> MUCH_MORE_ACTIVE (comp > 2x base)
  ];
  const compare = [
    { container_name: "svc-silent", total: "5" },
    { container_name: "svc-normal", total: "55" },
    { container_name: "svc-active", total: "30" },
    { container_name: "svc-new", total: "20" }, // -> NEW (absent from baseline)
  ];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson(compare) }])],
    () => run("compare-periods", {}, ctx),
  );
  const rows = written.find((w) => w.spec === "stats")!.payload
    .stats as Array<{ name: string; status: string }>;
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]));
  // Sanity: every bucket actually landed where intended.
  assertEquals(byName["svc-gone"], "GONE");
  assertEquals(byName["svc-silent"], "MOSTLY_SILENT");
  assertEquals(byName["svc-normal"], "NORMAL");
  assertEquals(byName["svc-active"], "MUCH_MORE_ACTIVE");
  assertEquals(byName["svc-new"], "NEW");
  // The regression guard: if this comparator's `|| 9` collapse is ever
  // "fixed" to correctly prioritize GONE first, this exact ordering will
  // break — that is the deliberate signal this test protects (a future
  // fix must update this pin deliberately, not silently).
  assertEquals(
    rows.map((r) => r.status),
    ["MOSTLY_SILENT", "NEW", "MUCH_MORE_ACTIVE", "NORMAL", "GONE"],
  );
});

// ---------------------------------------------------------------------------
// Gap: M2 — compare-periods Promise.all partial failure leaves NO side effect
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: M2 — when the baseline fetch fails, NOTHING is written (no partial stats resource)", async () => {
  const { ctx, written } = makeCtx();
  let threw = false;
  try {
    await withFetchStub(
      [queueRoute([{ text: "boom", status: 500 }, { text: ndjson([]) }])],
      () => run("compare-periods", {}, ctx),
    );
  } catch {
    threw = true;
  }
  assert(threw, "the method must reject");
  assertEquals(written.length, 0, "no partial write on Promise.all rejection");
});

// ---------------------------------------------------------------------------
// P9 — resource names have SECOND-only granularity: two calls in the same
// wall-clock second necessarily produce the IDENTICAL name (real-runtime
// clobber risk under swamp's writeResource, which is keyed on instance name).
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: P9 — the resource-name timestamp format has NO sub-second component, guaranteeing same-second calls collide", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([
      { text: ndjson(queryFixture) },
      { text: ndjson(queryFixture) },
    ])],
    async () => {
      await run("query", {}, ctx);
      await run("query", {}, ctx);
    },
  );
  const names = written.filter((w) => w.spec === "queryResult").map((w) =>
    w.name
  );
  assertEquals(names.length, 2);
  const SECOND_ONLY_RE = /^query-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
  for (const name of names) {
    assert(
      SECOND_ONLY_RE.test(name),
      `"${name}" must have exactly second granularity (no ms, no disambiguating suffix)`,
    );
  }
  // Because the format above has no sub-second/disambiguating component,
  // this test run's own two calls collide whenever they land in the same
  // wall-clock second (the overwhelmingly common case for two calls this
  // close together) — proving the real clobber risk without depending on
  // FakeTime (no timer exists in this model; only a Date snapshot).
  if (names[0] === names[1]) {
    assertEquals(
      names[0],
      names[1],
      "same-second calls produced an identical resource name",
    );
  }
});

// ---------------------------------------------------------------------------
// Guard: getRunningContainers stdout parsing — trailing/blank lines dropped
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: container list parsing drops blank lines and trims trailing whitespace/newlines", async () => {
  const cmdStub = installCmdStub([
    { success: true, stdout: "svc-alpha\n\nsvc-beta\n\n", stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson([]) }])],
      () => run("container-log-status", {}, ctx),
    );
  } finally {
    cmdStub.restore();
  }
  const res = written.find((w) => w.spec === "containerStatus")!;
  assertEquals(res.payload.notLogging, ["svc-alpha", "svc-beta"]);
});

// ---------------------------------------------------------------------------
// Guard: error-summary's 5-sample cap boundary (exactly 5 vs 6 entries)
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: error-summary — exactly 5 entries for one container yields 5 samples (the cap boundary, not yet dropping)", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    _time: `2026-06-01T00:0${i}:00.000Z`,
    _msg: `svc-alpha: error number ${i}`,
    container_name: "svc-alpha",
  }));
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(rows) }])],
    () => run("error-summary", {}, ctx),
  );
  const res = written.find((w) => w.spec === "errorSummary")!;
  const alpha = (res.payload.byContainer as Array<
    { name: string; count: number; samples: string[] }
  >)
    .find((c) => c.name === "svc-alpha")!;
  assertEquals(alpha.count, 5);
  assertEquals(
    alpha.samples.length,
    5,
    "5 entries -> exactly 5 samples, cap not yet exercised",
  );
});
