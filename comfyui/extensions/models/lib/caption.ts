/**
 * Ideogram-4 structured-caption builder.
 *
 * The Ideogram 4.0 local model consumes a structured JSON caption as its
 * prompt. A caption has a scene summary, a style block, and a compositional
 * deconstruction whose elements each carry a bounding box on a normalized
 * 0..1000 canvas (top-left origin).
 *
 * Zero runtime imports — plain TypeScript.
 */

/** A bounding box `[x1, y1, x2, y2]`: integers, 0..1000, x1<x2, y1<y2. */
export type BBox = [number, number, number, number];

/** A single deconstructed element of the composition. */
export interface CaptionElement {
  type: "obj" | "text";
  bbox: BBox;
  desc: string;
  color_palette?: string[];
}

/** The style block describing how the scene is rendered. */
export interface StyleDescription {
  aesthetics?: string;
  lighting?: string;
  photo?: string;
  medium?: string;
  color_palette?: string[];
}

/** The full wire-format caption consumed by the model. */
export interface IdeogramCaption {
  high_level_description: string;
  style_description?: StyleDescription;
  compositional_deconstruction?: {
    background?: string;
    elements: CaptionElement[];
  };
}

/** Input shape for a single object/text element. */
export interface CaptionObjectInput {
  bbox: BBox;
  desc: string;
  type?: "obj" | "text";
  color_palette?: string[];
}

/** Input shape for {@link buildCaption}. */
export interface BuildCaptionInput {
  summary: string;
  style?: StyleDescription;
  background?: string;
  objects?: CaptionObjectInput[];
}

export const BBOX_MIN = 0;
export const BBOX_MAX = 1000;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** True when `s` is a `#RRGGBB` hex color. */
export function isHexColor(s: string): boolean {
  return HEX_COLOR.test(s);
}

/**
 * Validate a bounding box, throwing an Error naming the offending value on any
 * violation: wrong length, non-integer, out of [0,1000], or reversed axis.
 */
export function validateBBox(b: BBox): void {
  if (!Array.isArray(b) || b.length !== 4) {
    throw new Error(
      `bbox must have exactly 4 numbers, got length ${
        Array.isArray(b) ? (b as unknown[]).length : typeof b
      }`,
    );
  }
  const [x1, y1, x2, y2] = b;
  for (const v of b) {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error(`bbox values must be integers, got ${JSON.stringify(v)}`);
    }
    if (v < BBOX_MIN || v > BBOX_MAX) {
      throw new Error(
        `bbox values must be within [${BBOX_MIN}, ${BBOX_MAX}], got ${v}`,
      );
    }
  }
  if (x1 >= x2) {
    throw new Error(`bbox x1 must be < x2, got x1=${x1}, x2=${x2}`);
  }
  if (y1 >= y2) {
    throw new Error(`bbox y1 must be < y2, got y1=${y1}, y2=${y2}`);
  }
}

function validatePalette(palette: string[], where: string): void {
  for (const c of palette) {
    if (!isHexColor(c)) {
      throw new Error(
        `${where} color_palette entry must be #RRGGBB, got ${
          JSON.stringify(c)
        }`,
      );
    }
  }
}

/**
 * Build a validated {@link IdeogramCaption} from loose input. Each object's
 * `type` defaults to `"obj"`; every bbox is validated and every hex color in a
 * present `color_palette` must pass {@link isHexColor}. The
 * `compositional_deconstruction` is omitted when there are no objects and no
 * background; `style_description` is omitted when no style is given.
 */
export function buildCaption(input: BuildCaptionInput): IdeogramCaption {
  const caption: IdeogramCaption = {
    high_level_description: input.summary,
  };

  if (input.style !== undefined) {
    if (input.style.color_palette !== undefined) {
      validatePalette(input.style.color_palette, "style_description");
    }
    caption.style_description = input.style;
  }

  const objects = input.objects ?? [];
  const hasBackground = input.background !== undefined;

  if (objects.length > 0 || hasBackground) {
    const elements: CaptionElement[] = objects.map((o) => {
      validateBBox(o.bbox);
      if (o.color_palette !== undefined) {
        validatePalette(o.color_palette, "element");
      }
      const element: CaptionElement = {
        type: o.type ?? "obj",
        bbox: o.bbox,
        desc: o.desc,
      };
      if (o.color_palette !== undefined) {
        element.color_palette = o.color_palette;
      }
      return element;
    });

    const deconstruction: { background?: string; elements: CaptionElement[] } =
      {
        elements,
      };
    if (hasBackground) {
      deconstruction.background = input.background;
    }
    caption.compositional_deconstruction = deconstruction;
  }

  return caption;
}

