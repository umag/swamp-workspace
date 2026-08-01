// Method-level characterization tests for @magistr/obsidian-vault.
//
// obsidian_vault.ts is BYTE-FROZEN by this change — every test below PINS the
// model's current, already-shipped behavior. This is not red-green TDD: there
// is no new behavior to drive out, only existing behavior to characterize.
//
// Method-coverage checklist — every one of the 24 methods in
// `Object.keys(model.methods)` is exercised at least once IN THIS FILE (the
// final test below asserts this mechanically), regardless of what
// obsidian_vault_test.ts (the contract-fixture suite) already covers. Column
// "contract-fixture" marks what that suite already drives via `.execute()`;
// column "this suite" marks the angle this file adds (a genuinely new
// scenario where the method was already touched, or first-ever `.execute()`
// coverage for the 11 CLI-only methods and the two fs methods the contract
// suite never called: `properties`, `propertyRemove`).
//
// | method          | contract-fixture              | this suite                          |
// |-----------------|--------------------------------|---------------------------------------|
// | list            | recursive/limit/ext/sort (fs) | CLI backend (folder/ext/recursive)    |
// | read            | symlink rejection (fs)        | fs happy + missing-file, CLI happy    |
// | fileInfo        | exists=false (fs)              | fs happy (existing file), CLI happy   |
// | create          | created/unchanged/updated (fs)| CLI backend with template             |
// | append          | separator + create-missing(fs)| fs nested-parent-dir auto-creation    |
// | prepend         | frontmatter-aware insert (fs) | CLI backend                           |
// | delete          | trash/permanent/dryRun (fs)   | CLI backend permanent + dryRun        |
// | move            | (none)                        | CLI backend (only backend it has)     |
// | search          | truncation/sort (fs), regex-on-cli rejection | CLI backend (non-regex) |
// | digest          | structure/body-retention (fs) | fs minimal empty-vault edge case      |
// | tags            | (none)                        | CLI backend (only backend it has)     |
// | tag             | (none)                        | CLI backend (only backend it has)     |
// | links           | (none)                        | CLI backend (only backend it has)     |
// | backlinks       | (none)                        | CLI backend, both response shapes     |
// | orphans         | (none)                        | CLI backend (only backend it has)     |
// | unresolved      | (none)                        | CLI backend (only backend it has)     |
// | daily           | (none)                        | CLI backend (only backend it has)     |
// | dailyRead       | (none)                        | CLI backend, two-call sequence        |
// | dailyAppend     | (none)                        | CLI backend (only backend it has)     |
// | dailyPrepend    | (none)                        | CLI backend (only backend it has)     |
// | properties      | (none)                        | fs happy + missing-file, CLI happy    |
// | propertySet     | list-type coercion (fs)       | CLI backend with type hint            |
// | setProperties   | merge/idempotent (fs)         | CLI backend fan-out (one call/key)    |
// | propertyRemove  | (none)                        | fs happy + no-op + missing-file, CLI  |
//
// CLI-only methods cannot run in CI (they need the Obsidian desktop app), so
// their contract is pinned at the argv boundary via a `(Deno as any).Command`
// stub — the same pattern obsidian_vault_test.ts already uses for `append`.
// TS2352 note: this repo deliberately avoids `as typeof Deno.Command` casts;
// `(Deno as any).Command` is the established idiom here.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, readProperties } from "./obsidian_vault.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

function fixture(name: string): string {
  return Deno.readTextFileSync(`${FIXTURES}${name}`);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Every method executed via `run()` below, so the final checklist assertion
 * can confirm all 24 were exercised without depending on any other file. */
const EXERCISED = new Set<string>();

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

/** Mirror the swamp runtime: arguments are schema-parsed (defaults applied)
 * before execute is invoked — never call execute() with raw, unparsed args. */
function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  EXERCISED.add(name);
  return method.execute(method.arguments.parse(args), ctx);
}

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

