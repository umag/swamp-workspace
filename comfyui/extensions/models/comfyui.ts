import { z } from "npm:zod@4";
import { ComfyClient } from "./lib/comfy_client.ts";
import {
  buildCaption,
  parseGeneratedCaption,
  serializeCaption,
} from "./lib/caption.ts";
import { type ApiGraph, applyIdeogramOverrides } from "./lib/workflow_patch.ts";
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
}

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
  seed: z.number().optional(),
  seedNodeId: z.string().optional(),
  resolution: z.string().optional(),
  resolutionNodeId: z.string().optional(),
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
  version: "2026.07.16.2",
  globalArguments: GlobalArgs,
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
        "Patch a workflow, queue it, fetch images, and record a `generation` resource.",
      arguments: GenerateArgs,
      execute: async (args: z.infer<typeof GenerateArgs>, context: Context) => {
        const { globalArgs } = context;
        let graph: ApiGraph;
        if (args.workflow) {
          graph = args.workflow as ApiGraph;
        } else if (globalArgs.workflowPath) {
          graph = JSON.parse(
            await Deno.readTextFile(globalArgs.workflowPath),
          ) as ApiGraph;
        } else {
          throw new Error(
            "generate requires an inline `workflow` graph or globalArgs.workflowPath",
          );
        }

        const patched = applyIdeogramOverrides(graph, {
          caption: args.caption,
          captionNodeId: args.captionNodeId,
          seed: args.seed,
          seedNodeId: args.seedNodeId,
          resolution: args.resolution,
          resolutionNodeId: args.resolutionNodeId,
        });

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

        await Deno.mkdir(globalArgs.outputDir, { recursive: true });
        const paths: string[] = [];
        for (const img of images) {
          const bytes = await client.fetchImage(img);
          const path = `${globalArgs.outputDir}/${img.filename}`;
          await Deno.writeFile(path, bytes);
          paths.push(path);
        }

        await context.writeResource("generation", "generation", {
          promptId,
          images,
          paths,
          seed: args.seed ?? null,
        });
        return { dataHandles: [] };
      },
    },
  },
};
