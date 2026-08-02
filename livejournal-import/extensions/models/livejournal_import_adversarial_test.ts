/**
 * Adversarial suite: hostile/boundary inputs and a mechanical
 * fixtures-secret-scan over livejournal-import/fixtures/*.html.
 *
 * LB1 (SSRF via image src, HIGH) has been PROMOTED from a characterization
 * pin to a RED fix-spec: the LB1 section below now asserts the FIXED
 * behavior (an `isAllowedImageHost` host allowlist applied to both
 * image-collection paths in `parsePost`, plus `redirect:"manual"` +
 * per-hop re-validation on the download fetch) and is red against the
 * still-UNMODIFIED `livejournal_import.ts` until that fix lands -- this is
 * the fix's TDD RED phase, not a characterization of current behavior.
 *
 * LB7 (operator `folder`/`attachmentsFolder` path traversal on the
 * attachment disk write, LOW) has ALSO been PROMOTED from a characterization
 * pin to a fix-verification pin: the LB7 section below now asserts the FIXED
 * behavior -- the attachment disk path is resolved through the
 * already-copied string-level `resolveVaultPath` before the post loop, in
 * BOTH the vaultRoot and CLI-fallback branches, so a hostile `folder`/
 * `attachmentsFolder` now rejects the whole run fast with "Path escapes
 * vault root" / "Path is outside vault root" instead of the mkdir/write
 * silently landing outside the vault.
 *
 * LB2, LB3, LB4, LB5, LB6, LB8 are ALSO now FIXED (this change) -- every
 * section below for these six bugs asserts the FIXED behavior, not a
 * characterization of the old buggy behavior:
 *   LB2 YAML frontmatter injection via unescaped newlines (MEDIUM) --
 *   `yamlEscape` now escapes backslash/newline/CR/other-control chars (not
 *   just `"`) in title/mood/now_playing/tags, so injected sibling YAML keys
 *   are ABSENT from the parsed frontmatter.
 *   LB3 silent-empty success (MEDIUM) -- a zero-post index now logs a
 *   distinct "no posts found" warning (logger-only; `result.errors` stays
 *   `[]`).
 *   LB4 no fetch/subprocess timeout (MEDIUM) -- every fetch and both
 *   `Deno.Command` invocations now carry a `timeoutMs`-bounded
 *   `AbortController`/`signal` (new backward-compatible global arg,
 *   default 30000).
 *   LB5 unbounded pagination/memory (MEDIUM) -- `collectPostUrls` now stops
 *   at a `maxPages` cap (new backward-compatible global arg, default 1000)
 *   and logs a distinct cap-warning.
 *   LB6 fragile comment-JSON extraction (LOW) -- the `Site.page` blob is now
 *   located via a string-aware balanced-brace scan (not a regex requiring a
 *   literal `};` terminator), and a `commentParseFailed` flag drives a
 *   distinct logged warning on a genuine parse failure.
 *   LB8 parseLjDate silent fallthrough (LOW) -- a non-matching date string
 *   now resolves to the safe, colon/space-free `"unknown"` sentinel (not a
 *   raw pass-through), with a distinct logged warning.
 *   All are tracked in the LOCAL `livejournal-import-latent-bugs`
 *   issue-lifecycle model (NEVER filed to the swamp.club Lab -- see
 *   CLAUDE.md's anti-bypass rule). LB1 (SSRF, already fixed in 2026.07.31.1)
 *   and LB7 (path traversal, already fixed in 2026.08.02.1) are untouched by
 *   this change.
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
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { parse as parseYaml } from "jsr:@std/yaml@1";
import { model, resolveVaultPathSafe } from "./livejournal_import.ts";

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
  opts: {
    vaultPath?: string;
    /** Leave Deno.mkdir un-stubbed (real) -- needed by the vaultRoot
     * (headless) path-confinement tests below (swamp-workspace #57). */
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
    constructor(_cmd: string, options: Record<string, unknown>) {
      this._args = (options.args as string[]) ?? [];
      if (opts.throwOnObsidian && _cmd === "obsidian") {
        throw new Error(
          "Deno.Command must not be constructed for 'obsidian' when vaultRoot is set -- the CLI must never be invoked",
        );
      }
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
          // Allowlisted relay host (post_ssrf.html) that 30x-redirects to a
          // documentation-only (RFC 5737 TEST-NET-3) internal target -- used
          // by the redirect-hop-rejection test below. redirect:"manual" on
          // the real fetch call means this raw 3xx is returned as-is, never
          // auto-followed.
          if (url.pathname === "/fixture-redirect-relay.jpg") {
            return new Response(null, {
              status: 302,
              headers: {
                Location:
                  "https://203.0.113.7/fixture-redirect-internal-target",
              },
            });
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

// A single-post index (matches the property suite's convention) so the
// isAllowedImageHost/redirect-hardening tests below process the post body
// exactly ONCE -- no doubled fetch/write counts to account for.
const SINGLE_POST_INDEX_HTML =
  `<html><body><a href="https://fixture-journal.example.com/9001.html">Fixture Single Post</a></body></html>`;

/** Runs `import` against ONE inline post body under a single-post index.
 * `extraRoutes` are consulted BEFORE the generic index/post/binary fallback,
 * so a caller can special-case an image URL (e.g. to return a redirect). */
async function runInlinePostImport(
  postBodyHtml: string,
  extraRoutes: Route[] = [],
) {
  const postHtml = `<html><body>
<div class="aentry-post__title-text">Fixture Inline Post</div>
<div class="aentry-head__date"><time>June 6 2013, 09:00</time></div>
<div class="aentry-post__text">${postBodyHtml}</div>
</body></html>`;
  const { ctx, written, logs } = makeCtx(GLOBAL_ARGS);
  const fetchCalls: { req: Request; init: RequestInit | undefined }[] = [];
  const denoResult = await withDenoStubs(
    {},
    async ({ commands, mkdirs, writes }) => {
      await withFetchStub(
        [
          ...extraRoutes,
          (req) => {
            const url = new URL(req.url);
            if (url.pathname === "/" && !url.searchParams.has("skip")) {
              return htmlResponse(SINGLE_POST_INDEX_HTML);
            }
            if (url.pathname === "/9001.html") return htmlResponse(postHtml);
            return binaryResponse();
          },
        ],
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

Deno.test("pin (livejournal-import-latent-bugs LB1, HIGH -- FIXED): an image src pointing at a cloud-metadata / loopback-admin target is REJECTED by the host allowlist and never fetched", async () => {
  const { fetchCalls, written } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_ssrf.html",
  );
  const imageUrls = fetchCalls
    .map((c) => c.req.url)
    .filter((u) => !u.includes("fixture-journal.example.com"));
  assert(
    !imageUrls.some((u) => new URL(u).hostname === "169.254.169.254"),
    "the cloud-metadata-shaped target must NEVER be fetched",
  );
  assert(
    !imageUrls.some((u) => {
      const parsed = new URL(u);
      return parsed.hostname === "127.0.0.1" && parsed.port === "8200";
    }),
    "the loopback admin-shaped target must NEVER be fetched",
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(
    post.payload.imageCount,
    0,
    "every image in this fixture is rejected -- the two IP-literal targets outright, the allowlisted relay via its redirect target",
  );
});

Deno.test('isAllowedImageHost hardening: an allowlisted relay host that 30x-redirects to an RFC 5737 documentation-only internal target is fetched at the relay hop with redirect:"manual", but the internal target is NEVER fetched and no attachment is written', async () => {
  const { fetchCalls, writes } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_ssrf.html",
  );
  // index.html links two posts (1001.html, 1002.html) and runSinglePostImport
  // routes both to the same post_ssrf.html fixture, so the relay hop is hit
  // once per post -- twice total, never more (no further hop is attempted
  // past the relay since its redirect target is rejected).
  const relayCalls = fetchCalls.filter((c) =>
    c.req.url.includes("fixture-redirect-relay.jpg")
  );
  assertEquals(
    relayCalls.length,
    2,
    "the allowlisted relay host IS fetched exactly once per post",
  );
  for (const call of relayCalls) {
    assertEquals(
      call.init?.redirect,
      "manual",
      "EVERY relay fetch must disable automatic redirect-follow so the Location can be re-validated",
    );
  }
  const internalCalls = fetchCalls.filter((c) =>
    c.req.url.includes("203.0.113.7")
  );
  assertEquals(
    internalCalls.length,
    0,
    "the RFC 5737 redirect target must NEVER be fetched",
  );
  assertEquals(
    writes.length,
    0,
    "no attachment is written -- every candidate image in this fixture is rejected outright or via its redirect target",
  );
});

Deno.test("isAllowedImageHost: allows hosts sharing the journal's registrable domain and the static *.livejournal.com/*.livejournal.net media suffixes; rejects a foreign domain, a suffix-confusable host, and a non-http(s) scheme", async () => {
  const { written, fetchCalls } = await runInlinePostImport(
    `<img src="https://f-pics.example.com/fixture-same-apex.jpg" alt="same registrable domain as the journal">` +
      `<img src="https://pics.livejournal.com/fixture-lj-com-cdn.jpg" alt="static .com LJ media suffix">` +
      `<img src="https://media.livejournal.net/fixture-lj-net-cdn.jpg" alt="static .net LJ media suffix">` +
      `<img src="https://cdn.fixture-unrelated-host.test/fixture-foreign.jpg" alt="foreign domain, must be rejected">` +
      `<img src="https://livejournal.com.fixture-attacker.test/fixture-suffix-confusion.jpg" alt="contains livejournal.com as a PREFIX, not a suffix -- must be rejected">` +
      `<img src="ftp://cdn.fixture-ftp-host.test/fixture-non-http-scheme.jpg" alt="non-http(s) scheme, must be rejected">`,
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(
    post.payload.imageCount,
    3,
    "the same-apex host and BOTH static LJ suffixes (.com and .net) are allowed through; the foreign domain, the suffix-confusable host, and the non-http(s) scheme are rejected before any fetch is attempted",
  );
  // A bare count can't catch a wrong-but-count-preserving flip (e.g.
  // incorrectly rejecting the same-apex host while incorrectly allowing the
  // ftp:// scheme) -- assert WHICH hosts were actually fetched, by identity.
  assert(
    fetchCalls.some((c) => c.req.url.includes("fixture-same-apex")),
    "the same-apex host IS fetched",
  );
  assert(
    fetchCalls.some((c) => c.req.url.includes("fixture-lj-com-cdn")),
    "the static .com LJ media suffix host IS fetched",
  );
  assert(
    fetchCalls.some((c) => c.req.url.includes("fixture-lj-net-cdn")),
    "the static .net LJ media suffix host IS fetched",
  );
  assert(
    !fetchCalls.some((c) => c.req.url.includes("fixture-foreign")),
    "the foreign domain must NEVER be fetched",
  );
  assert(
    !fetchCalls.some((c) => c.req.url.includes("fixture-suffix-confusion")),
    "a host that merely CONTAINS 'livejournal.com' as a prefix segment (livejournal.com.fixture-attacker.test) must NEVER be fetched -- an unanchored .includes() or missing dot-boundary check would let this through",
  );
  assert(
    !fetchCalls.some((c) => c.req.url.includes("fixture-non-http-scheme")),
    "the non-http(s) scheme must NEVER be fetched",
  );
});

Deno.test("isAllowedImageHost: rejects IP-literal hosts in decimal, hex, and bracketed IPv6/IPv4-mapped form -- not just dotted-decimal", async () => {
  // Decimal/hex-encoded IPv4 are normalized to dotted-decimal by the WHATWG
  // URL parser itself (new URL("http://2852039166/x").hostname ===
  // "169.254.169.254"), so a correct implementation that parses via
  // `new URL()` (rather than substring-matching the raw text) already closes
  // those two for free -- included here as an explicit regression pin, not
  // because they need separate parsing logic. The bracketed IPv6/IPv4-mapped
  // cases exercise a genuinely distinct branch (hostname contains a colon).
  const { written, fetchCalls } = await runInlinePostImport(
    `<img src="http://2852039166/fixture-decimal-encoded.jpg" alt="decimal-encoded 169.254.169.254">` +
      `<img src="http://0xA9FEA9FE/fixture-hex-encoded.jpg" alt="hex-encoded 169.254.169.254">` +
      `<img src="http://[::1]/fixture-ipv6-loopback.jpg" alt="IPv6 loopback">` +
      `<img src="http://[::ffff:127.0.0.1]/fixture-ipv4-mapped.jpg" alt="IPv4-mapped IPv6 loopback">`,
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(
    post.payload.imageCount,
    0,
    "decimal, hex, IPv6-loopback, and IPv4-mapped-IPv6 hosts must ALL be rejected, not just dotted-decimal IPv4",
  );
  // fetchCalls always contains the unavoidable index-page ("/") and
  // post-page ("/9001.html") fetches, so it can never be empty -- scope the
  // check to the four candidate image URLs specifically (same pattern as the
  // wrapped-<a href> test below), not the whole call list.
  assert(
    !fetchCalls.some((c) =>
      c.req.url.includes("fixture-decimal-encoded") ||
      c.req.url.includes("fixture-hex-encoded") ||
      c.req.url.includes("fixture-ipv6-loopback") ||
      c.req.url.includes("fixture-ipv4-mapped")
    ),
    "none of these IP-literal-shaped hosts should ever be fetched -- rejected in parsePost before any download is attempted",
  );
});

Deno.test("journalApex: a trailing-dot (FQDN-notation) journalUrl does not collapse the derived apex to a bare TLD-plus-dot -- same-apex hosts stay allowed, foreign hosts stay rejected", async () => {
  // Regression pin: an unstripped trailing dot on the journal hostname
  // (e.g. "fixture-journal.example.com.", a syntactically valid FQDN form)
  // would otherwise produce an empty final label after split("."), causing
  // journalApex's last-two-labels slice to collapse to "com." -- which
  // EVERY *.com. host would then match, defeating the allowlist entirely.
  const trailingDotArgs = {
    ...GLOBAL_ARGS,
    journalUrl: "https://fixture-journal.example.com./",
  };
  const indexHtml =
    `<html><body><a href="https://fixture-journal.example.com./9001.html">Fixture Single Post</a></body></html>`;
  const postHtml = `<html><body>
<div class="aentry-post__title-text">Fixture Trailing-Dot Post</div>
<div class="aentry-head__date"><time>July 7 2014, 10:00</time></div>
<div class="aentry-post__text">
<img src="https://f-pics.example.com/fixture-same-apex-trailing-dot.jpg" alt="same apex as the trailing-dot journal, must stay ALLOWED">
<img src="https://cdn.fixture-unrelated-host.test/fixture-foreign-trailing-dot.jpg" alt="foreign host, must stay REJECTED -- a collapsed apex bug would over-match any .test/.com-suffixed host">
</div>
</body></html>`;
  const { ctx, written } = makeCtx(trailingDotArgs);
  await withDenoStubs({}, async () => {
    await withFetchStub(
      [(req) => {
        const url = new URL(req.url);
        if (url.pathname === "/" && !url.searchParams.has("skip")) {
          return htmlResponse(indexHtml);
        }
        if (url.pathname === "/9001.html") return htmlResponse(postHtml);
        return binaryResponse();
      }],
      () => run({}, ctx) as Promise<void>,
    );
  });
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(
    post.payload.imageCount,
    1,
    "the trailing-dot journalUrl must still derive the 'example.com' apex correctly: the same-apex host is allowed, the foreign host stays rejected",
  );
});

Deno.test("SSRF via the wrapped <a href> image path (previously UNGUARDED): an href pointing at a cloud-metadata / loopback / foreign-domain target is rejected exactly like a bare <img src>", async () => {
  const { written, fetchCalls } = await runInlinePostImport(
    `<a href="http://169.254.169.254/fixture-wrapped-meta.jpg"><img src="https://f-pics.example.com/fixture-thumb-a.jpg"></a>` +
      `<a href="https://cdn.fixture-unrelated-host.test/fixture-wrapped-foreign.jpg"><img src="https://f-pics.example.com/fixture-thumb-b.jpg"></a>`,
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(
    post.payload.imageCount,
    2,
    "only the two benign <img src> thumbs are allowed through; both malicious wrapping hrefs are rejected",
  );
  assert(
    !fetchCalls.some((c) => c.req.url.includes("169.254.169.254")),
    "the wrapped-link cloud-metadata href must NEVER be fetched",
  );
  assert(
    !fetchCalls.some((c) => c.req.url.includes("fixture-unrelated-host.test")),
    "the wrapped-link foreign-domain href must NEVER be fetched",
  );
});

Deno.test("redirect hardening (positive case): an allowlisted relay that 30x-redirects to ANOTHER allowlisted host is followed and downloaded -- hardening re-validates per hop, it does not blanket-reject every redirect", async () => {
  const { written, fetchCalls } = await runInlinePostImport(
    `<img src="https://f-pics.example.com/fixture-redirect-to-allowed.jpg" alt="redirects to another allowed host">`,
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/fixture-redirect-to-allowed.jpg") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://pics.livejournal.com/fixture-redirect-final.jpg",
          },
        });
      }
      return undefined;
    }],
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(
    post.payload.imageCount,
    1,
    "the redirect to an ALLOWED final host must be followed and the image downloaded",
  );
  const finalCalls = fetchCalls.filter((c) =>
    c.req.url.includes("fixture-redirect-final.jpg")
  );
  assert(
    finalCalls.length > 0,
    "the final allowed target must actually be fetched -- proves per-hop re-validation runs, rather than every redirect being blanket-rejected",
  );
  const firstHopCalls = fetchCalls.filter((c) =>
    c.req.url.includes("fixture-redirect-to-allowed.jpg")
  );
  for (const call of [...firstHopCalls, ...finalCalls]) {
    assertEquals(
      call.init?.redirect,
      "manual",
      "every hop's fetch (relay AND the final followed target) must disable automatic redirect-follow",
    );
  }
});

Deno.test("redirect hardening: a multi-hop chain through allowed hosts that ultimately redirects to a rejected internal target is rejected at the final hop, not silently truncated early", async () => {
  const { written, fetchCalls } = await runInlinePostImport(
    `<img src="https://f-pics.example.com/fixture-hop-1.jpg">`,
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/fixture-hop-1.jpg") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://pics.livejournal.com/fixture-hop-2.jpg",
          },
        });
      }
      if (url.pathname === "/fixture-hop-2.jpg") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://203.0.113.9/fixture-hop-3-internal-target.jpg",
          },
        });
      }
      return undefined;
    }],
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(
    post.payload.imageCount,
    0,
    "the chain is rejected once a hop resolves to the internal target, even though the earlier hops were allowed",
  );
  const hop1Calls = fetchCalls.filter((c) =>
    c.req.url.includes("fixture-hop-1.jpg")
  );
  const hop2Calls = fetchCalls.filter((c) =>
    c.req.url.includes("fixture-hop-2.jpg")
  );
  assert(hop1Calls.length > 0, "hop 1 (allowed) IS fetched");
  assert(hop2Calls.length > 0, "hop 2 (allowed) IS fetched");
  for (const call of [...hop1Calls, ...hop2Calls]) {
    assertEquals(
      call.init?.redirect,
      "manual",
      "EVERY hop's fetch must disable automatic redirect-follow, not just the first",
    );
  }
  assert(
    !fetchCalls.some((c) => c.req.url.includes("203.0.113.9")),
    "hop 3 (the rejected internal target) is NEVER fetched",
  );
});

