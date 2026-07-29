/**
 * Method-level tests for @magistr/telegram/send — every one of the 4 methods
 * (getMe, sendMessage, sendPhoto, sendDocument), happy path + error path,
 * driven through `model.methods.<m>.arguments.parse()` + `.execute()` against
 * a stubbed `globalThis.fetch` (the porkbun-precedent
 * `as typeof globalThis.fetch` cast) and a fake context. sendPhoto/
 * sendDocument each exercise all THREE attachment-routing branches: an
 * https:// URL, a bare file_id (no slash, no scheme), and a local filesystem
 * path (multipart upload).
 *
 * The multipart branch stubs `Deno.readFile` via an
 * `as unknown as typeof Deno.readFile` bridge — verified reassignable under
 * local deno 2.7.13; if a future CI deno rejects the reassignment, fall back
 * to a real `Deno.makeTempFile` path with a narrowly-scoped
 * `--allow-read`/`--allow-write` on the test task (see deno.json's `test`
 * task comment and CHANGELOG.md).
 *
 * telegram_send.ts is UNMODIFIED by this change — every test here is a
 * characterization test that PINS the model's current, already-shipped
 * behavior. It is not red-green TDD: there is no new behavior to drive out.
 *
 * Token-leak assertions run for every method: the botToken global must never
 * appear in a thrown error, a written resource payload, or a logger call.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./telegram_send.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Deliberately NOT token-shaped (letters-first, no colon) — see the
// contract-fixture suite's comment on the same constant shape; this cannot
// match the real-token regex /\d+:[A-Za-z0-9_-]{30,}/ the adversarial suite's
// fixtures-secret-scan runs.
const TOKEN = "FAKE-BOT-TOKEN-SENTINEL-DO-NOT-LOG-0000";
const DEFAULT_CHAT_ID = "555000111";

const GLOBAL_ARGS = { botToken: TOKEN, defaultChatId: DEFAULT_CHAT_ID };

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};
type LogCall = { level: "info" | "warning"; args: unknown[] };

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
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

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied,
 * enums enforced) before execute is invoked — never call execute() with raw,
 * unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** Install a fetch stub for the duration of `fn`; captures every request. */
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

/** Single-route stub returning the same body/status to every call. */
function withOneResponse(
  body: unknown,
  status: number,
  fn: (calls: Request[]) => Promise<void>,
) {
  return withFetchStub([() => json(body, status)], fn);
}

async function requestJsonBody(
  req: Request,
): Promise<Record<string, unknown>> {
  return JSON.parse(await req.text());
}

/** Stub Deno.readFile for the duration of `fn`; restores the original after,
 * even on failure. See the module doc comment for the CI-portability note. */
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
    message_id: 2001,
    chat: { id: Number(DEFAULT_CHAT_ID), type: "private" },
    date: 1752600200,
    ...overrides,
  },
});

const ERROR_BODY = {
  ok: false,
  error_code: 400,
  description: "Bad Request: chat not found",
};

// ---------------------------------------------------------------------------
// getMe
// ---------------------------------------------------------------------------

Deno.test("getMe: happy path — posts to /bot<token>/getMe, writes botInfo", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    {
      ok: true,
      result: {
        id: 987654321,
        is_bot: true,
        first_name: "SwampNotifyBot",
        username: "swamp_notify_bot",
      },
    },
    200,
    async (calls) => {
      await run("getMe", {}, ctx);
      assertEquals(calls.length, 1);
      assertEquals(new URL(calls[0].url).pathname, `/bot${TOKEN}/getMe`);
      assertEquals(calls[0].method, "POST");
    },
  );
  const res = written.find((w) => w.spec === "botInfo");
  assert(res);
  assertEquals(res.name, "main");
  assertEquals(res.payload.id, 987654321);
  assertEquals(res.payload.isBot, true);
  assertEquals(res.payload.firstName, "SwampNotifyBot");
});

