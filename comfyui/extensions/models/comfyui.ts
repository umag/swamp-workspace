import { z } from "npm:zod@4";
import { ComfyClient, type FileRef } from "./lib/comfy_client.ts";
import {
  buildCaption,
  parseGeneratedCaption,
  serializeCaption,
} from "./lib/caption.ts";
import {
  type ApiGraph,
  applyIdeogramOverrides,
  buildReferences,
  chainLoras,
  chainModelPatchers,
  type LoraSpec,
  type ModelPatcherSpec,
  patchWorkflow,
  type ReferenceConfig,
  type ReferenceSpec,
} from "./lib/workflow_patch.ts";
import { claudeComplete } from "./lib/anthropic.ts";
import { buildCaptionMessages } from "./lib/ideogram_prompt.ts";

/** Global configuration for a ComfyUI server instance. */
export const GlobalArgs = z.object({
  baseUrl: z.string().default("http://127.0.0.1:8188"),
  clientId: z.string().optional(),
  workflowPath: z.string().optional(),
  outputDir: z.string().default("./out"),
  pollIntervalMs: z.number().default(1500),
  timeoutMs: z.number().default(300000),
  anthropicApiKey: z.string().optional().meta({ sensitive: true }),
  captionModel: z.string().default("claude-sonnet-4-6"),
  captionMaxTokens: z.number().default(2048),
});

type GlobalArgsType = z.infer<typeof GlobalArgs>;

interface Context {
  globalArgs: GlobalArgsType;
  writeResource(
    spec: string,
    name: string,
    data: unknown,
  ): void | Promise<void>;
  /** Resolve a path to a file bundled with the extension (additionalFiles). */
  extensionFile(rel: string): string;
}

/**
 * Bundled API-format workflow templates. Each names the graph file plus which
 * node/input the caption, seed and resolution are patched into — so a caller
 * picks a `template` by name instead of memorizing node ids. `generate`
 * defaults to `ideogram`; explicit `*NodeId`/`*InputKey` args still override.
 */
interface WorkflowTemplate {
  file: string;
  caption: { nodeId: string; key: string };
  seed: { nodeId: string; key: string };
  resolution: { nodeId: string; key: string };
  /**
   * Optional style-LoRA wiring. One or more LoRAs are chained onto the model
   * via `LoraLoaderModelOnly` nodes (see `chainLoras`); `enable` flips the
   * boolean that routes the sampler's model through the LoRA chain (Krea gates
   * the LoRA behind a switch that defaults to off).
   */
  lora?: {
    loaderNodeId: string;
    nameKey: string;
    strengthKey: string;
    modelKey: string;
    consumerNodeId: string;
    consumerKey: string;
    enableNodeId: string;
    enableKey: string;
  };
  /**
   * Reference wiring for reference-to-video templates. `generate`'s
   * `refImage(s)`/`refVideo(s)` are built onto the consumer node via
   * `buildReferences`. A template with `references` requires at least one
   * reference.
   */
  references?: ReferenceConfig;
  /**
   * Audio wiring for `keepRefAudio`: the `CreateVideo` node whose `audio` input
   * is repointed at the first reference video's audio, and the `VAEDecodeAudio`
   * node that generates model audio (deleted when keeping the reference audio).
   */
  audio?: {
    createVideoNodeId: string;
    audioKey: string;
    decodeNodeId: string;
  };
  /**
   * SeedVR2 video-upscale wiring for `upscale`. Inserts a DiT + VAE loader and a
   * `SeedVR2VideoUpscaler` between the decoded frames (`imageSource`) and the
   * video assembler (`consumer`), repointing the consumer at the upscaled frames.
   */
  upscale?: {
    imageSource: { nodeId: string; slot: number };
    consumer: { nodeId: string; key: string };
    ditClass: string;
    ditModelKey: string;
    ditDefaults: Record<string, unknown>;
    vaeClass: string;
    vaeDefaults: Record<string, unknown>;
    upscalerClass: string;
    imageKey: string;
    ditKey: string;
    vaeKey: string;
    resolutionKey: string;
    defaultResolution: number;
    upscalerDefaults: Record<string, unknown>;
  };
  /** Diffusion-model loader (UNETLoader), if the template lets you swap it. */
  model?: { nodeId: string; key: string };
  /** Clip duration in seconds, if the template exposes one (video). */
  duration?: { nodeId: string; key: string };
  /** Sampler step count, if the template exposes one. */
  steps?: { nodeId: string; key: string };
  /** Output size in megapixels (ResolutionSelector), if the template exposes it. */
  megapixels?: { nodeId: string; key: string };
  /**
   * Optional speed/optimization patchers spliced onto the model between a
   * source node and its consumers. `generate`'s `speed` (a list of patcher ids)
   * selects which to enable; they inject in the declared order (the
   * research-recommended order: attention backend → attention patch → FF
   * chunking → cache). `speedOptions` overrides a patcher's default inputs.
   * `default` is the patcher set applied when `speed` is omitted; pass an
   * explicit `speed: []` to disable them.
   */
  speed?: {
    modelSource: { nodeId: string; slot: number };
    consumers: { nodeId: string; key: string }[];
    patchers: SpeedPatcher[];
    default: string[];
  };
  /**
   * Turbo preset: the distillation-LoRA fast path. `turbo: true` selects this
   * `speed` set (a turbo LoRA + sigma shift + cache) and drops the sampler to
   * `steps` — a big speedup, but needs the turbo LoRA installed on the server.
   */
  turbo?: {
    speed: string[];
    steps: number;
  };
}

/** A named, ordered speed patcher a template exposes for `generate`'s `speed`. */
interface SpeedPatcher {
  /** Stable id used in the `speed` arg (e.g. `attentionBackend`, `spectrum`). */
  id: string;
  classType: string;
  modelKey: string;
  modelOutSlot: number;
  /** Default node inputs (excluding the model wire); overridable per run. */
  defaults: Record<string, unknown>;
}

