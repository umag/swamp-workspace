import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import {
  buildSearchQuery,
  decodeEmailId,
  encodeEmailId,
  findSpecialUse,
  groupByMailbox,
  newestUids,
  prefixSubject,
  quoteText,
  replyRecipients,
  replyReferences,
} from "./yandex_mail_lib.ts";

Deno.test("email id round-trips, including colons in the mailbox", () => {
  for (const [box, uid] of [["INBOX", 1], ["a:b|c", 42]] as const) {
    assertEquals(decodeEmailId(encodeEmailId(box, uid)), { mailbox: box, uid });
  }
});

Deno.test("malformed email ids are rejected", () => {
  for (const bad of ["INBOX", ":5", "INBOX:", "INBOX:0", "INBOX:x", "I:1.5"]) {
    assertThrows(() => decodeEmailId(bad));
  }
});

Deno.test("groupByMailbox groups and dedupes", () => {
  const g = groupByMailbox(["INBOX:1", "Sent:2", "INBOX:3", "INBOX:1"]);
  assertEquals([...g.entries()], [["INBOX", [1, 3]], ["Sent", [2]]]);
});

Deno.test("search query maps filters; empty means all", () => {
  assertEquals(buildSearchQuery({}), { all: true });
  const q = buildSearchQuery({
    after: "2026-01-02",
    from: "a@b.c",
    unseen: true,
    flagged: false,
  });
  assertEquals(q.since, new Date("2026-01-02"));
  assertEquals(q.from, "a@b.c");
  assertEquals(q.seen, false);
  assertEquals(q.flagged, false);
  assertThrows(() => buildSearchQuery({ before: "not a date" }));
});

Deno.test("newestUids keeps the highest UIDs", () => {
  assertEquals(newestUids([3, 10, 1, 7], 2), [10, 7]);
  assertEquals(newestUids([1], 0), []);
});

Deno.test("subject prefixes are applied once", () => {
  assertEquals(prefixSubject("Hi", "Re"), "Re: Hi");
  assertEquals(prefixSubject("RE: Hi", "Re"), "RE: Hi");
  assertEquals(prefixSubject("Fw: Hi", "Fwd"), "Fw: Hi");
  assertEquals(prefixSubject("Hi", "Fwd"), "Fwd: Hi");
});

Deno.test("reply goes to Reply-To; reply-all excludes self and dupes", () => {
  const orig = {
    from: { name: "Ann", address: "ann@x.ru" },
    replyTo: [{ address: "list@x.ru" }],
    to: [{ address: "ME@yandex.ru" }, { address: "bob@x.ru" }],
    cc: [{ address: "list@x.ru" }, { address: "cat@x.ru" }],
  };
  assertEquals(replyRecipients(orig, "me@yandex.ru", false), {
    to: ["list@x.ru"],
    cc: [],
  });
  assertEquals(replyRecipients(orig, "me@yandex.ru", true), {
    to: ["list@x.ru"],
    cc: ["bob@x.ru", "cat@x.ru"],
  });
  assertEquals(
    replyRecipients({ from: orig.from }, "me@yandex.ru", false).to,
    ["Ann <ann@x.ru>"],
  );
});

Deno.test("references chain appends the parent once", () => {
  assertEquals(replyReferences("<c>", "<a> <b>"), ["<a>", "<b>", "<c>"]);
  assertEquals(replyReferences("<b>", ["<a>", "<b>"]), ["<a>", "<b>"]);
  assertEquals(replyReferences(undefined, undefined), []);
});

Deno.test("quoteText prefixes every line", () => {
  assertEquals(
    quoteText("a\r\nb", "Ann", "Mon"),
    "On Mon, Ann wrote:\n> a\n> b",
  );
});

Deno.test("special-use lookup prefers attributes, falls back to names", () => {
  const boxes = [
    { path: "INBOX" },
    { path: "Отправленные", specialUse: "\\Sent" },
    { path: "Spam" },
    { path: "Trash", flags: new Set(["\\Trash"]) },
  ];
  assertEquals(findSpecialUse(boxes, "\\Sent"), "Отправленные");
  assertEquals(findSpecialUse(boxes, "\\Trash"), "Trash");
  assertEquals(findSpecialUse(boxes, "\\Junk"), "Spam");
  assertEquals(findSpecialUse(boxes, "\\Archive"), undefined);
});

import {
  archivedUids,
  mailboxDirName,
  maildirInfo,
  maildirName,
  parseMaildirName,
} from "./yandex_mail_lib.ts";

Deno.test("maildir flags are mapped and sorted", () => {
  assertEquals(maildirInfo(["\\Seen", "\\Flagged", "$NotJunk"]), "2,FS");
  assertEquals(maildirInfo([]), "2,");
});

Deno.test("maildir names round-trip and ignore foreign files", () => {
  const n = maildirName("1700000000", 42, new Set(["\\Seen"]));
  assertEquals(n, "1700000000-42:2,S");
  assertEquals(parseMaildirName(n), { uidValidity: "1700000000", uid: 42 });
  assertEquals(parseMaildirName(".DS_Store"), null);
});

Deno.test("archived UIDs are scoped to the UIDVALIDITY", () => {
  const names = ["5-10:2,S", "5-7:2,", "6-99:2,", "junk"];
  assertEquals([...archivedUids(names, "5")].sort(), [10, 7].sort());
  assertEquals([...archivedUids(names, "6")], [99]);
  assertEquals(archivedUids(names, "7").size, 0);
});

Deno.test("mailbox dir names are flat and filesystem-safe", () => {
  assertEquals(mailboxDirName("INBOX"), "INBOX");
  assertEquals(mailboxDirName("Работа|Отчёты"), "Работа.Отчёты");
  assertEquals(mailboxDirName("a/b:c", "|"), "a_b_c");
  assertEquals(mailboxDirName(".."), "__");
});

import {
  appleMailboxUrl,
  appleMailFlags,
  emlxRowId,
  parseEmlx,
} from "./yandex_mail_lib.ts";

Deno.test("emlx body is cut by its length line", () => {
  const raw = new TextEncoder().encode("5     \nHELLO<?xml plist?>");
  assertEquals(new TextDecoder().decode(parseEmlx(raw)), "HELLO");
  assertThrows(() => parseEmlx(new TextEncoder().encode("99\nshort")));
  assertThrows(() => parseEmlx(new TextEncoder().encode("Subject: x\n")));
});

Deno.test("apple mail flags and urls", () => {
  assertEquals(appleMailFlags(1 | 4 | 16 | 2), [
    "\\Seen",
    "\\Answered",
    "\\Flagged",
  ]);
  assertEquals(
    appleMailboxUrl("ACC", "офд и еда"),
    "imap://ACC/%D0%BE%D1%84%D0%B4%20%D0%B8%20%D0%B5%D0%B4%D0%B0",
  );
  assertEquals(appleMailboxUrl("ACC", "A|B"), "imap://ACC/A/B");
});

Deno.test("emlx file names map to rowids", () => {
  assertEquals(emlxRowId("49512.partial.emlx"), {
    rowId: 49512,
    partial: true,
  });
  assertEquals(emlxRowId("7.emlx"), { rowId: 7, partial: false });
  assertEquals(emlxRowId("Info.plist"), null);
});
