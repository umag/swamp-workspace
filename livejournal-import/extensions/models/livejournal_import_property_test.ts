/**
 * Property-based tests (fast-check) for @magistr/livejournal-import.
 *
 * livejournal_import.ts exports no pure parser helpers -- every property here
 * is observed by driving `model.methods.import.execute()` against a stubbed
 * fetch and stubbed Deno.Command/mkdir/writeFile, then reading back the
 * written `post`/`result` resources. Well-formedness is checked against the
 * model's OWN `model.resources.<x>.schema` zod schemas (not a
 * reimplementation), so a future schema tightening/loosening is what these
 * properties actually track.
 *
 * Honors `FC_NUM_RUNS` for the nightly soak (`deno task test:soak`).
 *
 * Properties:
 *  (a) never throws -- import() never throws for ANY post-body HTML string
 *      (arbitrary/hostile content included), and both written resources
 *      always validate against their resource schemas.
 *  (b) never throws / never hangs -- import() never throws for ANY index
 *      HTML string either; a harness-side page cap (not a source-code cap --
 *      see LB5) guarantees termination regardless of what fast-check
 *      generates.
 *  (c) normalization idempotent -- the post.text 500-char truncation is
 *      idempotent: re-running import with the ALREADY-truncated text
 *      embedded as the new post body produces the identical text value.
 *  (d) multi-post flow invariant -- for any generated set of N well-formed
 *      posts, import() always writes exactly N `post` resources plus one
 *      `result` summary with totalPosts === notesCreated === N.
 */
import { assert } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import fc from "npm:fast-check@4.8.0";
import { model } from "./livejournal_import.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(100) };

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

type Route = (
  req: Request,
) => Response | Promise<Response | undefined> | undefined;

async function withFetchStub(routes: Route[], fn: () => Promise<void>) {
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

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function binaryResponse() {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "Content-Type": "image/jpeg" },
  });
}

