// Swamp extension model: @magistr/jscad-stl-slicer
// Provides Z-plane slicing, 6-view orthographic projection, symmetry analysis,
// directional profile extraction, feature detection, and mesh comparison.

import { z } from "npm:zod@4";
import { StlSlicer } from "./jscad/stl_slicer.ts";

const boundsSchema = z.object({
  minX: z.number(),
  maxX: z.number(),
  minY: z.number(),
  maxY: z.number(),
  width: z.number(),
  depth: z.number(),
});

const bounds3Schema = z.object({
  minX: z.number(),
  maxX: z.number(),
  minY: z.number(),
  maxY: z.number(),
  minZ: z.number(),
  maxZ: z.number(),
  sizeX: z.number(),
  sizeY: z.number(),
  sizeZ: z.number(),
});

const viewSchema = z.object({ widthMm: z.number(), heightMm: z.number() });

const axisEnum = z.enum(["X", "Y", "Z"]);

const axisComparisonSchema = z.object({
  refSpan: z.number(),
  modelSpan: z.number(),
  delta: z.number(),
  deltaPct: z.number(),
  ratio: z.number(),
});

/** STL analysis model: Z-plane slicing, orthographic projection, symmetry analysis, feature detection, and mesh comparison. */
export const model = {
  type: "@magistr/jscad-stl-slicer",
  version: "2026.07.16.2",

  resources: {
    slice: {
      description: "Z-plane slice result with cross-section measurements",
      schema: z.object({
        sliceZ: z.number(),
        trianglesIntersected: z.number(),
        bounds: boundsSchema,
        widthMm: z.number(),
        depthMm: z.number(),
        referenceWidthMm: z.number().nullable(),
        referenceDepthMm: z.number().nullable(),
        widthDeltaPct: z.number().nullable(),
        depthDeltaPct: z.number().nullable(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    sixViewReport: {
      description:
        "6-view projection measurements (front/back/left/right/top/bottom)",
      schema: z.object({
        bounds: bounds3Schema,
        front: viewSchema,
        back: viewSchema,
        left: viewSchema,
        right: viewSchema,
        top: viewSchema,
        bottom: viewSchema,
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    analysisReport: {
      description: "PCA-based rotation-invariant mesh analysis",
      schema: z.object({
        primaryAxis: z.array(z.number()),
        centroid: z.array(z.number()),
        sortedLengths: z.array(z.number()),
        proportions: z.object({
          midToLong: z.number(),
          shortToLong: z.number(),
        }),
        symmetryScore: z.number(),
        profilePointCount: z.number(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    comparisonReport: {
      description: "Rotation-invariant PCA comparison between two STL meshes",
      schema: z.object({
        refSorted: z.array(z.number()),
        modelSorted: z.array(z.number()),
        ratios: z.array(z.number()),
        refProportions: z.object({
          midToLong: z.number(),
          shortToLong: z.number(),
        }),
        modelProportions: z.object({
          midToLong: z.number(),
          shortToLong: z.number(),
        }),
        proportionDeltas: z.object({
          midToLong: z.number(),
          shortToLong: z.number(),
        }),
        profileMatch: z.number().nullable(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    symmetryReport: {
      description: "Per-axis mirror symmetry analysis",
      schema: z.object({
        centroid: z.array(z.number()),
        axes: z.array(z.object({
          axis: z.string(),
          score: z.number(),
          positiveExtent: z.number(),
          negativeExtent: z.number(),
          extentRatio: z.number(),
        })),
        symmetricAxes: z.array(z.string()),
        asymmetricAxes: z.array(z.string()),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    featureDetectionReport: {
      description:
        "Detected asymmetric feature regions (protrusions, appendages)",
      schema: z.object({
        sliceAxis: z.string(),
        featureCount: z.number(),
        features: z.array(z.object({
          heightRange: z.array(z.number()),
          axis: z.string(),
          direction: z.string(),
          maxProtrusion: z.number(),
          sliceCount: z.number(),
        })),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    surfaceDistanceReport: {
      description:
        "RMS surface distance between two meshes (mean, RMS, Hausdorff, percentiles)",
      schema: z.object({
        meanDistance: z.number(),
        rmsDistance: z.number(),
        maxDistance: z.number(),
        percentile90: z.number(),
        percentile95: z.number(),
        sampleCount: z.number(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    enhancedComparisonReport: {
      description: "Combined PCA + aligned AABB + symmetry comparison",
      schema: z.object({
        refSorted: z.array(z.number()),
        modelSorted: z.array(z.number()),
        ratios: z.array(z.number()),
        refProportions: z.object({
          midToLong: z.number(),
          shortToLong: z.number(),
        }),
        modelProportions: z.object({
          midToLong: z.number(),
          shortToLong: z.number(),
        }),
        proportionDeltas: z.object({
          midToLong: z.number(),
          shortToLong: z.number(),
        }),
        profileMatch: z.number().nullable(),
        alignedAABB: z.object({
          axisMapping: z.object({
            long: z.object({ ref: z.string(), model: z.string() }),
            mid: z.object({ ref: z.string(), model: z.string() }),
            short: z.object({ ref: z.string(), model: z.string() }),
          }),
          long: axisComparisonSchema,
          mid: axisComparisonSchema,
          short: axisComparisonSchema,
        }),
        symmetryRefAxes: z.array(z.string()),
        symmetryModelAxes: z.array(z.string()),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  files: {
    crossSection: {
      description: "SVG cross-section at the sliced Z plane",
      contentType: "image/svg+xml",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    sideProfile: {
      description: "SVG side profile projected onto XZ plane",
      contentType: "image/svg+xml",
      lifetime: "7d",
      garbageCollection: 5,
    },
    sixViewSheet: {
      description:
        "SVG 6-view engineering drawing sheet with optional reference overlay",
      contentType: "image/svg+xml",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    profileData: {
      description: "JSON profile curve extracted along primary axis",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    directionalProfile: {
      description:
        "JSON profile curve along a specified axis with directional extents",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    multiSliceData: {
      description:
        "JSON multi-height cross-section measurements with separate width and depth",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
    sliceFile: {
      description:
        "Slice an STL file at an absolute path and produce cross-section SVG",
      arguments: z.object({
        filePath: z.string(),
        sliceZ: z.number().optional(),
        referenceWidthMm: z.number().optional(),
        referenceDepthMm: z.number().optional(),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const sliceZ = args.sliceZ ?? StlSlicer.centerZ(bytes);
        const result = StlSlicer.slice(bytes, sliceZ);

        const widthDelta = args.referenceWidthMm != null
          ? ((result.bounds.width - args.referenceWidthMm) /
            args.referenceWidthMm) * 100
          : null;
        const depthDelta = args.referenceDepthMm != null
          ? ((result.bounds.depth - args.referenceDepthMm) /
            args.referenceDepthMm) * 100
          : null;

        const sliceWriter = context.createFileWriter!(
          "crossSection",
          "crossSection",
        );
        const sliceHandle = await sliceWriter.writeText(result.svgPath);

        const reportHandle = await context.writeResource!("slice", "report", {
          sliceZ,
          trianglesIntersected: result.trianglesIntersected,
          bounds: result.bounds,
          widthMm: result.bounds.width,
          depthMm: result.bounds.depth,
          referenceWidthMm: args.referenceWidthMm ?? null,
          referenceDepthMm: args.referenceDepthMm ?? null,
          widthDeltaPct: widthDelta,
          depthDeltaPct: depthDelta,
        });

        return { dataHandles: [reportHandle, sliceHandle] };
      },
    },

    sixViewsFile: {
      description:
        "6-view orthographic drawing from an STL file, optionally overlaying a reference STL",
      arguments: z.object({
        filePath: z.string(),
        refH: z.number().default(135).describe(
          "Reference height in mm for title",
        ),
        refW: z.number().default(260).describe(
          "Reference width in mm for title",
        ),
        refPath: z.string().optional().describe(
          "Absolute path to reference STL for overlay",
        ),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const refBytes = args.refPath
          ? await Deno.readFile(args.refPath)
          : undefined;
        const result = StlSlicer.sixViews(
          bytes,
          args.refH,
          args.refW,
          refBytes,
        );

        const sheetWriter = context.createFileWriter!(
          "sixViewSheet",
          "sixViewSheet",
        );
        const sheetHandle = await sheetWriter.writeText(result.sheetSvg);

        const reportHandle = await context.writeResource!(
          "sixViewReport",
          "report",
          {
            bounds: result.bounds,
            front: {
              widthMm: result.front.widthMm,
              heightMm: result.front.heightMm,
            },
            back: {
              widthMm: result.back.widthMm,
              heightMm: result.back.heightMm,
            },
            left: {
              widthMm: result.left.widthMm,
              heightMm: result.left.heightMm,
            },
            right: {
              widthMm: result.right.widthMm,
              heightMm: result.right.heightMm,
            },
            top: { widthMm: result.top.widthMm, heightMm: result.top.heightMm },
            bottom: {
              widthMm: result.bottom.widthMm,
              heightMm: result.bottom.heightMm,
            },
          },
        );

        return { dataHandles: [reportHandle, sheetHandle] };
      },
    },

    sixViews: {
      description:
        "6-view orthographic drawing from a @magistr/jscad-cad model, optionally overlaying a reference STL",
      arguments: z.object({
        cadModelName: z.string(),
        refH: z.number().default(135),
        refW: z.number().default(260),
        refPath: z.string().optional().describe(
          "Absolute path to reference STL for overlay",
        ),
      }),
      execute: async (args, context) => {
        const found = await context.definitionRepository.findByNameGlobal(
          args.cadModelName,
        );
        if (!found) throw new Error(`Model "${args.cadModelName}" not found`);
        const bytes = await context.dataRepository.getContent(
          found.type,
          found.definition.id,
          "output",
        );
        if (!bytes) {
          throw new Error(
            `No output data found for model "${args.cadModelName}"`,
          );
        }
        const refBytes = args.refPath
          ? await Deno.readFile(args.refPath)
          : undefined;

        const result = StlSlicer.sixViews(
          bytes,
          args.refH,
          args.refW,
          refBytes,
        );

        const sheetWriter = context.createFileWriter!(
          "sixViewSheet",
          "sixViewSheet",
        );
        const sheetHandle = await sheetWriter.writeText(result.sheetSvg);

        const reportHandle = await context.writeResource!(
          "sixViewReport",
          "report",
          {
            bounds: result.bounds,
            front: {
              widthMm: result.front.widthMm,
              heightMm: result.front.heightMm,
            },
            back: {
              widthMm: result.back.widthMm,
              heightMm: result.back.heightMm,
            },
            left: {
              widthMm: result.left.widthMm,
              heightMm: result.left.heightMm,
            },
            right: {
              widthMm: result.right.widthMm,
              heightMm: result.right.heightMm,
            },
            top: { widthMm: result.top.widthMm, heightMm: result.top.heightMm },
            bottom: {
              widthMm: result.bottom.widthMm,
              heightMm: result.bottom.heightMm,
            },
          },
        );

        return { dataHandles: [reportHandle, sheetHandle] };
      },
    },

    analyze: {
      description:
        "PCA-based rotation-invariant analysis: principal axes, profile extraction, symmetry detection",
      arguments: z.object({
        filePath: z.string(),
        sliceCount: z.number().default(50),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const pca = StlSlicer.principalAxes(bytes);
        const profile = StlSlicer.extractProfile(bytes, args.sliceCount);

        const proportions = {
          midToLong: pca.sortedLengths[0] > 0
            ? pca.sortedLengths[1] / pca.sortedLengths[0]
            : 0,
          shortToLong: pca.sortedLengths[0] > 0
            ? pca.sortedLengths[2] / pca.sortedLengths[0]
            : 0,
        };

        const profileWriter = context.createFileWriter!(
          "profileData",
          "profileData",
        );
        const profileHandle = await profileWriter.writeText(JSON.stringify(
          {
            primaryAxis: profile.primaryAxis,
            centroid: profile.centroid,
            symmetryScore: profile.symmetryScore,
            profile: profile.profile,
          },
          null,
          2,
        ));

        const reportHandle = await context.writeResource!(
          "analysisReport",
          "analysis",
          {
            primaryAxis: [...pca.axes[0]],
            centroid: [...pca.centroid],
            sortedLengths: [...pca.sortedLengths],
            proportions,
            symmetryScore: profile.symmetryScore,
            profilePointCount: profile.profile.length,
          },
        );

        return { dataHandles: [reportHandle, profileHandle] };
      },
    },

    analyzeSymmetry: {
      description:
        "Per-axis mirror symmetry analysis — identifies symmetric and asymmetric axes",
      arguments: z.object({
        filePath: z.string(),
        threshold: z.number().default(0.85).describe(
          "Symmetry score threshold (0-1)",
        ),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const result = StlSlicer.analyzeSymmetry(bytes, args.threshold);

        const reportHandle = await context.writeResource!(
          "symmetryReport",
          "symmetry",
          {
            centroid: [...result.centroid],
            axes: result.axes.map((a) => ({ ...a })),
            symmetricAxes: result.symmetricAxes,
            asymmetricAxes: result.asymmetricAxes,
          },
        );

        return { dataHandles: [reportHandle] };
      },
    },

    extractDirectionalProfile: {
      description:
        "Extract a profile along a specified axis, measuring extent along another axis",
      arguments: z.object({
        filePath: z.string(),
        sliceAxis: axisEnum.default("Z"),
        measureAxis: axisEnum.default("X"),
        sliceCount: z.number().default(50),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const result = StlSlicer.extractDirectionalProfile(
          bytes,
          args.sliceAxis,
          args.measureAxis,
          args.sliceCount,
        );

        const profileWriter = context.createFileWriter!(
          "directionalProfile",
          "directionalProfile",
        );
        const profileHandle = await profileWriter.writeText(
          JSON.stringify(result, null, 2),
        );

        return { dataHandles: [profileHandle] };
      },
    },

    detectFeatures: {
      description:
        "Detect asymmetric feature regions (protrusions beyond the body envelope)",
      arguments: z.object({
        filePath: z.string(),
        sliceAxis: axisEnum.default("Z"),
        sliceCount: z.number().default(50),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const result = StlSlicer.detectFeatures(
          bytes,
          args.sliceAxis,
          args.sliceCount,
        );

        const reportHandle = await context.writeResource!(
          "featureDetectionReport",
          "features",
          {
            sliceAxis: result.sliceAxis,
            featureCount: result.features.length,
            features: result.features,
          },
        );

        return { dataHandles: [reportHandle] };
      },
    },

    multiSlice: {
      description:
        "Cross-section analysis at multiple heights with separate width and depth",
      arguments: z.object({
        filePath: z.string(),
        sliceAxis: axisEnum.default("Z"),
        widthAxis: axisEnum.default("X"),
        depthAxis: axisEnum.default("Y"),
        sliceCount: z.number().default(30),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const result = StlSlicer.multiSlice(
          bytes,
          args.sliceAxis,
          args.widthAxis,
          args.depthAxis,
          args.sliceCount,
        );

        const dataWriter = context.createFileWriter!(
          "multiSliceData",
          "multiSliceData",
        );
        const dataHandle = await dataWriter.writeText(
          JSON.stringify(result, null, 2),
        );

        return { dataHandles: [dataHandle] };
      },
    },

    decompose: {
      description:
        "Decompose a reference STL into features (body, tube, loop, platform) and generate a JSCAD script",
      arguments: z.object({
        filePath: z.string(),
        sliceAxis: axisEnum.default("Z"),
        sliceCount: z.number().default(60),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const result = StlSlicer.decompose(
          bytes,
          args.sliceAxis,
          args.sliceCount,
        );

        const dataWriter = context.createFileWriter!(
          "profileData",
          "profileData",
        );
        const dataHandle = await dataWriter.writeText(result.jscadScript);

        const reportHandle = await context.writeResource!(
          "featureDetectionReport",
          "features",
          {
            sliceAxis: result.sliceAxis,
            featureCount: result.features.length,
            features: result.features.map((f) => ({
              heightRange: f.heightRange,
              axis: f.type,
              direction: f.type,
              maxProtrusion: 0,
              sliceCount: 0,
            })),
          },
        );

        return { dataHandles: [reportHandle, dataHandle] };
      },
    },

    surfaceDistance: {
      description:
        "Compute RMS surface distance between two STL meshes (Hausdorff, mean, percentiles)",
      arguments: z.object({
        refPath: z.string(),
        modelPath: z.string(),
        sampleCount: z.number().default(5000),
      }),
      execute: async (args, context) => {
        const refBytes = await Deno.readFile(args.refPath);
        const modelBytes = await Deno.readFile(args.modelPath);
        let result;
        try {
          result = StlSlicer.surfaceDistance(
            refBytes,
            modelBytes,
            args.sampleCount,
          );
        } catch (_e) {
          result = {
            meanDistance: -1,
            rmsDistance: -1,
            maxDistance: -1,
            percentile90: -1,
            percentile95: -1,
            sampleCount: 0,
          };
        }

        const reportHandle = await context.writeResource!(
          "surfaceDistanceReport",
          "surfaceDistance",
          result,
        );

        return { dataHandles: [reportHandle] };
      },
    },

    extractSkeleton: {
      description:
        "Extract centerline skeleton of tubular features (spouts, handles) from an STL",
      arguments: z.object({
        filePath: z.string(),
        sliceAxis: axisEnum.default("Z"),
        featureAxis: axisEnum.default("Y"),
        sliceCount: z.number().default(40),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const result = StlSlicer.extractSkeleton(
          bytes,
          args.sliceAxis,
          args.featureAxis,
          args.sliceCount,
        );

        const dataWriter = context.createFileWriter!(
          "profileData",
          "profileData",
        );
        const dataHandle = await dataWriter.writeText(
          JSON.stringify(result, null, 2),
        );

        return { dataHandles: [dataHandle] };
      },
    },

    generateScript: {
      description:
        "Generate a JSCAD script that reproduces a reference STL using polynomial profiles and directional extents",
      arguments: z.object({
        filePath: z.string(),
        sliceAxis: axisEnum.default("Z"),
        sliceCount: z.number().default(60),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const script = StlSlicer.generateScript(
          bytes,
          args.sliceAxis,
          args.sliceCount,
        );

        const dataWriter = context.createFileWriter!(
          "profileData",
          "profileData",
        );
        const dataHandle = await dataWriter.writeText(script);

        return { dataHandles: [dataHandle] };
      },
    },

    fitProfiles: {
      description:
        "Fit polynomials to body profile curves — returns coefficients for xRadius, dP, dN vs normalized height",
      arguments: z.object({
        filePath: z.string(),
        sliceAxis: axisEnum.default("Z"),
        sliceCount: z.number().default(40),
        maxDegree: z.number().default(15),
        targetError: z.number().default(2.0).describe(
          "Max acceptable error in mm",
        ),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const result = StlSlicer.fitProfiles(
          bytes,
          args.sliceAxis,
          args.sliceCount,
          args.maxDegree,
          args.targetError,
        );

        const dataWriter = context.createFileWriter!(
          "profileData",
          "profileData",
        );
        const dataHandle = await dataWriter.writeText(
          JSON.stringify(result, null, 2),
        );

        return { dataHandles: [dataHandle] };
      },
    },

    extractContours: {
      description:
        "Extract actual cross-section contour points at multiple heights along an axis",
      arguments: z.object({
        filePath: z.string(),
        sliceAxis: axisEnum.default("Z"),
        sliceCount: z.number().default(40),
        pointsPerSlice: z.number().default(64),
      }),
      execute: async (args, context) => {
        const bytes = await Deno.readFile(args.filePath);
        const result = StlSlicer.extractContours(
          bytes,
          args.sliceAxis,
          args.sliceCount,
          args.pointsPerSlice,
        );

        const dataWriter = context.createFileWriter!(
          "multiSliceData",
          "multiSliceData",
        );
        const dataHandle = await dataWriter.writeText(
          JSON.stringify(result, null, 2),
        );

        return { dataHandles: [dataHandle] };
      },
    },

    compareFiles: {
      description: "PCA-based rotation-invariant comparison of two STL files",
      arguments: z.object({
        refPath: z.string(),
        modelPath: z.string(),
      }),
      execute: async (args, context) => {
        const refBytes = await Deno.readFile(args.refPath);
        const modelBytes = await Deno.readFile(args.modelPath);
        const result = StlSlicer.compare(refBytes, modelBytes);

        const reportHandle = await context.writeResource!(
          "comparisonReport",
          "comparison",
          result,
        );
        return { dataHandles: [reportHandle] };
      },
    },

    compareModels: {
      description:
        "PCA-based comparison: reference STL file vs @magistr/jscad-cad model output",
      arguments: z.object({
        refPath: z.string(),
        cadModelName: z.string(),
      }),
      execute: async (args, context) => {
        const refBytes = await Deno.readFile(args.refPath);
        const found = await context.definitionRepository.findByNameGlobal(
          args.cadModelName,
        );
        if (!found) throw new Error(`Model "${args.cadModelName}" not found`);
        const modelBytes = await context.dataRepository.getContent(
          found.type,
          found.definition.id,
          "output",
        );
        if (!modelBytes) {
          throw new Error(
            `No output data found for model "${args.cadModelName}"`,
          );
        }

        const result = StlSlicer.compare(refBytes, modelBytes);
        const reportHandle = await context.writeResource!(
          "comparisonReport",
          "comparison",
          result,
        );
        return { dataHandles: [reportHandle] };
      },
    },

    enhancedCompareFiles: {
      description:
        "Combined PCA + aligned AABB + symmetry comparison of two STL files",
      arguments: z.object({
        refPath: z.string(),
        modelPath: z.string(),
      }),
      execute: async (args, context) => {
        const refBytes = await Deno.readFile(args.refPath);
        const modelBytes = await Deno.readFile(args.modelPath);
        const result = StlSlicer.enhancedCompare(refBytes, modelBytes);

        const reportHandle = await context.writeResource!(
          "enhancedComparisonReport",
          "enhancedComparison",
          {
            refSorted: result.refSorted,
            modelSorted: result.modelSorted,
            ratios: result.ratios,
            refProportions: result.refProportions,
            modelProportions: result.modelProportions,
            proportionDeltas: result.proportionDeltas,
            profileMatch: result.profileMatch,
            alignedAABB: result.alignedAABB,
            symmetryRefAxes: result.symmetryRef.symmetricAxes,
            symmetryModelAxes: result.symmetryModel.symmetricAxes,
          },
        );

        return { dataHandles: [reportHandle] };
      },
    },

    enhancedCompareModels: {
      description:
        "Combined PCA + aligned AABB + symmetry comparison: reference STL vs @magistr/jscad-cad model",
      arguments: z.object({
        refPath: z.string(),
        cadModelName: z.string(),
      }),
      execute: async (args, context) => {
        const refBytes = await Deno.readFile(args.refPath);
        const found = await context.definitionRepository.findByNameGlobal(
          args.cadModelName,
        );
        if (!found) throw new Error(`Model "${args.cadModelName}" not found`);
        const modelBytes = await context.dataRepository.getContent(
          found.type,
          found.definition.id,
          "output",
        );
        if (!modelBytes) {
          throw new Error(
            `No output data found for model "${args.cadModelName}"`,
          );
        }

        const result = StlSlicer.enhancedCompare(refBytes, modelBytes);

        const reportHandle = await context.writeResource!(
          "enhancedComparisonReport",
          "enhancedComparison",
          {
            refSorted: result.refSorted,
            modelSorted: result.modelSorted,
            ratios: result.ratios,
            refProportions: result.refProportions,
            modelProportions: result.modelProportions,
            proportionDeltas: result.proportionDeltas,
            profileMatch: result.profileMatch,
            alignedAABB: result.alignedAABB,
            symmetryRefAxes: result.symmetryRef.symmetricAxes,
            symmetryModelAxes: result.symmetryModel.symmetricAxes,
          },
        );

        return { dataHandles: [reportHandle] };
      },
    },
  },
};