function cliContext(over: Record<string, unknown> = {}) {
  const captured: Captured[] = [];
  return {
    captured,
    context: {
      globalArgs: {
        vault: "testvault",
        vaultRoot: undefined,
        backend: "cli",
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

/** Install a Deno.Command stub returning one stdout string per call, in call
 * order (the last entry repeats if a test makes more calls than it listed —
 * most tests need exactly one or two, matched exactly by length below). */
async function withCliStub(
  stdouts: string[],
  fn: () => Promise<void>,
): Promise<string[][]> {
  const calls: string[][] = [];
  let i = 0;
  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    constructor(_cmd: string, opts: { args: string[] }) {
      calls.push(opts.args);
    }
    output() {
      const stdout = stdouts[Math.min(i, stdouts.length - 1)];
      i++;
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: new TextEncoder().encode(stdout),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
  return calls;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

Deno.test("read: fs happy path returns the note's content", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, "hello from disk");
    const a = fsContext(root);
    await run("read", { file: "note.md" }, a.context);
    assertEquals(a.captured[0].attrs.content, "hello from disk");
  });
});

Deno.test("read: fs failure path rejects for a missing file", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await assertRejects(() => run("read", { file: "missing.md" }, a.context));
  });
});

Deno.test("read: CLI backend passes the file param and trims stdout", async () => {
  const a = cliContext();
  const calls = await withCliStub(["  cli content  \n"], async () => {
    await run("read", { file: "note.md" }, a.context);
  });
  assertEquals(calls[0], ["read", "vault=testvault", "file=note.md"]);
  assertEquals(a.captured[0].attrs.content, "cli content");
});

Deno.test("fileInfo: fs happy path reports real stat fields for an existing file", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, "0123456789");
    const a = fsContext(root);
    await run("fileInfo", { file: "note.md" }, a.context);
    const attrs = a.captured[0].attrs;
    assertEquals(attrs.exists, true);
    assertEquals(attrs.name, "note.md");
    assertEquals(attrs.extension, "md");
    assertEquals(attrs.size, 10);
    assert(typeof attrs.modifiedAt === "string", "modifiedAt must be a string");
  });
});

Deno.test("fileInfo: CLI backend parses the TSV response", async () => {
  const a = cliContext();
  const calls = await withCliStub(
    ["path\tnote.md\nname\tnote.md\nextension\tmd\nsize\t42\ncreated\t0\nmodified\t0"],
    async () => {
      await run("fileInfo", { file: "note.md" }, a.context);
    },
  );
  assertEquals(calls[0], ["file", "vault=testvault", "file=note.md"]);
  const attrs = a.captured[0].attrs;
  assertEquals(attrs.exists, true);
  assertEquals(attrs.size, 42);
  assertEquals(attrs.extension, "md");
});

Deno.test("create: CLI backend passes template through without content or overwrite", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run("create", { name: "Daily Note", template: "Daily" }, a.context);
  });
  assertEquals(calls[0], [
    "create",
    "vault=testvault",
    "name=Daily Note",
    "template=Daily",
  ]);
  assertEquals(a.captured[0].attrs.action, "created");
});

Deno.test("append: fs backend creates missing parent directories", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await run(
      "append",
      { file: "deep/nested/log.md", content: "hello" },
      a.context,
    );
    assertEquals(
      await Deno.readTextFile(`${root}/deep/nested/log.md`),
      "hello",
    );
  });
});

Deno.test("prepend: CLI backend folds the separator and sends the inline flag", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run("prepend", { file: "log.md", content: "new" }, a.context);
  });
  assertEquals(calls[0], [
    "prepend",
    "vault=testvault",
    "file=log.md",
    "content=new\n",
    "inline",
  ]);
});

Deno.test("delete: CLI backend passes the permanent flag through", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run("delete", { file: "note.md", permanent: true }, a.context);
  });
  assertEquals(calls[0], [
    "delete",
    "vault=testvault",
    "file=note.md",
    "permanent",
  ]);
});

Deno.test("delete: CLI backend dryRun never invokes the Obsidian binary", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run("delete", { file: "note.md", dryRun: true }, a.context);
  });
  assertEquals(calls, []);
  assert(
    String(a.captured[0].attrs.message).includes("note.md"),
    "dry run message should name the file",
  );
});

