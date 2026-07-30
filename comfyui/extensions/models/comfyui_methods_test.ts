/**
 * Methods-gap suite: exercises the model methods `comfyui.test.ts` (the
 * host-authored gate) doesn't already cover — `sync`, `node_info`, `generate`
 * driven over a REAL bundled template file (the template-reading path +
 * auto-seed, as opposed to `comfyui.test.ts`'s inline-`workflow` tests), the
 * `generate` 400/`node_errors` failure surfacing, and `generate_caption`'s
 * missing-apiKey guard.
 *
 * comfyui.ts is UNMODIFIED — every test here PINS current, already-shipped
 * behavior. Every generate-invoking test overrides `outputDir` to a
 * `makeTempDir()` and removes it in a `finally` block (per plan v2 — the
 * shipped `comfyui.test.ts` only cleans up on the success path).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { GlobalArgs, model } from "./comfyui.ts";
import systemStats from "../../fixtures/system_stats.json" with {
  type: "json",
};
import promptQueued from "../../fixtures/prompt_queued.json" with {
  type: "json",
};
import promptNodeErrors from "../../fixtures/prompt_node_errors.json" with {
  type: "json",
};
import historyCompleted from "../../fixtures/history_completed.json" with {
  type: "json",
};
import objectInfoResolution from "../../fixtures/object_info_resolution.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness — porkbun-precedent fetch stub: reassign globalThis.fetch behind an
// `as unknown as typeof globalThis.fetch` unknown-bridge (never a direct
// `as typeof fetch` cast).
// ---------------------------------------------------------------------------

type Captured = { spec: string; name: string; data: unknown };

function fakeContext(overrides: Record<string, unknown> = {}) {
  const captured: Captured[] = [];
  const globalArgs = GlobalArgs.parse({
    baseUrl: "http://127.0.0.1:8188",
    ...overrides,
  });
  const context = {
    globalArgs,
    writeResource: (spec: string, name: string, data: unknown) => {
      captured.push({ spec, name, data });
    },
    extensionFile: (rel: string) =>
      new URL(`../../${rel}`, import.meta.url).pathname,
  };
  return { context, captured };
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pathOf(req: Request): string {
  return new URL(req.url).pathname;
}

// ---------------------------------------------------------------------------
// sync (gap: comfyui.test.ts only tests `lookup`, never `sync`)
// ---------------------------------------------------------------------------

Deno.test("sync: snapshots the server identically to lookup", async () => {
  const { context, captured } = fakeContext();
  await withFetchStub(
    [(req) => pathOf(req) === "/system_stats" ? json(systemStats) : undefined],
    async () => {
      await model.methods.sync.execute({}, context);
    },
  );
  const server = captured.find((c) => c.spec === "server");
  assert(server);
  const data = server.data as { comfyuiVersion: string; devices: unknown };
  assertEquals(data.comfyuiVersion, "0.0.0-synthetic");
  assert(Array.isArray(data.devices));
});

// ---------------------------------------------------------------------------
// node_info (gap: no existing test)
// ---------------------------------------------------------------------------

Deno.test("node_info: fetches /object_info/<classType> and writes a node_info resource", async () => {
  const { context, captured } = fakeContext();
  await withFetchStub(
    [(req) =>
      pathOf(req) === "/object_info/ResolutionSelector"
        ? json(objectInfoResolution)
        : undefined],
    async () => {
      await model.methods.node_info.execute(
        { classType: "ResolutionSelector" },
        context,
      );
    },
  );
  const res = captured.find((c) => c.spec === "node_info");
  assert(res);
  assertEquals(res.name, "ResolutionSelector");
  const data = res.data as { classType: string; info: unknown };
  assertEquals(data.classType, "ResolutionSelector");
  const info = data.info as Record<
    string,
    { input?: { required?: Record<string, unknown> } }
  >;
  assert(info.ResolutionSelector?.input?.required?.aspect_ratio);
});

// ---------------------------------------------------------------------------
// generate over a REAL bundled template (template-reading path + auto-seed) —
// comfyui.test.ts only exercises inline `workflow` args, never a `template`
// that makes loadGraphAndTemplate actually read a bundled file off disk.
// ---------------------------------------------------------------------------

Deno.test("generate: template='ideogram' reads the bundled workflow file, patches caption + auto-seed, and records them consistently", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    let postedCaption: unknown;
    let postedSeed: unknown;
    await withFetchStub(
      [
        (req) => {
          if (pathOf(req) !== "/prompt") return undefined;
          return req.text().then((text) => {
            const body = JSON.parse(text) as {
              prompt: Record<string, { inputs: Record<string, unknown> }>;
            };
            postedCaption = body.prompt["98:24"].inputs.text;
            postedSeed = body.prompt["98:18"].inputs.noise_seed;
            return json(promptQueued);
          });
        },
        (req) =>
          pathOf(req) === "/history/synthetic-prompt-0001"
            ? json(historyCompleted)
            : undefined,
        (req) =>
          pathOf(req) === "/view"
            ? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
            : undefined,
      ],
      async () => {
        const args = model.methods.generate.arguments.parse({
          template: "ideogram",
          caption: '{"high_level_description":"a scenic mountain landscape"}',
        });
        await model.methods.generate.execute(args, context);
      },
    );
    const gen = captured.find((c) => c.spec === "generation");
    assert(gen);
    const g = gen.data as {
      promptId: string;
      paths: string[];
      seed: number | null;
    };
    assertEquals(g.promptId, "synthetic-prompt-0001");
    assertEquals(g.paths.length, 1);
    assertEquals(
      postedCaption,
      '{"high_level_description":"a scenic mountain landscape"}',
    );
    // Template resolved a seed node -> a random seed was auto-picked, patched
    // into the actual POSTed graph, and the recorded value matches exactly
    // what was sent over the wire.
    assertEquals(typeof g.seed, "number");
    assertEquals(g.seed, postedSeed);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// generate: 400 with node_errors surfaces through the model method
// ---------------------------------------------------------------------------

Deno.test("generate: a 400 /prompt response carrying node_errors surfaces as a rejected Error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({ outputDir: dir });
    await withFetchStub(
      [(req) =>
        pathOf(req) === "/prompt" ? json(promptNodeErrors, 400) : undefined],
      async () => {
        const args = model.methods.generate.arguments.parse({
          caption: '{"x":1}',
          captionNodeId: "24",
          workflow: {
            "24": { class_type: "CLIPTextEncode", inputs: { text: "" } },
          },
        });
        const err = await assertRejects(() =>
          model.methods.generate.execute(args, context)
        );
        assert(String(err).includes("400"));
        assert(String(err).includes("Required input is missing"));
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// generate_caption: missing-apiKey guard
// ---------------------------------------------------------------------------

Deno.test("generate_caption: throws when globalArgs.anthropicApiKey is not set", async () => {
  const { context } = fakeContext(); // no anthropicApiKey
  const args = model.methods.generate_caption.arguments.parse({
    idea: "a neon cat",
  });
  await assertRejects(
    () => model.methods.generate_caption.execute(args, context),
    Error,
    "requires globalArgs.anthropicApiKey",
  );
});
