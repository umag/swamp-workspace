import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { describe, it } from "jsr:@std/testing@1/bdd";
import {
  type ApiGraph,
  applyIdeogramOverrides,
  chainLoras,
  findNodesByClass,
  findNodesByTitle,
  patchWorkflow,
} from "./workflow_patch.ts";

/** A minimal Krea-like model chain: UNET → lora loader → switch. */
function loraGraph(): ApiGraph {
  return {
    unet: {
      class_type: "UNETLoader",
      inputs: { unet_name: "base.safetensors" },
    },
    loader: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        lora_name: "baked.safetensors",
        strength_model: 0.8,
        model: ["unet", 0],
      },
    },
    sw: {
      class_type: "ComfySwitchNode",
      inputs: {
        switch: ["b", 0],
        on_false: ["unet", 0],
        on_true: ["loader", 0],
      },
    },
  };
}

const LORA_CFG = {
  loaderNodeId: "loader",
  nameKey: "lora_name",
  strengthKey: "strength_model",
  modelKey: "model",
  consumerNodeId: "sw",
  consumerKey: "on_true",
};

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
    assertEquals(findNodesByClass(sampleGraph(), "CLIPTextEncode"), [
      "9",
      "24",
    ]);
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
    const out = patchWorkflow(graph, [{
      nodeId: "24",
      inputs: { text: "new" },
    }]);
    assertEquals(out["24"].inputs.text, "new");
    assertEquals(out["24"].inputs.clip, ["14", 0]);
  });

  it("returns a clone and does not mutate the original", () => {
    const graph = sampleGraph();
    const out = patchWorkflow(graph, [{
      nodeId: "18",
      inputs: { noise_seed: 999 },
    }]);
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

describe("chainLoras", () => {
  it("sets a single lora on the existing loader (appends .safetensors)", () => {
    const out = chainLoras(loraGraph(), LORA_CFG, [
      { name: "krea2_darkbrush", strength: 1.0 },
    ]);
    assertEquals(out.loader.inputs.lora_name, "krea2_darkbrush.safetensors");
    assertEquals(out.loader.inputs.strength_model, 1.0);
    // First link still reads the base UNET; consumer still points at it.
    assertEquals(out.loader.inputs.model, ["unet", 0]);
    assertEquals(out.sw.inputs.on_true, ["loader", 0]);
    // No extra nodes were added.
    assertEquals(Object.keys(out).sort(), ["loader", "sw", "unet"]);
  });

  it("chains multiple loras and repoints the consumer at the last", () => {
    const out = chainLoras(loraGraph(), LORA_CFG, [
      { name: "a", strength: 1.0 },
      { name: "b.safetensors", strength: 0.5 },
      { name: "c", strength: 0.7 },
    ]);
    // First reuses `loader` reading the base UNET.
    assertEquals(out.loader.inputs.lora_name, "a.safetensors");
    assertEquals(out.loader.inputs.model, ["unet", 0]);
    // Second and third are new nodes chained to the previous.
    assertEquals(out["loader:lora1"].inputs.lora_name, "b.safetensors");
    assertEquals(out["loader:lora1"].inputs.strength_model, 0.5);
    assertEquals(out["loader:lora1"].inputs.model, ["loader", 0]);
    assertEquals(out["loader:lora2"].inputs.lora_name, "c.safetensors");
    assertEquals(out["loader:lora2"].inputs.model, ["loader:lora1", 0]);
    // The switch now consumes the last link in the chain.
    assertEquals(out.sw.inputs.on_true, ["loader:lora2", 0]);
  });

  it("does not mutate the input and no-ops on an empty list", () => {
    const graph = loraGraph();
    const out = chainLoras(graph, LORA_CFG, []);
    assertEquals(out, graph);
    if (out === graph) throw new Error("expected a clone even when empty");
    // A non-empty call must not touch the original.
    chainLoras(graph, LORA_CFG, [{ name: "x", strength: 1 }]);
    assertEquals(graph.loader.inputs.lora_name, "baked.safetensors");
  });

  it("throws when the loader or consumer node is missing", () => {
    assertThrows(
      () =>
        chainLoras(loraGraph(), { ...LORA_CFG, loaderNodeId: "nope" }, [
          { name: "a", strength: 1 },
        ]),
      Error,
      "loader node 'nope'",
    );
    assertThrows(
      () =>
        chainLoras(loraGraph(), { ...LORA_CFG, consumerNodeId: "nope" }, [
          { name: "a", strength: 1 },
        ]),
      Error,
      "consumer node 'nope'",
    );
  });
});