Deno.test("redirect hardening (positive multi-hop case): a chain of THREE allowed-host redirects terminating at a fourth allowed host is followed all the way through -- proves per-hop revalidation is not hard-capped at a fixed small depth", async () => {
  const { written, fetchCalls } = await runInlinePostImport(
    `<img src="https://f-pics.example.com/fixture-multi-hop-1.jpg">`,
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/fixture-multi-hop-1.jpg") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://pics.livejournal.com/fixture-multi-hop-2.jpg",
          },
        });
      }
      if (url.pathname === "/fixture-multi-hop-2.jpg") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://media.livejournal.net/fixture-multi-hop-3.jpg",
          },
        });
      }
      if (url.pathname === "/fixture-multi-hop-3.jpg") {
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://images2.example.com/fixture-multi-hop-4-final.jpg",
          },
        });
      }
      return undefined;
    }],
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(
    post.payload.imageCount,
    1,
    "a chain through THREE allowed hosts terminating at a fourth allowed host must be followed to completion and downloaded -- rules out a hardcoded 1- or 2-redirect cap",
  );
  // Includes the TERMINAL (4th, non-redirecting) hop -- an implementation
  // that manually re-validates hops 1-3 but then issues one final unguarded
  // fetch() for the actual download would otherwise pass every assertion
  // here unnoticed.
  const hopUrlFragments = [
    "fixture-multi-hop-1.jpg",
    "fixture-multi-hop-2.jpg",
    "fixture-multi-hop-3.jpg",
    "fixture-multi-hop-4-final.jpg",
  ];
  for (const fragment of hopUrlFragments) {
    const hopCalls = fetchCalls.filter((c) => c.req.url.includes(fragment));
    assert(hopCalls.length > 0, `${fragment} (allowed) IS fetched`);
    for (const call of hopCalls) {
      assertEquals(
        call.init?.redirect,
        "manual",
        `the fetch for ${fragment} must disable automatic redirect-follow, not just the first hop's`,
      );
    }
  }
});

