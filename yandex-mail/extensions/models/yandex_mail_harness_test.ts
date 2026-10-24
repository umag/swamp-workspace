/**
 * Shared harness for the @magistr/yandex-mail suites: an in-memory IMAP
 * server (`FakeServer`) behind a fake imapflow client, and a fake SMTP
 * transport, swapped in through the model's `transport` seam so no test
 * opens a socket. Messages are real RFC 5322 bytes built with nodemailer's
 * MailComposer and parsed with postal-mime, the same libraries the model
 * uses.
 *
 * Named `_test.ts` so swamp's model loader skips it and `deno test` runs it
 * as a file with no tests.
 */
import { Buffer } from "node:buffer";
import MailComposer from "npm:nodemailer@10.2.1/lib/mail-composer/index.js";
import PostalMime from "npm:postal-mime@4.1.4";
import { type ImapOptions, transport } from "./yandex_mail.ts";

/** The app password every test uses; asserted never to leak. */
export const SECRET = "s3cret-app-pass-XYZ";

/** Default global arguments. */
export const GLOBAL_ARGS: Record<string, unknown> = {
  username: "me@yandex.ru",
  appPassword: SECRET,
  imapHost: "imap.test",
  smtpHost: "smtp.test",
  smtpPort: 465,
};

/** One `writeResource` call. */
export type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

/** A fake method context that records writes and log lines. */
export function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
      writeResource: (
        spec: string,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        written.push({ spec, name, payload });
        return Promise.resolve({ name });
      },
      logger: {
        info: (msg: string, meta?: Record<string, unknown>) => {
          logs.push({ msg, meta });
        },
      },
    },
  };
}

/** Input for a synthetic message. */
export interface MessageSpec {
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
  attachments?: Array<
    { filename?: string; content: string | Buffer; contentType?: string }
  >;
}

/** Build real RFC 5322 bytes for a message. */
export async function buildRaw(m: MessageSpec): Promise<Buffer> {
  const mail = new MailComposer({
    from: m.from ?? "Alice <alice@example.com>",
    to: m.to ?? "me@yandex.ru",
    cc: m.cc,
    bcc: m.bcc,
    replyTo: m.replyTo,
    subject: m.subject ?? "Hello",
    text: m.text ?? "Hi there",
    html: m.html,
    messageId: m.messageId,
    inReplyTo: m.inReplyTo,
    references: m.references,
    date: m.date ?? new Date("2026-10-01T10:00:00Z"),
    attachments: m.attachments,
  }).compile();
  mail.keepBcc = true;
  return await mail.build();
}

/** A message stored in a fake mailbox. */
export interface FakeMessage {
  uid: number;
  source: Buffer;
  flags: Set<string>;
  internalDate: Date;
}

/** A fake mailbox. */
export interface FakeBox {
  path: string;
  delimiter: string;
  specialUse?: string;
  flags: Set<string>;
  uidValidity: bigint;
  nextUid: number;
  messages: Map<number, FakeMessage>;
  /** UIDs the server answers with NO [UNAVAILABLE] on fetch. */
  unavailable: Set<number>;
}

/** An IMAP error shaped like imapflow's. */
export function imapErr(
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), extra);
}

function uidsOf(range: string | number[] | number): number[] {
  if (Array.isArray(range)) return range;
  return String(range).split(",").map(Number);
}

function headerBlock(src: Buffer): string {
  const s = src.toString("latin1");
  const end = s.indexOf("\r\n\r\n");
  return (end < 0 ? s : s.slice(0, end)).replace(/\r\n[ \t]+/g, " ");
}

function header(src: Buffer, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  return headerBlock(src).match(re)?.[1] ?? "";
}

