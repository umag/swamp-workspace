/**
 * Property-based tests (fast-check@4.8.0) for comfyui's pure lib helpers and
 * one cross-method flow invariant. Iteration count is FC_NUM_RUNS-gated (small
 * default in CI, large in the nightly `test:soak`).
 *
 * Properties:
 *  - validateBBox's accept-iff predicate (range + ordering).
 *  - repairBBox's sort/degenerate invariant.
 *  - buildCaption -> serializeCaption -> JSON.parse round-trip, with every
 *    output bbox remaining valid.
 *  - patchWorkflow's clone/immutability invariant.
 *  - findNodesByClass's documented numeric-then-lexical sort order.
 *  - chainLoras's chain-length and consumer-wiring invariant.
 *  - isHexColor's #RRGGBB charset (accept iff exactly that shape).
 *  - build_caption -> generate multi-step flow: the caption text POSTed to
 *    ComfyUI is exactly what build_caption serialized (per plan v2's residual
 *    LOW finding, this flow gets the SAME makeTempDir + `finally` cleanup as
 *    the methods/adversarial suites).
 *
 * comfyui.ts and its libs are UNMODIFIED — every property PINS existing
 * behavior.
 */
import fc from "npm:fast-check@4.8.0";
import { GlobalArgs, model } from "./comfyui.ts";
import {
  type BBox,
  buildCaption,
  isHexColor,
  repairBBox,
  serializeCaption,
  validateBBox,
} from "./lib/caption.ts";
import {
  type ApiGraph,
  chainLoras,
  findNodesByClass,
  patchWorkflow,
} from "./lib/workflow_patch.ts";
import promptQueued from "../../fixtures/prompt_queued.json" with {
  type: "json",
};
import historyCompleted from "../../fixtures/history_completed.json" with {
  type: "json",
};

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// (a) validateBBox — accept iff all-integer, in [0,1000], x1<x2, y1<y2
// ---------------------------------------------------------------------------

Deno.test("property: validateBBox does not throw iff [x1,y1,x2,y2] are integers in [0,1000] with x1<x2 and y1<y2", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -5, max: 1005 }),
      fc.integer({ min: -5, max: 1005 }),
      fc.integer({ min: -5, max: 1005 }),
      fc.integer({ min: -5, max: 1005 }),
      (x1, y1, x2, y2) => {
        const inRange = [x1, y1, x2, y2].every((v) => v >= 0 && v <= 1000);
        const expected = inRange && x1 < x2 && y1 < y2;
        let threw = false;
        try {
          validateBBox([x1, y1, x2, y2]);
        } catch {
          threw = true;
        }
        return threw === !expected;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) repairBBox — sorts each axis pair; undefined iff degenerate
// ---------------------------------------------------------------------------

Deno.test("property: repairBBox sorts each axis, and returns undefined iff the sorted box is degenerate (zero width/height)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      (a0, a1, a2, a3) => {
        const y1 = Math.min(a0, a2);
        const y2 = Math.max(a0, a2);
        const x1 = Math.min(a1, a3);
        const x2 = Math.max(a1, a3);
        const result = repairBBox([a0, a1, a2, a3]);
        if (y1 === y2 || x1 === x2) {
          return result === undefined;
        }
        return Array.isArray(result) &&
          result[0] === y1 && result[1] === x1 &&
          result[2] === y2 && result[3] === x2;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) buildCaption -> serializeCaption -> JSON.parse round trip + valid bbox
// ---------------------------------------------------------------------------

const arbBBox: fc.Arbitrary<BBox> = fc.tuple(
  fc.integer({ min: 0, max: 900 }),
  fc.integer({ min: 0, max: 900 }),
  fc.integer({ min: 1, max: 100 }),
  fc.integer({ min: 1, max: 100 }),
).map(([x1, y1, dx, dy]) => [x1, y1, x1 + dx, y1 + dy] as BBox);

