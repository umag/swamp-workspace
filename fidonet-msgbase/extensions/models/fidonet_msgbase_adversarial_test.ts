/**
 * Adversarial suite: hostile/malformed inputs, pinning CURRENT behavior.
 * fidonet_msgbase.ts is BYTE-FROZEN — nothing here is a proposed fix, every
 * test asserts what the shipped code ACTUALLY does today. Bug pins are
 * labelled "pin:" and are recorded to the LOCAL `fidonet-msgbase-latent-bugs`
 * issue-lifecycle model, never a swamp.club Lab issue.
 *
 * Two findings are deliberately NOT exercised as running code:
 *  - The Squish frame-chain cycle (bug #2, MEDIUM): `parseSquishMessages`
 *    follows `nextFrame` with no visited-set. A crafted cycle hangs forever.
 *    This suite builds a genuine 2-frame cycle and asserts its STRUCTURE
 *    (frame B's nextFrame really does point back at frame A) without ever
 *    calling `readArea`/`searchBy*` on it — doing so would hang CI.
 *  - Unbounded `Deno.readFile` into RAM (bug #9, LOW/informational): every
 *    parser buffers the whole file with no size cap. Demonstrating this
 *    would require allocating a multi-GB fixture, which is not a reasonable
 *    CI-time cost; it is recorded as an accepted informational finding only.
 *
 * All fixture content is synthetic — see fixtures/PROVENANCE.md.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./fidonet_msgbase.ts";
import {
  buildFtsMsg,
  buildJamArea,
  buildJamAreaFiles,
  buildSquishArea,
  SQUISH_FRAME_ID,
  withTempMsgbase,
} from "./fixtures/builders.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx(basePath: string) {
  const written: Written[] = [];
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
        return Promise.resolve({ spec, name });
      },
      readResource: () => Promise.resolve(undefined),
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
// pin: readArea path traversal via the `area` arg — HIGH, fidonet_msgbase.ts:617
// ---------------------------------------------------------------------------

Deno.test("pin: readArea's `area` arg is interpolated unsanitized into the filesystem path — '../' escapes basePath (escape target stays INSIDE the temp tree)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fidonet-msgbase-traversal-" });
  try {
    const basePath = `${root}/msgbase`;
    await Deno.mkdir(basePath, { recursive: true });
    // The escape target lives ONE level above basePath, but still inside
    // `root` (the per-test temp tree) — never a real system path.
    const { jhr, jdt } = buildJamAreaFiles({
      messages: [{
        msgNum: 1,
        dateWritten: 1000000000,
        from: "Escaped Secret",
        subject: "should not be reachable via a sane area name",
      }],
    });
    await Deno.writeFile(`${root}/secret.jhr`, jhr);
    await Deno.writeFile(`${root}/secret.jdt`, jdt);

    const { ctx, written } = makeCtx(basePath);
    await run("readArea", { area: "../secret" }, ctx);
    const payload = written[0].payload;
    const messages = payload.messages as Array<Record<string, unknown>>;
    assertEquals(messages.length, 1);
    assertEquals(messages[0].from, "Escaped Secret");
    // area label reflects the caller-supplied traversal string verbatim
    assertEquals(payload.area, "../secret");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Bad/truncated JAM header -> falls back to Squish, or throws if neither exists
// ---------------------------------------------------------------------------

Deno.test("adversarial: wrong JAM signature falls back to Squish when a .sqd sibling exists", async () => {
  const badJhr = buildJamArea({
    badSignature: true,
    activeMsgs: 0,
    messages: [],
  });
  const sqd = buildSquishArea({
    messages: [{
      from: "Fallback",
      to: "All",
      subject: "via squish",
      body: "ok",
    }],
  });
  await withTempMsgbase(
    {
      areas: {
        "fido.badsig": {
          kind: "raw",
          files: { "fido.badsig.jhr": badJhr, "fido.badsig.sqd": sqd },
        },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.badsig" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].format, "squish");
      assertEquals(messages[0].from, "Fallback");
    },
  );
});

Deno.test("adversarial: a too-short .jhr (< 24 bytes) with no .sqd sibling throws 'not found or unreadable'", async () => {
  await withTempMsgbase(
    {
      areas: {
        "fido.tiny": {
          kind: "raw",
          files: { "fido.tiny.jhr": new Uint8Array([0x4a, 0x41, 0x4d]) }, // "JAM", 3 bytes total
        },
      },
    },
    async (basePath) => {
      const { ctx } = makeCtx(basePath);
      await assertRejects(
        () => run("readArea", { area: "fido.tiny" }, ctx),
        Error,
        "not found or unreadable",
      );
    },
  );
});

Deno.test("adversarial: a nonexistent area (no .jhr, no .sqd) throws 'not found or unreadable'", async () => {
  await withTempMsgbase({}, async (basePath) => {
    const { ctx } = makeCtx(basePath);
    await assertRejects(
      () => run("readArea", { area: "does.not.exist" }, ctx),
      Error,
      "not found or unreadable",
    );
  });
});

// ---------------------------------------------------------------------------
// Oversized subfieldLen -> OOB subfield read breaks the parse loop early
// ---------------------------------------------------------------------------

Deno.test("pin: an oversized subfieldLen causes the subfield/message loop to break early, silently truncating later messages", async () => {
  const jhr = buildJamArea({
    activeMsgs: 2,
    messages: [
      {
        msgNum: 1,
        dateWritten: 1000000000,
        subfieldLenOverride: 100000, // wildly larger than actual subfield bytes
        subfields: { from: "Corrupt", to: "All" },
      },
      // This second, perfectly well-formed message is UNREACHABLE: the
      // corrupt subfieldLen above pushes `offset` far past this message's
      // real position before the next iteration's signature check runs.
      {
        msgNum: 2,
        dateWritten: 1000000000,
        subfields: { from: "Never Seen", to: "All" },
      },
    ],
  });
  await withTempMsgbase(
    { areas: { "fido.corrupt": { kind: "jam", jhr } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.corrupt" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      // Neither message survives: the first message's own subfield read
      // already breaks (bufStart+datLen > length), and the corrupt
      // subfieldLen misaligns the outer loop so msgNum 2 is never reached.
      assert(
        messages.every((m) => m.from !== "Never Seen"),
        "a message after a corrupt subfieldLen must never be recovered",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// OOB txtOffset/txtLen -> empty body, no throw
// ---------------------------------------------------------------------------

Deno.test("adversarial: txtOffset/txtLen pointing past the .jdt buffer yields an empty body, not a throw", async () => {
  const { jdt } = buildJamAreaFiles({ messages: [] }); // empty .jdt
  const jhr = buildJamArea({
    activeMsgs: 1,
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      txtOffset: 99999,
      txtLen: 50,
      subfields: { from: "OOB Text", to: "All" },
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.ooboffset": { kind: "jam", jhr, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.ooboffset" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].body, "");
    },
  );
});

// ---------------------------------------------------------------------------
// Truncated Squish frame -> OOB fixed-field reads decode as ZERO (not NaN —
// bitwise ops coerce `undefined` to 0 via ToInt32), yielding a degenerate
// "0:0/0" address and a rolled-over garbage date, with no throw.
// ---------------------------------------------------------------------------

Deno.test("pin: a truncated Squish frame (XMSG cut short) decodes OOB fields as zero, not NaN — garbage address '0:0/0', no throw", async () => {
  const full = buildSquishArea({
    messages: [{
      from: "X",
      to: "Y",
      subject: "Z",
      zone: 2,
      net: 5020,
      node: 99,
      point: 0,
      body: "hi",
    }],
  });
  // Truncate to 10 bytes into the 238-byte XMSG: "from" (starts at xmsgOfs+4)
  // partially survives (6 bytes present), everything after it reads as 0.
  const truncated = full.slice(0, 256 + 28 + 10);
  await withTempMsgbase(
    { areas: { "fido.trunc": { kind: "squish", sqd: truncated } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.trunc" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].from, "X");
      assertEquals(messages[0].to, ""); // fully OOB -> empty slice
      assertEquals(messages[0].subject, "");
      assertEquals(messages[0].address, "0:0/0"); // zone/net/node all OOB->0
      assertEquals(messages[0].body, ""); // bodyStart+bodyLen > length guard
      assert(!Number.isNaN(messages[0].timestamp), "timestamp must not be NaN");
    },
  );
});

// ---------------------------------------------------------------------------
// Negative Squish bodyLen (msgLength smaller than the fixed+control size) ->
// body stays empty, no throw
// ---------------------------------------------------------------------------

Deno.test("adversarial: msgLength smaller than 238+clen (negative computed bodyLen) yields an empty body, not a throw", async () => {
  const sqd = buildSquishArea({
    messages: [{
      from: "Neg",
      to: "All",
      subject: "negative bodyLen",
      body: "this body is ignored by the corrupt msgLength",
      msgLengthOverride: 238, // exactly the fixed size -> bodyLen = 238-238-0 = 0
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.neg": { kind: "squish", sqd } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.neg" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages[0].body, "");
    },
  );
});

// ---------------------------------------------------------------------------
// Netmail: non-numeric and non-.msg filenames are silently skipped
// ---------------------------------------------------------------------------

Deno.test("adversarial: readNetmail skips non-.msg files and non-numeric .msg filenames, keeping only valid ones", async () => {
  const valid = buildFtsMsg({ from: "Valid", to: "All", bodyLines: ["ok"] });
  await withTempMsgbase(
    {
      netmail: {
        "10.msg": valid,
        "not-a-number.msg": buildFtsMsg({ from: "Bad", bodyLines: ["x"] }),
        "readme.txt": new TextEncoder().encode("not a msg file at all"),
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readNetmail", {}, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].from, "Valid");
    },
  );
});

// ---------------------------------------------------------------------------
// Missing .jdt sibling -> JAM area still readable, with empty bodies
// ---------------------------------------------------------------------------

Deno.test("adversarial: readArea tolerates a JAM area with no .jdt sibling — bodies are empty, no throw", async () => {
  const { jhr } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "No Text File",
      to: "All",
      subject: "no jdt",
      body: "this body is never written because we omit the .jdt file below",
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.nojdt": { kind: "jam", jhr } } }, // jdt omitted entirely
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.nojdt" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].body, "");
    },
  );
});

// ---------------------------------------------------------------------------
// Empty basePath — no areas, no netmail
// ---------------------------------------------------------------------------

Deno.test("adversarial: listAreas over a completely empty basePath returns zero areas and totalMessages 0, no throw", async () => {
  await withTempMsgbase({}, async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("listAreas", {}, ctx);
    assertEquals(written[0].payload.areas, []);
    assertEquals(written[0].payload.totalMessages, 0);
  });
});

// ---------------------------------------------------------------------------
// pin: silent-skip — a corrupt JAM area contributes zero matches and never
// blocks search of the rest of the msgbase (fidonet_msgbase.ts:796+)
//
// Correction to the plan's framing: for searchBySender/searchByAddress/
// searchByText, the JAM branch's outer `catch {}` is actually UNREACHABLE by
// crafted bytes alone — `parseJamMessages` never throws for any byte input
// (every read is bounds-guarded; `decodeText`'s only throwing call is caught
// internally). The user-visible "silent skip" is really `parseJamMessages`
// returning `[]` for a truncated/short area, which then hits the ordinary
// `if (matches.length === 0) continue` early-exit — not the catch block. The
// OBSERVABLE behavior (a corrupt area is silently and harmlessly excluded,
// with a good area alongside it still fully searchable) is what this test
// pins; readArea's catch IS reachable (see the bad-signature test above)
// because it explicitly validates the header and throws.
// ---------------------------------------------------------------------------

Deno.test("pin: a truncated/corrupt JAM area beside a good one yields only the good area's hits, with no throw", async () => {
  const corruptJhr = new Uint8Array(50); // valid-looking but far too short for any message region
  corruptJhr.set(new TextEncoder().encode("JAM"), 0);
  const { jhr: goodJhr } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "Good Sender",
      to: "All",
      subject: "fine",
    }],
  });
  await withTempMsgbase(
    {
      areas: {
        "fido.corrupt2": {
          kind: "raw",
          files: { "fido.corrupt2.jhr": corruptJhr },
        },
        "fido.good": { kind: "jam", jhr: goodJhr },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("searchBySender", { sender: "sender" }, ctx);
      const payload = written[0].payload;
      const messages = payload.messages as Array<Record<string, unknown>>;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].from, "Good Sender");
      assertEquals(messages[0].area, "fido.good");
    },
  );
});

// ---------------------------------------------------------------------------
// pin: JAM subfields carry raw, untrimmed bytes — embedded NUL padding
// survives verbatim into from/to/subject (unlike Squish's XMSG fixed fields
// and FTS-0001's header fields, both explicitly NUL-truncated at the call
// site via .replace(/\0.*/, "") / .split("\0")[0]).
// (Part of bug #8 — see also the contract suite's "dead-code UTF-8 guard"
// pin for the other half of that finding.)
// ---------------------------------------------------------------------------

