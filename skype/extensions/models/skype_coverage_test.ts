/**
 * Coverage suite: regression tests closing gaps a code reviewer found — every
 * `|| ""`/`|| 0` falsy guard on both sides, `tsToIso`'s full branch table
 * (including the exact 4102444800 cap boundary), default-argument
 * interpolation for every method, `exportToObsidian`'s type-name/date-header/
 * empty-body-skip branches, `importToObsidian`'s chunking-loop and
 * progress-log boundaries, and (since 2026.08.01.1) queryDb's ascii-framing
 * record-separator boundary (single-row / empty-result).
 *
 * skype.ts is otherwise BYTE-FROZEN by this change — every other test here
 * PINS already-shipped behavior. It is not red-green TDD except for the two
 * new boundary tests, which characterize the BUG #1 fix's own edge cases.
 * All `sqlite3` stdout stubs use the local `asciiTable()` helper (0x1F/0x1E
 * framing) since queryDb no longer parses TSV.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./skype.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  basePath: "/fixtures/skype-data",
  profile: "synthetic-user",
};

type Written = { spec: string; name: string; payload: Record<string, unknown> };
type LogCall = { level: "info" | "warn"; args: unknown[] };

function makeCtx() {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs: GLOBAL_ARGS,
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: {
        info: (...args: unknown[]) => logs.push({ level: "info", args }),
        warn: (...args: unknown[]) => logs.push({ level: "warn", args }),
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

type CommandResult = { success: boolean; stdout: string; stderr: string };
type SqlRouter = (sql: string, callIndex: number) => CommandResult;

function installSqliteStub(router: SqlRouter) {
  const encoder = new TextEncoder();
  const calls: string[] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    #sql: string;
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      const args = options.args ?? [];
      this.#sql = args[args.length - 1] ?? "";
    }
    output() {
      const idx = calls.length;
      calls.push(this.#sql);
      const r = router(this.#sql, idx);
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        stdout: encoder.encode(r.stdout),
        stderr: encoder.encode(r.stderr),
      });
    }
  }
  g.Deno.Command = FakeCommand;
  return {
    calls,
    restore: () => {
      g.Deno.Command = original;
    },
  };
}

async function withSqliteStub(
  router: SqlRouter,
  fn: (stub: ReturnType<typeof installSqliteStub>) => Promise<unknown>,
) {
  const stub = installSqliteStub(router);
  try {
    await fn(stub);
  } finally {
    stub.restore();
  }
}

function byTable(
  routes: { conversations?: string; messages?: string; contacts?: string },
): SqlRouter {
  return (sql: string) => {
    if (routes.conversations !== undefined && /FROM Conversations/.test(sql)) {
      return { success: true, stdout: routes.conversations, stderr: "" };
    }
    if (routes.messages !== undefined && /FROM Messages/.test(sql)) {
      return { success: true, stdout: routes.messages, stderr: "" };
    }
    if (routes.contacts !== undefined && /FROM Contacts/.test(sql)) {
      return { success: true, stdout: routes.contacts, stderr: "" };
    }
    throw new Error(`unrouted sql: ${sql}`);
  };
}

/** Frame rows the way real `sqlite3 -ascii` does: columns joined by 0x1F
 * (unit separator), every record (including the last) terminated by 0x1E
 * (record separator). Mirrors queryDb's own parse exactly. */
function asciiTable(rows: string[][]): string {
  const US = "\x1F";
  const RS = "\x1E";
  return rows.map((r) => r.join(US) + RS).join("");
}

// ---------------------------------------------------------------------------
// queryDb ascii-framing boundary: single-row + empty-result (BUG #1 fix)
// ---------------------------------------------------------------------------

Deno.test("guard: a single-row ascii result is not fabricated into two rows by the trailing 0x1E terminator", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({
      conversations: asciiTable([["1", "live:.cid.fake0001", "Fixture"]]),
    }),
    () => run("listConversations", {}, ctx),
  );
  const rows = written[0].payload.conversations as Array<
    Record<string, unknown>
  >;
  assertEquals(
    rows.length,
    1,
    "the trailing empty record after the last 0x1E must be dropped, not fabricated into a blank second row",
  );
});

