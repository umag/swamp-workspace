// Swamp extension model: @magistr/jscad-stl-validator
// Validates STL files — either from a @magistr/jscad-cad model's stored output,
// or from an absolute file path on disk.

import { z } from "npm:zod@4";
import { StlValidator } from "./jscad/stl_validator.ts";
import { PathPolicyError, resolveStlPath } from "./jscad/safe_path.ts";

// LB3 (application half): generous default cap so legitimate multi-MB STL
// files pass; validateFile enforces this via Deno.stat BEFORE Deno.readFile,
// so an oversized file is never buffered into memory.
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024; // 256 MiB

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
  version: "2026.08.02.1",

  upgrades: [
    {
      toVersion: "2026.08.02.1",
      description:
        "LB2–LB5 geometry/format fixes; add defaulted maxFileBytes global arg (no breaking schema change).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  globalArguments: z.object({
    allowedRoots: z.array(z.string()).default([]).describe(
      "Optional operator-set confinement roots for validateFile. When " +
        "non-empty, validateFile only reads files whose canonicalized path " +
        "falls under one of these roots. Empty (default) preserves the " +
        "historical unconfined contract — validateFile is an " +
        "operator-supplied-absolute-path method by design.",
    ),
    maxFileBytes: z.number().int().positive().default(DEFAULT_MAX_FILE_BYTES)
      .describe(
        "Maximum size in bytes validateFile will read from disk. Checked " +
          "via Deno.stat BEFORE Deno.readFile, so an oversized file is " +
          "never buffered into memory. Defaulted generously (256 MiB) so " +
          "legitimate multi-MB STL files pass; read only from " +
          "context.globalArgs (never per-call arguments), mirroring the " +
          "allowedRoots trust-boundary convention.",
      ),
  }),

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
        const allowedRoots = context.globalArgs?.allowedRoots ?? [];
        const maxFileBytes = context.globalArgs?.maxFileBytes ??
          DEFAULT_MAX_FILE_BYTES;

        let resolvedPath: string;
        try {
          resolvedPath = await resolveStlPath(args.filePath, allowedRoots);
        } catch (err) {
          if (err instanceof PathPolicyError) {
            throw err;
          }
          throw new Error(
            `Cannot read "${args.filePath}": ${(err as Error).message}`,
          );
        }

        // LB3 (application half): stat the canonical path BEFORE reading it,
        // so a huge file is never buffered into memory. Stat failures (e.g.
        // the target vanished between resolveStlPath and here) wrap to the
        // same "Cannot read" message as a readFile failure; a size-cap
        // violation gets its own distinct "Refusing to read" message.
        let info: Deno.FileInfo;
        try {
          info = await Deno.stat(resolvedPath);
        } catch (err) {
          throw new Error(
            `Cannot read "${args.filePath}": ${(err as Error).message}`,
          );
        }
        if (info.size > maxFileBytes) {
          throw new Error(
            `Refusing to read "${args.filePath}": file exceeds maxFileBytes (${info.size} > ${maxFileBytes})`,
          );
        }

        let bytes: Uint8Array;
        try {
          bytes = await Deno.readFile(resolvedPath);
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