/** In-memory IMAP server state plus a record of everything done to it. */
export class FakeServer {
  boxes = new Map<string, FakeBox>();
  /** Every client operation, in order: `[op, ...args]`. */
  log: Array<[string, ...unknown[]]> = [];
  /** Options each IMAP client was constructed with. */
  imapOptions: ImapOptions[] = [];
  /** Options each SMTP transport was constructed with. */
  smtpOptions: Record<string, unknown>[] = [];
  /** Messages handed to SMTP. */
  sent: Array<{ envelope: { from: string; to: string[] }; raw: string }> = [];
  /** When set, `connect()` throws it. */
  connectError?: Error;
  /** When set, `sendMail()` throws it. */
  smtpError?: Error;
  /** Per-operation errors to throw (op name → error, or a queue). */
  fail: Record<string, Error | Error[]> = {};
  sessions = 0;
  logouts = 0;
  /** When true, MOVE/COPY return no UID map (server without UIDPLUS). */
  noUidPlus = false;
  /** When true, APPEND returns no UID (server without UIDPLUS). */
  noAppendUid = false;

  /** Add a mailbox. */
  addBox(
    path: string,
    opts: { specialUse?: string; noselect?: boolean; uidValidity?: number } =
      {},
  ): FakeBox {
    const box: FakeBox = {
      path,
      delimiter: "|",
      specialUse: opts.specialUse,
      flags: new Set(opts.noselect ? ["\\Noselect"] : []),
      uidValidity: BigInt(opts.uidValidity ?? 1700000000),
      nextUid: 1,
      messages: new Map(),
      unavailable: new Set(),
    };
    this.boxes.set(path, box);
    return box;
  }

  /** Default Yandex-like folder set. */
  static standard(): FakeServer {
    const s = new FakeServer();
    s.addBox("INBOX");
    s.addBox("Sent", { specialUse: "\\Sent" });
    s.addBox("Drafts", { specialUse: "\\Drafts" });
    s.addBox("Trash", { specialUse: "\\Trash" });
    s.addBox("Spam", { specialUse: "\\Junk" });
    s.addBox("Archive", { specialUse: "\\Archive" });
    return s;
  }

  /** Append raw bytes; returns the new UID. */
  put(path: string, source: Buffer, flags: string[] = []): number {
    const box = this.boxes.get(path);
    if (!box) throw new Error(`no box ${path}`);
    const uid = box.nextUid++;
    box.messages.set(uid, {
      uid,
      source,
      flags: new Set(flags),
      internalDate: new Date("2026-10-01T10:00:00Z"),
    });
    return uid;
  }

  /** Build a message and append it; returns the new UID. */
  async add(
    path: string,
    m: MessageSpec = {},
    flags: string[] = [],
  ): Promise<number> {
    return this.put(path, await buildRaw(m), flags);
  }

  /** Throw the configured error for `op`, if any. */
  check(op: string) {
    const f = this.fail[op];
    if (!f) return;
    if (Array.isArray(f)) {
      const e = f.shift();
      if (f.length === 0) delete this.fail[op];
      if (e) throw e;
      return;
    }
    throw f;
  }

  /** Operations whose name matches, from the log. */
  ops(op: string): Array<[string, ...unknown[]]> {
    return this.log.filter((l) => l[0] === op);
  }
}

/** A fake imapflow client over a FakeServer. */
export class FakeImap {
  mailbox: { path: string; uidValidity: bigint; exists: number } | false =
    false;
  constructor(private s: FakeServer) {}

  private rec(op: string, ...args: unknown[]) {
    this.s.log.push([op, ...args]);
    this.s.check(op);
  }

  private box(path: string): FakeBox {
    const b = this.s.boxes.get(path);
    if (!b) {
      throw imapErr("Command failed", {
        responseText: `[NONEXISTENT] No such folder ${path}`,
        responseStatus: "NO",
      });
    }
    return b;
  }

  private current(): FakeBox {
    if (!this.mailbox) throw new Error("no mailbox selected");
    return this.box(this.mailbox.path);
  }

  connect() {
    this.s.sessions++;
    this.s.log.push(["connect"]);
    if (this.s.connectError) return Promise.reject(this.s.connectError);
    return Promise.resolve();
  }

