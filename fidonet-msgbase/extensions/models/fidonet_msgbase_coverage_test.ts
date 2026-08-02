/**
 * Coverage suite: closes specific branch gaps the methods/contract/
 * adversarial suites don't already exercise on BOTH sides — deleting any one
 * of these guards should turn a test red. Two tests here were previously
 * PINS of found bugs (searchByText's missing Squish branch — LB4 — and its
 * `continue` dropping a whole JAM area on a missing `.jdt` — LB5); both bugs
 * are now real-fixed in `fidonet_msgbase.ts` and these tests assert the
 * FIXED behavior instead (see fidonet_msgbase_adversarial_test.ts for the
 * rest of the real-fix pass). All fixture content is synthetic — see
 * fixtures/PROVENANCE.md.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./fidonet_msgbase.ts";
import {
  buildFtsMsg,
  buildJamAreaFiles,
  buildSquishArea,
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
// offset/limit slicing
// ---------------------------------------------------------------------------

function fiveJamMessages() {
  return buildJamAreaFiles({
    activeMsgs: 5,
    messages: [1, 2, 3, 4, 5].map((n) => ({
      msgNum: n,
      dateWritten: 1000000000 + n,
      from: `Sender ${n}`,
      to: "All",
      subject: `Message ${n}`,
    })),
  });
}

Deno.test("coverage: readArea's offset+limit slice matches a manual slice of the full message list", async () => {
  const { jhr, jdt } = fiveJamMessages();
  await withTempMsgbase(
    { areas: { "fido.slice": { kind: "jam", jhr, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.slice", offset: 2, limit: 2 }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.map((m) => m.msgNum), [3, 4]);
    },
  );
});

Deno.test("coverage: readArea's default limit (100) and offset (0) return everything when there are fewer than 100 messages", async () => {
  const { jhr, jdt } = fiveJamMessages();
  await withTempMsgbase(
    { areas: { "fido.slice2": { kind: "jam", jhr, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.slice2" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 5);
    },
  );
});

// ---------------------------------------------------------------------------
// mid-scan limit cutoff for a fan-out search
// ---------------------------------------------------------------------------

Deno.test("coverage: searchBySender stops scanning once the limit is reached mid-scan, across multiple matching areas", async () => {
  const areaA = buildJamAreaFiles({
    messages: [1, 2, 3].map((n) => ({
      msgNum: n,
      dateWritten: 1000000000 + n,
      from: "Popular Sender",
      to: "All",
      subject: `A${n}`,
    })),
  });
  const areaB = buildJamAreaFiles({
    messages: [4, 5, 6].map((n) => ({
      msgNum: n,
      dateWritten: 1000000000 + n,
      from: "Popular Sender",
      to: "All",
      subject: `B${n}`,
    })),
  });
  await withTempMsgbase(
    {
      areas: {
        "fido.a": { kind: "jam", jhr: areaA.jhr, jdt: areaA.jdt },
        "fido.b": { kind: "jam", jhr: areaB.jhr, jdt: areaB.jdt },
      },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("searchBySender", { sender: "Popular", limit: 2 }, ctx);
      const payload = written[0].payload;
      assertEquals(payload.count, 2);
      const messages = payload.messages as Array<Record<string, unknown>>;
      assertEquals(messages.length, 2);
    },
  );
});

// ---------------------------------------------------------------------------
// netmail fallback: scanned only when under limit, skipped once limit is met
// ---------------------------------------------------------------------------

Deno.test("coverage: netmail is scanned when results are still under limit after area scans", async () => {
  const { jhr, jdt } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "Netmail Match Target",
      to: "All",
      subject: "area hit",
    }],
  });
  const nm = buildFtsMsg({
    from: "Netmail Match Target",
    to: "All",
    subject: "netmail hit",
    bodyLines: ["x"],
  });
  await withTempMsgbase(
    {
      areas: { "fido.one": { kind: "jam", jhr, jdt } },
      netmail: { "1.msg": nm },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run(
        "searchBySender",
        { sender: "Netmail Match Target", limit: 200 },
        ctx,
      );
      const payload = written[0].payload;
      assertEquals(payload.count, 2); // both the area hit AND the netmail hit
    },
  );
});

Deno.test("coverage: netmail is SKIPPED once the area scan already reached the limit", async () => {
  const { jhr, jdt } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "Limited Sender",
      to: "All",
      subject: "area hit only",
    }],
  });
  const nm = buildFtsMsg({
    from: "Limited Sender",
    to: "All",
    subject: "netmail hit that must not appear",
    bodyLines: ["x"],
  });
  await withTempMsgbase(
    {
      areas: { "fido.one": { kind: "jam", jhr, jdt } },
      netmail: { "1.msg": nm },
    },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run(
        "searchBySender",
        { sender: "Limited Sender", limit: 1 }, // limit satisfied by the area alone
        ctx,
      );
      const payload = written[0].payload;
      assertEquals(payload.count, 1);
      const messages = payload.messages as Array<Record<string, unknown>>;
      assertEquals(messages[0].area, "fido.one");
    },
  );
});

// ---------------------------------------------------------------------------
// searchByAddress: point-vs-node — a node search must NOT numeric-prefix-
// match a different node that merely shares leading digits
// ---------------------------------------------------------------------------

Deno.test("coverage: searchByAddress node search does not falsely match a different node sharing a numeric prefix", async () => {
  const { jhr, jdt } = buildJamAreaFiles({
    messages: [
      {
        msgNum: 1,
        dateWritten: 1000000000,
        from: "A",
        to: "All",
        address: "2:5020/1",
      },
      {
        msgNum: 2,
        dateWritten: 1000000001,
        from: "B",
        to: "All",
        address: "2:5020/10", // shares the leading digit "1" with node 1 — must not match
      },
    ],
  });
  await withTempMsgbase(
    { areas: { "fido.prefix": { kind: "jam", jhr, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("searchByAddress", { address: "2:5020/1" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].address, "2:5020/1");
    },
  );
});

Deno.test("coverage: searchByAddress node search DOES match that node's points via the dot-prefix rule", async () => {
  const { jhr, jdt } = buildJamAreaFiles({
    messages: [
      {
        msgNum: 1,
        dateWritten: 1000000000,
        from: "Point Holder",
        to: "All",
        address: "2:5020/1.5",
      },
    ],
  });
  await withTempMsgbase(
    { areas: { "fido.point": { kind: "jam", jhr, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("searchByAddress", { address: "2:5020/1" }, ctx);
      const messages = written[0].payload.messages as Array<
        Record<string, unknown>
      >;
      assertEquals(messages.length, 1);
      assertEquals(messages[0].address, "2:5020/1.5");
    },
  );
});

// ---------------------------------------------------------------------------
// FIXED (LB4): searchByText previously excluded ALL Squish areas — no .sqd
// branch at all (was fidonet_msgbase.ts:1133) — now mirrors searchBySender's
// Squish handling.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was pin): searchByText now finds a hit in a Squish-only area", async () => {
  const sqd = buildSquishArea({
    messages: [{
      from: "Squish Author",
      to: "All",
      subject: "does not matter",
      body: "the unmistakable needle text is right here",
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.squishtext": { kind: "squish", sqd } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("searchByText", { text: "unmistakable needle" }, ctx);
      const payload = written[0].payload;
      assertEquals(payload.count, 1);
      const messages = payload.messages as Array<Record<string, unknown>>;
      assertEquals(messages[0].from, "Squish Author");
      assertEquals(messages[0].format, "squish");
    },
  );
});

// ---------------------------------------------------------------------------
// FIXED (LB5): searchByText previously dropped an entire JAM area when its
// .jdt was missing — even subject/from matches were lost (was
// fidonet_msgbase.ts:1150) — now tolerates a missing .jdt like readArea and
// searchBySender do, with an empty body.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was pin): searchByText now finds a subject match in a JAM area whose .jdt sibling is missing", async () => {
  const { jhr } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "No Jdt Sender",
      to: "All",
      subject: "findme in the subject line",
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.nojdttext": { kind: "jam", jhr } } }, // jdt omitted
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("searchByText", { text: "findme" }, ctx);
      const payload = written[0].payload;
      assertEquals(payload.count, 1);
      const messages = payload.messages as Array<Record<string, unknown>>;
      assertEquals(messages[0].from, "No Jdt Sender");
      assertEquals(messages[0].body, "");
    },
  );
});

Deno.test("coverage: searchByText DOES find a subject match in a JAM area that has its .jdt sibling", async () => {
  const { jhr, jdt } = buildJamAreaFiles({
    messages: [{
      msgNum: 1,
      dateWritten: 1000000000,
      from: "Has Jdt Sender",
      to: "All",
      subject: "findme in the subject line",
    }],
  });
  await withTempMsgbase(
    { areas: { "fido.hasjdttext": { kind: "jam", jhr, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("searchByText", { text: "findme" }, ctx);
      assertEquals(written[0].payload.count, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// listAreas: an empty netmail directory contributes no "netmail" area
// ---------------------------------------------------------------------------

Deno.test("coverage: listAreas omits the netmail entry entirely when the netmail directory has zero .msg files", async () => {
  await withTempMsgbase({ netmail: {} }, async (basePath) => {
    const { ctx, written } = makeCtx(basePath);
    await run("listAreas", {}, ctx);
    const areas = written[0].payload.areas as Array<Record<string, unknown>>;
    assert(!areas.some((a) => a.name === "netmail"));
  });
});

// ---------------------------------------------------------------------------
// formatForObsidian: dedup counting beyond 2 collisions, and both throws
// ---------------------------------------------------------------------------

Deno.test("coverage: formatForObsidian's dedup counter keeps incrementing past (2) for 4+ collisions", async () => {
  const { jhr, jdt } = buildJamAreaFiles({
    messages: [1, 2, 3, 4].map((n) => ({
      msgNum: n,
      dateWritten: 1000000000,
      from: `Sender ${n}`,
      subject: "Collide",
    })),
  });
  await withTempMsgbase(
    { areas: { "fido.dupmany": { kind: "jam", jhr, jdt } } },
    async (basePath) => {
      const { ctx, written } = makeCtx(basePath);
      await run("readArea", { area: "fido.dupmany" }, ctx);
      await run("formatForObsidian", { source: "area_fido.dupmany" }, ctx);
      const notes = written.find((w) =>
        w.name === "obsidian_area_fido.dupmany"
      )!
        .payload.messages as Array<Record<string, unknown>>;
      const suffixes = notes.map((n) =>
        (n.obsidianPath as string).match(/\((\d+)\)$/)?.[1]
      );
      assertEquals(suffixes, [undefined, "2", "3", "4"]);
    },
  );
});

Deno.test("coverage: formatForObsidian throws 'No stored data' for an unknown source name", async () => {
  await withTempMsgbase({}, async (basePath) => {
    const { ctx } = makeCtx(basePath);
    await assertRejects(
      () => run("formatForObsidian", { source: "never_written" }, ctx),
      Error,
      "No stored data",
    );
  });
});

Deno.test("coverage: formatForObsidian throws 'No messages in stored data' when the stored resource has zero messages", async () => {
  await withTempMsgbase({ netmail: {} }, async (basePath) => {
    const { ctx } = makeCtx(basePath);
    await run("readNetmail", {}, ctx); // writes 'netmail' with count 0
    await assertRejects(
      () => run("formatForObsidian", { source: "netmail" }, ctx),
      Error,
      "No messages in stored data",
    );
  });
});
