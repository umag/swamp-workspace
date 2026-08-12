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
  buildReferences,
  chainModelPatchers,
  type ModelPatcherSpec,
  type ReferenceConfig,
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

// Every speed-patcher class the minimax_h3 template can inject — used to stub
// /object_info so the installed-node check sees them all present.
const ALL_SPEED_CLASSES = [
  "LoraLoaderModelOnly",
  "ApplyMiniMaxH3FirstBlockCache",
  "ModelAttentionBackend",
  "PathchSageAttentionKJ",
  "MiniMaxH3ScheduledSolAttentionPatch",
  "MiniMaxH3ChunkFeedForward",
  "SpectrumApplyMiniMaxH3",
  "MiniMaxH3FusedModulation",
  "MiniMaxH3SigmaShift",
  "SeedVR2VideoUpscaler",
];

/** Route that answers /object_info with the given classes installed (default: all). */
function objectInfoRoute(classes: string[] = ALL_SPEED_CLASSES) {
  return (req: Request) =>
    pathOf(req) === "/object_info"
      ? json(Object.fromEntries(classes.map((c) => [c, {}])))
      : undefined;
}

const REF_CFG: ReferenceConfig = {
  consumerNodeId: "136",
  imagePrefix: "ref_images.ref_image_",
  videoPrefix: "ref_videos.ref_video_",
  videoAudioPrefix: "ref_video_audios.ref_video_audio_",
  maxImages: 9,
  maxVideos: 3,
  placeholderNodeIds: ["137", "139"],
  loadImageClass: "LoadImage",
  loadImageKey: "image",
  loadVideoClass: "LoadVideo",
  loadVideoKey: "file",
  videoComponentsClass: "GetVideoComponents",
  videoComponentsVideoKey: "video",
  videoImagesSlot: 0,
  videoAudioSlot: 1,
};

