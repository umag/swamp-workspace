/**
 * Yandex Mail — IMAP mailbox access and SMTP sending.
 *
 * Yandex has no JMAP or public REST mail API, so this model speaks IMAP
 * (imap.yandex.com:993, TLS) for reading/organising mail and SMTP
 * (smtp.yandex.com:465, TLS) for sending. Authentication is an app password
 * of type "Mail" (Yandex ID → Security → App passwords) or an OAuth token
 * (XOAUTH2). IMAP access and "App passwords and OAuth tokens" must be enabled
 * in Yandex Mail → Settings → Email clients.
 *
 * Emails are addressed by an opaque id `<mailbox>:<uid>` (e.g. `INBOX:1234`).
 * UIDs are stable while the mailbox's UIDVALIDITY is unchanged, which on
 * Yandex is effectively forever for an existing folder.
 *
 * @see https://yandex.com/support/mail/mail-clients/others.html
 * @module
 */
import { z } from "npm:zod@4";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { ImapFlow } from "npm:imapflow@2.0.5";
import nodemailer from "npm:nodemailer@10.0.10";
import MailComposer from "npm:nodemailer@10.0.10/lib/mail-composer/index.js";
import PostalMime from "npm:postal-mime@3.0.0";
import {
  type Addr,
  appleMailboxUrl,
  appleMailFlags,
  archivedUids,
  buildSearchQuery,
  decodeEmailId,
  emlxRowId,
  encodeEmailId,
  findSpecialUse,
  formatAddr,
  groupByMailbox,
  mailboxDirName,
  type MailboxEntry,
  maildirName,
  newestUids,
  parseEmlx,
  prefixSubject,
  quoteText,
  replyRecipients,
  replyReferences,
} from "./yandex_mail_lib.ts";