// ===========================================================================
// LB2 YAML frontmatter injection via unescaped newlines -- MEDIUM
// ===========================================================================

Deno.test('pin (livejournal-import-latent-bugs LB2, MEDIUM -- FIXED): title/mood/now_playing/tags now escape embedded newlines (and backslash/CR/other control chars), not just `"` -- injected sibling YAML keys are ABSENT from the parsed frontmatter, and title round-trips through the double-quoted scalar', async () => {
  const { written, commands } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_injection.html",
  );
  // The raw `post` RESOURCE field is untouched by the LB2 fix -- it is not
  // YAML, just a data field, and legitimately keeps the raw embedded
  // newline. The FIX is scoped to the frontmatter the fix targets: the note
  // content captured from the `obsidian create` command's `content=` arg.
  const post = written.find((w) => w.spec === "post")!;
  assert(
    (post.payload.title as string).includes("\n"),
    "post.title (the raw resource field, not YAML) still retains the embedded newline verbatim -- unaffected by the frontmatter-only LB2 fix",
  );

  const createCall = commands.find((c) => c.args[0] === "create")!;
  const contentArg = createCall.args.find((a) => a.startsWith("content="))!;
  const content = contentArg.slice("content=".length);
  const lines = content.split("\n");
  const closeIdx = lines.indexOf("---", 1);
  const frontmatterYaml = lines.slice(1, closeIdx).join("\n");
  // deno-lint-ignore no-explicit-any
  const fm = parseYaml(frontmatterYaml) as Record<string, any>;

  assertEquals(
    "and" in fm,
    false,
    "the injected sibling key 'and' (from the title's embedded newline) must be ABSENT from the parsed frontmatter",
  );
  assertEquals(
    "injected" in fm,
    false,
    "the injected sibling key 'injected' (from the tag's embedded newline) must be ABSENT from the parsed frontmatter",
  );
  assert(
    (fm.mood as string).includes("mood: injected"),
    "the injected 'mood: injected' text stays INSIDE the mood scalar's own value, not promoted to a sibling key",
  );
  assert(
    (fm.now_playing as string).includes("now_playing: injected-track"),
    "the injected 'now_playing: injected-track' text stays INSIDE the now_playing scalar's own value",
  );
  assertEquals(
    fm.title,
    'Fixture Title with "quotes"\nand: a folded line',
    "title round-trips byte-for-byte through the escape (write) / YAML-parse (read) round trip -- the embedded newline survives via the \\n escape, restored on parse",
  );
});