Deno.test("getMe: error path — ok:false throws 'Telegram API error (getMe): <code> <description>'", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () => run("getMe", {}, ctx),
      Error,
      "Telegram API error (getMe): 400 Bad Request: chat not found",
    );
  });
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

Deno.test("sendMessage: happy path — falls back to defaultChatId, writes msg-<id>", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    OK_MESSAGE({ text: "hello" }),
    200,
    async (calls) => {
      await run("sendMessage", { text: "hello" }, ctx);
      assertEquals(
        new URL(calls[0].url).pathname,
        `/bot${TOKEN}/sendMessage`,
      );
      const body = await requestJsonBody(calls[0]);
      assertEquals(body.chat_id, DEFAULT_CHAT_ID);
      assertEquals(body.text, "hello");
    },
  );
  const res = written.find((w) => w.spec === "sentMessage");
  assert(res);
  assertEquals(res.name, "msg-2001");
  assertEquals(res.payload.text, "hello");
});

Deno.test("sendMessage: explicit chatId overrides defaultChatId", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(OK_MESSAGE(), 200, async (calls) => {
    await run("sendMessage", { chatId: "111", text: "hi" }, ctx);
    const body = await requestJsonBody(calls[0]);
    assertEquals(body.chat_id, "111");
  });
});

Deno.test("sendMessage: optional args (parseMode, disableWebPagePreview, disableNotification, replyToMessageId) are sent snake_case", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(OK_MESSAGE(), 200, async (calls) => {
    await run("sendMessage", {
      text: "hi",
      parseMode: "HTML",
      disableWebPagePreview: true,
      disableNotification: true,
      replyToMessageId: 42,
    }, ctx);
    const body = await requestJsonBody(calls[0]);
    assertEquals(body.parse_mode, "HTML");
    assertEquals(body.disable_web_page_preview, true);
    assertEquals(body.disable_notification, true);
    assertEquals(body.reply_to_message_id, 42);
  });
});

Deno.test("sendMessage: error path — ok:false throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () => run("sendMessage", { text: "hi" }, ctx),
      Error,
      "Telegram API error (sendMessage)",
    );
  });
});

// ---------------------------------------------------------------------------
// sendPhoto — all three attachment-routing branches
// ---------------------------------------------------------------------------

Deno.test("sendPhoto: https URL — JSON branch, photo sent as-is", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    OK_MESSAGE({ caption: "cat" }),
    200,
    async (calls) => {
      await run(
        "sendPhoto",
        { photo: "https://example.com/cat.png", caption: "cat" },
        ctx,
      );
      assertEquals(new URL(calls[0].url).pathname, `/bot${TOKEN}/sendPhoto`);
      const body = await requestJsonBody(calls[0]);
      assertEquals(body.photo, "https://example.com/cat.png");
      assertEquals(body.caption, "cat");
    },
  );
  const res = written.find((w) => w.spec === "sentMessage");
  assert(res);
  assertEquals(res.payload.caption, "cat");
});

Deno.test("sendPhoto: bare file_id (no slash, no scheme) — also JSON branch", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(OK_MESSAGE(), 200, async (calls) => {
    await run("sendPhoto", { photo: "AgACAgIAAxkBAAEBcat" }, ctx);
    const contentType = calls[0].headers.get("Content-Type") ?? "";
    assert(
      contentType.includes("application/json"),
      "a bare file_id must route through the JSON branch, not multipart",
    );
    const body = await requestJsonBody(calls[0]);
    assertEquals(body.photo, "AgACAgIAAxkBAAEBcat");
  });
});

