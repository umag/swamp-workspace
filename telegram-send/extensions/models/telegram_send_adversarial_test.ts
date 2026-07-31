/**
 * Adversarial suite: attacker's-perspective tests for @magistr/telegram/send
 * — token-in-URL non-leak GREEN pins, redaction tests for the fetch-rejection
 * gap fixed by `telegram-send-hardening-richmessage-port` (both
 * `telegramJson` and `telegramMultipart` now wrap their `fetch()` call in
 * try/catch and route any rejection's message through `redactToken` before
 * rethrowing — see the tests below and `redactToken`'s own unit tests),
 * verbatim MarkdownV2/HTML pass-through, attachment mis-routing (Windows
 * path, ftp://, path traversal), no client-side 50MB guard, and a mechanical
 * fixtures-secret-scan over telegram-send/fixtures/*.json.
 *
 * Everything except the two fetch-rejection tests and the new `redactToken`
 * unit tests PINS pre-existing behavior (including behavior that is arguably
 * risky) rather than proposing a fix — those are labeled "pin" and say so
 * explicitly. See fixtures/PROVENANCE.md for fixture provenance.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, redactToken } from "./telegram_send.ts";
import getMeFixture from "../../fixtures/getMe.json" with { type: "json" };
import sendMessageFixture from "../../fixtures/sendMessage.json" with {
  type: "json",
};
import sendPhotoFixture from "../../fixtures/sendPhoto.json" with {
  type: "json",
};
import sendDocumentFixture from "../../fixtures/sendDocument.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Deliberately NOT token-shaped (letters-first, no colon anywhere) — see the
// "provably non-token-shaped" test near the bottom of this file, which
// asserts this constant cannot match the real-token regex.
const TOKEN = "FAKE-BOT-TOKEN-SENTINEL-DO-NOT-LOG-0000";
const DEFAULT_CHAT_ID = "555000111";

// Mirrors telegram_send.ts's own API_BASE literal — kept local rather than
// imported so this suite pins the redacted-URL SHAPE independently of the
// source's internal constant.
const API_BASE = "https://api.telegram.org";

const GLOBAL_ARGS = { botToken: TOKEN, defaultChatId: DEFAULT_CHAT_ID };

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
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
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withOneResponse(
  body: unknown,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, 200)], fn);
}

/** Make fetch REJECT (not resolve-with-error-body) — models a network-layer
 * failure (DNS, TLS, connection reset), as opposed to a well-formed
 * ok:false API response. */
function withRejectingFetch(error: unknown, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(error)) as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

async function requestJsonBody(
  req: Request,
): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
}

async function withReadFileStub(
  bytes: Uint8Array,
  fn: () => Promise<void>,
) {
  const original = Deno.readFile;
  (Deno as unknown as Record<string, unknown>).readFile = ((
    _path: string | URL,
  ) => Promise.resolve(bytes)) as unknown as typeof Deno.readFile;
  try {
    await fn();
  } finally {
    (Deno as unknown as Record<string, unknown>).readFile = original;
  }
}

const OK_MESSAGE = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  result: {
    message_id: 3001,
    chat: { id: Number(DEFAULT_CHAT_ID), type: "private" },
    date: 1752600300,
    ...overrides,
  },
});

// ---------------------------------------------------------------------------
// THE headline surface: token-in-URL
// ---------------------------------------------------------------------------

