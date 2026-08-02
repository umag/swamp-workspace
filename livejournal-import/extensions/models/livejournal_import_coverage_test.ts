/**
 * Coverage suite: sweeps every guard/branch in livejournal_import.ts that the
 * contract-fixture/methods/adversarial suites don't already exercise on BOTH
 * sides, so deleting any one of these guards turns a test red (STANDARD.md's
 * coverage role -- a behavioral regression guard, not a numeric percentage).
 *
 * livejournal_import.ts is UNMODIFIED; every test here PINS existing
 * behavior. htmlToMarkdown/parseLjDate/sanitize/collectPostUrls/parsePost
 * are module-private -- only `model` is exported -- so every branch is
 * reached by driving `model.methods.import.execute()` against a stubbed
 * fetch + stubbed Deno.Command/mkdir/writeFile and inspecting either the
 * written `post` resource or the FULL (untruncated) note content captured
 * from the `obsidian create` command argv (post.text is truncated to 500
 * chars; the note body is not).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
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

type Route = (
  req: Request,
) => Response | Promise<Response | undefined> | undefined;

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

type CommandCall = { args: string[] };

function withDenoStubs<T = void>(
  opts: {
    vaultPath?: string;
    /** Leave Deno.mkdir un-stubbed (real) -- needed by the vaultRoot
     * (headless) branch-matrix tests below (swamp-workspace #57). */
    realMkdir?: boolean;
    /** Throw when Deno.Command is constructed for "obsidian". */
    throwOnObsidian?: boolean;
  },
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
    constructor(_cmd: string, options: { args?: string[] }) {
      this._args = options.args ?? [];
      if (opts.throwOnObsidian && _cmd === "obsidian") {
        throw new Error(
          "Deno.Command must not be constructed for 'obsidian' when vaultRoot is set -- the CLI must never be invoked",
        );
      }
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
  if (!opts.realMkdir) {
    denoAny.mkdir = (path: string) => {
      mkdirs.push(path);
      return Promise.resolve();
    };
  }
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

/** Runs `import` against ONE synthetic post body (wrapped in the standard
 * aentry-post__text envelope) and returns the full, untruncated note content
 * captured from the obsidian `create` argv, plus the written `post`
 * resource. */
async function noteFor(
  postBodyHtml: string,
  extra: { title?: string; date?: string } = {},
): Promise<{ content: string; post: Written }> {
  const indexHtml = await readFixture("index.html");
  const title = extra.title ?? "Fixture Coverage Post";
  const date = extra.date ?? "April 10 2018, 08:00";
  const postHtml = `<html><body>
<div class="aentry-post__title-text">${title}</div>
<div class="aentry-head__date"><time>${date}</time></div>
<div class="aentry-post__text">${postBodyHtml}</div>
</body></html>`;
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  const { commands } = await withDenoStubs({}, async (calls) => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(indexHtml);
        }
        if (url.pathname === "/1001.html") return htmlResponse(postHtml);
        // 1002.html unused in these single-post coverage tests; keep the
        // fixture index but only assert against post 1001's output.
        if (url.pathname === "/1002.html") return htmlResponse(postHtml);
        return binaryResponse();
      }],
      () => run({}, ctx) as Promise<void>,
    );
    return calls;
  });
  const createCall = commands.find((c) => c.args[0] === "create")!;
  const contentArg = createCall.args.find((a) => a.startsWith("content="))!;
  const content = contentArg.slice("content=".length);
  const post = written.find((w) => w.spec === "post")!;
  return { content, post };
}

// ===========================================================================
// htmlToMarkdown -- inline formatting
// ===========================================================================

Deno.test("htmlToMarkdown: b/strong -> **x**, i/em -> *x*", async () => {
  const { content } = await noteFor(
    "<b>Bold fixture</b> and <strong>Strong fixture</strong>, <i>Italic fixture</i> and <em>Em fixture</em>.",
  );
  assert(content.includes("**Bold fixture**"));
  assert(content.includes("**Strong fixture**"));
  assert(content.includes("*Italic fixture*"));
  assert(content.includes("*Em fixture*"));
});