Deno.test("move: CLI backend sends the path param (slash in the name) plus to", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run("move", { file: "notes/a.md", to: "archive/a.md" }, a.context);
  });
  assertEquals(calls[0], [
    "move",
    "vault=testvault",
    "path=notes/a.md",
    "to=archive/a.md",
  ]);
  assertEquals(a.captured[0].attrs.file, "notes/a.md -> archive/a.md");
});

Deno.test("list: CLI backend sends folder/ext params and filters recursive=false client-side", async () => {
  const a = cliContext();
  const calls = await withCliStub(
    ["notes/a.md\nnotes/b.md\nother/c.md\n"],
    async () => {
      await run(
        "list",
        { folder: "notes", ext: "md", recursive: false },
        a.context,
      );
    },
  );
  assertEquals(calls[0], [
    "files",
    "vault=testvault",
    "folder=notes",
    "ext=md",
  ]);
  assertEquals(a.captured[0].attrs.files, ["notes/a.md", "notes/b.md"]);
  assertEquals(a.captured[0].attrs.count, 2);
});

Deno.test("search: CLI backend (non-regex) sends query and parses the JSON response", async () => {
  const a = cliContext();
  const calls = await withCliStub(
    [JSON.stringify([{
      file: "a.md",
      matches: [{ line: 1, text: "needle here" }],
    }])],
    async () => {
      await run("search", { query: "needle" }, a.context);
    },
  );
  assertEquals(calls[0], [
    "search:context",
    "vault=testvault",
    "query=needle",
    "format=json",
  ]);
  const results = a.captured[0].attrs.results as { file: string }[];
  assertEquals(results.map((r) => r.file), ["a.md"]);
});

Deno.test("digest: fs backend on an empty vault reports a zero-file corpus", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await run("digest", {}, a.context);
    const attrs = a.captured[0].attrs;
    assertEquals(attrs.fileCount, 0);
    assertEquals(attrs.files, []);
    assertEquals(attrs.signalRollups, []);
    assertEquals(
      attrs.dateRange,
      { earliest: null, latest: null },
    );
  });
});

// ---------------------------------------------------------------------------
// Tags & links (CLI-only)
// ---------------------------------------------------------------------------

Deno.test("tags: CLI backend requests JSON and appends the counts flag", async () => {
  const a = cliContext();
  const calls = await withCliStub(['["#alpha","#beta"]'], async () => {
    await run("tags", { counts: true }, a.context);
  });
  assertEquals(calls[0], ["tags", "vault=testvault", "format=json", "counts"]);
  const tags = a.captured[0].attrs.tags as { tag: string }[];
  assertEquals(tags.map((t) => t.tag), ["#alpha", "#beta"]);
});

Deno.test("tag: CLI backend normalizes a bare name to a leading #", async () => {
  const a = cliContext();
  const calls = await withCliStub(["a.md\nb.md\n"], async () => {
    await run("tag", { name: "swamp" }, a.context);
  });
  assertEquals(calls[0], ["tag", "vault=testvault", "name=#swamp"]);
  assertEquals(a.captured[0].attrs.files, ["a.md", "b.md"]);
  assertEquals(a.captured[0].attrs.tag, "#swamp");
});

Deno.test("links: CLI backend sends the file param and parses plain-text lines", async () => {
  const a = cliContext();
  const calls = await withCliStub(["target-a.md\ntarget-b.md\n"], async () => {
    await run("links", { file: "note.md" }, a.context);
  });
  assertEquals(calls[0], ["links", "vault=testvault", "file=note.md"]);
  assertEquals(a.captured[0].attrs.links, ["target-a.md", "target-b.md"]);
  assertEquals(a.captured[0].attrs.direction, "outgoing");
});