Deno.test("FIXED: a fetch-layer rejection is redacted before it propagates (telegramJson)", async () => {
  // telegramJson now wraps `await fetch(...)` in try/catch and rethrows the
  // rejection's message through redactToken before it reaches the caller.
  // Previously (see git history) this was an HONEST GAP pin proving the
  // opposite — that a rejection propagated verbatim, carrying the bot token
  // embedded in Deno's own fetch-error text (a real Deno fetch rejection for
  // a network-layer failure typically embeds the request URL, e.g. "error
  // sending request for url (https://api.telegram.org/bot<TOKEN>/getMe)").
  // This test now drives that exact shape — a synthetic Error whose message
  // embeds the live token in the Bot API URL path — and asserts the redacted
  // form is what the caller actually sees: the raw token is gone and the
  // path segment reads `/bot<redacted>/`.
  const rejection = new Error(
    `error sending request for url (${API_BASE}/bot${TOKEN}/getMe): connection reset`,
  );
  const { ctx } = makeCtx();
  await withRejectingFetch(rejection, async () => {
    const thrown = await assertRejects(() => run("getMe", {}, ctx));
    const message = (thrown as Error).message;
    assert(
      message.includes(`${API_BASE}/bot<redacted>/getMe`),
      `expected the redacted URL segment in the thrown message, got: ${message}`,
    );
    assert(
      !message.includes(TOKEN),
      `raw token must never appear in the thrown message, got: ${message}`,
    );
    // round-2 self-review (code-review phase): `cause` must NEVER be the raw
    // rejection object — Deno.inspect()/console.log()/the uncaught-error
    // printer all walk and print `cause` (including its `.stack`, whose
    // first line embeds the message), so attaching the original error
    // as-is would silently reopen the exact leak this mapper exists to
    // close. Assert both that `cause` is redacted AND that the full
    // Deno.inspect() rendering of the thrown error never contains the raw
    // token — an end-to-end guard against exactly the vulnerability found
    // during this suite's own code review.
    const cause = (thrown as Error).cause;
    assert(cause !== rejection, "cause must not be the raw rejection object");
    assert(cause instanceof Error, "cause should still be Error-shaped");
    assert(
      !(cause as Error).message.includes(TOKEN),
      `raw token must never appear in cause.message, got: ${
        (cause as Error).message
      }`,
    );
    const inspected = Deno.inspect(thrown);
    assert(
      !inspected.includes(TOKEN),
      `raw token must never appear anywhere in Deno.inspect(thrown), got: ${inspected}`,
    );
  });
});

