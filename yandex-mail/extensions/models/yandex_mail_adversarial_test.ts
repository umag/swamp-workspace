/**
 * Adversarial suite for @magistr/yandex-mail: hostile arguments (IMAP
 * command injection via CR/LF, sequence-set smuggling through email ids,
 * SMTP header injection), hostile server data (path traversal through
 * attachment file names and folder names, spec-violating replies) and
 * credential handling.
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
} from "jsr:@std/assert@1.0.13";
import { Buffer } from "node:buffer";
import { model } from "./yandex_mail.ts";
import {
  FakeServer,
  GLOBAL_ARGS,
  imapErr,
  makeCtx,
  SECRET,
  sentHeader,
  withFake,
} from "./yandex_mail_harness_test.ts";

type Method = keyof typeof model.methods;

function run(name: Method, args: Record<string, unknown>, ctx = makeCtx()) {
  return model.methods[name].execute(args, ctx.ctx as never);
}

const INJECT = "Receipts\r\nA2 DELETE INBOX";

// ── IMAP command injection ──────────────────────────────────────────────────

Deno.test("CR/LF/NUL in a mailbox argument is rejected before connecting", async () => {
  const s = FakeServer.standard();
  const cases: Array<[Method, Record<string, unknown>]> = [
    ["create-mailbox", { path: INJECT }],
    ["rename-mailbox", { path: "A", newPath: INJECT }],
    ["rename-mailbox", { path: "A\nB", newPath: "C" }],
    ["delete-mailbox", { path: "X\0Y" }],
    ["query-emails", { mailbox: INJECT }],
    ["set-email", { emailId: "INBOX:1", moveTo: INJECT }],
    ["archive-email", { emailIds: ["INBOX:1"], archiveMailbox: INJECT }],
    ["bulk-email-action", {
      emailIds: ["INBOX:1"],
      action: "move",
      mailbox: INJECT,
    }],
    ["get-thread", { emailId: "INBOX:1", mailboxes: [INJECT] }],
  ];
  for (const [m, args] of cases) {
    await assertRejects(() => withFake(s, () => run(m, args)), Error);
  }
  assertEquals(s.sessions, 0, "no IMAP session was opened");
  assert(s.boxes.has("INBOX"));
});

Deno.test("an empty mailbox path is rejected", async () => {
  const s = FakeServer.standard();
  await assertRejects(
    () => withFake(s, () => run("create-mailbox", { path: "" })),
    Error,
  );
  assertEquals(s.sessions, 0);
});

Deno.test("CR/LF in the mailbox part of an email id is rejected", async () => {
  const s = FakeServer.standard();
  for (const id of ["INBOX\r\nA2 LOGOUT:1", "IN\0BOX:1", "INBOX\n:3"]) {
    await assertRejects(
      () => withFake(s, () => run("delete-email", { emailIds: [id] })),
      Error,
      "Invalid emailId",
    );
  }
  assertEquals(s.ops("expunge").length, 0);
});

Deno.test("email ids cannot smuggle IMAP sequence sets", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  await s.add("INBOX");
  for (
    const id of [
      "INBOX:1:*",
      "INBOX:1,2",
      "INBOX:*",
      "INBOX:1e3",
      "INBOX:0x10",
      "INBOX: 1",
      "INBOX:4294967296",
      "INBOX:-1",
    ]
  ) {
    await assertRejects(
      () => withFake(s, () => run("delete-email", { emailIds: [id] })),
      Error,
      "Invalid emailId",
      id,
    );
  }
  assertEquals(s.boxes.get("INBOX")!.messages.size, 2, "nothing expunged");
});

Deno.test("search terms reach imapflow as structured values, not text", async () => {
  const s = FakeServer.standard();
  const evil = 'x" OR ALL\r\nA9 DELETE INBOX';
  await withFake(
    s,
    () => run("query-emails", { subject: evil, from: evil, text: evil }),
  );
  assertEquals(s.ops("search")[0][1], {
    subject: evil,
    from: evil,
    text: evil,
  });
});

// ── SMTP header injection ───────────────────────────────────────────────────

Deno.test("CR/LF in subject or display name never forges a header", async () => {
  const s = FakeServer.standard();
  await withFake(s, () =>
    run(
      "send-email",
      {
        to: ["bob@example.com"],
        subject: "hi\r\nBcc: evil@attacker.test",
        text: "x",
      },
      makeCtx({ ...GLOBAL_ARGS, fromName: "Me\r\nX-Evil: 1" }),
    ));
  const raw = s.sent[0].raw;
  const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
  assertFalse(/^Bcc:/im.test(head), head);
  assertFalse(/^X-Evil:/im.test(head), head);
  assertEquals(s.sent[0].envelope.to, ["bob@example.com"]);
});

Deno.test("a Message-ID with CR/LF or spaces is rejected before sending", async () => {
  const s = FakeServer.standard();
  for (
    const messageId of [
      "<a@b>\r\nBcc: evil@attacker.test",
      "a b@c",
      "<>",
      "<a@b>\0",
    ]
  ) {
    await assertRejects(
      () =>
        withFake(s, () =>
          run("send-email", {
            to: ["bob@example.com"],
            subject: "s",
            text: "t",
            messageId,
          })),
      Error,
      "Invalid messageId",
    );
  }
  assertEquals(s.sent.length, 0);
  assertEquals(s.sessions, 0, "no Sent lookup with a bad id");
});

Deno.test("reply to a hostile original does not forge headers", async () => {
  const s = FakeServer.standard();
  const uid = s.put(
    "INBOX",
    Buffer.from(
      "From: Mallory <mallory@attacker.test>\r\n" +
        "Subject: =?UTF-8?Q?hi=0D=0ABcc:_victim@example.com?=\r\n" +
        "Message-ID: <m1@attacker.test>\r\n\r\nbody\r\n",
    ),
  );
  await withFake(
    s,
    () => run("reply-email", { emailId: `INBOX:${uid}`, text: "no" }),
  );
  const raw = s.sent[0].raw;
  const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
  assertFalse(/^Bcc:/im.test(head), head);
  assertEquals(s.sent[0].envelope.to, ["mallory@attacker.test"]);
});

// ── Path traversal from server data ─────────────────────────────────────────

async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for await (const e of Deno.readDir(d)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory) await walk(`${d}/${e.name}`, r);
    }
  };
  await walk(dir, "");
  return out.sort();
}

Deno.test("hostile attachment file names stay inside outputDir", async () => {
  const names = [
    "../../escape.txt",
    "..",
    ".",
    "",
    "..\\..\\win.txt",
    "a\u0000b.txt",
    "/etc/passwd",
  ];
  const s = FakeServer.standard();
  const uid = await s.add("INBOX", {
    attachments: names.map((filename, i) => ({
      filename,
      content: `file-${i}`,
    })),
  });
  const root = await Deno.makeTempDir({ prefix: "yandex-mail-adv-" });
  try {
    const out = `${root}/a/b`;
    const c = makeCtx();
    await withFake(s, async () => {
      for (let index = 0; index < names.length; index++) {
        await run("get-attachment", {
          emailId: `INBOX:${uid}`,
          index,
          outputDir: out,
        }, c);
      }
    });
    const tree = await listTree(root);
    for (const t of tree) {
      assert(t === "a" || t === "a/b" || t.startsWith("a/b/"), t);
    }
    for (const w of c.written) {
      const name = w.payload.filename as string;
      assertFalse(name.includes("/") || name.includes("\\"), name);
      assertFalse(/^\.+$/.test(name) || name === "", name);
      assertFalse(name.includes("\0"), name);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("hostile folder names from LIST stay inside the Maildir root", async () => {
  const s = new FakeServer();
  for (const p of ["..", "../../up", "a/../../b", ".hidden", "C:\\x"]) {
    s.addBox(p);
    await s.add(p);
  }
  const root = await Deno.makeTempDir({ prefix: "yandex-mail-adv-" });
  try {
    const out = `${root}/maildir`;
    await withFake(s, () => run("archive-mailbox", { outputDir: out }));
    const tree = await listTree(root);
    for (const t of tree) {
      assert(t === "maildir" || t.startsWith("maildir/"), t);
    }
    const top = (await Array.fromAsync(Deno.readDir(out))).map((e) => e.name);
    assertEquals(top.length, 5, top.join(","));
    for (const n of top) assertFalse(n === "." || n === "..", n);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── Spec-violating server replies ───────────────────────────────────────────

Deno.test("a FETCH with no body is 'not found', not a crash", async () => {
  const s = FakeServer.standard();
  const uid = await s.add("INBOX");
  await withFake(s, async () => {
    // Delete behind the model's back: fetchOne answers `false`.
    s.boxes.get("INBOX")!.messages.delete(uid);
    await assertRejects(
      () => run("get-email", { emailId: `INBOX:${uid}` }),
      Error,
      "not found",
    );
  });
});

Deno.test("a garbage Date header does not abort query-emails", async () => {
  const s = FakeServer.standard();
  s.put(
    "INBOX",
    Buffer.from(
      "From: a@b.c\r\nDate: not a date at all\r\nSubject: s\r\n\r\nx",
    ),
  );
  const c = makeCtx();
  await withFake(s, () => run("query-emails", {}, c));
  const [m] = c.written[0].payload.emails as { date: string }[];
  // Falls back to INTERNALDATE.
  assertEquals(m.date, "2026-10-01T10:00:00.000Z");
});

Deno.test("a move without UIDPLUS reports an empty new id", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  const c = makeCtx();
  s.noUidPlus = true;
  await withFake(s, async () => {
    await run("archive-email", { emailIds: ["INBOX:1"] }, c);
    await s.add("INBOX");
    await run("set-email", { emailId: "INBOX:2", moveTo: "Trash" }, c);
  });
  assertEquals(
    (c.written[0].payload.emails as { newId: string }[])[0].newId,
    "",
  );
  assertEquals((c.written[1].payload.email as { newId: string }).newId, "");
  assertEquals(s.boxes.get("Archive")!.messages.size, 1);
});

// ── Credentials ─────────────────────────────────────────────────────────────

Deno.test("the app password never reaches stored data or logs", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX", { subject: "hello" });
  const c = makeCtx();
  const dir = await Deno.makeTempDir({ prefix: "yandex-mail-adv-" });
  try {
    await withFake(s, async () => {
      await run("get-account-summary", {}, c);
      await run("list-mailboxes", {}, c);
      await run("query-emails", {}, c);
      await run("get-email", { emailId: "INBOX:1" }, c);
      await run("send-email", { to: ["a@b.c"], subject: "s", text: "t" }, c);
      await run("archive-mailbox", { outputDir: dir }, c);
    });
    const blob = JSON.stringify([c.written, c.logs]);
    assertFalse(blob.includes(SECRET));
    for (const m of s.sent) assertFalse(m.raw.includes(SECRET));
    assertEquals(sentHeader(s.sent[0].raw, "From"), "me@yandex.ru");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a server or library echoing the password is redacted", async () => {
  const s = FakeServer.standard();
  s.connectError = imapErr("Authentication failed", {
    responseText: `LOGIN me@yandex.ru ${SECRET} rejected`,
  });
  const e = await assertRejects(
    () => withFake(s, () => run("list-mailboxes", {})),
    Error,
  );
  assertFalse(e.message.includes(SECRET), e.message);
  assert(e.message.includes("***"));

  const s2 = FakeServer.standard();
  s2.fail.list = imapErr("Command failed", {
    responseText: `bad ${SECRET}`,
    executedCommand: `A3 LIST "" "*" ${SECRET}`,
  });
  const e2 = await assertRejects(
    () => withFake(s2, () => run("list-mailboxes", {})),
    Error,
  );
  assertFalse(e2.message.includes(SECRET), e2.message);

  const s3 = FakeServer.standard();
  s3.smtpError = new Error(`535 auth failed for ${SECRET}`);
  const e3 = await assertRejects(
    () =>
      withFake(
        s3,
        () => run("send-email", { to: ["a@b.c"], subject: "s", text: "t" }),
      ),
    Error,
  );
  assertFalse(e3.message.includes(SECRET), e3.message);
});

Deno.test("credentials are declared sensitive in the global schema", () => {
  const shape = model.globalArguments.shape;
  for (const k of ["appPassword", "oauthToken"] as const) {
    const meta = shape[k].unwrap().meta() as
      | { sensitive?: boolean }
      | undefined;
    assertEquals(meta?.sensitive, true, k);
  }
});