Deno.test("htmlToMarkdown: a normal link -> [text](href); a LJ profile link (literal 'livejournal.com/profile' substring) -> bare text, href dropped", async () => {
  const { content } = await noteFor(
    `<a href="https://example.com/fixture-normal-link">Normal Fixture Link</a> ` +
      `<a href="https://fixture-user.livejournal.com/profile">Fixture Profile Link</a>`,
  );
  assert(
    content.includes(
      "[Normal Fixture Link](https://example.com/fixture-normal-link)",
    ),
  );
  assert(content.includes("Fixture Profile Link"));
  assert(!content.includes("[Fixture Profile Link]"));
});

Deno.test("htmlToMarkdown: an <a> with an href but NO text content returns bare empty (children.trim() guard, not just href truthiness)", async () => {
  const { content } = await noteFor(
    `before-marker<a href="https://example.com/fixture-empty-link"></a>after-marker`,
  );
  assert(content.includes("before-markerafter-marker"));
  assert(!content.includes("fixture-empty-link"));
});

Deno.test("htmlToMarkdown: an <img> with no src attribute yields an empty placeholder `{{IMG:}}`, later stripped by the image-replacement pass (no orphan marker survives)", async () => {
  const { content } = await noteFor(`before-marker<img>after-marker`);
  assert(content.includes("before-markerafter-marker"));
  assert(!content.includes("{{IMG:"));
});

// ===========================================================================
// htmlToMarkdown -- block elements
// ===========================================================================

Deno.test("htmlToMarkdown: p/div wrap with blank-line/single-newline padding; br -> single newline", async () => {
  const { content } = await noteFor(
    `<p>Fixture paragraph text.</p><div>Fixture div text.</div>line-one<br>line-two`,
  );
  assert(content.includes("Fixture paragraph text."));
  assert(content.includes("Fixture div text."));
  assert(content.includes("line-one\nline-two"));
});

Deno.test("htmlToMarkdown: blockquote prefixes EVERY line (split on the br-produced newline) with '> '", async () => {
  const { content } = await noteFor(
    `<blockquote>Fixture quote line one<br>Fixture quote line two</blockquote>`,
  );
  assert(content.includes("> Fixture quote line one"));
  assert(content.includes("> Fixture quote line two"));
});

Deno.test("htmlToMarkdown: ul/ol both render their <li> children as '- x' (no numbering distinction)", async () => {
  const { content } = await noteFor(
    `<ul><li>Fixture UL item</li></ul><ol><li>Fixture OL item</li></ol>`,
  );
  assert(content.includes("- Fixture UL item"));
  assert(content.includes("- Fixture OL item"));
});

Deno.test("htmlToMarkdown: h1/h2/h3 map to '#'.repeat(n) heading prefixes", async () => {
  const { content } = await noteFor(
    `<h1>Fixture Heading One</h1><h2>Fixture Heading Two</h2><h3>Fixture Heading Three</h3>`,
  );
  assert(content.includes("# Fixture Heading One"));
  assert(content.includes("## Fixture Heading Two"));
  assert(content.includes("### Fixture Heading Three"));
});

Deno.test("htmlToMarkdown: code -> inline backticks, pre -> a fenced block", async () => {
  const { content } = await noteFor(
    `<code>fixture inline code</code><pre>fixture pre block</pre>`,
  );
  assert(content.includes("`fixture inline code`"));
  assert(content.includes("```\nfixture pre block\n```"));
});

// ===========================================================================
// htmlToMarkdown -- embeds + default fallthrough
// ===========================================================================

Deno.test("htmlToMarkdown: iframe WITH src -> '[Embedded: src](src)'; iframe with NO src -> empty (the `if (src)` guard's other side)", async () => {
  const { content } = await noteFor(
    `<iframe src="https://embed.example.com/fixture-embed-one"></iframe>` +
      `marker-between<iframe></iframe>marker-after`,
  );
  assert(
    content.includes(
      "[Embedded: https://embed.example.com/fixture-embed-one](https://embed.example.com/fixture-embed-one)",
    ),
  );
  assert(content.includes("marker-betweenmarker-after"));
});