// ===========================================================================
// LB3 silent-empty success -- MEDIUM
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB3, MEDIUM -- FIXED): an index with zero collectible post urls now logs a DISTINCT 'no posts found' warning, alongside the ordinary 'Import complete' completion log -- result.errors stays [] (logger-only, not an error)", async () => {
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
  assertEquals(
    result.payload.errors,
    [],
    "the zero-posts warning is logger-only -- result.errors must stay empty",
  );
  assert(
    logs.some((l) =>
      l.includes("Import complete: 0 notes, 0 images. Errors: 0")
    ),
    "the ordinary completion log line is unchanged",
  );
  assert(
    logs.some((l) => /no posts|0 posts/i.test(l)),
    "a DISTINCT zero-posts warning must now be logged, not just the ordinary completion line",
  );
});

// ===========================================================================
// LB4 no fetch/subprocess timeout -- MEDIUM
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB4, MEDIUM -- FIXED): every index/post fetch and every image fetch now passes an AbortSignal (timeoutMs-bounded)", async () => {
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
    assert(
      init?.signal instanceof AbortSignal,
      "every fetch must carry a real AbortSignal",
    );
  }
});

Deno.test("pin (livejournal-import-latent-bugs LB4 -- FIXED): Deno.Command for the obsidian CLI is now constructed with a real AbortSignal option", async () => {
  const indexHtml = await readFixture("index_empty.html");
  const { ctx } = makeCtx(GLOBAL_ARGS);
  await withDenoStubs({}, async ({ commands }) => {
    await withFetchStub(
      [() => htmlResponse(indexHtml)],
      () => run({}, ctx) as Promise<void>,
    );
    assert(
      commands.length > 0,
      "sanity: at least one Deno.Command call happened",
    );
    for (const c of commands) {
      assertEquals("signal" in c.options, true);
      assert(
        c.options.signal instanceof AbortSignal,
        "the Deno.Command signal option must be a real AbortSignal",
      );
    }
  });
});

