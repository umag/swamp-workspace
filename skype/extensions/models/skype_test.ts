/**
 * Contract-fixture suite: pins the CONCRETE `sqlite3 -ascii <db> <sql>` wire
 * contract from skype/fixtures/*.tsv directly — the column order -> object
 * mapping for each of the four query shapes, `stripXml`'s tag strip + entity
 * decode, `tsToIso`'s cap/empty branches, and the baseline (non-hostile)
 * ascii-framed split. Independent of any live `sqlite3` invocation or real
 * `main.db`.
 *
 * Since 2026.08.01.1 (BUG #1 fix) the fixtures are framed with 0x1F
 * (column)/0x1E (record) bytes, not tab/newline — see fixtures/PROVENANCE.md
 * and CHANGELOG.md.
 *
 * All fixtures are PURE hand-authored synthetic data — see
 * fixtures/PROVENANCE.md. Every test here is offline: the `Deno.Command`
 * constructor is stubbed for the duration of each test, so no subprocess is
 * ever actually spawned.
 *
 * skype.ts is otherwise BYTE-FROZEN by this change — every test here
 * characterizes already-shipped behavior. It is not red-green TDD.
 *
 * Toolchain rule (deno 2.8.3 in CI): the `Deno.Command` seam is installed via
 * `(globalThis as any).Deno.Command = FakeCommand`, never a
 * `as typeof Deno.Command` cast — see STANDARD.md / the plan's "Deno skew"
 * constraint.
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

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
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
      logger: { info: () => {}, warn: () => {} },
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

async function loadFixture(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../fixtures/${name}`, import.meta.url),
  );
}

type CommandResult = { success: boolean; stdout: string; stderr: string };
type SqlRouter = (sql: string) => CommandResult;

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
      calls.push(this.#sql);
    }
    output() {
      const r = router(this.#sql);
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

/** Route canned stdout by which table the SQL's FROM clause targets — every
 * skype.ts query has exactly one of these as its FROM target (search methods
 * JOIN Conversations but FROM Messages, so they never collide with the
 * "FROM Conversations" match). */
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

function isoOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
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
// listConversations — conversations.tsv (7 columns)
// ---------------------------------------------------------------------------

Deno.test("contract: listConversations pins the 7-column -> object mapping, incl. displayname/identity fallback and tsToIso empty/cap branches", async () => {
  const conversations = await loadFixture("conversations.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations }),
    () => run("listConversations", {}, ctx),
  );
  const res = written.find((w) => w.spec === "conversations")!;
  const rows = res.payload.conversations as Array<Record<string, unknown>>;
  assertEquals(rows.length, 4);
  assertEquals(res.payload.count, 4);

  assertEquals(rows[0], {
    id: 1,
    identity: "live:.cid.fake0001",
    displayname: "Ana Synthetic",
    type: 1,
    messageCount: 42,
    firstMessage: isoOf(1700000000),
    lastMessage: isoOf(1700100000),
  });

  assertEquals(rows[1].displayname, "Fixture Book Club");
  assertEquals(rows[1].type, 2);

  // Row 3: empty displayname falls back to identity; ts=0 on both ends -> "".
  assertEquals(rows[2].displayname, "live:.cid.fake0002");
  assertEquals(rows[2].firstMessage, "");
  assertEquals(rows[2].lastMessage, "");

  // Row 4: first_ts exceeds the 4102444800 cap -> "", last_ts is valid.
  assertEquals(rows[3].firstMessage, "");
  assertEquals(rows[3].lastMessage, isoOf(1690600000));
});

// ---------------------------------------------------------------------------
// listContacts — contacts.tsv (5 columns)
// ---------------------------------------------------------------------------

Deno.test("contract: listContacts pins the 5-column -> object mapping, incl. missing-trailing-column fallback to ''", async () => {
  const contacts = await loadFixture("contacts.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ contacts }),
    () => run("listContacts", {}, ctx),
  );
  const res = written.find((w) => w.spec === "contacts")!;
  const rows = res.payload.contacts as Array<Record<string, unknown>>;
  assertEquals(rows.length, 3);
  assertEquals(rows[0], {
    id: 1,
    skypename: "fixture.contact.one",
    fullname: "Carla Example",
    city: "Rotterdam",
    country: "Netherlands",
  });
  assertEquals(rows[1], {
    id: 2,
    skypename: "fixture.contact.two",
    fullname: "",
    city: "",
    country: "",
  });
  assertEquals(rows[2].fullname, "Deniz Sample");
});

// ---------------------------------------------------------------------------
// readConversation — messages_read.tsv (9 columns) + stripXml
// ---------------------------------------------------------------------------

