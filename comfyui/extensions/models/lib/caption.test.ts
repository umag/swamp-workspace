import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { describe, it } from "jsr:@std/testing@1/bdd";
import {
  type BBox,
  buildCaption,
  type BuildCaptionInput,
  type IdeogramCaption,
  isHexColor,
  serializeCaption,
  validateBBox,
} from "./caption.ts";

describe("validateBBox", () => {
  it("accepts a valid box", () => {
    validateBBox([128, 149, 354, 810]);
    validateBBox([0, 0, 1000, 1000]);
  });

  it("throws on wrong length", () => {
    assertThrows(
      () => validateBBox([1, 2, 3] as unknown as BBox),
      Error,
      "exactly 4",
    );
  });

  it("throws on non-integer", () => {
    assertThrows(
      () => validateBBox([1.5, 2, 3, 4]),
      Error,
      "1.5",
    );
  });

  it("throws on negative", () => {
    assertThrows(() => validateBBox([-1, 2, 3, 4]), Error, "-1");
  });

  it("throws on > 1000", () => {
    assertThrows(() => validateBBox([0, 0, 1001, 5]), Error, "1001");
  });

  it("throws on reversed x", () => {
    assertThrows(
      () => validateBBox([500, 0, 100, 10]),
      Error,
      "x1 must be < x2",
    );
  });

  it("throws on reversed y", () => {
    assertThrows(
      () => validateBBox([0, 500, 10, 100]),
      Error,
      "y1 must be < y2",
    );
  });
});

describe("isHexColor", () => {
  it("accepts #RRGGBB", () => {
    assertEquals(isHexColor("#1E73BE"), true);
    assertEquals(isHexColor("#fdfdfd"), true);
  });

  it("rejects short, named, and unprefixed", () => {
    assertEquals(isHexColor("#abc"), false);
    assertEquals(isHexColor("red"), false);
    assertEquals(isHexColor("1E73BE"), false);
    assertEquals(isHexColor("#1E73B"), false);
    assertEquals(isHexColor("#1E73BEE"), false);
  });
});

describe("buildCaption", () => {
  it("builds the nested structure and defaults type to obj", () => {
    const input: BuildCaptionInput = {
      summary: "A surreal streetwear collage poster",
      style: {
        aesthetics: "Retro magazine cutout style",
        color_palette: ["#1E73BE", "#FDFDFD"],
      },
      background: "A vibrant blue sky",
      objects: [
        { bbox: [128, 149, 354, 810], desc: "Massive 3D puffy letters" },
        {
          bbox: [287, 210, 756, 819],
          desc: "A skateboarder mid-air",
          type: "text",
          color_palette: ["#657C9C"],
        },
      ],
    };

    const caption = buildCaption(input);

    assertEquals(
      caption.high_level_description,
      "A surreal streetwear collage poster",
    );
    assertEquals(
      caption.style_description?.aesthetics,
      "Retro magazine cutout style",
    );
    const deco = caption.compositional_deconstruction;
    assertEquals(deco?.background, "A vibrant blue sky");
    assertEquals(deco?.elements.length, 2);
    assertEquals(deco?.elements[0].type, "obj");
    assertEquals(deco?.elements[1].type, "text");
    assertEquals(deco?.elements[1].color_palette, ["#657C9C"]);
    assertEquals(deco?.elements[0].color_palette, undefined);
  });

  it("throws on a bad bbox", () => {
    assertThrows(
      () =>
        buildCaption({
          summary: "x",
          objects: [{ bbox: [10, 10, 5, 20], desc: "bad" }],
        }),
      Error,
      "x1 must be < x2",
    );
  });

  it("throws on a bad hex color in an element palette", () => {
    assertThrows(
      () =>
        buildCaption({
          summary: "x",
          objects: [{
            bbox: [0, 0, 10, 10],
            desc: "bad",
            color_palette: ["red"],
          }],
        }),
      Error,
      "color_palette",
    );
  });

  it("throws on a bad hex color in the style palette", () => {
    assertThrows(
      () =>
        buildCaption({
          summary: "x",
          style: { color_palette: ["#GGGGGG"] },
        }),
      Error,
      "color_palette",
    );
  });

  it("omits style_description when no style given", () => {
    const caption = buildCaption({ summary: "only summary" });
    assertEquals(caption.style_description, undefined);
  });

  it("omits compositional_deconstruction when no objects and no background", () => {
    const caption = buildCaption({
      summary: "only summary",
      style: { medium: "ink" },
    });
    assertEquals(caption.compositional_deconstruction, undefined);
  });

  it("includes compositional_deconstruction when only a background is given", () => {
    const caption = buildCaption({ summary: "s", background: "sky" });
    assertEquals(caption.compositional_deconstruction?.background, "sky");
    assertEquals(caption.compositional_deconstruction?.elements, []);
  });
});

describe("serializeCaption", () => {
  it("produces parseable JSON that deep-equals the input caption", () => {
    const caption: IdeogramCaption = buildCaption({
      summary: "A surreal streetwear collage poster",
      style: { aesthetics: "Retro", color_palette: ["#1E73BE"] },
      background: "A vibrant blue sky",
      objects: [{ bbox: [128, 149, 354, 810], desc: "letters" }],
    });

    const json = serializeCaption(caption);
    assertEquals(json.includes("\n  "), true);
    const parsed = JSON.parse(json) as IdeogramCaption;
    assertEquals(parsed, caption);
  });
});
