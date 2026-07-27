// Unit and filesystem tests for the @magistr/obsidian-vault model.
// Run: deno task test
//
// The fixtures under fixtures/ reproduce the SHAPE of real vault notes —
// block-style YAML lists, a title beginning with '@', frontmatter comments, a
// horizontal rule in the body — with synthetic content. They exist because a
// scalar-only frontmatter parser silently destroys block lists, which is the
// single most common frontmatter shape Obsidian produces.

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  buildObsidianArgs,
  buildSearchMatcher,
  classifyWrite,
  CLI_ONLY_METHODS,
  coerceProperty,
  extractHeadings,
  extractInlineTags,
  extractPrRefs,
  extractTicketRefs,
  extractWikilinks,
  inferDate,
  isHiddenSegment,
  mergeProperties,
  model,
  propertyTypeHint,
  readProperties,
  resolveVaultPath,
  resolveVaultPathSafe,
  resolveVaultRootFromRegistry,
  selectBackend,
  splitFrontmatter,
} from "./obsidian_vault.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

function fixture(name: string): string {
  return Deno.readTextFileSync(`${FIXTURES}${name}`);
}

const cfg = (over: Record<string, unknown> = {}) => ({
  vault: "testvault",
  vaultRoot: "/vault",
  backend: "auto",
  blockDotObsidian: true,
  ...over,
});

// --- Path confinement (the security boundary) ---------------------------

Deno.test("resolveVaultPath rejects a relative parent escape", () => {
  assertThrows(
    () => resolveVaultPath(cfg(), "../escape.md"),
    Error,
    "escapes vault root",
  );
});

Deno.test("resolveVaultPath rejects a mid-path parent escape", () => {
  assertThrows(
    () => resolveVaultPath(cfg(), "a/../../escape.md"),
    Error,
    "escapes vault root",
  );
});

Deno.test("resolveVaultPath rejects an absolute path outside the root", () => {
  assertThrows(
    () => resolveVaultPath(cfg(), "/etc/passwd"),
    Error,
    "outside vault root",
  );
});

Deno.test("resolveVaultPath accepts an in-root absolute path and normalizes it to the relative form", () => {
  const abs = resolveVaultPath(cfg(), "/vault/notes/a.md");
  const rel = resolveVaultPath(cfg(), "notes/a.md");
  assertEquals(abs.vaultRelativePath, "notes/a.md");
  assertEquals(abs.absolutePath, rel.absolutePath);
  assertEquals(abs.vaultRelativePath, rel.vaultRelativePath);
});

Deno.test("resolveVaultPath treats empty and dot as the vault root", () => {
  assertEquals(resolveVaultPath(cfg(), "").vaultRelativePath, "");
  assertEquals(resolveVaultPath(cfg(), ".").vaultRelativePath, "");
  assertEquals(resolveVaultPath(cfg(), ".").absolutePath, "/vault");
});

Deno.test("resolveVaultPath normalizes a trailing slash on vaultRoot", () => {
  const p = resolveVaultPath(cfg({ vaultRoot: "/vault/" }), "notes/a.md");
  assertEquals(p.absolutePath, "/vault/notes/a.md");
});

Deno.test("resolveVaultPath blocks .obsidian at the root", () => {
  assertThrows(
    () => resolveVaultPath(cfg(), ".obsidian/app.json"),
    Error,
    ".obsidian",
  );
});

Deno.test("resolveVaultPath blocks .obsidian at depth", () => {
  assertThrows(
    () => resolveVaultPath(cfg(), "nested/.obsidian/plugins/x.json"),
    Error,
    ".obsidian",
  );
});

Deno.test("resolveVaultPath allows .obsidian with an explicit opt-in", () => {
  const p = resolveVaultPath(cfg(), ".obsidian/app.json", {
    allowDotObsidian: true,
  });
  assertEquals(p.vaultRelativePath, ".obsidian/app.json");
});