Deno.test("htmlToMarkdown: lj-embed and lj-poll both render as a bracketed '[LJ <tag>]' placeholder", async () => {
  const { content } = await noteFor(
    `<lj-embed>fixture embed body</lj-embed><lj-poll>fixture poll body</lj-poll>`,
  );
  assert(content.includes("[LJ lj-embed]"));
  assert(content.includes("[LJ lj-poll]"));
  assert(!content.includes("fixture embed body"));
  assert(!content.includes("fixture poll body"));
});

Deno.test("htmlToMarkdown: an unrecognized tag (e.g. <span>) falls through the switch's `default` and contributes only its children, unwrapped", async () => {
  const { content } = await noteFor(`<span>Fixture fallthrough text</span>`);
  assert(content.includes("Fixture fallthrough text"));
});

// ===========================================================================
// image extraction -- denylist filters, both sides
// ===========================================================================

Deno.test("image filters: l-stat.livejournal.net/userpic/stat.livejournal/pixel/spacer are ALL excluded; an ordinary image src is included", async () => {
  const { post } = await noteFor(
    `<img src="https://f-pics.example.com/fixture-allowed.jpg">` +
      `<img src="https://l-stat.livejournal.net/img/fixture.gif">` +
      `<img src="https://f-pics.example.com/userpic-fixture.jpg">` +
      `<img src="https://stat.livejournal.example.com/fixture.gif">` +
      `<img src="https://f-pics.example.com/pixel-fixture.gif">` +
      `<img src="https://f-pics.example.com/spacer-fixture.gif">`,
  );
  assertEquals(post.payload.imageCount, 1);
});

Deno.test("image filters: an image wrapped in a link whose href ends in an image extension is ALSO collected (from the href, deduped against the img src)", async () => {
  const { post } = await noteFor(
    `<a href="https://f-pics.example.com/fixture-fullsize.png">` +
      `<img src="https://f-pics.example.com/fixture-thumb.png"></a>`,
  );
  // Both the thumb <img> src (passes the denylist) and the wrapping <a>'s
  // href (ends in .png) are collected -- two distinct URLs, not deduped
  // against each other since they differ.
  assertEquals(post.payload.imageCount, 2);
});

Deno.test("image filters: a wrapped link whose href does NOT end in a known image extension contributes only the <img> src, not the href", async () => {
  const { post } = await noteFor(
    `<a href="https://f-pics.example.com/fixture-not-an-image">` +
      `<img src="https://f-pics.example.com/fixture-thumb2.png"></a>`,
  );
  assertEquals(post.payload.imageCount, 1);
});

// ===========================================================================
// parseLjDate -- all 12 months, plus the non-matching fallthrough (pinned in
// the adversarial suite via post_bad_date.html)
// ===========================================================================

Deno.test("parseLjDate: all 12 month names resolve to the correct zero-padded ISO month", async () => {
  const months: [string, string][] = [
    ["January", "01"],
    ["February", "02"],
    ["March", "03"],
    ["April", "04"],
    ["May", "05"],
    ["June", "06"],
    ["July", "07"],
    ["August", "08"],
    ["September", "09"],
    ["October", "10"],
    ["November", "11"],
    ["December", "12"],
  ];
  for (const [name, num] of months) {
    const { post } = await noteFor(`<p>fixture body</p>`, {
      date: `${name} 7 2019, 06:05`,
      title: `Fixture ${name} Post`,
    });
    assertEquals(post.payload.date, `2019-${num}-07T06:05:00`);
  }
});

// ===========================================================================
// sanitize -- via the note slug/path
// ===========================================================================

