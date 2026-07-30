/**
 * Contract-fixture suite (asset gap): pins the two BUNDLED workflow assets
 * (`workflows/ideogram.api.json`, `workflows/krea.api.json`) and the code path
 * that reads them — the one gap the pre-existing lib contract-fixture files
 * (comfy_client.test.ts, workflow_patch.test.ts, etc.) don't cover, since none
 * of them ever import the bundled JSON.
 *
 * Two things are pinned:
 *  1. The UI-vs-API-format gotcha, structurally: ComfyUI workflow JSON comes
 *     in two incompatible shapes — the graph-editor "UI format"
 *     (`{"nodes":[...],"links":[...]}`) and the "API format" the `/prompt`
 *     endpoint actually consumes (a flat `{"<id>":{"class_type",
 *     "inputs"}}` map). `loadGraphAndTemplate` in comfyui.ts only ever reads
 *     these two bundled files, so if a future re-export from the ComfyUI UI
 *     silently replaces one with UI format, this test must fail loudly.
 *  2. Every `TEMPLATES` entry's node id + input key (hardcoded here to match
 *     comfyui.ts's private `TEMPLATES` map, which is not exported) actually
 *     resolves inside the corresponding bundled graph, with the expected
 *     `class_type` and the expected input key present.
 *
 * comfyui.ts, its libs, and the bundled workflow JSON are BYTE-FROZEN by this
 * change — this file only reads them, never modifies them.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import ideogramGraph from "../../workflows/ideogram.api.json" with {
  type: "json",
};
import kreaGraph from "../../workflows/krea.api.json" with { type: "json" };

import systemStats from "../../fixtures/system_stats.json" with {
  type: "json",
};
import promptQueued from "../../fixtures/prompt_queued.json" with {
  type: "json",
};
import promptNodeErrors from "../../fixtures/prompt_node_errors.json" with {
  type: "json",
};
import historyCompleted from "../../fixtures/history_completed.json" with {
  type: "json",
};
import objectInfoResolution from "../../fixtures/object_info_resolution.json" with {
  type: "json",
};
import generatedCaption from "../../fixtures/generated_caption.json" with {
  type: "json",
};

type RawGraph = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 1. Structural API-format pin (the UI-vs-API-format gotcha)
// ---------------------------------------------------------------------------

function assertIsApiFormatGraph(graph: RawGraph, label: string) {
  // Negative: API-format graphs have NO top-level `nodes`/`links` keys — that
  // shape belongs to the UI-format graph-editor export.
  assert(
    !("nodes" in graph),
    `${label}: has a top-level "nodes" key — looks like UI format, not API format`,
  );
  assert(
    !("links" in graph),
    `${label}: has a top-level "links" key — looks like UI format, not API format`,
  );
  assert(Object.keys(graph).length > 0, `${label}: graph must not be empty`);

  for (const [nodeId, rawNode] of Object.entries(graph)) {
    assert(
      typeof rawNode === "object" && rawNode !== null &&
        !Array.isArray(rawNode),
      `${label}: node '${nodeId}' must be an object, got ${typeof rawNode}`,
    );
    const node = rawNode as Record<string, unknown>;
    assert(
      typeof node.class_type === "string" && node.class_type.length > 0,
      `${label}: node '${nodeId}'.class_type must be a non-empty string`,
    );
    assert(
      typeof node.inputs === "object" && node.inputs !== null &&
        !Array.isArray(node.inputs),
      `${label}: node '${nodeId}'.inputs must be an object`,
    );
  }
}

Deno.test("ideogram.api.json is a well-formed API-format graph (not UI format)", () => {
  assertIsApiFormatGraph(ideogramGraph as RawGraph, "ideogram.api.json");
});

Deno.test("krea.api.json is a well-formed API-format graph (not UI format)", () => {
  assertIsApiFormatGraph(kreaGraph as RawGraph, "krea.api.json");
});

// ---------------------------------------------------------------------------
// 2. TEMPLATES node-id / input-key wiring — mirrors comfyui.ts's private
//    TEMPLATES map (not exported, so re-declared here as the expected pin).
// ---------------------------------------------------------------------------

function inputsOf(graph: RawGraph, nodeId: string): Record<string, unknown> {
  const node = graph[nodeId] as
    | { class_type?: unknown; inputs?: Record<string, unknown> }
    | undefined;
  assert(node !== undefined, `expected node '${nodeId}' to exist in graph`);
  return node.inputs ?? {};
}

function classTypeOf(graph: RawGraph, nodeId: string): unknown {
  const node = graph[nodeId] as { class_type?: unknown } | undefined;
  assert(node !== undefined, `expected node '${nodeId}' to exist in graph`);
  return node.class_type;
}

Deno.test("ideogram template: caption node 98:24 is a CLIPTextEncode with a 'text' input", () => {
  const graph = ideogramGraph as RawGraph;
  assertEquals(classTypeOf(graph, "98:24"), "CLIPTextEncode");
  assert("text" in inputsOf(graph, "98:24"));
});

Deno.test("ideogram template: seed node 98:18 is a RandomNoise with a 'noise_seed' input", () => {
  const graph = ideogramGraph as RawGraph;
  assertEquals(classTypeOf(graph, "98:18"), "RandomNoise");
  assert("noise_seed" in inputsOf(graph, "98:18"));
});

Deno.test("ideogram template: resolution node 37 is a ResolutionSelector with an 'aspect_ratio' input", () => {
  const graph = ideogramGraph as RawGraph;
  assertEquals(classTypeOf(graph, "37"), "ResolutionSelector");
  assert("aspect_ratio" in inputsOf(graph, "37"));
});

Deno.test("krea template: caption node 30:6 is a CLIPTextEncode with a 'text' input", () => {
  const graph = kreaGraph as RawGraph;
  assertEquals(classTypeOf(graph, "30:6"), "CLIPTextEncode");
  assert("text" in inputsOf(graph, "30:6"));
});

Deno.test("krea template: seed node 30:3 is a KSampler with a 'seed' input", () => {
  const graph = kreaGraph as RawGraph;
  assertEquals(classTypeOf(graph, "30:3"), "KSampler");
  assert("seed" in inputsOf(graph, "30:3"));
});

Deno.test("krea template: resolution node 49 is a ResolutionSelector with an 'aspect_ratio' input", () => {
  const graph = kreaGraph as RawGraph;
  assertEquals(classTypeOf(graph, "49"), "ResolutionSelector");
  assert("aspect_ratio" in inputsOf(graph, "49"));
});

Deno.test("krea template: lora loader 30:15 has 'lora_name'/'strength_model'/'model' inputs", () => {
  const graph = kreaGraph as RawGraph;
  assertEquals(classTypeOf(graph, "30:15"), "LoraLoaderModelOnly");
  const inputs = inputsOf(graph, "30:15");
  assert("lora_name" in inputs);
  assert("strength_model" in inputs);
  assert("model" in inputs);
});

Deno.test("krea template: lora consumer 30:22 is a switch with an 'on_true' input", () => {
  const graph = kreaGraph as RawGraph;
  assertEquals(classTypeOf(graph, "30:22"), "ComfySwitchNode");
  assert("on_true" in inputsOf(graph, "30:22"));
});

Deno.test("krea template: lora enable node 30:23 is a boolean primitive with a 'value' input", () => {
  const graph = kreaGraph as RawGraph;
  assertEquals(classTypeOf(graph, "30:23"), "PrimitiveBoolean");
  assert("value" in inputsOf(graph, "30:23"));
  // Documented default: LoRA is OFF unless generate's applyContentOverrides
  // flips it — pin the bundled default so a template edit can't silently
  // enable the LoRA chain by default.
  assertEquals(inputsOf(graph, "30:23").value, false);
});

// ---------------------------------------------------------------------------
// 3. Decode-pin the synthetic wire fixtures — every fixture parses to the
//    shape the corresponding endpoint/contract documents.
// ---------------------------------------------------------------------------

Deno.test("fixture: system_stats.json decodes to the /system_stats shape snapshotServer reads", () => {
  const data = systemStats as {
    system?: { comfyui_version?: string };
    devices?: unknown[];
  };
  assertEquals(data.system?.comfyui_version, "0.0.0-synthetic");
  assert(Array.isArray(data.devices));
});

Deno.test("fixture: prompt_queued.json decodes to the /prompt success shape queuePrompt reads", () => {
  const data = promptQueued as { prompt_id?: string; node_errors?: unknown };
  assertEquals(data.prompt_id, "synthetic-prompt-0001");
  assertEquals(data.node_errors, {});
});

Deno.test("fixture: prompt_node_errors.json decodes to the /prompt 400 validation-error shape", () => {
  const data = promptNodeErrors as {
    error?: { type?: string };
    node_errors?: Record<string, { errors?: unknown[] }>;
  };
  assertEquals(data.error?.type, "prompt_outputs_failed_validation");
  const nodeErr = data.node_errors?.["98:24"];
  assert(nodeErr !== undefined);
  assert(Array.isArray(nodeErr.errors) && nodeErr.errors.length > 0);
});

Deno.test("fixture: history_completed.json decodes to a completed /history entry with image REFS only", () => {
  const data = historyCompleted as Record<string, {
    status?: { completed?: boolean };
    outputs?: Record<string, { images?: unknown[] }>;
  }>;
  const entry = data["synthetic-prompt-0001"];
  assert(entry !== undefined);
  assertEquals(entry.status?.completed, true);
  const images = entry.outputs?.["158"]?.images;
  assert(Array.isArray(images) && images.length === 1);
  const img = images[0] as { filename?: string; subfolder?: string };
  assertEquals(img.filename, "sample.png");
  assertEquals(img.subfolder, "");
  // No real image bytes anywhere in this fixture — refs only.
  assertEquals(JSON.stringify(data).includes("data:image"), false);
});

Deno.test("fixture: object_info_resolution.json decodes to the /object_info combo-value shape", () => {
  const data = objectInfoResolution as Record<string, {
    input?: { required?: { aspect_ratio?: unknown[] } };
  }>;
  const combos = data.ResolutionSelector?.input?.required?.aspect_ratio?.[0];
  assert(Array.isArray(combos));
  assert((combos as string[]).includes("9:16 (Portrait Widescreen)"));
});

Deno.test("fixture: generated_caption.json decodes to a valid Ideogram-4 magic-prompt caption", () => {
  const data = generatedCaption as {
    aspect_ratio?: string;
    high_level_description?: string;
    compositional_deconstruction?: { elements?: unknown[] };
  };
  assertEquals(data.aspect_ratio, "9:16");
  assert(typeof data.high_level_description === "string");
  assert(Array.isArray(data.compositional_deconstruction?.elements));
});
