/**
 * Adversarial suite: hostile ClickHouse HTTP responses (non-200, malformed
 * JSONEachRow, garbage freshness timestamps, non-numeric media_id, unbounded
 * row counts) and HTML/CSS injection payloads driven THROUGH `execute()`,
 * plus focused pure-function pins for the two lowest-level latent bugs
 * (LB2, LB7) that resist stubbing through the model boundary.
 *
 * `2026.08.02.1` REAL-FIXED all 7 latent bugs tracked in the LOCAL
 * `anilist-chart-latent-bugs` issue-lifecycle model (never the Lab). Every
 * test that used to PIN a bug (LB2, LB3, LB5, LB7 here) now asserts the FIXED
 * behavior instead; the rest of this file (hostile-response characterization,
 * HTML/CSS injection defenses, SQL-injection defenses, credential sweep) is
 * an unchanged characterization of already-shipped behavior. Fixtures are
 * entirely SYNTHETIC: invented titles/users, RFC 2606 hosts
 * (`.example.test`), no real AniList data or hostnames.
 *
 * Latent bug map (all LOW/MEDIUM, 0 CRITICAL/HIGH) — ALL FIXED in
 * `2026.08.02.1`, see CHANGELOG.md for the per-bug writeup:
 *   LB1 (MED) read-phase ClickHouse failure now leaves a diagnostic
 *       `renderRun` marker (write-then-rethrow) — see
 *       anilist_chart_methods_test.ts (dedicated test there); this file's
 *       malformed-JSONEachRow and 200-inline-exception tests below also
 *       assert the marker now survives.
 *   LB2 (MED) ssh publish spawn now bounded by AbortController + setTimeout +
 *       clearTimeout — flipped HERE via a source-text scan.
 *   LB3 (MED) ClickHouseClient.query() now caps response bytes
 *       (`maxResponseBytes`, streamed) — flipped HERE.
 *   LB4 (LOW) malformed freshness timestamp now surfaces an explicit
 *       "unparseable" anomaly — see anilist_chart_methods_test.ts.
 *   LB5 (LOW) non-numeric media_id is now filtered before it ever reaches
 *       ClickHouse — flipped HERE (end-to-end) + methods_test.ts (wiring).
 *   LB6 (LOW) ClickHouse error body is now trimmed+redacted, still no
 *       credential leak — see anilist_chart_methods_test.ts.
 *   LB7 (LOW) arrayStringParam now escapes an embedded NUL byte — flipped
 *       HERE.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./anilist_chart.ts";
import {
  arrayIntParam,
  arrayStringParam,
  assertIdent,
  ClickHouseClient,
} from "./lib/clickhouse.ts";

// ---------------------------------------------------------------------------
// Harness (local copy per this repo's suite convention — each file is
// independently runnable)
// ---------------------------------------------------------------------------

const SENTINEL_KEY = "sntl_adv_clickhouse_key_do_not_log_2468";

const GLOBAL_ARGS: Record<string, unknown> = {
  clickhouseUrl: "https://ch.example.test:8443",
  clickhouseUser: "render_ro",
  clickhouseKey: SENTINEL_KEY,
  clickhouseDatabase: "default",
  userNames: ["alice", "bob"],
  topK: 5,
  bayesMinVotes: 5,
  penaltyRate: 0.05,
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const store = new Map<string, unknown>();
  return {
    written,
    store,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        store.set(name, payload);
        return Promise.resolve({ spec, name });
      },
      readResource: (name: string) => {
        if (!store.has(name)) {
          return Promise.reject(new Error(`no resource named "${name}"`));
        }
        return Promise.resolve(store.get(name));
      },
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

type Route = (req: Request) => Promise<Response | undefined>;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const stub = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req.clone());
      if (res) return res;
    }
    throw new Error(
      `fetch stub: unrouted ClickHouse call: ${await req.text()}`,
    );
  };
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonEachRow(rows: unknown[], status = 200): Response {
  return new Response(rows.map((r) => JSON.stringify(r)).join("\n"), {
    status,
  });
}

/** A minimal one-user/one-title dataset so a render can complete end-to-end
 * (used by the injection tests, which only care about the ONE hostile
 * field under test). `overrides` patches individual query responses. */