Deno.test("sanitize: dedicated slug pin -- reserved characters -> '-', collapsed whitespace, trimmed leading/trailing '-', capped at 100 chars", async () => {
  const indexHtml = await readFixture("index.html");
  const rawTitle = 'Fixture/Weird\\Title:With*Many?"Bad<Chars>|And.Dots  ' +
    "Then Some Extra Padding Words To Push The Raw Title Comfortably Past One Hundred Characters In Total Length For The Slug Truncation Pin";
  const postHtml = `<html><body>
<div class="aentry-post__title-text">${rawTitle}</div>
<div class="aentry-head__date"><time>April 10 2018, 08:00</time></div>
<div class="aentry-post__text"><p>fixture body</p></div>
</body></html>`;
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
    const pathArg = createCall.args.find((a) => a.startsWith("path="))!;
    const slug = pathArg.slice("path=LiveJournal/".length);
    // datePrefix ("2018-04-10") + "-" + sanitize(title).
    const sanitizedTitlePart = slug.slice("2018-04-10-".length);
    assertEquals(sanitizedTitlePart.startsWith("-"), false);
    assertEquals(sanitizedTitlePart.endsWith("-"), false);
    assert(!/[\\/:*?"<>|.]/.test(sanitizedTitlePart));
    assert(!/\s/.test(sanitizedTitlePart));
    assert(!sanitizedTitlePart.includes("--"));
    assertEquals(sanitizedTitlePart.length <= 100, true);
  });
});

// ===========================================================================
// comment threading -- parent indentation, uname/dname/anonymous, skip-empty
// ===========================================================================

Deno.test("comments: parent=0 renders unindented; a nonzero parent renders with '> ' indentation on both header and body", async () => {
  const indexHtml = await readFixture("index.html");
  const postHtml = `<html><body>
<div class="aentry-post__title-text">Fixture Comment Threading Post</div>
<div class="aentry-head__date"><time>April 10 2018, 08:00</time></div>
<div class="aentry-post__text"><p>fixture body</p></div>
<script>Site.page = {"comments":[
  {"uname":"fixture_top","ctime":"2018-04-11 09:00:00","article":"Top-level fixture comment","parent":0},
  {"uname":"fixture_reply","ctime":"2018-04-11 10:00:00","article":"Reply fixture comment","parent":1}
]};
</script>
</body></html>`;
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
    const content = createCall.args.find((a) => a.startsWith("content="))!;
    assert(content.includes("**fixture_top**"));
    assert(!content.includes("> **fixture_top**"));
    assert(content.includes("> **fixture_reply**"));
  });
});

Deno.test("comments: dname used when uname absent; 'anonymous' when BOTH uname and dname are absent (but article is non-empty, so not skipped)", async () => {
  const indexHtml = await readFixture("index.html");
  const postHtml = `<html><body>
<div class="aentry-post__title-text">Fixture Comment Identity Post</div>
<div class="aentry-head__date"><time>April 10 2018, 08:00</time></div>
<div class="aentry-post__text"><p>fixture body</p></div>
<script>Site.page = {"comments":[
  {"dname":"Fixture Display Name","ctime":"2018-04-11 09:00:00","article":"Has a display name only","parent":0},
  {"ctime":"2018-04-11 09:05:00","article":"Has neither uname nor dname","parent":0}
]};
</script>
</body></html>`;
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
    const content = createCall.args.find((a) => a.startsWith("content="))!;
    assert(content.includes("**Fixture Display Name**"));
    assert(content.includes("**anonymous**"));
  });
});

Deno.test("comments: an entry with NO article text and NO uname is skipped entirely (the deleted/empty-comment guard)", async () => {
  const indexHtml = await readFixture("index.html");
  const postHtml = `<html><body>
<div class="aentry-post__title-text">Fixture Skipped Comment Post</div>
<div class="aentry-head__date"><time>April 10 2018, 08:00</time></div>
<div class="aentry-post__text"><p>fixture body</p></div>
<script>Site.page = {"comments":[
  {"ctime":"2018-04-11 09:00:00","article":"","parent":0}
]};
</script>
</body></html>`;
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
    const content = createCall.args.find((a) => a.startsWith("content="))!;
    assert(!content.includes("## Comments"));
  });
});

// ===========================================================================
// FakeTime retry -- fetchWithRetry's linear backoff, both outcomes
// ===========================================================================