function refGraph() {
  return {
    "137": { class_type: "LoadImage", inputs: { image: "example.png" } },
    "139": { class_type: "LoadImage", inputs: { image: "example2.png" } },
    "136": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        prompt: ["138", 0],
        ref_image_size: "match",
        "ref_images.ref_image_0": ["137", 0],
        "ref_images.ref_image_1": ["139", 0],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// buildReferences
// ---------------------------------------------------------------------------

Deno.test("buildReferences: injects a LoadImage per image ref and rewires the consumer", () => {
  const out = buildReferences(refGraph(), REF_CFG, [
    { kind: "image", name: "a.png" },
    { kind: "image", name: "b.png" },
  ]);
  // placeholders removed, fresh loaders injected
  assertEquals(out["137"], undefined);
  assertEquals(out["139"], undefined);
  assertEquals(out["ref_img_0"].inputs.image, "a.png");
  assertEquals(out["ref_img_1"].inputs.image, "b.png");
  assertEquals(out["136"].inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assertEquals(out["136"].inputs["ref_images.ref_image_1"], ["ref_img_1", 0]);
  // non-ref inputs preserved
  assertEquals(out["136"].inputs.ref_image_size, "match");
});

Deno.test("buildReferences: a single image ref leaves only slot 0 wired (no dangling ref_image_1)", () => {
  const out = buildReferences(refGraph(), REF_CFG, [
    { kind: "image", name: "only.png" },
  ]);
  assertEquals(out["ref_img_0"].inputs.image, "only.png");
  assertEquals(out["136"].inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assertEquals("ref_images.ref_image_1" in out["136"].inputs, false);
});

Deno.test("buildReferences: a video ref wires LoadVideo→GetVideoComponents into ref_videos + ref_video_audios", () => {
  const out = buildReferences(refGraph(), REF_CFG, [
    { kind: "video", name: "clip.mp4" },
  ]);
  assertEquals(out["ref_vid_0"].class_type, "LoadVideo");
  assertEquals(out["ref_vid_0"].inputs.file, "clip.mp4");
  assertEquals(out["ref_vidc_0"].class_type, "GetVideoComponents");
  assertEquals(out["ref_vidc_0"].inputs.video, ["ref_vid_0", 0]);
  // frames → ref_video_0 (slot 0), audio → ref_video_audio_0 (slot 1)
  assertEquals(out["136"].inputs["ref_videos.ref_video_0"], ["ref_vidc_0", 0]);
  assertEquals(
    out["136"].inputs["ref_video_audios.ref_video_audio_0"],
    ["ref_vidc_0", 1],
  );
  // no image refs ⇒ no image links remain
  assertEquals("ref_images.ref_image_0" in out["136"].inputs, false);
});

Deno.test("buildReferences: mixes an image and a video ref", () => {
  const out = buildReferences(refGraph(), REF_CFG, [
    { kind: "image", name: "face.png" },
    { kind: "video", name: "motion.mp4" },
  ]);
  assertEquals(out["136"].inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assertEquals(out["136"].inputs["ref_videos.ref_video_0"], ["ref_vidc_0", 0]);
});

Deno.test("buildReferences: does not mutate the input graph", () => {
  const input = refGraph();
  buildReferences(input, REF_CFG, [{ kind: "image", name: "only.png" }]);
  assertEquals(input["139"]?.class_type, "LoadImage"); // original untouched
  assertEquals(input["137"].inputs.image, "example.png");
});

Deno.test("buildReferences: throws when video refs exceed the node maximum", () => {
  const vids = Array.from({ length: 4 }, (_, i) => ({
    kind: "video" as const,
    name: `v${i}.mp4`,
  }));
  assertThrows(
    () => buildReferences(refGraph(), REF_CFG, vids),
    Error,
    "too many reference videos",
  );
});

Deno.test("buildReferences: throws when the consumer node is missing", () => {
  const g = refGraph();
  delete (g as Record<string, unknown>)["136"];
  assertThrows(
    () => buildReferences(g, REF_CFG, [{ kind: "image", name: "a.png" }]),
    Error,
    "consumer node '136' not found",
  );
});

// ---------------------------------------------------------------------------
// chainModelPatchers — the speed chain
// ---------------------------------------------------------------------------

function speedGraph() {
  return {
    "127": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
    "124": {
      class_type: "BasicScheduler",
      inputs: { steps: 20, model: ["127", 0] },
    },
    "126": {
      class_type: "BasicGuider",
      inputs: { conditioning: ["136", 0], model: ["127", 0] },
    },
  };
}

const SOURCE = { nodeId: "127", slot: 0 };
const CONSUMERS = [
  { nodeId: "124", key: "model" },
  { nodeId: "126", key: "model" },
];

Deno.test("chainModelPatchers: splices patchers in series and repoints every consumer", () => {
  const patchers: ModelPatcherSpec[] = [
    {
      classType: "ModelAttentionBackend",
      modelKey: "model",
      modelOutSlot: 0,
      inputs: { attention: "comfy kitchen attention" },
    },
    {
      classType: "SpectrumApplyMiniMaxH3",
      modelKey: "model",
      modelOutSlot: 0,
      inputs: { enabled: true, degree: 4 },
    },
  ];
  const out = chainModelPatchers(speedGraph(), SOURCE, CONSUMERS, patchers);
  // first patcher reads the raw UNET model
  assertEquals(out["speed_0_ModelAttentionBackend"].inputs.model, ["127", 0]);
  assertEquals(
    out["speed_0_ModelAttentionBackend"].inputs.attention,
    "comfy kitchen attention",
  );
  // second reads the first
  assertEquals(out["speed_1_SpectrumApplyMiniMaxH3"].inputs.model, [
    "speed_0_ModelAttentionBackend",
    0,
  ]);
  assertEquals(out["speed_1_SpectrumApplyMiniMaxH3"].inputs.degree, 4);
  // both consumers now read the last patcher
  assertEquals(out["124"].inputs.model, ["speed_1_SpectrumApplyMiniMaxH3", 0]);
  assertEquals(out["126"].inputs.model, ["speed_1_SpectrumApplyMiniMaxH3", 0]);
});

Deno.test("chainModelPatchers: empty patcher list is a no-op clone (consumers untouched)", () => {
  const out = chainModelPatchers(speedGraph(), SOURCE, CONSUMERS, []);
  assertEquals(out["124"].inputs.model, ["127", 0]);
  assertEquals(out["126"].inputs.model, ["127", 0]);
});

Deno.test("chainModelPatchers: throws when a consumer node is missing", () => {
  const g = speedGraph();
  delete (g as Record<string, unknown>)["126"];
  assertThrows(
    () =>
      chainModelPatchers(g, SOURCE, CONSUMERS, [{
        classType: "ModelAttentionBackend",
        modelKey: "model",
        modelOutSlot: 0,
        inputs: {},
      }]),
    Error,
    "consumer node '126' not found",
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

Deno.test("generate template='minimax_h3': needs a reference (image or video)", async () => {
  const { context } = fakeContext();
  const args = model.methods.generate.arguments.parse({
    template: "minimax_h3",
    caption: "a robot waves",
  });
  await assertRejects(
    () => model.methods.generate.execute(args, context),
    Error,
    "needs a reference",
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
        objectInfoRoute(),
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
    // uploaded ref name lands on the injected image loader; placeholders gone
    assertEquals(posted["ref_img_0"].inputs.image, "portrait.png");
    assertEquals(posted["137"], undefined);
    assertEquals(posted["139"], undefined);
    // single ref image ⇒ only slot 0 wired, no dangling ref_image_1
    assertEquals(posted["136"].inputs["ref_images.ref_image_0"], [
      "ref_img_0",
      0,
    ]);
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

Deno.test("generate template='minimax_h3': speed splices the selected patchers (in template order) between UNET and the sampler/guider, with speedOptions overrides", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    let posted: Record<string, { inputs: Record<string, unknown> }> | undefined;
    const videoHistory = {
      status: { completed: true },
      outputs: {
        "92": {
          videos: [{ filename: "v.mp4", subfolder: "", type: "output" }],
        },
      },
    };
    await withFetchStub(
      [
        objectInfoRoute(),
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
            ? new Response(new Uint8Array([1]), { status: 200 })
            : undefined,
      ],
      async () => {
        const args = model.methods.generate.arguments.parse({
          template: "minimax_h3",
          caption: "go fast",
          // a server-side input name (no local file) ⇒ no upload
          refImage: "already_on_server.png",
          // deliberately out of template order — injection still follows the
          // template's declared order (attentionBackend before spectrum)
          speed: ["spectrum", "attentionBackend"],
          speedOptions: { attentionBackend: { attention: "pytorch attention" } },
        });
        await model.methods.generate.execute(args, context);
      },
    );
    assert(posted);
    // attentionBackend injected first (reads raw UNET 127), override applied
    const ab = posted["speed_0_ModelAttentionBackend"];
    assert(ab, "ModelAttentionBackend should be first in the chain");
    assertEquals(ab.inputs.model, ["127", 0]);
    assertEquals(ab.inputs.attention, "pytorch attention"); // speedOptions override
    // spectrum injected second, reading the attention backend
    const sp = posted["speed_1_SpectrumApplyMiniMaxH3"];
    assert(sp);
    assertEquals(sp.inputs.model, ["speed_0_ModelAttentionBackend", 0]);
    assertEquals(sp.inputs.degree, 4); // template default preserved
    // sampler + guider now read the last patcher
    assertEquals(posted["124"].inputs.model, [
      "speed_1_SpectrumApplyMiniMaxH3",
      0,
    ]);
    assertEquals(posted["126"].inputs.model, [
      "speed_1_SpectrumApplyMiniMaxH3",
      0,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate: an unknown speed patcher id throws, naming the known ones", async () => {
  const { context } = fakeContext();
  const args = model.methods.generate.arguments.parse({
    template: "minimax_h3",
    caption: "x",
    refImage: "on_server.png",
    speed: ["turbocharger"],
  });
  await withFetchStub([objectInfoRoute()], async () => {
    await assertRejects(
      () => model.methods.generate.execute(args, context),
      Error,
      "unknown speed patcher 'turbocharger'",
    );
  });
});

Deno.test("generate: speed on a template without speed wiring throws", async () => {
  const { context } = fakeContext();
  const args = model.methods.generate.arguments.parse({
    template: "ideogram",
    caption: "x",
    speed: ["attentionBackend"],
  });
  await assertRejects(
    () => model.methods.generate.execute(args, context),
    Error,
    "has no speed patchers",
  );
});

/** Run generate over the bundled minimax_h3 template, returning the POSTed graph. */
async function postedFor(
  extra: Record<string, unknown>,
  installedClasses: string[] = ALL_SPEED_CLASSES,
): Promise<Record<string, { inputs: Record<string, unknown> }>> {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    let posted: Record<string, { inputs: Record<string, unknown> }> | undefined;
    const videoHistory = {
      status: { completed: true },
      outputs: {
        "92": { videos: [{ filename: "v.mp4", subfolder: "", type: "output" }] },
      },
    };
    const objectInfo = Object.fromEntries(
      installedClasses.map((c) => [c, {}]),
    );
    await withFetchStub(
      [
        (req) =>
          pathOf(req) === "/object_info" ? json(objectInfo) : undefined,
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
            ? new Response(new Uint8Array([1]), { status: 200 })
            : undefined,
      ],
      async () => {
        const args = model.methods.generate.arguments.parse({
          template: "minimax_h3",
          caption: "x",
          refImage: "on_server.png",
          ...extra,
        });
        await model.methods.generate.execute(args, context);
      },
    );
    assert(posted);
    return posted;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("generate template='minimax_h3': omitting speed applies the full default stack (all installed), repointing the consumers", async () => {
  const posted = await postedFor({});
  // default patchers injected in template-declared order (firstBlockCache first)
  const ids = [
    "speed_0_ApplyMiniMaxH3FirstBlockCache",
    "speed_1_ModelAttentionBackend",
    "speed_2_PathchSageAttentionKJ",
    "speed_3_MiniMaxH3ScheduledSolAttentionPatch",
    "speed_4_MiniMaxH3ChunkFeedForward",
    "speed_5_SpectrumApplyMiniMaxH3",
    "speed_6_MiniMaxH3FusedModulation",
  ];
  for (const id of ids) assert(posted[id], `${id} should be present`);
  // first reads the raw UNET; last feeds both consumers
  assertEquals(
    posted["speed_0_ApplyMiniMaxH3FirstBlockCache"].inputs.model,
    ["127", 0],
  );
  assertEquals(posted["124"].inputs.model, ["speed_6_MiniMaxH3FusedModulation", 0]);
  assertEquals(posted["126"].inputs.model, ["speed_6_MiniMaxH3FusedModulation", 0]);
});

Deno.test("generate template='minimax_h3': an explicit empty speed:[] disables the default stack", async () => {
  const posted = await postedFor({ speed: [] });
  assertEquals("speed_0_ModelAttentionBackend" in posted, false);
  // consumers read the raw UNET, unpatched
  assertEquals(posted["124"].inputs.model, ["127", 0]);
  assertEquals(posted["126"].inputs.model, ["127", 0]);
});

Deno.test("generate template='minimax_h3': keepRefAudio routes CreateVideo audio from the ref video and drops VAEDecodeAudio", async () => {
  const posted = await postedFor({ refVideo: "clip.mp4", keepRefAudio: true });
  // ref video builds ref_vid_0 → ref_vidc_0 (GetVideoComponents); audio = out slot 1
  assertEquals(posted["130"].inputs.audio, ["ref_vidc_0", 1]);
  // the model-audio decode node is removed
  assertEquals("121" in posted, false);
});

Deno.test("generate template='minimax_h3': without keepRefAudio the model audio path is intact", async () => {
  const posted = await postedFor({ refVideo: "clip.mp4" });
  assertEquals(posted["130"].inputs.audio, ["121", 0]); // CreateVideo ← VAEDecodeAudio
  assert(posted["121"], "VAEDecodeAudio should remain");
});

Deno.test("generate template='minimax_h3': turbo injects the LoRA/cache/sigma-shift chain and drops steps to 8", async () => {
  const posted = await postedFor({ turbo: true });
  // turbo preset (installed nodes only): turboLora → firstBlockCache → sage → sigmaShift
  assertEquals(
    posted["speed_0_LoraLoaderModelOnly"].inputs.lora_name,
    "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors",
  );
  assertEquals(posted["speed_0_LoraLoaderModelOnly"].inputs.model, ["127", 0]);
  assert(posted["speed_1_ApplyMiniMaxH3FirstBlockCache"], "firstBlockCache");
  assert(posted["speed_3_MiniMaxH3SigmaShift"], "sigmaShift last");
  assertEquals(posted["speed_3_MiniMaxH3SigmaShift"].inputs.shift_video, 12);
  // non-turbo default patchers are NOT present
  assertEquals("speed_0_ModelAttentionBackend" in posted, false);
  // consumers read the last (sigma shift); steps dropped to 8
  assertEquals(posted["124"].inputs.model, ["speed_3_MiniMaxH3SigmaShift", 0]);
  assertEquals(posted["124"].inputs.steps, 8);
});

Deno.test("generate: an explicit speed patcher whose node is NOT installed errors clearly", async () => {
  await assertRejects(
    // server has everything EXCEPT the sol-attn node
    () =>
      postedFor(
        { speed: ["attentionBackend", "solAttention"] },
        ALL_SPEED_CLASSES.filter((c) => c !== "MiniMaxH3ScheduledSolAttentionPatch"),
      ),
    Error,
    "not installed on the ComfyUI server",
  );
});

Deno.test("generate: the DEFAULT speed stack silently skips patchers whose node is missing", async () => {
  // only attentionBackend + sage installed; default also lists the missing ones
  const posted = await postedFor({}, ["ModelAttentionBackend", "PathchSageAttentionKJ"]);
  assert(posted["speed_0_ModelAttentionBackend"], "installed one injected");
  assert(posted["speed_1_PathchSageAttentionKJ"], "installed one injected");
  // the missing spectrum/sol/etc. are simply absent — no error
  assertEquals("speed_2_SpectrumApplyMiniMaxH3" in posted, false);
  // consumers still repointed at the last INSTALLED patcher
  assertEquals(posted["124"].inputs.model, ["speed_1_PathchSageAttentionKJ", 0]);
});

Deno.test("generate template='minimax_h3': upscale splices SeedVR2 between the frames and CreateVideo", async () => {
  const posted = await postedFor({ upscale: true, upscaleResolution: 1440 }) as
    Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  assertEquals(posted["upscale_dit"].class_type, "SeedVR2LoadDiTModel");
  assertEquals(posted["upscale_vae"].class_type, "SeedVR2LoadVAEModel");
  assertEquals(posted["upscale_seedvr2"].class_type, "SeedVR2VideoUpscaler");
  // upscaler reads VAEDecode(122) frames + the DiT/VAE loaders, target res applied
  assertEquals(posted["upscale_seedvr2"].inputs.image, ["122", 0]);
  assertEquals(posted["upscale_seedvr2"].inputs.dit, ["upscale_dit", 0]);
  assertEquals(posted["upscale_seedvr2"].inputs.vae, ["upscale_vae", 0]);
  assertEquals(posted["upscale_seedvr2"].inputs.resolution, 1440);
  // CreateVideo(130) now reads the upscaled frames, not the raw decode
  assertEquals(posted["130"].inputs.images, ["upscale_seedvr2", 0]);
});

Deno.test("generate: upscale when SeedVR2 isn't installed throws", async () => {
  await assertRejects(
    () =>
      postedFor(
        { upscale: true },
        ALL_SPEED_CLASSES.filter((c) => c !== "SeedVR2VideoUpscaler"),
      ),
    Error,
    "SeedVR2",
  );
});

Deno.test("generate: turbo on a template without a turbo preset throws", async () => {
  const { context } = fakeContext();
  const args = model.methods.generate.arguments.parse({
    template: "ideogram",
    caption: "x",
    turbo: true,
  });
  await assertRejects(
    () => model.methods.generate.execute(args, context),
    Error,
    "has no turbo preset",
  );
});

Deno.test("generate template='minimax_h3': keepRefAudio without a ref video throws", async () => {
  const { context } = fakeContext();
  const args = model.methods.generate.arguments.parse({
    template: "minimax_h3",
    caption: "x",
    refImage: "on_server.png",
    keepRefAudio: true,
  });
  await assertRejects(
    () => model.methods.generate.execute(args, context),
    Error,
    "needs a reference video",
  );
});
