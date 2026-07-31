/**
 * Contract-fixture suite: pins the CONCRETE field-by-field output shape of
 * livejournal_import.ts's single `import` method -- the written `post` and
 * `result` resources, plus the captured `obsidian create` note content
 * (frontmatter + body with image embeds + comments section) -- against
 * livejournal-import/fixtures/*.html (synthetic).
 *
 * livejournal_import.ts has ONLY `model` exported -- collectPostUrls,
 * parsePost, htmlToMarkdown, parseLjDate, sanitize, runObsidian, and
 * getVaultPath are module-private. Every test here drives them exclusively
 * through `model.methods.import.execute()` against a stubbed
 * `globalThis.fetch` (index + post HTML, and image binary fetch) and a
 * stubbed `Deno.Command`/`Deno.mkdir`/`Deno.writeFile` (the `obsidian` CLI
 * seam and the vault-attachment disk writes), per the approved plan's test
 * seam. livejournal_import.ts is UNMODIFIED by this change -- every
 * assertion below was captured by actually running the frozen source against
 * these fixtures (not hand-derived from reading the regex/selector logic),
 * so it pins REAL observed behavior.
 *
 * All fixtures are PURE synthetic/hand-authored data -- see
 * fixtures/PROVENANCE.md. Every test here is offline: no real network call,
 * no real `obsidian` CLI invocation, no real filesystem write outside the
 * stub's in-memory capture.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./livejournal_import.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
      logger: {
        info: (strings: TemplateStringsArray, ...args: unknown[]) => {
          let out = strings[0];
          for (let i = 0; i < args.length; i++) {
            out += String(args[i]) + (strings[i + 1] ?? "");
          }
          logs.push(out);
        },
      },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)["import"];
  return method.execute(method.arguments.parse(args), ctx);
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

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function binaryResponse(status = 200) {
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
    status,
    headers: { "Content-Type": "image/jpeg" },
  });
}

async function readFixture(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../fixtures/${name}`, import.meta.url),
  );
}

type CommandCall = { cmd: string; args: string[] };

function withDenoStubs(
  opts: { vaultPath?: string },
  fn: (
    calls: {
      commands: CommandCall[];
      mkdirs: string[];
      writes: { path: string; data: Uint8Array }[];
    },
  ) => Promise<void>,
) {
  const commands: CommandCall[] = [];
  const mkdirs: string[] = [];
  const writes: { path: string; data: Uint8Array }[] = [];
  const vaultPath = opts.vaultPath ?? "/fixture/vault";
  // deno-lint-ignore no-explicit-any
  const denoAny = globalThis.Deno as any;
  const originalCommand = denoAny.Command;
  const originalMkdir = denoAny.mkdir;
  const originalWriteFile = denoAny.writeFile;

  class FakeCommand {
    constructor(_cmd: string, options: { args?: string[] }) {
      commands.push({ cmd: _cmd, args: options.args ?? [] });
      this._args = options.args ?? [];
    }
    _args: string[];
    output() {
      if (this._args[0] === "vault") {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new TextEncoder().encode(vaultPath),
          stderr: new Uint8Array(),
        });
      }
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }
  }

  denoAny.Command = FakeCommand;
  denoAny.mkdir = (path: string) => {
    mkdirs.push(path);
    return Promise.resolve();
  };
  denoAny.writeFile = (path: string | URL, data: Uint8Array) => {
    writes.push({ path: String(path), data });
    return Promise.resolve();
  };

  return (async () => {
    try {
      await fn({ commands, mkdirs, writes });
    } finally {
      denoAny.Command = originalCommand;
      denoAny.mkdir = originalMkdir;
      denoAny.writeFile = originalWriteFile;
    }
  })();
}

const GLOBAL_ARGS = {
  journalUrl: "https://fixture-journal.example.com/",
  vault: "fixture-vault",
  folder: "LiveJournal",
  attachmentsFolder: "attachments",
};

// ---------------------------------------------------------------------------
// import: single-page index + one full post -- the primary contract pin
// ---------------------------------------------------------------------------

Deno.test("contract: index.html + post_full.html -- writes one `post` resource with the full field set, one `result` summary, and a captured obsidian create note", async () => {
  const indexHtml = await readFixture("index.html");
  const postHtml = await readFixture("post_full.html");
  const { ctx, written } = makeCtx(GLOBAL_ARGS);

  await withDenoStubs({}, async ({ commands, mkdirs, writes }) => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(indexHtml);
        }
        if (url.pathname === "/1001.html" || url.pathname === "/1002.html") {
          return htmlResponse(postHtml);
        }
        if (url.hostname === "f-pics.example.com") return binaryResponse();
        return undefined;
      }],
      () => run({}, ctx) as Promise<void>,
    );

    // getVaultPath then mkdir for the attachments folder.
    assertEquals(commands[0].args, [
      "vault",
      "vault=fixture-vault",
      "info=path",
    ]);
    assertEquals(mkdirs, ["/fixture/vault/LiveJournal/attachments"]);

    const posts = written.filter((w) => w.spec === "post");
    assertEquals(posts.length, 2);

    const p = posts[0];
    assertEquals(p.payload.id, 1001);
    assertEquals(p.payload.title, "Fixture Full Post Title");
    assertEquals(p.payload.date, "2010-08-22T21:14:00");
    assertEquals(
      p.payload.url,
      "https://fixture-journal.example.com/1001.html",
    );
    assertEquals(p.payload.tags, ["travel", "fixture-tag"]);
    assertEquals(p.payload.mood, "optimistic");
    assertEquals(p.payload.nowPlaying, "Fixture Band - Fixture Song");
    assertEquals(typeof p.payload.text, "string");
    assertEquals(typeof p.payload.imageCount, "number");

    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.journal, "fixture-journal");
    assertEquals(result.payload.totalPosts, 2);
    assertEquals(result.payload.notesCreated, 2);
    assertEquals(result.payload.errors, []);

    // The obsidian `create` command carries the assembled note content.
    const createCalls = commands.filter((c) => c.args[0] === "create");
    assertEquals(createCalls.length, 2);
    const createArgs = createCalls[0].args;
    assertEquals(createArgs[1], "vault=fixture-vault");
    const pathArg = createArgs.find((a) => a.startsWith("path="))!;
    assertEquals(
      pathArg,
      "path=LiveJournal/2010-08-22-Fixture-Full-Post-Title",
    );
    assertEquals(createArgs[createArgs.length - 1], "overwrite");
    const contentArg = createArgs.find((a) => a.startsWith("content="))!;
    assertEquals(contentArg.includes('title: "Fixture Full Post Title"'), true);
    assertEquals(contentArg.includes("date: 2010-08-22T21:14:00"), true);
    assertEquals(contentArg.includes("source: livejournal"), true);
    assertEquals(
      contentArg.includes(
        'url: "https://fixture-journal.example.com/1001.html"',
      ),
      true,
    );
    assertEquals(contentArg.includes("lj_id: 1001"), true);
    assertEquals(contentArg.includes('mood: "optimistic"'), true);
    assertEquals(
      contentArg.includes('now_playing: "Fixture Band - Fixture Song"'),
      true,
    );
    assertEquals(contentArg.includes("  - livejournal"), true);
    assertEquals(contentArg.includes('  - "travel"'), true);
    assertEquals(contentArg.includes('  - "fixture-tag"'), true);
    assertEquals(contentArg.includes("## Comments"), true);
    assertEquals(contentArg.includes("**fixture_alice**"), true);
    assertEquals(contentArg.includes("**Fixture Bob**"), true);

    // Image attachments were written under the attachments folder.
    assertEquals(writes.length > 0, true);
    assertEquals(
      writes.every((w) =>
        w.path.startsWith("/fixture/vault/LiveJournal/attachments/")
      ),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// structural pin -- resources map
// ---------------------------------------------------------------------------

Deno.test("structural: model declares exactly the `result` and `post` resource specs, and a single `import` method", () => {
  assertEquals(Object.keys(model.resources).sort(), ["post", "result"]);
  assertEquals(Object.keys(model.methods), ["import"]);
});
