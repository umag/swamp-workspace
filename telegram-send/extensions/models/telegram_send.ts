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
  webhookSecret: z
    .string()
    .default("")
    .meta({ sensitive: true })
    .describe(
      "secret_token sent to setWebhook; Telegram echoes it in the " +
        "X-Telegram-Bot-Api-Secret-Token header so the receiver can verify " +
        "deliveries. Resolve from a vault, e.g. " +
        "${{ vault.get(secrets, telegram-webhook-secret) }}",
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

const WebhookInfoSchema = z.object({
  action: z.enum(["set", "deleted", "info"]),
  url: z.string(),
  pendingUpdateCount: z.number().optional(),
  ipAddress: z.string().optional(),
  lastErrorDate: z.number().optional(),
  lastErrorMessage: z.string().optional(),
  maxConnections: z.number().optional(),
  hasCustomCertificate: z.boolean().optional(),
  timestamp: z.string(),
});

const DownloadedFileSchema = z.object({
  fileId: z.string(),
  fileName: z.string(),
  mimeType: z.string().optional(),
  base64: z.string().describe(
    "Base64-encoded file content downloaded from Telegram",
  ),
  size: z.number().describe("Byte length of the decoded file"),
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
 * `fetch()` a URL that carries the bot token in its path. A network-layer
 * rejection (DNS failure, TLS error, connection reset) is caught and rethrown
 * with its message redacted via `redactToken` — Deno's own fetch-rejection
 * error text typically embeds the request URL, which carries the bot token in
 * its `/bot<token>/` path segment. The original rejection's shape (name,
 * redacted stack) is preserved as `cause` for downstream diagnostics — never
 * the raw rejection itself, since that would carry the token right back
 * through `cause`. Every Bot API and file-download request goes through here.
 */
async function redactedFetch(
  url: string,
  init: RequestInit | undefined,
  token: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(redactToken(err, token), {
      cause: redactedCause(err, token),
    });
  }
}

/**
 * POST `body` to Bot API `method` and unwrap the `result` envelope. Throws on
 * non-`ok` responses with the API's `error_code` + `description`.
 */
async function telegramPost(token, method, body: BodyInit, headers?) {
  const res = await redactedFetch(
    `${API_BASE}/bot${token}/${method}`,
    { method: "POST", headers, body },
    token,
  );
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

/** POST a JSON-bodied request to the Bot API (see `telegramPost`). */
function telegramJson(token, method, body) {
  return telegramPost(token, method, JSON.stringify(body), {
    "Content-Type": "application/json",
  });
}

/**
 * POST a multipart/form-data request uploading `filePath` under `fileField`.
 * Used by `sendPhoto` / `sendDocument` / `sendVideo` when given a local path
 * rather than a URL or `file_id`.
 */
async function telegramMultipart(token, method, fields, fileField, filePath) {
  const fileBytes = await Deno.readFile(filePath);
  const fileName = filePath.split("/").pop() || "upload.bin";
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  form.append(fileField, new Blob([fileBytes]), fileName);
  return telegramPost(token, method, form);
}

/**
 * Base64-encode bytes without any dependency, chunked so `String.fromCharCode`
 * never receives more arguments than the engine allows. Exported for tests.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Parse a JSON-string method argument, naming the argument on failure so a
 * malformed `richMessage` / `files` value is not reported as a bare
 * `SyntaxError`. Exported for tests.
 */
export function parseJsonArg(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${name} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Build the Bot API reply_markup value. The API wants a JSON-serialised
 * string; an object (convenient from YAML/CEL) is serialised, and a string is
 * passed through untouched so callers can hand-roll markup this schema does
 * not model. Exported for tests.
 */
export function serializeReplyMarkup(
  markup: string | Record<string, unknown> | undefined,
): string | undefined {
  if (markup === undefined) return undefined;
  return typeof markup === "string" ? markup : JSON.stringify(markup);
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
 * `@magistr/telegram/send` — send messages, photos, documents, and videos to
 * Telegram chats via the Bot API.
 *
 * Methods:
 * - `getMe` — verify the token and fetch bot identity (use as smoke test)
 * - `sendMessage` — text message with optional MarkdownV2/HTML formatting
 * - `sendPhoto` — image by URL, file_id, or local path (multipart upload)
 * - `sendDocument` — arbitrary file by URL, file_id, or local path
 * - `sendVideo` — video by URL, file_id, or local path, with optional
 *   width/height so Telegram sizes the player correctly
 * - `sendRichMessage` — Bot API 10.2 block-based rich message (passthrough)
 * - `getFile` — download a file the bot received, as base64
 * - `setWebhook` / `getWebhookInfo` / `deleteWebhook` — manage the bot's
 *   webhook; pair with the `@magistr/telegram-webhook` serve webhook scheme
 *   shipped in this package to receive updates on `swamp serve`
 *
 * The bot token (and optional `webhookSecret`) are sensitive
 * `globalArguments` routed to a vault. Set `defaultChatId` on the instance to
 * avoid repeating it on every call.
 *
 * @example
 * swamp model create @magistr/telegram/send tg-bot
 * swamp model method run tg-bot sendMessage --input text='hello'
 */
export const model = {
  type: "@magistr/telegram/send",
  version: "2026.09.24.1",
  upgrades: [
    {
      toVersion: "2026.09.19.2",
      description:
        "Version bump — repo-wide maintenance release; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.24.1",
      description:
        "Adds the optional webhookSecret global argument (defaults to empty); " +
        "existing attributes carry over unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
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
    webhookInfo: {
      description: "Result of setWebhook / deleteWebhook / getWebhookInfo",
      schema: WebhookInfoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    downloadedFile: {
      description: "A file downloaded from Telegram via getFile (base64)",
      schema: DownloadedFileSchema,
      lifetime: "infinite",
      garbageCollection: 20,
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

    getFile: {
      description:
        "Download a file the bot received (e.g. a document sent to the bot) by " +
        "its file_id. Calls getFile to resolve the storage path, downloads the " +
        "bytes, and emits them base64-encoded as a `downloadedFile` resource. " +
        "Telegram's getFile is limited to files up to 20 MB.",
      arguments: z.object({
        fileId: z.string().describe(
          "Telegram file_id (from message.document.file_id / a webhook update)",
        ),
        fileName: z.string().optional().describe(
          "Original file name to record (Telegram's getFile does not return it)",
        ),
        mimeType: z.string().optional().describe(
          "Original MIME type to record",
        ),
      }),
      execute: async (args, context) => {
        const { botToken } = context.globalArgs;
        const info = await telegramJson(botToken, "getFile", {
          file_id: args.fileId,
        });
        const filePath = info.file_path;
        if (!filePath) {
          throw new Error(
            `getFile returned no file_path for file_id ${args.fileId}`,
          );
        }
        const res = await redactedFetch(
          `${API_BASE}/file/bot${botToken}/${filePath}`,
          undefined,
          botToken,
        );
        if (!res.ok) {
          throw new Error(
            `Failed to download Telegram file (${res.status}): ${filePath}`,
          );
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const fallbackName = String(filePath).split("/").pop() || "file.bin";
        const handle = await context.writeResource(
          "downloadedFile",
          args.fileId,
          {
            fileId: args.fileId,
            fileName: args.fileName ?? fallbackName,
            mimeType: args.mimeType,
            base64: bytesToBase64(bytes),
            size: bytes.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    setWebhook: {
      description:
        "Register a webhook URL so Telegram POSTs updates to it (replacing " +
        "getUpdates). Sends the webhookSecret globalArg as secret_token, which " +
        "Telegram echoes in the X-Telegram-Bot-Api-Secret-Token header for the " +
        "receiver to verify. One webhook per bot — this replaces any existing.",
      arguments: z.object({
        url: z.string().describe("HTTPS URL Telegram should POST updates to"),
        dropPendingUpdates: z.boolean().default(false).describe(
          "Discard updates queued before the webhook was set",
        ),
        allowedUpdates: z.array(z.string()).default([]).describe(
          "Update types to receive (empty = Telegram default: all but " +
            "chat_member)",
        ),
      }),
      execute: async (args, context) => {
        const { botToken, webhookSecret } = context.globalArgs;
        if (!webhookSecret) {
          throw new Error(
            "webhookSecret is empty — set it (from a vault) before setWebhook, " +
              "so deliveries carry a verifiable secret_token",
          );
        }
        const body: Record<string, unknown> = {
          url: args.url,
          secret_token: webhookSecret,
          drop_pending_updates: args.dropPendingUpdates,
        };
        if (args.allowedUpdates.length > 0) {
          body.allowed_updates = args.allowedUpdates;
        }
        await telegramJson(botToken, "setWebhook", body);
        const handle = await context.writeResource("webhookInfo", "main", {
          action: "set",
          url: args.url,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    getWebhookInfo: {
      description:
        "Fetch the bot's current webhook registration (URL, pending updates, " +
        "and the last delivery error if any). Read this to confirm a setWebhook.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { botToken } = context.globalArgs;
        const r = await telegramJson(botToken, "getWebhookInfo", {});
        const handle = await context.writeResource("webhookInfo", "main", {
          action: "info",
          url: r.url ?? "",
          pendingUpdateCount: r.pending_update_count,
          ipAddress: r.ip_address,
          lastErrorDate: r.last_error_date,
          lastErrorMessage: r.last_error_message,
          maxConnections: r.max_connections,
          hasCustomCertificate: r.has_custom_certificate,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    deleteWebhook: {
      description:
        "Remove the bot's webhook (Telegram reverts to getUpdates). Use to " +
        "roll back a setWebhook.",
      arguments: z.object({
        dropPendingUpdates: z.boolean().default(false),
      }),
      execute: async (args, context) => {
        const { botToken } = context.globalArgs;
        await telegramJson(botToken, "deleteWebhook", {
          drop_pending_updates: args.dropPendingUpdates,
        });
        const handle = await context.writeResource("webhookInfo", "main", {
          action: "deleted",
          url: "",
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
        replyMarkup: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe(
            'Telegram reply markup, e.g. an inline keyboard: {"inline_keyboard":[[{"text":"ACK","callback_data":"ack:<id>"}]]}. Accepts an object or a pre-serialised JSON string.',
          ),
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
          reply_markup: serializeReplyMarkup(args.replyMarkup),
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

    sendRichMessage: {
      description:
        "Send a Rich Message (Bot API 10.2 block-based 'article' formatting: headings, paragraphs, tables, quotations, details, dividers, photo blocks). Pass the full InputRichMessage as `richMessage` JSON ({text?, parse_mode?, entities?, blocks?[], media?[]}); local-file media goes in `files` as {attachName: localPath}, uploaded via multipart and referenced in blocks/media as `attach://<attachName>`. Thin passthrough so it tracks the evolving API without hard-coding block internals.",
      arguments: z.object({
        chatId: z.string().optional(),
        richMessage: z
          .string()
          .describe(
            "InputRichMessage as a JSON string: {text?, parse_mode?, entities?, blocks?[], media?[]}",
          ),
        files: z
          .string()
          .optional()
          .describe(
            "JSON map {attachName: localPath}; each uploaded multipart and referenced as attach://<name> inside blocks/media",
          ),
        disableNotification: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const { botToken } = context.globalArgs;
        const chatId = resolveChatId(args, context);
        const rich = parseJsonArg("richMessage", args.richMessage);
        const files = args.files
          ? parseJsonArg("files", args.files) as Record<string, unknown>
          : {};
        let r;
        if (Object.keys(files).length > 0) {
          const form = new FormData();
          form.append("chat_id", String(chatId));
          form.append("rich_message", JSON.stringify(rich));
          if (args.disableNotification !== undefined) {
            form.append(
              "disable_notification",
              String(args.disableNotification),
            );
          }
          for (const [name, rawPath] of Object.entries(files)) {
            const path = String(rawPath);
            const bytes = await Deno.readFile(path);
            form.append(name, new Blob([bytes]), path.split("/").pop() || name);
          }
          r = await telegramPost(botToken, "sendRichMessage", form);
        } else {
          r = await telegramJson(botToken, "sendRichMessage", {
            chat_id: chatId,
            rich_message: rich,
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
            text: r.text,
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

    sendVideo: {
      description:
        "Send a video. `video` may be an https URL, a Telegram file_id, or a local file path.",
      arguments: z.object({
        chatId: z.string().optional(),
        video: z
          .string()
          .describe("https URL, Telegram file_id, or local file path"),
        caption: z.string().optional(),
        parseMode: ParseMode.optional(),
        width: z.number().optional().describe("Video width"),
        height: z.number().optional().describe("Video height"),
        disableNotification: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const { botToken } = context.globalArgs;
        const chatId = resolveChatId(args, context);
        let r;
        if (isLocalPath(args.video)) {
          r = await telegramMultipart(
            botToken,
            "sendVideo",
            {
              chat_id: chatId,
              caption: args.caption,
              parse_mode: args.parseMode,
              width: args.width,
              height: args.height,
              disable_notification: args.disableNotification,
            },
            "video",
            args.video,
          );
        } else {
          r = await telegramJson(botToken, "sendVideo", {
            chat_id: chatId,
            video: args.video,
            caption: args.caption,
            parse_mode: args.parseMode,
            width: args.width,
            height: args.height,
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