const GlobalArgsSchema = z.object({
  username: z.string().describe(
    "Yandex login or full address (e.g. user@yandex.ru). A bare login is " +
      "completed with @yandex.ru for the From address.",
  ),
  appPassword: z.string().meta({ sensitive: true }).optional().describe(
    "App password of type Mail (Yandex ID → Security → App passwords)",
  ),
  oauthToken: z.string().meta({ sensitive: true }).optional().describe(
    "OAuth token with mail scope, used via XOAUTH2 instead of appPassword",
  ),
  fromName: z.string().optional().describe("Display name for sent mail"),
  imapHost: z.string().default("imap.yandex.com").describe(
    "IMAP host (imap.ya.ru is the alternative outside Russia)",
  ),
  smtpHost: z.string().default("smtp.yandex.com").describe("SMTP host"),
  smtpPort: z.number().int().default(465).describe(
    "SMTP port: 465 (implicit TLS) or 587 (STARTTLS)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;
type Ctx = {
  globalArgs: Record<string, unknown>;
  writeResource: WriteResource;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
};
type Ret = Promise<{ dataHandles: { name: string }[] }>;

// ── Connection plumbing ─────────────────────────────────────────────────────

function globals(ctx: Ctx): GlobalArgs {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  if (!g.appPassword && !g.oauthToken) {
    throw new Error(
      "Set appPassword (app password of type Mail) or oauthToken in " +
        "globalArguments",
    );
  }
  return g;
}

/** The From address: the username if it is an address, else login@yandex.ru. */
function selfAddress(g: GlobalArgs): string {
  return g.username.includes("@") ? g.username : `${g.username}@yandex.ru`;
}

function fromHeader(g: GlobalArgs): string {
  return formatAddr({ name: g.fromName, address: selfAddress(g) });
}

function imapAuth(
  g: GlobalArgs,
): { user: string; pass?: string; accessToken?: string } {
  return g.oauthToken
    ? { user: g.username, accessToken: g.oauthToken }
    : { user: g.username, pass: g.appPassword as string };
}

/** Options handed to the IMAP client factory. */
export type ImapOptions = ConstructorParameters<typeof ImapFlow>[0];

/** The one SMTP call the model makes: send a pre-built raw message. */
export interface SmtpTransport {
  sendMail(
    message: { envelope: { from: string; to: string[] }; raw: Buffer },
  ): Promise<unknown>;
}

/**
 * Network seam: the factories that build the IMAP client and the SMTP
 * transport. Production code never reassigns them; the test suites swap in
 * in-memory fakes so no test opens a socket.
 */
export const transport = {
  /** Build an IMAP client (imapflow). */
  imap: (options: ImapOptions): ImapFlow => new ImapFlow(options),
  /** Build an SMTP transport (nodemailer). */
  smtp: (options: Record<string, unknown>): SmtpTransport =>
    nodemailer.createTransport(options) as unknown as SmtpTransport,
};

/** Open an IMAP session, run `fn`, and always log out. */
async function withImap<T>(
  g: GlobalArgs,
  fn: (c: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = transport.imap({
    host: g.imapHost,
    port: 993,
    secure: true,
    auth: imapAuth(g),
    logger: false,
  });
  try {
    await client.connect();
  } catch (e) {
    const err = e as Error & { responseText?: string };
    throw redact(
      g,
      new Error(
        `IMAP login to ${g.imapHost} failed: ${
          err.responseText ?? err.message
        }` +
          " — check the app password and that IMAP + app passwords are " +
          "enabled in Yandex Mail settings",
      ),
    );
  }
  try {
    return await fn(client);
  } catch (e) {
    throw redact(g, imapError(e));
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Scrub the app password / OAuth token out of an error message. imapflow
 * already redacts LOGIN in `executedCommand`; this is the belt to that
 * braces, so a server or library that echoes a credential can never put it
 * into a swamp run log.
 */
function redact(g: GlobalArgs, e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  let msg = e.message;
  for (const s of [g.appPassword, g.oauthToken]) {
    if (s && s.length >= 4) msg = msg.split(s).join("***");
  }
  if (msg === e.message) return e;
  const out = new Error(msg);
  out.name = e.name;
  return out;
}

/** Surface the server's reply text, which imapflow keeps off `message`. */
function imapError(e: unknown): Error {
  const err = e as Error & { responseText?: string; executedCommand?: string };
  if (!err.responseText) return err;
  return new Error(
    `${err.message}: ${err.responseText}` +
      (err.executedCommand ? ` (${err.executedCommand.slice(0, 120)})` : ""),
  );
}

/** Run `fn` with `mailbox` selected and locked. */
async function inMailbox<T>(
  c: ImapFlow,
  mailbox: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await c.getMailboxLock(mailbox).catch((e) => {
    throw new Error(
      `Cannot open mailbox "${mailbox}": ${imapError(e).message}`,
    );
  });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

async function listBoxes(c: ImapFlow): Promise<MailboxEntry[]> {
  return (await c.list()) as unknown as MailboxEntry[];
}

async function specialBox(
  c: ImapFlow,
  use: "\\Sent" | "\\Trash" | "\\Drafts" | "\\Archive" | "\\Junk",
  override?: string,
): Promise<string> {
  if (override) return override;
  const path = findSpecialUse(await listBoxes(c), use);
  if (!path) {
    throw new Error(
      `No ${use} mailbox found — pass the mailbox path explicitly`,
    );
  }
  return path;
}

function smtpTransport(g: GlobalArgs): SmtpTransport {
  return transport.smtp({
    host: g.smtpHost,
    port: g.smtpPort,
    secure: g.smtpPort === 465,
    auth: g.oauthToken
      ? { type: "OAuth2", user: g.username, accessToken: g.oauthToken }
      : { user: g.username, pass: g.appPassword },
  });
}

// ── Message shaping ─────────────────────────────────────────────────────────

interface BodyNode {
  disposition?: string;
  childNodes?: BodyNode[];
}

function hasAttachment(node: BodyNode | undefined): boolean {
  if (!node) return false;
  if ((node.disposition ?? "").toLowerCase() === "attachment") return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

interface FetchedSummary {
  uid: number;
  flags?: Set<string>;
  size?: number;
  internalDate?: Date | string;
  bodyStructure?: BodyNode;
  envelope?: {
    date?: Date;
    subject?: string;
    messageId?: string;
    inReplyTo?: string;
    from?: Addr[];
    to?: Addr[];
    cc?: Addr[];
    replyTo?: Addr[];
  };
}

/**
 * ISO string for a Date/date string, or "" when missing or unparseable — a
 * spam message with a garbage Date header must not abort a whole query.
 */
function isoDate(d: Date | string | undefined): string {
  if (d === undefined || d === null || d === "") return "";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString();
}

function summarize(mailbox: string, m: FetchedSummary) {
  const flags = [...(m.flags ?? [])];
  const env = m.envelope ?? {};
  return {
    id: encodeEmailId(mailbox, m.uid),
    mailbox,
    uid: m.uid,
    messageId: env.messageId ?? "",
    inReplyTo: env.inReplyTo ?? "",
    subject: env.subject ?? "",
    from: (env.from ?? []).map(formatAddr),
    to: (env.to ?? []).map(formatAddr),
    cc: (env.cc ?? []).map(formatAddr),
    date: isoDate(env.date) || isoDate(m.internalDate),
    flags,
    seen: flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    size: m.size ?? 0,
    hasAttachment: hasAttachment(m.bodyStructure),
  };
}

const SUMMARY_QUERY = {
  uid: true,
  envelope: true,
  flags: true,
  size: true,
  internalDate: true,
  bodyStructure: true,
};

async function fetchSummaries(c: ImapFlow, mailbox: string, uids: number[]) {
  if (uids.length === 0) return [];
  const out: ReturnType<typeof summarize>[] = [];
  for await (
    const m of c.fetch(uids, SUMMARY_QUERY, { uid: true })
  ) {
    out.push(summarize(mailbox, m as unknown as FetchedSummary));
  }
  return out.sort((a, b) => b.uid - a.uid);
}

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

/** Fetch and MIME-parse one message. */
async function fetchParsed(
  c: ImapFlow,
  emailId: string,
): Promise<{ parsed: Parsed; raw: Buffer; flags: string[] }> {
  const { mailbox, uid } = decodeEmailId(emailId);
  return await inMailbox(c, mailbox, async () => {
    const msg = await c.fetchOne(String(uid), { source: true, flags: true }, {
      uid: true,
    });
    if (!msg || !msg.source) {
      throw new Error(`Email ${emailId} not found`);
    }
    const raw = Buffer.from(msg.source);
    return {
      parsed: await PostalMime.parse(raw),
      raw,
      flags: [...(msg.flags ?? [])],
    };
  });
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

function emailDetail(
  emailId: string,
  p: Parsed,
  flags: string[],
  maxBodyChars: number,
) {
  const { mailbox, uid } = decodeEmailId(emailId);
  return {
    id: emailId,
    mailbox,
    uid,
    messageId: p.messageId ?? "",
    inReplyTo: p.inReplyTo ?? "",
    references: p.references ?? "",
    subject: p.subject ?? "",
    from: p.from ? formatAddr(p.from as Addr) : "",
    replyTo: ((p.replyTo ?? []) as Addr[]).map(formatAddr),
    to: ((p.to ?? []) as Addr[]).map(formatAddr),
    cc: ((p.cc ?? []) as Addr[]).map(formatAddr),
    date: p.date ?? "",
    flags,
    text: truncate(p.text, maxBodyChars),
    html: truncate(p.html, maxBodyChars),
    attachments: (p.attachments ?? []).map((a, index) => ({
      index,
      filename: a.filename ?? "",
      mimeType: a.mimeType,
      disposition: a.disposition ?? "",
      contentId: a.contentId ?? "",
      size: attachmentBytes(a.content).byteLength,
    })),
  };
}

function attachmentBytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array();
}

/**
 * Resource-name slug. ASCII ids keep their readable slug (`INBOX:5` →
 * `INBOX-5`); an id with non-ASCII characters (Cyrillic folder names) also
 * gets a short hash suffix, so `Работа:5` and `Личное:5` do not both
 * collapse to `5` and overwrite each other's data.
 */
export function slug(s: string): string {
  const base = s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "x";
  // deno-lint-ignore no-control-regex -- detect any non-ASCII code point
  if (/^[\x00-\x7f]*$/.test(s)) return base;
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${base}-${h.toString(16).padStart(8, "0")}`;
}

/** Characters that end an IMAP command line or SMTP header. */
const LINE_BREAK = /[\r\n\0]/;

/** A mailbox path argument: non-empty, no CR/LF/NUL. */
const mailboxPath = z.string().min(1).refine((s) => !LINE_BREAK.test(s), {
  message: "mailbox path must not contain CR, LF or NUL",
});

/**
 * Normalise a caller-supplied Message-ID to `<...>` form, rejecting
 * whitespace and control characters: nodemailer folds a CRLF into the header
 * instead of refusing it, so `<a@b>\r\nBcc: x` would otherwise go out as a
 * malformed Message-ID and break the idempotency lookup in Sent.
 */
export function normalizeMessageId(id: string): string {
  // deno-lint-ignore no-control-regex -- reject control characters
  if (!/^<?[^\s<>\x00-\x1f\x7f]+>?$/.test(id)) {
    throw new Error(
      `Invalid messageId "${JSON.stringify(id).slice(1, -1)}" — expected ` +
        `"<unique@domain>" with no spaces or control characters`,
    );
  }
  const inner = id.replace(/^</, "").replace(/>$/, "");
  return `<${inner}>`;
}

/**
 * A safe file name for an attachment: path separators and control
 * characters replaced, and empty / `.` / `..` names (which would resolve to
 * the output directory or its parent) replaced by `attachment-<index>`.
 */
export function safeFilename(name: string | undefined, index: number): string {
  // deno-lint-ignore no-control-regex -- strip control characters
  const n = (name ?? "").replace(/[/\\\x00-\x1f\x7f]/g, "_").trim();
  return n === "" || /^\.+$/.test(n) ? `attachment-${index}` : n;
}

const now = () => new Date().toISOString();

// ── Composition & sending ───────────────────────────────────────────────────

interface Compose {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<
    { filename?: string; path?: string; content?: Buffer; contentType?: string }
  >;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
}

/** Build a raw RFC 5322 message plus its SMTP envelope. */
async function compose(
  g: GlobalArgs,
  m: Compose,
  keepBcc = false,
): Promise<{ raw: Buffer; envelope: { from: string; to: string[] } }> {
  const mail = new MailComposer({
    from: fromHeader(g),
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    text: m.text,
    html: m.html,
    attachments: m.attachments,
    inReplyTo: m.inReplyTo,
    references: m.references,
    messageId: m.messageId,
  }).compile();
  mail.keepBcc = keepBcc;
  const raw = await mail.build();
  const env = mail.getEnvelope();
  return { raw, envelope: { from: env.from || selfAddress(g), to: env.to } };
}

/** Is a message with this Message-ID already in `mailbox`? */
async function hasMessageId(
  c: ImapFlow,
  mailbox: string,
  messageId: string,
): Promise<boolean> {
  return await inMailbox(c, mailbox, async () => {
    const hits = await c.search({ header: { "message-id": messageId } }, {
      uid: true,
    });
    return Array.isArray(hits) && hits.length > 0;
  });
}

/**
 * Send a composed message. With `messageId`, Sent is checked first and the
 * send is skipped if that Message-ID is already there, so workflow retries
 * never double-send. With `saveToSent`, the message is appended to Sent.
 */
async function deliver(
  g: GlobalArgs,
  m: Compose,
  opts: { saveToSent: boolean },
) {
  const msgId = m.messageId ? normalizeMessageId(m.messageId) : undefined;
  if (msgId) {
    const already = await withImap(g, async (c) => {
      const sent = await specialBox(c, "\\Sent");
      return await hasMessageId(c, sent, msgId);
    });
    if (already) {
      return {
        skipped: true,
        reason: "messageId already present in Sent",
        messageId: msgId,
        accepted: [] as string[],
        rejected: [] as string[],
        response: "",
        savedTo: "",
      };
    }
  }
  const { raw, envelope } = await compose(g, { ...m, messageId: msgId });
  const info = await smtpTransport(g).sendMail({ envelope, raw }).catch(
    (e) => {
      throw redact(g, e);
    },
  ) as {
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
    response?: string;
  };
  let savedTo = "";
  if (opts.saveToSent) {
    savedTo = await withImap(g, async (c) => {
      const sent = await specialBox(c, "\\Sent");
      await c.append(sent, raw, ["\\Seen"]);
      return sent;
    });
  }
  return {
    skipped: false,
    reason: "",
    messageId: info.messageId ?? msgId ?? "",
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
    response: info.response ?? "",
    savedTo,
  };
}

async function readAttachments(paths: string[] | undefined) {
  if (!paths?.length) return undefined;
  return await Promise.all(paths.map(async (p) => ({
    filename: p.split("/").pop(),
    content: Buffer.from(await Deno.readFile(p)),
  })));
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const tsField = z.string().describe("ISO 8601 timestamp");
const emailIdField = z.string().describe(
  'Email id "<mailbox>:<uid>", e.g. "INBOX:1234"',
);
const addrList = z.array(z.string()).describe(
  'Addresses, e.g. ["Name <a@b.c>", "d@e.f"]',
);

const SendArgs = z.object({
  to: addrList,
  cc: addrList.optional(),
  bcc: addrList.optional(),
  subject: z.string(),
  text: z.string().optional().describe("Plain-text body"),
  html: z.string().optional().describe("HTML body"),
  attachments: z.array(z.string()).optional().describe(
    "Local file paths to attach",
  ),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  messageId: z.string().optional().describe(
    "Stable Message-ID. If set and already in Sent, the send is skipped " +
      "(idempotent retries)",
  ),
  saveToSent: z.boolean().default(false).describe(
    "Append a copy to Sent. Leave false if Yandex already files SMTP mail " +
      "in Sent for your account, or it will appear twice",
  ),
});

const sendResultSchema = z.object({
  skipped: z.boolean(),
  reason: z.string(),
  messageId: z.string(),
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
  response: z.string(),
  savedTo: z.string(),
  subject: z.string(),
  to: z.array(z.string()),
  timestamp: tsField,
});

// ── Model ───────────────────────────────────────────────────────────────────

/** Yandex Mail model: IMAP read/organise + SMTP send. */
export const model = {
  type: "@magistr/yandex-mail",
  version: "2026.10.11.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.11.1",
      description: "Initial release",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    mailboxes: {
      description: "Mailbox (folder) listing with message counts",
      schema: z.object({
        mailboxes: z.array(z.unknown()),
        count: z.number(),
        timestamp: tsField,
      }),
      lifetime: "30m",
      garbageCollection: 10,
    },
    mailboxResult: {
      description: "Mailbox create/rename/delete result",
      schema: z.object({
        operation: z.string(),
        path: z.string(),
        changed: z.boolean(),
        detail: z.unknown(),
        timestamp: tsField,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Account overview: totals and unread per mailbox",
      schema: z.object({
        account: z.string(),
        totalMessages: z.number(),
        totalUnread: z.number(),
        mailboxes: z.array(z.unknown()),
        timestamp: tsField,
      }),
      lifetime: "30m",
      garbageCollection: 10,
    },
    emails: {
      description: "Email query results / bulk action results",
      schema: z.object({
        mailbox: z.string(),
        filter: z.unknown(),
        emails: z.array(z.unknown()),
        total: z.number(),
        count: z.number(),
        timestamp: tsField,
      }),
      lifetime: "15m",
      garbageCollection: 20,
    },
    email: {
      description: "Single email with decoded body and attachment list",
      schema: z.object({
        emailId: z.string(),
        email: z.unknown(),
        timestamp: tsField,
      }),
      lifetime: "1h",
      garbageCollection: 20,
    },
    thread: {
      description: "Conversation reconstructed from Message-ID/References",
      schema: z.object({
        emailId: z.string(),
        emails: z.array(z.unknown()),
        count: z.number(),
        timestamp: tsField,
      }),
      lifetime: "1h",
      garbageCollection: 20,
    },
    attachment: {
      description: "Attachment saved to local disk",
      schema: z.object({
        emailId: z.string(),
        index: z.number(),
        filename: z.string(),
        mimeType: z.string(),
        size: z.number(),
        path: z.string(),
        timestamp: tsField,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    sendResult: {
      description: "Email send result",
      schema: sendResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    archive: {
      description: "Maildir archive run: per-folder counts and UID watermarks",
      schema: z.object({
        outputDir: z.string(),
        folders: z.array(z.object({
          mailbox: z.string(),
          dir: z.string(),
          uidValidity: z.string(),
          total: z.number(),
          alreadyArchived: z.number(),
          archived: z.number(),
          bytes: z.number(),
          unavailable: z.number(),
          remaining: z.number(),
          complete: z.boolean(),
        })),
        archived: z.number(),
        bytes: z.number(),
        unavailable: z.number(),
        remaining: z.number(),
        complete: z.boolean(),
        timestamp: tsField,
      }),
      lifetime: "infinite",
      garbageCollection: 50,
    },
    appleImport: {
      description:
        "Apple Mail cache import: per-folder imported/partial/missing",
      schema: z.object({
        outputDir: z.string(),
        accountDir: z.string(),
        folders: z.array(z.unknown()),
        imported: z.number(),
        partial: z.number(),
        missing: z.number(),
        timestamp: tsField,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    draft: {
      description: "Draft saved to the Drafts mailbox",
      schema: z.object({
        emailId: z.string(),
        mailbox: z.string(),
        subject: z.string(),
        to: z.array(z.string()),
        timestamp: tsField,
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    // ═══════════════════════════════════════════════════════════════════════
    // Mailboxes
    // ═══════════════════════════════════════════════════════════════════════

    "get-account-summary": {
      description: "Account overview with total/unread counts per mailbox",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, ctx: Ctx): Ret => {
        const g = globals(ctx);
        const mailboxes = await withImap(g, (c) => mailboxStats(c));
        const h = await ctx.writeResource("summary", "account", {
          account: selfAddress(g),
          totalMessages: mailboxes.reduce((s, m) => s + m.messages, 0),
          totalUnread: mailboxes.reduce((s, m) => s + m.unseen, 0),
          mailboxes,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "list-mailboxes": {
      description: "List all mailboxes (folders) with message counts",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, ctx: Ctx): Ret => {
        const g = globals(ctx);
        const mailboxes = await withImap(g, (c) => mailboxStats(c));
        const h = await ctx.writeResource("mailboxes", "all", {
          mailboxes,
          count: mailboxes.length,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "create-mailbox": {
      description: "Create a mailbox (folder). No-op if it already exists.",
      arguments: z.object({
        path: mailboxPath.describe('Folder path, e.g. "Receipts" or "A|B"'),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const { path } = z.object({ path: mailboxPath }).parse(rawArgs);
        const g = globals(ctx);
        const res = await withImap(g, async (c) => {
          const exists = (await listBoxes(c)).some((b) => b.path === path);
          if (exists) return { changed: false, detail: "already exists" };
          return { changed: true, detail: await c.mailboxCreate(path) };
        });
        const h = await ctx.writeResource("mailboxResult", slug(path), {
          operation: "create",
          path,
          ...res,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "rename-mailbox": {
      description: "Rename (move) a mailbox",
      arguments: z.object({ path: mailboxPath, newPath: mailboxPath }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const { path, newPath } = z.object({
          path: mailboxPath,
          newPath: mailboxPath,
        }).parse(rawArgs);
        const g = globals(ctx);
        const res = await withImap(g, async (c) => {
          const boxes = await listBoxes(c);
          if (
            !boxes.some((b) => b.path === path) &&
            boxes.some((b) => b.path === newPath)
          ) {
            return { changed: false, detail: "already renamed" };
          }
          return {
            changed: true,
            detail: await c.mailboxRename(path, newPath),
          };
        });
        const h = await ctx.writeResource("mailboxResult", slug(newPath), {
          operation: "rename",
          path: newPath,
          ...res,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "delete-mailbox": {
      description:
        "Delete a mailbox and ALL messages in it. No-op if it does not exist.",
      arguments: z.object({ path: mailboxPath }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const { path } = z.object({ path: mailboxPath }).parse(rawArgs);
        const g = globals(ctx);
        const res = await withImap(g, async (c) => {
          const box = (await listBoxes(c)).find((b) => b.path === path);
          if (!box) return { changed: false, detail: "does not exist" };
          if (box.specialUse || path.toUpperCase() === "INBOX") {
            throw new Error(`Refusing to delete system mailbox "${path}"`);
          }
          return { changed: true, detail: await c.mailboxDelete(path) };
        });
        const h = await ctx.writeResource("mailboxResult", slug(path), {
          operation: "delete",
          path,
          ...res,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // Reading
    // ═══════════════════════════════════════════════════════════════════════

    "query-emails": {
      description:
        "Search a mailbox (default INBOX) and return newest-first summaries",
      arguments: z.object({
        mailbox: mailboxPath.default("INBOX").describe("Mailbox path"),
        after: z.string().optional().describe("On/after date (ISO 8601)"),
        before: z.string().optional().describe("Before date (ISO 8601)"),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional().describe("Search headers and body"),
        unseen: z.boolean().optional().describe("true = only unread"),
        flagged: z.boolean().optional(),
        limit: z.number().int().positive().default(50),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["query-emails"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const filter = buildSearchQuery(a);
        const { total, emails } = await withImap(
          g,
          (c) =>
            inMailbox(c, a.mailbox, async () => {
              const hits = await c.search(filter, { uid: true });
              const all = Array.isArray(hits) ? hits : [];
              return {
                total: all.length,
                emails: await fetchSummaries(
                  c,
                  a.mailbox,
                  newestUids(all, a.limit),
                ),
              };
            }),
        );
        const h = await ctx.writeResource("emails", "query", {
          mailbox: a.mailbox,
          filter: { ...a },
          emails,
          total,
          count: emails.length,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "get-email": {
      description: "Get one email with decoded text/HTML and attachment list",
      arguments: z.object({
        emailId: emailIdField,
        maxBodyChars: z.number().int().positive().default(100_000),
        markRead: z.boolean().default(false).describe(
          "Set \\Seen after reading (fetching never sets it by itself)",
        ),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["get-email"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const email = await withImap(g, async (c) => {
          const { parsed, flags } = await fetchParsed(c, a.emailId);
          if (a.markRead && !flags.includes("\\Seen")) {
            const { mailbox, uid } = decodeEmailId(a.emailId);
            await inMailbox(
              c,
              mailbox,
              () => c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }),
            );
            flags.push("\\Seen");
          }
          return emailDetail(a.emailId, parsed, flags, a.maxBodyChars);
        });
        const h = await ctx.writeResource("email", slug(a.emailId), {
          emailId: a.emailId,
          email,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "get-thread": {
      description:
        "Reconstruct a conversation from Message-ID/References across the " +
        "email's mailbox and Sent",
      arguments: z.object({
        emailId: emailIdField,
        mailboxes: z.array(mailboxPath).optional().describe(
          "Mailboxes to search (default: the email's mailbox + Sent)",
        ),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["get-thread"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const emails = await withImap(g, async (c) => {
          const { parsed } = await fetchParsed(c, a.emailId);
          const ids = replyReferences(parsed.messageId, parsed.references)
            .concat(parsed.inReplyTo ? [parsed.inReplyTo] : []);
          const unique = [...new Set(ids)].slice(-50);
          const boxes = a.mailboxes ?? [
            decodeEmailId(a.emailId).mailbox,
            await specialBox(c, "\\Sent"),
          ];
          const found: ReturnType<typeof summarize>[] = [];
          for (const box of [...new Set(boxes)]) {
            const uids = await inMailbox(c, box, async () => {
              const set = new Set<number>();
              for (const id of unique) {
                for (const header of ["message-id", "references"]) {
                  const hits = await c.search({ header: { [header]: id } }, {
                    uid: true,
                  });
                  if (Array.isArray(hits)) hits.forEach((u) => set.add(u));
                }
              }
              return [...set];
            });
            found.push(
              ...await inMailbox(c, box, () => fetchSummaries(c, box, uids)),
            );
          }
          return found.sort((x, y) => x.date.localeCompare(y.date));
        });
        const h = await ctx.writeResource("thread", slug(a.emailId), {
          emailId: a.emailId,
          emails,
          count: emails.length,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "get-attachment": {
      description: "Save one attachment of an email to a local directory",
      arguments: z.object({
        emailId: emailIdField,
        index: z.number().int().min(0).optional().describe(
          "Attachment index from get-email",
        ),
        filename: z.string().optional().describe("Or match by filename"),
        outputDir: z.string().describe("Directory to write the file into"),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["get-attachment"].arguments.parse(rawArgs);
        if (a.index === undefined && !a.filename) {
          throw new Error("Pass index or filename");
        }
        const g = globals(ctx);
        const { parsed } = await withImap(g, (c) => fetchParsed(c, a.emailId));
        const list = parsed.attachments ?? [];
        const index = a.index ??
          list.findIndex((x) => x.filename === a.filename);
        const att = list[index];
        if (!att) {
          throw new Error(
            `Attachment ${
              a.index ?? a.filename
            } not found (have ${list.length})`,
          );
        }
        const name = safeFilename(att.filename ?? undefined, index);
        const bytes = attachmentBytes(att.content);
        await Deno.mkdir(a.outputDir, { recursive: true });
        const path = `${a.outputDir.replace(/\/+$/, "")}/${name}`;
        await Deno.writeFile(path, bytes);
        const h = await ctx.writeResource(
          "attachment",
          slug(`${a.emailId}-${index}`),
          {
            emailId: a.emailId,
            index,
            filename: name,
            mimeType: att.mimeType,
            size: bytes.byteLength,
            path,
            timestamp: now(),
          },
        );
        return { dataHandles: [h] };
      },
    },

    "archive-mailbox": {
      description:
        "Incrementally back up folders to a local Maildir (raw .eml per " +
        "message). Re-runs only fetch UIDs not already on disk; messages the " +
        "server cannot deliver are listed in <folder>/unavailable.json.",
      arguments: z.object({
        outputDir: z.string().describe("Maildir root, e.g. ./yandex-backup"),
        mailboxes: z.array(z.string()).optional().describe(
          "Folders to archive (default: every selectable folder)",
        ),
        exclude: z.array(z.string()).default([]).describe(
          'Folders to skip, e.g. ["Spam", "Trash"]',
        ),
        maxMessages: z.number().int().min(0).default(0).describe(
          "Stop after this many fetch attempts in this run (0 = no limit); " +
            "the next run continues where this one stopped",
        ),
        batchSize: z.number().int().positive().default(100),
        retryUnavailable: z.boolean().default(false).describe(
          "Fetch UIDs from unavailable.json again instead of skipping them",
        ),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["archive-mailbox"].arguments.parse(rawArgs);
        const g = globals(ctx);
        await Deno.mkdir(a.outputDir, { recursive: true });
        const root = await Deno.realPath(a.outputDir);
        const boxes = await withImap(g, async (c) => {
          const all = await c.list();
          if (a.mailboxes) {
            const missing = a.mailboxes.filter((m) =>
              !all.some((b) => b.path === m)
            );
            if (missing.length) {
              throw new Error(`Unknown mailbox(es): ${missing.join(", ")}`);
            }
          }
          return all.filter((b) =>
            !b.flags?.has("\\Noselect") &&
            (!a.mailboxes || a.mailboxes.includes(b.path)) &&
            !a.exclude.includes(b.path)
          ).map((b) => ({ path: b.path, delimiter: b.delimiter }));
        });
        let budget = a.maxMessages || Infinity;
        const folders: Omit<
          Awaited<ReturnType<typeof archiveFolder>>,
          "attempted"
        >[] = [];
        // One connection per folder: Yandex drops long-lived sessions, and a
        // fresh login keeps one slow folder from failing the rest.
        for (const box of boxes) {
          const { attempted, ...res } = await withReconnect(
            () =>
              withImap(g, (c) =>
                archiveFolder(
                  c,
                  box.path,
                  mailboxDirName(box.path, box.delimiter),
                  root,
                  budget,
                  a.batchSize,
                  a.retryUnavailable,
                )),
            (attempt, e) =>
              ctx.logger?.info(
                "{mailbox}: session dropped ({error}), " +
                  "reconnect {attempt}",
                {
                  mailbox: box.path,
                  error: e.message,
                  attempt,
                },
              ),
          );
          // The budget counts fetch attempts made in THIS run, not UIDs that
          // were already listed as unavailable by an earlier run.
          budget -= attempted;
          ctx.logger?.info(
            "archived {mailbox}: {archived} new, {unavailable} unavailable",
            {
              mailbox: box.path,
              archived: res.archived,
              unavailable: res.unavailable,
            },
          );
          folders.push(res);
        }
        const h = await ctx.writeResource("archive", "archive", {
          outputDir: root,
          folders,
          archived: folders.reduce((s, f) => s + f.archived, 0),
          bytes: folders.reduce((s, f) => s + f.bytes, 0),
          unavailable: folders.reduce((s, f) => s + f.unavailable, 0),
          remaining: folders.reduce((s, f) => s + f.remaining, 0),
          complete: folders.every((f) => f.complete),
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "import-apple-mail": {
      description:
        "Fill the Maildir gaps listed in unavailable.json from Apple Mail's " +
        "local cache (.emlx files), matched by IMAP UID via Mail's Envelope " +
        "Index. macOS only; the process needs Full Disk Access.",
      arguments: z.object({
        outputDir: z.string().describe("Maildir root used by archive-mailbox"),
        accountDir: z.string().describe(
          "Apple Mail account directory, e.g. " +
            "~/Library/Mail/V10/<account-uuid>",
        ),
        envelopeIndex: z.string().optional().describe(
          "Path to Mail's Envelope Index (default: <accountDir>/../MailData/" +
            "Envelope Index)",
        ),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["import-apple-mail"].arguments.parse(rawArgs);
        const home = Deno.env.get("HOME") ?? "";
        const tilde = (p: string) => p.replace(/^~(?=\/|$)/, home);
        const root = await Deno.realPath(a.outputDir);
        const accountDir = (await Deno.realPath(tilde(a.accountDir)))
          .replace(/\/+$/, "");
        const accountId = accountDir.split("/").pop() as string;
        const indexPath = tilde(
          a.envelopeIndex ??
            `${accountDir.replace(/\/[^/]+$/, "")}/MailData/Envelope Index`,
        );
        const db = await openEnvelopeIndex(indexPath);
        const folders: Array<{
          mailbox: string;
          requested: number;
          imported: number;
          partial: number;
          missing: number;
        }> = [];
        try {
          for await (const entry of Deno.readDir(root)) {
            if (!entry.isDirectory) continue;
            const base = `${root}/${entry.name}`;
            const unavailable = await readUnavailable(base);
            if (!unavailable || unavailable.uids.length === 0) continue;
            const res = await importFolderFromAppleMail(
              db.db,
              accountDir,
              accountId,
              base,
              unavailable,
            );
            ctx.logger?.info(
              "apple mail {mailbox}: {imported} of {requested} imported",
              { ...res },
            );
            folders.push(res);
          }
        } finally {
          db.close();
        }
        const h = await ctx.writeResource("appleImport", "apple-mail", {
          outputDir: root,
          accountDir,
          folders,
          imported: folders.reduce((s, f) => s + f.imported, 0),
          partial: folders.reduce((s, f) => s + f.partial, 0),
          missing: folders.reduce((s, f) => s + f.missing, 0),
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // Sending
    // ═══════════════════════════════════════════════════════════════════════

    "send-email": {
      description: "Compose and send an email over SMTP",
      arguments: SendArgs,
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = SendArgs.parse(rawArgs);
        if (!a.text && !a.html) throw new Error("Pass text or html");
        const g = globals(ctx);
        const res = await deliver(g, {
          ...a,
          attachments: await readAttachments(a.attachments),
        }, { saveToSent: a.saveToSent });
        const h = await ctx.writeResource("sendResult", "send", {
          ...res,
          subject: a.subject,
          to: a.to,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "reply-email": {
      description: "Reply (or reply-all) to an email, quoting the original",
      arguments: z.object({
        emailId: emailIdField,
        text: z.string().describe("Reply body (plain text)"),
        html: z.string().optional(),
        replyAll: z.boolean().default(false),
        quote: z.boolean().default(true).describe("Quote the original text"),
        messageId: z.string().optional().describe(
          "Stable Message-ID for idempotent retries",
        ),
        saveToSent: z.boolean().default(false),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["reply-email"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const { parsed: p } = await withImap(
          g,
          (c) => fetchParsed(c, a.emailId),
        );
        const { to, cc } = replyRecipients(
          {
            from: p.from as Addr,
            replyTo: p.replyTo as Addr[],
            to: p.to as Addr[],
            cc: p.cc as Addr[],
          },
          selfAddress(g),
          a.replyAll,
        );
        if (to.length === 0) throw new Error("Original has no reply address");
        const subject = prefixSubject(p.subject ?? "", "Re");
        const body = a.quote && p.text
          ? `${a.text}\n\n${
            quoteText(
              p.text,
              p.from ? formatAddr(p.from as Addr) : "Unknown sender",
              p.date,
            )
          }`
          : a.text;
        const res = await deliver(g, {
          to,
          cc,
          subject,
          text: body,
          html: a.html,
          inReplyTo: p.messageId,
          references: replyReferences(p.messageId, p.references),
          messageId: a.messageId,
        }, { saveToSent: a.saveToSent });
        const h = await ctx.writeResource("sendResult", "reply", {
          ...res,
          subject,
          to,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "forward-email": {
      description:
        "Forward an email; the original is attached as message/rfc822",
      arguments: z.object({
        emailId: emailIdField,
        to: addrList,
        cc: addrList.optional(),
        text: z.string().default("").describe("Note above the forward"),
        messageId: z.string().optional(),
        saveToSent: z.boolean().default(false),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["forward-email"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const { parsed: p, raw } = await withImap(
          g,
          (c) => fetchParsed(c, a.emailId),
        );
        const subject = prefixSubject(p.subject ?? "", "Fwd");
        const header = [
          "---------- Forwarded message ----------",
          `From: ${p.from ? formatAddr(p.from as Addr) : ""}`,
          `Date: ${p.date ?? ""}`,
          `Subject: ${p.subject ?? ""}`,
          `To: ${((p.to ?? []) as Addr[]).map(formatAddr).join(", ")}`,
        ].join("\n");
        const res = await deliver(g, {
          to: a.to,
          cc: a.cc,
          subject,
          text: `${a.text}\n\n${header}\n\n${p.text ?? ""}`.trimStart(),
          attachments: [{
            filename: `${slug(p.subject ?? "message")}.eml`,
            content: raw,
            contentType: "message/rfc822",
          }],
          messageId: a.messageId,
        }, { saveToSent: a.saveToSent });
        const h = await ctx.writeResource("sendResult", "forward", {
          ...res,
          subject,
          to: a.to,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "create-draft": {
      description: "Save an email to Drafts without sending",
      arguments: SendArgs.omit({ saveToSent: true }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = SendArgs.omit({ saveToSent: true }).parse(rawArgs);
        const g = globals(ctx);
        const { raw } = await compose(g, {
          ...a,
          attachments: await readAttachments(a.attachments),
        }, true);
        const { mailbox, uid } = await withImap(g, async (c) => {
          const drafts = await specialBox(c, "\\Drafts");
          const r = await c.append(drafts, raw, ["\\Draft", "\\Seen"]);
          if (!r || !r.uid) {
            throw new Error("Server did not return a UID for the draft");
          }
          return { mailbox: drafts, uid: r.uid };
        });
        const emailId = encodeEmailId(mailbox, uid);
        const h = await ctx.writeResource("draft", slug(emailId), {
          emailId,
          mailbox,
          subject: a.subject,
          to: a.to,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "send-draft": {
      description: "Send a saved draft, then remove it from Drafts",
      arguments: z.object({
        emailId: emailIdField,
        saveToSent: z.boolean().default(false),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["send-draft"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const { parsed: p } = await withImap(
          g,
          (c) => fetchParsed(c, a.emailId),
        );
        const list = (x: unknown) => ((x ?? []) as Addr[]).map(formatAddr);
        const to = list(p.to);
        if (to.length === 0) throw new Error("Draft has no To recipients");
        const res = await deliver(g, {
          to,
          cc: list(p.cc),
          bcc: list(p.bcc),
          subject: p.subject ?? "",
          text: p.text,
          html: p.html || undefined,
          inReplyTo: p.inReplyTo,
          references: p.references
            ? replyReferences(undefined, p.references)
            : undefined,
          attachments: (p.attachments ?? []).map((x) => ({
            filename: x.filename ?? undefined,
            content: Buffer.from(attachmentBytes(x.content)),
            contentType: x.mimeType,
          })),
          messageId: p.messageId,
        }, { saveToSent: a.saveToSent });
        const { mailbox, uid } = decodeEmailId(a.emailId);
        await withImap(
          g,
          (c) =>
            inMailbox(
              c,
              mailbox,
              () => c.messageDelete(String(uid), { uid: true }),
            ),
        );
        const h = await ctx.writeResource("sendResult", "draft", {
          ...res,
          subject: p.subject ?? "",
          to,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // Organising
    // ═══════════════════════════════════════════════════════════════════════

    "set-email": {
      description: "Set read/flagged state and/or move one email",
      arguments: z.object({
        emailId: emailIdField,
        seen: z.boolean().optional(),
        flagged: z.boolean().optional(),
        moveTo: mailboxPath.optional().describe("Destination mailbox path"),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["set-email"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const { mailbox, uid } = decodeEmailId(a.emailId);
        const newId = await withImap(
          g,
          (c) =>
            inMailbox(c, mailbox, async () => {
              const r = String(uid);
              const add: string[] = [];
              const del: string[] = [];
              if (a.seen !== undefined) (a.seen ? add : del).push("\\Seen");
              if (a.flagged !== undefined) {
                (a.flagged ? add : del).push("\\Flagged");
              }
              if (add.length) await c.messageFlagsAdd(r, add, { uid: true });
              if (del.length) await c.messageFlagsRemove(r, del, { uid: true });
              if (a.moveTo && a.moveTo !== mailbox) {
                const res = await c.messageMove(r, a.moveTo, { uid: true });
                const moved = res && res.uidMap?.get(uid);
                return moved ? encodeEmailId(a.moveTo, moved) : "";
              }
              return a.emailId;
            }),
        );
        const h = await ctx.writeResource("email", slug(a.emailId), {
          emailId: a.emailId,
          email: {
            id: a.emailId,
            newId,
            seen: a.seen,
            flagged: a.flagged,
            moveTo: a.moveTo,
          },
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "archive-email": {
      description: "Mark emails read and move them to Archive",
      arguments: z.object({
        emailIds: z.array(z.string()),
        archiveMailbox: mailboxPath.optional().describe(
          "Override the archive folder path",
        ),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["archive-email"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const emails = await withImap(g, async (c) => {
          const dest = await specialBox(c, "\\Archive", a.archiveMailbox);
          return await bulk(c, a.emailIds, async (r) => {
            await c.messageFlagsAdd(r, ["\\Seen"], { uid: true });
            return await c.messageMove(r, dest, { uid: true });
          }, dest);
        });
        const h = await ctx.writeResource("emails", "archived", {
          mailbox: "*",
          filter: { action: "archive" },
          emails,
          total: emails.length,
          count: emails.length,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "delete-email": {
      description: "Permanently delete (expunge) one or more emails",
      arguments: z.object({ emailIds: z.array(z.string()) }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["delete-email"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const emails = await withImap(
          g,
          (c) =>
            bulk(c, a.emailIds, (r) => c.messageDelete(r, { uid: true }), ""),
        );
        const h = await ctx.writeResource("emails", "deleted", {
          mailbox: "*",
          filter: { action: "delete" },
          emails,
          total: emails.length,
          count: emails.length,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },

    "bulk-email-action": {
      description:
        "Batch action on many emails: mark-read, mark-unread, flag, unflag, " +
        "move, copy, trash, spam",
      arguments: z.object({
        emailIds: z.array(z.string()),
        action: z.enum([
          "mark-read",
          "mark-unread",
          "flag",
          "unflag",
          "move",
          "copy",
          "trash",
          "spam",
        ]),
        mailbox: mailboxPath.optional().describe("Target for move/copy"),
      }),
      execute: async (rawArgs: Record<string, unknown>, ctx: Ctx): Ret => {
        const a = model.methods["bulk-email-action"].arguments.parse(rawArgs);
        const g = globals(ctx);
        const emails = await withImap(g, async (c) => {
          const o = { uid: true };
          switch (a.action) {
            case "mark-read":
              return await bulk(
                c,
                a.emailIds,
                (r) => c.messageFlagsAdd(r, ["\\Seen"], o),
                "",
              );
            case "mark-unread":
              return await bulk(
                c,
                a.emailIds,
                (r) => c.messageFlagsRemove(r, ["\\Seen"], o),
                "",
              );
            case "flag":
              return await bulk(
                c,
                a.emailIds,
                (r) => c.messageFlagsAdd(r, ["\\Flagged"], o),
                "",
              );
            case "unflag":
              return await bulk(
                c,
                a.emailIds,
                (r) => c.messageFlagsRemove(r, ["\\Flagged"], o),
                "",
              );
            case "move":
            case "copy": {
              if (!a.mailbox) {
                throw new Error(`mailbox required for ${a.action}`);
              }
              const dest = a.mailbox;
              return await bulk(
                c,
                a.emailIds,
                (r) =>
                  a.action === "move"
                    ? c.messageMove(r, dest, o)
                    : c.messageCopy(r, dest, o),
                dest,
              );
            }
            case "trash":
            case "spam": {
              const dest = await specialBox(
                c,
                a.action === "trash" ? "\\Trash" : "\\Junk",
              );
              return await bulk(
                c,
                a.emailIds,
                (r) => c.messageMove(r, dest, o),
                dest,
              );
            }
          }
        });
        const h = await ctx.writeResource("emails", "bulk", {
          mailbox: a.mailbox ?? "*",
          filter: { action: a.action },
          emails,
          total: emails.length,
          count: emails.length,
          timestamp: now(),
        });
        return { dataHandles: [h] };
      },
    },
  },
};

// ── Shared method bodies ────────────────────────────────────────────────────

async function mailboxStats(c: ImapFlow) {
  const boxes = await listBoxes(c);
  const out: Array<{
    path: string;
    specialUse: string;
    messages: number;
    unseen: number;
  }> = [];
  for (const b of boxes) {
    const flags = [...(b.flags ?? [])];
    if (flags.includes("\\Noselect")) continue;
    const st = await c.status(b.path, { messages: true, unseen: true });
    out.push({
      path: b.path,
      specialUse: b.specialUse ?? "",
      messages: st.messages ?? 0,
      unseen: st.unseen ?? 0,
    });
  }
  return out;
}

async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile) names.push(e.name);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return names;
}

/** Per-folder record of UIDs the server refused to deliver. */
interface UnavailableFile {
  mailbox: string;
  uidValidity: string;
  uids: number[];
  updated: string;
}

async function readUnavailable(base: string): Promise<UnavailableFile | null> {
  try {
    return JSON.parse(
      await Deno.readTextFile(`${base}/unavailable.json`),
    ) as UnavailableFile;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function writeUnavailable(base: string, f: UnavailableFile) {
  const tmp = `${base}/tmp/unavailable.json`;
  await Deno.writeTextFile(tmp, JSON.stringify(f, null, 2) + "\n");
  await Deno.rename(tmp, `${base}/unavailable.json`);
}

/** Write one raw message into `<base>/cur` via tmp/ + rename. */
async function saveMaildir(
  base: string,
  uidValidity: string,
  uid: number,
  source: Uint8Array,
  flags: Iterable<string>,
  date?: Date,
) {
  const tmp = `${base}/tmp/${uidValidity}-${uid}`;
  await Deno.writeFile(tmp, source);
  if (date && !Number.isNaN(date.getTime())) {
    await Deno.utime(tmp, date, date);
  }
  await Deno.rename(tmp, `${base}/cur/${maildirName(uidValidity, uid, flags)}`);
}

/**
 * Archive one folder into `<root>/<dir>/{cur,new,tmp}`. The disk is the
 * state: every server UID with no file for the current UIDVALIDITY is
 * pending, so re-runs are incremental and an interrupted run resumes. Each
 * file is written to tmp/ and renamed into cur/, so a crash never leaves a
 * partial message under its final name.
 *
 * Yandex answers some messages with `NO [UNAVAILABLE] backend error` on every
 * attempt. A batch UID FETCH still returns every deliverable message before
 * the final NO, so whatever a batch did not return is recorded in
 * `unavailable.json` and skipped by later runs unless `retryUnavailable` is
 * set; `import-apple-mail` can fill those gaps from Apple Mail's cache.
 */
async function archiveFolder(
  c: ImapFlow,
  mailbox: string,
  dir: string,
  root: string,
  budget: number,
  batchSize: number,
  retryUnavailable: boolean,
) {
  const base = `${root}/${dir}`;
  for (const sub of ["cur", "new", "tmp"]) {
    await Deno.mkdir(`${base}/${sub}`, { recursive: true });
  }
  return await inMailbox(c, mailbox, async () => {
    const mb = c.mailbox;
    const uidValidity = String(mb ? mb.uidValidity : "0");
    const total = mb ? mb.exists : 0;
    const onDisk = archivedUids(
      [...await listNames(`${base}/cur`), ...await listNames(`${base}/new`)],
      uidValidity,
    );
    const prev = await readUnavailable(base);
    const known = new Set(
      prev && prev.uidValidity === uidValidity ? prev.uids : [],
    );
    const hits = total === 0
      ? []
      : await c.search({ all: true }, { uid: true });
    const server = Array.isArray(hits) ? hits : [];
    const pending = server.filter((u) =>
      !onDisk.has(u) && (retryUnavailable || !known.has(u))
    ).sort((x, y) => x - y);
    const todo = pending.slice(
      0,
      Math.max(0, Math.min(budget, pending.length)),
    );
    let archived = 0;
    let bytes = 0;
    const query = { uid: true, source: true, flags: true, internalDate: true };
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      const got = new Set<number>();
      try {
        for await (const m of c.fetch(batch, query, { uid: true })) {
          if (!m.source) continue;
          const src = new Uint8Array(m.source);
          await saveMaildir(
            base,
            uidValidity,
            m.uid,
            src,
            m.flags ?? [],
            m.internalDate ? new Date(m.internalDate) : undefined,
          );
          got.add(m.uid);
          archived++;
          bytes += src.byteLength;
        }
      } catch (e) {
        // A per-message NO turns the whole command into NO after the
        // deliverable messages were streamed; anything else is fatal.
        const err = e as { responseStatus?: string };
        if (err.responseStatus !== "NO") throw imapError(e);
      }
      for (const u of batch) {
        if (got.has(u)) known.delete(u);
        else known.add(u);
      }
      // Persist after every batch so a dropped session loses no progress.
      await writeUnavailable(base, {
        mailbox,
        uidValidity,
        uids: [...known].sort((x, y) => x - y),
        updated: now(),
      });
    }
    // Forget UIDs the server no longer has, or that are now archived.
    const serverSet = new Set(server);
    const unavailable = [...known].filter((u) =>
      serverSet.has(u) && !onDisk.has(u)
    ).sort((x, y) => x - y);
    await writeUnavailable(base, {
      mailbox,
      uidValidity,
      uids: unavailable,
      updated: now(),
    });
    return {
      mailbox,
      dir,
      uidValidity,
      total,
      alreadyArchived: onDisk.size,
      archived,
      bytes,
      unavailable: unavailable.length,
      remaining: pending.length - todo.length,
      complete: pending.length === todo.length,
      attempted: todo.length,
    };
  });
}

/**
 * Apply `op` to every id, one mailbox lock per source mailbox. When `dest` is
 * set and the server returns a UID map (UIDPLUS), the new id is reported so
 * callers can keep addressing a moved message.
 */
async function bulk(
  c: ImapFlow,
  ids: string[],
  op: (range: string) => Promise<unknown>,
  dest: string,
) {
  const out: Array<{ id: string; newId: string }> = [];
  for (const [mailbox, uids] of groupByMailbox(ids)) {
    await inMailbox(c, mailbox, async () => {
      const res = await op(uids.join(",")) as
        | { uidMap?: Map<number, number> }
        | boolean
        | undefined;
      const map = typeof res === "object" ? res?.uidMap : undefined;
      for (const uid of uids) {
        const moved = map?.get(uid);
        out.push({
          id: encodeEmailId(mailbox, uid),
          newId: dest && moved ? encodeEmailId(dest, moved) : "",
        });
      }
    });
  }
  return out;
}

// ── Apple Mail import ───────────────────────────────────────────────────────

/**
 * Open a private copy of Mail's Envelope Index. Mail keeps the live database
 * open in WAL mode, so the db, -wal and -shm files are copied together and
 * the copy is opened read-only; Mail's own file is never touched.
 */
async function openEnvelopeIndex(path: string) {
  const dir = await Deno.makeTempDir({ prefix: "yandex-mail-ei-" });
  const copy = `${dir}/index.db`;
  await Deno.copyFile(path, copy);
  for (const ext of ["-wal", "-shm"]) {
    try {
      await Deno.copyFile(`${path}${ext}`, `${copy}${ext}`);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  const db = new DatabaseSync(copy);
  return {
    db,
    close: () => {
      db.close();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

/** Index every `<rowid>[.partial].emlx` and Attachments/<rowid> under dir. */
async function indexAppleMbox(dir: string) {
  const emlx = new Map<number, { path: string; partial: boolean }>();
  const attachments = new Map<number, string>();
  const walk = async (d: string): Promise<void> => {
    let entries: Deno.DirEntry[] = [];
    try {
      entries = await Array.fromAsync(Deno.readDir(d));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) {
        // Nested .mbox directories are other folders, indexed separately.
        if (e.name.endsWith(".mbox")) continue;
        if (d.endsWith("/Attachments") && /^\d+$/.test(e.name)) {
          attachments.set(Number(e.name), p);
          continue;
        }
        await walk(p);
      } else if (e.isFile) {
        const id = emlxRowId(e.name);
        if (!id) continue;
        const prev = emlx.get(id.rowId);
        // A full copy always beats a partial one.
        if (!prev || (prev.partial && !id.partial)) {
          emlx.set(id.rowId, { path: p, partial: id.partial });
        }
      }
    }
  };
  await walk(dir);
  return { emlx, attachments };
}

async function copyDir(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true });
  for await (const e of Deno.readDir(src)) {
    if (e.isDirectory) await copyDir(`${src}/${e.name}`, `${dst}/${e.name}`);
    else if (e.isFile) {
      await Deno.copyFile(`${src}/${e.name}`, `${dst}/${e.name}`);
    }
  }
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return fallback;
    throw e;
  }
}

/**
 * Copy each unavailable UID of one Maildir folder out of Apple Mail's cache.
 * The message keeps the Maildir name an IMAP fetch would have produced, so
 * archive-mailbox treats it as archived. A `.partial.emlx` (Mail had not
 * downloaded every MIME part) is still written, its Attachments/<rowid>
 * directory is copied to `attachments/<uid>/`, and the UID is listed in
 * `apple-mail.json` under `partial`.
 */
async function importFolderFromAppleMail(
  db: InstanceType<typeof DatabaseSync>,
  accountDir: string,
  accountId: string,
  base: string,
  unavailable: { mailbox: string; uidValidity: string; uids: number[] },
) {
  const { mailbox, uidValidity } = unavailable;
  const box = db.prepare("SELECT ROWID AS id FROM mailboxes WHERE url = ?")
    .get(appleMailboxUrl(accountId, mailbox)) as { id: number } | undefined;
  const result = {
    mailbox,
    requested: unavailable.uids.length,
    imported: 0,
    partial: 0,
    missing: 0,
  };
  if (!box) {
    result.missing = unavailable.uids.length;
    return result;
  }
  const mboxDir = `${accountDir}/${
    mailbox.split("|").map((s) => `${s}.mbox`).join("/")
  }`;
  const files = await indexAppleMbox(mboxDir);
  const lookup = db.prepare(
    "SELECT ROWID AS id, flags, date_received AS received FROM messages " +
      "WHERE mailbox = ? AND remote_id = ? ORDER BY ROWID DESC",
  );
  const record = await readJsonOr<{ full: number[]; partial: number[] }>(
    `${base}/apple-mail.json`,
    { full: [], partial: [] },
  );
  const left: number[] = [];
  for (const uid of unavailable.uids) {
    const rows = lookup.all(box.id, uid) as Array<
      { id: number; flags: number; received: number }
    >;
    const row = rows.find((r) => files.emlx.has(r.id));
    if (!row) {
      left.push(uid);
      result.missing++;
      continue;
    }
    const file = files.emlx.get(row.id)!;
    const source = parseEmlx(await Deno.readFile(file.path));
    await saveMaildir(
      base,
      uidValidity,
      uid,
      source,
      appleMailFlags(Number(row.flags)),
      row.received ? new Date(Number(row.received) * 1000) : undefined,
    );
    if (file.partial) {
      const att = files.attachments.get(row.id);
      if (att) await copyDir(att, `${base}/attachments/${uid}`);
      record.partial.push(uid);
      result.partial++;
    } else {
      record.full.push(uid);
    }
    result.imported++;
  }
  const uniq = (xs: number[]) => [...new Set(xs)].sort((x, y) => x - y);
  await Deno.writeTextFile(
    `${base}/apple-mail.json`,
    JSON.stringify(
      { full: uniq(record.full), partial: uniq(record.partial) },
      null,
      2,
    ) + "\n",
  );
  await writeUnavailable(base, { ...unavailable, uids: left, updated: now() });
  return result;
}

/**
 * Yandex logs a session out after a run of `NO [UNAVAILABLE]` replies, so a
 * long archive sees "Connection not available" mid-folder. Re-run `fn` on a
 * fresh connection; the Maildir and unavailable.json are the resume state.
 */
async function withReconnect<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, e: Error) => void,
  maxAttempts = 50,
): Promise<T> {
  for (let attempt = 1;; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error & { code?: string };
      const dropped =
        /Connection (not available|closed)|ECONNRESET|EPIPE|BYE|Socket|timed? ?out/i
          .test(`${err.message} ${err.code ?? ""}`);
      if (!dropped || attempt >= maxAttempts) throw err;
      onRetry(attempt, err);
    }
  }
}
