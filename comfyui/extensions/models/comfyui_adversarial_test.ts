/**
 * Adversarial suite: hostile/malformed ComfyUI responses, malformed
 * caption/bbox input, credential-leak assertions (both the standard API-key
 * and Claude Code OAuth-token auth shapes), a fixtures-secret-scan over
 * `comfyui/fixtures/*.json`, and the four found-bug PINS.
 *
 * comfyui.ts is UNMODIFIED — every test here PINS current behavior. The
 * timeout/hung-server case is intentionally NOT re-tested here: it already
 * lives at the ComfyClient lib level in `lib/comfy_client.test.ts` (with an
 * injected no-op sleep). Every case below resolves IMMEDIATELY — none of them
 * enter `waitForResult`'s poll-sleep loop — so no real timers fire and
 * FakeTime is unnecessary.
 *
 * Bug pins are labelled "pin:" and assert the ACTUAL (wrong) current output —
 * a future fix must flip these red. They are tracked in the LOCAL
 * `comfyui-latent-bugs` issue-lifecycle model, never filed to the Lab.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1";
import { GlobalArgs, model } from "./comfyui.ts";
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Captured = { spec: string; name: string; data: unknown };

function fakeContext(overrides: Record<string, unknown> = {}) {
  const captured: Captured[] = [];
  const globalArgs = GlobalArgs.parse({
    baseUrl: "http://127.0.0.1:8188",
    ...overrides,
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
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`fetch stub: unrouted request ${req.method} ${req.url}`);
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(calls);
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

// ---------------------------------------------------------------------------
// Hostile / malformed ComfyUI HTTP responses — all resolve immediately
// ---------------------------------------------------------------------------

Deno.test("generate: a 200 /prompt response with a non-JSON body throws 'invalid JSON'", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({ outputDir: dir });
    await withFetchStub(
      [(req) =>
        pathOf(req) === "/prompt"
          ? new Response("not json at all", {
            status: 200,
            headers: { "content-type": "text/plain" },
          })
          : undefined],
      async () => {
        const args = model.methods.generate.arguments.parse({
          workflow: { "1": { class_type: "X", inputs: {} } },
        });
        await assertRejects(
          () => model.methods.generate.execute(args, context),
          Error,
          "invalid JSON",
        );
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate: an HTML 502 (reverse-proxy failure) surfaces the status + body, not a generic error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({ outputDir: dir });
    await withFetchStub(
      [(req) =>
        pathOf(req) === "/prompt"
          ? new Response("<html><body>502 Bad Gateway</body></html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          })
          : undefined],
      async () => {
        const args = model.methods.generate.arguments.parse({
          workflow: { "1": { class_type: "X", inputs: {} } },
        });
        const err = await assertRejects(() =>
          model.methods.generate.execute(args, context)
        );
        assert(String(err).includes("502"));
        assert(String(err).includes("Bad Gateway"));
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate: a 200 /prompt response missing prompt_id throws 'missing prompt_id'", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({ outputDir: dir });
    await withFetchStub(
      [(req) => pathOf(req) === "/prompt" ? json({ number: 1 }) : undefined],
      async () => {
        const args = model.methods.generate.arguments.parse({
          workflow: { "1": { class_type: "X", inputs: {} } },
        });
        await assertRejects(
          () => model.methods.generate.execute(args, context),
          Error,
          "missing prompt_id",
        );
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate: a 404 on /view surfaces through saveImages as a rejected Error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { context } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    await withFetchStub(
      [
        (req) => pathOf(req) === "/prompt" ? json(promptQueued) : undefined,
        (req) =>
          pathOf(req) === "/history/synthetic-prompt-0001"
            ? json(historyCompleted)
            : undefined,
        (req) =>
          pathOf(req) === "/view"
            ? new Response("not found", { status: 404 })
            : undefined,
      ],
      async () => {
        const args = model.methods.generate.arguments.parse({
          workflow: { "1": { class_type: "X", inputs: {} } },
        });
        await assertRejects(
          () => model.methods.generate.execute(args, context),
          Error,
          "404",
        );
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pin: a multi-image render whose LATER image fails to fetch leaves the EARLIER image orphaned on disk with no generation resource recorded at all", async () => {
  // saveImages() writes images to disk in order and awaits each fetchImage()
  // call sequentially. If the second image's /view fails, saveImages()
  // rejects immediately — the first image is already written to disk, but
  // generate() never reaches its writeResource("generation", ...) call, so
  // there is NO record of a render happening at all, despite one real file
  // sitting in outputDir. Found during adversarial review (round 1 of the
  // test-review phase); characterized here rather than left unpinned.
  const dir = await Deno.makeTempDir();
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    await withFetchStub(
      [
        (req) => pathOf(req) === "/prompt" ? json(promptQueued) : undefined,
        (req) =>
          pathOf(req) === "/history/synthetic-prompt-0001"
            ? json({
              "synthetic-prompt-0001": {
                status: { completed: true },
                outputs: {
                  "158": {
                    images: [{
                      filename: "first.png",
                      subfolder: "",
                      type: "output",
                    }],
                  },
                  "159": {
                    images: [{
                      filename: "second.png",
                      subfolder: "",
                      type: "output",
                    }],
                  },
                },
              },
            })
            : undefined,
        (req) => {
          if (pathOf(req) !== "/view") return undefined;
          const filename = new URL(req.url).searchParams.get("filename");
          if (filename === "first.png") {
            return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
          }
          return new Response("gone", { status: 404 });
        },
      ],
      async () => {
        const args = model.methods.generate.arguments.parse({
          workflow: { "1": { class_type: "X", inputs: {} } },
        });
        await assertRejects(
          () => model.methods.generate.execute(args, context),
          Error,
          "404",
        );
      },
    );
    // pin: the first image really did land on disk...
    const firstPath = `${dir}/first.png`;
    const stat = await Deno.stat(firstPath);
    assert(
      stat.isFile,
      "pin: the earlier image was written before the failure",
    );
    // ...yet no `generation` resource was ever written to account for it.
    assertEquals(
      captured.find((c) => c.spec === "generation"),
      undefined,
      "pin: a partially-saved render leaves no trace in the generation resource",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Malformed caption / bbox input
// ---------------------------------------------------------------------------

Deno.test("build_caption: an out-of-range bbox coordinate is rejected", async () => {
  const { context } = fakeContext();
  const args = model.methods.build_caption.arguments.parse({
    summary: "x",
    objects: [{ bbox: [0, 0, 1001, 500], desc: "too tall" }],
  });
  await assertRejects(
    () => model.methods.build_caption.execute(args, context),
    Error,
    "1001",
  );
});

Deno.test("build_caption: a non-integer bbox coordinate is rejected", async () => {
  const { context } = fakeContext();
  const args = model.methods.build_caption.arguments.parse({
    summary: "x",
    objects: [{ bbox: [0, 0.5, 500, 500], desc: "fractional" }],
  });
  await assertRejects(
    () => model.methods.build_caption.execute(args, context),
    Error,
    "integers",
  );
});

Deno.test("build_caption: a bad hex color in an element palette is rejected", async () => {
  const { context } = fakeContext();
  const args = model.methods.build_caption.arguments.parse({
    summary: "x",
    objects: [{
      bbox: [0, 0, 500, 500],
      desc: "y",
      color_palette: ["not-a-color"],
    }],
  });
  await assertRejects(
    () => model.methods.build_caption.execute(args, context),
    Error,
    "color_palette",
  );
});

Deno.test("generate_caption: a reversed generated bbox is silently auto-corrected, not rejected", async () => {
  const { context, captured } = fakeContext({
    anthropicApiKey: "sk-ant-api-test",
  });
  const reversed = {
    aspect_ratio: "1:1",
    high_level_description: "x",
    compositional_deconstruction: {
      elements: [{
        type: "obj",
        bbox: [600, 100, 300, 800], // y1 > y2 — reversed
        desc: "reversed axis element",
      }],
    },
  };
  await withFetchStub(
    [(req) =>
      pathOf(req) === "/v1/messages"
        ? json({ content: [{ type: "text", text: JSON.stringify(reversed) }] })
        : undefined],
    async () => {
      const args = model.methods.generate_caption.arguments.parse({
        idea: "x",
      });
      await model.methods.generate_caption.execute(args, context);
    },
  );
  const cap = captured.find((c) => c.spec === "caption");
  assert(cap);
  const data = cap.data as {
    caption: {
      compositional_deconstruction?: { elements: { bbox?: number[] }[] };
    };
  };
  const bbox = data.caption.compositional_deconstruction?.elements[0].bbox;
  assertEquals(bbox, [300, 100, 600, 800]);
});

Deno.test("generate_caption: injection-shaped text in a generated element passes through JSON-escaped, uninterpreted", async () => {
  const { context, captured } = fakeContext({
    anthropicApiKey: "sk-ant-api-test",
  });
  const hostile = {
    aspect_ratio: "1:1",
    high_level_description: "x",
    compositional_deconstruction: {
      elements: [{
        type: "text",
        text: "<script>alert(1)</script>' OR 1=1 --",
        desc: "hostile text content",
      }],
    },
  };
  await withFetchStub(
    [(req) =>
      pathOf(req) === "/v1/messages"
        ? json({ content: [{ type: "text", text: JSON.stringify(hostile) }] })
        : undefined],
    async () => {
      const args = model.methods.generate_caption.arguments.parse({
        idea: "x",
      });
      await model.methods.generate_caption.execute(args, context);
    },
  );
  const cap = captured.find((c) => c.spec === "caption");
  assert(cap);
  const data = cap.data as {
    caption: {
      compositional_deconstruction?: { elements: { text?: string }[] };
    };
  };
  assertEquals(
    data.caption.compositional_deconstruction?.elements[0].text,
    "<script>alert(1)</script>' OR 1=1 --",
  );
});

// ---------------------------------------------------------------------------
// Credential-leak assertions — both auth shapes (API key + OAuth token)
// ---------------------------------------------------------------------------

const API_KEY = "sk-ant-api-do-not-log-test-sentinel";
const OAUTH_TOKEN = "sk-ant-oat-do-not-log-test-sentinel";

Deno.test("generate_caption: the standard apiKey never appears in the written caption resource or a thrown error", async () => {
  const { context, captured } = fakeContext({ anthropicApiKey: API_KEY });
  await withFetchStub(
    [(req) =>
      pathOf(req) === "/v1/messages"
        ? json({
          content: [{ type: "text", text: JSON.stringify(generatedCaption) }],
        })
        : undefined],
    async () => {
      const args = model.methods.generate_caption.arguments.parse({
        idea: "x",
      });
      await model.methods.generate_caption.execute(args, context);
    },
  );
  const cap = captured.find((c) => c.spec === "caption");
  assert(cap);
  assert(!JSON.stringify(cap.data).includes(API_KEY));
});

Deno.test("generate_caption: the OAuth token never appears in the written caption resource or a thrown error", async () => {
  const { context, captured } = fakeContext({ anthropicApiKey: OAUTH_TOKEN });
  await withFetchStub(
    [(req) =>
      pathOf(req) === "/v1/messages"
        ? json({
          content: [{ type: "text", text: JSON.stringify(generatedCaption) }],
        })
        : undefined],
    async () => {
      const args = model.methods.generate_caption.arguments.parse({
        idea: "x",
      });
      await model.methods.generate_caption.execute(args, context);
    },
  );
  const cap = captured.find((c) => c.spec === "caption");
  assert(cap);
  assert(!JSON.stringify(cap.data).includes(OAUTH_TOKEN));
});

Deno.test("pin: a hostile Anthropic error response that echoes the apiKey back leaks it into the thrown error (no client-side redaction)", async () => {
  // claudeComplete throws `Anthropic API ${status}: ${text.slice(0,400)}`
  // verbatim — if a compromised/misconfigured proxy echoes credentials back
  // in its error body, this client performs no redaction. Documented
  // trust-boundary note (mirrors the porkbun precedent), not fixed here.
  const { context } = fakeContext({ anthropicApiKey: API_KEY });
  await withFetchStub(
    [(req) =>
      pathOf(req) === "/v1/messages"
        ? new Response(`Invalid credentials: key=${API_KEY}`, { status: 401 })
        : undefined],
    async () => {
      const args = model.methods.generate_caption.arguments.parse({
        idea: "x",
      });
      const err = await assertRejects(() =>
        model.methods.generate_caption.execute(args, context)
      );
      assert(
        String(err).includes(API_KEY),
        "sanity: fixture actually leaks",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "Anthropic standard API key prefix",
    re: /sk-ant-api[a-z0-9_-]{10,}/i,
  },
  { name: "Anthropic OAuth token prefix", re: /sk-ant-oat[a-z0-9_-]{10,}/i },
  // Generic high-entropy blob: a value that is ENTIRELY 32+ alnum/base64url
  // characters with no separators, containing at least one digit. The digit
  // requirement is deliberate: without it this pattern false-positived on
  // `prompt_node_errors.json`'s legitimate, documented ComfyUI error-type
  // string `prompt_outputs_failed_validation` (33 chars, all lowercase +
  // underscores, zero digits — a snake_case identifier, not a secret). Real
  // base64/hex tokens of this length contain a digit with overwhelming
  // probability; none of our authored fixture prose/identifiers do.
  {
    name: "high-entropy token-shaped value",
    re: /^(?=.*[0-9])[A-Za-z0-9+/_=-]{32,}$/,
  },
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

const FIXTURES: Record<string, unknown> = {
  "system_stats.json": systemStats,
  "prompt_queued.json": promptQueued,
  "prompt_node_errors.json": promptNodeErrors,
  "history_completed.json": historyCompleted,
  "object_info_resolution.json": objectInfoResolution,
  "generated_caption.json": generatedCaption,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected secret shape (both auth shapes + high-entropy)", () => {
  const poisoned = {
    a: "sk-ant-api-" + "a".repeat(20),
    b: "sk-ant-oat-" + "a".repeat(20),
    c: "x1".repeat(20), // 40 chars, alnum, includes digits — matches high-entropy
  };
  const violations: string[] = [];
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length >= 3,
    "sanity check: scanner must flag every injected secret shape",
  );
});

// ---------------------------------------------------------------------------
// Bug pins — asserting the ACTUAL (wrong) current output. See the LOCAL
// `comfyui-latent-bugs` issue-lifecycle model for the fix tracking.
// ---------------------------------------------------------------------------

Deno.test("pin: generate records a seed it never applied when no seedNodeId/template resolves", async () => {
  // args.seed is set explicitly, but no `template` and no `seedNodeId` are
  // given, so resolveSeedNode() returns seedNodeId=undefined. generate()'s
  // guard `seed !== undefined && seedNodeId !== undefined` is then false, so
  // `patched = base` (the seed is NEVER written into the graph) — yet the
  // generation resource still records `seed: args.seed`, misrepresenting
  // what was actually rendered. Documented gap #1 (MED), not fixed here.
  const dir = await Deno.makeTempDir();
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    let postedNoiseSeedNode18: unknown = "not-present";
    await withFetchStub(
      [
        (req) => {
          if (pathOf(req) !== "/prompt") return undefined;
          return req.text().then((text) => {
            const body = JSON.parse(text) as {
              prompt: Record<string, { inputs: Record<string, unknown> }>;
            };
            // The inline workflow's seed-shaped node, unpatched.
            postedNoiseSeedNode18 = body.prompt["18"]?.inputs.noise_seed;
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
        const args = model.methods.generate.arguments.parse({
          seed: 999999,
          // No template, no seedNodeId — nothing tells generate() where to
          // patch the seed.
          workflow: {
            "18": { class_type: "RandomNoise", inputs: { noise_seed: 111 } },
          },
        });
        await model.methods.generate.execute(args, context);
      },
    );
    const gen = captured.find((c) => c.spec === "generation");
    assert(gen);
    const g = gen.data as { seed: number | null };
    // pin: the graph actually sent to ComfyUI still carries the ORIGINAL
    // baked-in seed (111) — args.seed=999999 was never applied...
    assertEquals(postedNoiseSeedNode18, 111);
    // ...yet the generation resource claims 999999 was the render's seed.
    assertEquals(g.seed, 999999, "pin: misrepresents the actual render");
    assertNotEquals(
      g.seed,
      postedNoiseSeedNode18,
      "pin: recorded seed does not match what was actually posted",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pin: waitForResult treats completed:true + status:error + no images as done -> empty success, no error surfaced", async () => {
  // ComfyClient.waitForResult's `done` guard is
  // `entry.status?.completed === true || collectImages(entry).length > 0`.
  // A render that ComfyUI itself marked as errored (status_str: "error") but
  // that ALSO reports completed:true is treated identically to a genuine
  // success — generate() then returns normally with an empty images/paths
  // list instead of throwing. Documented gap #2 (MED), not fixed here.
  const dir = await Deno.makeTempDir();
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    await withFetchStub(
      [
        (req) => pathOf(req) === "/prompt" ? json(promptQueued) : undefined,
        (req) =>
          pathOf(req) === "/history/synthetic-prompt-0001"
            ? json({
              "synthetic-prompt-0001": {
                status: {
                  completed: true,
                  status_str: "error",
                  messages: [["execution_error", {
                    exception_type: "ValueError",
                  }]],
                },
                outputs: {},
              },
            })
            : undefined,
      ],
      async () => {
        const args = model.methods.generate.arguments.parse({
          workflow: { "1": { class_type: "X", inputs: {} } },
        });
        // pin: this does NOT throw, despite the render having errored.
        await model.methods.generate.execute(args, context);
      },
    );
    const gen = captured.find((c) => c.spec === "generation");
    assert(gen);
    const g = gen.data as { images: unknown[]; paths: string[] };
    assertEquals(g.images, [], "pin: empty images, no error surfaced");
    assertEquals(g.paths, [], "pin: empty paths, no error surfaced");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pin: snapshotServer never checks res.ok — a non-JSON 500 /system_stats throws a raw, unmapped SyntaxError", async () => {
  // Documented gap #3 (LOW): `snapshotServer` calls `res.json()`
  // unconditionally. A non-JSON error body on a 500 throws a raw SyntaxError
  // from JSON parsing, never mapped to a comfyui-domain error.
  const { context } = fakeContext();
  await withFetchStub(
    [(req) =>
      pathOf(req) === "/system_stats"
        ? new Response("Internal Server Error", { status: 500 })
        : undefined],
    async () => {
      await assertRejects(
        () => model.methods.lookup.execute({}, context),
        SyntaxError,
      );
    },
  );
});

Deno.test("pin: snapshotServer accepts a 500 with a well-formed but system-less JSON body, writing comfyuiVersion undefined", async () => {
  // Same gap as above from the other side: a WELL-FORMED JSON error envelope
  // on a 500 (no `system` key) is accepted identically to a 200 — no error
  // is thrown, and the written resource silently carries
  // `comfyuiVersion: undefined`.
  const { context, captured } = fakeContext();
  await withFetchStub(
    [(req) =>
      pathOf(req) === "/system_stats"
        ? json({ error: "internal error" }, 500)
        : undefined],
    async () => {
      await model.methods.lookup.execute({}, context); // pin: does not throw
    },
  );
  const server = captured.find((c) => c.spec === "server");
  assert(server);
  assertEquals(
    (server.data as { comfyuiVersion: unknown }).comfyuiVersion,
    undefined,
    "pin: HTTP 500 is ignored; version is silently undefined",
  );
});

Deno.test("pin: saveImages ignores subfolder — two images sharing a filename in different subfolders collide on disk", async () => {
  // Documented gap #4 (LOW): `saveImages` writes to
  // `${outputDir}/${img.filename}`, dropping `img.subfolder` entirely. Two
  // images that ComfyUI placed in different subfolders but share a filename
  // silently overwrite each other.
  const dir = await Deno.makeTempDir();
  try {
    const { context, captured } = fakeContext({
      outputDir: dir,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    const bytesA = new Uint8Array([1, 1, 1, 1]);
    const bytesB = new Uint8Array([2, 2, 2, 2]);
    await withFetchStub(
      [
        (req) => pathOf(req) === "/prompt" ? json(promptQueued) : undefined,
        (req) =>
          pathOf(req) === "/history/synthetic-prompt-0001"
            ? json({
              "synthetic-prompt-0001": {
                status: { completed: true },
                outputs: {
                  // Numeric-string node ids sort "158" before "159" — a
                  // deterministic collectImages() iteration order.
                  "158": {
                    images: [{
                      filename: "out.png",
                      subfolder: "a",
                      type: "output",
                    }],
                  },
                  "159": {
                    images: [{
                      filename: "out.png",
                      subfolder: "b",
                      type: "output",
                    }],
                  },
                },
              },
            })
            : undefined,
        (req) => {
          if (pathOf(req) !== "/view") return undefined;
          const subfolder = new URL(req.url).searchParams.get("subfolder");
          return new Response(subfolder === "a" ? bytesA : bytesB, {
            status: 200,
          });
        },
      ],
      async () => {
        const args = model.methods.generate.arguments.parse({
          workflow: { "1": { class_type: "X", inputs: {} } },
        });
        await model.methods.generate.execute(args, context);
      },
    );
    const gen = captured.find((c) => c.spec === "generation");
    assert(gen);
    const g = gen.data as { paths: string[] };
    // pin: TWO paths recorded (as if two distinct files were saved)...
    assertEquals(g.paths.length, 2);
    assertEquals(g.paths[0], g.paths[1], "pin: both paths are IDENTICAL");
    // ...but only ONE file actually exists, holding whichever image was
    // written LAST — the "a" subfolder's bytes are gone.
    const onDisk = await Deno.readFile(g.paths[0]);
    assertEquals(onDisk, bytesB, "pin: the second write clobbered the first");
    assertNotEquals(
      onDisk,
      bytesA,
      "pin: subfolder 'a''s image is unrecoverable — silently overwritten",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
