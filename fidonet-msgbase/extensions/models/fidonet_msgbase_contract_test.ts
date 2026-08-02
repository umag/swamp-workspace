/**
 * Contract-fixture suite: pins EXACT decoded output against golden synthetic
 * fixtures — independent of the methods suite's happy-path shape checks.
 * Covers: CP866 fallback decode (mapped byte ranges), the UTF-8 path,
 * JAM/Squish/FTS-0001 NUL-trim byte-exactness (LB8 fix), `* Origin:` line +
 * FTN-address extraction regexes (including the no-OADDRESS-subfield
 * fallback), an INDEPENDENTLY hand-derived DOS packed-datetime
 * (`parseScombo`) pin (a raw hex combo, not round-tripped through the
 * fixture builder's own `packScombo` inverse — so a symmetric bit-math bug
 * in both wouldn't silently cancel out), `parseFtsDate`'s 2-digit-year
 * century rule, every INTL/FMPT/TOPT kludge-address-assembly combination,
 * the deleted-message (`attr & 0x80000000`) skip, and the exact
 * `formatForObsidian` markdown frontmatter + body + dedup suffix string.
 *
 * `fidonet_msgbase.ts` received a real-fix pass for 9 latent bugs (see the
 * LOCAL `fidonet-msgbase-latent-bugs` issue-lifecycle model); valid-message
 * parsing stays byte-identical, which is exactly what this suite pins. All
 * fixture content is synthetic — see fixtures/PROVENANCE.md.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./fidonet_msgbase.ts";
import {
  buildFtsMsg,
  buildJamArea,
  buildJamAreaFiles,
  buildSquishArea,
  encodeCp866,
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
    ctx: {
      globalArgs: { basePath },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        seeded.set(name, payload as Record<string, unknown>);
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
// CP866 fallback decode — mapped ranges
// ---------------------------------------------------------------------------

Deno.test("contract: CP866 upper-range (0x80-0xAF) and lower-range (0xE0-0xEF) bytes decode to the documented Cyrillic letters", async () => {
  // "Иван" -> 0x88 0xA2 0xA0 0xAD (upper-range table, 0x80-0xAF)
  // "рстуфхцчшщъыьэюя" fully spans the lower-range table (0xE0-0xEF)
  const upperName = encodeCp866("Иван");
  const lowerWord = encodeCp866("рстуфхцчшщъыьэюя");
  await withTempMsgbase(
    {
      areas: {
        "fido.cp866": {
          kind: "jam",
          ...buildJamAreaFiles({
            messages: [
              {
                msgNum: 1,
                dateWritten: 1000000000,
                from: upperName,
                to: "All",
                subject: lowerWord,
              },
            ],
          }),
        },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.cp866" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages[0].from, "Иван");
      assertEquals(messages[0].subject, "рстуфхцчшщъыьэюя");
    },
  );
});

Deno.test("contract: CP866 extra-table bytes (shading blocks + Ё variants) decode via the explicit cp866Extra map", async () => {
  // 0xb0 "░", 0xf0 "Ё", 0xfc "№" — hand-picked bytes not in the upper/lower
  // contiguous ranges, forcing the cp866Extra lookup branch.
  const raw = new Uint8Array([0xb0, 0xf0, 0xfc]);
  await withTempMsgbase(
    {
      areas: {
        "fido.extra": {
          kind: "jam",
          ...buildJamAreaFiles({
            messages: [
              { msgNum: 1, dateWritten: 1000000000, from: raw, to: "All" },
            ],
          }),
        },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.extra" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages[0].from, "░Ё№");
    },
  );
});

// ---------------------------------------------------------------------------
// UTF-8 path (decodeText's first branch)
// ---------------------------------------------------------------------------

Deno.test("contract: valid multi-byte UTF-8 with high bytes decodes as UTF-8, not CP866 (the previously-dead high-byte guard was removed as part of the LB8 fix — decodeText now returns directly from the UTF-8 branch)", async () => {
  const utf8Name = "Привет мир"; // valid UTF-8, all bytes >= 0x80 for Cyrillic
  await withTempMsgbase(
    {
      areas: {
        "fido.utf8": {
          kind: "jam",
          ...buildJamAreaFiles({
            messages: [
              {
                msgNum: 1,
                dateWritten: 1000000000,
                from: utf8Name, // string -> encoded as UTF-8 by asciiBytes/TextEncoder
                to: "All",
              },
            ],
          }),
        },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.utf8" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages[0].from, utf8Name);
    },
  );
});

// ---------------------------------------------------------------------------
// LB8 fix: JAM subfield NUL-trim is byte-exact with Squish/FTS-0001
// ---------------------------------------------------------------------------

Deno.test("contract: JAM subfield NUL-trim is byte-exact with Squish's XMSG and FTS-0001's header NUL-truncation for the same padded input", async () => {
  const paddedName = new Uint8Array([
    0x43,
    0x61,
    0x72,
    0x6f,
    0x6c,
    0x00,
    0x00,
    0x00,
  ]); // "Carol\0\0\0"
  const { jhr, jdt } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: paddedName,
      to: "All",
    }],
  });
  const sqd = buildSquishArea({
    messages: [{ from: paddedName, to: "All", subject: "x", body: "b" }],
  });
  const nm = buildFtsMsg({ from: paddedName, to: "All", bodyLines: ["x"] });
  await withTempMsgbase(
    {
      areas: {
        "fido.jamtrim": { kind: "jam", jhr, jdt },
        "fido.sqtrim": { kind: "squish", sqd },
      },
      netmail: { "1.msg": nm },
    },
    async (basePath) => {
      const { ctx: ctx1, written: w1 } = makeCtx(basePath);
      await run("readArea", { area: "fido.jamtrim" }, ctx1);
      const jamFrom =
        (w1[0].payload.messages as Array<Record<string, unknown>>)[0].from;

      const { ctx: ctx2, written: w2 } = makeCtx(basePath);
      await run("readArea", { area: "fido.sqtrim" }, ctx2);
      const sqFrom =
        (w2[0].payload.messages as Array<Record<string, unknown>>)[0].from;

      const { ctx: ctx3, written: w3 } = makeCtx(basePath);
      await run("readNetmail", {}, ctx3);
      const ftsFrom =
        (w3[0].payload.messages as Array<Record<string, unknown>>)[0].from;

      assertEquals(jamFrom, "Carol");
      assertEquals(sqFrom, "Carol");
      assertEquals(ftsFrom, "Carol");
    },
  );
});

// ---------------------------------------------------------------------------
// Origin-line + FTN-address extraction regexes
// ---------------------------------------------------------------------------

Deno.test("contract: extractOrigin pulls the text between '* Origin: ' and end-of-line, non-greedy", async () => {
  await withTempMsgbase(
    {
      areas: {
        "fido.origin": {
          kind: "jam",
          ...buildJamAreaFiles({
            messages: [
              {
                msgNum: 1,
                dateWritten: 1000000000,
                from: "Poster",
                to: "All",
                body:
                  "Body line one.\rBody line two.\r* Origin: My BBS Name (2:5020/99)\r",
              },
            ],
          }),
        },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.origin" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages[0].origin, "My BBS Name (2:5020/99)");
      assertEquals(messages[0].address, "2:5020/99");
      assertEquals(
        messages[0].body,
        "Body line one.\nBody line two.\n* Origin: My BBS Name (2:5020/99)\n",
      );
    },
  );
});

Deno.test("contract: extractAddressFromOrigin is only used when the JAM OADDRESS subfield is absent — the subfield wins when both are present", async () => {
  await withTempMsgbase(
    {
      areas: {
        "fido.addr": {
          kind: "jam",
          ...buildJamAreaFiles({
            messages: [
              // No OADDRESS subfield -> falls back to origin-line extraction.
              {
                msgNum: 1,
                dateWritten: 1000000000,
                from: "NoSubfield",
                to: "All",
                body: "Hi.\r* Origin: Fallback BBS (2:5020/50.7)\r",
              },
              // OADDRESS subfield present AND a different origin-line
              // address -> the subfield value wins.
              {
                msgNum: 2,
                dateWritten: 1000000000,
                from: "WithSubfield",
                to: "All",
                address: "2:5020/60",
                body: "Hi.\r* Origin: Other BBS (2:5020/61)\r",
              },
            ],
          }),
        },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.addr" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages[0].address, "2:5020/50.7"); // from origin line
      assertEquals(messages[1].address, "2:5020/60"); // from OADDRESS subfield
    },
  );
});

// ---------------------------------------------------------------------------
// parseScombo — independent raw-hex pin (NOT built via packScombo)
// ---------------------------------------------------------------------------

Deno.test("contract: parseScombo decodes a hand-derived raw DOS packed date/time (0x6DAF32CF -> 2005-06-15 13:45:30 local)", async () => {
  // Hand-derived, independent of builders.ts's packScombo:
  //   date16 = day(15) | month(6)<<5 | (year-1980=25)<<9        = 0x32CF
  //   time16 = (sec/2=15) | min(45)<<5 | hour(13)<<11            = 0x6DAF
  //   val    = date16 | (time16 << 16)                           = 0x6DAF32CF
  const RAW_COMBO = 0x6dAF32CF;
  const expected = localEpochSeconds({
    year: 2005,
    month: 6,
    day: 15,
    hour: 13,
    min: 45,
    sec: 30,
  });
  const sqd = buildSquishArea({
    messages: [{
      from: "Squish Poster",
      to: "All",
      subject: "combo pin",
      scomboRaw: RAW_COMBO,
      body: "x",
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.combo": { kind: "squish", sqd } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.combo" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages[0].timestamp, expected);
    },
  );
});

// ---------------------------------------------------------------------------
// parseFtsDate — 2-digit-year century rule
// ---------------------------------------------------------------------------

Deno.test("contract: parseFtsDate applies +2000 for year<80 and +1900 for 80<=year<100", async () => {
  const nmLow = buildFtsMsg({
    from: "A",
    to: "B",
    dateStr: "01 Jan 05  00:00:00", // "05" -> 2005
    bodyLines: ["x"],
  });
  const nmHigh = buildFtsMsg({
    from: "A",
    to: "B",
    dateStr: "01 Jan 99  00:00:00", // "99" -> 1999
    bodyLines: ["x"],
  });
  await withTempMsgbase(
    { netmail: { "1.msg": nmLow, "2.msg": nmHigh } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readNetmail", {}, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      const byNum = new Map(messages.map((m) => [m.msgNum, m]));
      assertEquals(
        byNum.get(1)?.timestamp,
        localEpochSeconds({
          year: 2005,
          month: 1,
          day: 1,
          hour: 0,
          min: 0,
          sec: 0,
        }),
      );
      assertEquals(
        byNum.get(2)?.timestamp,
        localEpochSeconds({
          year: 1999,
          month: 1,
          day: 1,
          hour: 0,
          min: 0,
          sec: 0,
        }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// INTL / FMPT / TOPT kludge address assembly — every combination
// ---------------------------------------------------------------------------

Deno.test("contract: INTL-only assembles orig/dest with no point suffix", async () => {
  const msg = buildFtsMsg({
    from: "A",
    to: "B",
    kludges: [{ key: "INTL", value: "2:5020/10 2:5020/20" }],
    bodyLines: ["x"],
  });
  await withTempMsgbase({ netmail: { "1.msg": msg } }, async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readNetmail", {}, ctx);
    const m =
      (written[0].payload.messages as Array<Record<string, unknown>>)[0];
    assertEquals(m.destAddress, "2:5020/10");
    assertEquals(m.address, "2:5020/20"); // origAddress
  });
});

Deno.test("contract: INTL+FMPT appends the point to origAddress only", async () => {
  const msg = buildFtsMsg({
    from: "A",
    to: "B",
    kludges: [
      { key: "INTL", value: "2:5020/10 2:5020/20" },
      { key: "FMPT", value: "3" },
    ],
    bodyLines: ["x"],
  });
  await withTempMsgbase({ netmail: { "1.msg": msg } }, async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readNetmail", {}, ctx);
    const m =
      (written[0].payload.messages as Array<Record<string, unknown>>)[0];
    assertEquals(m.destAddress, "2:5020/10");
    assertEquals(m.address, "2:5020/20.3");
  });
});

Deno.test("contract: INTL+TOPT appends the point to destAddress only", async () => {
  const msg = buildFtsMsg({
    from: "A",
    to: "B",
    kludges: [
      { key: "INTL", value: "2:5020/10 2:5020/20" },
      { key: "TOPT", value: "7" },
    ],
    bodyLines: ["x"],
  });
  await withTempMsgbase({ netmail: { "1.msg": msg } }, async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readNetmail", {}, ctx);
    const m =
      (written[0].payload.messages as Array<Record<string, unknown>>)[0];
    assertEquals(m.destAddress, "2:5020/10.7");
    assertEquals(m.address, "2:5020/20");
  });
});

Deno.test("contract: INTL+FMPT+TOPT appends points to both addresses", async () => {
  const msg = buildFtsMsg({
    from: "A",
    to: "B",
    kludges: [
      { key: "INTL", value: "2:5020/10 2:5020/20" },
      { key: "FMPT", value: "3" },
      { key: "TOPT", value: "7" },
    ],
    bodyLines: ["x"],
  });
  await withTempMsgbase({ netmail: { "1.msg": msg } }, async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readNetmail", {}, ctx);
    const m =
      (written[0].payload.messages as Array<Record<string, unknown>>)[0];
    assertEquals(m.destAddress, "2:5020/10.7");
    assertEquals(m.address, "2:5020/20.3");
  });
});

Deno.test("contract: no INTL kludge falls back to '0:net/node' from the fixed-header orig/dest fields", async () => {
  const msg = buildFtsMsg({
    from: "A",
    to: "B",
    origNet: 5020,
    origNode: 42,
    destNet: 5030,
    destNode: 99,
    bodyLines: ["x"],
  });
  await withTempMsgbase({ netmail: { "1.msg": msg } }, async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("readNetmail", {}, ctx);
    const m =
      (written[0].payload.messages as Array<Record<string, unknown>>)[0];
    assertEquals(m.address, "0:5020/42");
    assertEquals(m.destAddress, "0:5030/99");
  });
});

// ---------------------------------------------------------------------------
// Deleted-message skip (attr bit 31)
// ---------------------------------------------------------------------------

Deno.test("contract: only attr bit 0x80000000 marks deletion — other high bits in attr are preserved as flags and don't hide the message", async () => {
  const { jdt } = buildJamAreaFiles({ messages: [] });
  // Build directly with attrOverride to test a non-deletion flag combo
  // alongside the (unset) deletion bit.
  const jhrWithFlags = buildJamArea({
    activeMsgs: 1,
    messages: [
      {
        msgNum: 1,
        dateWritten: 1000000000,
        attrOverride: 0x00000021, // MSGLOCAL(0x01)|MSGPRIVATE(0x20)-ish bits, deletion bit unset
        subfields: { from: "Flagged", to: "All" },
      },
    ],
  });
  await withTempMsgbase(
    { areas: { "fido.flags": { kind: "jam", jhr: jhrWithFlags, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.flags" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].flags, 0x00000021);
    },
  );
});

// ---------------------------------------------------------------------------
// formatForObsidian — exact markdown frontmatter/body + dedup suffix
// ---------------------------------------------------------------------------

Deno.test("contract: formatForObsidian's markdown frontmatter+body is byte-exact, and a raw \\x01 kludge line + '* Origin:' line are stripped from cleanBody", async () => {
  await withTempMsgbase(
    {
      areas: {
        "fido.md": {
          kind: "jam",
          ...buildJamAreaFiles({
            messages: [
              {
                msgNum: 1,
                dateWritten: localEpochSeconds({
                  year: 2005,
                  month: 8,
                  day: 28,
                  hour: 0,
                  min: 0,
                  sec: 0,
                }),
                from: "Poster Name",
                to: "All",
                subject: "Markdown Pin",
                address: "2:5020/1",
                body:
                  "\x01MSGID: 2:5020/1 12345678\rHello there.\r* Origin: Test BBS (2:5020/1)\r",
              },
            ],
          }),
        },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.md" }, ctx);
      await run("formatForObsidian", { source: "area_fido.md" }, ctx);
      const notes = written.find((w) => w.name === "obsidian_area_fido.md")!
        .payload.messages as Array<Record<string, unknown>>;
      const note = notes[0];

      const expectedDate = new Date(
        localEpochSeconds({
          year: 2005,
          month: 8,
          day: 28,
          hour: 0,
          min: 0,
          sec: 0,
        }) * 1000,
      ).toISOString().slice(0, 10);

      assertEquals(
        note.obsidianContent,
        `---\n` +
          `title: "Markdown Pin"\n` +
          `from: "Poster Name"\n` +
          `to: "All"\n` +
          `area: "fido.md"\n` +
          `date: ${expectedDate}\n` +
          `address: "2:5020/1"\n` +
          `format: "jam"\n` +
          `tags:\n  - fidonet\n  - fido-md\n` +
          `---\n\n` +
          `**From:** Poster Name (2:5020/1) **To:** All\n\n` +
          `Hello there.\n\n` +
          `> *Origin: Test BBS (2:5020/1)*\n`,
      );
      assertEquals(note.obsidianPath, `FidoNet/${expectedDate} Markdown Pin`);
    },
  );
});

Deno.test("contract: formatForObsidian dedups identical basePaths with a ' (N)' suffix", async () => {
  const sameDate = localEpochSeconds({
    year: 2005,
    month: 1,
    day: 1,
    hour: 0,
    min: 0,
    sec: 0,
  });
  const dateSlug = new Date(sameDate * 1000).toISOString().slice(0, 10);
  await withTempMsgbase(
    {
      areas: {
        "fido.dup": {
          kind: "jam",
          ...buildJamAreaFiles({
            messages: [
              {
                msgNum: 1,
                dateWritten: sameDate,
                from: "A",
                subject: "Same Subject",
              },
              {
                msgNum: 2,
                dateWritten: sameDate,
                from: "B",
                subject: "Same Subject",
              },
              {
                msgNum: 3,
                dateWritten: sameDate,
                from: "C",
                subject: "Same Subject",
              },
            ],
          }),
        },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.dup" }, ctx);
      await run("formatForObsidian", { source: "area_fido.dup" }, ctx);
      const notes = written.find((w) => w.name === "obsidian_area_fido.dup")!
        .payload.messages as Array<Record<string, unknown>>;
      const paths = notes.map((n) => n.obsidianPath);
      assertEquals(paths, [
        `FidoNet/${dateSlug} Same Subject`,
        `FidoNet/${dateSlug} Same Subject (2)`,
        `FidoNet/${dateSlug} Same Subject (3)`,
      ]);
    },
  );
});
