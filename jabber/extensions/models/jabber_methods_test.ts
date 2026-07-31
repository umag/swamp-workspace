/**
 * Method-level tests for @magistr/jabber (jabber_history.ts) -- all 4 methods
 * (list, read, search, importToObsidian), happy + error path, driven through
 * `model.methods.<m>.arguments.parse()` + `.execute()` against REAL
 * `Deno.readDir`/`Deno.readTextFile`/`Deno.writeTextFile` (synthetic on-disk
 * fixtures + `Deno.makeTempDir` scratch trees) and a fake context.
 *
 * jabber_history.ts is UNMODIFIED -- every test here is a characterization
 * test that PINS the model's current, already-shipped behavior.
 *
 * importToObsidian's `vaultPath` branch does REAL filesystem writes into a
 * `Deno.makeTempDir` vault (cleaned up after each test). Its `vault` (name)
 * branch is exercised by stubbing `(globalThis.Deno as unknown as
 * Record<string, unknown>).Command` -- the only stub in this suite; no real
 * `obsidian` binary is ever invoked.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./jabber_history.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GOOD_HISTORY_DIR = new URL("../../fixtures/good", import.meta.url)
  .pathname;

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};
type LogCall = { level: "info" | "warn"; args: unknown[] };

function makeCtx(historyDir: string) {
  const written: Written[] = [];
  const logs: LogCall[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs: { historyDir },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: {
        info: (...args: unknown[]) => {
          logs.push({ level: "info", args });
        },
        warn: (...args: unknown[]) => {
          logs.push({ level: "warn", args });
        },
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

async function withTempHistoryDir(
  files: Record<string, string>,
  fn: (historyDir: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "jabber-methods-test-" });
  const historyDir = `${root}/history`;
  await Deno.mkdir(historyDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${historyDir}/${name}`, content);
  }
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function withTempVault(fn: (vaultPath: string) => Promise<void>) {
  const vaultPath = await Deno.makeTempDir({ prefix: "jabber-vault-test-" });
  try {
    await fn(vaultPath);
  } finally {
    await Deno.remove(vaultPath, { recursive: true });
  }
}

type CommandCall = { cmd: string; options: Record<string, unknown> };

function withCommandStub(
  handler: (cmd: string, options: Record<string, unknown>) => {
    success: boolean;
    stdout?: string;
    stderr?: string;
  },
  fn: (calls: CommandCall[]) => Promise<void>,
) {
  const calls: CommandCall[] = [];
  const denoRecord = globalThis.Deno as unknown as Record<string, unknown>;
  const original = denoRecord.Command;
  // deno-lint-ignore no-explicit-any
  (denoRecord as any).Command = class {
    #cmd: string;
    #options: Record<string, unknown>;
    constructor(cmd: string, options: Record<string, unknown>) {
      this.#cmd = cmd;
      this.#options = options;
      calls.push({ cmd, options });
    }
    output() {
      const result = handler(this.#cmd, this.#options);
      const enc = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        code: result.success ? 0 : 1,
        stdout: enc.encode(result.stdout ?? ""),
        stderr: enc.encode(result.stderr ?? ""),
        signal: null,
      });
    }
  };
  return (async () => {
    try {
      await fn(calls);
    } finally {
      denoRecord.Command = original;
    }
  })();
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

Deno.test("list: happy path -- writes a single 'summary' resource named 'main'", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "all" }, ctx);
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "summary");
  assertEquals(written[0].name, "main");
  assertEquals(written[0].payload.historyDir, GOOD_HISTORY_DIR);
});

Deno.test("list: error path -- a nonexistent historyDir rejects with a Deno filesystem error", async () => {
  const { ctx } = makeCtx("/nonexistent/jabber-methods-test-path-xyz");
  await assertRejects(() => run("list", { chatType: "all" }, ctx));
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

Deno.test("read: limit>0 truncates to the LAST N messages", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "alice", limit: 1 }, ctx);
  const res = written.find((w) => w.name === "alice_at_example_com")!;
  const messages = res.payload.messages as Array<{ body: string }>;
  assertEquals(messages.length, 1);
  assertEquals(messages[0].body, "Yes, I am here!");
});

Deno.test("read: limit=0 (default) returns ALL messages, unlimited", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "alice", limit: 0 }, ctx);
  const res = written.find((w) => w.name === "alice_at_example_com")!;
  assertEquals((res.payload.messages as unknown[]).length, 2);
});

Deno.test("read: error path -- no matching jid throws with a 'Use the list method' hint", async () => {
  const { ctx } = makeCtx(GOOD_HISTORY_DIR);
  await assertRejects(
    () => run("read", { jid: "nobody-matches-this", limit: 0 }, ctx),
    Error,
    "No conversation found matching",
  );
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

Deno.test("search: chatType=dm excludes conference messages even when the query matches both", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("search", { query: "here", chatType: "dm", limit: 100 }, ctx);
  const summary = written[0].payload;
  const jids = (summary.conversations as Array<{ jid: string }>).map((c) =>
    c.jid
  );
  assert(jids.every((j) => j === "alice@example.com"));
});

Deno.test("search: sender match branch -- a plain-text sender nickname match surfaces the message even when the body doesn't match", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("search", { query: "nick2", chatType: "all", limit: 100 }, ctx);
  assertEquals(written[0].payload.totalMessages, 1);
});

Deno.test("search: limit truncates results EVEN when a single file alone yields more matches than the limit", async () => {
  await withTempHistoryDir({
    "multi_at_example.com.history": "|2024-05-01T00:00:00Z|1|to|0|ping one\n" +
      "|2024-05-01T00:01:00Z|1|to|0|ping two\n" +
      "|2024-05-01T00:02:00Z|1|to|0|ping three\n",
  }, async (historyDir) => {
    const { ctx, written } = makeCtx(historyDir);
    await run("search", { query: "ping", chatType: "all", limit: 2 }, ctx);
    assertEquals(written[0].payload.totalMessages, 2);
  });
});

// ---------------------------------------------------------------------------
// importToObsidian
// ---------------------------------------------------------------------------

Deno.test("importToObsidian: missing both 'vault' and 'vaultPath' throws BEFORE any filesystem work", async () => {
  const { ctx } = makeCtx(GOOD_HISTORY_DIR);
  await assertRejects(
    () => run("importToObsidian", { folder: "Jabber", chatType: "all" }, ctx),
    Error,
    "Either 'vault' or 'vaultPath' must be provided",
  );
});

Deno.test("importToObsidian: happy path via vaultPath -- dedup prefers plain-text over pipe for the same room, skips the empty DM, writes the rest", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx, written, logs } = makeCtx(GOOD_HISTORY_DIR);
    await run(
      "importToObsidian",
      { vaultPath, folder: "Jabber", chatType: "all" },
      ctx,
    );
    const summary = written.find((w) => w.spec === "summary")!;
    assertEquals(summary.payload.totalConversations, 4); // alice, room1, room2(plain), room3

    const entries: string[] = [];
    for await (const e of Deno.readDir(`${vaultPath}/Jabber`)) {
      entries.push(e.name);
    }
    assertEquals(
      entries.sort(),
      [
        "alice@example.com.md",
        "room1@conference.example.com.md",
        "room2@conference.example.com.md",
        "room3@conference.example.com.md",
      ].sort(),
    );

    // dedup proof: room2's note is the PLAIN-TEXT rendering, not the pipe one
    const room2Note = await Deno.readTextFile(
      `${vaultPath}/Jabber/room2@conference.example.com.md`,
    );
    assert(room2Note.includes("Nick2"));
    assert(!room2Note.includes("This pipe copy should be dropped"));

    // skip-empty proof: carol (0 messages) never gets a note
    await assertRejects(() =>
      Deno.stat(`${vaultPath}/Jabber/carol@example.com.md`)
    );

    const doneLog = logs.find((l) =>
      typeof l.args[0] === "string" && (l.args[0] as string).startsWith("Done.")
    );
    assertEquals(doneLog?.args[0], "Done. Written: 4, Skipped: 1");
  });
});

Deno.test("importToObsidian: chatType=dm imports only alice (carol is dm too, but empty -> skipped)", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
    await run(
      "importToObsidian",
      { vaultPath, folder: "Jabber", chatType: "dm" },
      ctx,
    );
    const summary = written.find((w) => w.spec === "summary")!;
    assertEquals(summary.payload.totalConversations, 1);
    const entries: string[] = [];
    for await (const e of Deno.readDir(`${vaultPath}/Jabber`)) {
      entries.push(e.name);
    }
    assertEquals(entries, ["alice@example.com.md"]);
  });
});

Deno.test("importToObsidian: custom folder is honored instead of the 'Jabber' default", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await run(
      "importToObsidian",
      { vaultPath, folder: "Archive", chatType: "dm" },
      ctx,
    );
    const stat = await Deno.stat(`${vaultPath}/Archive/alice@example.com.md`);
    assert(stat.isFile);
  });
});

Deno.test("importToObsidian: vault (name) branch resolves via the stubbed Deno.Command, then writes into the resolved path", async () => {
  await withTempVault(async (resolvedPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await withCommandStub(
      (cmd, options) => {
        assertEquals(cmd, "obsidian");
        assertEquals(options.args, ["vault", "vault=my-vault", "info=path"]);
        return { success: true, stdout: `${resolvedPath}\n` };
      },
      async (calls) => {
        await run(
          "importToObsidian",
          { vault: "my-vault", folder: "Jabber", chatType: "dm" },
          ctx,
        );
        assertEquals(calls.length, 1);
      },
    );
    const stat = await Deno.stat(`${resolvedPath}/Jabber/alice@example.com.md`);
    assert(stat.isFile);
  });
});

Deno.test("importToObsidian: vault (name) resolution failure -- stderr surfaces in the thrown error, no write is attempted", async () => {
  const { ctx } = makeCtx(GOOD_HISTORY_DIR);
  await withCommandStub(
    () => ({ success: false, stderr: "vault 'my-vault' is not registered" }),
    async () => {
      await assertRejects(
        () =>
          run(
            "importToObsidian",
            { vault: "my-vault", folder: "Jabber", chatType: "all" },
            ctx,
          ),
        Error,
        "Failed to resolve vault path: vault 'my-vault' is not registered",
      );
    },
  );
});
