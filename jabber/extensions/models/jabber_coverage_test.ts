/**
 * Coverage suite for @magistr/jabber (jabber_history.ts) -- regression tests
 * closing gaps a reviewer found: guards with no test protecting them. Every
 * test here answers "if someone deletes/weakens this guard, does a test go
 * red?"
 *
 * Also pins bug #8 (unbounded memory -- no streaming/cap on whole-file
 * reads or the all-file scan), tracked in the LOCAL `jabber-latent-bugs`
 * issue-lifecycle model.
 *
 * The "backend selection branch matrix" section near the end covers
 * importToObsidian's destination-resolution precedence added for
 * swamp-workspace #57 (mirrors PR #56's obsidian-vault backend split):
 * vaultPath argument > vaultRoot global argument > CLI vault-name lookup.
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
  const root = await Deno.makeTempDir({ prefix: "jabber-coverage-test-" });
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
  const vaultPath = await Deno.makeTempDir({
    prefix: "jabber-coverage-vault-",
  });
  try {
    await fn(vaultPath);
  } finally {
    await Deno.remove(vaultPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// chatType filter guard -- all/dm/conference partition exactly, no overlap
// ---------------------------------------------------------------------------

Deno.test("guard: chatType filter partitions list output exactly -- dm + conference counts sum to the 'all' total, with no overlap", async () => {
  const all = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "all" }, all.ctx);
  const dm = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "dm" }, dm.ctx);
  const conf = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "conference" }, conf.ctx);

  const allTotal = all.written[0].payload.totalConversations as number;
  const dmTotal = dm.written[0].payload.totalConversations as number;
  const confTotal = conf.written[0].payload.totalConversations as number;
  assertEquals(dmTotal + confTotal, allTotal);

  const dmChatTypes = (dm.written[0].payload.conversations as Array<
    { chatType: string }
  >).map((c) => c.chatType);
  assert(dmChatTypes.every((t) => t === "dm"));
  const confChatTypes = (conf.written[0].payload.conversations as Array<
    { chatType: string }
  >).map((c) => c.chatType);
  assert(confChatTypes.every((t) => t === "conference"));
});

// ---------------------------------------------------------------------------
// read: limit boundary guards
// ---------------------------------------------------------------------------

Deno.test("guard: read limit exactly equal to the message count returns all messages unchanged", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "alice", limit: 2 }, ctx);
  const messages = written[0].payload.messages as unknown[];
  assertEquals(messages.length, 2);
});

Deno.test("guard: read limit GREATER than the message count returns all messages, no error", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "alice", limit: 999 }, ctx);
  const messages = written[0].payload.messages as unknown[];
  assertEquals(messages.length, 2);
});

Deno.test("guard: read with a NEGATIVE limit behaves identically to unlimited (the `> 0` check, not `!== 0`)", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "alice", limit: -5 }, ctx);
  const messages = written[0].payload.messages as unknown[];
  assertEquals(messages.length, 2);
});

// ---------------------------------------------------------------------------
// search: limit=0 explicit short-circuit -- NOT one of the 9 tracked latent
// bugs, but a real characterization worth a regression guard: passing
// limit=0 EXPLICITLY (as opposed to relying on the schema default of 100)
// makes the `allMatches.length >= args.limit` check true after the very
// first file, and the final `.slice(0, 0)` always yields an empty array --
// so an explicit limit=0 always returns ZERO results, never "unlimited".
// ---------------------------------------------------------------------------

Deno.test("guard: search with an EXPLICIT limit=0 always returns zero results (asymmetric with read's limit=0-means-unlimited convention)", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("search", { query: "here", chatType: "all", limit: 0 }, ctx);
  assertEquals(written[0].payload.totalMessages, 0);
});

// ---------------------------------------------------------------------------
// importToObsidian dedup guard -- room2's pipe copy is dropped ONLY because
// a plain-text copy of the SAME jid exists; room1 (pipe, no plain twin) and
// room3 (plain, no pipe twin) both survive untouched.
// ---------------------------------------------------------------------------

Deno.test("guard: importToObsidian dedup drops room2's pipe copy (has a plain-text twin) but keeps room1's pipe copy (no twin) and room3's plain copy (no twin)", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await run(
      "importToObsidian",
      { vaultPath, folder: "Jabber", chatType: "conference" },
      ctx,
    );
    const names: string[] = [];
    for await (const e of Deno.readDir(`${vaultPath}/Jabber`)) {
      names.push(e.name);
    }
    assertEquals(names.sort(), [
      "room1@conference.example.com.md",
      "room2@conference.example.com.md",
      "room3@conference.example.com.md",
    ]);
    // room2's surviving note must be the PLAIN-TEXT rendering (Nick2's
    // nickname appears only in the plain-text log, never the pipe log).
    const room2 = await Deno.readTextFile(
      `${vaultPath}/Jabber/room2@conference.example.com.md`,
    );
    assert(room2.includes("Nick2"));
  });
});

// ---------------------------------------------------------------------------
// `_via_` naming guard -- present iff format === "plain" (i.e. iff the file
// carries an `account`), absent for every pipe-format file including
// conferences.
// ---------------------------------------------------------------------------

Deno.test("guard: '_via_' suffix appears in read()'s instance name iff the file is plain-text-format (has an account) -- never for pipe format, DM or conference alike", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "example.com", limit: 0 }, ctx); // matches every fixture jid
  for (const w of written) {
    const hasAccount = w.payload.account !== undefined;
    assertEquals(
      w.name.includes("_via_"),
      hasAccount,
      `resource '${w.name}' -- '_via_' presence must match account presence`,
    );
  }
});

// ---------------------------------------------------------------------------
// skip-empty guard -- an empty .history file is never written as a note,
// and is counted in the "Skipped" tally, not silently dropped from it.
// ---------------------------------------------------------------------------

Deno.test("guard: an empty conversation is counted in the 'Skipped' tally, not just silently absent from the note directory", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx, logs } = makeCtx(GOOD_HISTORY_DIR);
    await run(
      "importToObsidian",
      { vaultPath, folder: "Jabber", chatType: "dm" },
      ctx,
    );
    const doneLog = logs.find((l) =>
      typeof l.args[0] === "string" && (l.args[0] as string).startsWith("Done.")
    );
    assertEquals(doneLog?.args[0], "Done. Written: 1, Skipped: 1");
  });
});

// ---------------------------------------------------------------------------
// progress-log guard -- every 20th successful write logs a "Progress:" line
// ---------------------------------------------------------------------------

function makeNSyntheticDms(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const jidLocal = `user${String(i).padStart(3, "0")}`;
    files[`${jidLocal}_at_example.com.history`] = `|2024-10-01T00:00:0${
      i % 10
    }Z|1|to|0|message ${i}\n`;
  }
  return files;
}

Deno.test("guard: the 20th successful write logs a 'Progress: 20/N' line", async () => {
  await withTempHistoryDir(makeNSyntheticDms(20), async (historyDir) => {
    await withTempVault(async (vaultPath) => {
      const { ctx, logs } = makeCtx(historyDir);
      await run(
        "importToObsidian",
        { vaultPath, folder: "Jabber", chatType: "all" },
        ctx,
      );
      const progressLog = logs.find((l) =>
        typeof l.args[0] === "string" &&
        (l.args[0] as string).startsWith("Progress:")
      );
      assertEquals(
        progressLog?.args[0],
        "Progress: 20/20 conversations written",
      );
    });
  });
});

Deno.test("guard: with fewer than 20 writes, no 'Progress:' line is ever logged", async () => {
  await withTempHistoryDir(makeNSyntheticDms(5), async (historyDir) => {
    await withTempVault(async (vaultPath) => {
      const { ctx, logs } = makeCtx(historyDir);
      await run(
        "importToObsidian",
        { vaultPath, folder: "Jabber", chatType: "all" },
        ctx,
      );
      const progressLog = logs.find((l) =>
        typeof l.args[0] === "string" &&
        (l.args[0] as string).startsWith("Progress:")
      );
      assertEquals(progressLog, undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// bug #8 (LOW) -- unbounded memory: no streaming, no cap, on either a
// whole-file read or the all-file directory scan. A few thousand messages
// in ONE file are read entirely into memory in one `Deno.readTextFile` call
// with no size guard anywhere in list/read/search/importToObsidian.
// ---------------------------------------------------------------------------

Deno.test("bug #8: a several-thousand-message file is read entirely into memory with no cap or streaming -- messageCount reflects every single message", async () => {
  const N = 4000;
  const lines: string[] = [];
  for (let i = 0; i < N; i++) {
    lines.push(`|2024-11-01T00:00:00Z|1|to|0|bulk message number ${i}`);
  }
  await withTempHistoryDir(
    { "bulk_at_example.com.history": lines.join("\n") + "\n" },
    async (historyDir) => {
      const { ctx, written } = makeCtx(historyDir);
      await run("list", { chatType: "all" }, ctx);
      const bulk = (written[0].payload.conversations as Array<
        { jid: string; messageCount: number }
      >).find((c) => c.jid === "bulk@example.com");
      assert(bulk, "expected the bulk conversation to appear in list output");
      assertEquals(
        bulk!.messageCount,
        N,
        "no truncation/cap -- every one of the N messages was parsed and counted",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// backend selection branch matrix (swamp-workspace #57) -- importToObsidian's
// destination resolution: vaultPath argument > vaultRoot global argument > CLI
// vault-name lookup. Every branch either writes to the expected vault or, for
// the CLI branch, drives the stubbed Deno.Command exactly once.
// ---------------------------------------------------------------------------

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

Deno.test("branch matrix: vaultPath alone resolves to itself -- the CLI is never invoked", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await withCommandStub(
      () => ({ success: false, stderr: "must not be called" }),
      async (calls) => {
        await run(
          "importToObsidian",
          { vaultPath, folder: "Jabber", chatType: "dm" },
          ctx,
        );
        assertEquals(calls.length, 0);
      },
    );
    const stat = await Deno.stat(`${vaultPath}/Jabber/alice@example.com.md`);
    assert(stat.isFile);
  });
});

Deno.test("branch matrix: vaultRoot alone (no vaultPath, no vault) resolves to itself -- the CLI is never invoked", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    (ctx.globalArgs as Record<string, unknown>).vaultRoot = vaultPath;
    await withCommandStub(
      () => ({ success: false, stderr: "must not be called" }),
      async (calls) => {
        await run(
          "importToObsidian",
          { folder: "Jabber", chatType: "dm" },
          ctx,
        );
        assertEquals(calls.length, 0);
      },
    );
    const stat = await Deno.stat(`${vaultPath}/Jabber/alice@example.com.md`);
    assert(stat.isFile);
  });
});

Deno.test("branch matrix: vault (name) alone falls back to the CLI lookup -- exactly one Deno.Command invocation", async () => {
  await withTempVault(async (resolvedPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await withCommandStub(
      () => ({ success: true, stdout: `${resolvedPath}\n` }),
      async (calls) => {
        await run(
          "importToObsidian",
          { vault: "my-vault", folder: "Jabber", chatType: "dm" },
          ctx,
        );
        assertEquals(calls.length, 1);
      },
    );
    const stat = await Deno.stat(
      `${resolvedPath}/Jabber/alice@example.com.md`,
    );
    assert(stat.isFile);
  });
});

Deno.test("branch matrix: vaultRoot + vault both set (no vaultPath) -- vaultRoot wins, the CLI is never invoked", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    (ctx.globalArgs as Record<string, unknown>).vaultRoot = vaultPath;
    await withCommandStub(
      () => ({ success: false, stderr: "must not be called" }),
      async (calls) => {
        await run(
          "importToObsidian",
          { vault: "some-other-vault", folder: "Jabber", chatType: "dm" },
          ctx,
        );
        assertEquals(calls.length, 0, "vaultRoot must win over the CLI");
      },
    );
    const stat = await Deno.stat(`${vaultPath}/Jabber/alice@example.com.md`);
    assert(stat.isFile);
  });
});

Deno.test("branch matrix: vaultPath + vaultRoot + vault ALL set -- vaultPath wins over both", async () => {
  await withTempVault(async (vaultPathArg) => {
    await withTempVault(async (vaultPathGlobal) => {
      const { ctx } = makeCtx(GOOD_HISTORY_DIR);
      (ctx.globalArgs as Record<string, unknown>).vaultRoot = vaultPathGlobal;
      await withCommandStub(
        () => ({ success: false, stderr: "must not be called" }),
        async (calls) => {
          await run(
            "importToObsidian",
            {
              vaultPath: vaultPathArg,
              vault: "some-other-vault",
              folder: "Jabber",
              chatType: "dm",
            },
            ctx,
          );
          assertEquals(calls.length, 0, "vaultPath must win over both");
        },
      );
      const stat = await Deno.stat(
        `${vaultPathArg}/Jabber/alice@example.com.md`,
      );
      assert(stat.isFile);
      await assertRejects(() =>
        Deno.stat(`${vaultPathGlobal}/Jabber/alice@example.com.md`)
      );
    });
  });
});

Deno.test("branch matrix: fallback error text mentions all three options when none is set", async () => {
  const { ctx } = makeCtx(GOOD_HISTORY_DIR);
  await assertRejects(
    () => run("importToObsidian", { folder: "Jabber", chatType: "all" }, ctx),
    Error,
    "Either 'vault' or 'vaultPath' must be provided (or set the vaultRoot global argument)",
  );
});