Deno.test("contract: readConversation pins the 9-column -> object mapping, authorDisplay fallback, and stripXml tag+entity decode", async () => {
  const conversations = asciiTable([
    ["1", "live:.cid.fake0001", "Ana Synthetic"],
  ]);
  const messages = await loadFixture("messages_read.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("readConversation", { conversation: "Ana Synthetic" }, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const rows = res.payload.messages as Array<Record<string, unknown>>;
  assertEquals(rows.length, 2);

  assertEquals(rows[0], {
    id: 1,
    convoId: 1,
    author: "live:.cid.fake0001",
    authorDisplay: "Ana Synthetic",
    timestamp: 1700000000,
    date: isoOf(1700000000),
    type: 61,
    body: "Hello & welcome!",
    chatname: "",
    dialogPartner: "",
  });

  // Row 2: empty from_dispname falls back to author; <b>...</b> stripped and
  // &lt;/&gt; entities decoded.
  assertEquals(rows[1].authorDisplay, "live:.cid.fake0002");
  assertEquals(rows[1].body, "bold text with <tag>");
  assertEquals(rows[1].chatname, "ChatRoomFixture");
  assertEquals(rows[1].dialogPartner, "live:.cid.fake0001");
});

Deno.test("contract: readConversation — conversation not found (empty Conversations result) throws", async () => {
  const { ctx } = makeCtx();
  let threw: unknown;
  await withSqliteStub(
    byTable({ conversations: "" }),
    async () => {
      try {
        await run("readConversation", { conversation: "Nobody" }, ctx);
      } catch (err) {
        threw = err;
      }
    },
  );
  assert(threw instanceof Error);
  assertEquals((threw as Error).message, "Conversation 'Nobody' not found");
});

// ---------------------------------------------------------------------------
// searchBySender / searchByText — messages_search.tsv (10 columns)
// ---------------------------------------------------------------------------

Deno.test("contract: searchBySender pins the 10-column -> object mapping incl. conversationName", async () => {
  const messages = await loadFixture("messages_search.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ messages }),
    () => run("searchBySender", { sender: "fake0001" }, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const rows = res.payload.messages as Array<Record<string, unknown>>;
  assertEquals(rows.length, 2);
  assertEquals(rows[0].conversationName, "Fixture Book Club");
  assertEquals(rows[0].body, "found lunch plans");
  assertEquals(rows[1].conversationName, "Ana Synthetic");
  assertEquals(res.payload.query, "sender:fake0001");
});

Deno.test("contract: searchByText pins the same 10-column mapping via the text query", async () => {
  const messages = await loadFixture("messages_search.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ messages }),
    () => run("searchByText", { text: "lunch" }, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals(res.payload.query, "text:lunch");
  const rows = res.payload.messages as Array<Record<string, unknown>>;
  assertEquals(rows.length, 2);
});

// ---------------------------------------------------------------------------
// exportToObsidian — 4-column per-conversation message projection
// ---------------------------------------------------------------------------

Deno.test("contract: exportToObsidian pins the note shape and formats the 4-column message projection into a chat log", async () => {
  const conversations = await loadFixture("conversations.tsv");
  const messages = await loadFixture("messages_export.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", {}, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const notes = res.payload.messages as Array<Record<string, unknown>>;
  assertEquals(notes.length, 4, "one note per conversation row");
  const note = notes[0];
  assert(typeof note.obsidianPath === "string");
  assert(typeof note.obsidianContent === "string");
  const content = note.obsidianContent as string;
  assert(content.startsWith("---\n"), "note begins with YAML frontmatter");
  assert(
    content.includes("Hello there, exporting & testing."),
    "entity-decoded body appears in the chat log",
  );
  assert(
    content.includes("reply without display name"),
    "tag-stripped body from the display-name-less row appears",
  );
  // messageCount echoes the conv-list row's declared count, NOT a recount of
  // the (stubbed, identical-per-row) message fetch — pinned precisely because
  // it looks like it should be a recount but isn't.
  assertEquals(note.messageCount, 42);
});

// ---------------------------------------------------------------------------
// tsToIso cap/empty branches, pinned directly via listConversations
// ---------------------------------------------------------------------------

Deno.test("contract: tsToIso — non-numeric timestamp string yields ''", async () => {
  const conversations = asciiTable([
    [
      "9",
      "live:.cid.fake0009",
      "NaN Fixture",
      "1",
      "1",
      "not-a-number",
      "not-a-number",
    ],
  ]);
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations }),
    () => run("listConversations", {}, ctx),
  );
  const res = written.find((w) => w.spec === "conversations")!;
  const rows = res.payload.conversations as Array<Record<string, unknown>>;
  assertEquals(rows[0].firstMessage, "");
  assertEquals(rows[0].lastMessage, "");
});
