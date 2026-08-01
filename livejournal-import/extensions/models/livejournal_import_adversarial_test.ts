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
 * LB2-LB8 remain UNMODIFIED-behavior PINS (deferred, not fixed in this
 * change) -- every other test in this suite still PINS current behavior
 * (including behavior that is a documented latent bug) rather than
 * proposing a fix:
 *   LB2 YAML frontmatter injection via unescaped newlines (MEDIUM), LB3
 *   silent-empty success (MEDIUM), LB4 no fetch/subprocess timeout
 *   (MEDIUM), LB5 unbounded pagination/memory (MEDIUM), LB6 fragile
 *   comment-JSON extraction (LOW), LB7 operator `folder` path traversal on
 *   disk write (LOW), LB8 parseLjDate silent fallthrough (LOW). All 8 bugs
 *   are tracked in the LOCAL `livejournal-import-latent-bugs`
 *   issue-lifecycle model (NEVER filed to the swamp.club Lab -- see
 *   CLAUDE.md's anti-bypass rule).
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
// path confinement (vaultRoot note-write destination, swamp-workspace #57) --
// resolveVaultPathSafe, copied verbatim from
// obsidian-vault/extensions/models/obsidian_vault.ts (PR #56). This is a
// NEW, separate guard applied ONLY to the note write when vaultRoot is set --
// it does NOT touch the attachDiskPath mkdir/image-write path above, so LB7
// (folder traversal on the attachment disk path) remains UNFIXED exactly as
// pinned above, for both the CLI branch and the vaultRoot branch.
// ===========================================================================

Deno.test("path confinement: a '../'-relative 'folder' rejects the NOTE write via resolveVaultPathSafe when vaultRoot is set (LB7's attachDiskPath mkdir is UNCHANGED and still traverses)", async () => {
  const postHtml = await readFixture("post_full.html");
  const sandboxRoot = await Deno.makeTempDir({
    prefix: "livejournal-import-confinement-sandbox-",
  });
  const vaultRoot = `${sandboxRoot}/vault`;
  await Deno.mkdir(vaultRoot, { recursive: true });
  try {
    const { ctx, written } = makeCtx({
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
        () => run({}, ctx) as Promise<void>,
      );
    });
    // LB7 is UNCHANGED: the attachments mkdir still carries the raw
    // traversal segments verbatim (this guard was never applied there) --
    // realMkdir:true means it really landed outside the vault, in sandboxRoot.
    const attachStat = await Deno.stat(`${sandboxRoot}/escaped/attachments`);
    assert(attachStat.isDirectory);
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(
      result.payload.notesCreated,
      0,
      "the note write itself must be rejected by the NEW confinement guard",
    );
    const errors = result.payload.errors as string[];
    assert(errors.some((e) => e.includes("Path escapes vault root")));
    // The attachDiskPath mkdir side effect (LB7, unfixed) DOES create
    // sandboxRoot/escaped -- what must NOT happen is a note landing inside
    // it: no .md file anywhere under the escaped directory.
    const escapedEntries: string[] = [];
    for await (const e of Deno.readDir(`${sandboxRoot}/escaped`)) {
      escapedEntries.push(e.name);
    }
    assert(
      escapedEntries.every((n) => !n.endsWith(".md")),
      "no note may land outside the vault directory, even though LB7's attachments mkdir still does",
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
  // GlobalArgsSchema is a zod object; its shape keys are exactly these five
  // (vaultRoot added by swamp-workspace #57's headless filesystem backend).
  // deno-lint-ignore no-explicit-any
  const keys = Object.keys((shape as any).shape ?? {});
  assertEquals(
    keys.sort(),
    ["attachmentsFolder", "folder", "journalUrl", "vault", "vaultRoot"],
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