Deno.test("pin (livejournal-import-latent-bugs LB4 -- FIXED, regression): a tiny timeoutMs plus a never-resolving image fetch aborts and records a per-post error, without crashing the whole run", async () => {
  const args = { ...GLOBAL_ARGS, timeoutMs: 200 };
  const postHtml = `<html><body>
<div class="aentry-post__title-text">Fixture Timeout Post</div>
<div class="aentry-head__date"><time>June 6 2013, 09:00</time></div>
<div class="aentry-post__text"><img src="https://f-pics.example.com/fixture-never-resolves.jpg"></div>
</body></html>`;
  const { ctx, written } = makeCtx(args);
  await withDenoStubs({}, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((
      input: Request | URL | string,
      init?: RequestInit,
    ) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/" && !url.searchParams.has("skip")) {
        return Promise.resolve(htmlResponse(SINGLE_POST_INDEX_HTML));
      }
      if (url.pathname === "/9001.html") {
        return Promise.resolve(htmlResponse(postHtml));
      }
      // The image fetch NEVER resolves on its own -- only the timeoutMs
      // AbortController can end it. Presence-based assertions only (no
      // real-clock waits beyond timeoutMs itself), per the plan's flake
      // guidance.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(
              new DOMException("The signal has been aborted", "AbortError"),
            );
          });
        }
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      await run({}, ctx);
    } finally {
      globalThis.fetch = original;
    }
  });
  const result = written.find((w) => w.spec === "result")!;
  assertEquals(
    result.payload.notesCreated,
    1,
    "the post itself still completes -- only the image download fails",
  );
  const errors = result.payload.errors as string[];
  assert(
    errors.some((e) => e.includes("Image download failed")),
    "the aborted image fetch must be recorded as a per-post error, not left hanging or crashing the run",
  );
});