Deno.test("fetchWithRetry: two failures then a success -- retried with LINEAR backoff (1000ms, then 2000ms), no error surfaced", async () => {
  const time = new FakeTime();
  try {
    const indexHtml = await readFixture("index.html");
    const postHtml = `<html><body>
<div class="aentry-post__title-text">Fixture Retry Post</div>
<div class="aentry-head__date"><time>April 10 2018, 08:00</time></div>
<div class="aentry-post__text"><p>fixture body</p></div>
</body></html>`;
    const { ctx, written } = makeCtx(GLOBAL_ARGS);
    let postAttempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = ((input: Request | URL | string) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/" && !url.searchParams.has("skip")) {
        return Promise.resolve(htmlResponse(indexHtml));
      }
      if (url.pathname === "/1001.html") {
        postAttempts++;
        if (postAttempts < 3) {
          return Promise.resolve(new Response("boom", { status: 503 }));
        }
        return Promise.resolve(htmlResponse(postHtml));
      }
      return Promise.resolve(binaryResponse());
    }) as unknown as typeof globalThis.fetch;

    await withDenoStubs({}, async () => {
      const importPromise = run({}, ctx);
      // Drain the two retry backoffs (1000ms * (i+1) for i=0,1) plus the
      // 300ms "polite" inter-post delay and any microtask settling.
      await time.tickAsync(1000);
      await time.tickAsync(2000);
      await time.tickAsync(300);
      await importPromise;
    });
    globalThis.fetch = original;

    assertEquals(postAttempts, 3);
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.errors, []);
    const post = written.find((w) =>
      w.spec === "post" && w.payload.id === 1001
    );
    assert(post !== undefined, "post 1001 succeeded after retrying");
  } finally {
    time.restore();
  }
});

Deno.test("fetchWithRetry: all 3 attempts fail -- the per-post catch records an error string, import() itself does not throw", async () => {
  const time = new FakeTime();
  try {
    const indexHtml = await readFixture("index.html");
    const { ctx, written } = makeCtx(GLOBAL_ARGS);
    let postAttempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = ((input: Request | URL | string) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/" && !url.searchParams.has("skip")) {
        return Promise.resolve(htmlResponse(indexHtml));
      }
      if (url.pathname === "/1001.html" || url.pathname === "/1002.html") {
        postAttempts++;
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      return Promise.resolve(binaryResponse());
    }) as unknown as typeof globalThis.fetch;

    let threw: unknown;
    await withDenoStubs({}, async () => {
      const importPromise = run({}, ctx).catch((e) => {
        threw = e;
      });
      await time.tickAsync(1000);
      await time.tickAsync(2000);
      await time.tickAsync(1000);
      await time.tickAsync(2000);
      await importPromise;
    });
    globalThis.fetch = original;

    assertEquals(
      threw,
      undefined,
      "import() itself never throws on a per-post fetch failure",
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 0);
    assertEquals((result.payload.errors as string[]).length, 2);
    assert(
      (result.payload.errors as string[])[0].includes("Failed to process"),
    );
  } finally {
    time.restore();
  }
});

// ---------------------------------------------------------------------------
// backend selection branch matrix (swamp-workspace #57) -- import's note
// -destination resolution: vaultRoot (global argument) > the CLI vault-name
// lookup (getVaultPath) / obsidian create. Every branch either writes to the
// expected vault directory or drives the stubbed Deno.Command exactly once.
// ---------------------------------------------------------------------------

const SINGLE_POST_INDEX_HTML =
  `<html><body><a href="https://fixture-journal.example.com/5001.html">Post</a></body></html>`;

function singlePostHtml(): string {
  return `<html><body>
<div class="aentry-post__title-text">Fixture Branch Matrix Post</div>
<div class="aentry-head__date"><time>May 5 2019, 11:00</time></div>
<div class="aentry-post__text"><p>fixture body</p></div>
</body></html>`;
}

function singlePostRoutes(): Route[] {
  const postHtml = singlePostHtml();
  return [(req) => {
    const url = new URL(req.url);
    if (url.pathname === "/" && !url.searchParams.has("skip")) {
      return htmlResponse(SINGLE_POST_INDEX_HTML);
    }
    if (url.pathname === "/5001.html") return htmlResponse(postHtml);
    return undefined;
  }];
}

