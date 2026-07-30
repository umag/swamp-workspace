/**
 * Coverage suite: sweeps guards/branches in comfyui.ts that the contract,
 * methods, and adversarial suites don't already exercise on BOTH sides — so
 * deleting any one of these guards turns a test red (STANDARD.md's coverage
 * role — a behavioral regression guard, not a numeric percentage).
 *
 * comfyui.ts is UNMODIFIED; every test here PINS existing behavior. Every
 * generate-invoking test overrides `outputDir` to a `makeTempDir()` and
 * removes it in a `finally` block.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { GlobalArgs, model } from "./comfyui.ts";
import promptQueued from "../../fixtures/prompt_queued.json" with {
  type: "json",
};
import historyCompleted from "../../fixtures/history_completed.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
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

/** Stubs the full happy-path `generate` pipeline (/prompt, /history, /view)
 * and returns the captured POST body(ies) sent to /prompt. */
type PostedNode = { class_type: string; inputs: Record<string, unknown> };
type PostedBody = { prompt: Record<string, PostedNode> };

async function generateAndCapturePost(
  context: Parameters<typeof model.methods.generate.execute>[1],
  args: Record<string, unknown>,
): Promise<PostedBody[]> {
  const bodies: PostedBody[] = [];
  await withFetchStub(
    [
      (req) => {
        if (pathOf(req) !== "/prompt") return undefined;
        return req.text().then((text) => {
          const body = JSON.parse(text) as PostedBody;
          bodies.push(body);
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
      const parsed = model.methods.generate.arguments.parse(args);
      await model.methods.generate.execute(parsed, context);
    },
  );
  return bodies;
}

// ---------------------------------------------------------------------------
// Guard: loadGraphAndTemplate — every branch
// ---------------------------------------------------------------------------

Deno.test("generate: an unknown template name throws, naming the known templates", async () => {
  const { context } = fakeContext();
  const args = model.methods.generate.arguments.parse({
    template: "not-a-real-template",
  });
  await assertRejects(
    () => model.methods.generate.execute(args, context),
    Error,
    "unknown template 'not-a-real-template'",
  );
});

Deno.test("generate: an inline `workflow` PLUS a `template` uses the inline graph, not the bundled file (template only supplies node-id defaults)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    const bodies = await generateAndCapturePost(context, {
      template: "ideogram",
      caption: "custom caption",
      // The ideogram template's tpl.seed.nodeId ("98:18") still resolves
      // (from the TEMPLATE, not the graph) and auto-picks a seed, so the
      // inline graph must include that node too or the seed patch throws.
      workflow: {
        "98:24": { class_type: "CLIPTextEncode", inputs: { text: "" } },
        "98:18": { class_type: "RandomNoise", inputs: { noise_seed: 0 } },
      },
    });
    // Only the inline graph's two nodes were posted — never the ~30-node
    // bundled ideogram.api.json file.
    assertEquals(Object.keys(bodies[0].prompt).sort(), ["98:18", "98:24"]);
    assertEquals(bodies[0].prompt["98:24"].inputs.text, "custom caption");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate: globalArgs.workflowPath is read from disk when no template/workflow arg is given", async () => {
  const dir = await Deno.makeTempDir();
  const workflowFile = `${dir}/custom.api.json`;
  try {
    await Deno.writeTextFile(
      workflowFile,
      JSON.stringify({
        "1": { class_type: "CustomNode", inputs: { marker: "from-disk" } },
      }),
    );
    const { context } = fakeContext({
      outputDir: dir,
      workflowPath: workflowFile,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    const bodies = await generateAndCapturePost(context, {});
    assertEquals(bodies[0].prompt["1"].inputs.marker, "from-disk");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate: with no template/workflow/workflowPath at all, defaults to the bundled 'ideogram' template file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    const bodies = await generateAndCapturePost(context, {});
    // A node id unique to the bundled ideogram.api.json proves the default
    // branch actually read that file off disk.
    assert("98:24" in bodies[0].prompt);
    assertEquals(bodies[0].prompt["98:24"].class_type, "CLIPTextEncode");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Guard: applyContentOverrides — LoRA wiring
// ---------------------------------------------------------------------------

Deno.test("generate: a `lora` arg on a template with no LoRA wiring throws", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({ outputDir: dir });
    const args = model.methods.generate.arguments.parse({
      template: "ideogram", // ideogram has no `.lora` config
      lora: "some_style",
    });
    await assertRejects(
      () => model.methods.generate.execute(args, context),
      Error,
      "has no LoRA wiring",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate: `loras[]` takes precedence over a singular `lora` when both are given", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    const bodies = await generateAndCapturePost(context, {
      template: "krea",
      lora: "singular_lora",
      loras: ["stacked_lora"],
    });
    assertEquals(
      bodies[0].prompt["30:15"].inputs.lora_name,
      "stacked_lora.safetensors",
      "loras[] must win over the singular lora arg",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Guard: seed auto-pick — `args.seed ?? (seedNodeId ? randomSeed() : undefined)`
// ---------------------------------------------------------------------------

Deno.test("generate: an explicit seed of 0 is preserved (nullish-coalescing, not falsy-coalescing)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    const bodies = await generateAndCapturePost(context, {
      template: "ideogram",
      seed: 0,
    });
    assertEquals(bodies[0].prompt["98:18"].inputs.noise_seed, 0);
    const gen = captured.find((c) => c.spec === "generation");
    assert(gen);
    assertEquals((gen.data as { seed: number | null }).seed, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Guard: generate_batch — `args.seeds ?? Array.from({length: args.count ?? 4})`
// ---------------------------------------------------------------------------

Deno.test("generate_batch: explicit `seeds` wins over `count` when both are given", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    let posts = 0;
    await withFetchStub(
      [
        (req) => {
          if (pathOf(req) !== "/prompt") return undefined;
          posts++;
          return json({
            prompt_id: `p${posts}`,
            number: posts,
            node_errors: {},
          });
        },
        (req) => {
          const m = pathOf(req).match(/^\/history\/(p\d+)$/);
          if (!m) return undefined;
          return json({
            [m[1]]: {
              status: { completed: true },
              outputs: {
                "9": {
                  images: [{
                    filename: `${m[1]}.png`,
                    subfolder: "",
                    type: "output",
                  }],
                },
              },
            },
          });
        },
        (req) =>
          pathOf(req) === "/view"
            ? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
            : undefined,
      ],
      async () => {
        const args = model.methods.generate_batch.arguments.parse({
          seedNodeId: "18",
          seeds: [7, 8],
          count: 10, // must be ignored — seeds present
          workflow: {
            "18": { class_type: "RandomNoise", inputs: { noise_seed: 0 } },
          },
        });
        await model.methods.generate_batch.execute(args, context);
      },
    );
    const batch = captured.find((c) => c.spec === "batch");
    assert(batch);
    assertEquals((batch.data as { seeds: number[] }).seeds, [7, 8]);
    assertEquals(posts, 2, "count=10 must be ignored when seeds[] is given");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate_batch: neither `seeds` nor `count` given defaults to 4 random seeds", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    let posts = 0;
    await withFetchStub(
      [
        (req) => {
          if (pathOf(req) !== "/prompt") return undefined;
          posts++;
          return json({
            prompt_id: `p${posts}`,
            number: posts,
            node_errors: {},
          });
        },
        (req) => {
          const m = pathOf(req).match(/^\/history\/(p\d+)$/);
          if (!m) return undefined;
          return json({
            [m[1]]: {
              status: { completed: true },
              outputs: {
                "9": {
                  images: [{
                    filename: `${m[1]}.png`,
                    subfolder: "",
                    type: "output",
                  }],
                },
              },
            },
          });
        },
        (req) =>
          pathOf(req) === "/view"
            ? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
            : undefined,
      ],
      async () => {
        const args = model.methods.generate_batch.arguments.parse({
          seedNodeId: "18",
          workflow: {
            "18": { class_type: "RandomNoise", inputs: { noise_seed: 0 } },
          },
        });
        await model.methods.generate_batch.execute(args, context);
      },
    );
    const batch = captured.find((c) => c.spec === "batch");
    assert(batch);
    assertEquals((batch.data as { count: number }).count, 4);
    assertEquals(posts, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Guard: generate_caption's full method wiring around stripFences + repairBBox
// (the pure functions are pinned in lib/caption_generated.test.ts; this
// closes the gap that the METHOD's own plumbing — claudeComplete stub ->
// parseGeneratedCaption -> writeResource — never got a fenced/degenerate
// case run through it end to end).
// ---------------------------------------------------------------------------

Deno.test("generate_caption: a fenced Claude response with a degenerate element bbox is stripped, parsed, and the degenerate bbox silently dropped", async () => {
  const { context, captured } = fakeContext({
    anthropicApiKey: "sk-ant-api-test",
  });
  const raw = "```json\n" + JSON.stringify({
    aspect_ratio: "1:1",
    high_level_description: "x",
    compositional_deconstruction: {
      elements: [{
        type: "obj",
        bbox: [400, 500, 400, 900], // zero height -> degenerate
        desc: "degenerate element",
      }],
    },
  }) + "\n```";
  await withFetchStub(
    [(req) =>
      new URL(req.url).pathname === "/v1/messages"
        ? json({ content: [{ type: "text", text: raw }] })
        : undefined],
    async () => {
      const args = model.methods.generate_caption.arguments.parse({
        idea: "x",
      });
      await model.methods.generate_caption.execute(args, context);
    },
  );
  const cap = captured.find((c) => c.spec === "caption");
  assert(cap);
  const data = cap.data as {
    caption: {
      compositional_deconstruction?: { elements: { bbox?: number[] }[] };
    };
  };
  assertEquals(
    data.caption.compositional_deconstruction?.elements[0].bbox,
    undefined,
  );
});