const TEMPLATES: Record<string, WorkflowTemplate> = {
  ideogram: {
    file: "workflows/ideogram.api.json",
    caption: { nodeId: "98:24", key: "text" },
    seed: { nodeId: "98:18", key: "noise_seed" },
    resolution: { nodeId: "37", key: "aspect_ratio" },
  },
  krea: {
    file: "workflows/krea.api.json",
    caption: { nodeId: "30:6", key: "text" },
    seed: { nodeId: "30:3", key: "seed" },
    resolution: { nodeId: "49", key: "aspect_ratio" },
    lora: {
      loaderNodeId: "30:15",
      nameKey: "lora_name",
      strengthKey: "strength_model",
      modelKey: "model",
      consumerNodeId: "30:22",
      consumerKey: "on_true",
      enableNodeId: "30:23",
      enableKey: "value",
    },
  },
  minimax_h3: {
    file: "workflows/minimax_h3_r2v.api.json",
    // The prompt is plain multiline text (not an Ideogram bbox caption); pass it
    // as `caption`. Node 138 PrimitiveStringMultiline/value.
    caption: { nodeId: "138", key: "value" },
    seed: { nodeId: "129", key: "noise_seed" },
    resolution: { nodeId: "115", key: "aspect_ratio" },
    megapixels: { nodeId: "115", key: "megapixels" },
    references: {
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
    },
    audio: {
      createVideoNodeId: "130",
      audioKey: "audio",
      decodeNodeId: "121",
    },
    upscale: {
      // VAEDecode(122) frames → SeedVR2 → CreateVideo(130) images.
      imageSource: { nodeId: "122", slot: 0 },
      consumer: { nodeId: "130", key: "images" },
      ditClass: "SeedVR2LoadDiTModel",
      ditModelKey: "model",
      ditDefaults: {
        model: "seedvr2_ema_3b_fp8_e4m3fn.safetensors",
        device: "cuda:0",
      },
      vaeClass: "SeedVR2LoadVAEModel",
      vaeDefaults: { model: "ema_vae_fp16.safetensors", device: "cuda:0" },
      upscalerClass: "SeedVR2VideoUpscaler",
      imageKey: "image",
      ditKey: "dit",
      vaeKey: "vae",
      resolutionKey: "resolution",
      defaultResolution: 1080,
      // All required widget inputs (API format doesn't auto-fill UI defaults).
      upscalerDefaults: {
        seed: 42,
        max_resolution: 0,
        batch_size: 5,
        uniform_batch_size: false,
        color_correction: "lab",
      },
    },
    // UNETLoader — swap the diffusion checkpoint (e.g. an fl2va×ref2va hybrid).
    model: { nodeId: "127", key: "unet_name" },
    duration: { nodeId: "132", key: "value" },
    steps: { nodeId: "124", key: "steps" },
    speed: {
      // UNETLoader (MODEL) → chain → BasicScheduler + BasicGuider.
      modelSource: { nodeId: "127", slot: 0 },
      consumers: [
        { nodeId: "124", key: "model" },
        { nodeId: "126", key: "model" },
      ],
      // Declared in the recommended injection order. Defaults are the
      // community "fast" values (attention backend uses the comfy-kitchen int8
      // path — the ~39s headline; Spectrum/Sol values match the shared config).
      // `turboLora` must be FIRST (right after the UNET) and `sigmaShift` LAST.
      patchers: [
        {
          // Distillation LoRA → run in ~4-8 steps. NEEDS the file installed in
          // the server's loras/ folder. Model-only (the ref2v node uses raw CLIP).
          id: "turboLora",
          classType: "LoraLoaderModelOnly",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: {
            lora_name:
              "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors",
            strength_model: 1,
          },
        },
        {
          id: "firstBlockCache",
          classType: "ApplyMiniMaxH3FirstBlockCache",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: {
            mode: "H3 Fast — 0.10 / max 2",
            threshold: 0.1,
            start_percent: 0.1,
            end_percent: 0.95,
            max_consecutive_hits: 2,
            temporal_guard: false,
          },
        },
        {
          id: "attentionBackend",
          classType: "ModelAttentionBackend",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: { attention: "comfy kitchen attention" },
        },
        {
          id: "sage",
          classType: "PathchSageAttentionKJ",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: { sage_attention: "auto", allow_compile: false },
        },
        {
          id: "solAttention",
          classType: "MiniMaxH3ScheduledSolAttentionPatch",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: {
            enabled: true,
            tau_start: 1.3,
            tau_end: 0.8,
            curve: "linear",
            min_tokens: 4096,
            strict: false,
            dense_percent: 0,
            thresh_type: "diag",
            int8_qk: false,
            int8_pv: false,
            sink_conditioning: "exact_kv",
            dense_blocks: "",
          },
        },
        {
          id: "chunkFeedForward",
          classType: "MiniMaxH3ChunkFeedForward",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: { enabled: true, chunks: 2, min_tokens: 8192 },
        },
        {
          id: "spectrum",
          classType: "SpectrumApplyMiniMaxH3",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: {
            enabled: true,
            blend_weight: 0.5,
            degree: 4,
            ridge_lambda: 0.1,
            window_size: 2,
            flex_window: 0.75,
            warmup_steps: 5,
            tail_actual_steps: 1,
            max_history: 8,
            debug: false,
            history_storage: "system_ram",
            bootstrap_first_forecast: true,
          },
        },
        {
          id: "fusedModulation",
          classType: "MiniMaxH3FusedModulation",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: { enabled: true },
        },
        {
          // Noise-schedule shift for the distilled/turbo model. Last in the
          // chain (right before the sampler/guider).
          id: "sigmaShift",
          classType: "MiniMaxH3SigmaShift",
          modelKey: "model",
          modelOutSlot: 0,
          defaults: { shift_video: 12, shift_audio: 3 },
        },
      ],
      // Applied when `speed` is omitted. The full stack — live-measured ~43%
      // faster (1m5s vs 1m53s base) with all six accepted together. Pass
      // `speed: []` to disable, or a subset to pick.
      default: [
        "attentionBackend",
        "sage",
        "firstBlockCache",
        "solAttention",
        "chunkFeedForward",
        "spectrum",
        "fusedModulation",
      ],
    },
    // `turbo: true` → the 4-step distillation-LoRA fast path (needs the turbo
    // LoRA installed). LoRA first, cache, sage/sol attention, sigma shift last,
    // at 8 steps instead of 20.
    turbo: {
      // Only currently-installed nodes (sol-attn was removed in a conflict fix).
      // The essentials are turboLora + sigmaShift + low steps; cache/sage help.
      speed: ["turboLora", "firstBlockCache", "sage", "sigmaShift"],
      steps: 8,
    },
  },
};

const DEFAULT_TEMPLATE = "ideogram";

const NoArgs = z.object({});

const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const BuildCaptionArgs = z.object({
  summary: z.string(),
  style: z.record(z.string(), z.unknown()).optional(),
  background: z.string().optional(),
  objects: z.array(
    z.object({
      bbox: BBox,
      desc: z.string(),
      type: z.enum(["obj", "text"]).optional(),
      color_palette: z.array(z.string()).optional(),
    }),
  ).optional(),
});

const GenerateArgs = z.object({
  caption: z.string().optional(),
  captionNodeId: z.string().optional(),
  captionInputKey: z.string().optional(),
  seed: z.number().optional(),
  seedNodeId: z.string().optional(),
  seedInputKey: z.string().optional(),
  resolution: z.string().optional(),
  resolutionNodeId: z.string().optional(),
  resolutionInputKey: z.string().optional(),
  // Override the diffusion checkpoint the UNETLoader loads (a filename already in
  // the server's diffusion_models/unet folder), e.g. an fl2va×ref2va hybrid for
  // stronger reference/clothes transfer. Omit to keep the template's default.
  unetModel: z.string().optional(),
  refImage: z.string().optional(),
  refImages: z.array(z.string()).optional(),
  refVideo: z.string().optional(),
  refVideos: z.array(z.string()).optional(),
  keepRefAudio: z.boolean().optional(),
  turbo: z.boolean().optional(),
  upscale: z.boolean().optional(),
  upscaleResolution: z.number().optional(),
  upscaleModel: z.string().optional(),
  duration: z.number().optional(),
  steps: z.number().optional(),
  megapixels: z.number().optional(),
  speed: z.array(z.string()).optional(),
  speedOptions: z.record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  template: z.string().optional(),
  lora: z.string().optional(),
  loras: z.array(z.string()).optional(),
  loraStrength: z.number().optional(),
  loraStrengths: z.array(z.number()).optional(),
  workflow: z.record(
    z.string(),
    z.object({
      class_type: z.string(),
      inputs: z.record(z.string(), z.unknown()),
    }),
  ).optional(),
});

const GenerateCaptionArgs = z.object({
  idea: z.string(),
  aspectRatio: z.string().default("1:1"),
});

const GenerateBatchArgs = GenerateArgs.extend({
  count: z.number().int().positive().max(50).optional(),
  seeds: z.array(z.number()).max(50).optional(),
});

const GenerateLongArgs = GenerateArgs.extend({
  totalDuration: z.number().positive().max(600),
  fragmentDuration: z.number().positive().max(15).default(5),
  // Length (seconds) of the previous fragment's TAIL carried into the next one
  // as a continuation reference video (`<Video 2>`) — a moving clip conveys the
  // subject's velocity and the camera trajectory at the cut, so H3 continues the
  // motion instead of re-accelerating from a frozen still (the jump-cut cause).
  // ~0.5s ≈ 10-12 frames. Set 0 to fall back to a single last-frame still.
  continuationSeconds: z.number().min(0).max(3).default(0.5),
  // Snap each fragment boundary to the lowest-motion frame within `seamWindow`
  // seconds of its nominal position (profiled from the source motion video), so
  // cuts land on held/near-still poses — not mid-jump or mid-turn, where facing
  // is ambiguous and the next fragment forgets which way the face points. Needs
  // a LOCAL `refVideo`. Set false for fixed uniform windows.
  seamAlign: z.boolean().default(true),
  seamWindow: z.number().min(0).max(3).default(1.0),
});

const Ref2iArgs = GenerateArgs.extend({
  // Clothing/style SOURCE image → <Picture 1>; the garments/style are copied FROM
  // here. A local path or a server-side input filename.
  styleImage: z.string(),
  // Target PERSON image → <Picture 2>; identity/pose/background are kept, only the
  // outfit is replaced. A local path or a server-side input filename.
  targetImage: z.string(),
});

const NodeInfoArgs = z.object({
  classType: z.string(),
});

/** Resource schemas — the shapes written via `writeResource`. */
const ServerResource = z.object({
  comfyuiVersion: z.string().optional(),
  system: z.unknown().optional(),
  devices: z.unknown().optional(),
});