/** Serialize a caption to pretty (2-space) JSON; round-trips via JSON.parse. */
export function serializeCaption(c: IdeogramCaption): string {
  return JSON.stringify(c, null, 2);
}

/**
 * A single element of a Claude-generated caption. In the magic-prompt contract
 * the bbox is `[y1, x1, y2, x2]` (y-first) normalized 0..1000 and is OPTIONAL
 * per element; `text` carries the verbatim characters of a `text` element.
 */
export interface GeneratedElement {
  type: "obj" | "text";
  bbox?: BBox;
  desc?: string;
  text?: string;
}

/**
 * The caption shape emitted by the Ideogram-4 magic prompt: three top-level
 * keys — `aspect_ratio`, `high_level_description`, and an optional
 * `compositional_deconstruction`.
 */
export interface GeneratedCaption {
  aspect_ratio: string;
  high_level_description: string;
  compositional_deconstruction?: {
    background?: string;
    elements: GeneratedElement[];
  };
}

/** Strip an optional ```json fence (and surrounding whitespace) from `raw`. */
function stripFences(raw: string): string {
  const t = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(t);
  return (fenced ? fenced[1] : t).trim();
}

/**
 * Validate + repair a generated bbox `[y1,x1,y2,x2]`. Requires exactly 4
 * integers in [0,1000] (throws otherwise), then normalizes a reversed axis by
 * sorting (Claude occasionally emits `y1>y2`). Returns `undefined` for a
 * degenerate (zero-area) box so the element simply keeps no bbox rather than
 * failing the whole caption.
 */
export function repairBBox(b: unknown): BBox | undefined {
  if (!Array.isArray(b) || b.length !== 4) {
    throw new Error(
      `bbox must have exactly 4 numbers, got ${JSON.stringify(b)}`,
    );
  }
  for (const v of b) {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error(`bbox values must be integers, got ${JSON.stringify(v)}`);
    }
    if (v < BBOX_MIN || v > BBOX_MAX) {
      throw new Error(
        `bbox values must be within [${BBOX_MIN}, ${BBOX_MAX}], got ${v}`,
      );
    }
  }
  const [a0, a1, a2, a3] = b as BBox;
  const y1 = Math.min(a0, a2);
  const y2 = Math.max(a0, a2);
  const x1 = Math.min(a1, a3);
  const x2 = Math.max(a1, a3);
  if (y1 === y2 || x1 === x2) return undefined;
  return [y1, x1, y2, x2];
}

/**
 * Parse and validate a Claude-generated Ideogram-4 caption. Tolerates an
 * accidental markdown code fence. Throws on malformed JSON, a missing required
 * key (`aspect_ratio`, `high_level_description`), a bad element `type`, or an
 * invalid bbox (validated via {@link validateBBox}). Returns the typed caption.
 */
export function parseGeneratedCaption(raw: string): GeneratedCaption {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (e) {
    throw new Error(
      `generated caption is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("generated caption must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.aspect_ratio !== "string") {
    throw new Error("generated caption is missing a string `aspect_ratio`");
  }
  if (typeof obj.high_level_description !== "string") {
    throw new Error(
      "generated caption is missing a string `high_level_description`",
    );
  }
  const result: GeneratedCaption = {
    aspect_ratio: obj.aspect_ratio,
    high_level_description: obj.high_level_description,
  };
  const cd = obj.compositional_deconstruction;
  if (cd !== undefined) {
    if (typeof cd !== "object" || cd === null) {
      throw new Error("`compositional_deconstruction` must be an object");
    }
    const cdo = cd as Record<string, unknown>;
    const rawElements = cdo.elements;
    if (!Array.isArray(rawElements)) {
      throw new Error(
        "`compositional_deconstruction.elements` must be an array",
      );
    }
    const elements: GeneratedElement[] = rawElements.map((raw, i) => {
      if (typeof raw !== "object" || raw === null) {
        throw new Error(`element ${i} must be an object`);
      }
      const el = raw as Record<string, unknown>;
      if (el.type !== "obj" && el.type !== "text") {
        throw new Error(
          `element ${i} type must be "obj" or "text", got ${
            JSON.stringify(el.type)
          }`,
        );
      }
      const out: GeneratedElement = { type: el.type };
      if (el.bbox !== undefined) {
        const repaired = repairBBox(el.bbox);
        if (repaired) out.bbox = repaired;
      }
      if (typeof el.desc === "string") out.desc = el.desc;
      if (typeof el.text === "string") out.text = el.text;
      return out;
    });
    const deconstruction: {
      background?: string;
      elements: GeneratedElement[];
    } = { elements };
    if (typeof cdo.background === "string") {
      deconstruction.background = cdo.background;
    }
    result.compositional_deconstruction = deconstruction;
  }
  return result;
}