function minimalRoute(overrides: {
  board?: Record<string, unknown>[];
  chartMeta?: Record<string, unknown>[];
} = {}): Route {
  const board = overrides.board ?? [{
    user_name: "alice",
    media_id: 1,
    score: 8,
    title_romaji: "Fixture Title",
    title_english: "Fixture Title EN",
    genres: ["Comedy"],
    start_year: 2020,
    format: "TV",
    episodes: 12,
    duration: 24,
    average_score: 75,
    popularity: 1000,
    cover_image_large: "https://cdn.example.test/1.jpg",
  }];
  const chartMeta = overrides.chartMeta ?? [{
    media_id: 1,
    title_romaji: "Fixture Title",
    title_english: "Fixture Title EN",
    genres: ["Comedy"],
    format: "TV",
    start_year: 2020,
    start_date: "2020-07-05",
    cover_image_large: "https://cdn.example.test/1.jpg",
  }];
  return (req) =>
    (async () => {
      if (req.method !== "POST") return undefined;
      const sql = await req.text();
      if (sql.includes("LEFT JOIN")) return jsonEachRow(board);
      if (sql.includes("SELECT DISTINCT media_id")) {
        return jsonEachRow([{ media_id: 1 }]);
      }
      if (sql.startsWith("SELECT user_name, media_id, score")) {
        return jsonEachRow([{ user_name: "alice", media_id: 1, score: 8 }]);
      }
      if (sql.includes("WHERE media_id IN {ids:Array(Int64)}")) {
        return jsonEachRow(chartMeta);
      }
      if (sql.includes("AS users, count() AS rows")) {
        return jsonEachRow([{ users: 1, rows: 1, rated: 1 }]);
      }
      if (sql.includes("AS titles FROM")) return jsonEachRow([{ titles: 1 }]);
      if (sql.includes("arrayJoin(genres)")) {
        return jsonEachRow([{ genres: 1 }]);
      }
      if (sql.includes("cur_titles")) {
        return jsonEachRow([{ cur_titles: 0, cur_users: 0 }]);
      }
      if (sql.includes("AS movies")) return jsonEachRow([{ movies: 0 }]);
      if (sql.includes("y_min")) {
        return jsonEachRow([{
          y_min: 2020,
          y_max: 2020,
        }]);
      }
      if (sql.includes("AS newest")) {
        return jsonEachRow([{ newest: "2026-07-20 12:00:00" }]);
      }
      return undefined;
    })();
}

// ===========================================================================
// Hostile ClickHouse HTTP responses
// ===========================================================================

Deno.test("hostile: malformed JSONEachRow (one valid line, one garbage line) still throws a JSON parse error, but now leaves a diagnostic renderRun marker behind (LB1 fix)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) =>
        (async () => {
          const sql = await req.text();
          if (sql.includes("LEFT JOIN")) {
            return new Response(
              `${
                JSON.stringify({ user_name: "alice", media_id: 1, score: 8 })
              }\nNOT VALID JSON {{{`,
              { status: 200 },
            );
          }
          return undefined;
        })(),
    ],
    async () => {
      await assertRejects(() => run("render", {}, ctx));
    },
  );
  const runRes = written.find((w) => w.spec === "renderRun")!;
  assert(runRes, "a diagnostic marker must survive a parse-error read throw");
  assertEquals(runRes.payload.ok, false);
  assertStringIncludes(String(runRes.payload.refuseReason), "read failed");
});

Deno.test("hostile: an empty response body (zero rows) from a landing query is valid JSONEachRow -- `[0]` destructure yields `undefined`, N() coerces to 0, no throw", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) =>
        (async () => {
          const sql = await req.text();
          if (sql.includes("AS users, count() AS rows")) {
            return new Response("", { status: 200 }); // zero rows
          }
          return undefined;
        })(),
      minimalRoute(),
    ],
    async () => {
      await run("render", {}, ctx);
    },
  );
  const runRes = written.find((w) => w.spec === "renderRun")!;
  // totals?.rows is undefined -> N(undefined) -> 0 -> "no score rows" refusal,
  // NOT a crash. This characterizes num-coercion's fail-safe default.
  assertEquals(runRes.payload.ok, false);
  assert(String(runRes.payload.refuseReason).includes("no score rows"));
});