Deno.test("resolveVaultPathSafe rejects a symlink that escapes the vault", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${outside}/secret.txt`, "private");
    await Deno.symlink(`${outside}/secret.txt`, `${root}/escape.md`);
    await assertRejects(
      () => resolveVaultPathSafe(cfg({ vaultRoot: root }), "escape.md"),
      Error,
      "symlink",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("resolveVaultPathSafe rejects a path traversing a symlinked directory", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${outside}/inner`);
    await Deno.writeTextFile(`${outside}/inner/note.md`, "private");
    await Deno.symlink(`${outside}/inner`, `${root}/linked`);
    await assertRejects(
      () => resolveVaultPathSafe(cfg({ vaultRoot: root }), "linked/note.md"),
      Error,
      "symlink",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("resolveVaultPathSafe accepts a regular in-vault file", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/note.md`, "hello");
    const p = await resolveVaultPathSafe(cfg({ vaultRoot: root }), "note.md");
    assertEquals(p.vaultRelativePath, "note.md");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveVaultPathSafe accepts a not-yet-existing file whose parents are real", async () => {
  const root = await Deno.makeTempDir();
  try {
    const p = await resolveVaultPathSafe(
      cfg({ vaultRoot: root }),
      "new/note.md",
    );
    assertEquals(p.vaultRelativePath, "new/note.md");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- Backend selection ---------------------------------------------------

Deno.test("selectBackend resolves auto to fs when vaultRoot is set", () => {
  assertEquals(selectBackend(cfg(), "read"), "fs");
});

Deno.test("selectBackend resolves auto to cli without vaultRoot", () => {
  assertEquals(selectBackend(cfg({ vaultRoot: undefined }), "read"), "cli");
});

Deno.test("selectBackend honours an explicit cli choice even with vaultRoot", () => {
  assertEquals(selectBackend(cfg({ backend: "cli" }), "read"), "cli");
});

Deno.test("selectBackend routes CLI-only methods to cli under auto", () => {
  for (const method of CLI_ONLY_METHODS) {
    assertEquals(selectBackend(cfg(), method), "cli");
  }
});

Deno.test("selectBackend errors for a CLI-only method under an explicit fs backend", () => {
  assertThrows(
    () => selectBackend(cfg({ backend: "fs" }), "backlinks"),
    Error,
    "backlinks",
  );
});

Deno.test("selectBackend error names the headless alternative where one exists", () => {
  assertThrows(
    () => selectBackend(cfg({ backend: "fs" }), "tags"),
    Error,
    "digest",
  );
});

Deno.test("CLI_ONLY_METHODS covers exactly the index-dependent methods", () => {
  assertEquals(
    [...CLI_ONLY_METHODS].sort(),
    [
      "backlinks",
      "daily",
      "dailyAppend",
      "dailyPrepend",
      "dailyRead",
      "links",
      "move",
      "orphans",
      "tag",
      "tags",
      "unresolved",
    ],
  );
});

// --- Frontmatter (the v1 regression) -------------------------------------

const ROUND_TRIP_FIXTURES = [
  "block-list.md",
  "flow-list.md",
  "no-frontmatter.md",
  "hr-in-body.md",
  "commented.md",
  "links-and-tags.md",
];

Deno.test("frontmatter round trip is byte-identical for every fixture", () => {
  for (const name of ROUND_TRIP_FIXTURES) {
    const original = fixture(name);
    assertEquals(
      mergeProperties(original, {}),
      original,
      `round trip changed ${name}`,
    );
  }
});

Deno.test("a block-style tags list survives an unrelated property update", () => {
  const next = mergeProperties(fixture("block-list.md"), { status: "active" });
  const props = readProperties(next);
  assertEquals(props.tags, ["social", "social-posts"]);
  assertEquals(props.status, "active");
  assert(next.includes("  - social\n"), "block list style was not preserved");
});

Deno.test("an inline flow list survives an unrelated property update", () => {
  const next = mergeProperties(fixture("flow-list.md"), { status: "active" });
  const props = readProperties(next);
  assertEquals(props.tags, ["alpha", "beta"]);
  assertEquals(props.aliases, ["first-alias", "second-alias"]);
});

Deno.test("existing key order is preserved and new keys append", () => {
  const next = mergeProperties(fixture("block-list.md"), { zzz: "last" });
  const keys = Object.keys(readProperties(next));
  assertEquals(keys[0], "title");
  assertEquals(keys[1], "year");
  assertEquals(keys[keys.length - 1], "zzz");
});

Deno.test("a title beginning with @ stays quoted through a round trip", () => {
  const next = mergeProperties(fixture("block-list.md"), { status: "active" });
  assert(
    next.includes('title: "@handle posts 2014"'),
    `reserved leading @ lost its quoting: ${next.split("\n")[1]}`,
  );
  assertEquals(readProperties(next).title, "@handle posts 2014");
});

Deno.test("values needing quotes are quoted on write", () => {
  const cases: Record<string, string> = {
    at: "@leading",
    backtick: "`leading",
    question: "? leading",
    colonSpace: "key: value",
    hashComment: "text # not a comment",
    trailingSpace: "padded ",
    multiline: "line one\nline two",
    ampersand: "&anchor",
    asterisk: "*alias",
    bang: "!tag",
    pipe: "|block",
    gt: ">folded",
    percent: "%directive",
  };
  const next = mergeProperties(fixture("no-frontmatter.md"), cases);
  const parsed = readProperties(next);
  for (const [key, value] of Object.entries(cases)) {
    assertEquals(parsed[key], value, `value for ${key} did not survive`);
  }
});

