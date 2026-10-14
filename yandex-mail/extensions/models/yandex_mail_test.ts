/**
 * Contract-fixture suite for @magistr/yandex-mail. Pins, with no network:
 *
 *  - the connection options the model hands imapflow and nodemailer
 *    (Yandex's documented endpoints: IMAP 993/TLS, SMTP 465 TLS or 587
 *    STARTTLS, app password or XOAUTH2);
 *  - the IMAP wire bytes imapflow's own compilers produce for the model's
 *    search queries and mailbox paths (quoting, modified UTF-7, CRLF
 *    refusal);
 *  - the mapping of a hand-written RFC 5322 fixture
 *    (`fixtures/yandex-message.eml`: Cyrillic encoded-word headers,
 *    multipart/alternative body, a PDF attachment) into the stored `email`
 *    resource;
 *  - the headers of an outgoing message as nodemailer composes it.
 *
 * If a test here breaks, the contract with Yandex or with one of the
 * pinned libraries changed.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { Buffer } from "node:buffer";
import compiler from "npm:imapflow@2.0.5/lib/handler/imap-compiler.js";
import { searchCompiler } from "npm:imapflow@2.0.5/lib/search-compiler.js";
import { encodePath } from "npm:imapflow@2.0.5/lib/tools.js";
import { model } from "./yandex_mail.ts";
import { buildSearchQuery } from "./yandex_mail_lib.ts";
import {
  FakeServer,
  GLOBAL_ARGS,
  makeCtx,
  SECRET,
  sentHeader,
  withFake,
} from "./yandex_mail_harness_test.ts";

const FIXTURE = new URL("../../fixtures/yandex-message.eml", import.meta.url);

/** A connection shape imapflow's compilers read (no UTF8=ACCEPT, rev1). */
const conn = () => ({
  capabilities: new Map<string, boolean>([["IMAP4rev1", true]]),
  enabled: new Set<string>(),
  mailbox: { path: "INBOX" },
});

async function wire(command: string, attributes: unknown[]): Promise<string> {
  const buf = await compiler(
    { tag: "A1", command, attributes } as never,
    { asArray: false },
  );
  // imapflow returns one Buffer per literal segment; join them.
  const parts = Array.isArray(buf) ? buf : [buf];
  return Buffer.concat(parts as Uint8Array[]).toString("latin1");
}

// ── Connection options ──────────────────────────────────────────────────────

Deno.test("IMAP: imap.yandex.com:993 over TLS with the app password", async () => {
  const s = FakeServer.standard();
  await withFake(
    s,
    () =>
      model.methods["list-mailboxes"].execute(
        {},
        makeCtx({ username: "me", appPassword: SECRET }).ctx,
      ),
  );
  assertEquals(s.imapOptions[0], {
    host: "imap.yandex.com",
    port: 993,
    secure: true,
    auth: { user: "me", pass: SECRET },
    logger: false,
  });
});

Deno.test("IMAP: an OAuth token is sent as XOAUTH2 accessToken", async () => {
  const s = FakeServer.standard();
  await withFake(
    s,
    () =>
      model.methods["list-mailboxes"].execute(
        {},
        makeCtx({ username: "me@ya.ru", oauthToken: "y0_tok" }).ctx,
      ),
  );
  assertEquals(s.imapOptions[0]?.auth, {
    user: "me@ya.ru",
    accessToken: "y0_tok",
  });
});

Deno.test("SMTP: 465 is implicit TLS, 587 is STARTTLS, OAuth2 shape", async () => {
  const s = FakeServer.standard();
  const send = (g: Record<string, unknown>) =>
    model.methods["send-email"].execute(
      { to: ["a@b.c"], subject: "s", text: "t" },
      makeCtx(g).ctx,
    );
  await withFake(s, async () => {
    await send({ username: "me", appPassword: SECRET });
    await send({ ...GLOBAL_ARGS, smtpPort: 587 });
    await send({ username: "me", oauthToken: "y0_tok" });
  });
  assertEquals(s.smtpOptions[0], {
    host: "smtp.yandex.com",
    port: 465,
    secure: true,
    auth: { user: "me", pass: SECRET },
  });
  assertEquals(s.smtpOptions[1].secure, false);
  assertEquals(s.smtpOptions[1].port, 587);
  assertEquals(s.smtpOptions[2].auth, {
    type: "OAuth2",
    user: "me",
    accessToken: "y0_tok",
  });
  // A bare login gets @yandex.ru for the From address and envelope.
  assertEquals(s.sent[0].envelope.from, "me@yandex.ru");
});

// ── IMAP wire format (imapflow's compilers) ─────────────────────────────────

Deno.test("wire: the query-emails filter compiles to IMAP SEARCH keys", async () => {
  const q = buildSearchQuery({
    after: "2026-01-02",
    before: "2026-02-03",
    from: "alice@example.com",
    subject: "Invoice 42",
    unseen: true,
    flagged: false,
  });
  const attrs = searchCompiler(conn() as never, q as never);
  assertEquals(
    await wire("UID SEARCH", attrs as unknown[]),
    'A1 UID SEARCH SINCE 02-Jan-2026 BEFORE 03-Feb-2026 FROM alice@example.com SUBJECT "Invoice 42" UNSEEN UNFLAGGED',
  );
});

Deno.test("wire: an empty filter is SEARCH ALL", async () => {
  const attrs = searchCompiler(conn() as never, buildSearchQuery({}) as never);
  assertEquals(
    await wire("UID SEARCH", attrs as unknown[]),
    "A1 UID SEARCH ALL",
  );
});