const arbHexColor = fc.integer({ min: 0, max: 0xffffff }).map(
  (n) => "#" + n.toString(16).padStart(6, "0"),
);

const arbObjectInput = fc.record({
  bbox: arbBBox,
  desc: fc.string({ maxLength: 30 }),
  type: fc.constantFrom("obj" as const, "text" as const),
  color_palette: fc.option(fc.array(arbHexColor, { maxLength: 3 }), {
    nil: undefined,
  }),
});

Deno.test("property: buildCaption -> serializeCaption -> JSON.parse round-trips, and every output bbox stays valid", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.array(arbObjectInput, { maxLength: 5 }),
      (summary, objects) => {
        const caption = buildCaption({ summary, objects });
        const text = serializeCaption(caption);
        const parsed = JSON.parse(text);
        const roundTrips = JSON.stringify(parsed) === JSON.stringify(caption);
        const elements = caption.compositional_deconstruction?.elements ?? [];
        for (const el of elements) {
          validateBBox(el.bbox); // throws (fails the property) if invalid
        }
        return roundTrips;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) patchWorkflow — immutability: clone + never mutates the input
// ---------------------------------------------------------------------------

const arbGraphWithPatch = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,5}$/),
  fc.record({
    class_type: fc.constant("X"),
    inputs: fc.record({ marker: fc.integer() }),
  }),
  { minKeys: 1, maxKeys: 6 },
).chain((graph) =>
  fc.record({
    graph: fc.constant(graph as ApiGraph),
    nodeId: fc.constantFrom(...Object.keys(graph)),
    newMarker: fc.integer(),
  })
);