Deno.test("a note without frontmatter gains a well-formed block", () => {
  const next = mergeProperties(fixture("no-frontmatter.md"), {
    title: "Added",
  });
  assert(next.startsWith("---\n"), "frontmatter block was not prepended");
  assertEquals(readProperties(next).title, "Added");
  assert(
    next.includes("# Plain note"),
    "original body was lost when adding frontmatter",
  );
});

Deno.test("a horizontal rule in the body is not the frontmatter terminator", () => {
  const props = readProperties(fixture("hr-in-body.md"));
  assertEquals(props.title, "Note with a horizontal rule");
  assertEquals(props.status, "draft");
  const { body } = splitFrontmatter(fixture("hr-in-body.md"));
  assert(
    body.includes("Text after a horizontal rule"),
    "body was truncated at the horizontal rule",
  );
});

Deno.test("frontmatter comments survive a round trip", () => {
  const next = mergeProperties(fixture("commented.md"), { status: "active" });
  assert(
    next.includes("# which pipeline produced this note"),
    "leading frontmatter comment was dropped",
  );
  assert(
    next.includes("# provenance marker"),
    "inline frontmatter comment was dropped",
  );
});

Deno.test("readProperties returns an empty map for a note without frontmatter", () => {
  assertEquals(readProperties(fixture("no-frontmatter.md")), {});
});

// --- Write classification ------------------------------------------------

Deno.test("classifyWrite reports created when the file is absent", () => {
  assertEquals(classifyWrite(null, "body"), "created");
});

Deno.test("classifyWrite reports unchanged for identical content", () => {
  assertEquals(classifyWrite("body", "body"), "unchanged");
});

Deno.test("classifyWrite reports updated for different content", () => {
  assertEquals(classifyWrite("body", "other"), "updated");
});

// --- Search matcher ------------------------------------------------------

Deno.test("buildSearchMatcher does case-insensitive substring matching by default", () => {
  const m = buildSearchMatcher("Needle", false, false);
  assert(m("a needle here"));
  assert(!m("nothing"));
});

Deno.test("buildSearchMatcher honours caseSensitive for substrings", () => {
  const m = buildSearchMatcher("Needle", false, true);
  assert(m("a Needle here"));
  assert(!m("a needle here"));
});

Deno.test("buildSearchMatcher honours regex mode", () => {
  const m = buildSearchMatcher("^he[a-z]+o$", true, false);
  assert(m("HELLO"));
  assert(!m("say hello now"));
});

Deno.test("buildSearchMatcher honours regex plus caseSensitive", () => {
  const m = buildSearchMatcher("^He", true, true);
  assert(m("Hello"));
  assert(!m("hello"));
});

Deno.test("buildSearchMatcher treats a substring query literally", () => {
  const m = buildSearchMatcher("a.c", false, false);
  assert(m("xxa.cxx"));
  assert(!m("xxabcxx"));
});

Deno.test("buildSearchMatcher reports an invalid regex with the pattern echoed", () => {
  assertThrows(
    () => buildSearchMatcher("([unclosed", true, false),
    Error,
    "([unclosed",
  );
});

Deno.test("buildSearchMatcher rejects an over-long pattern", () => {
  assertThrows(
    () => buildSearchMatcher("a".repeat(2000), true, false),
    Error,
    "too long",
  );
});

Deno.test("buildSearchMatcher rejects nested unbounded quantifiers", () => {
  assertThrows(
    () => buildSearchMatcher("(a+)+$", true, false),
    Error,
    "quantifier",
  );
});

// --- Hidden segments -----------------------------------------------------

Deno.test("isHiddenSegment identifies dot directories", () => {
  assert(isHiddenSegment(".obsidian"));
  assert(isHiddenSegment(".trash"));
  assert(isHiddenSegment(".git"));
  assert(!isHiddenSegment("notes"));
  assert(!isHiddenSegment("note.md"));
});

// --- Digest extractors ---------------------------------------------------

Deno.test("extractHeadings takes levels one through four only", () => {
  const headings = extractHeadings(fixture("links-and-tags.md"));
  assertEquals(headings, [
    "Heading one",
    "Heading two",
    "Heading three",
    "Heading four",
  ]);
});

Deno.test("extractWikilinks handles plain, aliased, and heading-anchored forms", () => {
  assertEquals(extractWikilinks(fixture("links-and-tags.md")), [
    "target-note",
    "other-note",
    "third-note",
  ]);
});

Deno.test("extractInlineTags ignores code spans and URL fragments", () => {
  const tags = extractInlineTags(fixture("links-and-tags.md"));
  assertEquals(tags, ["inline-tag", "nested/tag"]);
});

