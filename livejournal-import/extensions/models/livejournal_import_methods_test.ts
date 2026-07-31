/**
 * Method-level tests for @magistr/livejournal-import -- the single `import`
 * method, happy path + argument schema, driven through
 * `model.methods.import.arguments.parse()` + `.execute()` against a stubbed
 * `globalThis.fetch` and stubbed `Deno.Command`/`Deno.mkdir`/`Deno.writeFile`.
 *
 * livejournal_import.ts is UNMODIFIED -- every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior: request URL shapes (index pagination, post fetch, image fetch),
 * the `obsidian` CLI argv shape for both subcommands it shells out to
 * (`vault ... info=path` and `create ... overwrite`), the vault-attachment
 * mkdir/writeFile paths, and the empty `z.object({})` argument schema.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./livejournal_import.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
      logger: {
        info: (_strings: TemplateStringsArray, ..._args: unknown[]) => {},
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

function binaryResponse() {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

async function readFixture(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../fixtures/${name}`, import.meta.url),
  );
}

type CommandCall = { cmd: string; args: string[] };
type MkdirCall = { path: string; recursive: boolean | undefined };
type WriteCall = { path: string; data: Uint8Array };

function withDenoStubs(
  opts: { vaultPath?: string },
  fn: (
    calls: {
      commands: CommandCall[];
      mkdirs: MkdirCall[];
      writes: WriteCall[];
    },
  ) => Promise<void>,
) {
  const commands: CommandCall[] = [];
  const mkdirs: MkdirCall[] = [];
  const writes: WriteCall[] = [];
  const vaultPath = opts.vaultPath ?? "/fixture/vault";
  // deno-lint-ignore no-explicit-any
  const denoAny = globalThis.Deno as any;
  const originalCommand = denoAny.Command;
  const originalMkdir = denoAny.mkdir;
  const originalWriteFile = denoAny.writeFile;

  class FakeCommand {
    _args: string[];
    constructor(_cmd: string, options: { args?: string[] }) {
      this._args = options.args ?? [];
      commands.push({ cmd: _cmd, args: this._args });
    }
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
  denoAny.mkdir = (path: string, options?: { recursive?: boolean }) => {
    mkdirs.push({ path, recursive: options?.recursive });
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
// argument schema
// ---------------------------------------------------------------------------

Deno.test("import: arguments schema is z.object({}) -- parses {} and silently strips unknown keys (zod default, not .strict())", () => {
  const method = (model.methods as MethodMap)["import"];
  assertEquals(method.arguments.parse({}), {});
  assertEquals(method.arguments.parse({ foo: "bar", n: 1 }), {});
});

// ---------------------------------------------------------------------------
// index pagination -- request URL shapes
// ---------------------------------------------------------------------------

Deno.test("import: the un-paginated index is fetched at `<base>/?format=light`, no skip param", async () => {
  const indexHtml = await readFixture("index_empty.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({}, async () => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        assertEquals(url.pathname, "/");
        assertEquals(url.searchParams.get("format"), "light");
        assertEquals(url.searchParams.has("skip"), false);
        return htmlResponse(indexHtml);
      }],
      () => run({}, ctx) as Promise<void>,
    );
  });
});

Deno.test("import: a paginated index's second page is fetched with `&skip=10`, and the loop terminates once no NEW post ids appear", async () => {
  const paginatedHtml = await readFixture("index_paginated.html");
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  const requestedSkips: (string | null)[] = [];
  await withDenoStubs({}, async ({ commands }) => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/") {
          requestedSkips.push(url.searchParams.get("skip"));
          return htmlResponse(paginatedHtml);
        }
        if (url.pathname === "/2001.html" || url.pathname === "/2002.html") {
          return htmlResponse(
            `<html><body><div class="aentry-post__title-text">Fixture Paginated Post</div>` +
              `<div class="aentry-head__date"><time>May 1 2015, 12:00</time></div>` +
              `<div class="aentry-post__text"><p>fixture body</p></div></body></html>`,
          );
        }
        return undefined;
      }],
      () => run({}, ctx) as Promise<void>,
    );
    // Two index fetches: skip=null (first page) then skip=10 (second page,
    // which repeats the SAME two ids -- foundNew=false breaks the loop).
    assertEquals(requestedSkips, [null, "10"]);
    const posts = written.filter((w) => w.spec === "post");
    assertEquals(posts.length, 2);
    const summary = written.find((w) => w.spec === "result")!;
    assertEquals(summary.payload.totalPosts, 2);
    void commands;
  });
});

// ---------------------------------------------------------------------------
// post fetch URL shape
// ---------------------------------------------------------------------------

Deno.test("import: each post URL is fetched with `?format=light` appended", async () => {
  const indexHtml = await readFixture("index.html");
  const postHtml = await readFixture("post_bad_date.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const postFetches: string[] = [];
  await withDenoStubs({}, async () => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(indexHtml);
        }
        if (url.pathname === "/1001.html" || url.pathname === "/1002.html") {
          postFetches.push(req.url);
          return htmlResponse(postHtml);
        }
        return undefined;
      }],
      () => run({}, ctx) as Promise<void>,
    );
    assertEquals(postFetches, [
      "https://fixture-journal.example.com/1001.html?format=light",
      "https://fixture-journal.example.com/1002.html?format=light",
    ]);
  });
});

// ---------------------------------------------------------------------------
// obsidian CLI argv shape -- both subcommands
// ---------------------------------------------------------------------------

Deno.test("import: getVaultPath shells out to `obsidian vault vault=<vault> info=path`", async () => {
  const indexHtml = await readFixture("index_empty.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs(
    { vaultPath: "/fixture/custom-vault-path" },
    async ({ commands }) => {
      await withFetchStub(
        [() => htmlResponse(indexHtml)],
        () => run({}, ctx) as Promise<void>,
      );
      assertEquals(commands[0].cmd, "obsidian");
      assertEquals(commands[0].args, [
        "vault",
        "vault=fixture-vault",
        "info=path",
      ]);
    },
  );
});

Deno.test("import: runObsidian(create) shells out to `obsidian create vault=<vault> path=<folder>/<slug> content=<note> overwrite`", async () => {
  const indexHtml = await readFixture("index.html");
  const postHtml = await readFixture("post_bad_date.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({}, async ({ commands }) => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(indexHtml);
        }
        return htmlResponse(postHtml);
      }],
      () => run({}, ctx) as Promise<void>,
    );
    const createCall = commands.find((c) => c.args[0] === "create")!;
    assertEquals(createCall.args[0], "create");
    assertEquals(createCall.args[1], "vault=fixture-vault");
    assertEquals(
      createCall.args.some((a) => a.startsWith("path=LiveJournal/")),
      true,
    );
    assertEquals(createCall.args.some((a) => a.startsWith("content=")), true);
    assertEquals(createCall.args[createCall.args.length - 1], "overwrite");
  });
});

// ---------------------------------------------------------------------------
// mkdir / writeFile paths
// ---------------------------------------------------------------------------

Deno.test("import: Deno.mkdir is called once with the `<vaultPath>/<folder>/<attachmentsFolder>` path and recursive:true, even with zero posts", async () => {
  const indexHtml = await readFixture("index_empty.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({ vaultPath: "/fixture/vault" }, async ({ mkdirs }) => {
    await withFetchStub(
      [() => htmlResponse(indexHtml)],
      () => run({}, ctx) as Promise<void>,
    );
    assertEquals(mkdirs, [
      { path: "/fixture/vault/LiveJournal/attachments", recursive: true },
    ]);
  });
});

Deno.test("import: Deno.writeFile is called once per downloaded image, named `lj-<postId>-<n>.<ext>` under the attachments dir", async () => {
  const indexHtml = await readFixture("index.html");
  const postHtml = await readFixture("post_full.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({ vaultPath: "/fixture/vault" }, async ({ writes }) => {
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
    // post_full.html has exactly one non-denylisted image per post.
    const post1001Writes = writes.filter((w) => w.path.includes("lj-1001-"));
    assertEquals(post1001Writes.length > 0, true);
    for (const w of post1001Writes) {
      assertEquals(
        w.path.startsWith("/fixture/vault/LiveJournal/attachments/lj-1001-"),
        true,
      );
      assertEquals(w.path.endsWith(".jpg"), true);
    }
  });
});

// ---------------------------------------------------------------------------
// empty index -- zero posts, no obsidian create calls
// ---------------------------------------------------------------------------

Deno.test("import: an empty index -- getVaultPath + mkdir still run, zero posts, zero obsidian `create` calls", async () => {
  const indexHtml = await readFixture("index_empty.html");
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({}, async ({ commands, mkdirs }) => {
    await withFetchStub(
      [() => htmlResponse(indexHtml)],
      () => run({}, ctx) as Promise<void>,
    );
    assertEquals(commands.filter((c) => c.args[0] === "vault").length, 1);
    assertEquals(mkdirs.length, 1);
    assertEquals(commands.filter((c) => c.args[0] === "create").length, 0);
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.totalPosts, 0);
    assertEquals(result.payload.notesCreated, 0);
    assertEquals(result.payload.imagesCopied, 0);
    assertEquals(result.payload.errors, []);
  });
});