// ===========================================================================
// LB5 unbounded pagination/memory -- MEDIUM
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB5, MEDIUM -- FIXED): collectPostUrls now stops at the maxPages cap, even though the server keeps offering more `skip=N` markers -- and logs a distinct cap-warning", async () => {
  // The harness offers PAGE_CAP=12 pages (unchanged from the original
  // characterization), but maxPages=3 is now set explicitly -- the source
  // itself must stop after 3 pages, not the harness.
  const PAGE_CAP = 12;
  const args = { ...GLOBAL_ARGS, maxPages: 3 };
  const { ctx, written, logs } = makeCtx(args);
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
  assertEquals(
    indexFetches,
    3,
    "exactly maxPages (3) index pages must be fetched, not all 12 the harness offers",
  );
  const result = written.find((w) => w.spec === "result")!;
  assertEquals(result.payload.totalPosts, 3);
  assert(
    logs.some((l) => /maxpages|page cap/i.test(l)),
    "a distinct cap-warning must be logged when the maxPages cap is hit",
  );
});

// ===========================================================================
// LB6 fragile comment-JSON extraction -- LOW
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB6, LOW -- FIXED): a corrupted `Site.page` blob still resolves comments to zero (no throw, no error entry) -- but a distinct warning is now logged instead of pure silence", async () => {
  const { written, logs } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_bad_comments.html",
  );
  const post = written.find((w) => w.spec === "post")!;
  const result = written.find((w) => w.spec === "result")!;
  assertEquals(
    result.payload.errors,
    [],
    "the comment-parse-failure warning is logger-only -- result.errors stays empty",
  );
  assertEquals((post.payload.text as string).includes("## Comments"), false);
  assert(
    logs.some((l) => /comment.*(fail|omit)/i.test(l)),
    "a distinct warning must now be logged when the comments JSON fails to parse",
  );
});

// ===========================================================================
// LB7 operator `folder` path traversal on disk write -- LOW -- FIXED
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB7, LOW -- FIXED): a `folder` global argument containing `..` segments is REJECTED before it reaches the attachment disk path (CLI-fallback branch, no vaultRoot)", async () => {
  const args = { ...GLOBAL_ARGS, folder: "../../fixture-escape-target" };
  const indexHtml = await readFixture("index.html");
  const postHtml = await readFixture("post_full.html");
  const { ctx } = makeCtx(args);
  await withDenoStubs({}, async ({ mkdirs, writes }) => {
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
      async () => {
        await assertRejects(
          () => run({}, ctx) as Promise<void>,
          Error,
          "Path escapes vault root",
        );
      },
    );
    assert(
      mkdirs.every((m) => !m.includes("fixture-escape-target")),
      "the guard fires before the attachment mkdir ever runs -- no mkdir call may carry the escaped path",
    );
    assert(
      writes.every((w) => !w.path.includes("fixture-escape-target")),
      "the guard fires before any attachment write -- no write call may carry the escaped path",
    );
  });
});