Deno.test("extractPrRefs finds hash and PR-prefixed forms", () => {
  assertEquals(extractPrRefs(fixture("links-and-tags.md")), ["#1234", "#5678"]);
});

Deno.test("extractTicketRefs finds uppercase ticket identifiers", () => {
  assertEquals(extractTicketRefs(fixture("links-and-tags.md")), [
    "ABC-42",
    "LONGER-1",
  ]);
});

Deno.test("inferDate reads several filename date shapes", () => {
  assertEquals(inferDate("2026-07-27-standup.md"), "2026-07-27");
  assertEquals(inferDate("20260727.md"), "2026-07-27");
  assertEquals(inferDate("notes 2026.07.27.md"), "2026-07-27");
  assertEquals(inferDate("retro.md"), null);
});

// --- Model shape ---------------------------------------------------------

Deno.test("model declares the new methods alongside the existing ones", () => {
  const methods = Object.keys(model.methods);
  for (const expected of ["setProperties", "digest"]) {
    assert(methods.includes(expected), `missing method ${expected}`);
  }
  assertEquals(methods.length, 24);
});

Deno.test("model version matches the last upgrade toVersion", () => {
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
});

Deno.test("digest retains no note bodies by default", () => {
  const shape = model.methods.digest.arguments.parse({});
  assertEquals(shape.maxBodyChars, 0);
});

// --- Filesystem backend (end to end) -------------------------------------

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
      logger: { info: () => {} },
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

async function withVault(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("create reports created then unchanged and does not rewrite an unchanged note", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await model.methods.create.execute(
      { name: "notes/idea.md", content: "# Idea" },
      a.context,
    );
    assertEquals(a.captured[0].attrs.action, "created");

    const stat1 = await Deno.stat(`${root}/notes/idea.md`);
    const b = fsContext(root);
    await model.methods.create.execute(
      { name: "notes/idea.md", content: "# Idea", overwrite: true },
      b.context,
    );
    assertEquals(b.captured[0].attrs.action, "unchanged");
    const stat2 = await Deno.stat(`${root}/notes/idea.md`);
    assertEquals(
      stat1.mtime?.getTime(),
      stat2.mtime?.getTime(),
      "unchanged write must not touch mtime",
    );

    const c = fsContext(root);
    await model.methods.create.execute(
      { name: "notes/idea.md", content: "# Different", overwrite: true },
      c.context,
    );
    assertEquals(c.captured[0].attrs.action, "updated");
  });
});

Deno.test("create refuses to overwrite without the flag and leaves the file intact", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, "original");
    const a = fsContext(root);
    await assertRejects(
      () =>
        model.methods.create.execute(
          { name: "note.md", content: "replacement" },
          a.context,
        ),
      Error,
      "overwrite=true",
    );
    assertEquals(await Deno.readTextFile(`${root}/note.md`), "original");
  });
});

Deno.test("create rejects a template on the filesystem backend", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await assertRejects(
      () =>
        model.methods.create.execute(
          { name: "note.md", template: "Daily" },
          a.context,
        ),
      Error,
      "template",
    );
  });
});

Deno.test("append honours a custom separator and creates a missing note", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await model.methods.append.execute(
      { file: "log.md", content: "first" },
      a.context,
    );
    assertEquals(await Deno.readTextFile(`${root}/log.md`), "first");

    const b = fsContext(root);
    await model.methods.append.execute(
      { file: "log.md", content: "second", separator: "\n\n---\n\n" },
      b.context,
    );
    assertEquals(
      await Deno.readTextFile(`${root}/log.md`),
      "first\n\n---\n\nsecond",
    );
  });
});

Deno.test("delete moves a note to .trash and permanent unlinks it", async () => {
  await withVault(async (root) => {
    await Deno.mkdir(`${root}/notes`);
    await Deno.writeTextFile(`${root}/notes/gone.md`, "recoverable");
    const a = fsContext(root);
    await model.methods.delete.execute({ file: "notes/gone.md" }, a.context);
    assertEquals(
      await Deno.readTextFile(`${root}/.trash/notes/gone.md`),
      "recoverable",
      "trashed note should still be recoverable",
    );

    await Deno.writeTextFile(`${root}/notes/zap.md`, "bye");
    const b = fsContext(root);
    await model.methods.delete.execute(
      { file: "notes/zap.md", permanent: true },
      b.context,
    );
    await assertRejects(() => Deno.stat(`${root}/notes/zap.md`));
  });
});

