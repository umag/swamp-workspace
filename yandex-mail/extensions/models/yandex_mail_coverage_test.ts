/**
 * Coverage suite for @magistr/yandex-mail: one test per guard or fix, so
 * deleting the guard turns a test red.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { Buffer } from "node:buffer";
import {
  model,
  normalizeMessageId,
  safeFilename,
  slug,
} from "./yandex_mail.ts";
import { decodeEmailId, mailboxDirName } from "./yandex_mail_lib.ts";
import {
  FakeServer,
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

async function tmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "yandex-mail-cov-" });
}

// ── Pure guards ─────────────────────────────────────────────────────────────

Deno.test("slug keeps ASCII ids readable", () => {
  assertEquals(slug("INBOX:5"), "INBOX-5");
  assertEquals(slug("A|B:7"), "A-B-7");
  assertEquals(slug(":::"), "x");
});

Deno.test("slug disambiguates non-ASCII mailboxes (collision fix)", () => {
  const a = slug("Работа:5");
  const b = slug("Личное:5");
  assertNotEquals(a, b);
  assert(a.startsWith("5-"), a);
  assertEquals(slug("Работа:5"), a, "deterministic");
});

Deno.test("get-email on two Cyrillic folders writes two resources", async () => {
  const s = FakeServer.standard();
  s.addBox("Работа");
  s.addBox("Личное");
  await s.add("Работа");
  await s.add("Личное");
  const c = makeCtx();
  await withFake(s, async () => {
    await run("get-email", { emailId: "Работа:1" }, c);
    await run("get-email", { emailId: "Личное:1" }, c);
  });
  assertNotEquals(c.written[0].name, c.written[1].name);
});

Deno.test("normalizeMessageId adds or keeps angle brackets once", () => {
  assertEquals(normalizeMessageId("a@b"), "<a@b>");
  assertEquals(normalizeMessageId("<a@b>"), "<a@b>");
  // Previously a trailing ">" alone produced "<a@b>>".
  assertEquals(normalizeMessageId("a@b>"), "<a@b>");
  assertEquals(normalizeMessageId("<a@b"), "<a@b>");
  assertThrows(() => normalizeMessageId(""), Error, "Invalid messageId");
});

Deno.test("safeFilename replaces separators and dot-only names", () => {
  assertEquals(safeFilename("a/b\\c.txt", 0), "a_b_c.txt");
  assertEquals(safeFilename("..", 3), "attachment-3");
  assertEquals(safeFilename("...", 3), "attachment-3");
  assertEquals(safeFilename("  ", 1), "attachment-1");
  assertEquals(safeFilename(undefined, 2), "attachment-2");
  assertEquals(safeFilename("a\tb", 0), "a_b");
  assertEquals(safeFilename(".bashrc", 0), ".bashrc");
});

Deno.test("decodeEmailId accepts the largest 32-bit UID and no more", () => {
  assertEquals(decodeEmailId("INBOX:4294967295").uid, 4294967295);
  assertThrows(() => decodeEmailId("INBOX:4294967296"));
  // Last colon splits, so a folder named with a colon round-trips.
  assertEquals(decodeEmailId("A:B:3"), { mailbox: "A:B", uid: 3 });
});

Deno.test("mailboxDirName honours the server's delimiter", () => {
  assertEquals(mailboxDirName("A/B", "/"), "A.B");
  assertEquals(mailboxDirName("A|B"), "A.B");
  assertEquals(mailboxDirName("A.B"), "A_B");
});

// ── Credentials / globals ───────────────────────────────────────────────────

Deno.test("an OAuth token alone satisfies the credential guard", async () => {
  const s = FakeServer.standard();
  await withFake(
    s,
    () =>
      run("list-mailboxes", {}, makeCtx({ username: "me", oauthToken: "t" })),
  );
  assertEquals(s.sessions, 1);
});

Deno.test("a bare login is completed with @yandex.ru", async () => {
  const s = FakeServer.standard();
  const c = makeCtx({ username: "ivan", appPassword: SECRET });
  await withFake(s, () => run("get-account-summary", {}, c));
  assertEquals(c.written[0].payload.account, "ivan@yandex.ru");
});

// ── Mailbox guards ──────────────────────────────────────────────────────────

Deno.test("delete-mailbox refuses inbox in any case", async () => {
  const s = new FakeServer();
  s.addBox("inbox");
  await assertRejects(
    () => withFake(s, () => run("delete-mailbox", { path: "inbox" })),
    Error,
    "Refusing",
  );
});

Deno.test("rename-mailbox renames when both exist (not 'already renamed')", async () => {
  const s = FakeServer.standard();
  s.addBox("A");
  s.addBox("B");
  await withFake(s, () => run("rename-mailbox", { path: "A", newPath: "B" }));
  assertEquals(s.ops("rename").length, 1);
});

// ── Reading guards ──────────────────────────────────────────────────────────

Deno.test("query-emails with no hits makes no FETCH", async () => {
  const s = FakeServer.standard();
  const c = makeCtx();
  await withFake(s, () => run("query-emails", {}, c));
  assertEquals(s.ops("fetch").length, 0);
  assertEquals(c.written[0].payload.count, 0);
});

Deno.test("get-email markRead skips STORE when already \\Seen", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX", {}, ["\\Seen"]);
  await withFake(
    s,
    () => run("get-email", { emailId: "INBOX:1", markRead: true }),
  );
  assertEquals(s.ops("flagsAdd").length, 0);
});

Deno.test("get-email never sets \\Seen unless markRead", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  await withFake(s, () => run("get-email", { emailId: "INBOX:1" }));
  assertEquals(s.ops("flagsAdd").length, 0);
  assertEquals(s.boxes.get("INBOX")!.messages.get(1)!.flags.size, 0);
});

Deno.test("get-email truncates bodies at maxBodyChars", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX", { text: "x".repeat(500) });
  const c = makeCtx();
  await withFake(
    s,
    () => run("get-email", { emailId: "INBOX:1", maxBodyChars: 10 }, c),
  );
  const text = (c.written[0].payload.email as { text: string }).text;
  assertEquals(text, `${"x".repeat(10)}\n…[truncated]`);
});

Deno.test("get-thread with explicit mailboxes needs no Sent folder", async () => {
  const s = new FakeServer();
  s.addBox("INBOX");
  await s.add("INBOX", { messageId: "<a@b>" });
  const c = makeCtx();
  await withFake(
    s,
    () => run("get-thread", { emailId: "INBOX:1", mailboxes: ["INBOX"] }, c),
  );
  assertEquals(c.written[0].payload.count, 1);
});

Deno.test("query-emails summary date is '' when no date exists", async () => {
  const s = FakeServer.standard();
  s.put("INBOX", Buffer.from("Subject: s\r\n\r\nx"));
  s.boxes.get("INBOX")!.messages.get(1)!.internalDate = new Date("bogus");
  const c = makeCtx();
  await withFake(s, () => run("query-emails", {}, c));
  assertEquals((c.written[0].payload.emails as { date: string }[])[0].date, "");
});

// ── Sending guards ──────────────────────────────────────────────────────────

Deno.test("reply quoting tolerates an original with no From (crash fix)", async () => {
  const s = FakeServer.standard();
  s.put(
    "INBOX",
    Buffer.from(
      "Reply-To: list@example.com\r\nSubject: s\r\n\r\noriginal text\r\n",
    ),
  );
  await withFake(
    s,
    () => run("reply-email", { emailId: "INBOX:1", text: "ok" }),
  );
  assertStringIncludes(s.sent[0].raw, "Unknown sender wrote:");
  assertStringIncludes(s.sent[0].raw, "> original text");
});

Deno.test("reply quote: false sends only the new text", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX", { text: "secret original" });
  await withFake(
    s,
    () => run("reply-email", { emailId: "INBOX:1", text: "ok", quote: false }),
  );
  assert(!s.sent[0].raw.includes("secret original"));
});

Deno.test("subjects are prefixed once (Re:/Fwd:)", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX", { subject: "Re: topic" });
  await s.add("INBOX", { subject: "Fwd: topic" });
  await withFake(s, async () => {
    await run("reply-email", { emailId: "INBOX:1", text: "x" });
    await run("forward-email", { emailId: "INBOX:2", to: ["a@b.c"] });
  });
  assertEquals(sentHeader(s.sent[0].raw, "Subject"), "Re: topic");
  assertEquals(sentHeader(s.sent[1].raw, "Subject"), "Fwd: topic");
});

Deno.test("create-draft fails when the server returns no UID", async () => {
  const s = FakeServer.standard();
  s.noAppendUid = true;
  await assertRejects(
    () =>
      withFake(
        s,
        () => run("create-draft", { to: ["a@b.c"], subject: "s", text: "t" }),
      ),
    Error,
    "Server did not return a UID",
  );
});

Deno.test("send-draft carries References forward", async () => {
  const s = FakeServer.standard();
  await s.add("Drafts", {
    to: "bob@example.com",
    inReplyTo: "<p@x>",
    references: ["<r@x>", "<p@x>"],
  });
  await withFake(s, () => run("send-draft", { emailId: "Drafts:1" }));
  assertEquals(sentHeader(s.sent[0].raw, "References"), "<r@x> <p@x>");
  assertEquals(sentHeader(s.sent[0].raw, "In-Reply-To"), "<p@x>");
});

// ── Organising guards ───────────────────────────────────────────────────────

Deno.test("set-email moveTo the same mailbox is not a MOVE", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  const c = makeCtx();
  await withFake(
    s,
    () => run("set-email", { emailId: "INBOX:1", moveTo: "INBOX" }, c),
  );
  assertEquals(s.ops("move").length, 0);
  assertEquals(
    (c.written[0].payload.email as { newId: string }).newId,
    "INBOX:1",
  );
});

Deno.test("bulk ops dedupe ids and lock each mailbox once", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  await s.add("INBOX");
  const c = makeCtx();
  await withFake(s, () =>
    run("bulk-email-action", {
      emailIds: ["INBOX:1", "INBOX:2", "INBOX:1"],
      action: "flag",
    }, c));
  assertEquals(s.ops("flagsAdd")[0][1], "1,2");
  assertEquals(c.written[0].payload.count, 2);
});

Deno.test("bulk with no ids writes an empty result", async () => {
  const s = FakeServer.standard();
  const c = makeCtx();
  await withFake(
    s,
    () => run("delete-email", { emailIds: [] }, c),
  );
  assertEquals(c.written[0].payload.emails, []);
});

// ── Archive guards ──────────────────────────────────────────────────────────

Deno.test("maxMessages counts this run's attempts only (budget fix)", async () => {
  const s = new FakeServer();
  s.addBox("A");
  s.addBox("B");
  await s.add("A");
  await s.add("A");
  s.boxes.get("A")!.unavailable = new Set([1, 2]);
  const dir = await tmp();
  try {
    await withFake(s, async () => {
      await run("archive-mailbox", { outputDir: dir, mailboxes: ["A"] });
      await s.add("A");
      await s.add("B");
      await s.add("B");
      const c = makeCtx();
      await run("archive-mailbox", {
        outputDir: dir,
        mailboxes: ["A", "B"],
        maxMessages: 2,
      }, c);
      const [fa, fb] = c.written[0].payload.folders as Record<
        string,
        number
      >[];
      // A: UIDs 1,2 are known-unavailable and skipped; UID 3 is one attempt.
      assertEquals([fa.archived, fa.unavailable], [1, 2]);
      // The second attempt of the budget goes to B.
      assertEquals([fb.archived, fb.remaining], [1, 1]);
      assertEquals(c.written[0].payload.complete, false);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("retryUnavailable fetches recorded UIDs again", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  s.boxes.get("INBOX")!.unavailable.add(1);
  const dir = await tmp();
  try {
    const c = makeCtx();
    await withFake(s, async () => {
      await run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }, c);
      s.boxes.get("INBOX")!.unavailable.clear();
      await run("archive-mailbox", {
        outputDir: dir,
        mailboxes: ["INBOX"],
        retryUnavailable: true,
      }, c);
    });
    assertEquals(c.written[1].payload.archived, 1);
    assertEquals(c.written[1].payload.unavailable, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a UIDVALIDITY change re-archives under the new epoch", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  const dir = await tmp();
  try {
    const c = makeCtx();
    await withFake(s, async () => {
      await run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }, c);
      s.boxes.get("INBOX")!.uidValidity = 1800000000n;
      await run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }, c);
    });
    assertEquals(c.written[1].payload.archived, 1);
    const names = (await Array.fromAsync(Deno.readDir(`${dir}/INBOX/cur`)))
      .map((e) => e.name).sort();
    assertEquals(names, ["1700000000-1:2,", "1800000000-1:2,"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive-mailbox honours exclude and skips \\Noselect", async () => {
  const s = FakeServer.standard();
  s.addBox("Parent", { noselect: true });
  const dir = await tmp();
  try {
    const c = makeCtx();
    await withFake(
      s,
      () =>
        run(
          "archive-mailbox",
          { outputDir: dir, exclude: ["Spam", "Trash"] },
          c,
        ),
    );
    const boxes = (c.written[0].payload.folders as { mailbox: string }[])
      .map((f) => f.mailbox);
    assertEquals(boxes, ["INBOX", "Sent", "Drafts", "Archive"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a non-drop error is not retried", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  s.fail.search = imapErr("Command failed", { responseText: "[SERVERBUG]" });
  const dir = await tmp();
  try {
    await assertRejects(
      () =>
        withFake(
          s,
          () =>
            run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }),
        ),
      Error,
      "SERVERBUG",
    );
    // One session to list folders, one archive attempt.
    assertEquals(s.sessions, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reconnects stop after 50 attempts", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  s.fail.search = Array.from(
    { length: 60 },
    () => imapErr("Connection not available"),
  );
  const dir = await tmp();
  try {
    await assertRejects(
      () =>
        withFake(
          s,
          () =>
            run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }),
        ),
      Error,
      "Connection not available",
    );
    assertEquals(s.sessions, 1 + 50);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a FETCH that fails with BAD (not NO) is fatal", async () => {
  const s = FakeServer.standard();
  await s.add("INBOX");
  s.fail.fetch = imapErr("Command failed", {
    responseStatus: "BAD",
    responseText: "parse error",
  });
  const dir = await tmp();
  try {
    await assertRejects(
      () =>
        withFake(
          s,
          () =>
            run("archive-mailbox", { outputDir: dir, mailboxes: ["INBOX"] }),
        ),
      Error,
      "parse error",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
