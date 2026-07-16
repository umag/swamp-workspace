// Swamp extension model: @magistr/jscad-stl-validator
// Validates STL files — either from a @magistr/jscad-cad model's stored output,
// or from an absolute file path on disk.

import { z } from "npm:zod@4";
import { StlValidator } from "./jscad/stl_validator.ts";

const reportSchema = z.object({
  valid: z.boolean(),
  format: z.enum(["binary", "ascii", "empty", "unknown"]),
  triangleCount: z.number(),
  expectedTriangleCount: z.number().nullable(),
  degenerateTriangles: z.number(),
  issues: z.array(z.string()),
  boundingBox: z
    .object({
      min: z.tuple([z.number(), z.number(), z.number()]),
      max: z.tuple([z.number(), z.number(), z.number()]),
      size: z.tuple([z.number(), z.number(), z.number()]),
    })
    .nullable(),
});

/** Swamp model that validates STL geometry from a @magistr/jscad-cad model output or a file on disk. */
export const model = {
  type: "@magistr/jscad-stl-validator",
  version: "2026.07.16.2",

  resources: {
    report: {
      description: "STL validation report",
      schema: reportSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
    validate: {
      description:
        "Validate the STL output stored by a @magistr/jscad-cad model instance",
      arguments: z.object({
        cadModelName: z.string().describe(
          "Name of the @magistr/jscad-cad model whose stored output STL to validate",
        ),
        version: z.number().optional().describe(
          "Data version to validate (defaults to latest)",
        ),
      }),
      execute: async (args, context) => {
        // Resolve model name → type + id via definition repository
        const found = await context.definitionRepository.findByNameGlobal(
          args.cadModelName,
        );
        if (!found) {
          throw new Error(`Model "${args.cadModelName}" not found`);
        }

        // Read the raw STL bytes from the data repository
        const bytes = await context.dataRepository.getContent(
          found.type,
          found.definition.id,
          "output",
          args.version,
        );
        if (bytes == null) {
          throw new Error(
            `No output data found for model "${args.cadModelName}"${
              args.version != null ? ` version ${args.version}` : ""
            }`,
          );
        }

        const report = StlValidator.validate(bytes);
        const reportHandle = await context.writeResource!(
          "report",
          "report",
          report,
        );
        return { dataHandles: [reportHandle] };
      },
    },

    validateFile: {
      description: "Validate an STL file at an absolute path on disk",
      arguments: z.object({
        filePath: z.string().describe(
          "Absolute path to the STL file to validate",
        ),
      }),
      execute: async (args, context) => {
        let bytes: Uint8Array;
        try {
          bytes = await Deno.readFile(args.filePath);
        } catch (err) {
          throw new Error(
            `Cannot read "${args.filePath}": ${(err as Error).message}`,
          );
        }

        const report = StlValidator.validate(bytes);
        const reportHandle = await context.writeResource!(
          "report",
          "report",
          report,
        );
        return { dataHandles: [reportHandle] };
      },
    },
  },
};