Deno.test("delete dryRun removes nothing and names the resolved path", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/keep.md`, "still here");
    const a = fsContext(root);
    await model.methods.delete.execute(
      { file: "keep.md", dryRun: true },
      a.context,
    );
    assertEquals(await Deno.readTextFile(`${root}/keep.md`), "still here");
    assert(
      String(a.captured[0].attrs.message).includes("keep.md"),
      "dry run should name the resolved path",
    );
  });
});

Deno.test("a trashed note does not come back in search, list, or digest", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/secret.md`, "findme marker");
    await Deno.writeTextFile(`${root}/kept.md`, "findme marker");
    const del = fsContext(root);
    await model.methods.delete.execute({ file: "secret.md" }, del.context);

    const s = fsContext(root);
    await model.methods.search.execute({ query: "findme" }, s.context);
    const results = s.captured[0].attrs.results as { file: string }[];
    assertEquals(results.map((r) => r.file), ["kept.md"]);

    const l = fsContext(root);
    await model.methods.list.execute({}, l.context);
    assertEquals(l.captured[0].attrs.files, ["kept.md"]);

    const d = fsContext(root);
    await model.methods.digest.execute(
      { maxFiles: 2000, maxBodyChars: 0 },
      d.context,
    );
    assertEquals(d.captured[0].attrs.fileCount, 1);
  });
});

Deno.test("list honours recursive and limit and reports truncation", async () => {
  await withVault(async (root) => {
    await Deno.mkdir(`${root}/sub`);
    await Deno.writeTextFile(`${root}/a.md`, "a");
    await Deno.writeTextFile(`${root}/b.md`, "b");
    await Deno.writeTextFile(`${root}/sub/c.md`, "c");

    const flat = fsContext(root);
    await model.methods.list.execute({ recursive: false }, flat.context);
    assertEquals((flat.captured[0].attrs.files as string[]).sort(), [
      "a.md",
      "b.md",
    ]);

    const deep = fsContext(root);
    await model.methods.list.execute({ recursive: true }, deep.context);
    assertEquals((deep.captured[0].attrs.files as string[]).length, 3);

    const capped = fsContext(root);
    await model.methods.list.execute({ limit: 2 }, capped.context);
    assertEquals(capped.captured[0].attrs.count, 2);
    assertEquals(capped.captured[0].attrs.truncated, true);
  });
});

Deno.test("search reports truncation when the limit is hit", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/many.md`, "hit\nhit\nhit\nhit\n");
    const s = fsContext(root);
    await model.methods.search.execute({ query: "hit", limit: 2 }, s.context);
    assertEquals(s.captured[0].attrs.truncated, true);
  });
});

Deno.test("setProperties merges without dropping the existing block list", async () => {
  await withVault(async (root) => {
    const original = fixture("block-list.md");
    await Deno.writeTextFile(`${root}/note.md`, original);
    const a = fsContext(root);
    await model.methods.setProperties.execute(
      { file: "note.md", properties: { status: "active", reviewed: true } },
      a.context,
    );
    const next = await Deno.readTextFile(`${root}/note.md`);
    const props = readProperties(next);
    assertEquals(props.tags, ["social", "social-posts"]);
    assertEquals(props.title, "@handle posts 2014");
    assertEquals(props.status, "active");
    assertEquals(props.reviewed, true);
    assert(next.includes("Body text that must survive"), "body was lost");
  });
});

Deno.test("setProperties is idempotent — a repeat merge leaves the file untouched", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, fixture("block-list.md"));
    const a = fsContext(root);
    await model.methods.setProperties.execute(
      { file: "note.md", properties: { status: "active" } },
      a.context,
    );
    const first = await Deno.readTextFile(`${root}/note.md`);
    const stat1 = await Deno.stat(`${root}/note.md`);

    const b = fsContext(root);
    await model.methods.setProperties.execute(
      { file: "note.md", properties: { status: "active" } },
      b.context,
    );
    assertEquals(await Deno.readTextFile(`${root}/note.md`), first);
    const stat2 = await Deno.stat(`${root}/note.md`);
    assertEquals(stat1.mtime?.getTime(), stat2.mtime?.getTime());
  });
});

Deno.test("propertySet with a list type writes a real YAML sequence", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, "---\ntitle: T\n---\n\nbody\n");
    const a = fsContext(root);
    await model.methods.propertySet.execute(
      { file: "note.md", name: "tags", value: '["x","y"]', type: "list" },
      a.context,
    );
    assertEquals(
      readProperties(await Deno.readTextFile(`${root}/note.md`)).tags,
      ["x", "y"],
    );
  });
});

Deno.test("fileInfo reports exists=false instead of failing", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await model.methods.fileInfo.execute({ file: "missing.md" }, a.context);
    assertEquals(a.captured[0].attrs.exists, false);
    assertEquals(a.captured[0].attrs.path, "missing.md");
  });
});

Deno.test("digest extracts structure and retains no body by default", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(
      `${root}/2026-07-27-standup.md`,
      fixture("links-and-tags.md"),
    );
    const a = fsContext(root);
    await model.methods.digest.execute(
      { signalKeywords: ["prose"], maxFiles: 2000, maxBodyChars: 0 },
      a.context,
    );
    const corpus = a.captured[0].attrs;
    assertEquals(corpus.fileCount, 1);
    const entry = (corpus.files as Record<string, unknown>[])[0];
    assertEquals(entry.inferredDate, "2026-07-27");
    assertEquals(entry.wikilinks, ["target-note", "other-note", "third-note"]);
    assertEquals(entry.body, undefined, "body must not be retained by default");
    assertEquals(
      (corpus.signalRollups as { keyword: string; count: number }[])[0].count,
      1,
    );
  });
});

Deno.test("digest retains bodies only when explicitly asked", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/n.md`, "private content here");
    const a = fsContext(root);
    await model.methods.digest.execute(
      { maxFiles: 10, maxBodyChars: 100 },
      a.context,
    );
    const entry = (a.captured[0].attrs.files as Record<string, unknown>[])[0];
    assertEquals(entry.body, "private content here");
  });
});

