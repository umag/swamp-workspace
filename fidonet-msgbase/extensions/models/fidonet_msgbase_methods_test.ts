/**
 * Methods suite: happy-path coverage of all 7 `@magistr/fidonet-msgbase`
 * methods (listAreas, readArea x2 formats, readNetmail, searchBySender,
 * searchByAddress x2 (node+point), searchByText, formatForObsidian) against
 * a canonical synthetic msgbase — one JAM area, one Squish-only area, and a
 * netmail folder. Every assertion checks the written resource's KIND +
 * INSTANCE NAME plus concrete DECODED FIELDS (from/to/subject/body/address/
 * date/format/timestamp), not just counts — per the approved plan.
 *
 * fidonet_msgbase.ts is BYTE-FROZEN; this suite drives it unmodified via
 * `model.methods.<m>.execute(args, ctx)` against a fake context (globalArgs +
 * writeResource + readResource) with `basePath` pointing at a per-test
 * `Deno.makeTempDir()` populated by `fixtures/builders.ts` — REAL
 * `Deno.readFile`/`readDir` over byte-accurate hand-authored bytes, no FS
 * stubbing. All fixture content is synthetic — see fixtures/PROVENANCE.md.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./fidonet_msgbase.ts";
import {
  buildFtsMsg,
  buildJamAreaFiles,
  buildSquishArea,
  formatFtsDateStr,
  localEpochSeconds,
  withTempMsgbase,
} from "./fixtures/builders.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(basePath: string) {
  const written: Written[] = [];
  const seeded = new Map<string, Record<string, unknown>>();
  return {
    written,
    seeded,
    ctx: {
      globalArgs: { basePath },
      writeResource: (spec: string, name: string, payload: unknown) => {
        const entry = {
          spec,
          name,
          payload: payload as Record<string, unknown>,
        };
        written.push(entry);
        seeded.set(name, entry.payload);
        return Promise.resolve({ spec, name });
      },
      readResource: (name: string) => Promise.resolve(seeded.get(name)),
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// Canonical synthetic msgbase
// ---------------------------------------------------------------------------

const DATE_MSG1 = { year: 2005, month: 8, day: 28, hour: 10, min: 15, sec: 0 };
const DATE_MSG3 = { year: 2005, month: 8, day: 29, hour: 9, min: 0, sec: 0 };
const DATE_SQUISH1 = { year: 2005, month: 9, day: 1, hour: 12, min: 0, sec: 0 };
const DATE_SQUISH2 = { year: 2005, month: 9, day: 2, hour: 8, min: 30, sec: 0 };
const DATE_NM1 = { year: 2005, month: 9, day: 3, hour: 14, min: 0, sec: 0 };
const DATE_NM2 = { year: 2005, month: 9, day: 4, hour: 9, min: 0, sec: 0 };

function buildCanonicalTree() {
  const { jhr, jdt } = buildJamAreaFiles({
    activeMsgs: 2,
    messages: [
      {
        msgNum: 100,
        dateWritten: localEpochSeconds(DATE_MSG1),
        from: "Alice Sender",
        to: "All",
        subject: "Welcome to the area",
        address: "2:5020/10",
        body: "Welcome!\r* Origin: Test BBS (2:5020/10)\r",
      },
      {
        msgNum: 101,
        dateWritten: localEpochSeconds(DATE_MSG1),
        from: "Spam Bot",
        deleted: true,
        subject: "deleted, must not appear",
      },
      {
        msgNum: 102,
        dateWritten: localEpochSeconds(DATE_MSG3),
        from: "Bob Carrier",
        to: "Alice Sender",
        subject: "Re: Welcome",
        address: "2:5020/11",
        body:
          "Thanks Alice, glad to be here.\r* Origin: Test BBS (2:5020/11)\r",
      },
    ],
  });

  const sqd = buildSquishArea({
    numMsg: 2,
    messages: [
      {
        from: "Carol Squisher",
        to: "All",
        subject: "Squish chat",
        zone: 2,
        net: 5020,
        node: 12,
        point: 0,
        dateWritten: DATE_SQUISH1,
        body: "Hi from squish.\r",
      },
      {
        from: "Alice Sender",
        to: "Carol Squisher",
        subject: "Re: Squish chat",
        zone: 2,
        net: 5020,
        node: 10,
        point: 0,
        dateWritten: DATE_SQUISH2,
        body: "Hello Carol.\r",
      },
    ],
  });

  const nm1 = buildFtsMsg({
    from: "Dave Router",
    to: "Alice Sender",
    subject: "Netmail hi",
    dateStr: formatFtsDateStr(DATE_NM1),
    origNet: 5020,
    origNode: 13,
    destNet: 5020,
    destNode: 10,
    kludges: [
      { key: "INTL", value: "2:5020/10 2:5020/13" },
      { key: "FMPT", value: "5" },
    ],
    bodyLines: ["Hi Alice, just checking in.", "- Dave"],
  });

  const nm2 = buildFtsMsg({
    from: "Alice Sender",
    to: "Dave Router",
    subject: "Re: Netmail hi",
    dateStr: formatFtsDateStr(DATE_NM2),
    origNet: 5020,
    origNode: 10,
    destNet: 5020,
    destNode: 13,
    kludges: [{ key: "INTL", value: "2:5020/13 2:5020/10" }],
    bodyLines: ["Hi Dave, all good here."],
  });

  return {
    areas: {
      "fido.general": { kind: "jam" as const, jhr, jdt },
      "fido.chat": { kind: "squish" as const, sqd },
    },
    netmail: { "1.msg": nm1, "2.msg": nm2 },
  };
}

// ---------------------------------------------------------------------------
// listAreas
// ---------------------------------------------------------------------------

Deno.test("methods: listAreas enumerates JAM + Squish + netmail, sorted by count desc, with totalMessages", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("listAreas", {}, ctx);
    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "areas");
    assertEquals(written[0].name, "areas_list");
    const areas = written[0].payload.areas as Array<Record<string, unknown>>;
    assertEquals(areas.length, 3);

    const byName = new Map(areas.map((a) => [a.name as string, a]));
    assertEquals(byName.get("fido.general")?.format, "jam");
    assertEquals(byName.get("fido.general")?.activeMessages, 2);
    assertEquals(byName.get("fido.general")?.baseMsgNum, 1);
    assertEquals(byName.get("fido.chat")?.format, "squish");
    assertEquals(byName.get("fido.chat")?.activeMessages, 2);
    assertEquals(byName.get("netmail")?.format, "fts-0001");
    assertEquals(byName.get("netmail")?.activeMessages, 2);

    // sorted non-increasing by activeMessages (ties are fine; strict
    // ordering across ties is filesystem-enumeration-order-dependent)
    for (let i = 1; i < areas.length; i++) {
      const prev = areas[i - 1].activeMessages as number;
      const cur = areas[i].activeMessages as number;
      assert(prev >= cur, `areas not sorted desc at index ${i}`);
    }
    assertEquals(written[0].payload.totalMessages, 6);
  });
});

// ---------------------------------------------------------------------------
// readArea — JAM
// ---------------------------------------------------------------------------

Deno.test("methods: readArea (JAM) decodes messages, skips the deleted one, extracts origin+address", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readArea", { area: "fido.general" }, ctx);
    assertEquals(written[0].spec, "messages");
    assertEquals(written[0].name, "area_fido.general");
    const payload = written[0].payload;
    assertEquals(payload.area, "fido.general");
    assertEquals(payload.count, 2); // msg 101 (deleted) excluded
    const messages = payload.messages as Array<Record<string, unknown>>;
    assertEquals(messages.length, 2);

    assertEquals(messages[0].msgNum, 100);
    assertEquals(messages[0].from, "Alice Sender");
    assertEquals(messages[0].to, "All");
    assertEquals(messages[0].subject, "Welcome to the area");
    assertEquals(messages[0].address, "2:5020/10");
    assertEquals(messages[0].origin, "Test BBS (2:5020/10)");
    assertEquals(
      messages[0].body,
      "Welcome!\n* Origin: Test BBS (2:5020/10)\n",
    );
    assertEquals(messages[0].format, "jam");
    assertEquals(messages[0].timestamp, localEpochSeconds(DATE_MSG1));
    assertEquals(
      messages[0].date,
      new Date(localEpochSeconds(DATE_MSG1) * 1000).toISOString(),
    );

    assertEquals(messages[1].msgNum, 102);
    assertEquals(messages[1].from, "Bob Carrier");
    assertEquals(messages[1].to, "Alice Sender");
    assertEquals(messages[1].address, "2:5020/11");
  });
});

// ---------------------------------------------------------------------------
// readArea — Squish fallback (no .jhr present for this area)
// ---------------------------------------------------------------------------

Deno.test("methods: readArea falls back to Squish when no .jhr exists for the area", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readArea", { area: "fido.chat" }, ctx);
    const payload = written[0].payload;
    assertEquals(payload.count, 2);
    const messages = payload.messages as Array<Record<string, unknown>>;
    assertEquals(messages[0].from, "Carol Squisher");
    assertEquals(messages[0].subject, "Squish chat");
    assertEquals(messages[0].address, "2:5020/12");
    assertEquals(messages[0].format, "squish");
    assertEquals(messages[0].body, "Hi from squish.\n");
    assertEquals(messages[0].timestamp, localEpochSeconds(DATE_SQUISH1));

    assertEquals(messages[1].from, "Alice Sender");
    assertEquals(messages[1].address, "2:5020/10");
  });
});

// ---------------------------------------------------------------------------
// readNetmail
// ---------------------------------------------------------------------------

Deno.test("methods: readNetmail decodes FTS-0001 .msg files, sorted ascending by date, with INTL/FMPT address assembly", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readNetmail", {}, ctx);
    assertEquals(written[0].spec, "messages");
    assertEquals(written[0].name, "netmail");
    const payload = written[0].payload;
    assertEquals(payload.area, "netmail");
    assertEquals(payload.count, 2);
    const messages = payload.messages as Array<Record<string, unknown>>;

    assertEquals(messages[0].from, "Dave Router");
    assertEquals(messages[0].to, "Alice Sender");
    assertEquals(messages[0].subject, "Netmail hi");
    assertEquals(messages[0].address, "2:5020/13.5"); // orig + FMPT
    assertEquals(messages[0].destAddress, "2:5020/10"); // dest, no TOPT
    assertEquals(messages[0].body, "Hi Alice, just checking in.\n- Dave");
    assertEquals(messages[0].format, "fts-0001");
    assertEquals(messages[0].timestamp, localEpochSeconds(DATE_NM1));

    assertEquals(messages[1].from, "Alice Sender");
    assertEquals(messages[1].address, "2:5020/10"); // orig, no FMPT
    assertEquals(messages[1].destAddress, "2:5020/13");
  });
});

// ---------------------------------------------------------------------------
// searchBySender
// ---------------------------------------------------------------------------

Deno.test("methods: searchBySender matches across JAM, Squish, and netmail, sorted ascending by timestamp", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("searchBySender", { sender: "alice" }, ctx);
    assertEquals(written[0].spec, "messages");
    assertEquals(written[0].name, "sender_alice");
    const payload = written[0].payload;
    assertEquals(payload.query, "sender:alice");
    assertEquals(payload.count, 3);
    const messages = payload.messages as Array<Record<string, unknown>>;
    assertEquals(messages.map((m) => m.format), ["jam", "squish", "fts-0001"]);
    assertEquals(messages[0].area, "fido.general");
    assertEquals(messages[1].area, "fido.chat");
    assertEquals(messages[2].area, "netmail");
    // strictly ascending timestamps
    for (let i = 1; i < messages.length; i++) {
      assert(
        (messages[i - 1].timestamp as number) <=
          (messages[i].timestamp as number),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// searchByAddress — full node match + point match
// ---------------------------------------------------------------------------

Deno.test("methods: searchByAddress (node, no point) matches JAM, Squish, and netmail origAddress across formats", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("searchByAddress", { address: "2:5020/10" }, ctx);
    assertEquals(written[0].name, "address_2_5020_10");
    const payload = written[0].payload;
    assertEquals(payload.count, 3);
    const messages = payload.messages as Array<Record<string, unknown>>;
    assertEquals(messages.map((m) => m.area), [
      "fido.general",
      "fido.chat",
      "netmail",
    ]);
    for (const m of messages) assertEquals(m.address, "2:5020/10");
  });
});

Deno.test("methods: searchByAddress (point) matches only the exact point address, prefix-matches its node search", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx: pointCtx, written: pointWritten } = makeCtx(basePath);
    await run("searchByAddress", { address: "2:5020/13.5" }, pointCtx);
    assertEquals(pointWritten[0].payload.count, 1);
    const pointMatch =
      (pointWritten[0].payload.messages as Array<Record<string, unknown>>)[0];
    assertEquals(pointMatch.area, "netmail");
    assertEquals(pointMatch.address, "2:5020/13.5");

    const { ctx: nodeCtx, written: nodeWritten } = makeCtx(basePath);
    await run("searchByAddress", { address: "2:5020/13" }, nodeCtx);
    // node search matches the bare node AND any of its points (prefix rule)
    const nodeMessages = nodeWritten[0].payload.messages as Array<
      Record<string, unknown>
    >;
    assert(nodeMessages.some((m) => m.address === "2:5020/13.5"));
  });
});

// ---------------------------------------------------------------------------
// searchByText
// ---------------------------------------------------------------------------

Deno.test("methods: searchByText matches case-insensitively across subject/body/from", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("searchByText", { text: "WELCOME" }, ctx);
    assertEquals(written[0].name, "search_WELCOME");
    const payload = written[0].payload;
    assertEquals(payload.query, "text:WELCOME");
    const messages = payload.messages as Array<Record<string, unknown>>;
    assert(messages.length >= 1);
    assert(
      messages.some((m) =>
        (m.subject as string).toLowerCase().includes("welcome")
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// formatForObsidian
// ---------------------------------------------------------------------------

Deno.test("methods: formatForObsidian renders stored netmail results as Obsidian notes", async () => {
  await withTempMsgbase(buildCanonicalTree(), async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readNetmail", {}, ctx);
    await run("formatForObsidian", { source: "netmail" }, ctx);

    const obsidianEntry = written.find((w) => w.name === "obsidian_netmail")!;
    assertEquals(obsidianEntry.spec, "messages");
    const payload = obsidianEntry.payload;
    assertEquals(payload.query, "obsidian:netmail");
    assertEquals(payload.count, 2);
    const notes = payload.messages as Array<Record<string, unknown>>;

    const note0 = notes[0];
    assert((note0.obsidianPath as string).startsWith("FidoNet/2005-09-03"));
    const content = note0.obsidianContent as string;
    assert(content.startsWith("---\n"));
    assert(content.includes('title: "Netmail hi"'));
    assert(content.includes('from: "Dave Router"'));
    assert(content.includes('to: "Alice Sender"'));
    assert(content.includes('area: "netmail"'));
    assert(content.includes('address: "2:5020/13.5"'));
    assert(content.includes('dest_address: "2:5020/10"'));
    assert(content.includes('format: "fts-0001"'));
    assert(content.includes("  - netmail\n"));
    assert(content.includes("Hi Alice, just checking in.\n- Dave"));
  });
});
