import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { describe, it } from "jsr:@std/testing@1/bdd";
import {
  type ApiGraph,
  applyIdeogramOverrides,
  findNodesByClass,
  findNodesByTitle,
  patchWorkflow,
} from "./workflow_patch.ts";

function sampleGraph(): ApiGraph {
  return {
    "24": {
      class_type: "CLIPTextEncode",
      inputs: { text: "old caption", clip: ["14", 0] },
      _meta: { title: "Positive" },
    },
    "9": {
      class_type: "CLIPTextEncode",
      inputs: { text: "negative", clip: ["14", 0] },
      _meta: { title: "Negative" },
    },
    "18": {
      class_type: "RandomNoise",
      inputs: { noise_seed: 12345 },
      _meta: { title: "Noise" },
    },
    "37": {
      class_type: "ResolutionSelector",
      inputs: { aspect_ratio: "1:1 (Square)" },
    },
  };
}

describe("findNodesByClass", () => {
  it("returns matching ids in numeric-then-lexical order", () => {
    assertEquals(findNodesByClass(sampleGraph(), "CLIPTextEncode"), ["9", "24"]);
  });

  it("returns a single match", () => {
    assertEquals(findNodesByClass(sampleGraph(), "RandomNoise"), ["18"]);
  });

  it("returns [] when none match", () => {
    assertEquals(findNodesByClass(sampleGraph(), "Nope"), []);
  });
});

describe("findNodesByTitle", () => {
  it("matches _meta.title exactly", () => {
    assertEquals(findNodesByTitle(sampleGraph(), "Positive"), ["24"]);
    assertEquals(findNodesByTitle(sampleGraph(), "Noise"), ["18"]);
  });

  it("returns [] when absent (including nodes with no _meta)", () => {
    assertEquals(findNodesByTitle(sampleGraph(), "Missing"), []);
  });
});

describe("patchWorkflow", () => {
  it("merges inputs and leaves other inputs intact", () => {
    const graph = sampleGraph();
    const out = patchWorkflow(graph, [{ nodeId: "24", inputs: { text: "new" } }]);
    assertEquals(out["24"].inputs.text, "new");
    assertEquals(out["24"].inputs.clip, ["14", 0]);
  });

  it("returns a clone and does not mutate the original", () => {
    const graph = sampleGraph();
    const out = patchWorkflow(graph, [{ nodeId: "18", inputs: { noise_seed: 999 } }]);
    assertEquals(graph["18"].inputs.noise_seed, 12345);
    assertEquals(out["18"].inputs.noise_seed, 999);
    if (out === graph) throw new Error("expected a new graph object");
  });

  it("throws on missing node", () => {
    const graph = sampleGraph();
    assertThrows(
      () => patchWorkflow(graph, [{ nodeId: "404", inputs: {} }]),
      Error,
      "node '404' not found in workflow",
    );
  });
});

describe("applyIdeogramOverrides", () => {
  it("sets caption / seed / resolution on the named nodes", () => {
    const graph = sampleGraph();
    const out = applyIdeogramOverrides(graph, {
      caption: "hello",
      captionNodeId: "24",
      seed: 777,
      seedNodeId: "18",
      resolution: "9:16 (Portrait Widescreen)",
      resolutionNodeId: "37",
    });
    assertEquals(out["24"].inputs.text, "hello");
    assertEquals(out["18"].inputs.noise_seed, 777);
    assertEquals(out["37"].inputs.aspect_ratio, "9:16 (Portrait Widescreen)");
    // original untouched
    assertEquals(graph["24"].inputs.text, "old caption");
  });

  it("honors custom input keys", () => {
    const graph: ApiGraph = {
      "1": { class_type: "X", inputs: { prompt: "a" } },
    };
    const out = applyIdeogramOverrides(graph, {
      caption: "b",
      captionNodeId: "1",
      captionInputKey: "prompt",
    });
    assertEquals(out["1"].inputs.prompt, "b");
  });

  it("throws when a value is given without its node id", () => {
    const graph = sampleGraph();
    assertThrows(
      () => applyIdeogramOverrides(graph, { caption: "x" }),
      Error,
      "captionNodeId",
    );
    assertThrows(
      () => applyIdeogramOverrides(graph, { seed: 1 }),
      Error,
      "seedNodeId",
    );
    assertThrows(
      () => applyIdeogramOverrides(graph, { resolution: "1:1" }),
      Error,
      "resolutionNodeId",
    );
  });

  it("ignores undefined fields and is a no-op when empty", () => {
    const graph = sampleGraph();
    const out = applyIdeogramOverrides(graph, {});
    assertEquals(out, graph);
    if (out === graph) throw new Error("expected a clone even when empty");
  });
});
