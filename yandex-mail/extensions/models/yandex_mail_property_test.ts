/**
 * Property suite for @magistr/yandex-mail (fast-check, FC_NUM_RUNS knob).
 *
 *  (a) email ids round-trip for every legal mailbox/UID, and no non-digit
 *      UID text is ever accepted (no sequence-set smuggling).
 *  (b) safeFilename / mailboxDirName never produce a path separator, a
 *      control character or a dot-only name, for any input.
 *  (c) normalizeMessageId is idempotent and always bracketed.
 *  (d) Maildir names round-trip through parseMaildirName.
 *  (e) flow: archive-mailbox run repeatedly under any per-run budget ends
 *      with every deliverable message on disk exactly once, and exactly the
 *      undeliverable UIDs in unavailable.json.
 *  (f) flow: bulk move conserves messages and reports a valid new id for
 *      every moved message.
 *  (g) flow: send-email with a messageId and saveToSent is idempotent —
 *      a retry never sends twice.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import { Buffer } from "node:buffer";
import fc from "npm:fast-check@4.8.0";
import { model, normalizeMessageId, safeFilename } from "./yandex_mail.ts";
import {
  decodeEmailId,
  encodeEmailId,
  mailboxDirName,
  maildirName,
  parseMaildirName,
} from "./yandex_mail_lib.ts";
import { FakeServer, makeCtx, withFake } from "./yandex_mail_harness_test.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");
// Disk-backed flows are ~10x costlier per run than the pure properties.
const flowRuns = Math.max(5, Math.floor(numRuns / 10));

const LINE_BREAK = /[\r\n\0]/;

const mailbox = fc.string({ minLength: 1, maxLength: 20 }).filter((s) =>
  !LINE_BREAK.test(s)
);
const uid = fc.integer({ min: 1, max: 0xffffffff });

Deno.test("property: email ids round-trip", () => {
  fc.assert(
    fc.property(mailbox, uid, (m, u) => {
      assertEquals(decodeEmailId(encodeEmailId(m, u)), { mailbox: m, uid: u });
    }),
    { numRuns },
  );
});

Deno.test("property: non-digit UID text is always rejected", () => {
  fc.assert(
    fc.property(
      mailbox,
      fc.string({ minLength: 1, maxLength: 12 }).filter((s) =>
        !/^\d+$/.test(s) && !s.includes(":")
      ),
      (m, tail) => {
        assertThrows(() => decodeEmailId(`${m}:${tail}`));
      },
    ),
    { numRuns },
  );
});

Deno.test("property: safeFilename output is always a safe single segment", () => {
  fc.assert(
    fc.property(fc.option(fc.string({ maxLength: 40 })), fc.nat(99), (n, i) => {
      const out = safeFilename(n ?? undefined, i);
      assert(out.length > 0);
      // deno-lint-ignore no-control-regex -- no control chars in output
      assert(!/[/\\\x00-\x1f\x7f]/.test(out), out);
      assert(!/^\.+$/.test(out), out);
    }),
    { numRuns },
  );
});

Deno.test("property: mailboxDirName is one safe directory name", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 30 }),
      fc.constantFrom("|", "/", "."),
      (p, d) => {
        const out = mailboxDirName(p, d);
        assert(out.length > 0);
        assert(!out.includes("/") && !out.includes("\\"), out);
        assert(out !== "." && out !== "..", out);
        // deno-lint-ignore no-control-regex -- no control chars in output
        assert(!/[\x00-\x1f]/.test(out), out);
      },
    ),
    { numRuns },
  );
});

Deno.test("property: normalizeMessageId is idempotent and bracketed", () => {
  const token = fc.stringMatching(/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~@-]{1,30}$/);
  fc.assert(
    fc.property(token, fc.boolean(), fc.boolean(), (t, lt, gt) => {
      const once = normalizeMessageId(`${lt ? "<" : ""}${t}${gt ? ">" : ""}`);
      assert(once.startsWith("<") && once.endsWith(">"));
      assertEquals(normalizeMessageId(once), once);
    }),
    { numRuns },
  );
});

Deno.test("property: ids with whitespace or control chars are rejected", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 10 }),
      fc.constantFrom(" ", "\t", "\r", "\n", "\0", "\x7f"),
      fc.string({ maxLength: 10 }),
      (a, bad, b) => {
        assertThrows(() => normalizeMessageId(`${a}${bad}${b}`));
      },
    ),
    { numRuns },
  );
});

Deno.test("property: Maildir names round-trip", () => {
  const flag = fc.constantFrom(
    "\\Seen",
    "\\Flagged",
    "\\Answered",
    "\\Draft",
    "\\Deleted",
    "$Custom",
  );
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 0xffffffff }),
      uid,
      fc.array(flag, { maxLength: 6 }),
      (v, u, flags) => {
        assertEquals(parseMaildirName(maildirName(String(v), u, flags)), {
          uidValidity: String(v),
          uid: u,
        });
      },
    ),
    { numRuns },
  );
});

Deno.test("flow: archiving under any budget converges to the server state", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 8 }),
      fc.integer({ min: 0, max: 5 }),
      fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      fc.integer({ min: 1, max: 3 }),
      async (nA, nB, refusedMask, budget) => {
        const s = new FakeServer();
        s.addBox("A");
        s.addBox("B");
        for (let i = 0; i < nA; i++) {
          s.put("A", Buffer.from(`Subject: a${i}\r\n\r\nx`));
        }
        for (let i = 0; i < nB; i++) {
          s.put("B", Buffer.from(`Subject: b${i}\r\n\r\nx`));
        }
        const refused = new Set<number>();
        for (let u = 1; u <= nA; u++) if (refusedMask[u - 1]) refused.add(u);
        s.boxes.get("A")!.unavailable = refused;
        const dir = await Deno.makeTempDir({ prefix: "yandex-mail-prop-" });
        try {
          await withFake(s, async () => {
            for (let i = 0; i < 40; i++) {
              const c = makeCtx();
              await model.methods["archive-mailbox"].execute(
                { outputDir: dir, maxMessages: budget },
                c.ctx as never,
              );
              if (c.written[0].payload.complete) break;
            }
          });
          const names = async (box: string) =>
            (await Array.fromAsync(Deno.readDir(`${dir}/${box}/cur`)))
              .map((e) => parseMaildirName(e.name)!.uid).sort((x, y) => x - y);
          const expectA = [...Array(nA).keys()].map((i) => i + 1)
            .filter((u) => !refused.has(u));
          assertEquals(await names("A"), expectA);
          assertEquals(
            await names("B"),
            [...Array(nB).keys()].map((i) => i + 1),
          );
          const un = JSON.parse(
            await Deno.readTextFile(`${dir}/A/unavailable.json`),
          );
          assertEquals(un.uids, [...refused].sort((x, y) => x - y));
        } finally {
          await Deno.remove(dir, { recursive: true });
        }
      },
    ),
    { numRuns: flowRuns },
  );
});

Deno.test("flow: bulk move conserves messages and maps every id", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 10 }),
      fc.array(fc.integer({ min: 1, max: 10 }), { maxLength: 12 }),
      async (n, pick) => {
        const s = FakeServer.standard();
        for (let i = 0; i < n; i++) {
          s.put("INBOX", Buffer.from(`Subject: m${i}\r\n\r\n`));
        }
        const ids = pick.filter((u) => u <= n).map((u) => `INBOX:${u}`);
        const c = makeCtx();
        await withFake(
          s,
          () =>
            model.methods["bulk-email-action"].execute(
              { emailIds: ids, action: "move", mailbox: "Archive" },
              c.ctx as never,
            ),
        );
        const moved = new Set(ids);
        const inbox = s.boxes.get("INBOX")!.messages;
        const archive = s.boxes.get("Archive")!.messages;
        assertEquals(inbox.size + archive.size, n);
        assertEquals(archive.size, moved.size);
        const res = c.written[0].payload.emails as {
          id: string;
          newId: string;
        }[];
        assertEquals(res.length, moved.size);
        for (const r of res) {
          const { mailbox: box, uid: nu } = decodeEmailId(r.newId);
          assertEquals(box, "Archive");
          const src = Number(r.id.split(":")[1]);
          const text = new TextDecoder().decode(archive.get(nu)!.source);
          assert(text.startsWith(`Subject: m${src - 1}\r\n`), text);
        }
      },
    ),
    { numRuns: flowRuns },
  );
});

Deno.test("flow: send-email with messageId never sends twice", async () => {
  const token = fc.stringMatching(/^[a-z0-9]{1,16}$/);
  await fc.assert(
    fc.asyncProperty(token, fc.integer({ min: 2, max: 4 }), async (id, n) => {
      const s = FakeServer.standard();
      await withFake(s, async () => {
        for (let i = 0; i < n; i++) {
          await model.methods["send-email"].execute({
            to: ["bob@example.com"],
            subject: "s",
            text: "t",
            messageId: `${id}@yandex.ru`,
            saveToSent: true,
          }, makeCtx().ctx as never);
        }
      });
      assertEquals(s.sent.length, 1);
      assertEquals(s.boxes.get("Sent")!.messages.size, 1);
    }),
    { numRuns: flowRuns },
  );
});
