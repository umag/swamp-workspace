/**
 * Adversarial suite: hostile/boundary inputs, malformed/truncated/injected
 * HTML, non-200 vs wrong-content-type responses, control bytes, and a
 * mechanical fixtures-secret-scan over bandcamp/fixtures/*.
 *
 * As of 2026.08.02.1, bandcamp.ts is FIXED for all 7 latent bugs tracked in
 * the LOCAL `bandcamp-latent-bugs` issue-lifecycle model (NEVER filed to the
 * swamp.club Lab -- see CLAUDE.md's anti-bypass rule):
 *   #1 SSRF via url arg (CRITICAL) -- fetchPage enforces a
 *   bandcamp.com/*.bandcamp.com host allowlist before every fetch, including
 *   re-validation on every redirect hop.
 *   #2 cross-instance token-cache bleed (HIGH) -- the token cache is keyed
 *   on credential identity, so distinct clientId/clientSecret pairs never
 *   share a cached bearer.
 *   #3 TralbumData `//`-strip corruption (MEDIUM) -- a direct JSON.parse is
 *   tried FIRST (real TralbumData is valid JSON); only on failure does a
 *   `scheme://`-protected cleanup fallback run, so tracks survive.
 *   #4 silent all-clear on parse failure (MEDIUM) -- a genuine JSON-LD or
 *   TralbumData parse failure now calls `context.logger.warning` with a
 *   generic message (never the raw blob or a credential).
 *   #5 no fetch timeout/backoff (MEDIUM) -- every fetch site routes through
 *   a `timedFetch` helper that attaches a bounded `AbortSignal` and clears
 *   its timer in `finally`.
 *   #6 instanceName 60-char truncation collision (LOW) -- the resource name
 *   is now a 47-char slug plus a 12-hex SHA-256 suffix of the full URL, so
 *   distinct URLs no longer clobber each other.
 *   #7 slice() surrogate split (LOW) -- `about`/`bio` truncate by CODE POINT
 *   (`Array.from(...).slice(0,500).join("")`), never splitting a surrogate
 *   pair.
 * See CHANGELOG.md's `## 2026.08.02.1` entry for the full per-bug writeup.
 *
 * Every get-artist/get-album/get-track fetch target in this file uses a
 * *.bandcamp.com host (the allowlist rejects *.example.com); fixture FILE
 * content is untouched (fixtures are parsed data, never a fetch target).
 *
 * IMPORTANT -- module-global token cache: Deno isolates module state PER
 * TEST FILE (verified empirically), so `tokenCache` starts empty at the top
 * of THIS file. The cross-instance-bleed test below is deliberately the
 * FIRST OAuth-touching test in this file so it observes a clean first-fetch
 * -> cache -> reuse sequence without needing FakeTime.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./bandcamp.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = {}) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: {
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warning: (...args: unknown[]) => {
          logs.push({ level: "warning", args });
        },
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
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

function withResponse(
  body: string,
  status: number,
  contentType: string,
  fn: () => Promise<void>,
) {
  return withFetchStub(
    [() =>
      new Response(body, { status, headers: { "Content-Type": contentType } })],
    () => fn(),
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readHtml(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../fixtures/${name}`, import.meta.url),
  );
}

// ===========================================================================
// #1 SSRF via url arg -- CRITICAL
// ===========================================================================

Deno.test("FIXED (bandcamp-latent-bugs #1, CRITICAL): get-artist's url arg is REJECTED for an internal/link-local target -- the host allowlist blocks it before any fetch", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })],
    async (calls) => {
      await assertRejects(
        () =>
          run(
            "get-artist",
            {
              url:
                "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
            },
            ctx,
          ),
        Error,
      );
      assertEquals(
        calls.length,
        0,
        "the internal/link-local host must never be fetched",
      );
    },
  );
});

Deno.test("FIXED (bandcamp-latent-bugs #1): get-album and get-track also reject an internal/link-local url before any fetch", async () => {
  for (const methodName of ["get-album", "get-track"]) {
    const { ctx } = makeCtx();
    await withFetchStub(
      [() =>
        new Response("<html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })],
      async (calls) => {
        await assertRejects(
          () =>
            run(methodName, {
              url: "http://169.254.169.254/latest/meta-data/",
            }, ctx),
          Error,
        );
        assertEquals(calls.length, 0);
      },
    );
  }
});

Deno.test("FIXED (bandcamp-latent-bugs #1): a localhost/loopback target is rejected the same way", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [() =>
      new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })],
    async (calls) => {
      await assertRejects(
        () =>
          run(
            "get-album",
            { url: "http://127.0.0.1:8080/internal-admin" },
            ctx,
          ),
        Error,
      );
      assertEquals(calls.length, 0);
    },
  );
});

Deno.test("FIXED (bandcamp-latent-bugs #1): a *.bandcamp.com URL that 3xx-redirects to an internal/link-local Location is rejected on the redirect hop -- the internal host is never fetched", async () => {
  const { ctx } = makeCtx();
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.hostname === "fixture-artist.bandcamp.com") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "http://169.254.169.254/latest/meta-data/",
          },
        });
      }
      return undefined;
    }],
    async (calls) => {
      await assertRejects(
        () =>
          run(
            "get-album",
            { url: "https://fixture-artist.bandcamp.com/album/x" },
            ctx,
          ),
        Error,
      );
      assertEquals(
        calls.length,
        1,
        "only the initial bandcamp.com request happens -- the redirect target is never fetched",
      );
    },
  );
});

Deno.test("FIXED (bandcamp-latent-bugs #1): an RFC 2606 example.com URL is rejected by get-*, while a real *.bandcamp.com URL still succeeds", async () => {
  const { ctx } = makeCtx();
  await assertRejects(
    () => run("get-album", { url: "https://fixture.example.com/album/x" }, ctx),
    Error,
  );
  await withFetchStub(
    [() =>
      new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })],
    async (calls) => {
      await run(
        "get-album",
        { url: "https://fixture-artist.bandcamp.com/album/x" },
        ctx,
      );
      assertEquals(calls.length, 1);
    },
  );
});

// ===========================================================================
// #2 Cross-instance token-cache bleed -- HIGH (first OAuth test in this file)
// ===========================================================================

Deno.test("FIXED (bandcamp-latent-bugs #2, HIGH): a SECOND bandcamp instance with DIFFERENT OAuth credentials gets its OWN token fetch and its OWN bearer -- no cross-instance bleed", async () => {
  // `tokenCache` is now a Map keyed on credential identity (clientId +
  // clientSecret). Two swamp model instances of @magistr/bandcamp pointed at
  // different Bandcamp accounts, even sharing one running swamp process (one
  // extension bundle load), each miss the other's cache entry and fetch
  // their own token.
  const { ctx: instanceA } = makeCtx({
    clientId: "client-A",
    clientSecret: "secret-A",
  });
  const { ctx: instanceB } = makeCtx({
    clientId: "client-B",
    clientSecret: "secret-B",
  });
  let tokenFetches = 0;
  const bearers: string[] = [];
  await withFetchStub(
    [(req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth_token") {
        tokenFetches++;
        // Echo a token DERIVED from the request's client_id, so each
        // identity's bearer is independently distinguishable.
        return req.clone().text().then((body) => {
          const clientId = new URLSearchParams(body).get("client_id");
          return json({
            ok: true,
            access_token: `${clientId}-bearer-token`,
            expires_in: 3600,
            refresh_token: `${clientId}-refresh-token`,
          });
        });
      }
      if (url.pathname === "/api/account/1/my_bands") {
        return json({ bands: [] });
      }
      return undefined;
    }],
    async (calls) => {
      await run("my-bands", {}, instanceA);
      await run("my-bands", {}, instanceB);
      for (const c of calls) {
        if (new URL(c.url).pathname === "/api/account/1/my_bands") {
          bearers.push(c.headers.get("authorization") || "");
        }
      }
    },
  );
  assertEquals(
    tokenFetches,
    2,
    "TWO distinct identities each cause their OWN token fetch",
  );
  assertEquals(bearers.length, 2);
  assertEquals(bearers[0], "Bearer client-A-bearer-token");
  assertEquals(bearers[1], "Bearer client-B-bearer-token");
  assert(
    bearers[0] !== bearers[1],
    "each instance carries its OWN credential-scoped bearer token -- no bleed",
  );
});

// ===========================================================================
// #3 TralbumData //-strip corruption -- MEDIUM (fuller explanation; the
// concrete VALUE is already pinned in the contract-fixture suite)
// ===========================================================================

Deno.test("FIXED (bandcamp-latent-bugs #3, MEDIUM): a TralbumData blob containing an https:// URL is RECOVERED via the scheme-protected fallback strip -- the track survives", async () => {
  const { ctx, written } = makeCtx();
  const html = await readHtml("album_tralbum_dirty.html");
  await withResponse(html, 200, "text/html", async () => {
    await run(
      "get-album",
      {
        url:
          "https://fixture-corrupt-artist.bandcamp.com/album/fixture-dirty-tralbum",
      },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "albumDetail")!;
  // A direct JSON.parse of the raw TralbumData blob fails (trailing comma),
  // so the scheme-protected fallback strip runs: it protects the embedded
  // "https://" value (never treating it as a `//`-comment) while still
  // cleaning up the genuine trailing comma, recovering the track.
  assertEquals(res.payload.tracks, [
    { position: 1, title: "Fixture Corrupt Track", duration: "3:00", url: "" },
  ]);
  assertEquals(res.payload.trackCount, 1);
});

Deno.test("FIXED (bandcamp-latent-bugs #3): the SAME recovery holds for get-track (shares parseAlbumPage)", async () => {
  const { ctx, written } = makeCtx();
  const html = await readHtml("album_tralbum_dirty.html");
  await withResponse(html, 200, "text/html", async () => {
    await run(
      "get-track",
      {
        url:
          "https://fixture-corrupt-artist.bandcamp.com/track/fixture-corrupt-track",
      },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.tracks, [
    { position: 1, title: "Fixture Corrupt Track", duration: "3:00", url: "" },
  ]);
});

// ===========================================================================
// #4 Silent all-clear on parse failure -- MEDIUM
// ===========================================================================

Deno.test("FIXED (bandcamp-latent-bugs #4, MEDIUM): malformed JSON-LD (unbalanced braces) is caught AND warned -- method still resolves 'success' with empty ld-only fields, DOM fallback (if any) still wins for its own fields", async () => {
  const { ctx, written, logs } = makeCtx();
  const html =
    `<html><head><script type="application/ld+json">{"name":"Fixture Truncated" not valid json {{{</script></head>` +
    `<body><h2 class="trackTitle">DOM Fallback Title</h2></body></html>`;
  let threw: unknown;
  await withResponse(html, 200, "text/html", async () => {
    try {
      await run(
        "get-album",
        { url: "https://fixture.bandcamp.com/album/x" },
        ctx,
      );
    } catch (e) {
      threw = e;
    }
  });
  assertEquals(threw, undefined, "no throw despite malformed JSON-LD");
  const res = written.find((w) => w.spec === "albumDetail")!;
  // title falls back to DOM (present) -- `about`, which has NO DOM fallback
  // for this fixture, still resolves to "" (there is genuinely no other
  // source), but the parse failure is no longer silent: a warning fires.
  assertEquals(res.payload.title, "DOM Fallback Title");
  assertEquals(res.payload.about, "");
  const warnings = logs.filter((l) => l.level === "warning");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].args, [
    "bandcamp: album JSON-LD parse failed: SyntaxError",
  ]);
});

Deno.test("FIXED (bandcamp-latent-bugs #4): control bytes inside the JSON-LD script also break JSON.parse -- no throw, but a warning is now captured", async () => {
  const { ctx, written, logs } = makeCtx();
  const html =
    `<html><head><script type="application/ld+json">{"name":"Fixture\x00Control\x07Bytes"}</script></head><body></body></html>`;
  let threw: unknown;
  await withResponse(html, 200, "text/html", async () => {
    try {
      await run(
        "get-album",
        { url: "https://fixture.bandcamp.com/album/x" },
        ctx,
      );
    } catch (e) {
      threw = e;
    }
  });
  assertEquals(threw, undefined);
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.title, "");
  const warnings = logs.filter((l) => l.level === "warning");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].args, [
    "bandcamp: album JSON-LD parse failed: SyntaxError",
  ]);
});

Deno.test("FIXED (bandcamp-latent-bugs #4) LEAK test: a parse-failure warning's message never contains the raw blob's content, even when that blob carries secret-shaped or PII-shaped text", async () => {
  // Satisfies bandcamp_methods_test.ts's pin charter ('no method calls the
  // logger today ... a future change that starts logging must add its own
  // leak test'): #4 is that future change, this is its leak test.
  const { ctx, logs } = makeCtx();
  const poisonedBlob =
    'not-json-at-all client_secret="fixture-super-secret-token-should-never-leak" user@example.com {{{';
  const html =
    `<html><head><script type="application/ld+json">${poisonedBlob}</script></head><body></body></html>`;
  await withResponse(html, 200, "text/html", async () => {
    await run(
      "get-album",
      { url: "https://fixture.bandcamp.com/album/x" },
      ctx,
    );
  });
  const warnings = logs.filter((l) => l.level === "warning");
  assertEquals(warnings.length, 1);
  const message = String(warnings[0].args[0]);
  assert(
    !message.includes("fixture-super-secret-token-should-never-leak"),
    "warning must never interpolate the raw blob content",
  );
  assert(!message.includes("user@example.com"));
  assertEquals(
    message,
    "bandcamp: album JSON-LD parse failed: SyntaxError",
    "the warning message is a fixed generic string, never the raw blob",
  );
});

Deno.test("FIXED (bandcamp-latent-bugs #4): malformed JSON-LD on an ARTIST page is also caught AND warned (parseArtistPage's own catch, distinct from parseAlbumPage's)", async () => {
  const { ctx, written, logs } = makeCtx();
  const html =
    `<html><head><script type="application/ld+json">{"name":"Fixture Artist" not valid json {{{</script></head>` +
    `<body><p id="band-name-location"><span class="title">DOM Fallback Artist</span></p></body></html>`;
  let threw: unknown;
  await withResponse(html, 200, "text/html", async () => {
    try {
      await run("get-artist", { url: "https://fixture.bandcamp.com" }, ctx);
    } catch (e) {
      threw = e;
    }
  });
  assertEquals(threw, undefined, "no throw despite malformed artist JSON-LD");
  const res = written.find((w) => w.spec === "artistDetail")!;
  assertEquals(res.payload.name, "DOM Fallback Artist");
  const warnings = logs.filter((l) => l.level === "warning");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].args, [
    "bandcamp: artist JSON-LD parse failed: SyntaxError",
  ]);
});

Deno.test("script-injection inside a title element is inert (linkedom parses it as a dead <script>); its textContent is still concatenated into the extracted title", async () => {
  // Not one of the 7 tracked bugs -- a safety-relevant characterization: no
  // script execution risk in this parse context, but the injected text DOES
  // flow through into the returned field (a caller rendering `title` as raw
  // HTML downstream would still need to escape it).
  const { ctx, written } = makeCtx();
  const html =
    `<html><body><div id="name-section"><h2 class="trackTitle">Fixture <script>alert(1)</script> Injected</h2></div></body></html>`;
  await withResponse(html, 200, "text/html", async () => {
    await run(
      "get-album",
      { url: "https://fixture.bandcamp.com/album/x" },
      ctx,
    );
  });
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.title, "Fixture alert(1) Injected");
});

// ===========================================================================
// #5 No fetch timeout/backoff -- MEDIUM
// ===========================================================================

Deno.test("FIXED (bandcamp-latent-bugs #5, MEDIUM): fetchPage passes an AbortSignal with a bounded timeout to fetch -- a hung upstream can no longer block indefinitely", async () => {
  const { ctx } = makeCtx();
  let capturedInit: RequestInit | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return Promise.resolve(
      new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    await run("search-artist", { query: "x" }, ctx);
  } finally {
    globalThis.fetch = original;
  }
  assert(
    capturedInit?.signal instanceof AbortSignal,
    "fetchPage passes a bounded AbortSignal",
  );
});

Deno.test("FIXED (bandcamp-latent-bugs #5): getToken's POST also carries an AbortSignal with a bounded timeout", async () => {
  const { ctx } = makeCtx({ clientId: "cid", clientSecret: "csecret" });
  const captured: (RequestInit | undefined)[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured.push(init);
    const u = new URL(String(url));
    if (u.pathname === "/oauth_token") {
      return Promise.resolve(
        json({ ok: true, access_token: "t", expires_in: 3600 }),
      );
    }
    return Promise.resolve(json({ bands: [] }));
  }) as unknown as typeof globalThis.fetch;
  try {
    await run("my-bands", {}, ctx);
  } finally {
    globalThis.fetch = original;
  }
  assert(captured.length > 0);
  for (const init of captured) {
    assert(init?.signal instanceof AbortSignal);
  }
});

Deno.test("FIXED (bandcamp-latent-bugs #5): a hung upstream is aborted once the fetch timeout elapses, instead of blocking forever", async () => {
  const time = new FakeTime();
  try {
    const { ctx } = makeCtx();
    await withFetchStub(
      [(req) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => {
            reject(
              new DOMException("The signal has been aborted", "AbortError"),
            );
          });
        })],
      async () => {
        const rejection = assertRejects(
          () => run("search-artist", { query: "x" }, ctx),
          DOMException,
          "aborted",
        );
        await time.tickAsync(30_000);
        await rejection;
      },
    );
  } finally {
    time.restore();
  }
});

// ===========================================================================
// #6 instanceName 60-char truncation collision -- LOW
// ===========================================================================

Deno.test("FIXED (bandcamp-latent-bugs #6, LOW): two distinct album URLs sharing the first 47 sanitized characters NO LONGER collide -- each gets its own resource name via a SHA-256 suffix", async () => {
  const sharedPrefix = "a".repeat(70); // comfortably over the 47-char slug boundary
  const urlOne = `https://${sharedPrefix}-one.bandcamp.com`;
  const urlTwo = `https://${sharedPrefix}-two.bandcamp.com`;
  const names: string[] = [];
  for (const url of [urlOne, urlTwo]) {
    const { ctx, written } = makeCtx();
    await withResponse(`<html></html>`, 200, "text/html", async () => {
      await run("get-album", { url }, ctx);
    });
    names.push(written.find((w) => w.spec === "albumDetail")!.name);
  }
  assert(
    names[0] !== names[1],
    "two DIFFERENT source URLs must no longer clobber each other's resource (writeResource is keyed on instance name)",
  );
  const SLUG_LENGTH = 47;
  assertEquals(
    names[0].slice(0, SLUG_LENGTH),
    names[1].slice(0, SLUG_LENGTH),
    "both share the identical (collision-prone) 47-char slug prefix",
  );
  for (const name of names) {
    assert(
      name.length <= 60,
      "the full name (slug + hash suffix) stays <= 60 chars",
    );
  }
});

// ===========================================================================
// #7 slice() surrogate split -- LOW
// ===========================================================================

Deno.test("FIXED (bandcamp-latent-bugs #7, LOW): about truncates by CODE POINT, never splitting a UTF-16 surrogate pair straddling the boundary", async () => {
  // 499 ASCII chars (code points 0..498) + a whole emoji (code point 499) +
  // filler. A code-point-safe slice(0,500) keeps all 500 code points -- the
  // 499 ASCII chars AND the emoji intact -- dropping only the filler after
  // it. Note: the returned string's `.length` (UTF-16 code units) is 501,
  // not 500 -- the emoji contributes 2 code units for 1 code point. The
  // invariant is now "<= 500 code points", not "<= 500 code units".
  const text = "A".repeat(499) + "\u{1F600}" +
    "more filler text after the emoji boundary";
  const html =
    `<html><body><div class="tralbumData tralbum-about">${text}</div></body></html>`;
  const { ctx, written } = makeCtx();
  await withResponse(html, 200, "text/html", async () => {
    await run(
      "get-album",
      { url: "https://fixture.bandcamp.com/album/x" },
      ctx,
    );
  });
  const about = written.find((w) => w.spec === "albumDetail")!.payload
    .about as string;
  assertEquals(Array.from(about).length, 500);
  assert(
    about.includes("\u{1F600}"),
    "the emoji at the boundary survives intact, not split",
  );
  assert(
    !/[\uD800-\uDBFF]$/.test(about),
    "the truncated string never ends in a LONE (unpaired) high surrogate",
  );
});

Deno.test("FIXED (bandcamp-latent-bugs #7): the SAME code-point-safe truncation applies to parseArtistPage's bio field", async () => {
  const text = "B".repeat(499) + "\u{1F600}" +
    "more filler text after the emoji boundary";
  const html = `<html><body><div class="bio-text">${text}</div></body></html>`;
  const { ctx, written } = makeCtx();
  await withResponse(html, 200, "text/html", async () => {
    await run("get-artist", { url: "https://fixture.bandcamp.com" }, ctx);
  });
  const bio = written.find((w) => w.spec === "artistDetail")!.payload
    .bio as string;
  assertEquals(Array.from(bio).length, 500);
  assert(bio.includes("\u{1F600}"));
  assert(!/[\uD800-\uDBFF]$/.test(bio));
});

// ===========================================================================
// Non-200 vs wrong-content-type
// ===========================================================================

Deno.test("a non-200 response throws with status + URL (correct behavior, contrast pin)", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withResponse(
    "<html>gateway timeout</html>",
    504,
    "text/html",
    async () => {
      try {
        await run(
          "get-album",
          { url: "https://fixture.bandcamp.com/album/x" },
          ctx,
        );
      } catch (e) {
        threw = e;
      }
    },
  );
  assertEquals(
    (threw as Error).message,
    "Failed to fetch https://fixture.bandcamp.com/album/x: 504",
  );
});

Deno.test("wrong content-type (a JSON body served as if it were HTML) does NOT throw -- fetchPage never inspects Content-Type, DOMParser tolerates it, all fields resolve empty", async () => {
  const { ctx, written } = makeCtx();
  const jsonBody = JSON.stringify({ hello: "world", nested: [1, 2, 3] });
  let threw: unknown;
  await withResponse(jsonBody, 200, "application/json", async () => {
    try {
      await run(
        "get-album",
        { url: "https://fixture.bandcamp.com/album/x" },
        ctx,
      );
    } catch (e) {
      threw = e;
    }
  });
  assertEquals(threw, undefined);
  const res = written.find((w) => w.spec === "albumDetail")!;
  assertEquals(res.payload.title, "");
  assertEquals(res.payload.tracks, []);
});

Deno.test("an empty-string response body does not throw either -- every field resolves to its empty default", async () => {
  const { ctx, written } = makeCtx();
  await withResponse("", 200, "text/html", async () => {
    await run("get-artist", { url: "https://fixture.bandcamp.com" }, ctx);
  });
  const res = written.find((w) => w.spec === "artistDetail")!;
  assertEquals(res.payload.name, "");
  assertEquals(res.payload.discography, []);
});

// ===========================================================================
// Fixtures-secret-scan -- mechanical backstop over the committed corpus
// ===========================================================================

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "vault key name CLIENT_ID", re: /\bCLIENT_ID\b/ },
  { name: "vault key name CLIENT_SECRET", re: /\bCLIENT_SECRET\b/ },
  // Generic high-entropy blob: entirely 32+ alnum/base64url characters, no
  // separators -- none of our authored fixture values (names, urls, dates,
  // ids, short tokens) match this shape.
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9+/_=-]{32,}$/ },
  { name: "bearer-token shaped value", re: /^Bearer\s+[A-Za-z0-9._-]{20,}$/ },
];

function collectStringsFromJson(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringsFromJson(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStringsFromJson(v, out);
    }
  }
  return out;
}

const JSON_FIXTURES = [
  "oauth_token.json",
  "my_bands.json",
  "sales_report.json",
  "merch_details.json",
  "orders.json",
  "update_shipped.json",
  "api_error.json",
];

const HTML_FIXTURES = [
  "search_artists.html",
  "search_albums.html",
  "search_tracks.html",
  "search_fallback.html",
  "search_empty.html",
  "album.html",
  "album_tralbum_fallback.html",
  "album_tralbum_dirty.html",
  "artist_grid.html",
  "artist_ld_discography.html",
];

Deno.test("fixtures-secret-scan: no committed JSON fixture contains a secret-shaped string", async () => {
  const violations: string[] = [];
  for (const file of JSON_FIXTURES) {
    const raw = await Deno.readTextFile(
      new URL(`../../fixtures/${file}`, import.meta.url),
    );
    const data = JSON.parse(raw);
    for (const str of collectStringsFromJson(data)) {
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
    `secret-shaped content found in committed JSON fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: no committed HTML fixture contains a secret-shaped string", async () => {
  const violations: string[] = [];
  for (const file of HTML_FIXTURES) {
    const raw = await Deno.readTextFile(
      new URL(`../../fixtures/${file}`, import.meta.url),
    );
    for (const { name, re } of SECRET_PATTERNS) {
      // HTML is scanned as one blob (not tokenized) since the high-entropy
      // pattern requires whole-value anchors; run it against every
      // whitespace-delimited token instead so it still has a chance to fire.
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
  const poisoned = { key: "a".repeat(40) };
  const violations: string[] = [];
  for (const str of collectStringsFromJson(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real high-entropy shape",
  );
});