Deno.test("filesystem methods refuse to follow a symlink out of the vault", async () => {
  await withVault(async (root) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${outside}/secret.txt`, "private");
      await Deno.symlink(`${outside}/secret.txt`, `${root}/escape.md`);
      const a = fsContext(root);
      await assertRejects(
        () => model.methods.read.execute({ file: "escape.md" }, a.context),
        Error,
        "symlink",
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("the registry fallback fails with an actionable message when the vault has moved", async () => {
  await withVault(async (root) => {
    const home = await Deno.makeTempDir();
    const prevHome = Deno.env.get("HOME");
    try {
      const cfgDir = Deno.build.os === "darwin"
        ? `${home}/Library/Application Support/obsidian`
        : `${home}/.config/obsidian`;
      await Deno.mkdir(cfgDir, { recursive: true });
      await Deno.writeTextFile(
        `${cfgDir}/obsidian.json`,
        JSON.stringify({
          vaults: { abc: { path: `${root}/moved-away`, open: true } },
        }),
      );
      Deno.env.set("HOME", home);
      await assertRejects(
        () => resolveVaultRootFromRegistry("moved-away"),
        Error,
        "does not exist",
      );
    } finally {
      if (prevHome) Deno.env.set("HOME", prevHome);
      await Deno.remove(home, { recursive: true });
    }
  });
});

// --- CLI backend contract ------------------------------------------------
//
// The CLI adapter cannot run in CI (it needs the Obsidian desktop app), so its
// contract is pinned at the argv boundary instead. These assertions are what
// stands between a silent CLI-side regression and a user finding it.

Deno.test("buildObsidianArgs puts the command first and the vault immediately after", () => {
  assertEquals(
    buildObsidianArgs("read", { file: "note.md" }, "myvault"),
    ["read", "vault=myvault", "file=note.md"],
  );
});

Deno.test("buildObsidianArgs renders params as key=value and appends bare flags last", () => {
  assertEquals(
    buildObsidianArgs("tags", { format: "json" }, "myvault", ["counts"]),
    ["tags", "vault=myvault", "format=json", "counts"],
  );
});

Deno.test("buildObsidianArgs fails with an actionable message when vault is unset", () => {
  assertThrows(
    () => buildObsidianArgs("read", {}, undefined),
    Error,
    "vault global argument",
  );
});

Deno.test("append folds the separator into the content and sends the inline flag", async () => {
  const calls: string[][] = [];
  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    constructor(_cmd: string, opts: { args: string[] }) {
      calls.push(opts.args);
    }
    output() {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }
  };
  try {
    const a = fsContext("/unused", { vaultRoot: undefined, backend: "cli" });
    await model.methods.append.execute(
      { file: "log.md", content: "entry", separator: "\n\n" },
      a.context,
    );
    assertEquals(calls[0], [
      "append",
      "vault=testvault",
      "file=log.md",
      "content=\n\nentry",
      "inline",
    ]);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
});

Deno.test("search rejects regex on the CLI backend and points at vaultRoot", async () => {
  const a = fsContext("/unused", { vaultRoot: undefined, backend: "cli" });
  await assertRejects(
    () =>
      model.methods.search.execute(
        { query: "x", regex: true },
        a.context,
      ),
    Error,
    "vaultRoot",
  );
});

// --- Property coercion ---------------------------------------------------

Deno.test("coerceProperty parses a JSON array for the list type", () => {
  assertEquals(coerceProperty('["a","b"]', "list"), ["a", "b"]);
});

Deno.test("coerceProperty falls back to comma splitting for a malformed list", () => {
  assertEquals(coerceProperty("a, b ,c", "list"), ["a", "b", "c"]);
});

Deno.test("coerceProperty wraps a non-array JSON value for the list type", () => {
  assertEquals(coerceProperty('"solo"', "list"), ['"solo"']);
});

Deno.test("coerceProperty converts numbers and leaves unparseable ones alone", () => {
  assertEquals(coerceProperty("42", "number"), 42);
  assertEquals(coerceProperty("4.5", "number"), 4.5);
  assertEquals(coerceProperty("not-a-number", "number"), "not-a-number");
});

Deno.test("coerceProperty reads the checkbox truthy spellings", () => {
  assertEquals(coerceProperty("true", "checkbox"), true);
  assertEquals(coerceProperty("yes", "checkbox"), true);
  assertEquals(coerceProperty("1", "checkbox"), true);
  assertEquals(coerceProperty("false", "checkbox"), false);
});

Deno.test("coerceProperty passes text and untyped values through untouched", () => {
  assertEquals(coerceProperty("plain", "text"), "plain");
  assertEquals(coerceProperty("plain", undefined), "plain");
});

// --- prepend on the filesystem backend -----------------------------------

Deno.test("prepend inserts after the frontmatter and leaves it untouched", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, fixture("block-list.md"));
    const a = fsContext(root);
    await model.methods.prepend.execute(
      { file: "note.md", content: "INSERTED" },
      a.context,
    );
    const next = await Deno.readTextFile(`${root}/note.md`);
    const props = readProperties(next);
    assertEquals(props.tags, ["social", "social-posts"]);
    assertEquals(props.title, "@handle posts 2014");
    const { body } = splitFrontmatter(next);
    assert(
      body.startsWith("INSERTED"),
      `body began with: ${body.slice(0, 40)}`,
    );
    assert(next.includes("Body text that must survive"), "original body lost");
  });
});

Deno.test("prepend honours a custom separator", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, "existing");
    const a = fsContext(root);
    await model.methods.prepend.execute(
      { file: "note.md", content: "new", separator: " | " },
      a.context,
    );
    assertEquals(await Deno.readTextFile(`${root}/note.md`), "new | existing");
  });
});

Deno.test("prepend into a note without frontmatter adds no frontmatter", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, "body only");
    const a = fsContext(root);
    await model.methods.prepend.execute(
      { file: "note.md", content: "top" },
      a.context,
    );
    const next = await Deno.readTextFile(`${root}/note.md`);
    assert(!next.startsWith("---"), "frontmatter should not be invented");
    assertEquals(next, "top\nbody only");
  });
});

Deno.test("prepend into a missing note creates it with just the content", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await model.methods.prepend.execute(
      { file: "fresh.md", content: "only" },
      a.context,
    );
    assertEquals(await Deno.readTextFile(`${root}/fresh.md`), "only");
  });
});

// --- Guards and cleanup --------------------------------------------------

Deno.test("list honours the ext filter", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/a.md`, "a");
    await Deno.writeTextFile(`${root}/b.txt`, "b");
    const a = fsContext(root);
    await model.methods.list.execute({ ext: "md" }, a.context);
    assertEquals(a.captured[0].attrs.files, ["a.md"]);
  });
});

