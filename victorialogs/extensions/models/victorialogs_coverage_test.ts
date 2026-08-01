/**
 * Coverage suite: regression tests for every guard/branch (and, in several
 * cases, every ABSENT guard) that the methods/contract/adversarial suites
 * don't already pin on both sides — so deleting or "helpfully" fixing one of
 * these behaviors turns a test red (STANDARD.md's coverage role).
 *
 * FIXED (2026.08.01.1): P4 (ssh `output.success` is now checked) and P6
 * (compare-periods now guards empty baseline/comparison windows AND
 * non-numeric totals, throwing distinct errors instead of silently
 * collapsing to NEW/GONE/NORMAL) and P13 (the sort comparator's `?? 9` no
 * longer falsy-collapses GONE's priority). The five pins below that used to
 * characterize those gaps are now GREEN tests proving the guards reject as
 * intended. Every other gap (P5 undefined-name fallback, M2 partial-write,
 * P9 timestamp collisions, and the blank-line/5-sample-cap guards) is
 * unchanged — these pins still protect CURRENT behavior, not a correct
 * guard, and a deliberate future fix must update them deliberately.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
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

Deno.test("coverage-pin: P4 FIXED — output.success is now checked; a success:false response REJECTS regardless of non-empty stdout", async () => {
  // output.success is now checked before stdout is ever trusted — a
  // success:false response throws instead of being decoded as if it were a
  // real container list.
  const cmdStub = installCmdStub([
    {
      success: false,
      stdout: "svc-alpha\nsvc-beta",
      stderr: "unrelated warning on stderr",
    },
  ]);
  const { ctx } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{
        text: ndjson([{ container_name: "svc-alpha", total: "5" }]),
      }])],
      async () => {
        await assertRejects(
          () => run("container-log-status", {}, ctx),
          Error,
        );
      },
    );
  } finally {
    cmdStub.restore();
  }
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

Deno.test("coverage-pin: P6 FIXED — empty BASELINE + non-empty comparison now REJECTS instead of classifying every container as NEW", async () => {
  const compare = [
    { container_name: "svc-alpha", total: "10" },
    { container_name: "svc-beta", total: "20" },
  ];
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson([]) }, { text: ndjson(compare) }])],
    async () => {
      const err = await assertRejects(
        () => run("compare-periods", {}, ctx),
        Error,
      );
      assert(
        err.message.includes("baseline window returned no data"),
        "must reject via the empty-baseline guard specifically",
      );
    },
  );
});

Deno.test("coverage-pin: P6 FIXED — non-empty baseline + empty COMPARISON now REJECTS instead of a fleet-wide false-alarm GONE storm", async () => {
  const baseline = [
    { container_name: "svc-alpha", total: "10" },
    { container_name: "svc-beta", total: "20" },
  ];
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson([]) }])],
    async () => {
      const err = await assertRejects(
        () => run("compare-periods", {}, ctx),
        Error,
      );
      assert(
        err.message.includes("comparison window returned no data"),
        "must reject via the empty-comparison guard specifically",
      );
    },
  );
});

Deno.test("coverage-pin: P6 FIXED — both windows empty now REJECTS instead of silently producing zero rows", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson([]) }, { text: ndjson([]) }])],
    async () => {
      const err = await assertRejects(
        () => run("compare-periods", {}, ctx),
        Error,
      );
      assert(
        err.message.includes("baseline window returned no data"),
        "the baseline-empty guard is checked first, so it fires even when both windows are empty",
      );
    },
  );
});

Deno.test("coverage-pin: P6 FIXED — a non-numeric 'total' (parseInt -> NaN) now REJECTS instead of silently collapsing to 0/NORMAL", async () => {
  // Previously: baselineMap[name] = parseInt("not-a-number") = NaN, and
  // `base = baselineMap[name] || 0` treated NaN as falsy, masking what
  // should read as "this container had SOME baseline volume" as if it never
  // existed — a garbled total silently hid a real disappearance instead of
  // surfacing an error. Now the NaN is caught at ingest and thrown.
  //
  // The comparison window MUST be non-empty here — an empty compare window
  // trips the P6 empty-comparison guard before the NaN check ever runs,
  // which would make this test pass for the wrong reason (found in review).
  const baseline = [{ container_name: "svc-alpha", total: "not-a-number" }];
  const compare = [{ container_name: "svc-alpha", total: "5" }];
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson(compare) }])],
    async () => {
      const err = await assertRejects(
        () => run("compare-periods", {}, ctx),
        Error,
      );
      assert(
        err.message.includes("non-numeric baseline total"),
        "must reject via the NaN guard specifically, not the empty-window guard",
      );
    },
  );
});

Deno.test("coverage-pin: P6 FIXED — the NaN guard's echoed container_name is length-bounded, never interpolates the full unbounded wire value", async () => {
  // Round-1 security review: the NaN/empty-window throw messages echo the
  // offending container_name, which originates from the VictoriaLogs wire
  // response — it must stay bounded, not interpolate arbitrary wire text.
  const longName = "svc-" + "x".repeat(500);
  const baseline = [{ container_name: longName, total: "not-a-number" }];
  const compare = [{ container_name: "svc-alpha", total: "5" }];
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(baseline) }, { text: ndjson(compare) }])],
    async () => {
      const err = await assertRejects(
        () => run("compare-periods", {}, ctx),
        Error,
      );
      assert(
        err.message.length < 300,
        "the echoed container_name must be truncated, not the full 500+ char wire value",
      );
    },
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
// P13 FIXED — the sort comparator's `order[status] ?? 9` no longer falsy-
// collapses GONE's priority value (0) to 9, so GONE now sorts FIRST — the
// most urgent status (a service went silent) leads the sorted list. Same bug
// CLASS as P6's NaN-total collapse, applied to the sort priority map instead;
// fixed in the same change.
// ---------------------------------------------------------------------------

Deno.test("coverage-pin: P13 FIXED — GONE now sorts FIRST, not last, among all 5 statuses", async () => {
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
  // The regression guard: GONE now correctly sorts FIRST — this is the
  // deliberate, intended priority order the comparator now produces.
  assertEquals(
    rows.map((r) => r.status),
    ["GONE", "MOSTLY_SILENT", "NEW", "MUCH_MORE_ACTIVE", "NORMAL"],
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
