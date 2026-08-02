/**
 * Adversarial suite: hostile/malformed inputs, exercising both the 9
 * real-fixed latent bugs and remaining intentionally-unchanged behavior.
 * `fidonet_msgbase.ts` received a real-fix pass (see the LOCAL
 * `fidonet-msgbase-latent-bugs` issue-lifecycle model, never a swamp.club Lab
 * issue): tests labelled "FIXED (was pin):" assert the NEW, corrected
 * behavior for a closed bug; tests still labelled "pin:" assert CURRENT,
 * intentionally-unchanged behavior (not one of the 9 bugs in scope).
 *
 * Two findings that were previously characterized WITHOUT running code are
 * now both exercised directly, since the fix itself makes them safe to run:
 *  - The Squish frame-chain cycle (bug #2, MEDIUM): `parseSquishMessages` now
 *    tracks visited frame offsets and breaks on a revisit, so the same
 *    crafted 2-frame cycle this suite used to only characterize structurally
 *    can now be run through `readArea` directly without hanging CI.
 *  - Unbounded `Deno.readFile` into RAM (bug #9, LOW/informational): every
 *    parser now goes through `readFileCapped`, which rejects a file over a
 *    configurable byte cap (`FIDONET_MSGBASE_MAX_BYTES`) before ever calling
 *    `Deno.readFile`. Demonstrating the ORIGINAL unbounded-buffering behavior
 *    would still require a multi-GB fixture (not a reasonable CI-time cost),
 *    but the FIX is fully testable at CI scale by shrinking the cap via the
 *    env var instead of growing the fixture.
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
// FIXED: readArea path traversal via the `area` arg — HIGH, was
// fidonet_msgbase.ts:617, now rejected by `resolveAreaFile` (LB1)
// ---------------------------------------------------------------------------

Deno.test("FIXED (was pin): readArea rejects a traversal `area` arg ('../secret') instead of escaping basePath — the escape target stays on disk, untouched, and its content never reaches the output", async () => {
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
    await assertRejects(
      () => run("readArea", { area: "../secret" }, ctx),
      Error,
      "path traversal rejected",
    );
    // Non-vacuous: the escape target is still ON DISK, unchanged, and no
    // handle was ever written referencing its content — the rejection
    // happened before any read, not after a read that was then discarded.
    const secretBytes = await Deno.readFile(`${root}/secret.jhr`);
    assertEquals(secretBytes, jhr);
    assert(
      written.every((w) =>
        !JSON.stringify(w.payload).includes("Escaped Secret")
      ),
      "the escaped secret's content must never reach any written resource",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("adversarial: readArea rejects an absolute-path `area` arg", async () => {
  await withTempMsgbase({}, async (basePath) => {
    const { ctx } = makeCtx(basePath);
    await assertRejects(
      () => run("readArea", { area: "/etc/passwd" }, ctx),
      Error,
      "path traversal rejected",
    );
  });
});

Deno.test("adversarial: readArea rejects a backslash-separated `area` arg", async () => {
  await withTempMsgbase({}, async (basePath) => {
    const { ctx } = makeCtx(basePath);
    await assertRejects(
      () => run("readArea", { area: "..\\secret" }, ctx),
      Error,
      "path traversal rejected",
    );
  });
});

Deno.test("adversarial: readArea rejects a nested traversal `area` arg ('a/../b') even though it would numerically cancel out", async () => {
  await withTempMsgbase({}, async (basePath) => {
    const { ctx } = makeCtx(basePath);
    await assertRejects(
      () => run("readArea", { area: "a/../b" }, ctx),
      Error,
      "path traversal rejected",
    );
  });
});

Deno.test("adversarial: readArea still reads a benign dotted area name ('fido.general') after the traversal guard", async () => {
  const { jhr, jdt } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "Benign Sender",
      subject: "dots in an area name are fine",
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.general": { kind: "jam", jhr, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.general" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].from, "Benign Sender");
    },
  );
});

Deno.test("adversarial: readArea surfaces 'not found or unreadable' when the resolved .jhr path is actually a directory (readFileCapped throws, not silently ignored)", async () => {
  await withTempMsgbase({}, async (basePath) => {
    await Deno.mkdir(`${basePath}/fido.dirarea.jhr`, { recursive: true });
    const { ctx } = makeCtx(basePath);
    await assertRejects(
      () => run("readArea", { area: "fido.dirarea" }, ctx),
      Error,
      "not found or unreadable",
    );
  });
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
// FIXED: truncated Squish frame -> the frame is now SKIPPED entirely instead
// of decoding OOB fixed-field reads as garbage ("0:0/0" etc.) (LB6)
// ---------------------------------------------------------------------------

Deno.test("FIXED (was pin): a truncated Squish frame (XMSG cut short) is now skipped entirely instead of decoding OOB fields as zero", async () => {
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
  // Truncate to 10 bytes into the 238-byte XMSG — same fixture bytes as
  // before the fix; the `xmsgOfs + 238 > sqd.length` guard now rejects the
  // frame outright rather than reading past the end of the buffer.
  const truncated = full.slice(0, 256 + 28 + 10);
  await withTempMsgbase(
    { areas: { "fido.trunc": { kind: "squish", sqd: truncated } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.trunc" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 0);
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
// FIXED (LB3): a corrupt/truncated JAM area contributes zero matches, never
// blocks search of the rest of the msgbase, and now ALSO names itself in a
// `warnings` array instead of failing completely silently
// (fidonet_msgbase.ts's searchBySender/searchByAddress/searchByText).
//
// Correction to the plan's framing, still true post-fix: for
// searchBySender/searchByAddress/searchByText, the JAM branch's outer
// `catch` is UNREACHABLE by crafted bytes alone for THIS fixture —
// `parseJamMessages` never throws for any byte input (every read is
// bounds-guarded; `decodeText`'s only throwing call is caught internally).
// The warning below comes from the explicit `jhrData.length < 1024` check
// added alongside the catch, not from the catch firing. See the
// directory-as-`.jhr` and tiny-size-cap tests further down for cases that DO
// reach the catch itself.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was pin): a truncated/corrupt JAM area beside a good one yields only the good area's hits, with a warning naming the corrupt area, no throw", async () => {
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
      const warnings = payload.warnings as string[] | undefined;
      assert(
        warnings !== undefined &&
          warnings.some((w) => w.includes("fido.corrupt2")),
        "expected a warning naming the corrupt area",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// New LB3/LB9 coverage: a real readFile-throwing failure (via the tiny
// FIDONET_MSGBASE_MAX_BYTES cap — portable across CI environments, unlike a
// permission-denied file which some CI runners bypass as root) is surfaced
// as a warning naming the offending area, while a good sibling area is still
// searched. Doubles as LB9's "tiny env cap excludes an oversized .jhr" test.
// ---------------------------------------------------------------------------

Deno.test("adversarial: a tiny FIDONET_MSGBASE_MAX_BYTES cap excludes an oversized .jhr with a warning, while a good sibling area is still searched", async () => {
  const { jhr: smallJhr } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "Cap Test Sender",
      to: "All",
      subject: "small enough",
    }],
  });
  const { jhr: bigJhr } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "Cap Test Sender",
      to: "All",
      subject: "x".repeat(500), // pads this .jhr well past the tiny cap below
    }],
  });
  await withTempMsgbase(
    {
      areas: {
        "fido.small": { kind: "jam", jhr: smallJhr },
        "fido.big": { kind: "raw", files: { "fido.big.jhr": bigJhr } },
      },
    },
    async (basePath) => {
      Deno.env.set("FIDONET_MSGBASE_MAX_BYTES", String(smallJhr.length));
      try {
        const { ctx, written } = makeCtx(basePath);
        await run("searchBySender", { sender: "Cap Test" }, ctx);
        const payload = written[0].payload;
        const messages = payload.messages as Array<Record<string, unknown>>;
        assertEquals(messages.length, 1);
        assertEquals(messages[0].area, "fido.small");
        const warnings = payload.warnings as string[] | undefined;
        assert(
          warnings !== undefined &&
            warnings.some((w) =>
              w.includes("fido.big") && w.includes("exceeds size cap")
            ),
          "expected a warning naming the oversized area and the size cap",
        );
      } finally {
        Deno.env.delete("FIDONET_MSGBASE_MAX_BYTES");
      }
    },
  );
});

// ---------------------------------------------------------------------------
// FIXED: JAM subfields now NUL-trim, matching Squish's XMSG fixed fields
// and FTS-0001's header fields (both already NUL-truncated at the call site
// via .replace(/\0.*/, "") / .split("\0")[0]) (LB8 — see also the contract
// suite's former "dead-code UTF-8 guard" note for the other half of this
// finding, also fixed).
// ---------------------------------------------------------------------------

Deno.test("FIXED (was pin): a JAM subfield's declared datLen no longer keeps trailing NUL padding — NUL-trimmed to match Squish/FTS-0001", async () => {
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
      assertEquals(messages[0].from, "Bob");
      assertEquals((messages[0].from as string).length, 3);
    },
  );
});