Deno.test("property: patchWorkflow never mutates its input and always returns a distinct clone reflecting the patch", () => {
  fc.assert(
    fc.property(arbGraphWithPatch, ({ graph, nodeId, newMarker }) => {
      const before = JSON.stringify(graph);
      const out = patchWorkflow(graph, [{
        nodeId,
        inputs: { marker: newMarker },
      }]);
      const inputUnchanged = JSON.stringify(graph) === before;
      const isClone = out !== graph;
      const patched = (out[nodeId].inputs as { marker: number }).marker ===
        newMarker;
      return inputUnchanged && isClone && patched;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) findNodesByClass — documented numeric-then-lexical sort order
// ---------------------------------------------------------------------------

/** Mirrors workflow_patch.ts's private compareNodeIds documented contract —
 * re-derived here (not imported; it isn't exported) as the property's oracle. */
function referenceCompare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = a.trim() !== "" && Number.isFinite(na);
  const bNum = b.trim() !== "" && Number.isFinite(nb);
  if (aNum && bNum) {
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const arbNodeId = fc.oneof(
  fc.integer({ min: 0, max: 999 }).map(String),
  fc.stringMatching(/^[a-z]{1,4}$/),
);

Deno.test("property: findNodesByClass returns matches in numeric-then-lexical order", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbNodeId, { minLength: 1, maxLength: 8 }),
      (ids) => {
        const graph: ApiGraph = {};
        for (const id of ids) {
          graph[id] = { class_type: "Target", inputs: {} };
        }
        const expected = [...ids].sort(referenceCompare);
        const actual = findNodesByClass(graph, "Target");
        return JSON.stringify(actual) === JSON.stringify(expected);
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (f) chainLoras — chain-length and consumer-wiring invariant
// ---------------------------------------------------------------------------

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

const arbLoraSpec = fc.record({
  name: fc.stringMatching(/^[a-z0-9]{1,8}$/),
  strength: fc.float({ min: 0, max: 2, noNaN: true }),
});

Deno.test("property: chainLoras adds exactly loras.length-1 new nodes and repoints the consumer at the last link", () => {
  fc.assert(
    fc.property(
      fc.array(arbLoraSpec, { minLength: 1, maxLength: 5 }),
      (loras) => {
        const graph = loraGraph();
        const baseKeyCount = Object.keys(graph).length;
        const out = chainLoras(graph, LORA_CFG, loras);
        const expectedKeyCount = baseKeyCount + (loras.length - 1);
        const lastId = loras.length === 1
          ? "loader"
          : `loader:lora${loras.length - 1}`;
        const consumerWired =
          JSON.stringify(out.sw.inputs.on_true) === JSON.stringify([lastId, 0]);
        // Every non-first link's model input chains to the PREVIOUS link.
        let chained = true;
        for (let i = 1; i < loras.length; i++) {
          const id = `loader:lora${i}`;
          const prevId = i === 1 ? "loader" : `loader:lora${i - 1}`;
          if (
            JSON.stringify(out[id].inputs.model) !==
              JSON.stringify([prevId, 0])
          ) {
            chained = false;
          }
        }
        return Object.keys(out).length === expectedKeyCount && consumerWired &&
          chained;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (g) isHexColor — accept iff exactly the #RRGGBB shape
// ---------------------------------------------------------------------------

Deno.test("property: isHexColor accepts every #RRGGBB-shaped string", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[0-9a-fA-F]{6}$/),
      (hex) => isHexColor("#" + hex) === true,
    ),
    FC_RUNS,
  );
});

Deno.test("property: isHexColor rejects any string not exactly matching #RRGGBB", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 12 }).filter((s) => !/^#[0-9a-fA-F]{6}$/.test(s)),
      (s) => isHexColor(s) === false,
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (h) build_caption -> generate multi-step flow invariant
// ---------------------------------------------------------------------------

type Captured = { spec: string; name: string; data: unknown };

function fakeContext(dir: string) {
  const captured: Captured[] = [];
  const globalArgs = GlobalArgs.parse({
    baseUrl: "http://127.0.0.1:8188",
    outputDir: dir,
    pollIntervalMs: 1,
    timeoutMs: 5000,
  });
  const context = {
    globalArgs,
    writeResource: (spec: string, name: string, data: unknown) => {
      captured.push({ spec, name, data });
    },
    extensionFile: (rel: string) =>
      new URL(`../../${rel}`, import.meta.url).pathname,
  };
  return { context, captured };
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

async function withFetchStub(
  routes: Route[],
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pathOf(req: Request): string {
  return new URL(req.url).pathname;
}

Deno.test("property: build_caption -> generate flow — the caption POSTed to ComfyUI is exactly build_caption's serialized text", async () => {
  // Residual LOW (plan v2 review): this flow drives `generate`, which writes
  // an image to outputDir — give it the SAME makeTempDir + `finally` cleanup
  // as the methods/adversarial suites, shared across the whole property run
  // (not leaked per-shrink-iteration).
  const dir = await Deno.makeTempDir();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.array(arbObjectInput, { maxLength: 3 }),
        async (summary, objects) => {
          const { context, captured } = fakeContext(dir);
          const bcArgs = model.methods.build_caption.arguments.parse({
            summary,
            objects,
          });
          await model.methods.build_caption.execute(bcArgs, context);
          const capRes = captured.find((c) => c.spec === "caption");
          const captionText = (capRes!.data as { text: string }).text;

          let postedText: unknown;
          await withFetchStub(
            [
              (req) => {
                if (pathOf(req) !== "/prompt") return undefined;
                return req.text().then((text) => {
                  const body = JSON.parse(text) as {
                    prompt: Record<string, { inputs: Record<string, unknown> }>;
                  };
                  postedText = body.prompt["98:24"].inputs.text;
                  return json(promptQueued);
                });
              },
              (req) =>
                pathOf(req) === "/history/synthetic-prompt-0001"
                  ? json(historyCompleted)
                  : undefined,
              (req) =>
                pathOf(req) === "/view"
                  ? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
                  : undefined,
            ],
            async () => {
              const genArgs = model.methods.generate.arguments.parse({
                template: "ideogram",
                caption: captionText,
              });
              await model.methods.generate.execute(genArgs, context);
            },
          );
          return postedText === captionText;
        },
      ),
      { numRuns: NIGHT(30) },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
