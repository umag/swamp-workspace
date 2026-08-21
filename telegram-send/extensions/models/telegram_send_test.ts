/**
 * Contract-fixture suite: pins BOTH the pure-helper behavior (isLocalPath,
 * resolveChatId — unit tests kept from the pre-backfill suite) AND the
 * concrete Telegram Bot API wire shape from telegram-send/fixtures/*.json,
 * independent of any live network call. See fixtures/PROVENANCE.md for
 * fixture provenance (doc-derived synthetic only, no live tg-bot/tg-anilist
 * capture, no telegram vault BOT_TOKEN read).
 *
 * All fixture-driven tests below are offline: fixtures are fed through a
 * stubbed fetch (the porkbun-precedent `as typeof globalThis.fetch` cast), no
 * network call is ever made.
 *
 * telegram_send.ts is UNMODIFIED by this backfill — every fixture-driven test
 * here is a characterization test that PINS the model's current,
 * already-shipped behavior.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { isLocalPath, model, resolveChatId } from "./telegram_send.ts";
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
import sendVideoFixture from "../../fixtures/sendVideo.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Pure-helper tests — unchanged from the pre-backfill suite (isLocalPath x3,
// resolveChatId x3). Only the assert-import specifier was standardized (round
// -1 code LOW) from https://deno.land/std@0.224.0 to jsr:@std/assert@1, to
// match the four new suites.
// ---------------------------------------------------------------------------

Deno.test("isLocalPath: https/http URLs are NOT local paths", () => {
  assertEquals(isLocalPath("https://example.com/cat.png"), false);
  assertEquals(isLocalPath("http://example.com/cat.png"), false);
  assertEquals(isLocalPath("HTTPS://EXAMPLE.COM/x.png"), false);
});

Deno.test("isLocalPath: a path with a slash is a local path", () => {
  assert(isLocalPath("/tmp/cat.png"));
  assert(isLocalPath("./relative/cat.png"));
  assert(isLocalPath("subdir/cat.png"));
});

Deno.test("isLocalPath: a bare file_id (no slash, no scheme) is NOT a local path", () => {
  // Telegram file_ids contain no slash → sent via JSON, not multipart.
  assertEquals(isLocalPath("AgACAgIAAxkBAAEBcat"), false);
  assertEquals(isLocalPath("upload.bin"), false);
});

Deno.test("resolveChatId: method chatId arg wins over defaultChatId", () => {
  assertEquals(
    resolveChatId({ chatId: "111" }, { globalArgs: { defaultChatId: "999" } }),
    "111",
  );
});

Deno.test("resolveChatId: falls back to defaultChatId when arg omitted", () => {
  assertEquals(
    resolveChatId({}, { globalArgs: { defaultChatId: "999" } }),
    "999",
  );
});

Deno.test("resolveChatId: throws when neither chatId nor defaultChatId is set", () => {
  assertThrows(
    () => resolveChatId({}, { globalArgs: {} }),
    Error,
    "chatId not provided",
  );
});

// ---------------------------------------------------------------------------
// Harness for fixture-driven wire pins
// ---------------------------------------------------------------------------

// Deliberately NOT token-shaped: letters-first, no colon anywhere, so it
// structurally cannot match the real-token regex /\d+:[A-Za-z0-9_-]{30,}/
// that the adversarial suite's fixtures-secret-scan runs (round-1 adversarial
// MEDIUM — sentinels used in test source must be provably non-token-shaped).
const GLOBAL_ARGS = {
  botToken: "FAKE-BOT-TOKEN-SENTINEL-NOT-REAL-0000",
  defaultChatId: "555000111",
};

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

/** Stub fetch to return the given full Bot API envelope (`{ok, result}` or
 * `{ok:false, error_code, description}`) verbatim as the JSON response body. */
function withEnvelope(envelope: unknown, fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

/** As withEnvelope, but also records each request's decoded JSON body so a test
 * can assert what actually went ON THE WIRE, not just what came back. */
function withEnvelopeCapturing(
  envelope: unknown,
  sink: Array<Record<string, unknown>>,
  fn: () => Promise<unknown>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const raw = init?.body;
    if (typeof raw === "string") {
      sink.push(JSON.parse(raw) as Record<string, unknown>);
    }
    return Promise.resolve(
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test("this suite's botToken sentinel is provably non-token-shaped (consistency check with the methods/adversarial suites)", () => {
  // Mirrors the equivalent self-check in telegram_send_adversarial_test.ts —
  // any token sentinel used across ANY suite must be structurally incapable
  // of matching the real-token regex, not just visually distinct from one.
  const realTokenShape = /\d+:[A-Za-z0-9_-]{30,}/;
  assert(!realTokenShape.test(GLOBAL_ARGS.botToken));
  assert(!GLOBAL_ARGS.botToken.includes(":"));
});

// ---------------------------------------------------------------------------
// getMe.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: getMe.json — envelope keyset {ok, result}, botInfo maps every snake_case field to camelCase", async () => {
  assertEquals(Object.keys(getMeFixture).sort(), ["ok", "result"]);
  const { ctx, written } = makeCtx();
  await withEnvelope(getMeFixture, () => run("getMe", {}, ctx));
  const res = written.find((w) => w.spec === "botInfo")!;
  const r = getMeFixture.result;
  assertEquals(res.payload.id, r.id);
  assertEquals(res.payload.isBot, r.is_bot);
  assertEquals(res.payload.firstName, r.first_name);
  assertEquals(res.payload.username, r.username);
  assertEquals(res.payload.canJoinGroups, r.can_join_groups);
  assertEquals(
    res.payload.canReadAllGroupMessages,
    r.can_read_all_group_messages,
  );
  assertEquals(res.payload.supportsInlineQueries, r.supports_inline_queries);
  assertEquals(typeof res.payload.timestamp, "string");
});

// ---------------------------------------------------------------------------
// sendMessage.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: sendMessage.json — messageId<-message_id, chatId<-chat.id, text carried, caption absent", async () => {
  const { ctx, written } = makeCtx();
  await withEnvelope(
    sendMessageFixture,
    () => run("sendMessage", { text: "Hello from swamp" }, ctx),
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  const r = sendMessageFixture.result;
  assertEquals(res.name, `msg-${r.message_id}`);
  assertEquals(res.payload.messageId, r.message_id);
  assertEquals(res.payload.chatId, r.chat.id);
  assertEquals(res.payload.date, r.date);
  assertEquals(res.payload.text, r.text);
  assert(
    !("caption" in res.payload) || res.payload.caption === undefined,
    "sendMessage's mapper never sets caption",
  );
});

