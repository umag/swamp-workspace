/**
 * Coverage suite: reviewer-gap regression pins — behavioral guards found
 * during review that the methods/adversarial suites don't already exercise
 * on both sides, so deleting any one of these guards turns a test red
 * (STANDARD.md's coverage role — a behavioral regression guard, not a
 * numeric percentage).
 *
 * telegram_send.ts is UNMODIFIED; every test here PINS existing behavior.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { model, resolveChatId } from "./telegram_send.ts";

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

type Route = (req: Request) => Response | undefined;

async function withFetchStub(
  routes: Route[],
  fn: (calls: Request[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    for (const r of routes) {
      const res = r(req);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unrouted ${req.url}`));
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

const OK_MESSAGE = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  result: {
    message_id: 4001,
    chat: { id: Number(DEFAULT_CHAT_ID), type: "private" },
    date: 1752600400,
    ...overrides,
  },
});

// ---------------------------------------------------------------------------
// Reviewer-gap: resolveChatId chatId:'' does NOT fall back — `??` only
// catches null/undefined, not empty string, so an explicit "" arg wins over
// defaultChatId and THEN fails the truthiness guard.
// ---------------------------------------------------------------------------

Deno.test("reviewer-gap: resolveChatId chatId:'' does NOT fall back to defaultChatId (?? keeps '', then !chatId throws)", () => {
  // args.chatId ?? context.globalArgs.defaultChatId — `??` only substitutes
  // on null/undefined, so an explicit empty string "" is kept as-is (it is
  // neither null nor undefined). The subsequent `if (!chatId) throw` then
  // fires because "" is falsy. This is DIFFERENT from omitting chatId
  // entirely (undefined DOES fall back — see telegram_send_test.ts). A
  // "helpful" refactor to `args.chatId || context.globalArgs.defaultChatId`
  // would silently change this to fall back on "" too — pinned so that
  // change cannot land unnoticed.
  assertThrows(
    () =>
      resolveChatId({ chatId: "" }, { globalArgs: { defaultChatId: "999" } }),
    Error,
    "chatId not provided",
  );
});

Deno.test("reviewer-gap: resolveChatId with chatId omitted (undefined) DOES fall back — contrast with the '' case above", () => {
  assertEquals(
    resolveChatId({}, { globalArgs: { defaultChatId: "999" } }),
    "999",
  );
});

// ---------------------------------------------------------------------------
// Reviewer-gap: botToken IS marked sensitive today — POSITIVE pin (contrast
// with the porkbun wave-1 backfill's NEGATIVE gap on apiKey/secretApiKey).
// ---------------------------------------------------------------------------

Deno.test("reviewer-gap: botToken IS marked .meta({ sensitive: true }) today — POSITIVE pin", () => {
  // Unlike porkbun's apiKey/secretApiKey (marked NOT sensitive, a documented
  // gap pinned in that extension's own coverage suite), telegram_send.ts's
  // GlobalArgsSchema DOES mark botToken sensitive. This is the credential's
  // one and only structural protection (routes it to a vault instead of
  // plaintext model-instance YAML) — pinned as a POSITIVE guard so a future
  // refactor that drops the .meta() call is caught immediately.
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.botToken) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    true,
    "botToken must stay marked sensitive — this is the credential's only structural protection",
  );
});

Deno.test("reviewer-gap: defaultChatId is NOT marked sensitive — contrast with botToken (chat ids are routing info, not secrets)", () => {
  const shape = (model.globalArguments as z.ZodObject<z.ZodRawShape>).shape;
  const meta = z.globalRegistry.get(shape.defaultChatId) as
    | { sensitive?: boolean }
    | undefined;
  assertEquals(
    meta?.sensitive,
    undefined,
    "defaultChatId is (correctly) not sensitive — it is routing info, not a credential",
  );
});

// ---------------------------------------------------------------------------
// Reviewer-gap: chatId <- r.chat?.id ?? resolved fallback, BOTH branches
// ---------------------------------------------------------------------------

Deno.test("reviewer-gap: sentMessage chatId reads r.chat?.id when the response includes a chat object", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(OK_MESSAGE({ text: "hi" }))],
    async () => {
      await run("sendMessage", { chatId: "111", text: "hi" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  // The response's chat.id (Number(DEFAULT_CHAT_ID) here, deliberately
  // DIFFERENT from the request's chatId:'111') wins — pins the `r.chat?.id`
  // priority over the resolved fallback.
  assertEquals(res.payload.chatId, Number(DEFAULT_CHAT_ID));
});

Deno.test("reviewer-gap: sentMessage chatId falls back to the RESOLVED (request-side) chatId when the response omits chat entirely", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      json({
        ok: true,
        result: { message_id: 4002, date: 1752600401, text: "hi" },
        // no `chat` key at all in the result
      })],
    async () => {
      await run("sendMessage", { chatId: "222", text: "hi" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  assertEquals(
    res.payload.chatId,
    "222",
    "r.chat?.id is undefined -> falls back to the resolved request-side chatId",
  );
});

// ---------------------------------------------------------------------------
// Reviewer-gap: getMe snake_case -> camelCase for every OPTIONAL flag
// ---------------------------------------------------------------------------

Deno.test("reviewer-gap: getMe maps every optional flag (can_join_groups, can_read_all_group_messages, supports_inline_queries) when present", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      json({
        ok: true,
        result: {
          id: 1,
          is_bot: true,
          first_name: "Bot",
          username: "bot_u",
          can_join_groups: true,
          can_read_all_group_messages: true,
          supports_inline_queries: true,
        },
      })],
    async () => {
      await run("getMe", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "botInfo")!;
  assertEquals(res.payload.canJoinGroups, true);
  assertEquals(res.payload.canReadAllGroupMessages, true);
  assertEquals(res.payload.supportsInlineQueries, true);
  assertEquals(res.payload.username, "bot_u");
});

Deno.test("reviewer-gap: getMe leaves every optional flag undefined when the response omits them entirely", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() =>
      json({
        ok: true,
        result: { id: 1, is_bot: true, first_name: "Bot" },
      })],
    async () => {
      await run("getMe", {}, ctx);
    },
  );
  const res = written.find((w) => w.spec === "botInfo")!;
  assertEquals(res.payload.username, undefined);
  assertEquals(res.payload.canJoinGroups, undefined);
  assertEquals(res.payload.canReadAllGroupMessages, undefined);
  assertEquals(res.payload.supportsInlineQueries, undefined);
});

// ---------------------------------------------------------------------------
// Reviewer-gap: sentMessage resource name is templated msg-<id> — per
// -message, no clobber. Contrast with porkbun's dns-created (fixed name,
// documented clobber gap).
// ---------------------------------------------------------------------------

Deno.test("reviewer-gap: two different sendMessage calls write TWO distinctly-named resources (msg-<id> per message, no clobber)", async () => {
  const { ctx, written } = makeCtx();
  let call = 0;
  await withFetchStub(
    [() => {
      call++;
      return json(OK_MESSAGE({ text: `msg ${call}`, message_id: 5000 + call }));
    }],
    async () => {
      await run("sendMessage", { text: "msg 1" }, ctx);
      await run("sendMessage", { text: "msg 2" }, ctx);
    },
  );
  const names = written.filter((w) => w.spec === "sentMessage").map((w) =>
    w.name
  );
  assertEquals(
    names,
    ["msg-5001", "msg-5002"],
    "each sendMessage call templates a distinct resource name from message_id — unlike porkbun's fixed 'dns-created' name, no clobber occurs in a real instance",
  );
});

Deno.test("reviewer-gap: sendPhoto and sendDocument ALSO template msg-<id> — the same per-message convention across every send* method", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(OK_MESSAGE({ caption: "p", message_id: 6001 }))],
    async () => {
      await run("sendPhoto", { photo: "https://example.com/x.png" }, ctx);
    },
  );
  await withFetchStub(
    [() => json(OK_MESSAGE({ caption: "d", message_id: 6002 }))],
    async () => {
      await run(
        "sendDocument",
        { document: "https://example.com/x.pdf" },
        ctx,
      );
    },
  );
  const names = written.filter((w) => w.spec === "sentMessage").map((w) =>
    w.name
  );
  assertEquals(names, ["msg-6001", "msg-6002"]);
});

// ---------------------------------------------------------------------------
// Reviewer-gap (round-1 LOW, folded into v3): per-method text-vs-caption
// mapping asymmetry — sendMessage writes text (never caption); sendPhoto/
// sendDocument write caption (never text) — though SentMessageSchema permits
// BOTH optionals on every method's resource.
// ---------------------------------------------------------------------------

Deno.test("reviewer-gap: sendMessage's sentMessage payload has text SET and caption ABSENT", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(OK_MESSAGE({ text: "hello" }))],
    async () => {
      await run("sendMessage", { text: "hello" }, ctx);
    },
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  assertEquals(res.payload.text, "hello");
  assertEquals(
    res.payload.caption,
    undefined,
    "sendMessage's mapper never reads r.caption",
  );
});

Deno.test("reviewer-gap: sendPhoto's sentMessage payload has caption SET and text ABSENT", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(OK_MESSAGE({ caption: "a photo" }))],
    async () => {
      await run(
        "sendPhoto",
        { photo: "https://example.com/x.png", caption: "a photo" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  assertEquals(res.payload.caption, "a photo");
  assertEquals(
    res.payload.text,
    undefined,
    "sendPhoto's mapper never reads r.text",
  );
});

Deno.test("reviewer-gap: sendDocument's sentMessage payload has caption SET and text ABSENT", async () => {
  const { ctx, written } = makeCtx();
  await withFetchStub(
    [() => json(OK_MESSAGE({ caption: "a doc" }))],
    async () => {
      await run(
        "sendDocument",
        { document: "https://example.com/x.pdf", caption: "a doc" },
        ctx,
      );
    },
  );
  const res = written.find((w) => w.spec === "sentMessage")!;
  assertEquals(res.payload.caption, "a doc");
  assertEquals(
    res.payload.text,
    undefined,
    "sendDocument's mapper never reads r.text",
  );
});

Deno.test("reviewer-gap: SentMessageSchema itself permits BOTH text and caption as optionals — the asymmetry is a mapper choice, not a schema constraint", () => {
  // Confirms the asymmetry pinned above is intentional-by-convention in the
  // three send* mappers, not something the resource schema forces. A
  // hypothetical mapper bug that set BOTH fields would still validate.
  const resources = model.resources as Record<
    string,
    { schema: z.ZodTypeAny }
  >;
  const parsed = resources.sentMessage.schema.parse({
    messageId: 1,
    chatId: "1",
    date: 1,
    text: "both",
    caption: "both",
    timestamp: new Date().toISOString(),
  }) as { text?: string; caption?: string };
  assertEquals(parsed.text, "both");
  assertEquals(parsed.caption, "both");
});