Deno.test("hostile: a 200 status with a ClickHouse-style exception TEXT body (not an HTTP error code) is still parsed as-if-JSON and throws a JSON syntax error, not a ClickHouse-status error -- but now leaves a diagnostic renderRun marker behind (LB1 fix)", async () => {
  // Some ClickHouse deployments can return 200 with an inline exception in
  // the body under certain settings. The client only branches on `res.ok`
  // (200-299), so this path is NOT caught by the `!res.ok` branch at all --
  // it falls through to JSON.parse(line), which throws a SyntaxError. A
  // genuinely different failure mode from the `!res.ok` branch's clean
  // `ClickHouse ${status}: ...` message.
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) =>
        (async () => {
          const sql = await req.text();
          if (sql.includes("LEFT JOIN")) {
            return new Response(
              "Code: 47. DB::Exception: Unknown identifier: 'bogus_column'",
              { status: 200 },
            );
          }
          return undefined;
        })(),
    ],
    async () => {
      const err = await assertRejects(() => run("render", {}, ctx));
      assert(
        !String(err).startsWith("ClickHouse 200:"),
        "a 200-status inline exception is NOT routed through the !res.ok branch",
      );
    },
  );
  const runRes = written.find((w) => w.spec === "renderRun")!;
  assert(runRes, "a diagnostic marker must survive this parse-error throw too");
  assertEquals(runRes.payload.ok, false);
  assertStringIncludes(String(runRes.payload.refuseReason), "read failed");
});

// ===========================================================================
// LB5: non-numeric media_id poisons the metadata read, end-to-end
// ===========================================================================

Deno.test("LB5 (fixed): a non-numeric media_id from distinctMediaIdsQuery is filtered out before ever reaching ClickHouse -- render COMPLETES instead of aborting on a poisoned '[NaN]' array param", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      (req) =>
        (async () => {
          const sql = await req.text();
          if (sql.includes("SELECT DISTINCT media_id")) {
            // A non-numeric media_id — e.g. a corrupted upstream ingest row.
            // Number("not-a-number") -> NaN -> now dropped by render()'s
            // `.filter(Number.isFinite)` before it can ever become a
            // ClickHouse array param (LB5).
            return jsonEachRow([{ media_id: "not-a-number" }]);
          }
          return undefined;
        })(),
      minimalRoute(),
    ],
    async (calls) => {
      await run("render", {}, ctx);
      for (const call of calls) {
        const url = new URL(call.url);
        assert(
          url.searchParams.get("param_ids") !== "[NaN]",
          "a poisoned '[NaN]' array param must never be sent to ClickHouse",
        );
      }
    },
  );
  const runRes = written.find((w) => w.spec === "renderRun")!;
  assertEquals(
    runRes.payload.ok,
    true,
    "the whole render now completes instead of aborting on the filtered id",
  );
});

Deno.test("LB5 root cause (fixed, pure): arrayIntParam now throws loud on a non-finite value instead of letting Math.trunc pass it straight through to String()", () => {
  assertThrows(() => arrayIntParam([Number.NaN]), Error, "non-finite");
  assertThrows(
    () => arrayIntParam([Number.POSITIVE_INFINITY]),
    Error,
    "non-finite",
  );
  assertThrows(
    () => arrayIntParam([Number.NEGATIVE_INFINITY]),
    Error,
    "non-finite",
  );
  // Sanity: the well-formed path still works correctly, byte-identical.
  assertEquals(arrayIntParam([1, -2, 3.9]), "[1,-2,3]");
});

// ===========================================================================
// LB3: unbounded response buffering / no row cap (pure ClickHouseClient test)
// ===========================================================================

