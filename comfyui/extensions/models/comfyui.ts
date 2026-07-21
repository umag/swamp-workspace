import { z } from "npm:zod@4";
import { ComfyClient, type ImageRef } from "./lib/comfy_client.ts";
import {
  buildCaption,
  parseGeneratedCaption,
  serializeCaption,
} from "./lib/caption.ts";
import {
  type ApiGraph,
  applyIdeogramOverrides,
  chainLoras,
  type LoraSpec,
  patchWorkflow,
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

/** Download every image to `outputDir`, returning the saved paths. */
async function saveImages(
  client: ComfyClient,
  images: ImageRef[],
  outputDir: string,
): Promise<string[]> {
  await Deno.mkdir(outputDir, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const bytes = await client.fetchImage(img);
    const path = `${outputDir}/${img.filename}`;
    await Deno.writeFile(path, bytes);
    paths.push(path);
  }
  return paths;
}

async function snapshotServer(
  context: Context,
): Promise<{ dataHandles: never[] }> {
  const { globalArgs } = context;
  const res = await fetch(`${globalArgs.baseUrl}/system_stats`);
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
  version: "2026.07.21.1",
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
        "Patch a workflow, queue it, fetch images, and record a `generation` " +
        "resource. Pick a bundled `template` ('ideogram' default, or 'krea') — " +
        "its caption/seed/resolution node ids are applied automatically — or " +
        "override with an inline `workflow`/globalArgs.workflowPath and explicit " +
        "`*NodeId`/`*InputKey` args.",
      arguments: GenerateArgs,
      execute: async (args: z.infer<typeof GenerateArgs>, context: Context) => {
        const { globalArgs } = context;
        const { graph, tpl } = await loadGraphAndTemplate(args, context);
        const base = applyContentOverrides(graph, args, tpl);

        const { nodeId: seedNodeId, key: seedInputKey } = resolveSeedNode(
          args,
          tpl,
        );
        // Auto-pick a random seed when omitted — but only when we know which
        // node to set it on (a template is active or seedNodeId was given).
        // Otherwise a seedless run would reuse the graph's baked constant.
        const seed = args.seed ??
          (seedNodeId !== undefined ? randomSeed() : undefined);
        const patched = seed !== undefined && seedNodeId !== undefined
          ? applyIdeogramOverrides(base, { seed, seedNodeId, seedInputKey })
          : base;

        const client = new ComfyClient({
          baseUrl: globalArgs.baseUrl,
          clientId: globalArgs.clientId,
        });
        const promptId = await client.queuePrompt(patched);
        const entry = await client.waitForResult(promptId, {
          pollIntervalMs: globalArgs.pollIntervalMs,
          timeoutMs: globalArgs.timeoutMs,
        });
        const images = client.collectImages(entry);
        const paths = await saveImages(client, images, globalArgs.outputDir);

        await context.writeResource("generation", "generation", {
          promptId,
          images,
          paths,
          seed: seed ?? null,
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
        const base = applyContentOverrides(graph, args, tpl);

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

        const client = new ComfyClient({
          baseUrl: globalArgs.baseUrl,
          clientId: globalArgs.clientId,
        });

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
          const paths = await saveImages(
            client,
            client.collectImages(entry),
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
  },
};
