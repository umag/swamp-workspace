/**
 * Swamp extension model: `@magistr/manim/scene`.
 *
 * Drives the ManimCommunity (https://github.com/ManimCommunity/manim) CLI to
 * render a Python-defined `Scene` into a video (or GIF/PNG). The application
 * layer here owns only swamp I/O; the render orchestration lives in
 * `./manim/runner.ts` and the CLI vocabulary in `./manim/types.ts`.
 *
 * The `command` global argument is the invocation prefix (default `["manim"]`).
 * Point it at a wrapper when manim is not on `PATH`, e.g. `["uvx", "manim"]`
 * or `["docker", "run", "--rm", "-i", "manimcommunity/manim", "manim"]`.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { FORMATS, QUALITIES } from "./manim/types.ts";
import {
  type CommandRunner,
  defaultIo,
  defaultRunner,
  type RenderInput,
  type RenderIo,
  renderScene,
} from "./manim/runner.ts";

const GlobalArgsSchema = z.object({
  command: z
    .array(z.string().min(1))
    .min(1)
    .default(["manim"])
    .describe(
      "manim invocation prefix; first element is the binary " +
        '(e.g. ["manim"] or ["uvx", "manim"])',
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RenderArgsSchema = z.object({
  script: z
    .string()
    .min(1)
    .describe("Python source defining one or more manim Scene classes"),
  sceneNames: z
    .array(z.string().min(1))
    .default([])
    .describe("Scene class names to render; empty renders all scenes (-a)"),
  quality: z
    .enum(QUALITIES)
    .default("medium")
    .describe("Render quality: low/medium/high/production/fourk"),
  format: z
    .enum(FORMATS)
    .default("mp4")
    .describe("Output container format"),
  resolution: z
    .string()
    .regex(/^\d+,\d+$/, "resolution must be 'WIDTH,HEIGHT'")
    .optional()
    .describe("Optional pixel resolution, e.g. '1920,1080'"),
  fps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional frame rate override"),
  transparent: z
    .boolean()
    .default(false)
    .describe("Render with a transparent background"),
  extraArgs: z
    .array(z.string())
    .default([])
    .describe("Extra raw manim CLI arguments appended before the script"),
});

const ResultSchema = z.object({
  success: z.boolean(),
  sceneNames: z.array(z.string()),
  quality: z.string(),
  format: z.string(),
  sizeBytes: z.number(),
  durationMs: z.number(),
  executedAt: z.iso.datetime(),
});

/** Minimal swamp method context this model relies on. */
interface ManimContext {
  globalArgs: unknown;
  createFileWriter: (
    specName: string,
    name: string,
  ) => {
    writeAll: (bytes: Uint8Array) => Promise<{ name: string }>;
    writeText: (text: string) => Promise<{ name: string }>;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Injectable seams for {@link runRender}, defaulted to the real runtime. */
export interface RenderDeps {
  /** Subprocess runner. */
  run?: CommandRunner;
  /** Filesystem seam. */
  io?: RenderIo;
}

/**
 * Application service: parse args, render the scene, and persist the artifact,
 * log, and result to swamp. Split out from the method so tests can inject a
 * scripted runner and in-memory IO without spawning `manim`.
 */
export async function runRender(
  rawArgs: Record<string, unknown>,
  context: ManimContext,
  deps: RenderDeps = {},
): Promise<{ dataHandles: { name: string }[] }> {
  const args = RenderArgsSchema.parse(rawArgs);
  const g: GlobalArgs = GlobalArgsSchema.parse(context.globalArgs);

  const input: RenderInput = {
    command: g.command,
    script: args.script,
    sceneNames: args.sceneNames,
    quality: args.quality,
    format: args.format,
    resolution: args.resolution,
    fps: args.fps,
    transparent: args.transparent,
    extraArgs: args.extraArgs,
  };

  // Throws ManimRenderError on failure — captured by the method-summary
  // report. Only the success path writes swamp artifacts.
  const outcome = await renderScene(
    deps.run ?? defaultRunner,
    input,
    deps.io ?? defaultIo,
  );

  const outputWriter = context.createFileWriter("output", "output");
  const outputHandle = await outputWriter.writeAll(outcome.outputBytes);

  const logWriter = context.createFileWriter("log", "log");
  const logHandle = await logWriter.writeText(
    `$ ${g.command.join(" ")} render …\n\n` +
      `--- stdout ---\n${outcome.stdout}\n` +
      `--- stderr ---\n${outcome.stderr}\n`,
  );

  const resultHandle = await context.writeResource("result", "result", {
    success: true,
    sceneNames: args.sceneNames,
    quality: args.quality,
    format: args.format,
    sizeBytes: outcome.outputBytes.byteLength,
    durationMs: outcome.durationMs,
    executedAt: new Date().toISOString(),
  });

  return { dataHandles: [resultHandle, outputHandle, logHandle] };
}

/** The `@magistr/manim/scene` model — renders a manim Scene to a media file. */
export const model = {
  type: "@magistr/manim/scene",
  version: "2026.09.19.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    result: {
      description: "RenderResult — metadata for one manim render",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  files: {
    output: {
      description: "Rendered media file (mp4/gif/png/webm)",
      contentType: "application/octet-stream",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    log: {
      description: "manim CLI stdout + stderr",
      contentType: "text/plain",
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    render: {
      description:
        "Render a manim Scene from Python source to a media file via the " +
        "ManimCommunity CLI",
      arguments: RenderArgsSchema,
      execute: (rawArgs: Record<string, unknown>, context: unknown) =>
        runRender(rawArgs, context as ManimContext),
    },
  },
};