Deno.test("LB3 (fixed): ClickHouseClient.query() now enforces maxResponseBytes -- a response over the configured cap throws instead of buffering unbounded", async () => {
  const ROWS = 4000;
  const lines: string[] = [];
  for (let i = 0; i < ROWS; i++) {
    lines.push(JSON.stringify({ media_id: i, title_romaji: `T${i}` }));
  }
  const body = lines.join("\n");
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  assert(
    bodyBytes > 1024,
    "sanity: the stubbed body really is over the configured cap",
  );
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, { status: 200 }),
    )) as unknown as typeof globalThis.fetch;
  try {
    const client = new ClickHouseClient({
      url: "https://ch.example.test:8443",
      user: "render_ro",
      key: SENTINEL_KEY,
      database: "default",
      maxResponseBytes: 1024, // far below the ~4000-row synthetic body
    });
    await assertRejects(
      () => client.query("SELECT media_id, title_romaji FROM x"),
      Error,
      "exceeds",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("LB3 (fixed): a response body UNDER the configured cap still returns every row -- the cap is a ceiling, not a silent truncator", async () => {
  const ROWS = 4000;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    const lines: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      lines.push(JSON.stringify({ media_id: i, title_romaji: `T${i}` }));
    }
    return Promise.resolve(new Response(lines.join("\n"), { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
  try {
    const client = new ClickHouseClient({
      url: "https://ch.example.test:8443",
      user: "render_ro",
      key: SENTINEL_KEY,
      database: "default",
      maxResponseBytes: 10 * 1024 * 1024, // comfortably above this body
    });
    const rows = await client.query("SELECT media_id, title_romaji FROM x");
    assertEquals(
      rows.length,
      ROWS,
      "under the cap, every row still comes back -- not a silent truncator",
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ===========================================================================
// LB2: ssh publish timeout (structural source-text pin — the ssh branch is a
// Deno.Command spawn; per the Deno-skew rule this suite never stubs
// Deno.Command with an `as typeof` cast, so the bounded spawn is
// characterized by scanning the source text directly).
// ===========================================================================

Deno.test("LB2 (fixed): the ssh publish spawn is now bounded by AbortController + setTimeout + clearTimeout -- a hung ssh connection aborts instead of blocking publish() forever", () => {
  const src = Deno.readTextFileSync(
    new URL("./anilist_chart.ts", import.meta.url),
  );
  assert(
    src.includes('new Deno.Command("ssh"'),
    "sanity: the ssh spawn is actually present in this file",
  );
  assert(
    src.includes("AbortController"),
    "anilist_chart.ts's ssh Deno.Command must now be bounded by an " +
      "AbortController (contrast with lib/clickhouse.ts's fetch, which was " +
      "already bounded via AbortSignal.timeout)",
  );
  assert(
    src.includes("signal:"),
    "the AbortController's signal must actually be wired into the " +
      "Deno.Command options, not just constructed",
  );
  assert(
    src.includes("clearTimeout"),
    "the timer must be cleared on a fast success, not left pending " +
      "(AbortController + setTimeout + clearTimeout, NOT AbortSignal.timeout)",
  );
});

// ===========================================================================
// LB7: hand-rolled arrayStringParam escaping (pure function pin)
// ===========================================================================

Deno.test("LB7 (fixed): arrayStringParam's escaping -- pinned exact output for adversarial strings, now including an ESCAPED embedded NUL byte", () => {
  // Backslash escaped first, then quote, then NUL -- matches the source's
  // replace order (each new escape's backslash must not be re-doubled).
  assertEquals(arrayStringParam(["O'Brien"]), "['O\\'Brien']");
  assertEquals(arrayStringParam(["back\\slash"]), "['back\\\\slash']");
  assertEquals(
    arrayStringParam(["mix\\'ed"]),
    "['mix\\\\\\'ed']",
  );
  assertEquals(
    arrayStringParam(["'; DROP TABLE users; --"]),
    "['\\'; DROP TABLE users; --']",
  );
  // A NUL byte is now ENCODED as the two-character backslash-zero escape
  // instead of passing straight through into the array literal (LB7 fix).
  // Encode, not reject -- this is a URL query-param value, not raw SQL text,
  // matching LB5's "don't abort the render" philosophy.
  const withNul = "before\0after";
  assertEquals(arrayStringParam([withNul]), "['before\\0after']");
});

// ===========================================================================
// PIN the DEFENDED negatives: HTML/CSS injection escaped through execute()
// ===========================================================================

Deno.test("defended: a <script> HTML-injection title survives execute() fully escaped in the board, landing-independent chart page, with no raw <script> tag in the output", async () => {
  const HOSTILE_TITLE = "<script>alert(document.cookie)</script>";
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      minimalRoute({
        board: [{
          user_name: "alice",
          media_id: 1,
          score: 8,
          title_romaji: HOSTILE_TITLE,
          title_english: "Safe EN Title",
          genres: ["Comedy"],
          start_year: 2020,
          format: "TV",
          episodes: 12,
          duration: 24,
          average_score: 75,
          popularity: 1000,
          cover_image_large: "https://cdn.example.test/1.jpg",
        }],
        chartMeta: [{
          media_id: 1,
          title_romaji: HOSTILE_TITLE,
          title_english: "Safe EN Title",
          genres: ["Comedy"],
          format: "TV",
          start_year: 2020,
          start_date: "2020-07-05",
          cover_image_large: "https://cdn.example.test/1.jpg",
        }],
      }),
    ],
    async () => {
      await run("render", {}, ctx);
    },
  );
  const chart = written.find((w) => w.name === "chart")!;
  const html = String(chart.payload.html);
  assert(
    !html.includes(HOSTILE_TITLE),
    "the raw <script> tag must never appear verbatim",
  );
  assert(
    html.includes("&lt;script&gt;alert(document.cookie)&lt;/script&gt;"),
    "the title must appear fully HTML-entity-escaped",
  );
});

Deno.test("defended: a quote-breakout title in the cover URL / attribute position cannot escape its attribute quotes", async () => {
  const HOSTILE_COVER = '"><img src=x onerror=alert(1)>';
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      minimalRoute({
        chartMeta: [{
          media_id: 1,
          title_romaji: "Fixture Title",
          title_english: "Fixture Title EN",
          genres: ["Comedy"],
          format: "TV",
          start_year: 2020,
          start_date: "2020-07-05",
          cover_image_large: HOSTILE_COVER,
        }],
      }),
    ],
    async () => {
      await run("render", {}, ctx);
    },
  );
  const chart = written.find((w) => w.name === "chart")!;
  const html = String(chart.payload.html);
  assert(
    !html.includes('"><img src=x onerror=alert(1)>'),
    "the raw attribute-breakout sequence must never appear verbatim",
  );
  assert(
    html.includes("&quot;&gt;&lt;img"),
    "the cover URL must be fully escaped",
  );
});

Deno.test("pin (documented, accepted trade-off): a legitimately-named title of EXACTLY 'undefined' collides with the publish_gate's whole-text-node bad-fragment check and gets the ENTIRE page refused", async () => {
  // publish_gate.ts's own header comment documents this exact trade-off: the
  // check only fires when a WHOLE text node is exactly a bad fragment, which
  // is precisely what happens when a real anime title IS the bare word
  // "undefined" -- `<div class="title-text">undefined</div>` contains the
  // literal substring ">undefined<". This is accepted, not a new bug: a
  // false-positive refusal is safer than a real broken-slot leak, and a
  // title THAT is literally the English word "undefined" is vanishingly
  // rare in practice.
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [
      minimalRoute({
        chartMeta: [{
          media_id: 1,
          title_romaji: "undefined",
          title_english: null,
          genres: ["Comedy"],
          format: "TV",
          start_year: 2020,
          start_date: "2020-07-05",
          cover_image_large: null,
        }],
      }),
    ],
    async () => {
      await run("render", {}, ctx);
    },
  );
  const runRes = written.find((w) => w.spec === "renderRun")!;
  assertEquals(runRes.payload.ok, true, "the RUN as a whole still succeeds");
  const refused = runRes.payload.refused as string[];
  assert(
    refused.includes("chart"),
    "the /chart page specifically is refused by the publish_gate backstop",
  );
  // The same title feeds every TV-eligible genre-chart mode, so /fresh and
  // /bayes are refused too — only /current excludes it (not this season).
  assert(refused.includes("fresh") && refused.includes("bayes"));
  assert(
    written.find((w) => w.name === "chart") === undefined,
    "a refused page never becomes a renderedPage artifact",
  );
});

// ===========================================================================
// SQL injection blocked by param-binding + IDENT_RE
// ===========================================================================

Deno.test("defended: assertIdent rejects a hostile database/table identifier (SQL injection via an unparameterizable position)", () => {
  const attempts = [
    "users; DROP TABLE user_scores; --",
    'users" --',
    "users/*",
    "",
    "1users", // must not start with a digit
    "users;",
  ];
  for (const hostile of attempts) {
    let threw = false;
    try {
      assertIdent(hostile);
    } catch {
      threw = true;
    }
    assert(threw, `assertIdent must reject ${JSON.stringify(hostile)}`);
  }
  // Sanity: a real identifier passes.
  assertEquals(assertIdent("anilist_metadata"), "anilist_metadata");
});

Deno.test("defended: ClickHouseClient's constructor rejects a hostile database name immediately, before any query can run", () => {
  let threw = false;
  try {
    new ClickHouseClient({
      url: "https://ch.example.test:8443",
      user: "render_ro",
      key: SENTINEL_KEY,
      database: "evil; DROP TABLE x; --",
    });
  } catch {
    threw = true;
  }
  assert(threw);
});

// ===========================================================================
// X-ClickHouse-Key never logged / never leaked into markers or errors
// ===========================================================================

Deno.test("no method on this model ever calls a logger -- there is no context.logger reference anywhere in anilist_chart.ts (structural pin)", () => {
  const src = Deno.readTextFileSync(
    new URL("./anilist_chart.ts", import.meta.url),
  );
  assert(
    !src.includes("logger"),
    "a future change that starts logging must add its own credential-leak test",
  );
});

Deno.test("credential sweep: clickhouseKey never appears in any written resource across every render/publish scenario in this file", async () => {
  for (
    const w of (await (async () => {
      const { ctx, written } = makeCtx();
      await withFetchStub([minimalRoute()], async () => {
        await run("render", {}, ctx);
      });
      await run("publish", {}, ctx); // not configured -> ok:false, still fine
      return written;
    })())
  ) {
    assert(!JSON.stringify(w.payload).includes(SENTINEL_KEY));
  }
});
