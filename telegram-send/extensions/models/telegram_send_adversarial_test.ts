/**
 * Adversarial suite: attacker's-perspective tests for @magistr/telegram/send
 * — token-in-URL non-leak GREEN pins, an HONEST no-redaction
 * sentinel-propagation test for the fetch-rejection gap (round-1 adversarial
 * HIGH fix — see the test below for why the naive version would have been
 * tautological), verbatim MarkdownV2/HTML pass-through, attachment
 * mis-routing (Windows path, ftp://, path traversal), no client-side 50MB
 * guard, and a mechanical fixtures-secret-scan over
 * telegram-send/fixtures/*.json.
 *
 * telegram_send.ts is UNMODIFIED — every test here PINS current behavior
 * (including behavior that is arguably risky) rather than proposing a fix.
 * Where a test documents a real gap, it is labeled "pin" and says so
 * explicitly. See fixtures/PROVENANCE.md for fixture provenance.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./telegram_send.ts";
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

Deno.test("HONEST GAP pin: a fetch-layer rejection propagates VERBATIM with no redaction wrapper", async () => {
  // telegramJson/telegramMultipart call `await fetch(...)` with no
  // surrounding try/catch — ANY rejection (DNS failure, TLS error, connection
  // reset) propagates completely unchanged, all the way to the caller. This
  // test proves that mechanism using a NEUTRAL sentinel error object, never
  // the bot token itself — self-feeding the token into a thrown string here
  // would be a tautology (the test controls the stub; asserting "the token I
  // just typed into the stub appears in the output" proves nothing about
  // production). This is the round-1 adversarial HIGH fix: split the
  // tautological claim into (1) this mechanism test, and (2) the documented
  // fact below.
  //
  // DOCUMENTED FACT (not asserted here — this is Deno's fetch behavior, not
  // this model's code, so it cannot be pinned by a stubbed-fetch unit test):
  // a REAL Deno fetch rejection for a network-layer failure typically embeds
  // the request URL in its error message (e.g. something shaped like "error
  // sending request for url (https://api.telegram.org/bot<TOKEN>/getMe)").
  // Because telegram_send.ts builds its URL as
  // `${API_BASE}/bot${token}/${method}`, that URL carries the bot token
  // verbatim. Since this test proves telegramJson/telegramMultipart add NO
  // redaction layer around fetch, a real network failure in production would
  // surface the token via Deno's own error formatting — a genuine, currently
  // -unfixed gap given telegram_send.ts is byte-frozen by this change. The
  // follow-up hardening issue `telegram-send-hardening-richmessage-port`
  // (see ../../CHANGELOG.md and ../../quality.yaml) tracks adding a redacting error
  // mapper that strips `/bot<token>/` from every thrown message in both
  // telegramJson and telegramMultipart.
  const SENTINEL = new Error("NEUTRAL_FETCH_REJECTION_SENTINEL_NOT_A_TOKEN");
  const { ctx } = makeCtx();
  await withRejectingFetch(SENTINEL, async () => {
    const thrown = await assertRejects(() => run("getMe", {}, ctx));
    assert(
      thrown === SENTINEL,
      "the exact same rejection object must propagate unchanged — no wrapping, no redaction, no substitution",
    );
  });
});

Deno.test("HONEST GAP pin: the SAME no-redaction propagation holds through the multipart branch (telegramMultipart), not just telegramJson", async () => {
  // The test above only drives getMe (telegramJson). telegramMultipart has
  // its OWN independent `await fetch(...)` call with no try/catch, so the
  // no-redaction claim must be pinned there too, not just asserted in a
  // comment — round-1 adversarial follow-up. Deno.readFile is stubbed to
  // succeed (the multipart branch must reach its fetch call at all), then
  // fetch itself is stubbed to reject with a fresh neutral sentinel.
  const SENTINEL = new Error(
    "NEUTRAL_MULTIPART_FETCH_REJECTION_SENTINEL_NOT_A_TOKEN",
  );
  const { ctx } = makeCtx();
  const bytes = new Uint8Array([1, 2, 3]);
  await withReadFileStub(bytes, async () => {
    await withRejectingFetch(SENTINEL, async () => {
      const thrown = await assertRejects(
        () => run("sendPhoto", { photo: "/tmp/local/cat.png" }, ctx),
      );
      assert(
        thrown === SENTINEL,
        "telegramMultipart must also propagate a fetch rejection unchanged — no wrapping, no redaction",
      );
    });
  });
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