Deno.test("guard: an empty ascii result (zero records) yields zero rows, not one blank row", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: "" }),
    () => run("listConversations", {}, ctx),
  );
  const rows = written[0].payload.conversations as Array<
    Record<string, unknown>
  >;
  assertEquals(rows.length, 0);
  assertEquals(written[0].payload.count, 0);
});

// ---------------------------------------------------------------------------
// tsToIso — full branch table, pinned via listConversations
// ---------------------------------------------------------------------------

function convRowWithTs(first: string, last: string): string {
  return asciiTable([
    ["1", "live:.cid.fake0001", "Fixture", "1", "1", first, last],
  ]);
}

Deno.test("guard: tsToIso — ts exactly 0 yields ''", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: convRowWithTs("0", "0") }),
    () => run("listConversations", {}, ctx),
  );
  const row =
    (written[0].payload.conversations as Array<Record<string, unknown>>)[0];
  assertEquals(row.firstMessage, "");
  assertEquals(row.lastMessage, "");
});

Deno.test("guard: tsToIso — a negative ts yields ''", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: convRowWithTs("-100", "-1") }),
    () => run("listConversations", {}, ctx),
  );
  const row =
    (written[0].payload.conversations as Array<Record<string, unknown>>)[0];
  assertEquals(row.firstMessage, "");
  assertEquals(row.lastMessage, "");
});

Deno.test("guard: tsToIso — exactly the 4102444800 cap boundary is STILL valid (only strictly greater is rejected)", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: convRowWithTs("4102444800", "4102444801") }),
    () => run("listConversations", {}, ctx),
  );
  const row =
    (written[0].payload.conversations as Array<Record<string, unknown>>)[0];
  assertEquals(row.firstMessage, new Date(4102444800 * 1000).toISOString());
  assertEquals(row.lastMessage, "", "one second past the cap is rejected");
});

Deno.test("guard: tsToIso — ts of exactly 1 (smallest valid positive) produces a valid ISO string", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: convRowWithTs("1", "1") }),
    () => run("listConversations", {}, ctx),
  );
  const row =
    (written[0].payload.conversations as Array<Record<string, unknown>>)[0];
  assertEquals(row.firstMessage, new Date(1000).toISOString());
});

// ---------------------------------------------------------------------------
// listConversations / listContacts — `|| ""` / `|| 0` fallback guards
// ---------------------------------------------------------------------------

Deno.test("guard: listConversations — a row missing the type column entirely defaults type to 0", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({
      conversations: asciiTable([["1", "live:.cid.fake0001", "Fixture"]]),
    }),
    () => run("listConversations", {}, ctx),
  );
  const row =
    (written[0].payload.conversations as Array<Record<string, unknown>>)[0];
  assertEquals(row.type, 0);
  assertEquals(row.messageCount, 0);
});

Deno.test("guard: listConversations — identity missing entirely defaults to '' (not 'undefined')", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: asciiTable([["1"]]) }),
    () => run("listConversations", {}, ctx),
  );
  const row =
    (written[0].payload.conversations as Array<Record<string, unknown>>)[0];
  assertEquals(row.identity, "");
  assertEquals(row.displayname, "");
});

// ---------------------------------------------------------------------------
// Default-argument interpolation across every SQL-issuing method
// ---------------------------------------------------------------------------

Deno.test("guard: exportToObsidian/importToObsidian default minMessages=1 in the HAVING clause", async () => {
  const { ctx } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: "", messages: "" }),
    async (stub) => {
      await run("exportToObsidian", {}, ctx);
      assert(stub.calls[0].includes("HAVING msg_count >= 1"));
    },
  );
});

Deno.test("guard: exportToObsidian — an explicit minMessages is interpolated verbatim", async () => {
  const { ctx } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: "", messages: "" }),
    async (stub) => {
      await run("exportToObsidian", { minMessages: 7 }, ctx);
      assert(stub.calls[0].includes("HAVING msg_count >= 7"));
    },
  );
});

// ---------------------------------------------------------------------------
// exportToObsidian — typeName mapping (both branches)
// ---------------------------------------------------------------------------

