// Swamp extension model: @magistr/jscad-cad
// Application layer — orchestrates domain services, owns swamp I/O.
// No CAD logic lives here; all geometry concerns are in the domain layer.

import { z } from "npm:zod@4";
import { CadScript, OUTPUT_FORMATS, ScriptParameters } from "./jscad/types.ts";
import { ScriptEvaluator } from "./jscad/script_evaluator.ts";

/** The @magistr/jscad-cad model — evaluates a JSCAD v2 CadScript main() and serializes the result to STL/DXF/SVG/OBJ/3MF. */
export const model = {
  type: "@magistr/jscad-cad",
  version: "2026.04.05.2",

  resources: {
    result: {
      description: "RenderResult — outcome of evaluating a CadScript",
      schema: z.object({
        success: z.boolean(),
        format: z.string(),
        objectCount: z.number(),
        durationMs: z.number(),
        executedAt: z.iso.datetime(),
        error: z.string().optional(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  files: {
    output: {
      description: "SerializedModel — generated CAD file (STL/DXF/SVG/OBJ/3MF)",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    log: {
      description: "Evaluation warnings from CadScript execution",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },

  methods: {
    run: {
      description:
        "Evaluate a CadScript and serialize the resulting Geometry to the requested OutputFormat",
      arguments: z.object({
        script: z.string().describe(
          "JSCAD JavaScript defining main(params) → geometry",
        ),
        parameters: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Key-value ScriptParameters passed to main(params)"),
        outputFormat: z
          .enum(OUTPUT_FORMATS)
          .default("stl")
          .describe("Target OutputFormat for the SerializedModel"),
      }),
      execute: async (args, context) => {
        const startedAt = Date.now();

        // Domain — eval + serialize in one subprocess call
        const script = CadScript.of(args.script);
        const params = ScriptParameters.of(args.parameters);
        const { serialized, objectCount } = ScriptEvaluator
          .evaluateAndSerialize(
            script,
            params,
            args.outputFormat,
          );

        // Infrastructure — swamp writes; only reached on success
        const outputWriter = context.createFileWriter!("output", "output");
        const outputHandle = await outputWriter.writeAll(serialized.bytes);

        const logWriter = context.createFileWriter!("log", "log");
        const logHandle = await logWriter.writeText("(no warnings)");

        const resultHandle = await context.writeResource!("result", "result", {
          success: true,
          format: serialized.format,
          objectCount,
          durationMs: Date.now() - startedAt,
          executedAt: new Date().toISOString(),
        });

        return { dataHandles: [resultHandle, outputHandle, logHandle] };
      },
    },
  },
};
