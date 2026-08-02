/**
 * Adversarial suite for @magistr/jabber (jabber_history.ts) -- attacker's
 * -perspective tests: malformed filenames, injection, PATH-hijack, and a
 * falsified-XXE covered-negative (this model parses NO XML at all -- see
 * below).
 *
 * Eight latent bugs (#1-4, #6-9) were tracked in the LOCAL
 * `jabber-latent-bugs` issue-lifecycle model (never filed to the swamp.club
 * Lab) and are now FIXED by this change -- this file pins the FIXED behavior
 * for bugs #1, #2, #3 (both vectors), #4 (now offline-testable via the
 * post-parse MessageSchema guard, no longer live-only), #6, #7, and #9 -- see
 * jabber_coverage_test.ts for #8 (unbounded memory). **Bug #5 (folder path
 * traversal) was already FIXED** by the headless `vaultRoot`/path-confinement
 * change (swamp-workspace #57, mirrors PR #56's obsidian-vault backend split)
 * -- see the "path confinement" section below, untouched by this change.
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
// FIXED (was bug #1) -- decodeURIComponent on a malformed-% filename used to
// throw a URIError straight out of listHistoryFiles' for-await loop, aborting
// EVERY method for the WHOLE directory over one poisoned file. decodeJid now
// wraps decodeURIComponent in try/catch and falls back to the _at_-replaced
// raw string (sanitize-not-abort). `fixtures/poison/history/` holds exactly
// `bad%ZZ.history`, kept out of `fixtures/good/` so this characterization
// stays isolated (see PROVENANCE.md).
// ---------------------------------------------------------------------------

Deno.test("FIXED (was bug #1): a malformed-% filename no longer aborts 'list' -- it is listed with the _at_-replaced raw string as a fallback jid", async () => {
  const { ctx, written } = makeCtx(POISON_HISTORY_DIR);
  await run("list", { chatType: "all" }, ctx);
  const summary = written[0].payload;
  assertEquals(summary.totalConversations, 1);
  const jids = (summary.conversations as Array<{ jid: string }>).map((c) =>
    c.jid
  );
  assertEquals(jids, ["bad%ZZ"]);
});

Deno.test("FIXED (was bug #1): the same malformed-% filename no longer aborts 'read'", async () => {
  const { ctx, written } = makeCtx(POISON_HISTORY_DIR);
  await run("read", { jid: "bad", limit: 0 }, ctx);
  assertEquals(written.length, 1);
});

Deno.test("FIXED (was bug #1): the same malformed-% filename no longer aborts 'search'", async () => {
  const { ctx, written } = makeCtx(POISON_HISTORY_DIR);
  await run("search", { query: "x", chatType: "all", limit: 100 }, ctx);
  assertEquals(written[0].payload.totalMessages, 0);
});

Deno.test("FIXED (was bug #1): the same malformed-% filename no longer aborts 'importToObsidian' -- the Jabber/ folder is created and the poisoned entry is processed", async () => {
  await withTempVault(async (vaultPath) => {
    const { ctx } = makeCtx(POISON_HISTORY_DIR);
    await run("importToObsidian", {
      vaultPath,
      folder: "Jabber",
      chatType: "all",
    }, ctx);
    const stat = await Deno.stat(`${vaultPath}/Jabber`);
    assert(stat.isDirectory, "the Jabber/ folder must be created, not aborted");
  });
});

Deno.test("FIXED (was bug #1), non-vacuous: a directory mixing a good file and the poisoned filename still lists the GOOD file -- the poisoned one no longer takes the whole directory down with it", async () => {
  const root = await Deno.makeTempDir({ prefix: "jabber-mixed-poison-test-" });
  const historyDir = `${root}/history`;
  await Deno.mkdir(historyDir, { recursive: true });
  await Deno.writeTextFile(
    `${historyDir}/gooduser_at_example.com.history`,
    "|2024-10-10T00:00:00Z|1|to|0|a perfectly good message\n",
  );
  await Deno.writeTextFile(`${historyDir}/bad%ZZ.history`, "");
  try {
    const { ctx, written } = makeCtx(root);
    await run("list", { chatType: "all" }, ctx);
    const summary = written[0].payload;
    const jids = (summary.conversations as Array<{ jid: string }>).map((c) =>
      c.jid
    ).sort();
    assertEquals(
      jids,
      ["bad%ZZ", "gooduser@example.com"],
      "the good file must be listed alongside the poisoned one, not collateral damage of it",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// FIXED (was bug #2) -- sanitizeFilename collision used to silently overwrite
// notes. Two DISTINCT jids can sanitize to the IDENTICAL filename: one whose
// raw jid already contains a literal '-', and one whose jid contains a '/'
// that sanitizeFilename replaces with '-'. importToObsidian now tracks used
// stems in a Map and appends " (2)", " (3)", ... on collision (the same
// pattern fidonet_msgbase.ts uses for its Obsidian note paths).
// ---------------------------------------------------------------------------

Deno.test("FIXED (was bug #2): two distinct JIDs that sanitize to the same filename now BOTH survive on disk, distinctly named", async () => {
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
        "the model wrote 2 distinct notes",
      );
      const names: string[] = [];
      for await (const e of Deno.readDir(`${vaultPath}/Jabber`)) {
        names.push(e.name);
      }
      assertEquals(
        names.length,
        2,
        "BOTH files actually exist on disk -- the collision no longer clobbers, it gets a ' (2)' suffix instead",
      );
      const bodies: string[] = [];
      for (const name of names) {
        bodies.push(await Deno.readTextFile(`${vaultPath}/Jabber/${name}`));
      }
      assert(
        bodies.some((b) =>
          b.includes("message from the slash-jid conversation")
        ),
        "the slash-jid conversation's body must survive on disk",
      );
      assert(
        bodies.some((b) =>
          b.includes("message from the hyphen-jid conversation")
        ),
        "the hyphen-jid conversation's body must survive on disk",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// FIXED (was bug #3) -- Obsidian frontmatter/markdown injection, two vectors:
// (a) a %0A-encoded JID used to inject a second 'title:' YAML line -- now
//     neutralized by yamlEscape (copied verbatim from
//     livejournal_import.ts), which escapes embedded newlines to the literal
//     two-character sequence '\n' inside the double-quoted YAML scalar.
// (b) a message body containing a literal '---' line used to inject a
//     frontmatter delimiter into the body section -- now neutralized by
//     neutralizeBodyDelimiters, which backslash-escapes any body LINE that,
//     trimmed, is exactly a '---'/'***'/'___' delimiter.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was bug #3a): a %0A-encoded JID's embedded newline is yaml-escaped -- no second 'title:' line is injected", async () => {
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
      assertEquals(
        titleLines.length,
        1,
        `expected the injected newline to be escaped, not to produce a second 'title:' line; got: ${
          JSON.stringify(titleLines)
        }`,
      );
      assert(
        titleLines[0].includes("\\ntitle:_HACKED"),
        `expected the escaped literal '\\n' followed by the injected text inside the single title: line; got: ${
          titleLines[0]
        }`,
      );
    });
  });
});

Deno.test("FIXED (was bug #3b), non-vacuous: a message body containing an internal '---' line no longer injects a second frontmatter delimiter", async () => {
  await withTempHistoryDir({
    "injector_at_example.com.history":
      // Literal backslash-n (two characters) in the fixture bytes -- the
      // model's `.replace(/\\n/g, "\n")` turns this into a REAL newline
      // inside the parsed body, producing a 3-line body whose middle line is
      // exactly '---'.
      "|2024-06-01T00:00:00Z|1|to|0|seen\\n---\\ngone\n",
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
      assertEquals(
        dashLines.length,
        2,
        "expected ONLY the real frontmatter open/close delimiters -- the injected body line must no longer count (an unfixed model produces 3)",
      );
      assert(
        note.includes("seen") && note.includes("gone"),
        "the literal body text on either side of the neutralized delimiter must survive",
      );
      assert(
        note.includes("\\---"),
        "the injected '---' line must survive as a backslash-escaped, visually-intact literal, not be stripped",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// FIXED (was bug #4, live-only -- NOW offline-testable) -- a malformed
// timestamp and an arbitrary (non-enum) direction string used to pass
// straight through parsePipeDelimited untouched. In a REAL swamp instance,
// `context.writeResource` validates against `ConversationSchema` (whose
// `messages[].timestamp` is `z.iso.datetime()` and `.direction` is a
// 3-value enum) and would have rejected the WHOLE payload, aborting `read`
// for every OTHER well-formed message in the same conversation too. `read`
// now runs a post-parse guard (filterValidMessages) against the model's own
// MessageSchema and drops only the invalid message, so this is no longer a
// live-only characterization: the fixture below directly asserts
// `model.resources.conversation.schema.parse(payload)` no longer throws.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was bug #4): a malformed timestamp/direction message is dropped by the post-parse MessageSchema guard, leaving its valid sibling -- the resource now parses against ConversationSchema without throwing", async () => {
  await withTempHistoryDir({
    "garbage_at_example.com.history":
      "|not-a-real-timestamp|1|sideways|0|whatever\n" +
      "|2024-09-10T12:00:00Z|1|to|0|a perfectly valid sibling message\n",
  }, async (historyDir) => {
    const { ctx, written, logs } = makeCtx(historyDir);
    await run("read", { jid: "garbage", limit: 0 }, ctx);
    const payload = written[0].payload;
    const messages = payload.messages as Array<
      { timestamp: string; direction: string; body: string }
    >;
    assertEquals(
      messages.length,
      1,
      "only the valid sibling message must survive",
    );
    assertEquals(messages[0].timestamp, "2024-09-10T12:00:00Z");
    assertEquals(messages[0].direction, "to");
    assertEquals(messages[0].body, "a perfectly valid sibling message");
    const warnLog = logs.find((l) => l.level === "warn");
    assert(warnLog, "expected a warn log for the dropped invalid message");
    // This is the live-instance behavior this bug used to abort: the
    // resource this method wrote must now parse cleanly against the model's
    // own ConversationSchema.
    model.resources.conversation.schema.parse(payload);
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
// FIXED (was bug #6) -- the `obsidian` subprocess previously carried no
// timeout/AbortSignal at all, so a hung CLI blocked the import indefinitely.
// It now always carries an AbortController-derived `signal` (a manual
// setTimeout/clearTimeout pair, never `AbortSignal.timeout()` -- see the
// doc comment on jabber_history.ts's getVaultPath). A real hang is still
// never simulated here (per plan constraint); this pins the PRESENCE of the
// signal option, not a live timeout firing.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was bug #6): the obsidian subprocess is now spawned with an AbortSignal derived from a timeoutMs-bounded AbortController", async () => {
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
        assertEquals("signal" in calls[0].options, true);
        assert(
          calls[0].options.signal instanceof AbortSignal,
          "the signal option must be a real AbortSignal",
        );
        // No bare `timeout` option is passed -- the timeout is implemented
        // via the AbortController/setTimeout pair, not a Deno.Command option
        // (which does not exist).
        assertEquals("timeout" in calls[0].options, false);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// FIXED (was bug #7) -- 'obsidian' used to be resolved as an UNCONDITIONAL
// bare PATH-relative command name (PATH-hijack risk if a malicious
// `obsidian` binary precedes the real one on $PATH), with no way to pin an
// absolute path. A new `obsidianBin` global argument now lets an operator
// pin an absolute path (see jabber_methods_test.ts's obsidianBin coverage);
// this test pins the still-current DEFAULT (obsidianBin unset -> bare
// "obsidian", unchanged for backward compatibility). Paired with a
// covered-negative: the argv API means no shell metacharacter in the vault
// NAME can inject a second command.
// ---------------------------------------------------------------------------

Deno.test("bug #7 default (mitigable via obsidianBin): with obsidianBin unset, 'obsidian' is still spawned as a bare PATH-resolved command name, not an absolute path", async () => {
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
// FIXED (was bug #9) -- sanitizeFilename's `.slice(0, 80)` used to be a raw
// UTF-16 code-unit cut that could split a surrogate pair straddling the
// boundary, emitting a lone unpaired high surrogate. sanitizeFilename now
// slices via `Array.from(...).slice(0, 80).join("")`, which iterates by
// Unicode code point, so the cut can never land inside a surrogate pair.
// ---------------------------------------------------------------------------

Deno.test("FIXED (was bug #9): sanitizeFilename's code-point-aware slice never splits a surrogate pair at the truncation boundary", async () => {
  const pad = "a".repeat(79);
  const emoji = "\u{1F600}"; // U+1F600 GRINNING FACE -- a UTF-16 surrogate pair
  const jid = `${pad}${emoji}@example.com`;
  const filename = `${jid.replace(/@/g, "_at_")}.history`;
  await withTempHistoryDir(
    { [filename]: "|2024-08-01T00:00:00Z|1|to|0|hi\n" },
    async (historyDir) => {
      await withTempVault(async (vaultPath) => {
        const { ctx } = makeCtx(historyDir);
        await run(
          "importToObsidian",
          { vaultPath, folder: "Jabber", chatType: "dm" },
          ctx,
        );
        const names: string[] = [];
        for await (const e of Deno.readDir(`${vaultPath}/Jabber`)) {
          names.push(e.name);
        }
        assertEquals(names.length, 1);
        const stem = names[0].replace(/\.md$/, "");
        const codePoints = Array.from(stem);
        assertEquals(
          codePoints.length,
          80,
          "sanitizeFilename slices to exactly 80 Unicode code points",
        );
        assertEquals(
          codePoints[79],
          emoji,
          "the 80th code point must be the INTACT emoji, never a split surrogate half",
        );
        // No lone surrogate anywhere in the stem -- every high surrogate is
        // immediately followed by its low surrogate pair, and vice versa.
        for (let i = 0; i < stem.length; i++) {
          const code = stem.charCodeAt(i);
          const isHighSurrogate = code >= 0xD800 && code <= 0xDBFF;
          const isLowSurrogate = code >= 0xDC00 && code <= 0xDFFF;
          if (isHighSurrogate) {
            const next = stem.charCodeAt(i + 1);
            assert(
              i + 1 < stem.length && next >= 0xDC00 && next <= 0xDFFF,
              "a high surrogate must always be immediately followed by its low surrogate pair",
            );
          }
          if (isLowSurrogate) {
            const prev = stem.charCodeAt(i - 1);
            assert(
              i > 0 && prev >= 0xD800 && prev <= 0xDBFF,
              "a low surrogate must always be immediately preceded by its high surrogate pair",
            );
          }
        }
      });
    },
  );
});