const CaptionResource = z.object({
  caption: z.unknown(),
  text: z.string(),
});

const NodeInfoResource = z.object({
  classType: z.string(),
  info: z.unknown(),
});

const GenerationResource = z.object({
  promptId: z.string(),
  images: z.array(z.unknown()),
  paths: z.array(z.string()),
  seed: z.number().nullable(),
});

const BatchResource = z.object({
  count: z.number(),
  seeds: z.array(z.number()),
  items: z.array(z.object({
    seed: z.number(),
    promptId: z.string(),
    paths: z.array(z.string()),
  })),
  paths: z.array(z.string()),
});

const LongResource = z.object({
  count: z.number(),
  fragments: z.array(z.string()),
  paths: z.array(z.string()),
});

const Ref2iResource = z.object({
  promptId: z.string(),
  paths: z.array(z.string()),
  seed: z.number().nullable(),
});

/**
 * A random seed in `[0, 2^53)` — uniform, safe as a JSON integer and a valid
 * ComfyUI seed input. 21 high bits + 32 low bits from the crypto RNG.
 */
function randomSeed(): number {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return (hi % 0x200000) * 0x100000000 + lo;
}

type GenArgs = z.infer<typeof GenerateArgs>;

/** Resolve the API graph to drive and the template whose node ids to default to. */
async function loadGraphAndTemplate(
  args: GenArgs,
  context: Context,
): Promise<{ graph: ApiGraph; tpl: WorkflowTemplate | undefined }> {
  if (args.template && !TEMPLATES[args.template]) {
    throw new Error(
      `unknown template '${args.template}'. Known: ${
        Object.keys(TEMPLATES).join(", ")
      }`,
    );
  }
  if (args.workflow) {
    return {
      graph: args.workflow as ApiGraph,
      tpl: args.template ? TEMPLATES[args.template] : undefined,
    };
  }
  if (args.template) {
    const tpl = TEMPLATES[args.template];
    return {
      graph: JSON.parse(
        await Deno.readTextFile(context.extensionFile(tpl.file)),
      ) as ApiGraph,
      tpl,
    };
  }
  if (context.globalArgs.workflowPath) {
    return {
      graph: JSON.parse(
        await Deno.readTextFile(context.globalArgs.workflowPath),
      ) as ApiGraph,
      tpl: undefined,
    };
  }
  const tpl = TEMPLATES[DEFAULT_TEMPLATE];
  return {
    graph: JSON.parse(
      await Deno.readTextFile(context.extensionFile(tpl.file)),
    ) as ApiGraph,
    tpl,
  };
}

/** Apply caption, resolution and any LoRA chain — everything except the seed. */
function applyContentOverrides(
  graph: ApiGraph,
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
): ApiGraph {
  let patched = applyIdeogramOverrides(graph, {
    caption: args.caption,
    captionNodeId: args.captionNodeId ?? tpl?.caption.nodeId,
    captionInputKey: args.captionInputKey ?? tpl?.caption.key,
    resolution: args.resolution,
    resolutionNodeId: args.resolutionNodeId ?? tpl?.resolution.nodeId,
    resolutionInputKey: args.resolutionInputKey ?? tpl?.resolution.key,
  });

  const names = args.loras && args.loras.length > 0
    ? args.loras
    : args.lora !== undefined
    ? [args.lora]
    : [];
  if (names.length > 0) {
    const lc = tpl?.lora;
    if (!lc) {
      throw new Error(
        `template '${args.template ?? DEFAULT_TEMPLATE}' has no LoRA wiring; ` +
          "pick a template that supports LoRAs (e.g. 'krea')",
      );
    }
    const specs: LoraSpec[] = names.map((name, i) => ({
      name,
      strength: args.loraStrengths?.[i] ?? args.loraStrength ?? 1.0,
    }));
    patched = chainLoras(patched, {
      loaderNodeId: lc.loaderNodeId,
      nameKey: lc.nameKey,
      strengthKey: lc.strengthKey,
      modelKey: lc.modelKey,
      consumerNodeId: lc.consumerNodeId,
      consumerKey: lc.consumerKey,
    }, specs);
    patched = patchWorkflow(patched, [
      { nodeId: lc.enableNodeId, inputs: { [lc.enableKey]: true } },
    ]);
  }
  return patched;
}

/** Patch the optional video knobs (duration seconds, sampler steps, megapixels). */
function applyVideoOverrides(
  graph: ApiGraph,
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
): ApiGraph {
  const patches = [];
  if (args.duration !== undefined && tpl?.duration) {
    patches.push({
      nodeId: tpl.duration.nodeId,
      inputs: { [tpl.duration.key]: args.duration },
    });
  }
  if (args.steps !== undefined && tpl?.steps) {
    patches.push({
      nodeId: tpl.steps.nodeId,
      inputs: { [tpl.steps.key]: args.steps },
    });
  }
  if (args.megapixels !== undefined && tpl?.megapixels) {
    patches.push({
      nodeId: tpl.megapixels.nodeId,
      inputs: { [tpl.megapixels.key]: args.megapixels },
    });
  }
  return patches.length > 0 ? patchWorkflow(graph, patches) : graph;
}

/**
 * Resolve a reference value to a server-side input filename. An existing local
 * file is uploaded (`/upload/image` accepts image and video files) and referenced
 * by its returned name (prefixed with a subfolder when set); any other value is a
 * name already present in the server's input directory and passes through.
 */
async function resolveReferenceName(
  client: ComfyClient,
  value: string,
): Promise<string> {
  let isLocalFile = false;
  try {
    isLocalFile = (await Deno.stat(value)).isFile;
  } catch {
    isLocalFile = false;
  }
  if (!isLocalFile) return value;
  const bytes = await Deno.readFile(value);
  const filename = value.split(/[\\/]/).pop() || "reference";
  const up = await client.uploadImage(bytes, filename, { overwrite: true });
  return up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
}

/**
 * Build a template's reference inputs from `refImage(s)` and `refVideo(s)`
 * (uploading any local files first, videos wired as `LoadVideo →
 * GetVideoComponents`). A no-op for templates without `references`; throws if
 * such a template gets no references at all.
 */
async function applyReferences(
  graph: ApiGraph,
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
  client: ComfyClient,
): Promise<ApiGraph> {
  if (!tpl?.references) return graph;
  const images = args.refImages && args.refImages.length > 0
    ? args.refImages
    : args.refImage !== undefined
    ? [args.refImage]
    : [];
  const videos = args.refVideos && args.refVideos.length > 0
    ? args.refVideos
    : args.refVideo !== undefined
    ? [args.refVideo]
    : [];
  if (images.length === 0 && videos.length === 0) {
    throw new Error(
      `template '${args.template ?? DEFAULT_TEMPLATE}' needs a reference; pass ` +
        "`refImage`/`refImages` or `refVideo`/`refVideos` (a local path or a " +
        "server-side input filename)",
    );
  }
  const refs: ReferenceSpec[] = [];
  for (const img of images) {
    refs.push({ kind: "image", name: await resolveReferenceName(client, img) });
  }
  for (const vid of videos) {
    refs.push({ kind: "video", name: await resolveReferenceName(client, vid) });
  }
  return buildReferences(graph, tpl.references, refs);
}

/**
 * Swap the diffusion checkpoint the UNETLoader loads when `unetModel` is set
 * (e.g. an fl2va×ref2va hybrid). A no-op unless the template exposes a `model`
 * loader; throws if that node is missing from the graph.
 */
function applyModelOverride(
  graph: ApiGraph,
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
): ApiGraph {
  if (!args.unetModel || !tpl?.model) return graph;
  const clone = structuredClone(graph);
  const loader = clone[tpl.model.nodeId];
  if (loader === undefined) {
    throw new Error(
      `unetModel: model loader node '${tpl.model.nodeId}' not found in the graph`,
    );
  }
  loader.inputs = { ...loader.inputs, [tpl.model.key]: args.unetModel };
  return clone;
}

/**
 * When `keepRefAudio` is set, use the first reference video's original audio for
 * the output instead of the model-generated track: repoint the `CreateVideo`
 * node's audio input at that reference audio and delete the `VAEDecodeAudio`
 * node (the audio VAE *loader* stays — the reference-to-video node requires it).
 * A no-op unless the template declares `audio` wiring and the flag is set; throws
 * if there is no reference video to take audio from. Runs after `applyReferences`
 * so the video's `GetVideoComponents` node already exists. Note: the reference
 * audio spans the ref clip's length, which may differ from the output duration.
 */
