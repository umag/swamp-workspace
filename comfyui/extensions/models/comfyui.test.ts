import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { describe, it } from "jsr:@std/testing@1/bdd";
import { stub } from "jsr:@std/testing@1/mock";
import { GlobalArgs, model } from "./comfyui.ts";

// Host-authored gate for the instance-model leaf (the leaf writes only comfyui.ts).
// Exercises the real model methods against the already-built libs, stubbing fetch.

type Captured = { spec: string; name: string; data: unknown };

function fakeContext(overrides: Record<string, unknown> = {}) {
  const captured: Captured[] = [];
  const globalArgs = GlobalArgs.parse({
    baseUrl: "http://comfy.test:8081",
    ...overrides,
  });
  const context = {
    globalArgs,
    writeResource: (spec: string, name: string, data: unknown) => {
      captured.push({ spec, name, data });
    },
  };
  return { context, captured };
}

describe("@magistr/comfyui/instance model", () => {
  it("declares its type, version, and the four methods", () => {
    assertEquals(model.type, "@magistr/comfyui/instance");
    assertExists(model.version);
    const methods = model.methods as Record<string, unknown>;
    for (const m of ["lookup", "sync", "build_caption", "generate"]) {
      assertExists(methods[m]);
    }
  });

  it("build_caption stores a round-tripping serialized caption", async () => {
    const { context, captured } = fakeContext();
    const args = model.methods.build_caption.arguments.parse({
      summary: "a red cat on a blue sofa",
      style: { medium: "photo", color_palette: ["#1E73BE", "#C82A2A"] },
      background: "a softly lit living room",
      objects: [
        {
          bbox: [40, 60, 520, 880],
          desc: "a ginger cat",
          color_palette: ["#DCA57D"],
        },
        { bbox: [0, 700, 1000, 1000], desc: "a navy blue sofa" },
      ],
    });
    await model.methods.build_caption.execute(args, context);
    assertEquals(captured.length, 1);
    assertEquals(captured[0].spec, "caption");
    const data = captured[0].data as { caption: unknown; text: string };
    assertExists(data.caption);
    assertEquals(JSON.parse(data.text), data.caption);
  });

  it("build_caption rejects a reversed bbox", async () => {
    const { context } = fakeContext();
    const args = model.methods.build_caption.arguments.parse({
      summary: "broken",
      objects: [{ bbox: [900, 900, 100, 100], desc: "inverted" }],
    });
    await assertRejects(() =>
      model.methods.build_caption.execute(args, context)
    );
  });

  it("lookup snapshots the server version", async () => {
    const { context, captured } = fakeContext();
    const f = stub(
      globalThis,
      "fetch",
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              system: { comfyui_version: "0.24.0" },
              devices: [],
            }),
            { status: 200 },
          ),
        ),
    );
    try {
      await model.methods.lookup.execute({}, context);
    } finally {
      f.restore();
    }
    const server = captured.find((c) => c.spec === "server");
    assertExists(server);
    assertEquals(
      (server.data as { comfyuiVersion: string }).comfyuiVersion,
      "0.24.0",
    );
  });

  it("generate patches, queues, fetches the image, and records the generation", async () => {
    const dir = await Deno.makeTempDir();
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    const f = stub(
      globalThis,
      "fetch",
      (input: string | URL | Request, _init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url;
        if (url.endsWith("/prompt")) {
          return Promise.resolve(
            new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200 }),
          );
        }
        if (url.includes("/history/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                p1: {
                  status: { completed: true },
                  outputs: {
                    "9": {
                      images: [{
                        filename: "out.png",
                        subfolder: "",
                        type: "output",
                      }],
                    },
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
        );
      },
    );
    try {
      const args = model.methods.generate.arguments.parse({
        caption: '{"high_level_description":"x"}',
        captionNodeId: "24",
        seed: 12345,
        seedNodeId: "18",
        resolution: "2560x1440 (16:9)",
        resolutionNodeId: "37",
        workflow: {
          "24": { class_type: "CLIPTextEncode", inputs: { text: "" } },
          "18": { class_type: "RandomNoise", inputs: { noise_seed: 0 } },
          "37": {
            class_type: "ResolutionSelector",
            inputs: { aspect_ratio: "" },
          },
        },
      });
      await model.methods.generate.execute(args, context);
    } finally {
      f.restore();
    }
    const gen = captured.find((c) => c.spec === "generation");
    assertExists(gen);
    const g = gen.data as { promptId: string; paths: string[] };
    assertEquals(g.promptId, "p1");
    assertEquals(g.paths.length, 1);
    const bytes = await Deno.readFile(g.paths[0]);
    assertEquals(bytes.length, 4);
    await Deno.remove(dir, { recursive: true });
  });

  it("generate_caption asks Claude and stores a validated caption", async () => {
    const { context, captured } = fakeContext({ anthropicApiKey: "sk-test" });
    const minified = JSON.stringify({
      aspect_ratio: "9:16",
      high_level_description: "a neon cat on a rooftop",
      compositional_deconstruction: {
        background: "rainy skyline",
        elements: [{
          type: "obj",
          bbox: [200, 100, 800, 500],
          desc: "a neon cat",
        }],
      },
    });
    let sentToAnthropic = false;
    const f = stub(globalThis, "fetch", (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      if (url.includes("api.anthropic.com")) {
        sentToAnthropic = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({ content: [{ type: "text", text: minified }] }),
            {
              status: 200,
            },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    try {
      const args = model.methods.generate_caption.arguments.parse({
        idea: "a neon cat",
        aspectRatio: "9:16",
      });
      await model.methods.generate_caption.execute(args, context);
    } finally {
      f.restore();
    }
    assertEquals(sentToAnthropic, true);
    const cap = captured.find((c) => c.spec === "caption");
    assertExists(cap);
    const data = cap.data as {
      caption: { aspect_ratio: string };
      text: string;
    };
    assertEquals(data.caption.aspect_ratio, "9:16");
    assertEquals(
      JSON.parse(data.text).high_level_description,
      "a neon cat on a rooftop",
    );
  });
});