Deno.test("sendPhoto: local path — multipart branch, uploads file bytes as a Blob", async () => {
  const { ctx, written } = makeCtx();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
  await withReadFileStub(bytes, async () => {
    await withOneResponse(
      OK_MESSAGE({ caption: "local cat" }),
      200,
      async (calls) => {
        await run(
          "sendPhoto",
          { photo: "/tmp/pics/cat.png", caption: "local cat" },
          ctx,
        );
        assertEquals(
          new URL(calls[0].url).pathname,
          `/bot${TOKEN}/sendPhoto`,
        );
        const contentType = calls[0].headers.get("Content-Type") ?? "";
        assert(
          contentType.includes("multipart/form-data"),
          "a local path must route through the multipart branch",
        );
        const form = await calls[0].clone().formData();
        assertEquals(form.get("chat_id"), DEFAULT_CHAT_ID);
        assertEquals(form.get("caption"), "local cat");
        const file = form.get("photo") as File;
        assert(file instanceof File);
        assertEquals(file.name, "cat.png");
        const uploaded = new Uint8Array(await file.arrayBuffer());
        assertEquals(uploaded, bytes);
      },
    );
  });
  const res = written.find((w) => w.spec === "sentMessage");
  assert(res);
  assertEquals(res.payload.caption, "local cat");
});

Deno.test("sendPhoto: error path (JSON branch) — ok:false throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () => run("sendPhoto", { photo: "https://example.com/cat.png" }, ctx),
      Error,
      "Telegram API error (sendPhoto)",
    );
  });
});

// ---------------------------------------------------------------------------
// sendDocument — all three attachment-routing branches
// ---------------------------------------------------------------------------

Deno.test("sendDocument: https URL — JSON branch, document sent as-is", async () => {
  const { ctx, written } = makeCtx();
  await withOneResponse(
    OK_MESSAGE({ caption: "report" }),
    200,
    async (calls) => {
      await run(
        "sendDocument",
        { document: "https://example.com/report.pdf", caption: "report" },
        ctx,
      );
      assertEquals(
        new URL(calls[0].url).pathname,
        `/bot${TOKEN}/sendDocument`,
      );
      const body = await requestJsonBody(calls[0]);
      assertEquals(body.document, "https://example.com/report.pdf");
      assertEquals(body.caption, "report");
    },
  );
  const res = written.find((w) => w.spec === "sentMessage");
  assert(res);
  assertEquals(res.payload.caption, "report");
});

Deno.test("sendDocument: bare file_id (no slash, no scheme) — also JSON branch", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(OK_MESSAGE(), 200, async (calls) => {
    await run("sendDocument", { document: "BQACAgIAAxkBdocEXAMPLE" }, ctx);
    const contentType = calls[0].headers.get("Content-Type") ?? "";
    assert(
      contentType.includes("application/json"),
      "a bare file_id must route through the JSON branch, not multipart",
    );
  });
});

Deno.test("sendDocument: local path — multipart branch, uploads file bytes as a Blob named from the path", async () => {
  const { ctx, written } = makeCtx();
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  await withReadFileStub(bytes, async () => {
    await withOneResponse(
      OK_MESSAGE({ caption: "nightly report" }),
      200,
      async (calls) => {
        await run(
          "sendDocument",
          { document: "/tmp/reports/nightly.pdf", caption: "nightly report" },
          ctx,
        );
        const contentType = calls[0].headers.get("Content-Type") ?? "";
        assert(contentType.includes("multipart/form-data"));
        const form = await calls[0].clone().formData();
        const file = form.get("document") as File;
        assert(file instanceof File);
        assertEquals(file.name, "nightly.pdf");
        const uploaded = new Uint8Array(await file.arrayBuffer());
        assertEquals(uploaded, bytes);
      },
    );
  });
  const res = written.find((w) => w.spec === "sentMessage");
  assert(res);
  assertEquals(res.payload.caption, "nightly report");
});

Deno.test("sendDocument: local path with no subdirectory (bare basename via split/pop) still names the Blob", async () => {
  // filePath.split("/").pop() || "upload.bin" — a path with a leading slash
  // and no further segments exercises the split/pop basename extraction, NOT
  // the `|| "upload.bin"` fallback (that fallback is exercised separately,
  // by the very next test, for a path that ENDS in "/").
  const { ctx } = makeCtx();
  const bytes = new Uint8Array([1, 2, 3]);
  await withReadFileStub(bytes, async () => {
    await withOneResponse(OK_MESSAGE(), 200, async (calls) => {
      await run("sendDocument", { document: "./report.pdf" }, ctx);
      const form = await calls[0].clone().formData();
      const file = form.get("document") as File;
      assertEquals(file.name, "report.pdf");
    });
  });
});