function applyKeepRefAudio(
  graph: ApiGraph,
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
): ApiGraph {
  if (!args.keepRefAudio || !tpl?.audio || !tpl.references) return graph;
  const clone = structuredClone(graph);
  const refConsumer = clone[tpl.references.consumerNodeId];
  const audioSource = refConsumer?.inputs[`${tpl.references.videoAudioPrefix}0`];
  if (audioSource === undefined) {
    throw new Error(
      "keepRefAudio needs a reference video to take audio from; pass " +
        "`refVideo`/`refVideos` (or drop keepRefAudio)",
    );
  }
  const createVideo = clone[tpl.audio.createVideoNodeId];
  if (createVideo === undefined) {
    throw new Error(
      `keepRefAudio: CreateVideo node '${tpl.audio.createVideoNodeId}' not found`,
    );
  }
  createVideo.inputs = { ...createVideo.inputs, [tpl.audio.audioKey]: audioSource };
  delete clone[tpl.audio.decodeNodeId];
  return clone;
}

/**
 * When `upscale` is set, splice a SeedVR2 super-resolution stage between the
 * decoded frames and the video assembler: inject a DiT loader, a VAE loader, and
 * a `SeedVR2VideoUpscaler` (target short edge = `upscaleResolution`, DiT model
 * overridable via `upscaleModel`), then repoint the consumer at the upscaled
 * frames. A no-op unless the template declares `upscale`; throws if the SeedVR2
 * node isn't installed.
 */
function applyUpscale(
  graph: ApiGraph,
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
  installed?: Set<string>,
): ApiGraph {
  if (!args.upscale || !tpl?.upscale) return graph;
  const u = tpl.upscale;
  if (installed && !installed.has(u.upscalerClass)) {
    throw new Error(
      `upscale needs '${u.upscalerClass}' (SeedVR2) installed on the ComfyUI ` +
        "server; install the node or drop `upscale`",
    );
  }
  const clone = structuredClone(graph);
  const consumer = clone[u.consumer.nodeId];
  if (consumer === undefined) {
    throw new Error(`upscale consumer node '${u.consumer.nodeId}' not found`);
  }
  const ditId = "upscale_dit";
  const vaeId = "upscale_vae";
  const upId = "upscale_seedvr2";
  clone[ditId] = {
    class_type: u.ditClass,
    inputs: {
      ...u.ditDefaults,
      ...(args.upscaleModel ? { [u.ditModelKey]: args.upscaleModel } : {}),
    },
  };
  clone[vaeId] = { class_type: u.vaeClass, inputs: { ...u.vaeDefaults } };
  clone[upId] = {
    class_type: u.upscalerClass,
    inputs: {
      ...u.upscalerDefaults,
      [u.imageKey]: [u.imageSource.nodeId, u.imageSource.slot],
      [u.ditKey]: [ditId, 0],
      [u.vaeKey]: [vaeId, 0],
      [u.resolutionKey]: args.upscaleResolution ?? u.defaultResolution,
    },
  };
  consumer.inputs = { ...consumer.inputs, [u.consumer.key]: [upId, 0] };
  return clone;
}

/**
/**
 * Resolve the `turbo` sugar into effective args: when `turbo` is set, default
 * `speed` to the template's turbo preset and `steps` to its turbo step count
 * (explicit `speed`/`steps` still win). Throws if `turbo` is requested on a
 * template without a turbo preset.
 */
function resolveTurboArgs(
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
): GenArgs {
  if (!args.turbo) return args;
  if (!tpl?.turbo) {
    throw new Error(
      `template '${args.template ?? DEFAULT_TEMPLATE}' has no turbo preset`,
    );
  }
  return {
    ...args,
    speed: args.speed ?? tpl.turbo.speed,
    steps: args.steps ?? tpl.turbo.steps,
  };
}

/**
 * Splice the selected speed patchers onto the model chain. When `args.speed` is
 * omitted the template's `default` set is used; an explicit `speed: []` disables
 * them. Enabled patchers inject in the template's declared order (not the arg
 * order). `args.speedOptions[id]` overrides that patcher's default inputs. Throws
 * on an unknown id or an explicit `speed` on a template without speed wiring.
 */
function applySpeed(
  graph: ApiGraph,
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
  installed?: Set<string>,
): ApiGraph {
  // Omitted `speed` → template default; explicit `speed` (incl. []) wins.
  const selected = args.speed ?? tpl?.speed?.default ?? [];
  if (selected.length === 0) return graph;
  if (!tpl?.speed) {
    throw new Error(
      `template '${args.template ?? DEFAULT_TEMPLATE}' has no speed patchers; ` +
        "speed is only available on templates that declare them (e.g. 'minimax_h3')",
    );
  }
  const known = new Map(tpl.speed.patchers.map((p) => [p.id, p]));
  const wanted = new Set(selected);
  for (const id of wanted) {
    if (!known.has(id)) {
      throw new Error(
        `unknown speed patcher '${id}'. Known: ${[...known.keys()].join(", ")}`,
      );
    }
  }
  // Patchers to inject, in the template's declared (recommended) order.
  const selectedPatchers = tpl.speed.patchers.filter((p) => wanted.has(p.id));
  // Complain about patchers whose custom node isn't installed. When `speed` was
  // requested explicitly (or via `turbo`), a missing node is an error — the
  // caller asked for it. The DEFAULT stack instead degrades gracefully, skipping
  // whatever isn't installed so a churning node set doesn't break a plain render.
  const missing = installed
    ? selectedPatchers.filter((p) => !installed.has(p.classType))
    : [];
  const explicit = args.speed !== undefined;
  if (missing.length > 0 && explicit) {
    throw new Error(
      "speed patcher(s) not installed on the ComfyUI server: " +
        missing.map((p) => `${p.id} (${p.classType})`).join(", ") +
        " — install the node(s) or drop them from `speed`",
    );
  }
  const specs: ModelPatcherSpec[] = selectedPatchers
    .filter((p) => installed === undefined || installed.has(p.classType))
    .map((p) => ({
      classType: p.classType,
      modelKey: p.modelKey,
      modelOutSlot: p.modelOutSlot,
      inputs: { ...p.defaults, ...(args.speedOptions?.[p.id] ?? {}) },
    }));
  return chainModelPatchers(
    graph,
    tpl.speed.modelSource,
    tpl.speed.consumers,
    specs,
  );
}

/** The seed node id + input key to patch, resolved from args then template. */
function resolveSeedNode(
  args: GenArgs,
  tpl: WorkflowTemplate | undefined,
): { nodeId: string | undefined; key: string | undefined } {
  return {
    nodeId: args.seedNodeId ?? tpl?.seed.nodeId,
    key: args.seedInputKey ?? tpl?.seed.key,
  };
}

/** Download every output file (image or video) to `outputDir`, returning paths. */
async function saveFiles(
  client: ComfyClient,
  files: FileRef[],
  outputDir: string,
): Promise<string[]> {
  await Deno.mkdir(outputDir, { recursive: true });
  const paths: string[] = [];
  for (const file of files) {
    const bytes = await client.fetchImage(file);
    const dir = file.subfolder ? `${outputDir}/${file.subfolder}` : outputDir;
    if (file.subfolder) await Deno.mkdir(dir, { recursive: true });
    const path = `${dir}/${file.filename}`;
    await Deno.writeFile(path, bytes);
    paths.push(path);
  }
  return paths;
}

/**
 * Build the graph for one clip from `args` (content/refs/audio/speed/upscale/
 * seed), queue it, wait, and save the output. Shared by `generate` and each
 * fragment of `generate_long`. Returns the applied seed + saved file paths.
 */
async function renderClip(
  args: GenArgs,
  context: Context,
  client: ComfyClient,
  installed: Set<string> | undefined,
): Promise<
  { promptId: string; images: FileRef[]; paths: string[]; seed: number | null }