Deno.test("FIXED: the SAME redaction holds through the multipart branch (telegramMultipart), not just telegramJson", async () => {
  // The test above only drives getMe (telegramJson). telegramMultipart has
  // its OWN independent `await fetch(...)` call, now wrapped with the same
  // try/catch redact-rethrow, so the fix must be pinned there too, not just
  // asserted in a comment. Deno.readFile is stubbed to succeed (the
  // multipart branch must reach its fetch call at all), then fetch itself is
  // stubbed to reject with a fresh token-bearing rejection.
  const rejection = new Error(
    `error sending request for url (${API_BASE}/bot${TOKEN}/sendPhoto): connection reset`,
  );
  const { ctx } = makeCtx();
  const bytes = new Uint8Array([1, 2, 3]);
  await withReadFileStub(bytes, async () => {
    await withRejectingFetch(rejection, async () => {
      const thrown = await assertRejects(
        () => run("sendPhoto", { photo: "/tmp/local/cat.png" }, ctx),
      );
      const message = (thrown as Error).message;
      assert(
        message.includes(`${API_BASE}/bot<redacted>/sendPhoto`),
        `expected the redacted URL segment in the thrown message, got: ${message}`,
      );
      assert(
        !message.includes(TOKEN),
        `raw token must never appear in the thrown message, got: ${message}`,
      );
      // Same code-review-found guard as the telegramJson test above: cause
      // must not be the raw rejection, and nothing reachable from the
      // thrown error (including via Deno.inspect, which the uncaught-error
      // printer and console.log both use) may carry the raw token.
      const cause = (thrown as Error).cause;
      assert(
        cause !== rejection,
        "cause must not be the raw rejection object",
      );
      assert(cause instanceof Error, "cause should still be Error-shaped");
      assert(
        !(cause as Error).message.includes(TOKEN),
        `raw token must never appear in cause.message, got: ${
          (cause as Error).message
        }`,
      );
      const inspected = Deno.inspect(thrown);
      assert(
        !inspected.includes(TOKEN),
        `raw token must never appear anywhere in Deno.inspect(thrown), got: ${inspected}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// redactToken unit tests
// ---------------------------------------------------------------------------

Deno.test("redactToken: replaces the live /bot<token>/ URL segment with /bot<redacted>/", () => {
  const message =
    `error sending request for url (${API_BASE}/bot${TOKEN}/getMe): connection reset`;
  const result = redactToken(message, TOKEN);
  assert(result.includes(`${API_BASE}/bot<redacted>/getMe`));
  assert(!result.includes(TOKEN));
});

Deno.test("redactToken: a token-free message passes through unchanged (no-op)", () => {
  const message = "Telegram API error (sendMessage): 400 Bad Request";
  assertEquals(redactToken(message, TOKEN), message);
});

Deno.test("redactToken: a generic /bot[^/]+/ backstop scrubs a reformatted token even when it no longer matches the literal token string", () => {
  // Defense-in-depth per round-1 adversarial review: a network stack that
  // percent-encodes, case-folds, or otherwise reformats the token in its
  // error text would slip past an exact-match replace. This TOKEN sentinel
  // is deliberately alnum+hyphen-only (see the "provably non-token-shaped"
  // test below), so percent-encoding it is a no-op — encodeURIComponent
  // cannot itself produce a divergent string here. Lower-casing it instead
  // gives a reformatted variant that (a) still fails the exact-token
  // replaceAll (case-sensitive) and (b) still sits inside a /bot.../ path
  // segment, which is exactly the shape the generic backstop must catch
  // regardless of WHY the exact match missed it.
  const reformattedToken = TOKEN.toLowerCase();
  const message =
    `error sending request for url (${API_BASE}/bot${reformattedToken}/getMe)`;
  const result = redactToken(message, TOKEN);
  assert(
    result.includes(`${API_BASE}/bot<redacted>/getMe`),
    `expected the generic backstop to scrub the reformatted token, got: ${result}`,
  );
  assert(!result.includes(reformattedToken));
});

Deno.test("redactToken: a non-Error/non-string rejection (e.g. DOMException, thrown string, undefined) is coerced safely before redaction", () => {
  assert(
    redactToken(new DOMException("aborted", "AbortError"), TOKEN).length > 0,
  );
  assertEquals(
    redactToken(`network failed for /bot${TOKEN}/getMe`, TOKEN),
    `network failed for /bot<redacted>/getMe`,
  );
  // A thrown non-Error value (e.g. a plain object or undefined) must coerce
  // to a string without throwing a secondary error.
  assert(typeof redactToken(undefined, TOKEN) === "string");
  assert(typeof redactToken({ some: "object" }, TOKEN) === "string");
});

Deno.test("redactToken: a non-Error object whose own string form embeds the token is still redacted, not just coerced without exploding", () => {
  // round-2 self-review (security lens): the test above only proves the
  // non-Error coercion path returns SOME string without throwing — it never
  // proves redaction actually still fires when that coerced string carries
  // the token. A thrown value doesn't have to be `instanceof Error` to leak
  // a token: some fetch/runtime shims reject with a plain object exposing a
  // custom `toString()`. Coercion must happen BEFORE (or as part of)
  // redaction, not instead of it.
  const tokenBearingNonError = {
    toString: () =>
      `error sending request for url (${API_BASE}/bot${TOKEN}/getMe)`,
  };
  const result = redactToken(tokenBearingNonError, TOKEN);
  assert(
    result.includes(`${API_BASE}/bot<redacted>/getMe`),
    `expected the non-Error coercion path to still redact the token, got: ${result}`,
  );
  assert(
    !result.includes(TOKEN),
    `raw token must not survive coercion of a non-Error value, got: ${result}`,
  );
});

Deno.test("GREEN pin: an API error message (ok:false path) contains ONLY the method name, code, and description — never the token", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(errorFixture, async () => {
    const thrown = await assertRejects(
      () => run("sendMessage", { text: "hi" }, ctx),
    );
    assertEquals(
      (thrown as Error).message,
      `Telegram API error (sendMessage): ${errorFixture.error_code} ${errorFixture.description}`,
    );
    assert(!(thrown as Error).message.includes(TOKEN));
  });
});

Deno.test("GREEN pin: written resources never contain the bot token across a mixed happy/error sequence", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(getMeFixture, async () => {
    await run("getMe", {}, ctx);
  });
  await withOneResponse(sendMessageFixture, async () => {
    await run("sendMessage", { text: "hi" }, ctx);
  });
  for (const w of written) {
    assert(
      !JSON.stringify(w.payload).includes(TOKEN),
      `${w.spec} must never contain the bot token`,
    );
  }
});

// ---------------------------------------------------------------------------
// Verbatim MarkdownV2/HTML pass-through — no escaping helper exists
// ---------------------------------------------------------------------------

Deno.test("pin: parseMode-formatted text is passed through VERBATIM — no escaping helper exists in this source", async () => {
  // SCOPE CORRECTION (see ../fixtures/PROVENANCE.md and the plan's scope
  // note): the frozen source exposes no MarkdownV2/HTML escaping helper at
  // all. parse_mode-formatted text is forwarded byte-for-byte to the Bot
  // API — the caller is entirely responsible for escaping reserved
  // characters. This test pins that pass-through, using hostile MarkdownV2
  // special characters plus an HTML-injection-shaped string, to prove no
  // hidden escaping/sanitization step exists.
  const { ctx } = makeCtx();
  const hostile = "_*[]()~`>#+-=|{}.!\\<script>alert(1)</script>";
  await withOneResponse(OK_MESSAGE({ text: hostile }), async (calls) => {
    await run(
      "sendMessage",
      { text: hostile, parseMode: "MarkdownV2" },
      ctx,
    );
    const body = await requestJsonBody(calls[0]);
    assertEquals(
      body.text,
      hostile,
      "text must be forwarded byte-for-byte, unescaped",
    );
  });
});

Deno.test("pin: HTML parseMode is also verbatim pass-through, including raw '<'/'>' tags", async () => {
  const { ctx } = makeCtx();
  const htmlish = "<b>bold</b><script>alert(document.cookie)</script>";
  await withOneResponse(OK_MESSAGE({ caption: htmlish }), async (calls) => {
    await run(
      "sendPhoto",
      {
        photo: "https://example.com/x.png",
        caption: htmlish,
        parseMode: "HTML",
      },
      ctx,
    );
    const body = await requestJsonBody(calls[0]);
    assertEquals(body.caption, htmlish);
  });
});

// ---------------------------------------------------------------------------
// Attachment mis-routing
// ---------------------------------------------------------------------------

Deno.test("pin: a Windows-style path (backslashes, no forward slash) is mis-routed to the JSON/file_id branch, not multipart", async () => {
  // isLocalPath only checks for a forward slash ("/") — a Windows path like
  // "C:\\Users\\x\\cat.png" has none, so it is (incorrectly, from a
  // Windows-user's perspective) treated as a bare file_id/JSON value rather
  // than a local path to upload. Documented gap: this model is
  // POSIX-path-oriented; a Windows caller must convert separators before
  // calling sendPhoto/sendDocument with a local path.
  const { ctx } = makeCtx();
  await withOneResponse(OK_MESSAGE(), async (calls) => {
    await run("sendPhoto", { photo: "C:\\Users\\x\\cat.png" }, ctx);
    const contentType = calls[0].headers.get("Content-Type") ?? "";
    assert(contentType.includes("application/json"));
    const body = await requestJsonBody(calls[0]);
    assertEquals(body.photo, "C:\\Users\\x\\cat.png");
  });
});

Deno.test("pin: an ftp:// URL is mis-routed to the multipart (local-file-read) branch, not treated as a remote URL", async () => {
  // isLocalPath's regex only excludes http(s):// — any OTHER scheme that
  // still contains a slash (ftp://, file://, s3://, ...) is treated as a
  // LOCAL PATH, triggering Deno.readFile("ftp://host/cat.png") instead of
  // being sent to Telegram as a URL string. Documented gap: only https(s)
  // URLs are recognized as "remote"; every other scheme is misinterpreted as
  // a filesystem path and attempted as a local read.
  const { ctx } = makeCtx();
  let readFileCalledWith: string | URL | undefined;
  const original = Deno.readFile;
  (Deno as unknown as Record<string, unknown>).readFile = ((
    path: string | URL,
  ) => {
    readFileCalledWith = path;
    return Promise.reject(new Deno.errors.NotFound("no such file"));
  }) as unknown as typeof Deno.readFile;
  try {
    await assertRejects(
      () =>
        run(
          "sendPhoto",
          { photo: "ftp://files.example.com/cat.png" },
          ctx,
        ),
    );
  } finally {
    (Deno as unknown as Record<string, unknown>).readFile = original;
  }
  assertEquals(readFileCalledWith, "ftp://files.example.com/cat.png");
});

Deno.test("pin: a '../' path-traversal string is routed to the multipart (local-file) branch with no path sanitization", async () => {
  // isLocalPath has no allowlist/sandbox check — any string containing a
  // slash that is not an http(s) URL is passed straight to Deno.readFile. A
  // caller that forwards untrusted input as `photo`/`document` gives an
  // attacker filesystem-read access to whatever the swamp process itself can
  // read. Documented trust-boundary gap: callers must validate/sandbox any
  // user-supplied attachment path themselves before invoking
  // sendPhoto/sendDocument — this model performs no such check.
  const { ctx } = makeCtx();
  const bytes = new Uint8Array([1, 2, 3]);
  await withReadFileStub(bytes, async () => {
    await withOneResponse(OK_MESSAGE(), async (calls) => {
      await run(
        "sendDocument",
        { document: "../../../../etc/passwd" },
        ctx,
      );
      const contentType = calls[0].headers.get("Content-Type") ?? "";
      assert(contentType.includes("multipart/form-data"));
      const form = await calls[0].clone().formData();
      const file = form.get("document") as File;
      assertEquals(
        file.name,
        "passwd",
        "the traversal path's basename becomes the uploaded filename",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// No client-side size guard
// ---------------------------------------------------------------------------

Deno.test("pin: NO client-side size guard exists — a file larger than the documented 50MB API limit is uploaded whole", async () => {
  // telegramMultipart never inspects fileBytes.length before building the
  // FormData/Blob and POSTing. A 50MB+ local file is read fully into memory
  // and uploaded in full; the ONLY enforcement is whatever the live Bot API
  // rejects server-side. Documented gap: this model applies no local
  // pre-flight size check.
  const { ctx } = makeCtx();
  const oversized = new Uint8Array(51 * 1024 * 1024); // 51MB > the 50MB Bot API cap
  await withReadFileStub(oversized, async () => {
    await withOneResponse(OK_MESSAGE(), async (calls) => {
      await run("sendDocument", { document: "/tmp/huge.bin" }, ctx);
      const form = await calls[0].clone().formData();
      const file = form.get("document") as File;
      assertEquals(
        file.size,
        oversized.length,
        "the oversized file was uploaded whole, with no client-side guard",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

// The real homelab chat id used by the live tg-bot/tg-anilist instances (see
// fixtures/PROVENANCE.md) — denylisted explicitly per round-1 security LOW.
const REAL_HOMELAB_CHAT_ID = "154348275";

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "real Telegram bot-token shape (digits, colon, 30+ alnum/_/-)",
    re: /\d+:[A-Za-z0-9_-]{30,}/,
  },
  { name: "vault key name BOT_TOKEN", re: /\bBOT_TOKEN\b/ },
  {
    name: "the real homelab chat id (154348275)",
    re: new RegExp(`\\b${REAL_HOMELAB_CHAT_ID}\\b`),
  },
];

/** Recursively collect every string/number leaf value in a parsed JSON
 * structure (numbers included: Telegram chat/message ids are wire numbers,
 * and the chat-id denylist must catch them whether they land as a JSON
 * string or a JSON number). */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (typeof value === "number") {
    out.push(String(value));
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
  "getMe.json": getMeFixture,
  "sendMessage.json": sendMessageFixture,
  "sendPhoto.json": sendPhotoFixture,
  "sendDocument.json": sendDocumentFixture,
  "error.json": errorFixture,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string or the real homelab chat id", () => {
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

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected real-token shape", () => {
  const violations: string[] = [];
  const poisoned = { token: "123456789:" + "A".repeat(35) };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real Telegram bot-token shape",
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects the real homelab chat id if it were present", () => {
  const violations: string[] = [];
  const poisoned = { chat: { id: 154348275 } };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag the real homelab chat id",
  );
});

Deno.test("the TOKEN sentinel used throughout the methods/adversarial suites' test source is provably non-token-shaped", () => {
  // Round-1 adversarial MEDIUM: any token sentinel embedded in test SOURCE
  // (not fixtures) — e.g. baked into a URL-path assertion — must not itself
  // be able to match the real-token regex, so it can never mask a real leak
  // or false-positive a repo-wide secret-scanning gate. TOKEN is
  // letters-first with NO colon at all, so ^\d+: can never match it.
  const realTokenShape = /\d+:[A-Za-z0-9_-]{30,}/;
  assert(
    !realTokenShape.test(TOKEN),
    "TOKEN sentinel must not be token-shaped",
  );
  assert(!TOKEN.includes(":"), "TOKEN sentinel must contain no colon at all");
});
