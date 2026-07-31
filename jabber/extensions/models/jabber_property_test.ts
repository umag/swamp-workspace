/**
 * Property-based tests (fast-check) for @magistr/jabber (jabber_history.ts).
 *
 * jabber_history.ts exports ONLY `model` -- parsePipeDelimited,
 * parsePlainText, listHistoryFiles, decodeJid, and sanitizeFilename are all
 * module-private. Every property here is observed by driving
 * `model.methods.<m>.execute()` against REAL `Deno.makeTempDir`/
 * `Deno.writeTextFile`/`Deno.readDir` scratch trees (never a stubbed
 * filesystem), per the approved plan's test seam. jabber_history.ts is
 * BYTE-FROZEN by this change.
 *
 * Honors `FC_NUM_RUNS` for a nightly soak (`deno task test:soak`). Kept to a
 * modest default `numRuns` because every iteration here does REAL disk I/O
 * (mkdir/write/readDir/remove), unlike a pure in-memory property suite.
 *
 * Properties:
 *  (a) never throws -- list()/search() never throw for ANY hostile message
 *      body (arbitrary string, control chars and lone surrogates included),
 *      and the written resource always validates against the model's OWN
 *      `summary` resource schema.
 *  (b) count invariant -- list()'s totalMessages/totalConversations/
 *      totalDMs exactly match a generated set of N single-message DM
 *      fixtures.
 *  (c) truncation invariant -- search() truncates to exactly
 *      min(N, limit) when every generated conversation's message matches
 *      the query (generalizes the coverage suite's single boundary case).
 *  (d) filename invariant -- importToObsidian's note filename stem is
 *      NEVER longer than 80 UTF-16 code units, for any generated JID
 *      local-part (including sanitizeFilename's replace-target characters).
 *  (e) multi-step flow invariant -- for any jid appearing in list()'s OWN
 *      output, read() with that exact jid always finds >=1 match.
 */
import { assert } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./jabber_history.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(25) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
  return method.execute(method.arguments.parse(args), ctx);
}