> {
  const { globalArgs } = context;
  const { graph, tpl } = await loadGraphAndTemplate(args, context);
  const eArgs = resolveTurboArgs(args, tpl);
  let base = applyContentOverrides(graph, eArgs, tpl);
  base = applyModelOverride(base, eArgs, tpl);
  base = applyVideoOverrides(base, eArgs, tpl);
  base = await applyReferences(base, eArgs, tpl, client);
  base = applyKeepRefAudio(base, eArgs, tpl);
  base = applySpeed(base, eArgs, tpl, installed);
  base = applyUpscale(base, eArgs, tpl, installed);

  const { nodeId: seedNodeId, key: seedInputKey } = resolveSeedNode(args, tpl);
  const seed = args.seed ??
    (seedNodeId !== undefined ? randomSeed() : undefined);
  const appliedSeed = seed !== undefined && seedNodeId !== undefined
    ? seed
    : undefined;
  const patched = appliedSeed !== undefined
    ? applyIdeogramOverrides(base, { seed: appliedSeed, seedNodeId, seedInputKey })
    : base;

  const promptId = await client.queuePrompt(patched);
  const entry = await client.waitForResult(promptId, {
    pollIntervalMs: globalArgs.pollIntervalMs,
    timeoutMs: globalArgs.timeoutMs,
  });
  const images = client.collectFiles(entry);
  const paths = await saveFiles(client, images, globalArgs.outputDir);
  return { promptId, images, paths, seed: appliedSeed ?? null };
}

/** Run ffmpeg with the given args (a `-y` is prepended); throws on failure. */
async function runFfmpeg(args: string[]): Promise<void> {
  const cmd = new Deno.Command("ffmpeg", {
    args: ["-y", ...args],
    stdout: "null",
    stderr: "piped",
  });
  const { success, stderr } = await cmd.output();
  if (!success) {
    throw new Error(
      "ffmpeg failed: " + new TextDecoder().decode(stderr).slice(-500),
    );
  }
}

/** Cut `[start, start+dur]` from `src` (accurate seek, re-encoded) to `dst`. */
function ffmpegSlice(
  src: string,
  start: number,
  dur: number,
  dst: string,
): Promise<void> {
  return runFfmpeg([
    "-i", src, "-ss", String(start), "-t", String(dur),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16",
    "-c:a", "aac", "-movflags", "+faststart", dst,
  ]);
}

/** Write the last frame of `src` to `dst` (a PNG). */
function ffmpegLastFrame(src: string, dst: string): Promise<void> {
  return runFfmpeg([
    "-sseof", "-0.15", "-i", src, "-update", "1", "-frames:v", "1", dst,
  ]);
}

/** Write the FIRST frame of `src` to `dst` (a PNG). */
function ffmpegFirstFrame(src: string, dst: string): Promise<void> {
  return runFfmpeg(["-i", src, "-frames:v", "1", "-update", "1", dst]);
}

/**
 * Write the last `seconds` of `src` to `dst` as a short SILENT mp4 — the motion
 * anchor for continuation (multiple frames, so H3 sees velocity + camera path at
 * the cut, not a frozen still). Audio is dropped (`-an`); it never becomes the
 * output soundtrack (keepRefAudio takes the source-motion clip's audio instead).
 */
function ffmpegTail(src: string, seconds: number, dst: string): Promise<void> {
  return runFfmpeg([
    "-sseof", String(-Math.abs(seconds)), "-i", src,
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16",
    "-movflags", "+faststart", dst,
  ]);
}

/**
 * Return `path` if free, else the first non-existing `name_N.ext` sibling
 * (`_2`, `_3`, …) — so repeated runs auto-increment instead of overwriting.
 */
export async function nextFreePath(path: string): Promise<string> {
  const exists = (p: string) =>
    Deno.stat(p).then(() => true).catch(() => false);
  const m = path.match(/^(.*?)(\.[^.\/\\]+)$/);
  const stem = m ? m[1] : path;
  const ext = m ? m[2] : "";
  let candidate = path;
  for (let i = 2; await exists(candidate); i++) candidate = `${stem}_${i}${ext}`;
  return candidate;
}

/** Concatenate `parts` (re-encoded, uniform) into `dst` via the concat demuxer. */
async function ffmpegConcat(parts: string[], dst: string): Promise<void> {
  const list = `${await Deno.makeTempDir()}/concat.txt`;
  await Deno.writeTextFile(
    list,
    parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
  );
  await runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", list,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16",
    "-c:a", "aac", "-movflags", "+faststart", dst,
  ]);
}

/** Split a total duration into ordered fragment windows of at most `frag` s. */
export function planFragments(
  total: number,
  frag: number,
): { index: number; start: number; duration: number }[] {
  const out = [];
  for (let start = 0, i = 0; start < total - 1e-6; start += frag, i++) {
    out.push({ index: i, start, duration: Math.min(frag, total - start) });
  }
  return out;
}

/**
 * Per-frame motion magnitude of `src`: the mean luma of the frame-to-frame
 * DIFFERENCE (tblend difference → signalstats YAVG), so high = fast movement,
 * low = a held/near-still pose. Downscaled to 64px wide for speed. Best-effort:
 * returns `[]` if ffmpeg fails, so callers fall back to uniform fragments.
 */
async function ffmpegMotionProfile(
  src: string,
): Promise<{ t: number; m: number }[]> {
  const cmd = new Deno.Command("ffmpeg", {
    args: [
      "-y", "-i", src,
      "-vf",
      "format=gray,scale=64:-2,tblend=all_mode=difference," +
      "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
      "-f", "null", "-",
    ],
    stdout: "piped",
    stderr: "null",
  });
  const { success, stdout } = await cmd.output();
  if (!success) return [];
  return parseMotionProfile(new TextDecoder().decode(stdout));
}

/** Parse ffmpeg `metadata=print` output into `{t, m}` motion samples. */
export function parseMotionProfile(text: string): { t: number; m: number }[] {
  const out: { t: number; m: number }[] = [];
  let t: number | undefined;
  for (const line of text.split("\n")) {
    const pt = line.match(/pts_time:([-\d.]+)/);
    if (pt) {
      t = Number(pt[1]);
      continue;
    }
    const y = line.match(/YAVG=([-\d.]+)/);
    if (y && t !== undefined) out.push({ t, m: Number(y[1]) });
  }
  return out;
}

/**
 * Like `planFragments`, but SNAP each interior fragment boundary to the
 * lowest-motion frame within `window` seconds of its nominal position, so cuts
 * land on held/near-still poses instead of mid-jump or mid-turn (where the
 * subject's facing is ambiguous and continuation "forgets" head orientation).
 * `minSeg` keeps every fragment at least that long. Falls back to uniform
 * windows for any boundary with no motion samples in range.
 */
export function alignSeams(
  total: number,
  frag: number,
  motion: { t: number; m: number }[],
  window = 1.0,
  minSeg = 1.5,
): { index: number; start: number; duration: number }[] {
  const boundaries = [0];
  for (let b = frag; b < total - 1e-6; b += frag) {
    const prev = boundaries[boundaries.length - 1];
    const lo = Math.max(prev + minSeg, b - window);
    const hi = Math.min(total - minSeg, b + window);
    let best = b;
    let bestM = Infinity;
    for (const s of motion) {
      if (s.t < lo || s.t > hi) continue;
      if (s.m < bestM) {
        bestM = s.m;
        best = s.t;
      }
    }
    best = Math.min(Math.max(best, lo), hi);
    if (best > prev + 1e-6 && best < total - 1e-6) boundaries.push(best);
  }
  boundaries.push(total);
  const out = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    out.push({
      index: i,
      start: boundaries[i],
      duration: boundaries[i + 1] - boundaries[i],
    });
  }
  return out;
}

/**
 * Append a continuation instruction to a caption, telling H3 that the given
 * `<Picture N>` is the last frame of the previous clip to continue from.
 */
export function continuationCaption(caption: string, pictureIndex: number): string {
  return `${caption.trimEnd()}\n\ncontinuation:\n<Picture ${pictureIndex}> is ` +
    `the exact last frame of the immediately preceding clip; begin this clip ` +
    `from it and continue the same motion, camera, and pacing seamlessly, ` +
    `keeping <Subject 1>'s identity and clothing from <Picture 1>.`;
}

/**
 * Append a continuation instruction telling H3 that the given `<Video N>` is the
 * TAIL (last ~0.5s) of the immediately preceding clip. Unlike a single still,
 * this carries the subject's velocity and the camera trajectory, so the model
 * continues the motion and holds the camera steady across the cut instead of
 * hard-cutting. `<Subject 1>`'s identity still comes from `<Picture 1>`.
 */
