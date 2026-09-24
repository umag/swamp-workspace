// Copyright 2026 magistr.
// SPDX-License-Identifier: MIT

/**
 * `@magistr/telegram-webhook` — a swamp serve webhook verifier for the Telegram
 * Bot API.
 *
 * Telegram authenticates its webhook deliveries with a STATIC secret token: you
 * register it via `setWebhook(secret_token=…)` and Telegram then echoes it
 * verbatim in the `X-Telegram-Bot-Api-Secret-Token` request header on every
 * update — there is no body HMAC. swamp's built-in webhook schemes are all
 * HMAC-over-body, so none can verify a Telegram delivery. This extension closes
 * that gap (swamp Lab #2204 shipped webhook extensions for exactly this): with
 * it, Telegram calls a `swamp serve` webhook endpoint DIRECTLY — no translator
 * bridge, no `getUpdates` poller.
 *
 * The verifier compares the header against the endpoint secret in constant time
 * (SHA-256 digests, never `===` on the raw secret). It shapes nothing and
 * responds with the default `200 {"status":"queued"}`, so the workflow bound to
 * the route sees the raw Telegram Update and reads e.g.
 * `webhook.body.callback_query.data` to dispatch inline-button taps.
 *
 * Security: a static token is weaker than an HMAC (no body integrity, and a
 * captured request is replayable) — serve this endpoint over TLS only. The
 * secret-token header is named as `signatureHeader`, so serve redacts it before
 * the payload reaches any workflow.
 */

import { z } from "npm:zod@4";

/** Telegram's fixed secret-token header (lowercased, as serve compares). */
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** SHA-256 digest of a UTF-8 string. */
export async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** Constant-time equality of two byte arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Constant-time comparison of the presented token against the secret. Comparing
 * SHA-256 digests keeps the compare fixed-length and independent of the raw
 * values, so it leaks neither the secret's length nor a byte-by-byte match
 * position through timing.
 */
export async function tokenMatches(
  presented: string,
  secret: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(secret)]);
  return bytesEqual(a, b);
}

/** Optional per-endpoint config: override the header name if ever needed. */
export const TelegramWebhookConfig = z.object({
  header: z.string().default(TELEGRAM_SECRET_HEADER).describe(
    "Lowercased header carrying Telegram's static secret token",
  ),
});

/**
 * Label a Telegram `User` object: @username, else first name, else numeric id,
 * else "". Shared by every view so they name the sender identically.
 */
export function senderLabel(user: unknown): string {
  const u = (user && typeof user === "object")
    ? user as Record<string, unknown>
    : {};
  if (typeof u.username === "string" && u.username) return `@${u.username}`;
  if (typeof u.first_name === "string" && u.first_name) return u.first_name;
  return u.id !== undefined ? String(u.id) : "";
}

/** Flat callback fields surfaced onto `webhook.body.callback` for workflows. */
export interface CallbackView {
  /** callback_query.id — pass to answerCallbackQuery to clear the spinner. */
  id: string;
  /** Raw callback_data, e.g. "ia:incident-123". */
  data: string;
  /** Part of `data` before the first ":" — the action, e.g. "ia". */
  kind: string;
  /** Part of `data` after the first ":" — the argument, e.g. "incident-123". */
  arg: string;
  /** Who tapped: @username, else first name, else numeric id. */
  from: string;
}

/** Empty callback view for updates that are not inline-button taps. */
const EMPTY_CALLBACK: CallbackView = {
  id: "",
  data: "",
  kind: "",
  arg: "",
  from: "",
};

/**
 * Lift a Telegram callback_query into a flat `callback` view so a workflow can
 * route on `webhook.body.callback.kind` / `.arg` without CEL string-slicing
 * (swamp CEL has no substring). `data` is split on the FIRST ":" into
 * kind:arg — the widely-used Telegram callback_data convention. Non-callback
 * updates get an all-empty callback so a bound workflow starts and no-ops
 * rather than aborting on a missing field.
 */
export function callbackView(body: unknown): CallbackView {
  const b = (body && typeof body === "object")
    ? body as Record<string, unknown>
    : {};
  const cq = b.callback_query;
  if (!cq || typeof cq !== "object") return EMPTY_CALLBACK;
  const q = cq as Record<string, unknown>;
  const data = typeof q.data === "string" ? q.data : "";
  const colon = data.indexOf(":");
  const kind = colon >= 0 ? data.slice(0, colon) : data;
  const arg = colon >= 0 ? data.slice(colon + 1) : "";
  const from = senderLabel(q.from);
  return { id: typeof q.id === "string" ? q.id : "", data, kind, arg, from };
}