Deno.test("guard: exportToObsidian — convoType 2 maps to 'group', anything else maps to 'direct'", async () => {
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fakeGroup",
      "Group One",
      "2",
      "1",
      "1700000000",
      "1700000000",
    ],
    [
      "2",
      "live:.cid.fakeDirect",
      "Direct One",
      "1",
      "1",
      "1700000000",
      "1700000000",
    ],
    [
      "3",
      "live:.cid.fakeOther",
      "Other Type",
      "99",
      "1",
      "1700000000",
      "1700000000",
    ],
  ]);
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages: "" }),
    () => run("exportToObsidian", {}, ctx),
  );
  const notes = written[0].payload.messages as Array<
    { obsidianContent: string }
  >;
  assert(notes[0].obsidianContent.includes("type: group"));
  assert(notes[0].obsidianContent.includes("skype-group"));
  assert(notes[1].obsidianContent.includes("type: direct"));
  assert(
    notes[2].obsidianContent.includes("type: direct"),
    "any non-2 type falls back to direct",
  );
});

// ---------------------------------------------------------------------------
// exportToObsidian — empty-body messages are skipped entirely
// ---------------------------------------------------------------------------

Deno.test("guard: exportToObsidian — a message whose stripped body is blank/whitespace-only is skipped from the chat log", async () => {
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fake0001",
      "Fixture",
      "1",
      "2",
      "1700000000",
      "1700000100",
    ],
  ]);
  const messages = asciiTable([
    ["Ana", "live:.cid.fake0001", "1700000000", "   "], // whitespace-only after strip
    ["Boris", "live:.cid.fake0002", "1700000100", "<b></b>"], // tags strip to ""
  ]);
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", {}, ctx),
  );
  const notes = written[0].payload.messages as Array<
    { obsidianContent: string }
  >;
  assert(!notes[0].obsidianContent.includes("Ana:"));
  assert(!notes[0].obsidianContent.includes("Boris:"));
  assert(
    !notes[0].obsidianContent.includes("###"),
    "no date header is emitted either, since every message on that date was skipped",
  );
});

Deno.test("guard: exportToObsidian — a message with an invalid/zero timestamp is skipped even with a real body", async () => {
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fake0001",
      "Fixture",
      "1",
      "1",
      "1700000000",
      "1700000000",
    ],
  ]);
  const messages = asciiTable([
    ["Ana", "live:.cid.fake0001", "0", "Real body text"],
  ]);
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", {}, ctx),
  );
  const notes = written[0].payload.messages as Array<
    { obsidianContent: string }
  >;
  assert(!notes[0].obsidianContent.includes("Real body text"));
});

// ---------------------------------------------------------------------------
// exportToObsidian — date-header grouping only changes when the date changes
// ---------------------------------------------------------------------------

Deno.test("guard: exportToObsidian — consecutive same-day messages share ONE date header; a new day emits a new one", async () => {
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fake0001",
      "Fixture",
      "1",
      "3",
      "1700000000",
      "1700200000",
    ],
  ]);
  const messages = asciiTable([
    ["Ana", "live:.cid.fake0001", "1700000000", "First message"],
    ["Ana", "live:.cid.fake0001", "1700003600", "Second message same day"],
    ["Ana", "live:.cid.fake0001", "1700200000", "Third message next day"],
  ]);
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", {}, ctx),
  );
  const content =
    (written[0].payload.messages as Array<{ obsidianContent: string }>)[0]
      .obsidianContent;
  const headerCount = (content.match(/### \d{4}-\d{2}-\d{2}/g) ?? []).length;
  assertEquals(
    headerCount,
    2,
    "two distinct days -> exactly two headers, not three",
  );
});

// ---------------------------------------------------------------------------
// importToObsidian — chunking loop boundary + progress log
// ---------------------------------------------------------------------------