Deno.test("backlinks: CLI backend reads the JSON array shape when the server returns one", async () => {
  const a = cliContext();
  const calls = await withCliStub(
    [JSON.stringify([{ file: "src-a.md" }, { path: "src-b.md" }])],
    async () => {
      await run("backlinks", { file: "note.md" }, a.context);
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0], [
    "backlinks",
    "vault=testvault",
    "file=note.md",
    "format=json",
  ]);
  assertEquals(a.captured[0].attrs.links, ["src-a.md", "src-b.md"]);
  assertEquals(a.captured[0].attrs.direction, "incoming");
});

Deno.test("backlinks: CLI backend falls back to a second plain-text call when JSON parsing fails", async () => {
  const a = cliContext();
  const calls = await withCliStub(
    ["not json at all", "src-a.md\nsrc-b.md\n"],
    async () => {
      await run("backlinks", { file: "note.md" }, a.context);
    },
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0], [
    "backlinks",
    "vault=testvault",
    "file=note.md",
    "format=json",
  ]);
  assertEquals(calls[1], ["backlinks", "vault=testvault", "file=note.md"]);
  assertEquals(a.captured[0].attrs.links, ["src-a.md", "src-b.md"]);
});

Deno.test("orphans: CLI backend takes no params and parses plain-text lines", async () => {
  const a = cliContext();
  const calls = await withCliStub(["lonely.md\n"], async () => {
    await run("orphans", {}, a.context);
  });
  assertEquals(calls[0], ["orphans", "vault=testvault"]);
  assertEquals(a.captured[0].attrs.files, ["lonely.md"]);
});

Deno.test("unresolved: CLI backend requests JSON and appends the verbose flag", async () => {
  const a = cliContext();
  const calls = await withCliStub(
    [JSON.stringify([{ link: "missing-note", count: 2 }])],
    async () => {
      await run("unresolved", { verbose: true }, a.context);
    },
  );
  assertEquals(calls[0], [
    "unresolved",
    "vault=testvault",
    "format=json",
    "verbose",
  ]);
  const links = a.captured[0].attrs.links as { link: string; count?: number }[];
  assertEquals(links, [{ link: "missing-note", count: 2 }]);
});

// ---------------------------------------------------------------------------
// Daily notes (CLI-only)
// ---------------------------------------------------------------------------

Deno.test("daily: CLI backend takes no params", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run("daily", {}, a.context);
  });
  assertEquals(calls[0], ["daily", "vault=testvault"]);
  assertEquals(a.captured[0].attrs.success, true);
});

Deno.test("dailyRead: CLI backend makes two calls — content then path", async () => {
  const a = cliContext();
  const calls = await withCliStub(
    ["today's content", "Daily/2026-08-01.md"],
    async () => {
      await run("dailyRead", {}, a.context);
    },
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0], ["daily:read", "vault=testvault"]);
  assertEquals(calls[1], ["daily:path", "vault=testvault"]);
  assertEquals(a.captured[0].attrs.content, "today's content");
  assertEquals(a.captured[0].attrs.path, "Daily/2026-08-01.md");
});

Deno.test("dailyAppend: CLI backend folds the separator into content and sends inline", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run(
      "dailyAppend",
      { content: "entry", separator: "\n\n" },
      a.context,
    );
  });
  assertEquals(calls[0], [
    "daily:append",
    "vault=testvault",
    "content=\n\nentry",
    "inline",
  ]);
});

Deno.test("dailyPrepend: CLI backend places content ahead of the separator", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run(
      "dailyPrepend",
      { content: "entry", separator: "\n\n" },
      a.context,
    );
  });
  assertEquals(calls[0], [
    "daily:prepend",
    "vault=testvault",
    "content=entry\n\n",
    "inline",
  ]);
});

// ---------------------------------------------------------------------------
// Properties (frontmatter)
// ---------------------------------------------------------------------------

Deno.test("properties: fs happy path reads the note's real frontmatter", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, fixture("block-list.md"));
    const a = fsContext(root);
    await run("properties", { file: "note.md" }, a.context);
    const props = a.captured[0].attrs.properties as Record<string, unknown>;
    assertEquals(props.title, "@handle posts 2014");
    assertEquals(props.tags, ["social", "social-posts"]);
  });
});

