// Coverage/regression tests for @magistr/obsidian-vault — branch/edge gaps
// left uncovered by obsidian_vault_test.ts (the contract-fixture suite) and
// obsidian_vault_methods_test.ts (the methods suite). Each test here targets
// a SPECIFIC guard or branch that a code reviewer could delete without any
// existing test going red.
//
// obsidian_vault.ts is BYTE-FROZEN. Two tests below (marked `pin: KNOWN BUG`)
// characterize a NEWLY DISCOVERED latent bug found while writing this exact
// suite — obsidian-vault-latent-bugs #8, filed alongside the seven bugs the
// approved plan's adversarial review already cataloged. Writing an exhaustive
// methods/coverage suite is precisely the kind of exercise that surfaces
// bugs static review missed; #8 is reported the same way as #1-#7 (a local,
// non-blocking, `accepted` finding — never a swamp.club Lab issue).
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { model, propertyTypeHint, selectBackend } from "./obsidian_vault.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Captured {
  spec: string;
  name: string;
  attrs: Record<string, unknown>;
}

function fsContext(root: string, over: Record<string, unknown> = {}) {
  const captured: Captured[] = [];
  return {
    captured,
    context: {
      globalArgs: {
        vault: "testvault",
        vaultRoot: root,
        backend: "auto",
        blockDotObsidian: true,
        defaultFileMode: 0o644,
        defaultDirectoryMode: 0o755,
        ...over,
      },
      logger: { info: () => {}, warning: () => {} },
      writeResource: (
        spec: string,
        name: string,
        attrs: Record<string, unknown>,
      ) => {
        captured.push({ spec, name, attrs });
        return Promise.resolve({ name });
      },
    },
  };
}

async function withVault(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
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
// digest: matchName branches (datePrefixes / nameContains / both / neither)
// ---------------------------------------------------------------------------

Deno.test("digest: nameContains alone matches a substring and excludes everything else", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/keep-me.md`, "a");
    await Deno.writeTextFile(`${root}/skip.md`, "b");
    const a = fsContext(root);
    await run("digest", { nameContains: ["keep"] }, a.context);
    const files = a.captured[0].attrs.files as { file: string }[];
    assertEquals(files.map((f) => f.file), ["keep-me.md"]);
  });
});

Deno.test("digest: datePrefixes alone matches a filename prefix and excludes everything else", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/2026-07-27-standup.md`, "a");
    await Deno.writeTextFile(`${root}/random.md`, "b");
    const a = fsContext(root);
    await run("digest", { datePrefixes: ["2026-07-27"] }, a.context);
    const files = a.captured[0].attrs.files as { file: string }[];
    assertEquals(files.map((f) => f.file), ["2026-07-27-standup.md"]);
  });
});

Deno.test("digest: when both filters are given, nameContains short-circuits before datePrefixes is even checked", async () => {
  await withVault(async (root) => {
    // Matches nameContains but NOT datePrefixes — still included, because
    // matchName's `nameContains.some(...)` branch returns true first.
    await Deno.writeTextFile(`${root}/keep-random-name.md`, "a");
    // Matches datePrefixes but NOT nameContains — reached only via the final
    // `datePrefixes.some(...)` return, proving the fallthrough path also works.
    await Deno.writeTextFile(`${root}/2026-01-01-other.md`, "b");
    // Matches neither — excluded.
    await Deno.writeTextFile(`${root}/nothing.md`, "c");
    const a = fsContext(root);
    await run(
      "digest",
      { nameContains: ["keep"], datePrefixes: ["2026-01-01"] },
      a.context,
    );
    const files = (a.captured[0].attrs.files as { file: string }[])
      .map((f) => f.file)
      .sort();
    assertEquals(files, ["2026-01-01-other.md", "keep-random-name.md"]);
  });
});

