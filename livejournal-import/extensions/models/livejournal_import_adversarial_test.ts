/**
 * Adversarial suite: hostile/boundary inputs and a mechanical
 * fixtures-secret-scan over livejournal-import/fixtures/*.html.
 *
 * livejournal_import.ts is UNMODIFIED -- every test here PINS current
 * behavior (including behavior that is a documented latent bug) rather than
 * proposing a fix. This suite is where the 8 latent bugs tracked in the
 * LOCAL `livejournal-import-latent-bugs` issue-lifecycle model (NEVER filed
 * to the swamp.club Lab -- see CLAUDE.md's anti-bypass rule) are
 * characterized as failing-would-be-red-if-"fixed" pins:
 *   LB1 SSRF via image src (HIGH), LB2 YAML frontmatter injection via
 *   unescaped newlines (MEDIUM), LB3 silent-empty success (MEDIUM), LB4 no
 *   fetch/subprocess timeout (MEDIUM), LB5 unbounded pagination/memory
 *   (MEDIUM), LB6 fragile comment-JSON extraction (LOW), LB7 operator
 *   `folder` path traversal on disk write (LOW), LB8 parseLjDate silent
 *   fallthrough (LOW).
 *
 * It also pins three REFUTED risk classes as covered-negatives -- explicitly
 * checked and found NOT applicable to this model, so a future change that
 * makes them applicable turns a test red:
 *   - credential leak: globalArguments carries no secret-shaped field at all
 *     (journalUrl/vault/folder/attachmentsFolder), so there is nothing to
 *     leak.
 *   - XXE: HTML is parsed with cheerio (htmlparser2), never an XML/DOMParser
 *     with external-entity resolution; a literal DOCTYPE/ENTITY payload is
 *     inert text, never resolved.
 *   - command injection: `Deno.Command` is invoked with an ARRAY of args
 *     (never a shell string), so shell metacharacters in `vault`/title/tags
 *     pass through as inert array elements, never reaching a shell.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
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
  fn: (
    calls: { req: Request; init: RequestInit | undefined }[],
  ) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: { req: Request; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({ req: req.clone(), init });
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
    headers: { "Content-Type": "image/jpeg" },
  });
}

async function readFixture(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../fixtures/${name}`, import.meta.url),
  );
}

type CommandCall = {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
};

function withDenoStubs<T = void>(
  opts: { vaultPath?: string },
  fn: (
    calls: {
      commands: CommandCall[];
      mkdirs: string[];
      writes: { path: string }[];
    },
  ) => Promise<T>,
): Promise<T> {
  const commands: CommandCall[] = [];
  const mkdirs: string[] = [];
  const writes: { path: string }[] = [];
  const vaultPath = opts.vaultPath ?? "/fixture/vault";
  // deno-lint-ignore no-explicit-any
  const denoAny = globalThis.Deno as any;
  const originalCommand = denoAny.Command;
  const originalMkdir = denoAny.mkdir;
  const originalWriteFile = denoAny.writeFile;

  class FakeCommand {
    _args: string[];
    constructor(_cmd: string, options: Record<string, unknown>) {
      this._args = (options.args as string[]) ?? [];
      commands.push({ cmd: _cmd, args: this._args, options });
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
  denoAny.writeFile = (path: string | URL) => {
    writes.push({ path: String(path) });
    return Promise.resolve();
  };

  return (async () => {
    try {
      return await fn({ commands, mkdirs, writes });
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

async function runSinglePostImport(
  globalArgs: Record<string, unknown>,
  postHtmlFile: string,
) {
  const indexHtml = await readFixture("index.html");
  const postHtml = await readFixture(postHtmlFile);
  const { ctx, written, logs } = makeCtx(globalArgs);
  const fetchCalls: { req: Request; init: RequestInit | undefined }[] = [];
  const denoResult = await withDenoStubs(
    {},
    async ({ commands, mkdirs, writes }) => {
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/" && !url.searchParams.has("skip")) {
            return htmlResponse(indexHtml);
          }
          if (url.pathname === "/1001.html" || url.pathname === "/1002.html") {
            return htmlResponse(postHtml);
          }
          return binaryResponse();
        }],
        async (calls) => {
          await run({}, ctx);
          fetchCalls.push(...calls);
        },
      );
      return { commands, mkdirs, writes };
    },
  );
  return { written, logs, fetchCalls, ...denoResult };
}

// ===========================================================================
// LB1 SSRF via image src -- HIGH
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB1, HIGH): an image src pointing at a cloud-metadata / loopback-admin target is fetched with NO host allowlist", async () => {
  const { fetchCalls } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_ssrf.html",
  );
  const imageUrls = fetchCalls
    .map((c) => c.req.url)
    .filter((u) => !u.includes("fixture-journal.example.com"));
  assert(
    imageUrls.some((u) => new URL(u).hostname === "169.254.169.254"),
    "the cloud-metadata-shaped target must have been reached exactly as given",
  );
  assert(
    imageUrls.some((u) => {
      const parsed = new URL(u);
      return parsed.hostname === "127.0.0.1" && parsed.port === "8200";
    }),
    "the loopback admin-shaped target must have been reached exactly as given",
  );
});

// ===========================================================================
// LB2 YAML frontmatter injection via unescaped newlines -- MEDIUM
// ===========================================================================

Deno.test('pin (livejournal-import-latent-bugs LB2, MEDIUM): title/mood/now_playing/tags escape only `"`, not embedded newlines -- a raw newline reaches the YAML frontmatter', async () => {
  const { written } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_injection.html",
  );
  const post = written.find((w) => w.spec === "post")!;
  // The title field itself carries the raw, un-newline-stripped text.
  assert(
    (post.payload.title as string).includes("\n"),
    "post.title retains the embedded newline verbatim",
  );
  assert(
    (post.payload.mood as string).includes("\n"),
    "post.mood retains the embedded newline verbatim",
  );
});

// ===========================================================================
// LB3 silent-empty success -- MEDIUM
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB3, MEDIUM): an index with zero collectible post urls resolves as an ordinary 'Import complete' success, not an error/warning", async () => {
  const indexHtml = await readFixture("index_empty.html");
  const { ctx, written, logs } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({}, async () => {
    await withFetchStub(
      [() => htmlResponse(indexHtml)],
      () => run({}, ctx) as Promise<void>,
    );
  });
  const result = written.find((w) => w.spec === "result")!;
  assertEquals(result.payload.totalPosts, 0);
  assertEquals(result.payload.errors, []);
  assert(
    logs.some((l) =>
      l.includes("Import complete: 0 notes, 0 images. Errors: 0")
    ),
    "the completion log reads as an ordinary success, no distinct zero-posts warning",
  );
});

// ===========================================================================
// LB4 no fetch/subprocess timeout -- MEDIUM
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB4, MEDIUM): neither the index/post fetch nor the image fetch pass an AbortSignal/timeout", async () => {
  const indexHtml = await readFixture("index.html");
  const postHtml = await readFixture("post_full.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  const inits: (RequestInit | undefined)[] = [];
  await withDenoStubs({}, async () => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(indexHtml);
        }
        if (url.pathname === "/1001.html" || url.pathname === "/1002.html") {
          return htmlResponse(postHtml);
        }
        return binaryResponse();
      }],
      async (calls) => {
        await run({}, ctx);
        for (const c of calls) inits.push(c.init);
      },
    );
  });
  assert(inits.length > 0, "sanity: at least one fetch call happened");
  for (const init of inits) {
    assertEquals(init?.signal, undefined);
  }
});

Deno.test("pin (livejournal-import-latent-bugs LB4): Deno.Command for the obsidian CLI is constructed with no timeout/signal option either", async () => {
  const indexHtml = await readFixture("index_empty.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({}, async ({ commands }) => {
    await withFetchStub(
      [() => htmlResponse(indexHtml)],
      () => run({}, ctx) as Promise<void>,
    );
    for (const c of commands) {
      assertEquals("signal" in c.options, false);
    }
  });
});

// ===========================================================================
// LB5 unbounded pagination/memory -- MEDIUM
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB5, MEDIUM): collectPostUrls has NO page cap -- it keeps paging for as many `skip=N` markers as the server offers (bounded here only by the TEST HARNESS, not by the source)", async () => {
  // The harness itself imposes a hard page cap (PAGE_CAP) purely so the test
  // terminates -- this characterizes the ABSENCE of any such cap in
  // livejournal_import.ts: every page the harness offers is faithfully
  // requested, with a fresh unseen post id each time, until the harness
  // (not the code) stops advertising a next page.
  const PAGE_CAP = 12;
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  let indexFetches = 0;
  await withDenoStubs({}, async () => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/") {
          const skip = Number(url.searchParams.get("skip") ?? "0");
          indexFetches++;
          const page = skip / 10;
          const id = 9000 + page;
          const hasNext = page + 1 < PAGE_CAP;
          const nextMarker = hasNext
            ? `<a href="https://fixture-journal.example.com/?format=light&amp;skip=${
              skip + 10
            }">next</a>`
            : "";
          return htmlResponse(
            `<html><body><a href="https://fixture-journal.example.com/${id}.html">p${page}</a>${nextMarker}</body></html>`,
          );
        }
        return htmlResponse(
          `<html><body><div class="aentry-post__title-text">Fixture Page Post</div>` +
            `<div class="aentry-head__date"><time>May 1 2015, 12:00</time></div>` +
            `<div class="aentry-post__text"><p>fixture body</p></div></body></html>`,
        );
      }],
      () => run({}, ctx) as Promise<void>,
    );
  });
  assertEquals(indexFetches, PAGE_CAP);
  const result = written.find((w) => w.spec === "result")!;
  assertEquals(result.payload.totalPosts, PAGE_CAP);
});

// ===========================================================================
// LB6 fragile comment-JSON extraction -- LOW
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB6, LOW): a corrupted `Site.page` blob is swallowed by the empty catch -- comments silently resolve to zero, no throw, no error entry", async () => {
  const { written } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_bad_comments.html",
  );
  const post = written.find((w) => w.spec === "post")!;
  const result = written.find((w) => w.spec === "result")!;
  assertEquals(result.payload.errors, []);
  assertEquals((post.payload.text as string).includes("## Comments"), false);
});

// ===========================================================================
// LB7 operator `folder` path traversal on disk write -- LOW
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB7, LOW): a `folder` global argument containing `..` segments is concatenated into the attachment disk path with no traversal guard (escape target stays SYNTHETIC)", async () => {
  const args = { ...GLOBAL_ARGS, folder: "../../fixture-escape-target" };
  const { mkdirs, writes } = await runSinglePostImport(args, "post_full.html");
  assert(
    mkdirs.some((m) => m.includes("../../fixture-escape-target/attachments")),
    "mkdir path carries the unsanitized traversal segments verbatim",
  );
  assert(
    writes.every((w) =>
      w.path.includes("../../fixture-escape-target/attachments/")
    ),
    "every image write path also carries the unsanitized traversal segments",
  );
});

// ===========================================================================
// LB8 parseLjDate silent fallthrough -- LOW
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB8, LOW): a date string not matching the expected shape flows through UNCHANGED into post.date, the frontmatter's unquoted `date:` line, and the note slug", async () => {
  const { written, commands } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_bad_date.html",
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(post.payload.date, "Sometime last fixture-summer");
  const createCall = commands.find((c) => c.args[0] === "create")!;
  const contentArg = createCall.args.find((a) => a.startsWith("content="))!;
  assert(
    contentArg.includes("date: Sometime last fixture-summer"),
    "the raw non-ISO date string is emitted UNQUOTED into the frontmatter",
  );
  const pathArg = createCall.args.find((a) => a.startsWith("path="))!;
  assert(
    pathArg.includes("Sometime last fixture-summer"),
    "the raw date string (not sanitized like the title) is prepended to the note slug",
  );
});

// ===========================================================================
// Covered-negatives: credential leak / XXE / command injection -- REFUTED
// ===========================================================================

Deno.test("refuted: globalArguments carries no credential-shaped field -- there is nothing for a credential-leak test to catch", () => {
  const shape = model.globalArguments;
  // GlobalArgsSchema is a zod object; its shape keys are exactly these four.
  // deno-lint-ignore no-explicit-any
  const keys = Object.keys((shape as any).shape ?? {});
  assertEquals(
    keys.sort(),
    ["attachmentsFolder", "folder", "journalUrl", "vault"],
  );
  for (const k of keys) {
    assert(
      !/token|secret|key|password|credential/i.test(k),
      `globalArgs key "${k}" looks credential-shaped`,
    );
  }
});

Deno.test("refuted: a literal DOCTYPE/ENTITY (XXE-shaped) payload embedded in post body text is inert -- cheerio never resolves external entities", async () => {
  const indexHtml = await readFixture("index.html");
  const xxePost = `<html><body>
<div class="aentry-post__title-text">Fixture XXE Post</div>
<div class="aentry-head__date"><time>July 4 2016, 10:00</time></div>
<div class="aentry-post__text">
<p>Fixture body with an inert XXE-shaped payload below.</p>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/fixture-passwd"> ]>
<p>&xxe;</p>
</div>
</body></html>`;
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  let threw: unknown;
  await withDenoStubs({}, async () => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(indexHtml);
        }
        return htmlResponse(xxePost);
      }],
      async () => {
        try {
          await run({}, ctx);
        } catch (e) {
          threw = e;
        }
      },
    );
  });
  assertEquals(threw, undefined, "no throw from the XXE-shaped payload");
  const post = written.find((w) => w.spec === "post")!;
  assert(
    !(post.payload.text as string).includes("fixture-passwd"),
    "the entity was never resolved into file content -- no read ever happened",
  );
});

Deno.test("refuted: shell metacharacters in `vault`/title reach Deno.Command as inert ARRAY elements -- no shell is ever invoked", async () => {
  const args = {
    ...GLOBAL_ARGS,
    vault: "fixture-vault; rm -rf /tmp/fixture-target",
  };
  const indexHtml = await readFixture("index.html");
  const injectionPost = `<html><body>
<div class="aentry-post__title-text">Fixture \`touch /tmp/fixture-pwned\` Title</div>
<div class="aentry-head__date"><time>July 5 2016, 11:00</time></div>
<div class="aentry-post__text"><p>fixture body</p></div>
</body></html>`;
  const { ctx } = makeCtx(args);
  await withDenoStubs({}, async ({ commands }) => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(indexHtml);
        }
        return htmlResponse(injectionPost);
      }],
      () => run({}, ctx) as Promise<void>,
    );
    for (const c of commands) {
      assertEquals(
        c.args.some((a) =>
          a === "vault=fixture-vault; rm -rf /tmp/fixture-target"
        ),
        true,
      );
    }
  });
});

// ===========================================================================
// Fixtures-secret-scan -- mechanical backstop over the committed HTML corpus
// ===========================================================================

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "vault key name JOURNAL_URL/VAULT secret shape",
    re: /\b[A-Z_]*SECRET[A-Z_]*\b/,
  },
  {
    name: "high-entropy token-shaped value",
    re: /^[A-Za-z0-9+/_=-]{32,}$/,
  },
  { name: "bearer-token shaped value", re: /^Bearer\s+[A-Za-z0-9._-]{20,}$/ },
];

const HTML_FIXTURES = [
  "index.html",
  "index_empty.html",
  "index_paginated.html",
  "post_full.html",
  "post_ssrf.html",
  "post_injection.html",
  "post_bad_date.html",
  "post_bad_comments.html",
];

Deno.test("fixtures-secret-scan: no committed HTML fixture contains a secret-shaped token", async () => {
  const violations: string[] = [];
  for (const file of HTML_FIXTURES) {
    const raw = await readFixture(file);
    for (const { name, re } of SECRET_PATTERNS) {
      for (const token of raw.split(/\s+/)) {
        if (re.test(token)) {
          violations.push(`${file}: token "${token}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed HTML fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity -- the scanner actually detects an injected secret shape", () => {
  const poisoned = "a".repeat(40);
  const violations: string[] = [];
  for (const { re } of SECRET_PATTERNS) {
    if (re.test(poisoned)) violations.push(poisoned);
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real high-entropy shape",
  );
});
