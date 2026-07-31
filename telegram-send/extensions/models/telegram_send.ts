import { z } from "npm:zod@4";

const API_BASE = "https://api.telegram.org";

const ParseMode = z.enum(["MarkdownV2", "HTML", "Markdown"]);

const GlobalArgsSchema = z.object({
  botToken: z
    .string()
    .meta({ sensitive: true })
    .describe("Telegram Bot API token from @BotFather"),
  defaultChatId: z
    .string()
    .optional()
    .describe(
      "Default chat_id (numeric ID, @channelusername, or @username) used when a method omits chatId",
    ),
});

const SentMessageSchema = z.object({
  messageId: z.number(),
  chatId: z.union([z.number(), z.string()]),
  date: z.number(),
  text: z.string().optional(),
  caption: z.string().optional(),
  timestamp: z.string(),
});

const BotInfoSchema = z.object({
  id: z.number(),
  isBot: z.boolean(),
  firstName: z.string(),
  username: z.string().optional(),
  canJoinGroups: z.boolean().optional(),
  canReadAllGroupMessages: z.boolean().optional(),
  supportsInlineQueries: z.boolean().optional(),
  timestamp: z.string(),
});

/**
 * Redact the bot token from an error message. Replaces the exact
 * `/bot<token>/` URL segment with `/bot<redacted>/`, then applies a generic
 * `/bot[^/]+/` backstop so any `/bot.../ ` path segment is scrubbed even if
 * the token reaches the message reformatted (re-cased, percent-encoded, or
 * otherwise transformed) rather than byte-for-byte. `message` is `unknown`
 * because a fetch rejection is not guaranteed to be an `Error` with a string
 * `.message` — it may be a `DOMException`, a thrown string, or an arbitrary
 * non-Error value (e.g. one with a custom `toString()`); every shape is
 * coerced to a string before redaction, so no unsanitized value can pass
 * through untouched.
 */
export function redactToken(message: unknown, token: string): string {
  const text = typeof message === "string"
    ? message
    : message instanceof Error
    ? message.message
    : String(message);
  const exactRedacted = token
    ? text.split(`/bot${token}/`).join(
      "/bot<redacted>/",
    )
    : text;
  return exactRedacted.replace(/\/bot[^/]+\//g, "/bot<redacted>/");
}

/**
 * Build a redacted stand-in for `cause`. `cause` must NEVER be the raw
 * rejection: `Deno.inspect()`, `console.log`, and Deno's own uncaught-error
 * printer all walk and print the `cause` chain (including its `.stack`,
 * whose first line embeds the message), so attaching the original error
 * as-is would silently reopen the exact token leak this mapper exists to
 * close. This preserves the error's `name` (and a redacted `.stack`, when
 * present) for downstream diagnostics without ever exposing the raw token.
 */
function redactedCause(err: unknown, token: string): unknown {
  if (err instanceof Error) {
    const redacted = new Error(redactToken(err, token));
    redacted.name = err.name;
    if (typeof err.stack === "string") {
      redacted.stack = redactToken(err.stack, token);
    }
    return redacted;
  }
  return redactToken(err, token);
}

/**
 * POST a JSON-bodied request to the Bot API and unwrap the `result` envelope.
 * Throws on non-`ok` responses with the API's `error_code` + `description`.
 * A network-layer fetch rejection (DNS failure, TLS error, connection reset)
 * is caught and rethrown with its message redacted via `redactToken` —
 * Deno's own fetch-rejection error text typically embeds the request URL,
 * which carries the bot token in its `/bot<token>/` path segment. The
 * original rejection's shape (name, redacted stack) is preserved as `cause`
 * for downstream diagnostics — never the raw rejection itself, since that
 * would carry the token right back through `cause`.
 */
async function telegramJson(token, method, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(redactToken(err, token), {
      cause: redactedCause(err, token),
    });
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(
      `Telegram API error (${method}): ${data.error_code ?? "?"} ${
        data.description ?? "unknown"
      }`,
    );
  }
  return data.result;
}

/**
 * POST a multipart/form-data request uploading `filePath` under `fileField`.
 * Used by `sendPhoto` / `sendDocument` when given a local path rather than a
 * URL or `file_id`. Its `fetch()` call is wrapped the same way as
 * `telegramJson`'s: a rejection is caught and rethrown with its message
 * redacted via `redactToken`, preserving a redacted `cause` (never the raw
 * rejection — see `redactedCause`).
 */
async function telegramMultipart(token, method, fields, fileField, filePath) {
  const fileBytes = await Deno.readFile(filePath);
  const fileName = filePath.split("/").pop() || "upload.bin";
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  form.append(fileField, new Blob([fileBytes]), fileName);

  let res;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    throw new Error(redactToken(err, token), {
      cause: redactedCause(err, token),
    });
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(
      `Telegram API error (${method}): ${data.error_code ?? "?"} ${
        data.description ?? "unknown"
      }`,
    );
  }
  return data.result;
}

/**
 * Resolve the target chat: method `chatId` arg wins, else
 * `globalArgs.defaultChatId`. Throws if neither is set. Exported for tests.
 */
export function resolveChatId(
  args: { chatId?: string },
  context: { globalArgs: { defaultChatId?: string } },
): string {
  const chatId = args.chatId ?? context.globalArgs.defaultChatId;
  if (!chatId) {
    throw new Error(
      "chatId not provided and no defaultChatId set on the model instance",
    );
  }
  return chatId;
}

