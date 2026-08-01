/**
 * Adversarial suite for @magistr/jabber (jabber_history.ts) -- attacker's
 * -perspective tests: malformed filenames, injection, PATH-hijack, and a
 * falsified-XXE covered-negative (this model parses NO XML at all -- see
 * below).
 *
 * Nine already-shipped latent bugs are tracked in the LOCAL
 * `jabber-latent-bugs` issue-lifecycle model (never filed to the swamp.club
 * Lab). This file pins bugs #1, #2, #3 (both vectors), #4 (parse-layer
 * only), #6, #7, and #9 -- see jabber_coverage_test.ts for #8
 * (unbounded memory). **Bug #5 (folder path traversal) is FIXED** by the
 * headless `vaultRoot`/path-confinement change (swamp-workspace #57, mirrors
 * PR #56's obsidian-vault backend split) -- see the "path confinement" section
 * below, which replaces the old bug #5 characterization with tests of the new,
 * fixed behavior.
 *
 * The "path confinement" section below exercises the `resolveVaultPathSafe`
 * helper copied verbatim from
 * obsidian-vault/extensions/models/obsidian_vault.ts (PR #56) into
 * jabber_history.ts, and importToObsidian's new `vaultRoot` global argument.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, resolveVaultPathSafe } from "./jabber_history.ts";

// ---------------------------------------------------------------------------
// Harness (self-contained per suite file, matching the bandcamp/porkbun
// precedent)
// ---------------------------------------------------------------------------

const GOOD_HISTORY_DIR = new URL("../../fixtures/good", import.meta.url)
  .pathname;
const POISON_HISTORY_DIR = new URL("../../fixtures/poison", import.meta.url)
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
  const root = await Deno.makeTempDir({ prefix: "jabber-adversarial-test-" });
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
    prefix: "jabber-adversarial-vault-",
  });
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
// bug #1 (MEDIUM) -- decodeURIComponent on a malformed-% filename aborts
// listHistoryFiles' for-await loop, which aborts EVERY method for the WHOLE
// directory, not just the poisoned file. `fixtures/poison/history/` holds
// exactly `bad%ZZ.history`, kept out of `fixtures/good/` for exactly this
// reason (see PROVENANCE.md).
// ---------------------------------------------------------------------------

Deno.test("bug #1: a malformed-% filename aborts 'list' with URIError -- ALL other files in the directory become unreachable too", async () => {
  const { ctx } = makeCtx(POISON_HISTORY_DIR);
  await assertRejects(() => run("list", { chatType: "all" }, ctx), URIError);
});

Deno.test("bug #1: the same malformed-% filename also aborts 'read'", async () => {
  const { ctx } = makeCtx(POISON_HISTORY_DIR);
  await assertRejects(
    () => run("read", { jid: "anything", limit: 0 }, ctx),
    URIError,
  );
});

Deno.test("bug #1: the same malformed-% filename also aborts 'search'", async () => {
  const { ctx } = makeCtx(POISON_HISTORY_DIR);
  await assertRejects(
    () => run("search", { query: "x", chatType: "all", limit: 100 }, ctx),
    URIError,
  );
});

Deno.test("bug #1: the same malformed-% filename also aborts 'importToObsidian' BEFORE any directory is created", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(POISON_HISTORY_DIR);
    await assertRejects(
      () =>
        run("importToObsidian", {
          vaultPath,
          folder: "Jabber",
          chatType: "all",
        }, ctx),
      URIError,
    );
    await assertRejects(() => Deno.stat(`${vaultPath}/Jabber`));
  });
});

// ---------------------------------------------------------------------------
// bug #2 (MEDIUM) -- sanitizeFilename collision silently overwrites notes.
// Two DISTINCT jids can sanitize to the IDENTICAL filename: one whose raw
// jid already contains a literal '-', and one whose jid contains a '/' that
// sanitizeFilename replaces with '-'.
// ---------------------------------------------------------------------------

Deno.test("bug #2: two distinct JIDs that sanitize to the same filename silently overwrite each other -- the returned summary still claims BOTH were written", async () => {
  await withTempHistoryDir({
    // decodeJid: "_at_" -> "@", then decodeURIComponent -- "%2F" -> "/".
    "alice%2Fbob_at_example.com.history":
      "|2024-09-01T00:00:00Z|1|to|0|message from the slash-jid conversation\n",
    "alice-bob_at_example.com.history":
      "|2024-09-02T00:00:00Z|1|to|0|message from the hyphen-jid conversation\n",
  }, async (historyDir) => {
    await withTempVault(async (vaultPath) => {
      const { ctx, written } = makeCtx(historyDir);
      await run(
        "importToObsidian",
        { vaultPath, folder: "Jabber", chatType: "dm" },
        ctx,
      );
      const summary = written.find((w) => w.spec === "summary")!;
      assertEquals(
        summary.payload.totalConversations,
        2,
        "the model believes it wrote 2 distinct notes",
      );
      const names: string[] = [];
      for await (const e of Deno.readDir(`${vaultPath}/Jabber`)) {
        names.push(e.name);
      }
      assertEquals(
        names.length,
        1,
        "only ONE file actually exists on disk -- the second write silently clobbered the first (data loss)",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// bug #3 (MEDIUM) -- Obsidian frontmatter/markdown injection, two vectors:
// (a) a %0A-encoded JID injects a second 'title:' YAML line
// (b) a message body containing a literal '---' line injects a frontmatter
//     delimiter into the body section
// Neither the jid nor the body is escaped for newlines anywhere in the
// markdown-rendering code (only `"` is escaped, via `.replace(/"/g, '\\"')`)
// ---------------------------------------------------------------------------

Deno.test("bug #3a: a %0A-encoded JID injects a second 'title:' line into the YAML frontmatter", async () => {
  await withTempHistoryDir({
    "alice%0Atitle:_HACKED_at_example.com.history":
      "|2024-06-02T00:00:00Z|1|to|0|hello\n",
  }, async (historyDir) => {
    await withTempVault(async (vaultPath) => {
      const { ctx } = makeCtx(historyDir);
      await run(
        "importToObsidian",
        { vaultPath, folder: "Jabber", chatType: "all" },
        ctx,
      );
      const names: string[] = [];
      for await (const e of Deno.readDir(`${vaultPath}/Jabber`)) {
        names.push(e.name);
      }
      assertEquals(names.length, 1);
      const note = await Deno.readTextFile(`${vaultPath}/Jabber/${names[0]}`);
      const titleLines = note.split("\n").filter((l) => l.startsWith("title:"));
      assert(
        titleLines.length >= 2,
        `expected the injected jid to produce a SECOND 'title:' line; got: ${
          JSON.stringify(titleLines)
        }`,
      );
    });
  });
});

Deno.test("bug #3b: a message body containing a literal '---' line injects a second frontmatter delimiter", async () => {
  await withTempHistoryDir({
    "injector_at_example.com.history":
      // Literal backslash-n (two characters) in the fixture bytes -- the
      // model's `.replace(/\\n/g, "\n")` turns this into a REAL newline
      // inside the parsed body, producing a body that is its own '---' line.
      "|2024-06-01T00:00:00Z|1|to|0|---\\nfrontmatter: injected\n",
  }, async (historyDir) => {
    await withTempVault(async (vaultPath) => {
      const { ctx } = makeCtx(historyDir);
      await run(
        "importToObsidian",
        { vaultPath, folder: "Jabber", chatType: "all" },
        ctx,
      );
      const note = await Deno.readTextFile(
        `${vaultPath}/Jabber/injector@example.com.md`,
      );
      const dashLines = note.split("\n").filter((l) => l.trim() === "---");
      assert(
        dashLines.length >= 2,
        "expected the real closing delimiter PLUS an injected one from the message body",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// bug #4 (MEDIUM, characterized AT THE PARSE LAYER ONLY) -- a malformed
// timestamp and an arbitrary (non-enum) direction string pass straight
// through parsePipeDelimited untouched. In a REAL swamp instance,
// `context.writeResource` validates against `ConversationSchema` (whose
// `messages[].timestamp` is `z.iso.datetime()` and `.direction` is a
// 3-value enum) and would reject this payload with a schema error, aborting
// the WHOLE `read` call for every OTHER well-formed message in the same
// conversation too. This suite's fake `writeResource` never runs zod, so it
// can only pin the parse-layer output -- the live abort-on-schema-violation
// behavior is NOT independently enforced by any test in this backfill.
// ---------------------------------------------------------------------------

Deno.test("bug #4 (parse-layer only, see doc comment above): a malformed timestamp gets the same blind 'Z' append, and an arbitrary direction string is never validated", async () => {
  await withTempHistoryDir({
    "garbage_at_example.com.history":
      "|not-a-real-timestamp|1|sideways|0|whatever\n",
  }, async (historyDir) => {
    const { ctx, written } = makeCtx(historyDir);
    await run("read", { jid: "garbage", limit: 0 }, ctx);
    const messages = written[0].payload.messages as Array<
      { timestamp: string; direction: string }
    >;
    assertEquals(messages[0].timestamp, "not-a-real-timestampZ");
    assertEquals(messages[0].direction, "sideways");
  });
});

// ---------------------------------------------------------------------------
// path confinement (swamp-workspace #57) -- resolveVaultPathSafe, copied
// verbatim from obsidian-vault/extensions/models/obsidian_vault.ts (PR #56),
// now confines importToObsidian's noteDir/notePath. This FIXES former bug #5
// (folder path traversal) and adds symlink refusal + realpath-based
// containment, which the old vaultPath-string-concatenation code never had.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was bug #5): a '../'-relative 'folder' is now REJECTED before any directory is created -- no note lands outside the vault", async () => {
  const sandboxRoot = await Deno.makeTempDir({
    prefix: "jabber-traversal-test-",
  });
  try {
    const vaultPath = `${sandboxRoot}/vault`;
    await Deno.mkdir(vaultPath, { recursive: true });
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await assertRejects(
      () =>
        run(
          "importToObsidian",
          { vaultPath, folder: "../escaped", chatType: "dm" },
          ctx,
        ),
      Error,
      "Path escapes vault root",
    );
    await assertRejects(
      () => Deno.stat(`${sandboxRoot}/escaped`),
      "the note must NOT land outside the vault directory",
    );
    await assertRejects(
      () => Deno.stat(`${vaultPath}/escaped`),
      "no directory is created for a rejected traversal path",
    );
  } finally {
    await Deno.remove(sandboxRoot, { recursive: true });
  }
});

Deno.test("path confinement: a nested '../../' traversal buried deeper in 'folder' is also rejected", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await assertRejects(
      () =>
        run(
          "importToObsidian",
          { vaultPath, folder: "sub/../../escaped", chatType: "dm" },
          ctx,
        ),
      Error,
      "Path escapes vault root",
    );
  });
});

Deno.test("path confinement: a symlinked 'folder' path segment is refused via realpath, not silently followed", async () => {
  await withTempVault(async (vaultPath) => {
    const outside = await Deno.makeTempDir({
      prefix: "jabber-symlink-outside-",
    });
    try {
      await Deno.symlink(outside, `${vaultPath}/Jabber`);
      const { ctx } = makeCtx(GOOD_HISTORY_DIR);
      await assertRejects(
        () =>
          run(
            "importToObsidian",
            { vaultPath, folder: "Jabber", chatType: "dm" },
            ctx,
          ),
        Error,
        "symlink",
      );
      await assertRejects(
        () => Deno.stat(`${outside}/alice@example.com.md`),
        "no note may be written through the symlinked folder",
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("path confinement: resolveVaultPathSafe's realRoot is the symlink-resolved root, not the raw configured vaultRoot string (macOS temp dirs resolve /var -> /private/var)", async () => {
  await withTempVault(async (vaultPath) => {
    const target = await resolveVaultPathSafe(
      { vaultRoot: vaultPath },
      "Jabber/note.md",
    );
    const expectedRealRoot = await Deno.realPath(vaultPath);
    assertEquals(
      target.realRoot,
      expectedRealRoot,
      "containment must be computed against the REAL (symlink-resolved) root, not the raw vaultRoot prefix",
    );
    assertEquals(target.absolutePath, `${expectedRealRoot}/Jabber/note.md`);
  });
});

Deno.test("path confinement: importToObsidian with vaultRoot (global argument) writes under the vault's REAL root, byte-identical to the vaultPath-argument branch", async () => {
  await withTempVault(async (vaultPath) => {
    const realVaultPath = await Deno.realPath(vaultPath);

    const viaVaultPath = makeCtx(GOOD_HISTORY_DIR);
    await run(
      "importToObsidian",
      { vaultPath, folder: "Jabber", chatType: "dm" },
      viaVaultPath.ctx,
    );
    const viaVaultPathNote = await Deno.readTextFile(
      `${realVaultPath}/Jabber/alice@example.com.md`,
    );
    await Deno.remove(`${realVaultPath}/Jabber`, { recursive: true });

    const viaVaultRoot = makeCtx(GOOD_HISTORY_DIR);
    (viaVaultRoot.ctx.globalArgs as Record<string, unknown>).vaultRoot =
      vaultPath;
    await run(
      "importToObsidian",
      { folder: "Jabber", chatType: "dm" },
      viaVaultRoot.ctx,
    );
    const viaVaultRootNote = await Deno.readTextFile(
      `${realVaultPath}/Jabber/alice@example.com.md`,
    );

    assertEquals(
      viaVaultRootNote,
      viaVaultPathNote,
      "the vaultRoot global-argument branch must produce byte-identical frontmatter/content to the vaultPath-argument branch",
    );
  });
});

// covered-negative: these importers only ever write into a caller-named
// folder inside the vault -- they never walk the vault directory tree, so
// there is no dot-dir/.trash EXCLUSION logic to have (unlike obsidian-vault's
// `list`/`digest`, which do walk and must skip hidden directories).
Deno.test("covered-negative: dot-dir/.trash exclusion is N/A -- importToObsidian never walks the vault, it only writes into the caller-named folder", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await run(
      "importToObsidian",
      { vaultPath, folder: ".trash", chatType: "dm" },
      ctx,
    );
    // A literal ".trash" folder name is honored as an ordinary destination --
    // there is no vault-walk to exclude it from, so no exclusion rule applies.
    const stat = await Deno.stat(`${vaultPath}/.trash/alice@example.com.md`);
    assert(stat.isFile);
  });
});

// ---------------------------------------------------------------------------
// bug #6 (MEDIUM) -- no timeout/AbortSignal is ever passed to the `obsidian`
// subprocess. A real hang is NEVER simulated in this test suite (per plan
// constraint); this only pins the ABSENCE of any timeout mechanism.
// ---------------------------------------------------------------------------

Deno.test("bug #6: the obsidian subprocess is spawned with no AbortSignal/timeout option -- a hung CLI would block the import indefinitely (not simulated here)", async () => {
  await withTempVault(async (resolvedPath) => {
    const { ctx } = makeCtx(GOOD_HISTORY_DIR);
    await withCommandStub(
      () => ({ success: true, stdout: `${resolvedPath}\n` }),
      async (calls) => {
        await run(
          "importToObsidian",
          { vault: "any-vault", folder: "Jabber", chatType: "dm" },
          ctx,
        );
        assertEquals(calls.length, 1);
        assertEquals("signal" in calls[0].options, false);
        assertEquals("timeout" in calls[0].options, false);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// bug #7 (LOW) -- 'obsidian' is resolved as a bare PATH-relative command
// name, never an absolute path (PATH-hijack risk if a malicious `obsidian`
// binary precedes the real one on $PATH). Paired with a covered-negative:
// the argv API means no shell metacharacter in the vault NAME can inject a
// second command.
// ---------------------------------------------------------------------------

Deno.test("bug #7: 'obsidian' is spawned as a bare PATH-resolved command name, not an absolute path", async () => {
  const { ctx } = makeCtx(GOOD_HISTORY_DIR);
  await withCommandStub(
    (cmd) => {
      assertEquals(cmd, "obsidian");
      assert(
        !cmd.startsWith("/"),
        "expected a bare command name, not an absolute path",
      );
      return { success: false, stderr: "not relevant to this pin" };
    },
    async () => {
      await assertRejects(() =>
        run(
          "importToObsidian",
          { vault: "x", folder: "Jabber", chatType: "all" },
          ctx,
        )
      );
    },
  );
});

Deno.test("covered-negative: a vault name containing shell metacharacters is forwarded as ONE argv element -- no shell injection", async () => {
  const dangerousVaultName = "my-vault; rm -rf ~; echo pwned $(whoami)";
  const { ctx } = makeCtx(GOOD_HISTORY_DIR);
  await withCommandStub(
    (_cmd, options) => {
      const args = options.args as string[];
      assertEquals(
        args,
        ["vault", `vault=${dangerousVaultName}`, "info=path"],
        "the dangerous string must survive as a single, unsplit argv element",
      );
      assertEquals(args.length, 3);
      return { success: false, stderr: "not relevant to this pin" };
    },
    async () => {
      await assertRejects(() =>
        run(
          "importToObsidian",
          { vault: dangerousVaultName, folder: "Jabber", chatType: "all" },
          ctx,
        )
      );
    },
  );
});

// ---------------------------------------------------------------------------
// XXE-falsification covered-negative -- this model parses NO XML whatsoever
// (confirmed by reading the frozen source: only pipe-split and one plain
// -text line regex, no DOMParser/XML dependency anywhere). An XML/DOCTYPE
// /billion-laughs payload inside a message body is inert literal text.
// ---------------------------------------------------------------------------

Deno.test("covered-negative: an XML/DOCTYPE/billion-laughs payload inside a message body is NEVER parsed as XML -- it survives as inert literal text (this model has no XML dependency at all)", async () => {
  const xxePayload =
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
  await withTempHistoryDir({
    "xxe_at_example.com.history":
      `|2024-07-01T00:00:00Z|1|to|0|${xxePayload}\n`,
  }, async (historyDir) => {
    const { ctx, written } = makeCtx(historyDir);
    await run("read", { jid: "xxe", limit: 0 }, ctx);
    const messages = written[0].payload.messages as Array<{ body: string }>;
    assertEquals(
      messages[0].body,
      xxePayload,
      "the payload must survive byte-for-byte -- no entity expansion, no external entity resolution, no XML parser ever touches it",
    );
  });
});

// ---------------------------------------------------------------------------
// bug #9 (LOW) -- sanitizeFilename's `.slice(0, 80)` is a UTF-16 code-unit
// cut that can split a surrogate pair straddling the boundary, emitting a
// lone unpaired high surrogate. Asserted via whichever of the two paths the
// runtime actually takes (a written file, OR a caught write failure logged
// as a warning) -- both paths expose the IDENTICAL sanitizeFilename() output.
// ---------------------------------------------------------------------------

Deno.test("bug #9: sanitizeFilename's slice(0,80) can split a surrogate pair at the truncation boundary", async () => {
  const pad = "a".repeat(79);
  const emoji = "\u{1F600}"; // U+1F600 GRINNING FACE -- a UTF-16 surrogate pair
  const jid = `${pad}${emoji}@example.com`;
  const filename = `${jid.replace(/@/g, "_at_")}.history`;
  await withTempHistoryDir(
    { [filename]: "|2024-08-01T00:00:00Z|1|to|0|hi\n" },
    async (historyDir) => {
      await withTempVault(async (vaultPath) => {
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
        let stem: string;
        if (names.length === 1) {
          stem = names[0].replace(/\.md$/, "");
        } else {
          const warnLog = logs.find((l) => l.level === "warn");
          assert(
            warnLog,
            "expected either a written note or a warn log for a failed write",
          );
          const msg = warnLog!.args[0] as string;
          const m = msg.match(/^Failed to write (.*): /);
          assert(
            m,
            `warn message didn't match 'Failed to write <stem>: ' shape: ${msg}`,
          );
          stem = m![1];
        }
        assertEquals(
          stem.length,
          80,
          "sanitizeFilename slices to exactly 80 UTF-16 code units",
        );
        const last = stem.charCodeAt(79);
        const isLoneHighSurrogate = last >= 0xD800 && last <= 0xDBFF;
        const isReplacementChar = last === 0xFFFD;
        // Two observed outcomes for the SAME underlying bug: sanitizeFilename
        // itself always emits a lone high surrogate at position 79 (that part
        // is asserted whenever the write fails and we read it back from the
        // warn log, un-mangled). But when Deno.writeTextFile actually
        // SUCCEEDS (observed on macOS/APFS), the OS/runtime's UTF-16-to-UTF-8
        // path encoding silently substitutes the WHATWG replacement
        // character U+FFFD for the unpaired surrogate -- so reading the
        // filename back via Deno.readDir shows U+FFFD, not the original lone
        // surrogate. Both outcomes are the SAME bug (#9): sanitizeFilename
        // never guards the UTF-16 slice boundary against splitting a pair.
        assert(
          isLoneHighSurrogate || isReplacementChar,
          `the 80th code unit must be either a lone HIGH surrogate (pre-mangling) or U+FFFD (post round-trip through the filesystem) -- got 0x${
            last.toString(16)
          }`,
        );
      });
    },
  );
});