Deno.test('pin (livejournal-import-latent-bugs LB7, LOW -- FIXED): an absolute `folder` (e.g. "/etc/lj-escape") is REJECTED before it reaches the attachment disk path (CLI-fallback branch, no vaultRoot)', async () => {
  const args = { ...GLOBAL_ARGS, folder: "/etc/lj-escape" };
  const indexHtml = await readFixture("index.html");
  const postHtml = await readFixture("post_full.html");
  const { ctx } = makeCtx(args);
  await withDenoStubs({}, async ({ mkdirs, writes }) => {
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
      async () => {
        await assertRejects(
          () => run({}, ctx) as Promise<void>,
          Error,
          "Path is outside vault root",
        );
      },
    );
    assert(
      mkdirs.every((m) => !m.includes("lj-escape")),
      "the guard fires before the attachment mkdir ever runs -- no mkdir call may carry the escaped absolute path",
    );
    assert(
      writes.every((w) => !w.path.includes("lj-escape")),
      "the guard fires before any attachment write -- no write call may carry the escaped absolute path",
    );
  });
});

// ===========================================================================
// path confinement (vaultRoot note-write destination, swamp-workspace #57) --
// resolveVaultPathSafe, copied verbatim from
// obsidian-vault/extensions/models/obsidian_vault.ts (PR #56). This guard
// was originally applied ONLY to the note write when vaultRoot is set; the
// attachment disk path now ALSO goes through path confinement (via the
// already-copied string-level resolveVaultPath, applied before the post
// loop) -- LB7 is FIXED in both the CLI-fallback branch and the vaultRoot
// branch.
// ===========================================================================

Deno.test("path confinement: a '../'-relative 'folder' rejects the run via resolveVaultPath BEFORE any attachment mkdir, when vaultRoot is set (LB7's attachDiskPath mkdir is now ALSO rejected -- LB7 FIXED)", async () => {
  const postHtml = await readFixture("post_full.html");
  const sandboxRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-confinement-sandbox-",
  });
  const vaultRoot = `${sandboxRoot}/vault`;
  await Deno.mkdir(vaultRoot, { recursive: true });
  try {
    const { ctx } = makeCtx({
      ...GLOBAL_ARGS,
      folder: "../escaped",
      vaultRoot,
    });
    await withDenoStubs({ realMkdir: true }, async () => {
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/" && !url.searchParams.has("skip")) {
            return htmlResponse(SINGLE_POST_INDEX_HTML);
          }
          if (url.pathname === "/9001.html") return htmlResponse(postHtml);
          return undefined;
        }],
        async () => {
          await assertRejects(
            () => run({}, ctx) as Promise<void>,
            Error,
            "Path escapes vault root",
          );
        },
      );
    });
    // LB7 FIXED: the attachment mkdir must never have run at all -- the
    // whole escape-target directory must be ABSENT, not merely empty. This
    // is the load-bearing, non-vacuous check that the guard fired before
    // Deno.mkdir, not after it already created the directory.
    let escapedExists = true;
    try {
      await Deno.stat(`${sandboxRoot}/escaped`);
    } catch {
      escapedExists = false;
    }
    assert(
      !escapedExists,
      "sandboxRoot/escaped must not exist at all -- the attachment mkdir never ran",
    );
  } finally {
    await Deno.remove(sandboxRoot, { recursive: true });
  }
});

Deno.test("path confinement: an absolute 'folder' (e.g. \"/etc/lj-escape\"-shaped) rejects the run via resolveVaultPath BEFORE any attachment mkdir, when vaultRoot is set (LB7 FIXED, absolute-path variant)", async () => {
  const postHtml = await readFixture("post_full.html");
  const sandboxRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-confinement-absolute-",
  });
  const vaultRoot = `${sandboxRoot}/vault`;
  const outsideRoot = `${sandboxRoot}/outside`;
  await Deno.mkdir(vaultRoot, { recursive: true });
  try {
    const { ctx } = makeCtx({
      ...GLOBAL_ARGS,
      folder: `${outsideRoot}/lj-escape`,
      vaultRoot,
    });
    await withDenoStubs({ realMkdir: true }, async () => {
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/" && !url.searchParams.has("skip")) {
            return htmlResponse(SINGLE_POST_INDEX_HTML);
          }
          if (url.pathname === "/9001.html") return htmlResponse(postHtml);
          return undefined;
        }],
        async () => {
          await assertRejects(
            () => run({}, ctx) as Promise<void>,
            Error,
            "Path is outside vault root",
          );
        },
      );
    });
    // LB7 FIXED (absolute-path variant): the escape target must never have
    // been created at all -- non-vacuous proof the attachment mkdir never
    // ran with the absolute, out-of-vault path.
    let outsideExists = true;
    try {
      await Deno.stat(outsideRoot);
    } catch {
      outsideExists = false;
    }
    assert(
      !outsideExists,
      "the absolute-path escape target must not exist at all -- the attachment mkdir never ran",
    );
  } finally {
    await Deno.remove(sandboxRoot, { recursive: true });
  }
});

