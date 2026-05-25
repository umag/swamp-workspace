// Domain value objects for the JSCAD CAD integration.
// All types are immutable — equality by value, no identity.

// Value Object: CadScript
// A JSCAD JavaScript string defining a main(params) function that returns geometry.
export type CadScript = { readonly source: string };
export const CadScript = {
  of(source: string): CadScript {
    if (!source.trim()) throw new Error("CadScript source must not be empty");
    return { source };
  },
};

// Value Object: ScriptParameters
// Immutable key-value map passed to main(params) at render time.
export type ScriptParameters = { readonly values: Record<string, unknown> };
export const ScriptParameters = {
  of(values: Record<string, unknown> = {}): ScriptParameters {
    return { values: { ...values } };
  },
  empty(): ScriptParameters {
    return { values: {} };
  },
};

// Value Object: OutputFormat
// Target serialization format for the CAD output file.
export type OutputFormat = "stl" | "stl-ascii" | "dxf" | "svg" | "obj" | "3mf";
export const OUTPUT_FORMATS = [
  "stl",
  "stl-ascii",
  "dxf",
  "svg",
  "obj",
  "3mf",
] as const;

// Value Object: Geometry
// Wraps one or more JSCAD geom3/geom2 objects returned by a CadScript's main().
export type Geometry = { readonly shapes: ReadonlyArray<unknown> };
export const Geometry = {
  of(raw: unknown): Geometry {
    const shapes = Array.isArray(raw) ? raw : [raw];
    if (shapes.length === 0) {
      throw new Error("Geometry must contain at least one shape");
    }
    return { shapes };
  },
  count(g: Geometry): number {
    return g.shapes.length;
  },
};

// Value Object: SerializedModel
// Raw bytes of the CAD file ready for storage, together with the format used.
export type SerializedModel = {
  readonly bytes: Uint8Array;
  readonly format: OutputFormat;
};
export const SerializedModel = {
  of(bytes: Uint8Array, format: OutputFormat): SerializedModel {
    return { bytes, format };
  },
};

// Value Object: RenderResult
// Outcome of executing a CadScript — stored as a swamp resource.
export type RenderResult = {
  readonly success: boolean;
  readonly format: string;
  readonly objectCount: number;
  readonly durationMs: number;
  readonly executedAt: string;
  readonly error?: string;
};
