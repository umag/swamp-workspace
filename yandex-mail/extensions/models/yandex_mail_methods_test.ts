/**
 * Methods suite for @magistr/yandex-mail: every model method's success and
 * failure paths, driven through `model.methods.<m>.execute()` against the
 * in-memory IMAP server and fake SMTP transport (no network).
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { model } from "./yandex_mail.ts";
import {
  buildRaw,
  FakeServer,
  GLOBAL_ARGS,
  imapErr,
  makeCtx,
  sentHeader,
  withFake,
} from "./yandex_mail_harness_test.ts";

type Method = keyof typeof model.methods;

function run(name: Method, args: Record<string, unknown>, ctx = makeCtx()) {
  return model.methods[name].execute(args, ctx.ctx as never);
}

async function tmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "yandex-mail-test-" });
}

// ── Mailboxes ───────────────────────────────────────────────────────────────

Deno.test("get-account-summary totals messages and unread", async () => {
  const s = FakeServer.standard();
  s.addBox("Folders", { noselect: true });
  await s.add("INBOX", {}, ["\\Seen"]);
  await s.add("INBOX");
  await s.add("Sent", {}, ["\\Seen"]);
  const c = makeCtx();
  await withFake(s, () => run("get-account-summary", {}, c));
  const p = c.written[0].payload;
  assertEquals(c.written[0].spec, "summary");
  assertEquals(p.account, "me@yandex.ru");
  assertEquals(p.totalMessages, 3);
  assertEquals(p.totalUnread, 1);
  const paths = (p.mailboxes as { path: string }[]).map((m) => m.path);
  assert(!paths.includes("Folders"), "\\Noselect folders are skipped");
  assertEquals(s.logouts, 1);
});

Deno.test("get-account-summary fails without credentials", async () => {
  await assertRejects(
    () => run("get-account-summary", {}, makeCtx({ username: "me" })),
    Error,
    "Set appPassword",
  );
});

Deno.test("list-mailboxes writes every selectable folder", async () => {
  const s = FakeServer.standard();
  const c = makeCtx();
  await withFake(s, () => run("list-mailboxes", {}, c));
  assertEquals(c.written[0].spec, "mailboxes");
  assertEquals(c.written[0].payload.count, 6);
});

Deno.test("list-mailboxes surfaces a login failure", async () => {
  const s = FakeServer.standard();
  s.connectError = imapErr("Authentication failed", {
    responseText: "[AUTHENTICATIONFAILED] bad credentials",
  });
  await assertRejects(
    () => withFake(s, () => run("list-mailboxes", {})),
    Error,
    "IMAP login to imap.test failed: [AUTHENTICATIONFAILED]",
  );
});

Deno.test("create-mailbox creates, then is a no-op", async () => {
  const s = FakeServer.standard();
  const c = makeCtx();
  await withFake(s, async () => {
    await run("create-mailbox", { path: "Receipts" }, c);
    await run("create-mailbox", { path: "Receipts" }, c);
  });
  assertEquals(s.ops("create").length, 1);
  assertEquals(c.written[0].payload.changed, true);
  assertEquals(c.written[1].payload.changed, false);
  assertEquals(c.written[1].payload.detail, "already exists");
});

Deno.test("create-mailbox surfaces a server refusal", async () => {
  const s = FakeServer.standard();
  s.fail.create = imapErr("Command failed", { responseText: "[LIMIT] quota" });
  await assertRejects(
    () => withFake(s, () => run("create-mailbox", { path: "X" })),
    Error,
    "Command failed: [LIMIT] quota",
  );
});

Deno.test("rename-mailbox renames, then reports already renamed", async () => {
  const s = FakeServer.standard();
  s.addBox("Old");
  const c = makeCtx();
  await withFake(s, async () => {
    await run("rename-mailbox", { path: "Old", newPath: "New" }, c);
    await run("rename-mailbox", { path: "Old", newPath: "New" }, c);
  });
  assertEquals(s.ops("rename").length, 1);
  assert(s.boxes.has("New"));
  assertEquals(c.written[1].payload.detail, "already renamed");
});

Deno.test("rename-mailbox of a missing folder fails", async () => {
  const s = FakeServer.standard();
  await assertRejects(
    () =>
      withFake(s, () => run("rename-mailbox", { path: "Nope", newPath: "X" })),
    Error,
    "NONEXISTENT",
  );
});

Deno.test("delete-mailbox deletes, then is a no-op", async () => {
  const s = FakeServer.standard();
  s.addBox("Tmp");
  const c = makeCtx();
  await withFake(s, async () => {
    await run("delete-mailbox", { path: "Tmp" }, c);
    await run("delete-mailbox", { path: "Tmp" }, c);
  });
  assertEquals(s.ops("delete").length, 1);
  assertEquals(c.written[1].payload.detail, "does not exist");
});

Deno.test("delete-mailbox refuses INBOX and special-use folders", async () => {
  const s = FakeServer.standard();
  for (const path of ["INBOX", "Sent", "Trash"]) {
    await assertRejects(
      () => withFake(s, () => run("delete-mailbox", { path })),
      Error,
      "Refusing to delete system mailbox",
    );
  }
  assertEquals(s.ops("delete").length, 0);
});

// ── Reading ─────────────────────────────────────────────────────────────────

Deno.test("query-emails returns newest-first, limited summaries", async () => {
  const s = FakeServer.standard();
  for (let i = 1; i <= 5; i++) {
    await s.add("INBOX", { subject: `n${i}` }, i % 2 ? [] : ["\\Seen"]);
  }
  const c = makeCtx();
  await withFake(s, () => run("query-emails", { limit: 2 }, c));
  const p = c.written[0].payload;
  assertEquals(p.total, 5);
  assertEquals(p.count, 2);
  const emails = p.emails as { id: string; subject: string; seen: boolean }[];
  assertEquals(emails.map((e) => e.id), ["INBOX:5", "INBOX:4"]);
  assertEquals(emails[1].seen, true);
  assertEquals(emails[0].subject, "n5");
});

Deno.test("query-emails applies filters (unread only)", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX", {}, ["\\Seen"]);
  await s.add("INBOX");
  const c = makeCtx();
  await withFake(s, () => run("query-emails", { unseen: true }, c));
  assertEquals(c.written[0].payload.total, 1);
  assertEquals(s.ops("search")[0][1], { seen: false });
});

Deno.test("query-emails on an unknown mailbox fails clearly", async () => {
  const s = FakeServer.standard();
  await assertRejects(
    () => withFake(s, () => run("query-emails", { mailbox: "Nope" })),
    Error,
    'Cannot open mailbox "Nope"',
  );
  assertEquals(s.logouts, 1, "session is closed on failure");
});

Deno.test("get-email decodes body and attachments; markRead", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("INBOX", {
    subject: "Invoice",
    text: "see attached",
    attachments: [{ filename: "a.txt", content: "abc" }],
  });
  const c = makeCtx();
  await withFake(
    s,
    () => run("get-email", { emailId: `INBOX:${uid}`, markRead: true }, c),
  );
  const e = c.written[0].payload.email as Record<string, unknown>;
  assertEquals(e.subject, "Invoice");
  assertStringIncludes(e.text as string, "see attached");
  assertEquals(
    (e.attachments as { filename: string; size: number }[])[0],
    {
      index: 0,
      filename: "a.txt",
      mimeType: "text/plain",
      disposition: "attachment",
      contentId: "",
      size: 3,
    } as never,
  );
  assert((e.flags as string[]).includes("\\Seen"));
  assert(s.boxes.get("INBOX")!.messages.get(uid)!.flags.has("\\Seen"));
});

Deno.test("get-email of a missing uid fails", async () => {
  const s = FakeServer.standard();
  await assertRejects(
    () => withFake(s, () => run("get-email", { emailId: "INBOX:99" })),
    Error,
    "Email INBOX:99 not found",
  );
});

Deno.test("get-thread finds the parent in Sent and the reply in INBOX", async () => {
  const s = FakeServer.standard();
  await s.add("Sent", {
    from: "me@yandex.ru",
    to: "alice@example.com",
    messageId: "<root@yandex.ru>",
    date: new Date("2026-10-01T09:00:00Z"),
  });
  const reply = await s.add("INBOX", {
    messageId: "<r1@example.com>",
    inReplyTo: "<root@yandex.ru>",
    references: ["<root@yandex.ru>"],
    date: new Date("2026-10-01T10:00:00Z"),
  });
  await s.add("INBOX", { messageId: "<unrelated@x>" });
  const c = makeCtx();
  await withFake(s, () => run("get-thread", { emailId: `INBOX:${reply}` }, c));
  const p = c.written[0].payload;
  const ids = (p.emails as { id: string }[]).map((e) => e.id);
  assertEquals(ids, ["Sent:1", "INBOX:1"]);
});

Deno.test("get-thread fails when no Sent folder exists", async () => {
  const s = new FakeServer();
  s.addBox("INBOX");
  const uid = await s.add("INBOX", { messageId: "<a@b>" });
  await assertRejects(
    () => withFake(s, () => run("get-thread", { emailId: `INBOX:${uid}` })),
    Error,
    "No \\Sent mailbox found",
  );
});

Deno.test("get-attachment saves by index and by filename", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("INBOX", {
    attachments: [
      { filename: "a.txt", content: "AAA" },
      { filename: "b.bin", content: Buffer.from([1, 2, 3, 4]) },
    ],
  });
  const dir = await tmp();
  try {
    const c = makeCtx();
    await withFake(s, async () => {
      await run("get-attachment", {
        emailId: `INBOX:${uid}`,
        index: 0,
        outputDir: `${dir}/out/`,
      }, c);
      await run("get-attachment", {
        emailId: `INBOX:${uid}`,
        filename: "b.bin",
        outputDir: `${dir}/out`,
      }, c);
    });
    assertEquals(await Deno.readTextFile(`${dir}/out/a.txt`), "AAA");
    assertEquals(
      [...await Deno.readFile(`${dir}/out/b.bin`)],
      [1, 2, 3, 4],
    );
    assertEquals(c.written[1].payload.index, 1);
    assertEquals(c.written[1].payload.path, `${dir}/out/b.bin`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-attachment fails without index/filename or on a miss", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("INBOX");
  await assertRejects(
    () =>
      withFake(
        s,
        () =>
          run("get-attachment", { emailId: `INBOX:${uid}`, outputDir: "x" }),
      ),
    Error,
    "Pass index or filename",
  );
  await assertRejects(
    () =>
      withFake(s, () =>
        run("get-attachment", {
          emailId: `INBOX:${uid}`,
          filename: "nope.pdf",
          outputDir: "x",
        })),
    Error,
    "Attachment nope.pdf not found (have 0)",
  );
});

// ── Archive ─────────────────────────────────────────────────────────────────

Deno.test("archive-mailbox writes Maildir files and is incremental", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX", { subject: "one" }, ["\\Seen"]);
  await s.add("INBOX", { subject: "two" }, ["\\Flagged", "\\Seen"]);
  const dir = await tmp();
  try {
    const c = makeCtx();
    await withFake(s, async () => {
      await run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }, c);
      await s.add("INBOX", { subject: "three" });
      await run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }, c);
    });
    const names = (await Array.fromAsync(Deno.readDir(`${dir}/INBOX/cur`)))
      .map((e) => e.name).sort();
    assertEquals(names, [
      "1700000000-1:2,S",
      "1700000000-2:2,FS",
      "1700000000-3:2,",
    ]);
    assertEquals(c.written[0].payload.archived, 2);
    assertEquals(c.written[1].payload.archived, 1);
    const f1 = (c.written[1].payload.folders as Record<string, unknown>[])[0];
    assertEquals(f1.alreadyArchived, 2);
    assertEquals(f1.complete, true);
    assert(!("attempted" in f1), "internal budget field is not stored");
    const raw = await Deno.readTextFile(`${dir}/INBOX/cur/1700000000-1:2,S`);
    assertStringIncludes(raw, "Subject: one");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive-mailbox records unavailable UIDs and skips them", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  await s.add("INBOX");
  s.boxes.get("INBOX")!.unavailable.add(2);
  const dir = await tmp();
  try {
    const c = makeCtx();
    await withFake(s, async () => {
      await run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }, c);
      await run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }, c);
    });
    const un = JSON.parse(
      await Deno.readTextFile(`${dir}/INBOX/unavailable.json`),
    );
    assertEquals(un.uids, [2]);
    assertEquals(c.written[0].payload.unavailable, 1);
    // Second run: nothing pending, the UID is not fetched again.
    const fetches = s.ops("fetch");
    assertEquals(fetches.length, 1);
    assertEquals(c.written[1].payload.archived, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive-mailbox rejects an unknown folder", async () => {
  const s = FakeServer.standard();
  const dir = await tmp();
  try {
    await assertRejects(
      () =>
        withFake(
          s,
          () => run("archive-mailbox", { outputDir: dir, mailboxes: ["Nope"] }),
        ),
      Error,
      "Unknown mailbox(es): Nope",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive-mailbox reconnects after a dropped session", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  s.fail.search = [imapErr("Connection not available")];
  const dir = await tmp();
  try {
    const c = makeCtx();
    await withFake(
      s,
      () => run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }, c),
    );
    assertEquals(c.written[0].payload.archived, 1);
    assert(c.logs.some((l) => l.msg.includes("session dropped")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Apple Mail import ───────────────────────────────────────────────────────

async function appleFixture(dir: string, raw: Buffer) {
  const account = `${dir}/Mail/V10/ACC-1`;
  const msgs = `${account}/INBOX.mbox/X/Data/Messages`;
  await Deno.mkdir(msgs, { recursive: true });
  const emlx = Buffer.concat([
    Buffer.from(`${raw.byteLength}\n`),
    raw,
    Buffer.from('<?xml version="1.0"?><plist/>'),
  ]);
  await Deno.writeFile(`${msgs}/42.emlx`, emlx);
  await Deno.mkdir(`${dir}/Mail/V10/MailData`, { recursive: true });
  const db = new DatabaseSync(`${dir}/Mail/V10/MailData/Envelope Index`);
  db.exec(
    "CREATE TABLE mailboxes (url TEXT); " +
      "CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, mailbox INTEGER, " +
      "remote_id INTEGER, flags INTEGER, date_received INTEGER);",
  );
  db.prepare("INSERT INTO mailboxes (rowid, url) VALUES (1, ?)").run(
    "imap://ACC-1/INBOX",
  );
  db.prepare(
    "INSERT INTO messages (ROWID, mailbox, remote_id, flags, date_received) " +
      "VALUES (42, 1, 7, 17, 1759312800)",
  ).run();
  db.close();
  const out = `${dir}/out/INBOX`;
  for (const sub of ["cur", "new", "tmp"]) {
    await Deno.mkdir(`${out}/${sub}`, { recursive: true });
  }
  await Deno.writeTextFile(
    `${out}/unavailable.json`,
    JSON.stringify({
      mailbox: "INBOX",
      uidValidity: "1700000000",
      uids: [7, 8],
      updated: "",
    }),
  );
  return account;
}

Deno.test("import-apple-mail fills gaps from the .emlx cache", async () => {
  const dir = await tmp();
  try {
    const raw = await buildRaw({ subject: "from apple" });
    const account = await appleFixture(dir, raw);
    const c = makeCtx();
    await run("import-apple-mail", {
      outputDir: `${dir}/out`,
      accountDir: account,
    }, c);
    const p = c.written[0].payload;
    assertEquals([p.imported, p.partial, p.missing], [1, 0, 1]);
    const file = `${dir}/out/INBOX/cur/1700000000-7:2,FS`;
    assertEquals(await Deno.readFile(file), new Uint8Array(raw));
    const un = JSON.parse(
      await Deno.readTextFile(`${dir}/out/INBOX/unavailable.json`),
    );
    assertEquals(un.uids, [8]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("import-apple-mail fails on a missing Envelope Index", async () => {
  const dir = await tmp();
  try {
    await Deno.mkdir(`${dir}/out`);
    await Deno.mkdir(`${dir}/acct`);
    await assertRejects(
      () =>
        run("import-apple-mail", {
          outputDir: `${dir}/out`,
          accountDir: `${dir}/acct`,
        }),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Sending ─────────────────────────────────────────────────────────────────

Deno.test("send-email sends over SMTP with the From header", async () => {
  const s = FakeServer.standard();
  const c = makeCtx({ ...GLOBAL_ARGS, fromName: "Me Myself" });
  await withFake(s, () =>
    run("send-email", {
      to: ["Bob <bob@example.com>"],
      bcc: ["hidden@example.com"],
      subject: "Hi",
      text: "Hello Bob",
    }, c));
  assertEquals(s.sent.length, 1);
  const { raw, envelope } = s.sent[0];
  assertEquals(sentHeader(raw, "From"), "Me Myself <me@yandex.ru>");
  assertEquals(envelope.to, ["bob@example.com", "hidden@example.com"]);
  assert(!/^Bcc:/im.test(raw), "Bcc is not written into the message");
  const p = c.written[0].payload;
  assertEquals(p.skipped, false);
  assertEquals(p.accepted, ["bob@example.com", "hidden@example.com"]);
  assertEquals(s.sessions, 0, "no IMAP session without messageId/saveToSent");
});

Deno.test("send-email with messageId is idempotent via Sent", async () => {
  const s = FakeServer.standard();
  await s.add("Sent", { messageId: "<fixed-1@yandex.ru>" });
  const c = makeCtx();
  await withFake(s, () =>
    run("send-email", {
      to: ["bob@example.com"],
      subject: "Hi",
      text: "x",
      messageId: "fixed-1@yandex.ru",
    }, c));
  assertEquals(s.sent.length, 0);
  assertEquals(c.written[0].payload.skipped, true);
  assertEquals(c.written[0].payload.messageId, "<fixed-1@yandex.ru>");
});

Deno.test("send-email saveToSent appends a \\Seen copy", async () => {
  const s = FakeServer.standard();
  const c = makeCtx();
  await withFake(s, () =>
    run("send-email", {
      to: ["bob@example.com"],
      subject: "Hi",
      text: "x",
      saveToSent: true,
    }, c));
  assertEquals(c.written[0].payload.savedTo, "Sent");
  assertEquals(s.ops("append")[0].slice(1), ["Sent", ["\\Seen"]]);
});

Deno.test("send-email requires a body and surfaces SMTP errors", async () => {
  const s = FakeServer.standard();
  await assertRejects(
    () =>
      withFake(
        s,
        () => run("send-email", { to: ["a@b.c"], subject: "x" }),
      ),
    Error,
    "Pass text or html",
  );
  s.smtpError = new Error("535 5.7.8 Error: authentication failed");
  await assertRejects(
    () =>
      withFake(
        s,
        () => run("send-email", { to: ["a@b.c"], subject: "x", text: "y" }),
      ),
    Error,
    "535",
  );
});

Deno.test("reply-email quotes, threads and replies to Reply-To", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("INBOX", {
    from: "Alice <alice@example.com>",
    replyTo: "list@example.com",
    to: ["me@yandex.ru", "carol@example.com"],
    subject: "Plans",
    text: "line1\nline2",
    messageId: "<orig@example.com>",
  });
  const c = makeCtx();
  await withFake(s, () =>
    run("reply-email", {
      emailId: `INBOX:${uid}`,
      text: "Sounds good",
      replyAll: true,
    }, c));
  const raw = s.sent[0].raw;
  assertEquals(sentHeader(raw, "Subject"), "Re: Plans");
  assertEquals(sentHeader(raw, "In-Reply-To"), "<orig@example.com>");
  assertEquals(s.sent[0].envelope.to, [
    "list@example.com",
    "carol@example.com",
  ]);
  assertStringIncludes(raw, "> line1");
  assertEquals(c.written[0].payload.to, ["list@example.com"]);
});

Deno.test("reply-email fails when the original has no reply address", async () => {
  const s = FakeServer.standard();
  const raw = Buffer.from("Subject: orphan\r\n\r\nbody\r\n");
  const uid = s.put("INBOX", raw);
  await assertRejects(
    () =>
      withFake(
        s,
        () => run("reply-email", { emailId: `INBOX:${uid}`, text: "x" }),
      ),
    Error,
    "Original has no reply address",
  );
});

Deno.test("forward-email attaches the original as message/rfc822", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("INBOX", { subject: "Report", text: "numbers" });
  const c = makeCtx();
  await withFake(s, () =>
    run("forward-email", {
      emailId: `INBOX:${uid}`,
      to: ["boss@example.com"],
      text: "FYI",
    }, c));
  const raw = s.sent[0].raw;
  assertEquals(sentHeader(raw, "Subject"), "Fwd: Report");
  assertStringIncludes(raw, "message/rfc822");
  assertStringIncludes(raw, "Forwarded message");
  assertEquals(c.written[0].payload.to, ["boss@example.com"]);
});

Deno.test("forward-email of a missing email fails before sending", async () => {
  const s = FakeServer.standard();
  await assertRejects(
    () =>
      withFake(
        s,
        () => run("forward-email", { emailId: "INBOX:5", to: ["a@b.c"] }),
      ),
    Error,
    "not found",
  );
  assertEquals(s.sent.length, 0);
});

Deno.test("create-draft appends to Drafts and keeps Bcc", async () => {
  const s = FakeServer.standard();
  const c = makeCtx();
  await withFake(s, () =>
    run("create-draft", {
      to: ["bob@example.com"],
      bcc: ["secret@example.com"],
      subject: "Draft",
      text: "wip",
    }, c));
  const p = c.written[0].payload;
  assertEquals(p.emailId, "Drafts:1");
  assertEquals(s.ops("append")[0].slice(1), ["Drafts", ["\\Draft", "\\Seen"]]);
  const raw = s.boxes.get("Drafts")!.messages.get(1)!.source.toString();
  assertMatch(raw, /^Bcc: secret@example.com/m);
});

Deno.test("create-draft fails without a Drafts folder", async () => {
  const s = new FakeServer();
  s.addBox("INBOX");
  await assertRejects(
    () =>
      withFake(
        s,
        () => run("create-draft", { to: ["a@b.c"], subject: "x", text: "y" }),
      ),
    Error,
    "No \\Drafts mailbox found",
  );
});

Deno.test("send-draft sends the draft and removes it", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("Drafts", {
    from: "me@yandex.ru",
    to: "bob@example.com",
    bcc: "hidden@example.com",
    subject: "Ready",
    text: "go",
    messageId: "<draft-1@yandex.ru>",
  }, ["\\Draft"]);
  const c = makeCtx();
  await withFake(s, () => run("send-draft", { emailId: `Drafts:${uid}` }, c));
  assertEquals(s.sent[0].envelope.to, [
    "bob@example.com",
    "hidden@example.com",
  ]);
  assertEquals(sentHeader(s.sent[0].raw, "Message-ID"), "<draft-1@yandex.ru>");
  assertEquals(s.boxes.get("Drafts")!.messages.size, 0);
  assertEquals(c.written[0].payload.subject, "Ready");
});

Deno.test("send-draft refuses a draft with no recipients", async () => {
  const s = FakeServer.standard();
  const uid = s.put("Drafts", Buffer.from("Subject: empty\r\n\r\nx\r\n"));
  await assertRejects(
    () => withFake(s, () => run("send-draft", { emailId: `Drafts:${uid}` })),
    Error,
    "Draft has no To recipients",
  );
  assertEquals(s.boxes.get("Drafts")!.messages.size, 1, "draft is kept");
});

// ── Organising ──────────────────────────────────────────────────────────────

Deno.test("set-email sets flags and moves, reporting the new id", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("INBOX", {}, ["\\Seen"]);
  const c = makeCtx();
  await withFake(s, () =>
    run("set-email", {
      emailId: `INBOX:${uid}`,
      seen: false,
      flagged: true,
      moveTo: "Archive",
    }, c));
  const e = c.written[0].payload.email as Record<string, unknown>;
  assertEquals(e.newId, "Archive:1");
  const m = s.boxes.get("Archive")!.messages.get(1)!;
  assertEquals([...m.flags], ["\\Flagged"]);
});

Deno.test("set-email to a missing folder fails", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("INBOX");
  await assertRejects(
    () =>
      withFake(
        s,
        () => run("set-email", { emailId: `INBOX:${uid}`, moveTo: "Nope" }),
      ),
    Error,
    "NONEXISTENT",
  );
});

Deno.test("archive-email marks read and moves to Archive", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  await s.add("INBOX");
  const c = makeCtx();
  await withFake(
    s,
    () => run("archive-email", { emailIds: ["INBOX:1", "INBOX:2"] }, c),
  );
  assertEquals(c.written[0].payload.emails, [
    { id: "INBOX:1", newId: "Archive:1" },
    { id: "INBOX:2", newId: "Archive:2" },
  ]);
  assert(s.boxes.get("Archive")!.messages.get(1)!.flags.has("\\Seen"));
  assertEquals(s.ops("lock").filter((l) => l[1] === "INBOX").length, 1);
});

Deno.test("archive-email rejects a malformed id before connecting", async () => {
  const s = FakeServer.standard();
  await assertRejects(
    () => withFake(s, () => run("archive-email", { emailIds: ["INBOX"] })),
    Error,
    "Invalid emailId",
  );
  assertEquals(s.ops("move").length, 0);
});

Deno.test("delete-email expunges each id", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  await s.add("Spam");
  const c = makeCtx();
  await withFake(
    s,
    () => run("delete-email", { emailIds: ["INBOX:1", "Spam:1"] }, c),
  );
  assertEquals(s.boxes.get("INBOX")!.messages.size, 0);
  assertEquals(s.boxes.get("Spam")!.messages.size, 0);
  assertEquals(c.written[0].payload.count, 2);
});

Deno.test("delete-email surfaces a server refusal", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  s.fail.expunge = imapErr("Command failed", { responseText: "[CANNOT] ro" });
  await assertRejects(
    () => withFake(s, () => run("delete-email", { emailIds: ["INBOX:1"] })),
    Error,
    "[CANNOT] ro",
  );
});

Deno.test("bulk-email-action covers every action", async () => {
  const s = FakeServer.standard();
  s.addBox("Keep");
  for (let i = 0; i < 4; i++) await s.add("INBOX");
  await withFake(s, async () => {
    for (const action of ["mark-read", "flag"]) {
      await run("bulk-email-action", { emailIds: ["INBOX:1"], action });
    }
    const m = s.boxes.get("INBOX")!.messages.get(1)!;
    assertEquals([...m.flags].sort(), ["\\Flagged", "\\Seen"]);
    for (const action of ["mark-unread", "unflag"]) {
      await run("bulk-email-action", { emailIds: ["INBOX:1"], action });
    }
    assertEquals(m.flags.size, 0);
    await run("bulk-email-action", {
      emailIds: ["INBOX:1"],
      action: "copy",
      mailbox: "Keep",
    });
    await run("bulk-email-action", {
      emailIds: ["INBOX:2"],
      action: "move",
      mailbox: "Keep",
    });
    await run("bulk-email-action", { emailIds: ["INBOX:3"], action: "trash" });
    await run("bulk-email-action", { emailIds: ["INBOX:4"], action: "spam" });
  });
  assertEquals(s.boxes.get("Keep")!.messages.size, 2);
  assertEquals(s.boxes.get("Trash")!.messages.size, 1);
  assertEquals(s.boxes.get("Spam")!.messages.size, 1);
  assertEquals([...s.boxes.get("INBOX")!.messages.keys()], [1]);
});

Deno.test("bulk-email-action move/copy require a mailbox", async () => {
  const s = FakeServer.standard();
  for (const action of ["move", "copy"]) {
    await assertRejects(
      () =>
        withFake(
          s,
          () => run("bulk-email-action", { emailIds: ["INBOX:1"], action }),
        ),
      Error,
      `mailbox required for ${action}`,
    );
  }
});

Deno.test("every method is covered by this suite", () => {
  const src = Deno.readTextFileSync(new URL(import.meta.url));
  for (const name of Object.keys(model.methods)) {
    assert(src.includes(`"${name}"`), `no test drives ${name}`);
  }
});