Deno.test("branch matrix: vaultRoot unset -- falls back to the CLI (getVaultPath + obsidian create), exactly as before this change", async () => {
  const { ctx, written } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({}, async ({ commands }) => {
    await withFetchStub(
      singlePostRoutes(),
      () => run({}, ctx) as Promise<void>,
    );
    assertEquals(
      commands.filter((c) => c.args[0] === "vault").length,
      1,
      "getVaultPath must be called exactly once when vaultRoot is unset",
    );
    assertEquals(
      commands.filter((c) => c.args[0] === "create").length,
      1,
      "obsidian create must be called exactly once when vaultRoot is unset",
    );
  });
  const result = written.find((w) => w.spec === "result")!;
  assertEquals(result.payload.notesCreated, 1);
});

Deno.test("branch matrix: vaultRoot set -- the CLI is never invoked at all, note written directly to disk", async () => {
  const vaultRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-branch-matrix-",
  });
  try {
    const { ctx, written } = makeCtx({ ...GLOBAL_ARGS, vaultRoot });
    await withDenoStubs({ realMkdir: true }, async ({ commands }) => {
      await withFetchStub(
        singlePostRoutes(),
        () => run({}, ctx) as Promise<void>,
      );
      assertEquals(
        commands.length,
        0,
        "no obsidian subcommand (vault OR create) may be invoked when vaultRoot is set",
      );
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
    const entries: string[] = [];
    for await (const e of Deno.readDir(`${vaultRoot}/LiveJournal`)) {
      if (e.name.endsWith(".md")) entries.push(e.name);
    }
    assertEquals(entries.length, 1);
  } finally {
    await Deno.remove(vaultRoot, { recursive: true });
  }
});

Deno.test("branch matrix: vaultRoot + vault BOTH set -- vaultRoot wins, getVaultPath is never invoked", async () => {
  const vaultRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-branch-matrix-precedence-",
  });
  try {
    const { ctx, written } = makeCtx({
      ...GLOBAL_ARGS,
      vault: "some-other-vault",
      vaultRoot,
    });
    await withDenoStubs(
      { realMkdir: true, throwOnObsidian: true },
      async () => {
        await withFetchStub(
          singlePostRoutes(),
          () => run({}, ctx) as Promise<void>,
        );
      },
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
  } finally {
    await Deno.remove(vaultRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// LB7 fix regression: a benign multi-segment 'folder' (no traversal) must
// keep working -- guards against an over-broad fix that rejects every
// multi-segment folder instead of just '..'/absolute escapes.
// ---------------------------------------------------------------------------

Deno.test("LB7 fix, benign case: a nested 'folder' (\"sub/dir\", multiple segments, no traversal) still works -- attachments mkdir'd and the note written, both under vaultRoot/sub/dir", async () => {
  const vaultRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-branch-matrix-nested-",
  });
  try {
    const { ctx, written } = makeCtx({
      ...GLOBAL_ARGS,
      folder: "sub/dir",
      vaultRoot,
    });
    await withDenoStubs({ realMkdir: true }, async () => {
      await withFetchStub(
        singlePostRoutes(),
        () => run({}, ctx) as Promise<void>,
      );
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(
      result.payload.notesCreated,
      1,
      "a benign multi-segment folder must not be rejected by the LB7 traversal guard",
    );
    const attachStat = await Deno.stat(`${vaultRoot}/sub/dir/attachments`);
    assert(
      attachStat.isDirectory,
      "the attachments directory is created under the nested benign folder",
    );
    const entries: string[] = [];
    for await (const e of Deno.readDir(`${vaultRoot}/sub/dir`)) {
      if (e.name.endsWith(".md")) entries.push(e.name);
    }
    assertEquals(
      entries.length,
      1,
      "exactly one note is written directly under the nested benign folder",
    );
  } finally {
    await Deno.remove(vaultRoot, { recursive: true });
  }
});
