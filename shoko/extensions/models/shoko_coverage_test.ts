/**
 * Coverage suite: sweeps every guard/branch in shoko.ts's http() helper and
 * its callers that the contract/methods/adversarial suites don't already
 * exercise on both sides, so deleting any one of these guards turns a test
 * red (STANDARD.md's coverage role — a behavioral regression guard, not a
 * numeric percentage).
 *
 * shoko.ts is UNMODIFIED; every test PINS existing behavior. Round-1 plan
 * review findings folded in here: shoko.ts DOES check `resp.ok` (opposite of
 * porkbun) and DOES mark `apiKey` `.meta({ sensitive: true })` (also opposite
 * of porkbun) — both pinned as the affirmative case, not the gap. The
 * null/empty-body handling is asymmetric across methods: `queue-status`
 * wraps a null body as `[null]`; `list-import-folders`/`search-series` map a
 * null body to `[]`; the four `List`-keyed read methods instead throw a
 * TypeError on a null body (`data.List` derefs null before `?? []` applies).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { model } from "./shoko.ts";
import denoConfig from "../../deno.json" with { type: "json" };

const HOST = "http://203.0.113.10:8111";
const API_KEY = "fixture-shoko-key-0001";

const GLOBAL_ARGS = {
  host: HOST,
  apiKey: API_KEY,
  userAgent: "swamp-shoko-test/1.0",
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
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = r(req);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unrouted ${req.url}`));
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
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

function emptyBody(status = 200) {
  return new Response("", { status });
}

// ---------------------------------------------------------------------------
// Guard: resp.ok — both sides, plus the 299/300 boundary
// ---------------------------------------------------------------------------

Deno.test("resp.ok: status 200 and 299 (both 'ok') do not throw", async () => {
  const { ctx } = makeCtx();
  for (const status of [200, 299]) {
    await withFetchStub([() => json({ State: 1 }, status)], async () => {
      await run("status", {}, ctx); // must not throw
    });
  }
});

Deno.test("resp.ok: status 300 and 404 (both NOT 'ok') throw 'Shoko <method> <path> -> <status>: ...'", async () => {
  const { ctx } = makeCtx();
  for (const status of [300, 404]) {
    await withFetchStub([() => json({ err: true }, status)], async () => {
      let threw = false;
      try {
        await run("status", {}, ctx);
      } catch (err) {
        threw = true;
        assert((err as Error).message.includes(`→ ${status}:`));
      }
      assert(threw, `status ${status} must throw`);
    });
  }
});

// ---------------------------------------------------------------------------
// Guard: JSON.parse try/catch — both sides, exercised via `status`
// ---------------------------------------------------------------------------

Deno.test("JSON.parse: a well-formed JSON body parses to the equivalent object", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json({ State: 3, StartupMessage: "hi" })],
    async () => {
      await run("status", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload, { State: 3, StartupMessage: "hi" });
});

Deno.test("JSON.parse: a malformed-JSON body (truncated) falls back to {raw: text}, does not throw", async () => {
  const { ctx, written } = makeCtx();
  const truncated = '{"State": 3, "Startup';
  await withFetchStub(
    [() =>
      new Response(truncated, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })],
    async () => {
      await run("status", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "status")!;
  assertEquals(res.payload, { raw: truncated });
});

// ---------------------------------------------------------------------------
// Guard: empty-body -> null — sweep across ALL affected methods
// ---------------------------------------------------------------------------

Deno.test("empty-body: run-action / remove-missing-files / rescan-folder discard the http() result entirely, so a null body does NOT crash them", async () => {
  for (
    const [name, args] of [
      ["run-action", { action: "RunImport" }],
      ["remove-missing-files", {}],
      ["rescan-folder", { importFolderId: 1 }],
    ] as const
  ) {
    const { ctx, written } = makeCtx();
    await withFetchStub([() => emptyBody(200)], async () => {
      await run(name, args, ctx);
    });
    assert(
      written.some((w) => w.spec === "task"),
      `${name}: must still write its task resource despite a null http() result`,
    );
  }
});

Deno.test("empty-body: the four List-keyed read methods (list-series, find-unrecognized-files, find-missing-episodes, find-duplicate-files) throw a TypeError on a null body — 'data.List' derefs null", async () => {
  for (
    const [name, args] of [
      ["list-series", {}],
      ["find-unrecognized-files", {}],
      ["find-missing-episodes", {}],
      ["find-duplicate-files", {}],
    ] as const
  ) {
    const { ctx } = makeCtx();
    await withFetchStub([() => emptyBody(200)], async () => {
      let threw = false;
      try {
        await run(name, args, ctx);
      } catch (err) {
        threw = true;
        assert(err instanceof TypeError, `${name}: must throw a TypeError`);
      }
      assert(threw, `${name}: a null body must throw, not silently succeed`);
    });
  }
});

Deno.test("empty-body ASYMMETRY: queue-status wraps a null body as [null] (Array.isArray ? data : [data])", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => emptyBody(200)], async () => {
    await run("queue-status", {}, ctx);
  });
  const res = written.find((w) => w.spec === "queue")!;
  assertEquals(res.payload.items, [null]);
});

Deno.test("empty-body ASYMMETRY: list-import-folders maps a null body to [] (Array.isArray guard, no wrap)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => emptyBody(200)], async () => {
    await run("list-import-folders", {}, ctx);
  });
  const res = written.find((w) => w.spec === "importFolders")!;
  assertEquals(res.payload.folders, []);
  assertEquals(res.payload.total, 0);
});

Deno.test("empty-body ASYMMETRY: search-series maps a null body to [] (Array.isArray guard, no wrap) — contrast queue-status's [null]", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => emptyBody(200)], async () => {
    await run("search-series", { query: "x" }, ctx);
  });
  const res = written.find((w) => w.spec === "series")!;
  assertEquals(res.payload.items, []);
  assertEquals(res.payload.total, 0);
});

// ---------------------------------------------------------------------------
// Guard: `data.List ?? []` — List absent / List:null both collapse to [];
// contrast with data itself being null (which throws, pinned above)
// ---------------------------------------------------------------------------

Deno.test("list-series: List key ABSENT from a defined response object -> [] (no crash, no Total)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({})], async () => {
    await run("list-series", {}, ctx);
  });
  const res = written.find((w) => w.spec === "series")!;
  assertEquals(res.payload.items, []);
  assertEquals(res.payload.total, 0);
});

Deno.test("list-series: List explicitly null on a defined response object -> [] (?? catches null, unlike a null data itself)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ Total: 5, List: null })], async () => {
    await run("list-series", {}, ctx);
  });
  const res = written.find((w) => w.spec === "series")!;
  assertEquals(res.payload.items, []);
  assertEquals(
    res.payload.total,
    5,
    "Total is preserved even when List is null",
  );
});

Deno.test("list-series: List present and non-empty -> passed through with matching total", async () => {
  const { ctx, written } = makeCtx();
  const list = [{ Name: "A" }, { Name: "B" }];
  await withFetchStub([() => json({ Total: 2, List: list })], async () => {
    await run("list-series", {}, ctx);
  });
  const res = written.find((w) => w.spec === "series")!;
  assertEquals(res.payload.items, list);
  assertEquals(res.payload.total, 2);
});

// ---------------------------------------------------------------------------
// Guard: `Array.isArray` — non-array TRUTHY body (not just null) on both
// isArray-guarded methods
// ---------------------------------------------------------------------------

Deno.test("list-import-folders: a non-array truthy body ({} object, not a list) -> [] (Array.isArray fails on a plain object too)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ notAnArray: true })], async () => {
    await run("list-import-folders", {}, ctx);
  });
  const res = written.find((w) => w.spec === "importFolders")!;
  assertEquals(res.payload.folders, []);
});

Deno.test("search-series: a non-array truthy body ({} object) -> [] (Array.isArray fails on a plain object too)", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub([() => json({ notAnArray: true })], async () => {
    await run("search-series", { query: "x" }, ctx);
  });
  const res = written.find((w) => w.spec === "series")!;
  assertEquals(res.payload.items, []);
});

Deno.test("queue-status: a non-array truthy body (a single plain object) is WRAPPED as [data], not discarded", async () => {
  const { ctx, written } = makeCtx();
  const single = { Name: "General", Status: "Idle" };
  await withFetchStub([() => json(single)], async () => {
    await run("queue-status", {}, ctx);
  });
  const res = written.find((w) => w.spec === "queue")!;
  assertEquals(res.payload.items, [single]);
});

// ---------------------------------------------------------------------------
// Guard: list-series `startsWith` — truthy check (empty string collapses
// with undefined), contrast a real value
// ---------------------------------------------------------------------------

Deno.test("list-series: startsWith omitted (undefined) and startsWith='' (empty, falsy) BOTH omit the query param", async () => {
  for (const args of [{}, { startsWith: "" }]) {
    const { ctx } = makeCtx();
    await withFetchStub([() => json({ Total: 0, List: [] })], async (calls) => {
      await run("list-series", args, ctx);
      assertEquals(new URL(calls[0].url).searchParams.has("startsWith"), false);
    });
  }
});

Deno.test("list-series: a non-empty startsWith IS included in the query string", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ Total: 0, List: [] })], async (calls) => {
    await run("list-series", { startsWith: "Z" }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("startsWith"), "Z");
  });
});

// ---------------------------------------------------------------------------
// Guard: find-missing-episodes `collecting` — existence check, NOT truthy
// (contrast startsWith above: false is a legitimate, distinct value here)
// ---------------------------------------------------------------------------

Deno.test("find-missing-episodes: collecting omitted (undefined) -> query param absent", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ Total: 0, List: [] })], async (calls) => {
    await run("find-missing-episodes", {}, ctx);
    assertEquals(new URL(calls[0].url).searchParams.has("collecting"), false);
  });
});

Deno.test("find-missing-episodes: collecting=true -> query param present as 'true' (existence check, mirrors collecting=false already covered in methods suite)", async () => {
  const { ctx } = makeCtx();
  await withFetchStub([() => json({ Total: 0, List: [] })], async (calls) => {
    await run("find-missing-episodes", { collecting: true }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("collecting"), "true");
  });
});

// ---------------------------------------------------------------------------
// Guard: scope enum schema boundary rejection (find-missing-episodes /
// find-duplicate-files both use the same z.enum(["series","episodes"]) shape)
// ---------------------------------------------------------------------------

Deno.test("scope is rejected at the schema boundary when it is not 'series' or 'episodes'", () => {
  for (const methodName of ["find-missing-episodes", "find-duplicate-files"]) {
    const method = (model.methods as MethodMap)[methodName];
    let threw = false;
    try {
      method.arguments.parse({ scope: "not-a-real-scope" });
    } catch {
      threw = true;
    }
    assert(
      threw,
      `${methodName}: an unknown scope must be rejected before execute()`,
    );
  }
});

// ---------------------------------------------------------------------------
// Guard: `if (apiKey)` header truthiness — an explicitly EMPTY string apiKey
// omits the header even on an "authed" method (existence vs truthiness)
// ---------------------------------------------------------------------------

Deno.test("dashboard: an empty-string apiKey (falsy) omits the apikey header entirely — the guard is a truthiness check, not an existence check", async () => {
  const { ctx } = makeCtx({ ...GLOBAL_ARGS, apiKey: "" });
  await withFetchStub([() => json({})], async (calls) => {
    await run("dashboard", {}, ctx);
    assertEquals(calls[0].headers.has("apikey"), false);
  });
});

// ---------------------------------------------------------------------------
// Security-review finding: apiKey IS marked sensitive — the OPPOSITE pin of
// porkbun's corresponding coverage test (round-1 review risk note)
// ---------------------------------------------------------------------------

Deno.test("pin: globalArguments.apiKey IS marked `.meta({ sensitive: true })` — contrast porkbun, which marks neither credential field", () => {
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.apiKey) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    true,
    "apiKey must stay marked sensitive; if this starts failing, shoko.ts regressed the annotation",
  );
});

// ---------------------------------------------------------------------------
// Guard: globalArguments.userAgent schema default
// ---------------------------------------------------------------------------

Deno.test("globalArguments: userAgent defaults to 'swamp-shoko/1.0' when omitted from parsed input", () => {
  const parsed = model.globalArguments.parse({
    host: HOST,
    apiKey: "x",
  }) as { userAgent: string };
  assertEquals(parsed.userAgent, "swamp-shoko/1.0");
});

// ---------------------------------------------------------------------------
// Permission-scope regression guard (round-1 security review MEDIUM finding,
// operationalized): the plan required the default test task to stay
// network-less. Read via a static JSON import — same mechanism the fixtures
// use — so this pin needs NO new runtime permission (no --allow-read), and
// stays consistent with the suite's own network-less, offline guarantee.
// ---------------------------------------------------------------------------

Deno.test("deno.json: the default test task stays network-less (--allow-env=FC_NUM_RUNS, no --allow-net)", () => {
  const tasks = denoConfig.tasks as Record<string, string>;
  assert(
    tasks.test.includes("--allow-env=FC_NUM_RUNS"),
    "the default test task must scope FC_NUM_RUNS via --allow-env",
  );
  assert(
    !tasks.test.includes("--allow-net"),
    "the default test task must stay network-less (no --allow-net) — a future " +
      "accidental edit that adds it would defeat the whole suite's offline guarantee",
  );
});