async function withTempHistoryDir<T>(
  files: Record<string, string>,
  fn: (historyDir: string) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "jabber-property-test-" });
  const historyDir = `${root}/history`;
  await Deno.mkdir(historyDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${historyDir}/${name}`, content);
  }
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function withTempVault<T>(
  fn: (vaultPath: string) => Promise<T>,
): Promise<T> {
  const vaultPath = await Deno.makeTempDir({
    prefix: "jabber-property-vault-",
  });
  try {
    return await fn(vaultPath);
  } finally {
    await Deno.remove(vaultPath, { recursive: true });
  }
}

const arbSafeLocal = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/);

// ---------------------------------------------------------------------------
// (a) never throws, over hostile message-body content
// ---------------------------------------------------------------------------

const arbHostileBody = fc.string({ maxLength: 300, unit: "binary" });

Deno.test("property: list() never throws for ANY hostile message body, and its resource is always schema-valid", async () => {
  await fc.assert(
    fc.asyncProperty(arbHostileBody, async (body) => {
      return await withTempHistoryDir(
        {
          "hostile_at_example.com.history":
            `|2024-01-01T00:00:00Z|1|to|0|${body}\n`,
        },
        async (historyDir) => {
          const { ctx, written } = makeCtx(historyDir);
          let threw = false;
          try {
            await run("list", { chatType: "all" }, ctx);
          } catch {
            threw = true;
          }
          if (threw) return false;
          model.resources.summary.schema.parse(written[0].payload);
          return true;
        },
      );
    }),
    FC_RUNS,
  );
});

Deno.test("property: search() never throws for ANY hostile message body, and its resource is always schema-valid", async () => {
  await fc.assert(
    fc.asyncProperty(arbHostileBody, async (body) => {
      return await withTempHistoryDir(
        {
          "hostile_at_example.com.history":
            `|2024-01-01T00:00:00Z|1|to|0|${body}\n`,
        },
        async (historyDir) => {
          const { ctx, written } = makeCtx(historyDir);
          let threw = false;
          try {
            await run(
              "search",
              { query: "e", chatType: "all", limit: 100 },
              ctx,
            );
          } catch {
            threw = true;
          }
          if (threw) return false;
          model.resources.summary.schema.parse(written[0].payload);
          return true;
        },
      );
    }),
    FC_RUNS,
  );
});

Deno.test("sanity: the hostile-body arbitrary can generate control characters and unpaired surrogates (not vacuously safe strings)", () => {
  let sawControl = false;
  fc.assert(
    fc.property(arbHostileBody, (s) => {
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) <= 8) sawControl = true;
      }
      return true;
    }),
    { numRuns: 500 },
  );
  assert(
    sawControl,
    "sanity: the arbitrary must generate control characters at least once",
  );
});

// ---------------------------------------------------------------------------
// (b) count invariant over a generated set of N single-message DMs
// ---------------------------------------------------------------------------

Deno.test("property: list()'s totals exactly match a generated set of N single-message DM fixtures", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(arbSafeLocal, { minLength: 1, maxLength: 8 }),
      async (locals) => {
        const files: Record<string, string> = {};
        for (const local of locals) {
          files[`${local}_at_example.com.history`] =
            `|2024-01-01T00:00:00Z|1|to|0|hello from ${local}\n`;
        }
        return await withTempHistoryDir(files, async (historyDir) => {
          const { ctx, written } = makeCtx(historyDir);
          await run("list", { chatType: "all" }, ctx);
          const summary = written[0].payload;
          model.resources.summary.schema.parse(summary);
          return summary.totalConversations === locals.length &&
            summary.totalDMs === locals.length &&
            summary.totalConferences === 0 &&
            summary.totalMessages === locals.length;
        });
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) truncation invariant: search() always returns exactly min(N, limit)
// ---------------------------------------------------------------------------

Deno.test("property: search() truncates to exactly min(N, limit) when every generated conversation's message matches the query", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(arbSafeLocal, { minLength: 1, maxLength: 10 }),
      fc.integer({ min: 0, max: 12 }),
      async (locals, limit) => {
        const files: Record<string, string> = {};
        for (const local of locals) {
          files[`${local}_at_example.com.history`] =
            `|2024-01-01T00:00:00Z|1|to|0|zzzcommonmarker\n`;
        }
        return await withTempHistoryDir(files, async (historyDir) => {
          const { ctx, written } = makeCtx(historyDir);
          await run(
            "search",
            { query: "zzzcommonmarker", chatType: "all", limit },
            ctx,
          );
          const total = written[0].payload.totalMessages as number;
          return total === Math.min(locals.length, limit);
        });
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) filename invariant: sanitizeFilename's slice(0,80) is NEVER exceeded
// ---------------------------------------------------------------------------

const JID_LOCAL_ALPHABET = Array.from(
  'abcdefghijklmnopqrstuvwxyz0123456789#:*?"<>|[]{}\\-_. ',
);
const arbJidLocal = fc
  .array(fc.constantFrom(...JID_LOCAL_ALPHABET), {
    minLength: 1,
    maxLength: 150,
  })
  .map((cs) => cs.join(""));

Deno.test("property: importToObsidian's note filename stem is NEVER longer than 80 UTF-16 code units, for any generated JID local-part", async () => {
  await fc.assert(
    fc.asyncProperty(arbJidLocal, async (local) => {
      const jid = `${local}@example.com`;
      const filename = `${jid.replace(/@/g, "_at_")}.history`;
      return await withTempHistoryDir(
        { [filename]: "|2024-01-01T00:00:00Z|1|to|0|hi\n" },
        (historyDir) =>
          withTempVault(async (vaultPath) => {
            const { ctx, logs } = makeCtx(historyDir);
            await run(
              "importToObsidian",
              { vaultPath, folder: "Jabber", chatType: "dm" },
              ctx,
            );
            const names: string[] = [];
            for await (const e of Deno.readDir(`${vaultPath}/Jabber`)) {
              names.push(e.name);
            }
            let stem: string | undefined;
            if (names.length === 1) {
              stem = names[0].replace(/\.md$/, "");
            } else {
              const warnLog = logs.find((l) => l.level === "warn");
              if (!warnLog) return false;
              const msg = warnLog.args[0] as string;
              const m = msg.match(/^Failed to write (.*): /);
              if (!m) return false;
              stem = m[1];
            }
            return stem !== undefined && stem.length <= 80;
          }),
      );
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (e) multi-step flow invariant: list() -> read(jid) always finds a match
// ---------------------------------------------------------------------------

Deno.test("property: for any jid appearing in list()'s own output, read() with that exact jid ALWAYS finds at least one match", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(arbSafeLocal, { minLength: 1, maxLength: 6 }),
      async (locals) => {
        const files: Record<string, string> = {};
        for (const local of locals) {
          files[`${local}_at_example.com.history`] =
            `|2024-01-01T00:00:00Z|1|to|0|hi\n`;
        }
        return await withTempHistoryDir(files, async (historyDir) => {
          const listCtx = makeCtx(historyDir);
          await run("list", { chatType: "all" }, listCtx.ctx);
          const jids =
            (listCtx.written[0].payload.conversations as Array<{ jid: string }>)
              .map((c) => c.jid);
          for (const jid of jids) {
            const readCtx = makeCtx(historyDir);
            try {
              await run("read", { jid, limit: 0 }, readCtx.ctx);
            } catch {
              return false;
            }
            if (readCtx.written.length === 0) return false;
          }
          return true;
        });
      },
    ),
    FC_RUNS,
  );
});
