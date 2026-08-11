/**
 * MiniMax H3 reference-to-video template suite. Covers the new video pieces:
 * `applyReferenceImages` (slot fill + unused-slot drop), `collectFiles` (video
 * output under a non-`images` key), `uploadImage`, the bundled `minimax_h3`
 * template contract (node ids/classes match the registry entry), and the
 * `generate` flow end-to-end over the real bundled graph — reference-image
 * upload, prompt/seed/duration patching, single-reference slot removal, and
 * video-output collection + save.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { GlobalArgs, model } from "./comfyui.ts";
import {
  applyReferenceImages,
  type RefImageSlot,
} from "./lib/workflow_patch.ts";
import { ComfyClient, type HistoryEntry } from "./lib/comfy_client.ts";
import promptQueued from "../../fixtures/prompt_queued.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness (self-contained; mirrors comfyui_methods_test.ts)
// ---------------------------------------------------------------------------

function fakeContext(overrides: Record<string, unknown> = {}) {
  const captured: { spec: string; name: string; data: unknown }[] = [];
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

const SLOTS: RefImageSlot[] = [
  {
    loaderNodeId: "137",
    loaderKey: "image",
    consumerNodeId: "136",
    consumerKey: "ref_images.ref_image_0",
  },
  {
    loaderNodeId: "139",
    loaderKey: "image",
    consumerNodeId: "136",
    consumerKey: "ref_images.ref_image_1",
  },
];

function refGraph() {
  return {
    "137": { class_type: "LoadImage", inputs: { image: "example.png" } },
    "139": { class_type: "LoadImage", inputs: { image: "example2.png" } },
    "136": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        prompt: ["138", 0],
        "ref_images.ref_image_0": ["137", 0],
        "ref_images.ref_image_1": ["139", 0],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// applyReferenceImages
// ---------------------------------------------------------------------------

Deno.test("applyReferenceImages: fills every slot when enough images are given", () => {
  const out = applyReferenceImages(refGraph(), SLOTS, ["a.png", "b.png"]);
  assertEquals(out["137"].inputs.image, "a.png");
  assertEquals(out["139"].inputs.image, "b.png");
  // consumer keeps both ref links
  assertEquals(out["136"].inputs["ref_images.ref_image_0"], ["137", 0]);
  assertEquals(out["136"].inputs["ref_images.ref_image_1"], ["139", 0]);
});

Deno.test("applyReferenceImages: a single image fills slot 0 and DROPS slot 1 (loader node + consumer link)", () => {
  const out = applyReferenceImages(refGraph(), SLOTS, ["only.png"]);
  assertEquals(out["137"].inputs.image, "only.png");
  assertEquals(out["139"], undefined); // loader node removed
  assertEquals(out["136"].inputs["ref_images.ref_image_0"], ["137", 0]);
  assertEquals("ref_images.ref_image_1" in out["136"].inputs, false); // link dropped
});

Deno.test("applyReferenceImages: does not mutate the input graph", () => {
  const input = refGraph();
  applyReferenceImages(input, SLOTS, ["only.png"]);
  assertEquals(input["139"]?.class_type, "LoadImage"); // still present on the original
  assertEquals(input["137"].inputs.image, "example.png");
});

Deno.test("applyReferenceImages: throws when a used slot's loader node is missing", () => {
  const g = refGraph();
  delete (g as Record<string, unknown>)["137"];
  assertThrows(
    () => applyReferenceImages(g, SLOTS, ["a.png"]),
    Error,
    "loader node '137' not found",
  );
});

// ---------------------------------------------------------------------------
// collectFiles — video output surfaces under a non-`images` key
// ---------------------------------------------------------------------------

Deno.test("collectFiles: collects a SaveVideo output regardless of the output key", () => {
  const c = new ComfyClient({ baseUrl: "http://host", fetchImpl: fetch });
  const entry: HistoryEntry = {
    outputs: {
      "92": {
        // core SaveVideo may key its file under any name; collectFiles keys off
        // the {filename,type} shape, not the property name.
        videos: [{
          filename: "MiniMax_H3_00001.mp4",
          subfolder: "video",
          type: "output",
          format: "video/mp4",
        }],
      },
      "99": { text: "not a file" }, // ignored
    },
  } as unknown as HistoryEntry;
  const files = c.collectFiles(entry);
  assertEquals(files.length, 1);
  assertEquals(files[0].filename, "MiniMax_H3_00001.mp4");
  assertEquals(files[0].subfolder, "video");
  assertEquals(files[0].format, "video/mp4");
});

Deno.test("collectFiles: still collects images, and ignores empty / non-file arrays", () => {
  const c = new ComfyClient({ baseUrl: "http://host", fetchImpl: fetch });
  const entry: HistoryEntry = {
    outputs: {
      "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
      "10": { gifs: [] },
      "11": { latents: [{ some: "object-without-filename" }] },
    },
  } as unknown as HistoryEntry;
  const files = c.collectFiles(entry);
  assertEquals(files.length, 1);
  assertEquals(files[0].filename, "a.png");
});

// ---------------------------------------------------------------------------
// uploadImage
// ---------------------------------------------------------------------------

Deno.test("uploadImage: POSTs multipart to /upload/image and returns the server name", async () => {
  let seenPath: string | undefined;
  let seenMethod: string | undefined;
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    seenPath = new URL(req.url).pathname;
    seenMethod = req.method;
    return Promise.resolve(
      json({ name: "ref.png", subfolder: "", type: "input" }),
    );
  };
  const c = new ComfyClient({
    baseUrl: "http://host",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const out = await c.uploadImage(new Uint8Array([1, 2, 3]), "ref.png");
  assertEquals(seenPath, "/upload/image");
  assertEquals(seenMethod, "POST");
  assertEquals(out, { name: "ref.png", subfolder: "", type: "input" });
});

// ---------------------------------------------------------------------------
// bundled template contract
// ---------------------------------------------------------------------------

Deno.test("minimax_h3 bundled graph matches the template's node wiring", async () => {
  const path =
    new URL("../../workflows/minimax_h3_r2v.api.json", import.meta.url).pathname;
  const graph = JSON.parse(await Deno.readTextFile(path)) as Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  >;
  assertEquals(graph["138"].class_type, "PrimitiveStringMultiline");
  assert("value" in graph["138"].inputs);
  assertEquals(graph["129"].class_type, "RandomNoise");
  assert("noise_seed" in graph["129"].inputs);
  assertEquals(graph["115"].class_type, "ResolutionSelector");
  assert("aspect_ratio" in graph["115"].inputs);
  assertEquals(graph["137"].class_type, "LoadImage");
  assertEquals(graph["139"].class_type, "LoadImage");
  assertEquals(graph["132"].class_type, "PrimitiveFloat");
  assertEquals(graph["124"].class_type, "BasicScheduler");
  assert("steps" in graph["124"].inputs);
  assertEquals(graph["136"].class_type, "MiniMaxH3ReferenceToVideo");
  assertEquals(graph["136"].inputs["ref_images.ref_image_0"], ["137", 0]);
  assertEquals(graph["136"].inputs["ref_images.ref_image_1"], ["139", 0]);
  // the bundled prompt is neutralized (no shipped session content)
  assertEquals(graph["138"].inputs.value, "A short cinematic clip.");
});

// ---------------------------------------------------------------------------
// generate over the real bundled template
// ---------------------------------------------------------------------------

Deno.test("generate template='minimax_h3': needs a reference image", async () => {
  const { context } = fakeContext();
  const args = model.methods.generate.arguments.parse({
    template: "minimax_h3",
    caption: "a robot waves",
  });
  await assertRejects(
    () => model.methods.generate.execute(args, context),
    Error,
    "needs a reference image",
  );
});

Deno.test("generate template='minimax_h3': uploads a local ref image, patches prompt/seed/duration, drops the 2nd ref slot, saves the video", async () => {
  const dir = await Deno.makeTempDir();
  const refPath = `${dir}/portrait.png`;
  await Deno.writeFile(refPath, new Uint8Array([9, 9, 9, 9]));
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    let posted: Record<string, { inputs: Record<string, unknown> }> | undefined;
    let uploadHit = false;
    const videoHistory = {
      status: { completed: true },
      outputs: {
        "92": {
          videos: [{
            filename: "MiniMax_H3_00001.mp4",
            subfolder: "video",
            type: "output",
            format: "video/mp4",
          }],
        },
      },
    };
    await withFetchStub(
      [
        (req) => {
          if (pathOf(req) !== "/upload/image") return undefined;
          uploadHit = true;
          return json({ name: "portrait.png", subfolder: "", type: "input" });
        },
        (req) => {
          if (pathOf(req) !== "/prompt") return undefined;
          return req.text().then((text) => {
            posted = (JSON.parse(text) as {
              prompt: Record<string, { inputs: Record<string, unknown> }>;
            }).prompt;
            return json(promptQueued);
          });
        },
        (req) =>
          pathOf(req) === "/history/synthetic-prompt-0001"
            ? json({ "synthetic-prompt-0001": videoHistory })
            : undefined,
        (req) =>
          pathOf(req) === "/view"
            ? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
            : undefined,
      ],
      async () => {
        const args = model.methods.generate.arguments.parse({
          template: "minimax_h3",
          caption: "a robot waves hello",
          refImage: refPath,
          duration: 8,
          seed: 4242,
        });
        await model.methods.generate.execute(args, context);
      },
    );
    assert(uploadHit, "local ref image should be uploaded");
    assert(posted);
    // prompt text patched onto node 138/value
    assertEquals(posted["138"].inputs.value, "a robot waves hello");
    // seed patched onto RandomNoise 129/noise_seed
    assertEquals(posted["129"].inputs.noise_seed, 4242);
    // duration patched onto PrimitiveFloat 132/value
    assertEquals(posted["132"].inputs.value, 8);
    // uploaded ref name lands on loader 137
    assertEquals(posted["137"].inputs.image, "portrait.png");
    // single ref image ⇒ 2nd loader dropped + consumer link removed
    assertEquals(posted["139"], undefined);
    assertEquals("ref_images.ref_image_1" in posted["136"].inputs, false);
    // the mp4 was fetched + saved and recorded
    const gen = captured.find((c) => c.spec === "generation");
    assert(gen);
    const data = gen.data as { paths: string[]; seed: number | null };
    assertEquals(data.seed, 4242);
    assertEquals(data.paths.length, 1);
    assert(data.paths[0].endsWith("MiniMax_H3_00001.mp4"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