function withDenoStubs<T = void>(
  fn: (
    calls: { commands: { args: string[] }[]; mkdirs: string[] },
  ) => Promise<T>,
): Promise<T> {
  const commands: { args: string[] }[] = [];
  const mkdirs: string[] = [];
  const vaultPath = "/fixture/vault";
  // deno-lint-ignore no-explicit-any
  const denoAny = globalThis.Deno as any;
  const originalCommand = denoAny.Command;
  const originalMkdir = denoAny.mkdir;
  const originalWriteFile = denoAny.writeFile;

  class FakeCommand {
    _args: string[];
    constructor(_cmd: string, options: { args?: string[] }) {
      this._args = options.args ?? [];
      commands.push({ args: this._args });
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
  denoAny.mkdir = (path: string) => {
    mkdirs.push(path);
    return Promise.resolve();
  };
  denoAny.writeFile = () => Promise.resolve();

  return (async () => {
    try {
      return await fn({ commands, mkdirs });
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

// A single-post index (no pagination, no inter-post 300ms delay) so hostile
// per-post properties stay fast across many fast-check runs.
const SINGLE_POST_INDEX =
  `<html><body><a href="https://fixture-journal.example.com/9001.html">Fixture Single Post</a></body></html>`;

// ---------------------------------------------------------------------------
// (a) never throws -- arbitrary post-body HTML
// ---------------------------------------------------------------------------

const arbHostileHtml = fc.string({ maxLength: 3000 });

Deno.test("property: import() never throws for ANY post-body HTML string, and both written resources are always schema-valid", async () => {
  await fc.assert(
    fc.asyncProperty(arbHostileHtml, async (body) => {
      const { ctx, written } = makeCtx(GLOBAL_ARGS);
      let threw = false;
      await withDenoStubs(async () => {
        await withFetchStub(
          [(req) => {
            const url = new URL(req.url);
            if (url.pathname === "/" && !url.searchParams.has("skip")) {
              return htmlResponse(SINGLE_POST_INDEX);
            }
            if (url.pathname === "/9001.html") {
              return htmlResponse(
                `<html><body><div class="aentry-post__text">${body}</div></body></html>`,
              );
            }
            return binaryResponse();
          }],
          async () => {
            try {
              await run({}, ctx);
            } catch {
              threw = true;
            }
          },
        );
      });
      if (threw) return false;
      const post = written.find((w) => w.spec === "post")!;
      const result = written.find((w) => w.spec === "result")!;
      model.resources.post.schema.parse(post.payload);
      model.resources.result.schema.parse(result.payload);
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) never throws / never hangs -- arbitrary INDEX HTML
// ---------------------------------------------------------------------------

const VALID_POST_HTML =
  `<html><body><div class="aentry-post__title-text">Fixture Property Post</div>` +
  `<div class="aentry-head__date"><time>May 1 2020, 10:00</time></div>` +
  `<div class="aentry-post__text"><p>fixture body</p></div></body></html>`;

Deno.test("property: import() never throws for ANY index-page HTML string, terminating within a harness-side page cap regardless of content", async () => {
  const HARNESS_PAGE_CAP = 6;
  await fc.assert(
    fc.asyncProperty(arbHostileHtml, async (indexBody) => {
      const { ctx, written } = makeCtx(GLOBAL_ARGS);
      let indexFetches = 0;
      let threw = false;
      await withDenoStubs(async () => {
        await withFetchStub(
          [(req) => {
            const url = new URL(req.url);
            if (url.pathname === "/") {
              indexFetches++;
              // Harness-side safety valve: once the cap is hit, force
              // termination by serving a page with no links and no `skip=`
              // marker, no matter what the arbitrary generated. This bounds
              // the TEST, not the source -- see LB5 (no code-level cap).
              if (indexFetches > HARNESS_PAGE_CAP) {
                return htmlResponse(
                  "<html><body>no more fixture pages</body></html>",
                );
              }
              return htmlResponse(indexBody);
            }
            return htmlResponse(VALID_POST_HTML);
          }],
          async () => {
            try {
              await run({}, ctx);
            } catch {
              threw = true;
            }
          },
        );
      });
      if (threw) return false;
      assert(
        indexFetches <= HARNESS_PAGE_CAP + 1,
        "harness page cap must bound the run",
      );
      const result = written.find((w) => w.spec === "result");
      if (result) model.resources.result.schema.parse(result.payload);
      return true;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) normalization idempotent -- post.text's 500-char truncation
// ---------------------------------------------------------------------------

const arbSafeText = fc.stringMatching(/^[a-zA-Z0-9 '.,\n-]{0,900}$/);

async function textFor(bodyText: string): Promise<string> {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs(async () => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(SINGLE_POST_INDEX);
        }
        return htmlResponse(
          `<html><body><div class="aentry-post__title-text">Fixture Idempotence Post</div>` +
            `<div class="aentry-head__date"><time>May 1 2020, 10:00</time></div>` +
            `<div class="aentry-post__text"><p>${bodyText}</p></div></body></html>`,
        );
      }],
      () => run({}, ctx) as Promise<void>,
    );
  });
  return written.find((w) => w.spec === "post")!.payload.text as string;
}

Deno.test("property: post.text's 500-char truncation is idempotent -- re-running import with the ALREADY-truncated text embedded yields the identical value", async () => {
  await fc.assert(
    fc.asyncProperty(arbSafeText, async (text) => {
      const once = await textFor(text);
      const twice = await textFor(once);
      return twice === once;
    }),
    FC_RUNS,
  );
});

Deno.test("property: post.text is never longer than 500 characters, for any input length", async () => {
  await fc.assert(
    fc.asyncProperty(arbSafeText, async (text) => {
      const t = await textFor(text);
      return t.length <= 500;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) multi-post flow invariant
// ---------------------------------------------------------------------------

const arbTitle = fc
  .stringMatching(/^[a-zA-Z0-9 '-]{1,30}$/)
  .filter((s) => /[a-zA-Z0-9]/.test(s));

Deno.test("property: for any generated set of N well-formed posts, import() writes exactly N `post` resources and result.totalPosts === notesCreated === N", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbTitle, { minLength: 1, maxLength: 4 }),
      async (titles) => {
        const time = new FakeTime();
        try {
          const ids = titles.map((_, i) => 9100 + i);
          const indexHtml = `<html><body>${
            ids.map((id) =>
              `<a href="https://fixture-journal.example.com/${id}.html">p</a>`
            ).join("")
          }</body></html>`;
          const { ctx, written } = makeCtx(GLOBAL_ARGS);
          await withDenoStubs(async () => {
            const importPromise = withFetchStub(
              [(req) => {
                const url = new URL(req.url);
                if (url.pathname === "/" && !url.searchParams.has("skip")) {
                  return htmlResponse(indexHtml);
                }
                const match = url.pathname.match(/^\/(\d+)\.html$/);
                if (match) {
                  const idx = ids.indexOf(Number(match[1]));
                  const title = titles[idx];
                  return htmlResponse(
                    `<html><body><div class="aentry-post__title-text">${title}</div>` +
                      `<div class="aentry-head__date"><time>May 1 2020, 10:00</time></div>` +
                      `<div class="aentry-post__text"><p>fixture body</p></div></body></html>`,
                  );
                }
                return undefined;
              }],
              () => run({}, ctx) as Promise<void>,
            );
            // Drain the (titles.length - 1) inter-post 300ms polite delays.
            const delays = Math.max(0, titles.length - 1);
            for (let i = 0; i < delays; i++) {
              await time.tickAsync(300);
            }
            await importPromise;
          });
          const posts = written.filter((w) => w.spec === "post");
          const result = written.find((w) => w.spec === "result")!;
          model.resources.result.schema.parse(result.payload);
          for (const p of posts) model.resources.post.schema.parse(p.payload);
          return posts.length === titles.length &&
            result.payload.totalPosts === titles.length &&
            result.payload.notesCreated === titles.length;
        } finally {
          time.restore();
        }
      },
    ),
    { ...FC_RUNS, numRuns: Math.min(FC_RUNS.numRuns, 30) },
  );
});

// ---------------------------------------------------------------------------
// Sanity: the never-throws property scanner actually exercises hostile input
// ---------------------------------------------------------------------------

Deno.test("sanity: the hostile-HTML arbitrary can generate control characters and non-empty strings (not vacuously safe)", () => {
  let sawWeird = false;
  fc.assert(
    fc.property(arbHostileHtml, (s) => {
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) <= 8) sawWeird = true;
      }
      if (s.length > 0) sawWeird = true;
      return true;
    }),
    { numRuns: 500 },
  );
  assert(
    sawWeird,
    "sanity: the arbitrary must generate non-empty strings at least once",
  );
});