Deno.test("guard: importToObsidian — a message-fetch batch returning FEWER rows than chunkSize (10000) stops after ONE iteration", async () => {
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fake0001",
      "Fixture",
      "1",
      "2",
      "1700000000",
      "1700000100",
    ],
  ]);
  const messages = asciiTable([
    ["Ana", "live:.cid.fake0001", "1700000000", "Hello"],
    ["Ana", "live:.cid.fake0001", "1700000100", "World"],
  ]);
  const vault = await Deno.makeTempDir();
  try {
    const { ctx } = makeCtx();
    let messageFetchCount = 0;
    await withSqliteStub(
      (sql) => {
        if (/FROM Conversations/.test(sql)) {
          return { success: true, stdout: conversations, stderr: "" };
        }
        if (/FROM Messages/.test(sql)) {
          messageFetchCount++;
          return { success: true, stdout: messages, stderr: "" };
        }
        throw new Error(`unrouted: ${sql}`);
      },
      () => run("importToObsidian", { vaultPath: vault }, ctx),
    );
    assertEquals(
      messageFetchCount,
      1,
      "2 rows < chunkSize(10000) -> the while(true) loop breaks after its first fetch",
    );
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("guard: importToObsidian — logs a 'Progress' line only when written is a positive multiple of 20", async () => {
  const rows = asciiTable(
    Array.from(
      { length: 20 },
      (_, i) => [
        String(i),
        `live:.cid.fake${i}`,
        `Convo ${i}`,
        "1",
        "1",
        String(1700000000 + i),
        String(1700000000 + i),
      ],
    ),
  );
  const vault = await Deno.makeTempDir();
  try {
    const { ctx, logs } = makeCtx();
    await withSqliteStub(
      byTable({
        conversations: rows,
        messages: asciiTable([["Ana", "live:.cid.fake0", "1700000000", "Hi"]]),
      }),
      () => run("importToObsidian", { vaultPath: vault }, ctx),
    );
    const progressLogs = logs.filter((l) =>
      l.level === "info" &&
      typeof l.args[0] === "string" &&
      (l.args[0] as string).startsWith("Progress:")
    );
    assertEquals(
      progressLogs.length,
      1,
      "exactly one Progress log fires, at written === 20",
    );
    assertEquals(
      progressLogs[0].args[0],
      "Progress: 20/20 conversations written",
    );
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// searchBySender / searchByText — LIKE pattern wraps the escaped needle
// ---------------------------------------------------------------------------

Deno.test("guard: searchBySender — a needle containing a single quote is escaped before being wrapped in '%...%'", async () => {
  const { ctx } = makeCtx();
  await withSqliteStub(byTable({ messages: "" }), async (stub) => {
    await run("searchBySender", { sender: "O'Brien" }, ctx);
    assert(stub.calls[0].includes("LIKE '%O''Brien%'"));
  });
});

Deno.test("guard: searchByText — a needle containing a single quote is escaped before being wrapped in '%...%'", async () => {
  const { ctx } = makeCtx();
  await withSqliteStub(byTable({ messages: "" }), async (stub) => {
    await run("searchByText", { text: "it's here" }, ctx);
    assert(stub.calls[0].includes("LIKE '%it''s here%'"));
  });
});

// ---------------------------------------------------------------------------
// listContacts — dbPath interpolation pin (shared template across methods)
// ---------------------------------------------------------------------------

Deno.test("guard: every method builds dbPath as '<basePath>/<profile>/main.db' — pinned via a distinctive basePath/profile pair", async () => {
  const ctxObj = {
    globalArgs: {
      basePath: "/srv/skype-archive",
      profile: "weird profile name",
    },
    writeResource: (spec: string, name: string, payload: unknown) =>
      Promise.resolve({ spec, name, payload }),
    logger: { info: () => {}, warn: () => {} },
  };
  const encoder = new TextEncoder();
  const capturedArgs: string[][] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    constructor(_cmd: string, options: { args?: string[] } = {}) {
      capturedArgs.push(options.args ?? []);
    }
    output() {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: encoder.encode(""),
        stderr: encoder.encode(""),
      });
    }
  }
  g.Deno.Command = FakeCommand;
  try {
    await run("listContacts", {}, ctxObj);
  } finally {
    g.Deno.Command = original;
  }
  assertEquals(capturedArgs.length, 1);
  assertEquals(
    capturedArgs[0][1],
    "/srv/skype-archive/weird profile name/main.db",
    "dbPath is argv[1] — sandwiched between the -ascii flag and the SQL text",
  );
});