// ---------------------------------------------------------------------------
// sendPhoto.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: sendPhoto.json (URL branch) — messageId/chatId/date/caption mapped, text absent", async () => {
  const { ctx, written } = makeCtx();
  await withEnvelope(
    sendPhotoFixture,
    () => run("sendPhoto", { photo: "https://example.com/cat.png" }, ctx),
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  const r = sendPhotoFixture.result;
  assertEquals(res.name, `msg-${r.message_id}`);
  assertEquals(res.payload.messageId, r.message_id);
  assertEquals(res.payload.chatId, r.chat.id);
  assertEquals(res.payload.date, r.date);
  assertEquals(res.payload.caption, r.caption);
  assert(
    !("text" in res.payload) || res.payload.text === undefined,
    "sendPhoto's mapper never sets text",
  );
});

// ---------------------------------------------------------------------------
// sendDocument.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: sendDocument.json (URL branch) — messageId/chatId/date/caption mapped, text absent", async () => {
  const { ctx, written } = makeCtx();
  await withEnvelope(
    sendDocumentFixture,
    () =>
      run(
        "sendDocument",
        { document: "https://example.com/report.pdf" },
        ctx,
      ),
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  const r = sendDocumentFixture.result;
  assertEquals(res.name, `msg-${r.message_id}`);
  assertEquals(res.payload.messageId, r.message_id);
  assertEquals(res.payload.chatId, r.chat.id);
  assertEquals(res.payload.date, r.date);
  assertEquals(res.payload.caption, r.caption);
  assert(
    !("text" in res.payload) || res.payload.text === undefined,
    "sendDocument's mapper never sets text",
  );
});

Deno.test("contract: sendVideo.json (URL branch) — messageId/chatId/date/caption mapped, text absent", async () => {
  const { ctx, written } = makeCtx();
  await withEnvelope(
    sendVideoFixture,
    () =>
      run(
        "sendVideo",
        { video: "https://example.com/timelapse.mp4" },
        ctx,
      ),
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  const r = sendVideoFixture.result;
  assertEquals(res.name, `msg-${r.message_id}`);
  assertEquals(res.payload.messageId, r.message_id);
  assertEquals(res.payload.chatId, r.chat.id);
  assertEquals(res.payload.date, r.date);
  assertEquals(res.payload.caption, r.caption);
  assert(
    !("text" in res.payload) || res.payload.text === undefined,
    "sendVideo's mapper never sets text",
  );
});

Deno.test("sendVideo: width/height ride the wire on the URL branch, and are omitted when not given", async () => {
  // width/height are the only fields sendVideo adds over sendDocument, so they
  // are the part a copy-paste port is most likely to drop.
  const seen: Array<Record<string, unknown>> = [];
  const { ctx } = makeCtx();
  await withEnvelopeCapturing(sendVideoFixture, seen, () =>
    run("sendVideo", {
      video: "https://example.com/timelapse.mp4",
      width: 1280,
      height: 720,
    }, ctx));
  assertEquals(seen[0]?.width, 1280);
  assertEquals(seen[0]?.height, 720);
  assertEquals(seen[0]?.video, "https://example.com/timelapse.mp4");

  const { ctx: ctx2 } = makeCtx();
  await withEnvelopeCapturing(sendVideoFixture, seen, () =>
    run("sendVideo", {
      video: "https://example.com/timelapse.mp4",
    }, ctx2));
  assertEquals(seen[1]?.width, undefined);
  assertEquals(seen[1]?.height, undefined);
});

// ---------------------------------------------------------------------------
// error.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: error.json — {ok:false, error_code, description} throws 'Telegram API error (<method>): <code> <description>'", async () => {
  assertEquals(Object.keys(errorFixture).sort(), [
    "description",
    "error_code",
    "ok",
  ]);
  const { ctx } = makeCtx();
  let threw: unknown;
  await withEnvelope(errorFixture, async () => {
    try {
      await run("getMe", {}, ctx);
    } catch (err) {
      threw = err;
    }
  });
  assert(threw instanceof Error);
  assertEquals(
    (threw as Error).message,
    `Telegram API error (getMe): ${errorFixture.error_code} ${errorFixture.description}`,
  );
});