Deno.test("blockDotObsidian=false lets .obsidian through without a per-call opt-in", () => {
  const p = resolveVaultPath(
    cfg({ blockDotObsidian: false }),
    ".obsidian/app.json",
  );
  assertEquals(p.vaultRelativePath, ".obsidian/app.json");
});

Deno.test("a symlink pointing inside the vault is still refused", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/real.md`, "content");
    await Deno.symlink(`${root}/real.md`, `${root}/alias.md`);
    await assertRejects(
      () => resolveVaultPathSafe(cfg({ vaultRoot: root }), "alias.md"),
      Error,
      "symlink",
    );
  });
});

Deno.test("a successful write leaves no temp file behind", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await model.methods.create.execute(
      { name: "note.md", content: "body" },
      a.context,
    );
    const names: string[] = [];
    for await (const entry of Deno.readDir(root)) names.push(entry.name);
    assertEquals(names.filter((n) => n.includes(".tmp")), []);
    assertEquals(names, ["note.md"]);
  });
});

Deno.test("vaultRoot unset reports what to set", () => {
  assertThrows(
    () => resolveVaultPath(cfg({ vaultRoot: undefined }), "note.md"),
    Error,
    "vaultRoot is not set",
  );
});

Deno.test("an ambiguous vault name in the registry is reported, not guessed", async () => {
  await withVault(async (root) => {
    const home = await Deno.makeTempDir();
    const prevHome = Deno.env.get("HOME");
    try {
      const cfgDir = Deno.build.os === "darwin"
        ? `${home}/Library/Application Support/obsidian`
        : `${home}/.config/obsidian`;
      await Deno.mkdir(cfgDir, { recursive: true });
      await Deno.mkdir(`${root}/one/notes`, { recursive: true });
      await Deno.mkdir(`${root}/two/notes`, { recursive: true });
      await Deno.writeTextFile(
        `${cfgDir}/obsidian.json`,
        JSON.stringify({
          vaults: {
            a: { path: `${root}/one/notes` },
            b: { path: `${root}/two/notes` },
          },
        }),
      );
      Deno.env.set("HOME", home);
      await assertRejects(
        () => resolveVaultRootFromRegistry("notes"),
        Error,
        "ambiguous",
      );
    } finally {
      if (prevHome) Deno.env.set("HOME", prevHome);
      await Deno.remove(home, { recursive: true });
    }
  });
});

// --- Walk robustness and determinism --------------------------------------

Deno.test("an unreadable root propagates rather than reporting an empty vault", async () => {
  await withVault(async (root) => {
    const a = fsContext(root);
    await assertRejects(
      () => model.methods.list.execute({ folder: "no-such-folder" }, a.context),
      Error,
    );
  });
});

Deno.test("an unreadable subdirectory is skipped and the rest of the walk completes", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/a.md`, "a");
    await Deno.mkdir(`${root}/locked`);
    await Deno.writeTextFile(`${root}/locked/hidden.md`, "x");
    await Deno.mkdir(`${root}/open`);
    await Deno.writeTextFile(`${root}/open/b.md`, "b");
    await Deno.chmod(`${root}/locked`, 0o000);
    try {
      const a = fsContext(root);
      await model.methods.list.execute({ recursive: true }, a.context);
      assertEquals(a.captured[0].attrs.files, ["a.md", "open/b.md"]);
    } finally {
      await Deno.chmod(`${root}/locked`, 0o755);
    }
  });
});