export function continuationCaptionTail(
  caption: string,
  videoIndex: number,
): string {
  return `${caption.trimEnd()}\n\ncontinuation:\n<Video ${videoIndex}> is the ` +
    `final ~0.5 seconds of the immediately preceding clip. Begin this clip on ` +
    `the exact frame <Video ${videoIndex}> ends, matching <Subject 1>'s pose, ` +
    `body position, and — critically — the exact direction her head, face, and ` +
    `gaze are facing at that instant, plus the camera framing and angle. Then ` +
    `continue the same body motion, head and face orientation, camera ` +
    `trajectory, and pacing without any cut, jump, or camera reset. <Picture 1> ` +
    `supplies ONLY <Subject 1>'s identity, face, and clothing — NOT her pose or ` +
    `which way she is facing; her facing and orientation come from ` +
    `<Video ${videoIndex}> and the choreography and camera from <Video 1>.`;
}

/**
 * Default H3-format prompt for `ref2i` clothes/style transfer: `<Picture 1>` is
 * the garment/style source, `<Picture 2>` the target person. Binds the outfit
 * from #1 onto the person in #2 while preserving their face, pose, and
 * background. Used when the caller doesn't pass an explicit `caption`.
 */
export function clothesTransferCaption(): string {
  return [
    "subject_definitions:",
    "<Subject 1> is the person from <Picture 2>, wearing the clothing, outfit, " +
    "and styling from <Picture 1>.",
    "",
    "summary:",
    "[reference generation] A single still image of <Subject 1> — the exact " +
    "person in <Picture 2> — re-dressed in the garments and style from " +
    "<Picture 1>, keeping that person's own face, hair, body, pose, framing, " +
    "and background unchanged.",
    "",
    "retention_analysis:",
    "<Picture 2> (person source, [Shot 1]): fully_preserved - the person's face, " +
    "hair, body, skin tone, pose, camera framing, and background are kept.",
    "<Picture 1> (clothing/style source): attribute_transfer - ONLY the clothing, " +
    "outfit, garments, fabric, colours, and styling transfer onto <Subject 1>; " +
    "the person, face, body, and background of <Picture 1> are NOT carried over.",
    "",
    "detailed_description:",
    "[Shot 1] A clean, well-lit still of <Subject 1>, the person from " +
    "<Picture 2>, now wearing the outfit from <Picture 1>. Same face, hairstyle, " +
    "body, pose, framing, and background as <Picture 2>; only the clothing is " +
    "replaced with the garments from <Picture 1>, fitted naturally to the body " +
    "with consistent lighting and realistic fabric.",
    "",
    "overall_soundscape:",
    "N/A",
    "",
    "non_diegetic_music:",
    "N/A",
  ].join("\n");
}

async function snapshotServer(
  context: Context,
): Promise<{ dataHandles: never[] }> {
  const { globalArgs } = context;
  const res = await fetch(`${globalArgs.baseUrl}/system_stats`);
  if (!res.ok) {
    throw new Error(
      `ComfyUI /system_stats failed: ${res.status} ${res.statusText}`,
    );
  }
  const json = await res.json() as {
    system?: { comfyui_version?: string };
    devices?: unknown;
  };
  await context.writeResource("server", "server", {
    comfyuiVersion: json?.system?.comfyui_version,
    system: json?.system,
    devices: json?.devices,
  });
  return { dataHandles: [] };
}

/**
 * The `@magistr/comfyui/instance` model — connect to a ComfyUI server and
 * drive the Ideogram 4.0 text-to-image workflow: `lookup`/`sync`,
 * `build_caption`, `generate_caption` (Claude), and `generate`.
 */
