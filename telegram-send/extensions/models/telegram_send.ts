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
 * POST a JSON-bodied request to the Bot API and unwrap the `result` envelope.
 * Throws on non-`ok` responses with the API's `error_code` + `description`.
 */
async function telegramJson(token, method, body) {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
 * URL or `file_id`.
 */
async function telegramMultipart(token, method, fields, fileField, filePath) {
  const fileBytes = await Deno.readFile(filePath);
  const fileName = filePath.split("/").pop() || "upload.bin";
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  form.append(fileField, new Blob([fileBytes]), fileName);

  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
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
 * `globalArgs.defaultChatId`. Throws if neither is set.
 */
function resolveChatId(args, context) {
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
 * Telegram `file_id` and sent via JSON.
 */
function isLocalPath(s) {
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
  version: "2026.05.13.1",
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