Deno.test("list output is sorted so limit truncates predictably", async () => {
  await withVault(async (root) => {
    for (const name of ["delta", "alpha", "charlie", "bravo"]) {
      await Deno.writeTextFile(`${root}/${name}.md`, name);
    }
    const a = fsContext(root);
    await model.methods.list.execute({}, a.context);
    assertEquals(a.captured[0].attrs.files, [
      "alpha.md",
      "bravo.md",
      "charlie.md",
      "delta.md",
    ]);

    const b = fsContext(root);
    await model.methods.list.execute({ limit: 2 }, b.context);
    assertEquals(b.captured[0].attrs.files, ["alpha.md", "bravo.md"]);
  });
});

Deno.test("search results are sorted by path", async () => {
  await withVault(async (root) => {
    for (const name of ["zulu", "alpha", "mike"]) {
      await Deno.writeTextFile(`${root}/${name}.md`, "needle");
    }
    const a = fsContext(root);
    await model.methods.search.execute({ query: "needle" }, a.context);
    assertEquals(
      (a.captured[0].attrs.results as { file: string }[]).map((r) => r.file),
      ["alpha.md", "mike.md", "zulu.md"],
    );
  });
});

// --- Permission preservation ----------------------------------------------

Deno.test("overwriting an existing note preserves its permissions", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/private.md`, "original");
    await Deno.chmod(`${root}/private.md`, 0o600);
    const a = fsContext(root);
    await model.methods.create.execute(
      { name: "private.md", content: "replacement", overwrite: true },
      a.context,
    );
    const mode = (await Deno.stat(`${root}/private.md`)).mode! & 0o777;
    assertEquals(mode, 0o600, "existing permissions must not be relaxed");
  });
});

Deno.test("a newly created note gets defaultFileMode", async () => {
  await withVault(async (root) => {
    const a = fsContext(root, { defaultFileMode: 0o640 });
    await model.methods.create.execute(
      { name: "fresh.md", content: "x" },
      a.context,
    );
    const mode = (await Deno.stat(`${root}/fresh.md`)).mode! & 0o777;
    assertEquals(mode, 0o640);
  });
});

// --- Property type agreement across backends ------------------------------

Deno.test("propertyTypeHint maps JavaScript types to Obsidian property types", () => {
  assertEquals(propertyTypeHint(["a"]), "list");
  assertEquals(propertyTypeHint(true), "checkbox");
  assertEquals(propertyTypeHint(3), "number");
  assertEquals(propertyTypeHint("text"), undefined);
  assertEquals(propertyTypeHint(null), undefined);
});