Deno.test("digest: with neither filter, every markdown file matches (the length-0/length-0 short-circuit)", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/a.md`, "a");
    await Deno.writeTextFile(`${root}/b.md`, "b");
    const a = fsContext(root);
    await run("digest", {}, a.context);
    assertEquals(a.captured[0].attrs.fileCount, 2);
  });
});

// ---------------------------------------------------------------------------
// fileInfo: dotfile extension edge (dot index 0, not > 0)
// ---------------------------------------------------------------------------

Deno.test("fileInfo: a dotfile with no real extension reports extension as empty, not the whole name", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/.gitignore`, "node_modules/");
    const a = fsContext(root);
    await run(
      "fileInfo",
      { file: ".gitignore", allowDotObsidian: true },
      a.context,
    );
    assertEquals(a.captured[0].attrs.name, ".gitignore");
    assertEquals(a.captured[0].attrs.extension, "");
  });
});

// ---------------------------------------------------------------------------
// propertyRemove: a note with NO frontmatter block at all (hasFrontmatter=false)
// ---------------------------------------------------------------------------

Deno.test("propertyRemove: a note with no frontmatter block is returned unchanged and never written", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/plain.md`, "# Just a heading\n\nbody\n");
    const before = await Deno.stat(`${root}/plain.md`);
    const a = fsContext(root);
    await run(
      "propertyRemove",
      { file: "plain.md", name: "anything" },
      a.context,
    );
    const after = await Deno.stat(`${root}/plain.md`);
    assertEquals(before.mtime?.getTime(), after.mtime?.getTime());
    assertEquals(
      await Deno.readTextFile(`${root}/plain.md`),
      "# Just a heading\n\nbody\n",
    );
  });
});

// ---------------------------------------------------------------------------
// search: empty query and the `path` alias for `folder`
// ---------------------------------------------------------------------------

Deno.test("search: an empty-string query matches every line (String#includes('') is always true)", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, "alpha\nbeta\ngamma");
    const a = fsContext(root);
    await run("search", { query: "" }, a.context);
    const results = a.captured[0].attrs.results as {
      file: string;
      matches: unknown[];
    }[];
    assertEquals(results[0].matches.length, 3);
  });
});

Deno.test("search: the `path` argument works as an alias for `folder`", async () => {
  await withVault(async (root) => {
    await Deno.mkdir(`${root}/notes`);
    await Deno.writeTextFile(`${root}/notes/a.md`, "needle");
    await Deno.writeTextFile(`${root}/other.md`, "needle");
    const a = fsContext(root);
    await run("search", { query: "needle", path: "notes" }, a.context);
    const results = a.captured[0].attrs.results as { file: string }[];
    // The returned path is relative to the VAULT root, not to the searched
    // subfolder — `path`/`folder` only scope which directory is walked.
    assertEquals(results.map((r) => r.file), ["notes/a.md"]);
  });
});

// ---------------------------------------------------------------------------
// list: the ext filter tolerates a leading dot
// ---------------------------------------------------------------------------

Deno.test("list: ext='.md' behaves identically to ext='md'", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/a.md`, "a");
    await Deno.writeTextFile(`${root}/b.txt`, "b");
    const withDot = fsContext(root);
    await run("list", { ext: ".md" }, withDot.context);
    const withoutDot = fsContext(root);
    await run("list", { ext: "md" }, withoutDot.context);
    assertEquals(withDot.captured[0].attrs.files, ["a.md"]);
    assertEquals(withoutDot.captured[0].attrs.files, ["a.md"]);
  });
});

// ---------------------------------------------------------------------------
// append: explicit separator wins over inline=true (joinSeparator precedence)
// ---------------------------------------------------------------------------