/** Flat document fields surfaced onto `webhook.body.document` for workflows. */
export interface DocumentView {
  /** message.document.file_id — pass to getFile to download it. */
  fileId: string;
  /** Original file name, e.g. "ubuntu.iso.torrent". */
  fileName: string;
  /** MIME type Telegram reported, e.g. "application/x-bittorrent". */
  mimeType: string;
  /** message.chat.id — where to reply (numeric id as string). */
  chatId: string;
  /** Who sent it: @username, else first name, else numeric id. */
  from: string;
}

/** Empty document view for updates that carry no document. */
const EMPTY_DOCUMENT: DocumentView = {
  fileId: "",
  fileName: "",
  mimeType: "",
  chatId: "",
  from: "",
};

/**
 * Lift a Telegram message document into a flat `document` view so a workflow can
 * route on `webhook.body.document.fileId` / `.fileName` and download it via the
 * telegram model's getFile. Reads `message.document` (a file/torrent upload).
 * Non-document updates get an all-empty view so a bound workflow starts and
 * no-ops rather than aborting on a missing field.
 */
export function documentView(body: unknown): DocumentView {
  const b = (body && typeof body === "object")
    ? body as Record<string, unknown>
    : {};
  const msg = (b.message && typeof b.message === "object")
    ? b.message as Record<string, unknown>
    : {};
  const doc = (msg.document && typeof msg.document === "object")
    ? msg.document as Record<string, unknown>
    : null;
  if (!doc) return EMPTY_DOCUMENT;
  const chatObj = (msg.chat && typeof msg.chat === "object")
    ? msg.chat as Record<string, unknown>
    : {};
  const from = senderLabel(msg.from);
  return {
    fileId: typeof doc.file_id === "string" ? doc.file_id : "",
    fileName: typeof doc.file_name === "string" ? doc.file_name : "",
    mimeType: typeof doc.mime_type === "string" ? doc.mime_type : "",
    chatId: chatObj.id !== undefined ? String(chatObj.id) : "",
    from,
  };
}

/** Flat magnet fields surfaced onto `webhook.body.magnet` for workflows. */
export interface MagnetView {
  /** The magnet: URI if the message text is one, else "". */
  url: string;
  /** message.chat.id — where to reply (numeric id as string). */
  chatId: string;
  /** Who sent it: @username, else first name, else numeric id. */
  from: string;
}

/** Empty magnet view for updates whose text is not a magnet link. */
const EMPTY_MAGNET: MagnetView = { url: "", chatId: "", from: "" };

/**
 * Lift a Telegram text message that is a magnet: link into a flat `magnet` view
 * so a workflow can add it to a torrent client directly. Reads `message.text`
 * and only surfaces it when it starts with "magnet:". Non-magnet updates get an
 * all-empty view so a bound workflow starts and no-ops.
 */
export function magnetView(body: unknown): MagnetView {
  const b = (body && typeof body === "object")
    ? body as Record<string, unknown>
    : {};
  const msg = (b.message && typeof b.message === "object")
    ? b.message as Record<string, unknown>
    : {};
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!text.toLowerCase().startsWith("magnet:")) return EMPTY_MAGNET;
  const chatObj = (msg.chat && typeof msg.chat === "object")
    ? msg.chat as Record<string, unknown>
    : {};
  const from = senderLabel(msg.from);
  return {
    url: text,
    chatId: chatObj.id !== undefined ? String(chatObj.id) : "",
    from,
  };
}

/**
 * The webhook extension export. `type` doubles as the `scheme` name used in
 * `serve.yaml` / `--webhook` (`@magistr/telegram-webhook`).
 *
 * @internal
 */
export const webhook = {
  type: "@magistr/telegram-webhook",
  name: "Telegram secret token",
  description: "Verifies Telegram Bot API webhook deliveries via the static " +
    "X-Telegram-Bot-Api-Secret-Token header (constant-time), so Telegram can " +
    "call a swamp serve webhook directly with no HMAC bridge.",
  configSchema: TelegramWebhookConfig,
  createHandler: (config: Record<string, unknown>) => {
    const header =
      (typeof config.header === "string" && config.header.length > 0)
        ? config.header.toLowerCase()
        : TELEGRAM_SECRET_HEADER;
    return {
      signatureHeader: header,
      requiredHeaders: [header],
      verify: (_body: Uint8Array, headers: Headers, secret: string) =>
        tokenMatches(headers.get(header) ?? "", secret),
      // Surface flat `callback` and `document` views alongside the raw update,
      // so a workflow routes on webhook.body.callback.kind/.arg (inline-button
      // taps) or webhook.body.document.fileId (uploaded files, e.g. .torrent)
      // without CEL string-slicing.
      transform: (body: unknown, _headers: Record<string, string>) => {
        const base = (body && typeof body === "object")
          ? body as Record<string, unknown>
          : {};
        return {
          ...base,
          callback: callbackView(body),
          document: documentView(body),
          magnet: magnetView(body),
        };
      },
    };
  },
};