Deno.test("pin: a JAM subfield's declared datLen is taken literally — trailing NUL padding survives untrimmed into the decoded field", async () => {
  const paddedFrom = new Uint8Array([0x42, 0x6f, 0x62, 0x00, 0x00]); // "Bob\0\0"
  const jhr = buildJamArea({
    activeMsgs: 1,
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      subfields: { from: paddedFrom, to: "All" },
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.nul": { kind: "jam", jhr } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.nul" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages[0].from, "Bob\0\0");
      assertEquals((messages[0].from as string).length, 5);
    },
  );
});

// ---------------------------------------------------------------------------
// Squish frame-cycle — STRUCTURAL characterization only, never executed
// (bug #2, MEDIUM, fidonet_msgbase.ts:270). See the module docstring.
// ---------------------------------------------------------------------------

Deno.test("pin (structural only, NOT executed): a crafted Squish frame chain can cycle — nextFrame pointing backward is representable and would hang parseSquishMessages if ever read", () => {
  // Two frames; force the LAST frame's nextFrame back to frame A's offset
  // instead of 0, forming a 2-frame cycle: A -> B -> A -> B -> ... forever.
  const headerSize = 256;
  const sqd = buildSquishArea({
    headerSize,
    messages: [
      { from: "A", to: "All", subject: "frame A", body: "a" },
      { from: "B", to: "All", subject: "frame B", body: "b" },
    ],
    lastNextFrameOverride: headerSize, // frame B's nextFrame -> frame A's offset
  });
  const view = new DataView(sqd.buffer);
  const frameAOffset = headerSize;
  assertEquals(view.getUint32(frameAOffset, true), SQUISH_FRAME_ID);
  // Walk to frame B without ever looping (bounded, single hop) purely to
  // confirm the BYTES form a genuine cycle — `parseSquishMessages` is never
  // invoked on this buffer.
  const frameALength = 28 + 238 + "a".length;
  const frameBOffset = frameAOffset + frameALength;
  assertEquals(view.getUint32(frameBOffset, true), SQUISH_FRAME_ID);
  const frameBNextFrame = view.getUint32(frameBOffset + 4, true);
  assertEquals(
    frameBNextFrame,
    frameAOffset,
    "frame B's nextFrame must point back at frame A, proving the cycle exists structurally",
  );
});