Deno.test("wire: Cyrillic search text adds CHARSET UTF-8", async () => {
  const attrs = searchCompiler(
    conn() as never,
    buildSearchQuery({ text: "счёт" }) as never,
  );
  const w = await wire("UID SEARCH", attrs as unknown[]);
  assert(w.startsWith("A1 UID SEARCH CHARSET UTF-8 TEXT"), w);
});

Deno.test("wire: the thread lookup is a HEADER Message-ID search", async () => {
  const attrs = searchCompiler(
    conn() as never,
    { header: { "message-id": "<root@yandex.ru>" } } as never,
  );
  assertEquals(
    await wire("UID SEARCH", attrs as unknown[]),
    "A1 UID SEARCH HEADER MESSAGE-ID <root@yandex.ru>",
  );
});

Deno.test("wire: mailbox paths are atoms, quoted strings or UTF-7", async () => {
  const create = async (path: string) =>
    await wire("CREATE", [{
      type: "ATOM",
      value: encodePath(conn() as never, path),
    }]);
  assertEquals(await create("Receipts"), "A1 CREATE Receipts");
  assertEquals(await create("My Folder"), 'A1 CREATE "My Folder"');
  assertEquals(await create('a"b\\c'), 'A1 CREATE "a\\"b\\\\c"');
  assertEquals(await create("Входящие"), "A1 CREATE &BBIERQQ+BDQETwRJBDgENQ-");
});

Deno.test("wire: imapflow refuses CR/LF in a mailbox token", async () => {
  await assertRejects(
    () => wire("CREATE", [{ type: "ATOM", value: "x\r\nA2 DELETE INBOX" }]),
    Error,
  );
});

// ── Parsing a real message ──────────────────────────────────────────────────

Deno.test("fixture: get-email maps the RFC 5322 message", async () => {
  const s = FakeServer.standard();
  const uid = s.put(
    "INBOX",
    Buffer.from(await Deno.readFile(FIXTURE)),
    ["\\Seen"],
  );
  const c = makeCtx();
  await withFake(
    s,
    () =>
      model.methods["get-email"].execute({ emailId: `INBOX:${uid}` }, c.ctx),
  );
  assertEquals(c.written[0].spec, "email");
  assertEquals(c.written[0].name, "INBOX-1");
  const e = c.written[0].payload.email as Record<string, unknown>;
  assertEquals({ ...e, html: undefined, text: undefined }, {
    id: "INBOX:1",
    mailbox: "INBOX",
    uid: 1,
    messageId: "<fixture-1@example.com>",
    inReplyTo: "<root@yandex.ru>",
    references: "<root@yandex.ru>",
    subject: "Счёт № 42",
    from: "Алиса <alice@example.com>",
    replyTo: ["list@example.com"],
    to: ["me@yandex.ru"],
    cc: ["Carol <carol@example.com>"],
    date: "2026-10-01T09:00:00.000Z",
    flags: ["\\Seen"],
    html: undefined,
    text: undefined,
    attachments: [{
      index: 0,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      disposition: "attachment",
      contentId: "",
      size: 9,
    }],
  });
  assertEquals((e.text as string).trim(), "Привет! Счёт во вложении.");
  assertStringIncludes(e.html as string, "Привет!");
});

Deno.test("fixture: query-emails summary of the message", async () => {
  const s = FakeServer.standard();
  s.put("INBOX", Buffer.from(await Deno.readFile(FIXTURE)));
  const c = makeCtx();
  await withFake(
    s,
    () => model.methods["query-emails"].execute({}, c.ctx),
  );
  const [m] = c.written[0].payload.emails as Record<string, unknown>[];
  assertEquals(m.subject, "Счёт № 42");
  assertEquals(m.from, ["Алиса <alice@example.com>"]);
  assertEquals(m.hasAttachment, true);
  assertEquals(m.seen, false);
  assertEquals(m.date, "2026-10-01T09:00:00.000Z");
});

// ── Outgoing message headers ────────────────────────────────────────────────

Deno.test("compose: the outgoing message carries the expected headers", async () => {
  const s = FakeServer.standard();
  await withFake(
    s,
    () =>
      model.methods["send-email"].execute({
        to: ["Bob <bob@example.com>"],
        cc: ["carol@example.com"],
        subject: "Встреча",
        text: "Привет",
        messageId: "meet-1@yandex.ru",
        inReplyTo: "<root@yandex.ru>",
        references: ["<root@yandex.ru>"],
      }, makeCtx({ ...GLOBAL_ARGS, fromName: "Me" }).ctx),
  );
  const raw = s.sent[0].raw;
  assertEquals(sentHeader(raw, "From"), "Me <me@yandex.ru>");
  assertEquals(sentHeader(raw, "To"), "Bob <bob@example.com>");
  assertEquals(sentHeader(raw, "Cc"), "carol@example.com");
  assertEquals(sentHeader(raw, "Message-ID"), "<meet-1@yandex.ru>");
  assertEquals(sentHeader(raw, "In-Reply-To"), "<root@yandex.ru>");
  assertEquals(sentHeader(raw, "References"), "<root@yandex.ru>");
  assertEquals(sentHeader(raw, "MIME-Version"), "1.0");
  assertEquals(sentHeader(raw, "Subject"), "=?UTF-8?B?0JLRgdGC0YDQtdGH0LA=?=");
  assertStringIncludes(sentHeader(raw, "Content-Type"), "text/plain");
  assertEquals(s.sent[0].envelope, {
    from: "me@yandex.ru",
    to: ["bob@example.com", "carol@example.com"],
  });
});