Deno.test("path confinement: a symlinked 'folder' path segment is refused via realpath for the note write, not silently followed", async () => {
  const postHtml = await readFixture("post_full.html");
  const vaultRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-symlink-vault-",
  });
  const outside = await Deno.makeTempDir({
    prefix: "livejournal-import-symlink-outside-",
  });
  try {
    await Deno.symlink(outside, `${vaultRoot}/LiveJournal`);
    const { ctx, written } = makeCtx({ ...GLOBAL_ARGS, vaultRoot });
    await withDenoStubs({ realMkdir: true }, async () => {
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/" && !url.searchParams.has("skip")) {
            return htmlResponse(SINGLE_POST_INDEX_HTML);
          }
          if (url.pathname === "/9001.html") return htmlResponse(postHtml);
          return undefined;
        }],
        () => run({}, ctx) as Promise<void>,
      );
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 0);
    const errors = result.payload.errors as string[];
    assert(errors.some((e) => e.includes("symlink")));
  } finally {
    await Deno.remove(outside, { recursive: true });
    await Deno.remove(vaultRoot, { recursive: true });
  }
});

Deno.test("path confinement: resolveVaultPathSafe's realRoot is the symlink-resolved root, not the raw configured vaultRoot string (macOS temp dirs resolve /var -> /private/var)", async () => {
  const vaultRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-realroot-",
  });
  try {
    const target = await resolveVaultPathSafe(
      { vaultRoot },
      "LiveJournal/note.md",
    );
    const expectedRealRoot = await Deno.realPath(vaultRoot);
    assertEquals(
      target.realRoot,
      expectedRealRoot,
      "containment must be computed against the REAL (symlink-resolved) root, not the raw vaultRoot prefix",
    );
    assertEquals(
      target.absolutePath,
      `${expectedRealRoot}/LiveJournal/note.md`,
    );
  } finally {
    await Deno.remove(vaultRoot, { recursive: true });
  }
});

// covered-negative: import only ever writes into a caller-named folder --
// it never walks the vault, so there is no dot-dir/.trash EXCLUSION rule to
// have (unlike obsidian-vault's list/digest, which do walk and must skip
// hidden directories).
Deno.test("covered-negative: dot-dir/.trash exclusion is N/A -- import never walks the vault, it only writes into the caller-named folder", async () => {
  const postHtml = await readFixture("post_full.html");
  const vaultRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-dotdir-",
  });
  try {
    const { ctx, written } = makeCtx({
      ...GLOBAL_ARGS,
      folder: ".trash",
      vaultRoot,
    });
    await withDenoStubs({ realMkdir: true }, async () => {
      await withFetchStub(
        [(req) => {
          const url = new URL(req.url);
          if (url.pathname === "/" && !url.searchParams.has("skip")) {
            return htmlResponse(SINGLE_POST_INDEX_HTML);
          }
          if (url.pathname === "/9001.html") return htmlResponse(postHtml);
          return undefined;
        }],
        () => run({}, ctx) as Promise<void>,
      );
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
    const entries: string[] = [];
    for await (const e of Deno.readDir(`${vaultRoot}/.trash`)) {
      entries.push(e.name);
    }
    assert(entries.some((n) => n.endsWith(".md")));
  } finally {
    await Deno.remove(vaultRoot, { recursive: true });
  }
});

// ===========================================================================
// LB8 parseLjDate silent fallthrough -- LOW
// ===========================================================================

Deno.test("pin (livejournal-import-latent-bugs LB8, LOW -- FIXED): a date string not matching the expected shape now resolves to the safe 'unknown' sentinel (not a raw pass-through) in post.date, the frontmatter's unquoted `date:` line, and the note slug -- with a distinct warning logged", async () => {
  const { written, commands, logs } = await runSinglePostImport(
    GLOBAL_ARGS,
    "post_bad_date.html",
  );
  const post = written.find((w) => w.spec === "post")!;
  assertEquals(post.payload.date, "unknown");
  const createCall = commands.find((c) => c.args[0] === "create")!;
  const contentArg = createCall.args.find((a) => a.startsWith("content="))!;
  assert(
    contentArg.includes("date: unknown"),
    "the safe sentinel is emitted UNQUOTED into the frontmatter",
  );
  assert(
    !contentArg.includes("Sometime last fixture-summer"),
    "the raw unparseable date text must NOT reach the frontmatter",
  );
  const pathArg = createCall.args.find((a) => a.startsWith("path="))!;
  assert(
    pathArg.includes("unknown-"),
    "the sentinel (not the raw date string) is prepended to the note slug",
  );
  assert(
    !pathArg.includes("fixture-summer"),
    "the raw date text must NOT leak into the slug either",
  );
  assert(
    logs.some((l) => /could not parse|unparsed|unparseable/i.test(l)),
    "a distinct warning must be logged when the date fails to parse",
  );
});

// ===========================================================================
// Covered-negatives: credential leak / XXE / command injection -- REFUTED
// ===========================================================================

Deno.test("refuted: globalArguments carries no credential-shaped field -- there is nothing for a credential-leak test to catch", () => {
  const shape = model.globalArguments;
  // GlobalArgsSchema is a zod object; its shape keys are exactly these seven
  // (vaultRoot added by swamp-workspace #57's headless filesystem backend;
  // timeoutMs/maxPages added by the LB4/LB5 fixes, both backward-compatible
  // `.default(...)` global args, not credential-shaped).
  // deno-lint-ignore no-explicit-any
  const keys = Object.keys((shape as any).shape ?? {});
  assertEquals(
    keys.sort(),
    [
      "attachmentsFolder",
      "folder",
      "journalUrl",
      "maxPages",
      "timeoutMs",
      "vault",
      "vaultRoot",
    ],
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