Deno.test("append: an explicit separator wins even when inline=true is also set", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/log.md`, "first");
    const a = fsContext(root);
    await run(
      "append",
      { file: "log.md", content: "second", separator: " | ", inline: true },
      a.context,
    );
    assertEquals(await Deno.readTextFile(`${root}/log.md`), "first | second");
  });
});

// ---------------------------------------------------------------------------
// propertyTypeHint: zero is a number too (typeof check, not truthiness)
// ---------------------------------------------------------------------------

Deno.test("propertyTypeHint: 0 is still hinted as a number (a truthiness check would miss this)", () => {
  assertEquals(propertyTypeHint(0), "number");
});

// ---------------------------------------------------------------------------
// selectBackend: the no-headless-alternative message shape
// ---------------------------------------------------------------------------

Deno.test("selectBackend: a CLI-only method with no headless alternative ends the message with a bare period", () => {
  assertThrows(
    () => selectBackend({ backend: "fs" }, "move"),
    Error,
    "Obsidian desktop app running.",
  );
  try {
    selectBackend({ backend: "fs" }, "move");
    assert(false, "unreachable");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert(
      !message.includes("headless approximation"),
      "move has no HEADLESS_ALTERNATIVE entry — the message must not suggest one",
    );
  }
});

Deno.test("selectBackend: a CLI-only method WITH a headless alternative names it", () => {
  assertThrows(
    () => selectBackend({ backend: "fs" }, "unresolved"),
    Error,
    'use "digest" for a headless approximation',
  );
});

// ---------------------------------------------------------------------------
// pin: KNOWN BUG (MED, obsidian-vault-latent-bugs #8) — operationResult.action
// is a hardcoded literal for setProperties and propertyRemove, not the real
// write outcome. classifyWrite's own doc comment promises "a real idempotency
// signal"; these two methods compute (setProperties) or could compute
// (propertyRemove) that signal and then discard it in favor of a fixed
// string, so a caller branching on `action` to skip downstream work on a true
// no-op is misled every time.
// ---------------------------------------------------------------------------

Deno.test(
  "pin: KNOWN BUG (MED, obsidian-vault-latent-bugs #8) — setProperties reports action:'updated' for a brand-new file, an unchanged repeat, AND a real change alike",
  async () => {
    await withVault(async (root) => {
      const created = fsContext(root);
      await run(
        "setProperties",
        { file: "note.md", properties: { status: "active" } },
        created.context,
      );
      assertEquals(created.captured[0].attrs.action, "updated");
      const stat1 = await Deno.stat(`${root}/note.md`);

      // Same properties again — the file is byte-identical afterwards (a
      // TRUE no-op, confirmed via mtime), yet the reported action is
      // unchanged from the first ("created") call.
      const repeat = fsContext(root);
      await run(
        "setProperties",
        { file: "note.md", properties: { status: "active" } },
        repeat.context,
      );
      const stat2 = await Deno.stat(`${root}/note.md`);
      assertEquals(
        stat1.mtime?.getTime(),
        stat2.mtime?.getTime(),
        "the write really was skipped — this is a true no-op",
      );
      assertEquals(
        repeat.captured[0].attrs.action,
        "updated",
        "misleading: a true no-op still reports 'updated'",
      );

      // A genuine change reports the SAME literal — not distinguishable from
      // the no-op case above by inspecting `action` alone.
      const changed = fsContext(root);
      await run(
        "setProperties",
        { file: "note.md", properties: { status: "archived" } },
        changed.context,
      );
      assertEquals(changed.captured[0].attrs.action, "updated");
    });
  },
);

Deno.test(
  "pin: KNOWN BUG (MED, obsidian-vault-latent-bugs #8) — propertyRemove reports action:'updated' even when the file was never written (absent key, or no frontmatter at all)",
  async () => {
    await withVault(async (root) => {
      await Deno.writeTextFile(
        `${root}/note.md`,
        "---\ntitle: T\n---\n\nbody\n",
      );
      const before = await Deno.stat(`${root}/note.md`);
      const a = fsContext(root);
      await run(
        "propertyRemove",
        { file: "note.md", name: "never-existed" },
        a.context,
      );
      const after = await Deno.stat(`${root}/note.md`);
      assertEquals(
        before.mtime?.getTime(),
        after.mtime?.getTime(),
        "no write actually happened",
      );
      assertEquals(
        a.captured[0].attrs.action,
        "updated",
        "misleading: no write happened, but action still says 'updated'",
      );
    });
  },
);