// ---------------------------------------------------------------------------
// FIXED: the Squish frame-chain cycle guard (LB2, fidonet_msgbase.ts:270) —
// previously characterized STRUCTURALLY ONLY (never executed, since it would
// hang CI); `parseSquishMessages` now tracks visited frame offsets and
// breaks on a revisit, so this exact cyclic fixture can be run through
// `readArea` directly.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was structural-only pin): a crafted Squish frame chain that cycles now terminates via the visited-frame guard, returning each frame exactly once", async () => {
  const headerSize = 256;
  const sqd = buildSquishArea({
    headerSize,
    messages: [
      { from: "A", to: "All", subject: "frame A", body: "a" },
      { from: "B", to: "All", subject: "frame B", body: "b" },
    ],
    lastNextFrameOverride: headerSize, // frame B's nextFrame -> frame A's offset (cycle)
  });
  await withTempMsgbase(
    { areas: { "fido.cycle": { kind: "squish", sqd } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.cycle" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 2);
      assertEquals(messages.map((m) => m.from), ["A", "B"]);
    },
  );
});

// ---------------------------------------------------------------------------
// Structural characterization retained: confirms the fixture BYTES really do
// form a genuine cycle (independent of the guard that now handles it above).
// ---------------------------------------------------------------------------

Deno.test("sanity: the cyclic Squish fixture's bytes genuinely form a cycle — frame B's nextFrame points back at frame A", () => {
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