export const model = {
  type: "@magistr/comfyui/instance" as const,
  version: "2026.08.12.12",
  upgrades: [
    {
      fromVersion: "2026.07.21.1",
      toVersion: "2026.08.02.1",
      description:
        "Real-fix 4 latent bugs (unapplied-seed record, errored-render silent success, snapshotServer res.ok, saveImages subfolder collision); no globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.02.1",
      toVersion: "2026.08.12.1",
      description:
        "Add 'minimax_h3' reference-to-video template: image AND video references (refImage(s)/refVideo(s), videos via LoadVideo→GetVideoComponents), duration/steps, opt-in speed patcher chain (ModelAttentionBackend/sage/sol-attn/chunk-FF/spectrum via `speed`/`speedOptions`), generic video-output collection (collectFiles) + local ref upload; no globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.1",
      toVersion: "2026.08.12.2",
      description:
        "minimax_h3: enable the full speed patcher stack BY DEFAULT (live ~43% faster); `speed: []` disables, an explicit `speed` still overrides. No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.2",
      toVersion: "2026.08.12.3",
      description:
        "minimax_h3: add `keepRefAudio` — use the first reference video's original audio for the output (repoints CreateVideo audio, drops the VAEDecodeAudio node; audio VAE loader stays, required by the ref2v node). No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.3",
      toVersion: "2026.08.12.4",
      description:
        "minimax_h3: add `turbo` — 4-step distillation-LoRA fast path (turboLora + firstBlockCache + sage/sol + MiniMaxH3SigmaShift at 8 steps). New speed patchers turboLora/firstBlockCache/sigmaShift. Needs the turbo LoRA installed on the server. No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.4",
      toVersion: "2026.08.12.5",
      description:
        "minimax_h3: speed injection checks installed nodes (/object_info) — an explicit `speed`/`turbo` patcher whose node is missing now errors clearly (install it or drop it); the DEFAULT stack skips missing nodes gracefully. Turbo preset trimmed to installed nodes (sol-attn removed upstream). No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.5",
      toVersion: "2026.08.12.6",
      description:
        "minimax_h3: add `upscale` — SeedVR2 video super-resolution (SeedVR2LoadDiTModel + SeedVR2LoadVAEModel + SeedVR2VideoUpscaler) spliced between the decoded frames and CreateVideo; `upscaleResolution` (default 1080), `upscaleModel` override. Errors if the SeedVR2 node isn't installed. No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.6",
      toVersion: "2026.08.12.7",
      description:
        "minimax_h3: expose `megapixels` (ResolutionSelector output size, e.g. 0.8) as an arg alongside `resolution`. No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.7",
      toVersion: "2026.08.12.8",
      description:
        "Add `generate_long` — long video by CONTINUATION: slices the full refVideo into `fragmentDuration`(5s) windows, renders each fragment carrying the previous fragment's last frame as a ref image (Strategy A: motion-faithful), ffmpeg-stitches to `totalDuration`. New `long` resource. Refactored shared per-clip renderer. No globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.8",
      toVersion: "2026.08.12.9",
      description:
        "generate_long: continuation now carries the previous fragment's TAIL as a moving reference VIDEO (<Video 2>, `continuationSeconds` default 0.5 ≈ 10-12 frames) instead of a single frozen still — H3 sees the subject's velocity and the camera trajectory at the cut, killing the jump-cut/hitch at each seam and holding the camera steady. `continuationSeconds: 0` restores the single-still fallback. No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.9",
      toVersion: "2026.08.12.10",
      description:
        "generate_long: SEAM-ALIGN fragment boundaries (`seamAlign` default on, `seamWindow` 1s) — profile the source motion video (tblend-difference → signalstats YAVG per frame) and snap each cut to the lowest-motion frame near its nominal position, so cuts land on held poses instead of mid-jump/turn where facing is ambiguous (fixed the next fragment 'forgetting' head/face orientation). Also bind facing/gaze/head-orientation to <Video 2> in the continuation caption and demote <Picture 1> to appearance-only. No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.10",
      toVersion: "2026.08.12.11",
      description:
        "generate_long: AUTO-INCREMENT the stitched output filename (nextFreePath) — a new run writes minimax_h3_long_NxMs_2.mp4, _3.mp4, … instead of overwriting the previous stitched video. No globalArguments or resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.12.11",
      toVersion: "2026.08.12.12",
      description:
        "Add `ref2i` — style/clothes transfer to a STILL: drives the H3 reference graph with styleImage (<Picture 1>) + targetImage (<Picture 2>), generates the shortest clip and saves frame 0 as a PNG (new `ref2i` resource, auto-incremented). Default clothes-transfer caption. Also add `unetModel` arg + template `model` loader (UNETLoader node 127) to swap the diffusion checkpoint (e.g. an fl2va×ref2va hybrid) on generate/generate_long/ref2i via applyModelOverride. No globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgs,
  resources: {
    server: {
      description: "ComfyUI server snapshot (system_stats).",
      schema: ServerResource,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    caption: {
      description: "A validated Ideogram-4 structured JSON caption.",
      schema: CaptionResource,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    node_info: {
      description: "A node class's input spec from /object_info.",
      schema: NodeInfoResource,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    generation: {
      description: "A completed render: prompt id, image refs, saved paths.",
      schema: GenerationResource,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    batch: {
      description: "A batch of renders sharing a prompt, one per seed.",
      schema: BatchResource,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    long: {
      description:
        "A long video assembled by continuation: fragment paths + the stitched result.",
      schema: LongResource,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    ref2i: {
      description:
        "A style/clothes-transfer still: the saved first frame's path + seed.",
      schema: Ref2iResource,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    lookup: {
      description:
        "Snapshot the ComfyUI server (system_stats) as a `server` resource.",
      arguments: NoArgs,
      execute: (_args: z.infer<typeof NoArgs>, context: Context) =>
        snapshotServer(context),
    },
    sync: {
      description: "Refresh the ComfyUI server snapshot (identical to lookup).",
      arguments: NoArgs,
      execute: (_args: z.infer<typeof NoArgs>, context: Context) =>
        snapshotServer(context),
    },
    node_info: {
      description:
        "Fetch a node class's input spec from /object_info (e.g. the valid " +
        "combo values for ResolutionSelector's aspect_ratio), stored as a " +
        "`node_info` resource.",
      arguments: NodeInfoArgs,
      execute: async (
        args: z.infer<typeof NodeInfoArgs>,
        context: Context,
      ) => {
        const { globalArgs } = context;
        const client = new ComfyClient({
          baseUrl: globalArgs.baseUrl,
          clientId: globalArgs.clientId,
        });
        const info = await client.fetchObjectInfo(args.classType);
        await context.writeResource("node_info", args.classType, {
          classType: args.classType,
          info,
        });
        return { dataHandles: [] };
      },
    },
    build_caption: {
      description:
        "Build and serialize an Ideogram caption, stored as a `caption` resource.",
      arguments: BuildCaptionArgs,
      execute: async (
        args: z.infer<typeof BuildCaptionArgs>,
        context: Context,
      ) => {
        const caption = buildCaption(args);
        await context.writeResource("caption", "caption", {
          caption,
          text: serializeCaption(caption),
        });
        return { dataHandles: [] };
      },
    },
    generate_caption: {
      description:
        "Turn a natural-language idea into a validated Ideogram-4 JSON caption via Claude " +
        "(Anthropic Messages API), stored as a `caption` resource.",
      arguments: GenerateCaptionArgs,
      execute: async (
        args: z.infer<typeof GenerateCaptionArgs>,
        context: Context,
      ) => {
        const { globalArgs } = context;
        if (!globalArgs.anthropicApiKey) {
          throw new Error(
            "generate_caption requires globalArgs.anthropicApiKey",
          );
        }
        const { system, user } = buildCaptionMessages(
          args.idea,
          args.aspectRatio,
        );
        const raw = await claudeComplete(user, {
          apiKey: globalArgs.anthropicApiKey,
          model: globalArgs.captionModel,
          maxTokens: globalArgs.captionMaxTokens,
          system,
        });
        const caption = parseGeneratedCaption(raw);
        await context.writeResource("caption", "caption", {
          caption,
          text: JSON.stringify(caption),
        });
        return { dataHandles: [] };
      },
    },
    generate: {
      description:
        "Patch a workflow, queue it, fetch the output (image or video), and " +
        "record a `generation` resource. Pick a bundled `template` ('ideogram' " +
        "default, 'krea', or 'minimax_h3' reference-to-video) — its caption/seed/" +
        "resolution node ids are applied automatically — or override with an " +
        "inline `workflow`/globalArgs.workflowPath and explicit `*NodeId`/" +
        "`*InputKey` args. For 'minimax_h3', pass the prompt as `caption` and a " +
        "reference via `refImage`/`refImages` and/or `refVideo`/`refVideos` (each " +
        "a local path or a server-side input filename; videos are wired through " +
        "LoadVideo→GetVideoComponents); optional `duration` (seconds) and `steps`. " +
        "The full speed patcher stack (attentionBackend, sage, solAttention, " +
        "chunkFeedForward, spectrum, fusedModulation) runs BY DEFAULT (~43% " +
        "faster); pass `speed: []` to disable, an explicit `speed` list to pick a " +
        "subset, or `speedOptions` to override a patcher's inputs. `turbo: true` " +
        "is the 4-step distillation-LoRA fast path (needs the turbo LoRA on the " +
        "server). `keepRefAudio` uses the first reference video's original audio " +
        "instead of the model-generated track. `upscale: true` adds a SeedVR2 " +
        "super-resolution pass (`upscaleResolution`, default 1080).",
      arguments: GenerateArgs,
      execute: async (args: z.infer<typeof GenerateArgs>, context: Context) => {
        const { globalArgs } = context;
        const client = new ComfyClient({
          baseUrl: globalArgs.baseUrl,
          clientId: globalArgs.clientId,
        });
        const { tpl } = await loadGraphAndTemplate(args, context);
        const installed = (tpl?.speed || (args.upscale && tpl?.upscale))
          ? await client.fetchInstalledClasses()
          : undefined;
        const { promptId, images, paths, seed } = await renderClip(
          args,
          context,
          client,
          installed,
        );
        await context.writeResource("generation", "generation", {
          promptId,
          images,
          paths,
          seed,
        });
        return { dataHandles: [] };
      },
    },
    generate_batch: {
      description:
        "Queue a batch of images that share one prompt/LoRA/resolution but vary " +
        "by seed. Give explicit `seeds` or a `count` (random seeds; default 4). " +
        "All prompts are queued up front so ComfyUI pipelines them; every image " +
        "is fetched and recorded in a `batch` resource. Needs a seed node (a " +
        "`template` or `seedNodeId`).",
      arguments: GenerateBatchArgs,
      execute: async (
        args: z.infer<typeof GenerateBatchArgs>,
        context: Context,
      ) => {
        const { globalArgs } = context;
        const { graph, tpl } = await loadGraphAndTemplate(args, context);
        const client = new ComfyClient({
          baseUrl: globalArgs.baseUrl,
          clientId: globalArgs.clientId,
        });
        const eArgs = resolveTurboArgs(args, tpl);
        let base = applyContentOverrides(graph, eArgs, tpl);
        base = applyVideoOverrides(base, eArgs, tpl);
        base = await applyReferences(base, eArgs, tpl, client);
        base = applyKeepRefAudio(base, eArgs, tpl);
        const installed = (tpl?.speed || (eArgs.upscale && tpl?.upscale))
          ? await client.fetchInstalledClasses()
          : undefined;
        base = applySpeed(base, eArgs, tpl, installed);
        base = applyUpscale(base, eArgs, tpl, installed);

        const { nodeId: seedNodeId, key: seedInputKey } = resolveSeedNode(
          args,
          tpl,
        );
        if (seedNodeId === undefined) {
          throw new Error(
            "generate_batch needs a seed node to vary images; pick a " +
              "`template` or pass `seedNodeId`",
          );
        }
        const seeds = args.seeds ??
          Array.from({ length: args.count ?? 4 }, () => randomSeed());

        // Queue every prompt up front so ComfyUI keeps its pipeline full.
        const queued: { seed: number; promptId: string }[] = [];
        for (const s of seeds) {
          const patched = applyIdeogramOverrides(base, {
            seed: s,
            seedNodeId,
            seedInputKey,
          });
          const promptId = await client.queuePrompt(patched);
          queued.push({ seed: s, promptId });
        }

        // Then poll + fetch each in submission order.
        const items: { seed: number; promptId: string; paths: string[] }[] = [];
        const allPaths: string[] = [];
        for (const q of queued) {
          const entry = await client.waitForResult(q.promptId, {
            pollIntervalMs: globalArgs.pollIntervalMs,
            timeoutMs: globalArgs.timeoutMs,
          });
          const paths = await saveFiles(
            client,
            client.collectFiles(entry),
            globalArgs.outputDir,
          );
          items.push({ seed: q.seed, promptId: q.promptId, paths });
          allPaths.push(...paths);
        }

        await context.writeResource("batch", "batch", {
          count: seeds.length,
          seeds,
          items,
          paths: allPaths,
        });
        return { dataHandles: [] };
      },
    },
    generate_long: {
      description:
        "Build a long video (`totalDuration` s) from `fragmentDuration`-second " +
        "clips (default 5) by CONTINUATION: fragment 1 renders normally; each " +
        "later fragment carries the previous fragment's TAIL (`continuationSeconds` " +
        "≈0.5s of moving frames) forward as an extra reference video `<Video 2>` " +
        "and continues its motion + camera, then all fragments are stitched with " +
        "ffmpeg. A moving tail (vs a single still) gives H3 the subject velocity " +
        "and camera trajectory at the cut, removing the jump-cut at each seam; " +
        "`continuationSeconds: 0` falls back to a single last-frame still. Fragment " +
        "boundaries are SEAM-ALIGNED (`seamAlign`, default on): each cut snaps to " +
        "the lowest-motion frame within `seamWindow`(1s) of its nominal position — " +
        "profiled from the source motion video — so cuts land on held poses, not " +
        "mid-jump/turn where facing is ambiguous and the next fragment forgets head " +
        "orientation. The `refVideo` is the FULL motion reference and is sliced per " +
        "fragment. All `generate` options (turbo, keepRefAudio, resolution, " +
        "megapixels, upscale, speed) apply per fragment. minimax_h3 only.",
      arguments: GenerateLongArgs,
      execute: async (
        args: z.infer<typeof GenerateLongArgs>,
        context: Context,
      ) => {
        const { globalArgs } = context;
        const client = new ComfyClient({
          baseUrl: globalArgs.baseUrl,
          clientId: globalArgs.clientId,
        });
        const installed = await client.fetchInstalledClasses();

        const frag = args.fragmentDuration ?? 5;

        // Resolve the character reference image(s) once to server-side names so
        // they aren't re-uploaded every fragment.
        const charInputs = args.refImages && args.refImages.length > 0
          ? args.refImages
          : args.refImage !== undefined
          ? [args.refImage]
          : [];
        const charNames: string[] = [];
        for (const c of charInputs) {
          charNames.push(await resolveReferenceName(client, c));
        }
        // The full motion reference to slice per fragment (a local file).
        const motionRef = (args.refVideos && args.refVideos.length > 0)
          ? args.refVideos[0]
          : args.refVideo;

        // Fragment plan: snap boundaries to low-motion frames of the source
        // motion video (avoid cutting mid-jump/turn) when possible, else uniform.
        let plan = planFragments(args.totalDuration, frag);
        const motionLocal = motionRef !== undefined &&
          await Deno.stat(motionRef).then((s) => s.isFile).catch(() => false);
        if (args.seamAlign && motionLocal) {
          const profile = await ffmpegMotionProfile(motionRef!);
          if (profile.length > 0) {
            plan = alignSeams(args.totalDuration, frag, profile, args.seamWindow);
          }
        }

        const contSecs = args.continuationSeconds ?? 0.5;
        const tmpDir = await Deno.makeTempDir();
        const fragmentPaths: string[] = [];
        // Continuation anchor from the previous fragment: a moving TAIL clip
        // (contSecs > 0) or, when disabled, a single last-frame still.
        let tailClip: string | undefined;
        let lastFrameName: string | undefined;

        for (const f of plan) {
          const segRefVideos: string[] = [];
          if (motionRef) {
            const seg = `${tmpDir}/seg_${f.index}.mp4`;
            await ffmpegSlice(motionRef, f.start, f.duration, seg);
            segRefVideos.push(seg);
          }
          // Later fragments continue from the previous one. Prefer the tail clip
          // (motion + camera continuity); otherwise the single still fallback.
          const refImages = [...charNames];
          let caption = args.caption;
          if (f.index > 0) {
            if (tailClip !== undefined) {
              segRefVideos.push(tailClip); // → <Video 2> (after the motion <Video 1>)
              caption = continuationCaptionTail(
                args.caption ?? "",
                segRefVideos.length,
              );
            } else if (lastFrameName !== undefined) {
              refImages.push(lastFrameName);
              caption = continuationCaption(args.caption ?? "", refImages.length);
            }
          }

          const clipArgs = {
            ...args,
            caption,
            duration: f.duration,
            refImage: undefined,
            refImages,
            refVideo: undefined,
            refVideos: segRefVideos.length > 0 ? segRefVideos : undefined,
            totalDuration: undefined,
            fragmentDuration: undefined,
            continuationSeconds: undefined,
            seamAlign: undefined,
            seamWindow: undefined,
          } as unknown as GenArgs;

          const { paths } = await renderClip(clipArgs, context, client, installed);
          const mp4 = paths.find((p) => p.toLowerCase().endsWith(".mp4")) ??
            paths[0];
          if (mp4 === undefined) {
            throw new Error(`fragment ${f.index} produced no output file`);
          }
          fragmentPaths.push(mp4);

          // Carry this fragment forward as the next one's continuation anchor.
          if (contSecs > 0) {
            const tail = `${tmpDir}/tail_${f.index}.mp4`;
            await ffmpegTail(mp4, Math.min(contSecs, f.duration - 0.05), tail);
            tailClip = tail; // a local path; renderClip uploads it per fragment
          } else {
            const lfPng = `${tmpDir}/last_${f.index}.png`;
            await ffmpegLastFrame(mp4, lfPng);
            const up = await client.uploadImage(
              await Deno.readFile(lfPng),
              `h3long_last_${f.index}.png`,
              { overwrite: true },
            );
            lastFrameName = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
          }
        }

        await Deno.mkdir(`${globalArgs.outputDir}/video`, { recursive: true });
        // Auto-increment so a new run never overwrites a previous stitched video.
        const finalPath = await nextFreePath(
          `${globalArgs.outputDir}/video/minimax_h3_long_${plan.length}x${frag}s.mp4`,
        );
        await ffmpegConcat(fragmentPaths, finalPath);

        await context.writeResource("long", "long", {
          count: plan.length,
          fragments: fragmentPaths,
          paths: [finalPath],
        });
        return { dataHandles: [] };
      },
    },
    ref2i: {
      description:
        "Style/clothes transfer to a STILL image (minimax_h3): drive the H3 " +
        "reference graph with two image refs — `styleImage` (the garment/style " +
        "source → <Picture 1>) and `targetImage` (the person to re-dress → " +
        "<Picture 2>) — generate the shortest clip, and save its FIRST frame as a " +
        "PNG. The person's face/pose/background are kept; only the outfit is " +
        "replaced. A default clothes-transfer prompt is used unless `caption` is " +
        "given. Point `unetModel` at an fl2va×ref2va hybrid for stronger transfer. " +
        "`duration` (default 1s) trades speed for the model's minimum clip length.",
      arguments: Ref2iArgs,
      execute: async (
        args: z.infer<typeof Ref2iArgs>,
        context: Context,
      ) => {
        const { globalArgs } = context;
        const client = new ComfyClient({
          baseUrl: globalArgs.baseUrl,
          clientId: globalArgs.clientId,
        });
        const installed = await client.fetchInstalledClasses();

        // style → <Picture 1>, target → <Picture 2> (buildReferences keeps order).
        const clipArgs = {
          ...args,
          template: args.template ?? "minimax_h3",
          caption: args.caption ?? clothesTransferCaption(),
          duration: args.duration ?? 1,
          keepRefAudio: false,
          upscale: false,
          refImage: undefined,
          refImages: [args.styleImage, args.targetImage],
          refVideo: undefined,
          refVideos: undefined,
        } as unknown as GenArgs;

        const { promptId, paths, seed } = await renderClip(
          clipArgs,
          context,
          client,
          installed,
        );
        const mp4 = paths.find((p) => p.toLowerCase().endsWith(".mp4")) ??
          paths[0];
        if (mp4 === undefined) throw new Error("ref2i produced no output file");

        await Deno.mkdir(`${globalArgs.outputDir}/image`, { recursive: true });
        const outPng = await nextFreePath(
          `${globalArgs.outputDir}/image/ref2i_styled.png`,
        );
        await ffmpegFirstFrame(mp4, outPng);

        await context.writeResource("ref2i", "ref2i", {
          promptId,
          paths: [outPng],
          seed,
        });
        return { dataHandles: [] };
      },
    },
  },
};