Deno.test("sendDocument: local path ending in '/' falls back to the literal 'upload.bin' filename", async () => {
  // filePath.split("/").pop() returns "" for a trailing-slash path, which is
  // falsy, so `|| "upload.bin"` DOES engage here. Pinned as a documented edge
  // case: a directory-shaped `document` arg still uploads under a fixed name.
  const { ctx } = makeCtx();
  const bytes = new Uint8Array([1, 2, 3]);
  await withReadFileStub(bytes, async () => {
    await withOneResponse(OK_MESSAGE(), 200, async (calls) => {
      await run("sendDocument", { document: "/tmp/reports/" }, ctx);
      const form = await calls[0].clone().formData();
      const file = form.get("document") as File;
      assertEquals(file.name, "upload.bin");
    });
  });
});

Deno.test("sendDocument: error path (JSON branch) — ok:false throws", async () => {
  const { ctx } = makeCtx();
  await withOneResponse(ERROR_BODY, 200, async () => {
    await assertRejects(
      () =>
        run(
          "sendDocument",
          { document: "https://example.com/report.pdf" },
          ctx,
        ),
      Error,
      "Telegram API error (sendDocument)",
    );
  });
});

// ---------------------------------------------------------------------------
// Token-leak assertions across every method (JSON and multipart branches)
// ---------------------------------------------------------------------------

Deno.test("the bot token never appears in any written resource across all 4 methods (JSON branches)", async () => {
  const scenarios: Array<[string, Record<string, unknown>, unknown]> = [
    ["getMe", {}, {
      ok: true,
      result: { id: 1, is_bot: true, first_name: "Bot" },
    }],
    ["sendMessage", { text: "hi" }, OK_MESSAGE({ text: "hi" })],
    [
      "sendPhoto",
      { photo: "https://example.com/cat.png" },
      OK_MESSAGE({ caption: "cat" }),
    ],
    [
      "sendDocument",
      { document: "https://example.com/report.pdf" },
      OK_MESSAGE({ caption: "report" }),
    ],
  ];
  for (const [name, args, response] of scenarios) {
    const { ctx, written, logs } = makeCtx();
    await withOneResponse(response, 200, async () => {
      await run(name, args, ctx);
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(!s.includes(TOKEN), `${name}: botToken leaked into ${w.spec}`);
    }
    for (const l of logs) {
      const s = JSON.stringify(l.args);
      assert(!s.includes(TOKEN), `${name}: botToken leaked into a log call`);
    }
  }
});

Deno.test("the bot token never appears in a written resource for the multipart branches either", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  for (
    const [name, argKey] of [
      ["sendPhoto", "photo"],
      ["sendDocument", "document"],
    ] as const
  ) {
    const { ctx, written } = makeCtx();
    await withReadFileStub(bytes, async () => {
      await withOneResponse(
        OK_MESSAGE({ caption: "x" }),
        200,
        async () => {
          await run(
            name,
            { [argKey]: "/tmp/local/file.bin", caption: "x" },
            ctx,
          );
        },
      );
    });
    for (const w of written) {
      const s = JSON.stringify(w.payload);
      assert(!s.includes(TOKEN), `${name}: botToken leaked into ${w.spec}`);
    }
  }
});

Deno.test("no method calls the logger at all today (pin — a future change that starts logging must add its own leak test)", async () => {
  const { ctx, logs } = makeCtx();
  await withOneResponse(
    { ok: true, result: { id: 1, is_bot: true, first_name: "Bot" } },
    200,
    async () => {
      await run("getMe", {}, ctx);
    },
  );
  assertEquals(logs.length, 0);
});
