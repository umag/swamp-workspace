/**
 * Method-level tests for @magistr/skype — every one of the 8 methods
 * (listProfiles, listConversations, listContacts, readConversation,
 * searchBySender, searchByText, exportToObsidian, importToObsidian), happy
 * path + failure path where one exists, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()`.
 *
 * `listProfiles` is exercised against a REAL filesystem (`Deno.makeTempDir` +
 * real `Deno.readDir`/`Deno.stat`) per the plan's test-seam split. Every other
 * method's `sqlite3` subprocess is stubbed via a fake `Deno.Command` — no
 * subprocess is ever spawned and no network call is made. `importToObsidian`
 * writes into a REAL temp vault directory read back by the test.
 *
 * Since 2026.08.01.1, `sqlite3` stdout is stubbed in the real `-ascii` wire
 * shape (0x1F column / 0x1E record separator, via the local `asciiTable()`
 * helper) — queryDb no longer parses TSV framing (BUG #1 fix, see the
 * adversarial suite). Every test here is otherwise a characterization test
 * that PINS the model's current, already-shipped behavior. It is not
 * red-green TDD: there is no new behavior to drive out.
 *
 * Toolchain rule (deno 2.8.3 in CI): the `Deno.Command` seam is installed via
 * `(globalThis as any).Deno.Command = FakeCommand`, never a
 * `as typeof Deno.Command` cast.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
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

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs,
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

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
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
// listProfiles — real filesystem, no Deno.Command involved
// ---------------------------------------------------------------------------

Deno.test("listProfiles: happy path — lists only subdirectories containing main.db", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/alice`, { recursive: true });
    await Deno.writeTextFile(`${root}/alice/main.db`, "fixture-not-a-real-db");
    await Deno.mkdir(`${root}/bob`, { recursive: true });
    await Deno.writeTextFile(`${root}/bob/main.db`, "fixture-not-a-real-db");
    await Deno.mkdir(`${root}/no-db-here`, { recursive: true });
    // A stray file at basePath's top level (not a directory) must be ignored.
    await Deno.writeTextFile(`${root}/stray.txt`, "not a profile dir");

    const { ctx, written } = makeCtx({ basePath: root, profile: "alice" });
    await run("listProfiles", {}, ctx);
    const res = written.find((w) => w.spec === "conversations")!;
    const names = (res.payload.conversations as Array<{ identity: string }>)
      .map((c) => c.identity).sort();
    assertEquals(names, ["alice", "bob"]);
    assertEquals(res.payload.count, 2);
    assertEquals(res.payload.profile, "all");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("listProfiles: an empty basePath yields zero profiles, not an error", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { ctx, written } = makeCtx({ basePath: root, profile: "x" });
    await run("listProfiles", {}, ctx);
    const res = written.find((w) => w.spec === "conversations")!;
    assertEquals(res.payload.count, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// listConversations
// ---------------------------------------------------------------------------

Deno.test("listConversations: happy path — default minMessages=1 is interpolated into the HAVING clause", async () => {
  const conversations = await loadFixture("conversations.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(byTable({ conversations }), async (stub) => {
    await run("listConversations", {}, ctx);
    assert(stub.calls[0].includes("HAVING msg_count >= 1"));
  });
  const res = written.find((w) => w.spec === "conversations")!;
  assertEquals(res.name, "conv_list");
  assertEquals((res.payload.conversations as unknown[]).length, 4);
  assertEquals(res.payload.profile, "synthetic-user");
});

Deno.test("listConversations: an explicit minMessages is interpolated verbatim", async () => {
  const conversations = await loadFixture("conversations.tsv");
  const { ctx } = makeCtx();
  await withSqliteStub(byTable({ conversations }), async (stub) => {
    await run("listConversations", { minMessages: 10 }, ctx);
    assert(stub.calls[0].includes("HAVING msg_count >= 10"));
  });
});

Deno.test("listConversations: an empty result set yields count 0", async () => {
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: "" }),
    () => run("listConversations", {}, ctx),
  );
  const res = written.find((w) => w.spec === "conversations")!;
  assertEquals(res.payload.count, 0);
  assertEquals(res.payload.conversations, []);
});

// ---------------------------------------------------------------------------
// listContacts
// ---------------------------------------------------------------------------

Deno.test("listContacts: happy path — filters WHERE is_permanent = 1, orders by fullname", async () => {
  const contacts = await loadFixture("contacts.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(byTable({ contacts }), async (stub) => {
    await run("listContacts", {}, ctx);
    assert(stub.calls[0].includes("WHERE is_permanent = 1"));
    assert(stub.calls[0].includes("ORDER BY fullname"));
  });
  const res = written.find((w) => w.spec === "contacts")!;
  assertEquals(res.name, "contact_list");
  assertEquals((res.payload.contacts as unknown[]).length, 3);
});

// ---------------------------------------------------------------------------
// readConversation
// ---------------------------------------------------------------------------

Deno.test("readConversation: happy path — found by identity OR displayname, writes conv_<safeKey>", async () => {
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
  assertEquals(res.name, "conv_Ana_Synthetic");
  assertEquals(res.payload.conversation, "Ana Synthetic");
  assertEquals((res.payload.messages as unknown[]).length, 2);
});

Deno.test("readConversation: default limit=500/offset=0 are interpolated when omitted", async () => {
  const conversations = asciiTable([
    ["1", "live:.cid.fake0001", "Ana Synthetic"],
  ]);
  const { ctx } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages: "" }),
    async (stub) => {
      await run("readConversation", { conversation: "Ana Synthetic" }, ctx);
      const messagesSql = stub.calls.find((c) => /FROM Messages/.test(c))!;
      assert(messagesSql.includes("LIMIT 500 OFFSET 0"));
    },
  );
});

Deno.test("readConversation: explicit limit/offset are interpolated verbatim", async () => {
  const conversations = asciiTable([
    ["1", "live:.cid.fake0001", "Ana Synthetic"],
  ]);
  const { ctx } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages: "" }),
    async (stub) => {
      await run(
        "readConversation",
        { conversation: "Ana Synthetic", limit: 10, offset: 20 },
        ctx,
      );
      const messagesSql = stub.calls.find((c) => /FROM Messages/.test(c))!;
      assert(messagesSql.includes("LIMIT 10 OFFSET 20"));
    },
  );
});

Deno.test("readConversation: not found — throws 'Conversation '<name>' not found'", async () => {
  const { ctx } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: "" }),
    () =>
      assertRejects(
        () => run("readConversation", { conversation: "Ghost" }, ctx),
        Error,
        "Conversation 'Ghost' not found",
      ),
  );
});

// ---------------------------------------------------------------------------
// searchBySender
// ---------------------------------------------------------------------------

Deno.test("searchBySender: happy path — default limit=200, writes sender_<key>", async () => {
  const messages = await loadFixture("messages_search.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(byTable({ messages }), async (stub) => {
    await run("searchBySender", { sender: "fake0001" }, ctx);
    assert(stub.calls[0].includes("LIMIT 200"));
    assert(stub.calls[0].includes("LIKE '%fake0001%'"));
  });
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals(res.name, "sender_fake0001");
  assertEquals(res.payload.query, "sender:fake0001");
});

Deno.test("searchBySender: an explicit limit is interpolated verbatim", async () => {
  const messages = await loadFixture("messages_search.tsv");
  const { ctx } = makeCtx();
  await withSqliteStub(byTable({ messages }), async (stub) => {
    await run("searchBySender", { sender: "x", limit: 5 }, ctx);
    assert(stub.calls[0].includes("LIMIT 5"));
  });
});

// ---------------------------------------------------------------------------
// searchByText
// ---------------------------------------------------------------------------

Deno.test("searchByText: happy path — default limit=200, writes search_<key>", async () => {
  const messages = await loadFixture("messages_search.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(byTable({ messages }), async (stub) => {
    await run("searchByText", { text: "lunch" }, ctx);
    assert(stub.calls[0].includes("LIMIT 200"));
    assert(stub.calls[0].includes("LIKE '%lunch%'"));
  });
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals(res.name, "search_lunch");
  assertEquals(res.payload.query, "text:lunch");
});

// ---------------------------------------------------------------------------
// exportToObsidian
// ---------------------------------------------------------------------------

Deno.test("exportToObsidian: happy path — default folder='Skype', writes obsidian_<profile> with one note per conversation", async () => {
  const conversations = await loadFixture("conversations.tsv");
  const messages = await loadFixture("messages_export.tsv");
  const { ctx, written, logs } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", {}, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  assertEquals(res.name, "obsidian_synthetic-user");
  const notes = res.payload.messages as Array<Record<string, unknown>>;
  assertEquals(notes.length, 4);
  assert(
    (notes[0].obsidianPath as string).startsWith("Skype/synthetic-user/"),
  );
  assert(logs.some((l) => l.level === "info"));
});

Deno.test("exportToObsidian: an explicit folder is used as the base path", async () => {
  const conversations = await loadFixture("conversations.tsv");
  const messages = await loadFixture("messages_export.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", { folder: "Chats" }, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const notes = res.payload.messages as Array<Record<string, unknown>>;
  assert((notes[0].obsidianPath as string).startsWith("Chats/synthetic-user/"));
});

// ---------------------------------------------------------------------------
// importToObsidian — real temp vault directory
// ---------------------------------------------------------------------------

Deno.test("importToObsidian: happy path — writes one .md file per conversation into the vault, reports written/skipped", async () => {
  const conversations = await loadFixture("conversations.tsv");
  const messages = await loadFixture("messages_export.tsv");
  const vault = await Deno.makeTempDir();
  try {
    const { ctx, written, logs } = makeCtx({
      ...GLOBAL_ARGS,
    });
    await withSqliteStub(
      byTable({ conversations, messages }),
      () => run("importToObsidian", { vaultPath: vault }, ctx),
    );
    const res = written.find((w) => w.spec === "conversations")!;
    assertEquals(res.name, "import_synthetic-user");
    assertEquals(
      res.payload.count,
      4,
      "all 4 conversations written, 0 skipped",
    );

    const dir = `${vault}/Skype/synthetic-user`;
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries.length, 4);
    assert(entries.every((e) => e.endsWith(".md")));

    const anaFile = entries.find((e) => e.startsWith("Ana Synthetic"))!;
    const content = await Deno.readTextFile(`${dir}/${anaFile}`);
    assert(content.includes("Hello there, exporting & testing."));
    assert(logs.some((l) => l.level === "info"));
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});