  logout() {
    this.s.logouts++;
    this.s.log.push(["logout"]);
    return Promise.resolve();
  }

  close() {}

  getMailboxLock(path: string) {
    try {
      this.rec("lock", path);
      const b = this.box(path);
      this.mailbox = {
        path,
        uidValidity: b.uidValidity,
        exists: b.messages.size,
      };
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve({
      path,
      release: () => {
        this.s.log.push(["release", path]);
      },
    });
  }

  list() {
    this.rec("list");
    return Promise.resolve(
      [...this.s.boxes.values()].map((b) => ({
        path: b.path,
        delimiter: b.delimiter,
        specialUse: b.specialUse,
        flags: new Set(b.flags),
      })),
    );
  }

  status(path: string, q: Record<string, boolean>) {
    this.rec("status", path, q);
    const b = this.box(path);
    return Promise.resolve({
      path,
      messages: b.messages.size,
      unseen: [...b.messages.values()].filter((m) => !m.flags.has("\\Seen"))
        .length,
    });
  }

  mailboxCreate(path: string) {
    this.rec("create", path);
    this.s.addBox(path);
    return Promise.resolve({ path, created: true });
  }

  mailboxRename(path: string, newPath: string) {
    this.rec("rename", path, newPath);
    const b = this.box(path);
    this.s.boxes.delete(path);
    b.path = newPath;
    this.s.boxes.set(newPath, b);
    return Promise.resolve({ path, newPath });
  }

  mailboxDelete(path: string) {
    this.rec("delete", path);
    this.box(path);
    this.s.boxes.delete(path);
    return Promise.resolve({ path });
  }

  search(q: Record<string, unknown>, opts: Record<string, unknown>) {
    this.rec("search", q, opts);
    const b = this.current();
    const out: number[] = [];
    for (const m of b.messages.values()) {
      if (matches(m, q)) out.push(m.uid);
    }
    return Promise.resolve(out.sort((x, y) => x - y));
  }

  async *fetch(
    range: number[] | string,
    q: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) {
    this.rec("fetch", range, q, opts);
    const b = this.current();
    let refused = false;
    for (const uid of uidsOf(range)) {
      const m = b.messages.get(uid);
      if (!m) continue;
      if (b.unavailable.has(uid)) {
        refused = true;
        continue;
      }
      yield await view(m);
    }
    if (refused) {
      throw imapErr("Command failed", {
        responseStatus: "NO",
        responseText: "[UNAVAILABLE] backend error",
      });
    }
  }

  async fetchOne(
    uid: string,
    q: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) {
    this.rec("fetchOne", uid, q, opts);
    const m = this.current().messages.get(Number(uid));
    return m ? await view(m) : false;
  }

  messageFlagsAdd(range: string, flags: string[], opts: unknown) {
    this.rec("flagsAdd", range, flags, opts);
    const b = this.current();
    for (const u of uidsOf(range)) {
      flags.forEach((f) => b.messages.get(u)?.flags.add(f));
    }
    return Promise.resolve(true);
  }

  messageFlagsRemove(range: string, flags: string[], opts: unknown) {
    this.rec("flagsRemove", range, flags, opts);
    const b = this.current();
    for (const u of uidsOf(range)) {
      flags.forEach((f) => b.messages.get(u)?.flags.delete(f));
    }
    return Promise.resolve(true);
  }

  private transfer(range: string, dest: string, move: boolean) {
    const src = this.current();
    const to = this.box(dest);
    const uidMap = new Map<number, number>();
    for (const u of uidsOf(range)) {
      const m = src.messages.get(u);
      if (!m) continue;
      const nu = to.nextUid++;
      to.messages.set(nu, { ...m, uid: nu, flags: new Set(m.flags) });
      uidMap.set(u, nu);
      if (move) src.messages.delete(u);
    }
    return this.s.noUidPlus
      ? { path: src.path, destination: dest }
      : { path: src.path, destination: dest, uidMap };
  }

  messageMove(range: string, dest: string, opts: unknown) {
    try {
      this.rec("move", range, dest, opts);
      return Promise.resolve(this.transfer(range, dest, true));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  messageCopy(range: string, dest: string, opts: unknown) {
    try {
      this.rec("copy", range, dest, opts);
      return Promise.resolve(this.transfer(range, dest, false));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  messageDelete(range: string, opts: unknown) {
    this.rec("expunge", range, opts);
    const b = this.current();
    for (const u of uidsOf(range)) b.messages.delete(u);
    return Promise.resolve(true);
  }

  append(path: string, raw: Buffer, flags: string[]) {
    try {
      this.rec("append", path, flags);
      const uid = this.s.put(path, Buffer.from(raw), flags);
      return Promise.resolve(
        this.s.noAppendUid ? { destination: path } : { destination: path, uid },
      );
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

function matches(m: FakeMessage, q: Record<string, unknown>): boolean {
  const src = m.source;
  for (const [k, v] of Object.entries(q)) {
    switch (k) {
      case "all":
        break;
      case "seen":
        if (m.flags.has("\\Seen") !== v) return false;
        break;
      case "flagged":
        if (m.flags.has("\\Flagged") !== v) return false;
        break;
      case "since":
        if (m.internalDate < (v as Date)) return false;
        break;
      case "before":
        if (m.internalDate >= (v as Date)) return false;
        break;
      case "from":
      case "to":
      case "subject":
        if (
          !header(src, k).toLowerCase().includes(String(v).toLowerCase())
        ) return false;
        break;
      case "text":
        if (
          !src.toString("utf8").toLowerCase().includes(String(v).toLowerCase())
        ) return false;
        break;
      case "header":
        for (const [h, val] of Object.entries(v as Record<string, string>)) {
          if (!header(src, h).includes(val)) return false;
        }
        break;
      default:
        throw new Error(`fake search: unsupported key ${k}`);
    }
  }
  return true;
}

async function view(m: FakeMessage) {
  const p = await PostalMime.parse(m.source);
  const one = (a: unknown) => (a ? [a] : []);
  return {
    uid: m.uid,
    flags: new Set(m.flags),
    size: m.source.byteLength,
    internalDate: m.internalDate,
    source: m.source,
    envelope: {
      date: p.date ? new Date(p.date) : undefined,
      subject: p.subject,
      messageId: p.messageId,
      inReplyTo: p.inReplyTo,
      from: one(p.from),
      to: p.to ?? [],
      cc: p.cc ?? [],
      replyTo: p.replyTo ?? [],
    },
    bodyStructure: {
      childNodes: (p.attachments ?? []).map((a) => ({
        disposition: a.disposition ?? "attachment",
      })),
    },
  };
}

/**
 * Swap the model's transport for fakes over `server` for the duration of
 * `fn`, then restore the real factories.
 */
export async function withFake<T>(
  server: FakeServer,
  fn: (s: FakeServer) => Promise<T>,
): Promise<T> {
  const orig = { ...transport };
  transport.imap = (options) => {
    server.imapOptions.push(options);
    return new FakeImap(server) as unknown as ReturnType<typeof orig.imap>;
  };
  transport.smtp = (options) => {
    server.smtpOptions.push(options);
    return {
      sendMail: (m) => {
        if (server.smtpError) return Promise.reject(server.smtpError);
        const raw = Buffer.from(m.raw).toString("utf8");
        server.sent.push({ envelope: m.envelope, raw });
        const id = raw.match(/^Message-ID:\s*(.*)$/im)?.[1]?.trim();
        return Promise.resolve({
          messageId: id,
          accepted: m.envelope.to,
          rejected: [],
          response: "250 2.0.0 Ok: queued",
        });
      },
    };
  };
  try {
    return await fn(server);
  } finally {
    transport.imap = orig.imap;
    transport.smtp = orig.smtp;
  }
}

/** Header value of a raw sent message. */
export function sentHeader(raw: string, name: string): string {
  return raw.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
}