Deno.test("properties: fs failure path rejects for a missing file", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await assertRejects(() =>
      run("properties", { file: "missing.md" }, a.context)
    );
  });
});

Deno.test("properties: CLI backend parses the JSON response", async () => {
  const a = cliContext();
  const calls = await withCliStub(
    [JSON.stringify({ title: "T", tags: ["x"] })],
    async () => {
      await run("properties", { file: "note.md" }, a.context);
    },
  );
  assertEquals(calls[0], [
    "properties",
    "vault=testvault",
    "file=note.md",
    "format=json",
  ]);
  assertEquals(a.captured[0].attrs.properties, { title: "T", tags: ["x"] });
});

Deno.test("propertySet: CLI backend passes the type hint through", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run(
      "propertySet",
      { file: "note.md", name: "tags", value: '["x","y"]', type: "list" },
      a.context,
    );
  });
  assertEquals(calls[0], [
    "property:set",
    "vault=testvault",
    "file=note.md",
    "name=tags",
    'value=["x","y"]',
    "type=list",
  ]);
});

Deno.test("setProperties: CLI backend fans out one property:set call per key", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok", "ok", "ok"], async () => {
    await run(
      "setProperties",
      {
        file: "note.md",
        properties: { status: "active", count: 3, tags: ["a", "b"] },
      },
      a.context,
    );
  });
  assertEquals(calls.length, 3);
  assertEquals(calls[0], [
    "property:set",
    "vault=testvault",
    "file=note.md",
    "name=status",
    "value=active",
  ]);
  assertEquals(calls[1], [
    "property:set",
    "vault=testvault",
    "file=note.md",
    "name=count",
    "value=3",
    "type=number",
  ]);
  assertEquals(calls[2], [
    "property:set",
    "vault=testvault",
    "file=note.md",
    "name=tags",
    'value=["a","b"]',
    "type=list",
  ]);
});

Deno.test("propertyRemove: fs happy path drops the named property and keeps the rest", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(
      `${root}/note.md`,
      "---\ntitle: Keep me\ntemp: remove-me\n---\n\nBody.\n",
    );
    const a = fsContext(root);
    await run("propertyRemove", { file: "note.md", name: "temp" }, a.context);
    const props = readProperties(await Deno.readTextFile(`${root}/note.md`));
    assertEquals(props.title, "Keep me");
    assertEquals("temp" in props, false);
  });
});

Deno.test("propertyRemove: fs no-op removal of an absent key leaves the file untouched", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(
      `${root}/note.md`,
      "---\ntitle: Keep me\n---\n\nBody.\n",
    );
    const before = await Deno.stat(`${root}/note.md`);
    const a = fsContext(root);
    await run(
      "propertyRemove",
      { file: "note.md", name: "never-existed" },
      a.context,
    );
    const after = await Deno.stat(`${root}/note.md`);
    assertEquals(before.mtime?.getTime(), after.mtime?.getTime());
  });
});

Deno.test("propertyRemove: fs failure path rejects for a missing file", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await assertRejects(() =>
      run("propertyRemove", { file: "missing.md", name: "x" }, a.context)
    );
  });
});

Deno.test("propertyRemove: CLI backend sends the file and name params", async () => {
  const a = cliContext();
  const calls = await withCliStub(["ok"], async () => {
    await run("propertyRemove", { file: "note.md", name: "temp" }, a.context);
  });
  assertEquals(calls[0], [
    "property:remove",
    "vault=testvault",
    "file=note.md",
    "name=temp",
  ]);
});

// ---------------------------------------------------------------------------
// Method-coverage checklist
// ---------------------------------------------------------------------------

Deno.test("method-coverage: every method in model.methods was exercised by this suite", () => {
  const all = Object.keys(model.methods).sort();
  const missing = all.filter((m) => !EXERCISED.has(m));
  assertEquals(missing, [], `methods never exercised: ${missing.join(", ")}`);
  assertEquals(all.length, 24, "expected exactly 24 methods on the model");
});