/**
 * Heuristic: treat the string as a local path if it isn't an http(s) URL and
 * contains a slash. A bare token (no slash, no scheme) is assumed to be a
 * Telegram `file_id` and sent via JSON. Exported for tests.
 */
export function isLocalPath(s: string): boolean {
  return !/^https?:\/\//i.test(s) && s.includes("/");
}

/**
 * `@magistr/telegram/send` — send messages, photos, and documents to Telegram
 * chats via the Bot API.
 *
 * Methods:
 * - `getMe` — verify the token and fetch bot identity (use as smoke test)
 * - `sendMessage` — text message with optional MarkdownV2/HTML formatting
 * - `sendPhoto` — image by URL, file_id, or local path (multipart upload)
 * - `sendDocument` — arbitrary file by URL, file_id, or local path
 *
 * The bot token is stored as a sensitive `globalArgument` and routed to a
 * vault. Set `defaultChatId` on the instance to avoid repeating it on every
 * call.
 *
 * @example
 * swamp model create @magistr/telegram/send tg-bot
 * swamp model method run tg-bot sendMessage --input text='hello'
 */
export const model = {
  type: "@magistr/telegram/send",
  version: "2026.08.01.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    botInfo: {
      description: "Bot identity returned by getMe",
      schema: BotInfoSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    sentMessage: {
      description: "Result of a send* call",
      schema: SentMessageSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    getMe: {
      description:
        "Call getMe to verify the bot token and fetch bot identity. Use as a smoke-test.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { botToken } = context.globalArgs;
        const r = await telegramJson(botToken, "getMe", {});
        const handle = await context.writeResource("botInfo", "main", {
          id: r.id,
          isBot: r.is_bot,
          firstName: r.first_name,
          username: r.username,
          canJoinGroups: r.can_join_groups,
          canReadAllGroupMessages: r.can_read_all_group_messages,
          supportsInlineQueries: r.supports_inline_queries,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    sendMessage: {
      description: "Send a text message to a chat or channel.",
      arguments: z.object({
        chatId: z
          .string()
          .optional()
          .describe(
            "Target chat (numeric ID, @channelusername, or @username). Falls back to defaultChatId.",
          ),
        text: z.string().describe("Message text (1-4096 characters)"),
        parseMode: ParseMode.optional().describe(
          "MarkdownV2, HTML, or Markdown",
        ),
        disableWebPagePreview: z.boolean().optional(),
        disableNotification: z.boolean().optional(),
        replyToMessageId: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { botToken } = context.globalArgs;
        const chatId = resolveChatId(args, context);
        const body = {
          chat_id: chatId,
          text: args.text,
          parse_mode: args.parseMode,
          disable_web_page_preview: args.disableWebPagePreview,
          disable_notification: args.disableNotification,
          reply_to_message_id: args.replyToMessageId,
        };
        const r = await telegramJson(botToken, "sendMessage", body);
        const handle = await context.writeResource(
          "sentMessage",
          `msg-${r.message_id}`,
          {
            messageId: r.message_id,
            chatId: r.chat?.id ?? chatId,
            date: r.date,
            text: r.text,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    sendPhoto: {
      description:
        "Send a photo. `photo` may be an https URL, a Telegram file_id, or a local file path.",
      arguments: z.object({
        chatId: z.string().optional(),
        photo: z
          .string()
          .describe("https URL, Telegram file_id, or local file path"),
        caption: z.string().optional(),
        parseMode: ParseMode.optional(),
        disableNotification: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const { botToken } = context.globalArgs;
        const chatId = resolveChatId(args, context);
        let r;
        if (isLocalPath(args.photo)) {
          r = await telegramMultipart(
            botToken,
            "sendPhoto",
            {
              chat_id: chatId,
              caption: args.caption,
              parse_mode: args.parseMode,
              disable_notification: args.disableNotification,
            },
            "photo",
            args.photo,
          );
        } else {
          r = await telegramJson(botToken, "sendPhoto", {
            chat_id: chatId,
            photo: args.photo,
            caption: args.caption,
            parse_mode: args.parseMode,
            disable_notification: args.disableNotification,
          });
        }
        const handle = await context.writeResource(
          "sentMessage",
          `msg-${r.message_id}`,
          {
            messageId: r.message_id,
            chatId: r.chat?.id ?? chatId,
            date: r.date,
            caption: r.caption,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    sendDocument: {
      description:
        "Send a document/file. `document` may be an https URL, a Telegram file_id, or a local file path.",
      arguments: z.object({
        chatId: z.string().optional(),
        document: z
          .string()
          .describe("https URL, Telegram file_id, or local file path"),
        caption: z.string().optional(),
        parseMode: ParseMode.optional(),
        disableNotification: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const { botToken } = context.globalArgs;
        const chatId = resolveChatId(args, context);
        let r;
        if (isLocalPath(args.document)) {
          r = await telegramMultipart(
            botToken,
            "sendDocument",
            {
              chat_id: chatId,
              caption: args.caption,
              parse_mode: args.parseMode,
              disable_notification: args.disableNotification,
            },
            "document",
            args.document,
          );
        } else {
          r = await telegramJson(botToken, "sendDocument", {
            chat_id: chatId,
            document: args.document,
            caption: args.caption,
            parse_mode: args.parseMode,
            disable_notification: args.disableNotification,
          });
        }
        const handle = await context.writeResource(
          "sentMessage",
          `msg-${r.message_id}`,
          {
            messageId: r.message_id,
            chatId: r.chat?.id ?? chatId,
            date: r.date,
            caption: r.caption,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
