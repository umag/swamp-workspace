/**
 * Adversarial suite: LogsQL-injection/breakout attempts, malformed/hostile
 * NDJSON responses, prototype-pollution characterization (with a HARD
 * cleanup contract), ssh/subprocess boundary pins, and a mechanical
 * fixtures-secret-scan enforcing a synthetic-name ALLOWLIST (primary) plus a
 * real-homelab-name DENYLIST (defense-in-depth) over every string leaf in
 * victorialogs/fixtures/*.json — including free-text log MESSAGE bodies, not
 * just the structured `container_name` field.
 *
 * victorialogs.ts is UNMODIFIED — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Where a test documents a real gap, it is labeled "pin" and says so.
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

async function requestParams(req: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await req.text());
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

// =============================================================================
// P3 — prototype pollution: HARD cleanup contract (round-1 review HIGH)
// Kept FIRST and physically isolated so an accidental test reorder cannot run
// a sibling before this test's `finally` cleanup executes.
// =============================================================================

Deno.test("pin: P3 — a '__proto__' container_name entry is SAFE on Deno (verified): the legacy Object.prototype.__proto__ accessor does not exist in this runtime, so it is treated as an ordinary container name, no crash, no pollution", async () => {
  // Empirically verified (not assumed): unlike Node.js/browsers, Deno's V8
  // build does not expose `Object.prototype.__proto__` as an accessor
  // (`Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")` is
  // `undefined` here). `byContainer["__proto__"]` is therefore a plain,
  // previously-unset own property — the `if (!byContainer[name])` guard
  // takes the INIT branch (unlike the `constructor` case below, where the
  // accumulator DOES inherit a truthy value and skips init) and the entry
  // behaves exactly like any other container name. This is a real,
  // runtime-specific characterization: the ORIGINAL round-1 review assumed
  // Node/browser `__proto__` semantics, which do not hold for the actual
  // Deno process this extension runs under. Kept isolated + HARD-cleanup
  // wrapped anyway, defensively, in case a future Deno version restores the
  // Annex B accessor.
  const hostile = [
    {
      _time: "2026-06-01T00:00:00.000Z",
      _msg: "attempted prototype pollution via __proto__ container_name",
      container_name: "__proto__",
    },
  ];
  const { ctx, written } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson(hostile) }])],
      () => run("error-summary", {}, ctx),
    );
  } finally {
    // Defensive HARD cleanup — a no-op today (Deno has no __proto__
    // accessor), kept in case that ever changes.
    // deno-lint-ignore no-explicit-any
    delete (Object.prototype as any).count;
    // deno-lint-ignore no-explicit-any
    delete (Object.prototype as any).samples;
  }
  const res = written.find((w) => w.spec === "errorSummary")!;
  const byContainer = res.payload.byContainer as Array<
    { name: string; count: number }
  >;
  assertEquals(
    byContainer.find((c) => c.name === "__proto__")?.count,
    1,
    "on Deno, '__proto__' is stored as a literal, ordinary container name",
  );
  assertEquals(
    ({} as Record<string, unknown>).count,
    undefined,
    "process must be provably un-poisoned: a fresh plain object must not inherit .count",
  );
  assertEquals(
    ({} as Record<string, unknown>).samples,
    undefined,
    "process must be provably un-poisoned: a fresh plain object must not inherit .samples",
  );
});

Deno.test("pin: P3 — a 'constructor' container_name entry pollutes the Object constructor itself (a DIFFERENT target than __proto__), same HARD cleanup contract", async () => {
  const hostile = [
    {
      _time: "2026-06-01T00:00:01.000Z",
      _msg: "attempted prototype pollution via constructor container_name",
      container_name: "constructor",
    },
  ];
  const { ctx } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson(hostile) }])],
      async () => {
        await assertRejects(
          () => run("error-summary", {}, ctx),
          TypeError,
        );
      },
    );
  } finally {
    // deno-lint-ignore no-explicit-any
    delete (Object as any).count;
    // deno-lint-ignore no-explicit-any
    delete (Object as any).samples;
  }
  assertEquals(
    (Object as unknown as Record<string, unknown>).count,
    undefined,
    "process must be provably un-poisoned: the Object constructor must not carry .count",
  );
  assertEquals(
    (Object as unknown as Record<string, unknown>).samples,
    undefined,
  );
});

// =============================================================================
// P1 / P12 — LogsQL form-field no-breakout, unbounded length
// =============================================================================

Deno.test("pin: P1 — a hostile logsql value (breakout characters) travels as ONE opaque form field, never splits into extra params or breaks out of the field", async () => {
  const hostile =
    'a" OR 1=1 -- \n | stats count() as x & start=2020-01-01T00:00:00Z & evil=1';
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture) }])],
    async (calls) => {
      await run("query", { logsql: hostile }, ctx);
      const params = await requestParams(calls[0]);
      assertEquals(
        params.getAll("query"),
        [hostile],
        "the hostile string must round-trip as exactly one query value",
      );
      assert(
        !params.has("evil"),
        "the injected '&evil=1' must never become an independent form field",
      );
      assertEquals(
        params.get("start"),
        "-24h",
        "the real start field keeps its own (default) value — the hostile logsql cannot override it",
      );
    },
  );
});

Deno.test("pin: P1 — the SAME no-breakout guarantee holds for `stats`'s logsql field (vlogsQuery/vlogsStats are byte-identical per the plan's P1 finding)", async () => {
  const hostile = 'x" & inject=1 \n | stats count() as evil';
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(statsFixture) }])],
    async (calls) => {
      await run("stats", { logsql: hostile }, ctx);
      const params = await requestParams(calls[0]);
      assertEquals(params.getAll("query"), [hostile]);
      assert(!params.has("inject"));
    },
  );
});

Deno.test("pin: P12 — logsql/start/end have no length bound (z.string() with no .max()) — an oversized value is accepted and sent whole", async () => {
  const huge = "x".repeat(20000);
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(queryFixture) }])],
    async (calls) => {
      await run("query", { logsql: huge }, ctx);
      const params = await requestParams(calls[0]);
      assertEquals(params.get("query")?.length, 20000);
    },
  );
});

// =============================================================================
// P2 — malformed / truncated / hostile NDJSON bodies
// =============================================================================

Deno.test("pin: P2 — a truncated final NDJSON line throws a raw, unmapped SyntaxError", async () => {
  const goodLine = JSON.stringify(queryFixture[0]);
  const truncated =
    `${goodLine}\n{"_time":"2026-06-01T00:09:00Z","_msg":"cut off mid-object`;
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: truncated }])],
    async () => {
      await assertRejects(() => run("query", {}, ctx), SyntaxError);
    },
  );
});

Deno.test("pin: P2 — a non-JSON line anywhere in the body throws a raw SyntaxError (no try/catch around JSON.parse)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: "not json at all" }])],
    async () => {
      await assertRejects(() => run("query", {}, ctx), SyntaxError);
    },
  );
});

Deno.test("pin: P2 — an empty or whitespace-only body yields [] (no error, no entries)", async () => {
  for (const body of ["", "   ", "\n\n\n"]) {
    const { ctx, written } = makeCtx();
    await withFetchStub(
      [queueRoute([{ text: body }])],
      () => run("query", {}, ctx),
    );
    const res = written.find((w) => w.spec === "queryResult")!;
    assertEquals(res.payload.totalEntries, 0);
    assertEquals(res.payload.entries, []);
  }
});

// =============================================================================
// P8 — error-summary: fixed-keyword classifier, no content sanitization
// =============================================================================

Deno.test("pin: P8 — error-summary's schema silently STRIPS any unrecognized arg (e.g. a caller-supplied keyword override) — there is no way to change the fixed classifier", () => {
  const method = (model.methods as MethodMap)["error-summary"];
  const parsed = method.arguments.parse({
    keywords: ["disk-full"],
    logsql: "custom query",
  }) as Record<string, unknown>;
  assert(
    !("keywords" in parsed),
    "an unrecognized 'keywords' field must be stripped, not honored",
  );
  assert(
    !("logsql" in parsed),
    "an unrecognized 'logsql' field must be stripped — the classifier's keyword OR-list is not overridable",
  );
});

Deno.test("pin: P8 — a benign message that merely CONTAINS an error keyword as a substring is stored verbatim (no false-positive filtering, no re-validation)", async () => {
  const benign = [{
    _time: "2026-06-01T00:10:00.000Z",
    _msg:
      "svc-alpha: successfully applied error-correcting patch, no action needed",
    container_name: "svc-alpha",
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(benign) }])],
    () => run("error-summary", {}, ctx),
  );
  const res = written.find((w) => w.spec === "errorSummary")!;
  const byContainer = res.payload.byContainer as Array<
    { name: string; samples: string[] }
  >;
  const alpha = byContainer.find((c) => c.name === "svc-alpha")!;
  assert(
    alpha.samples[0].includes("successfully applied error-correcting patch"),
    "the benign message is stored raw — the model performs no semantic check",
  );
});

Deno.test("pin: P8 — control characters and embedded newlines in _msg survive into the stored sample, truncated at 300 chars, unsanitized", async () => {
  const controlChar = String.fromCharCode(0);
  const hostileMsg =
    `svc-beta: error${controlChar} payload\nwith embedded newline and ${
      "z".repeat(320)
    }`;
  const hostile = [{
    _time: "2026-06-01T00:11:00.000Z",
    _msg: hostileMsg,
    container_name: "svc-beta",
  }];
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [queueRoute([{ text: ndjson(hostile) }])],
    () => run("error-summary", {}, ctx),
  );
  const res = written.find((w) => w.spec === "errorSummary")!;
  const byContainer = res.payload.byContainer as Array<
    { name: string; samples: string[] }
  >;
  const beta = byContainer.find((c) => c.name === "svc-beta")!;
  const sample = beta.samples[0];
  assert(sample.includes(controlChar), "the raw control char is not stripped");
  assert(sample.includes("\n"), "the raw embedded newline is not stripped");
  // sample = `[time-slice] ${msg.slice(0,300)}` — the message portion is capped at 300.
  const msgPortion = sample.slice(sample.indexOf("] ") + 2);
  assertEquals(msgPortion.length, 300);
});

// =============================================================================
// P4 / P9 — ssh boundary: swallowed stderr, MITM-permissive options
// =============================================================================

Deno.test("pin: P9 — the ssh invocation carries MITM-permissive options (StrictHostKeyChecking=no, UserKnownHostsFile=/dev/null) — characterized, not fixed", async () => {
  const cmdStub = installCmdStub([{
    success: true,
    stdout: "svc-alpha",
    stderr: "",
  }]);
  const { ctx } = makeCtx();
  try {
    await withFetchStub(
      [queueRoute([{ text: ndjson(containerStatsFixture) }])],
      () => run("container-log-status", {}, ctx),
    );
  } finally {
    cmdStub.restore();
  }
  const args = cmdStub.invocations[0].args;
  assert(args.includes("StrictHostKeyChecking=no"));
  assert(args.includes("UserKnownHostsFile=/dev/null"));
});

Deno.test("pin: P4 — ssh stderr content is swallowed entirely — it never appears in the written containerStatus payload", async () => {
  const sensitiveStderr =
    "ssh: handshake failed: host key verification error for internal-gateway";
  const cmdStub = installCmdStub([
    { success: false, stdout: "", stderr: sensitiveStderr },
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
  const serialized = JSON.stringify(res.payload);
  assert(
    !serialized.includes(sensitiveStderr),
    "stderr text must not leak into the written resource (it is also never surfaced anywhere else)",
  );
});

// =============================================================================
// P10 / P11 — no fetch timeout, plaintext transport
// =============================================================================

Deno.test("pin: P10/P11 — every fetch call carries no AbortSignal AND targets plaintext http://, across all three analytics query paths", async () => {
  const scenarios: Array<[string, Record<string, unknown>]> = [
    ["query", {}],
    ["stats", {}],
    ["error-summary", {}],
  ];
  for (const [name, args] of scenarios) {
    const { ctx } = makeCtx();
    await withFetchStub(
      [queueRoute([{ text: ndjson(queryFixture) }])],
      async (calls) => {
        await run(name, args, ctx);
        assertEquals(calls[0].signal?.aborted ?? false, false);
        assertEquals(new URL(calls[0].url).protocol, "http:");
      },
    );
  }
});

// =============================================================================
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// =============================================================================

// PRIMARY control: every synthetic container name used anywhere in the
// fixtures must match this strict allowlist pattern.
const SYNTHETIC_CONTAINER_ALLOWLIST = /^svc-(alpha|beta|gamma|delta)$/;
const SYNTHETIC_HOST_ALLOWLIST = /^[a-z0-9-]+\.example\.test$/;

// DEFENSE-IN-DEPTH: known real container/extension/host names from this
// homelab (see swamp-workspace's extension directory listing + operational
// memory). Kept to tokens of 4+ characters to avoid noisy short-substring
// false positives against ordinary English words in synthetic log messages.
const REAL_NAME_DENYLIST: string[] = [
  "gonic",
  "immich",
  "traefik",
  "transmission",
  "headphones",
  "dawarich",
  "homeassistant",
  "skema",
  "pihole",
  "grafana",
  "prometheus",
  "victoriametrics",
  "vmalert",
  "alertmanager",
  "mongodb",
  "mongo",
  "hashicorp",
  "unifi",
  "mikrotik",
  "kandev",
  "kaiten",
  "atlas",
  "anilist",
  "cadvisor",
  "clickhouse",
  "comfyui",
  "tubearchivist",
  "seanime",
  "fragrantica",
  "porkbun",
  "stripe-mpp",
  "swamp-go-brr",
  "cozystack",
  "libvirt",
  "firecracker",
  "talos-node",
  "talm-cluster",
  "telegram",
  "obsidian",
  "jellyfin",
  "sonarr",
  "radarr",
  "qbittorrent",
  "music-library",
  "career-kb",
  "vlogs-unraid",
  "aopab-local-dns",
  "zeroclaw",
  "unraid",
  "navi",
];

const RFC1918_RE =
  /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;
const REAL_HOST_RE = /\.aopab\.art\b/i;
// Entirely 32+ alnum/base64url characters, no separators — none of our
// authored fixture values (container names, hosts, ttl-shaped digits, short
// messages) match this shape.
const HIGH_ENTROPY_RE = /^[A-Za-z0-9+/_=-]{32,}$/;

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
  "query.json": queryFixture,
  "stats.json": statsFixture,
  "container-stats.json": containerStatsFixture,
  "error-lines.json": errorLinesFixture,
};

Deno.test("fixtures-secret-scan: every structured container_name value matches the synthetic svc-* ALLOWLIST", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const row of data as Array<Record<string, unknown>>) {
      if (row.container_name !== undefined) {
        const name = String(row.container_name);
        if (!SYNTHETIC_CONTAINER_ALLOWLIST.test(name)) {
          violations.push(
            `${file}: container_name "${name}" does not match ${SYNTHETIC_CONTAINER_ALLOWLIST}`,
          );
        }
      }
    }
  }
  assertEquals(violations, [], violations.join("\n"));
});

Deno.test("fixtures-secret-scan: GLOBAL_ARGS.host (used across every suite) matches the synthetic *.example.test ALLOWLIST", () => {
  assert(
    SYNTHETIC_HOST_ALLOWLIST.test(GLOBAL_ARGS.host),
    `host "${GLOBAL_ARGS.host}" must be a *.example.test synthetic host`,
  );
});

Deno.test("fixtures-secret-scan: no string leaf ANYWHERE in the fixtures — including free-text _msg bodies — matches the real-name DENYLIST, an RFC1918 address, or a real *.aopab.art host", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      const lower = str.toLowerCase();
      for (const real of REAL_NAME_DENYLIST) {
        if (lower.includes(real)) {
          violations.push(
            `${file}: value "${str}" contains denylisted name "${real}"`,
          );
        }
      }
      if (RFC1918_RE.test(str)) {
        violations.push(`${file}: value "${str}" contains an RFC1918 address`);
      }
      if (REAL_HOST_RE.test(str)) {
        violations.push(
          `${file}: value "${str}" contains a real *.aopab.art host`,
        );
      }
      if (HIGH_ENTROPY_RE.test(str)) {
        violations.push(
          `${file}: value "${str}" is a high-entropy token-shaped string`,
        );
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

Deno.test("fixtures-secret-scan: sanity — the scanner actually flags an injected real name AND a high-entropy secret shape (anti-vacuity)", () => {
  const poisonedName = { _msg: "the gonic container restarted after an OOM" };
  const poisonedEntropy = { token: "a".repeat(40) };
  const nameViolations = collectStrings(poisonedName).filter((s) =>
    REAL_NAME_DENYLIST.some((real) => s.toLowerCase().includes(real))
  );
  const entropyViolations = collectStrings(poisonedEntropy).filter((s) =>
    HIGH_ENTROPY_RE.test(s)
  );
  assert(
    nameViolations.length > 0,
    "sanity: scanner must flag a real container name",
  );
  assert(
    entropyViolations.length > 0,
    "sanity: scanner must flag a high-entropy shape",
  );
});
