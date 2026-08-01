/**
 * Adversarial suite: attacker's-perspective tests for @magistr/skype — TSV
 * row-corruption on embedded newline/tab, path traversal via an unsanitized
 * `folder`/`profile`, resource-name collisions, the unbounded single-blob
 * export resource, the absent subprocess timeout, lone-surrogate slice
 * truncation, YAML frontmatter injection, the emoji numeric-entity
 * mis-decode, and the hand-rolled SQL escaping (a covered NEGATIVE — pinning
 * that it holds TODAY). Plus a mechanical fixtures-secret-scan over
 * skype/fixtures/*.
 *
 * FIXED (2026.08.01.1): BUG #1 (TSV row corruption on embedded newline/tab —
 * queryDb now transports via `sqlite3 -ascii`, 0x1F/0x1E framing) and BUG #2
 * (path traversal via unsanitized `folder`/`profile` — importToObsidian now
 * guards the write target with `resolveWithin`). Both are now GREEN tests
 * proving the fix, not pins of buggy behavior. Every other bug (#3-#9) is
 * still characterized-not-fixed — skype.ts remains BYTE-FROZEN for those.
 * Where a test documents a real gap, it is labeled "pin"/"BUG #n" and says so
 * explicitly. Every finding here is filed against the LOCAL
 * `skype-latent-bugs` issue-lifecycle model, never the Lab. See
 * fixtures/PROVENANCE.md for fixture provenance.
 *
 * All `sqlite3` stdout stubs use `asciiTable()` — 0x1F between columns, 0x1E
 * terminating every record (the real `sqlite3 -ascii` wire shape) — never
 * raw tab/newline joins, which the fixed queryDb no longer parses as framing.
 *
 * No test in this file hangs (BUG #5 is pinned by inspecting the Deno.Command
 * options, never by simulating a real subprocess hang) and no test reads a
 * real filesystem path outside a `Deno.makeTempDir` sandbox (BUG #2's escape
 * targets are sibling temp directories, never a real system path).
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

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
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
type CommandInvocation = { sql: string; options: Record<string, unknown> };
type SqlRouter = (sql: string) => CommandResult;

function installSqliteStub(router: SqlRouter) {
  const encoder = new TextEncoder();
  const calls: string[] = [];
  const invocations: CommandInvocation[] = [];
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const original = g.Deno.Command;
  class FakeCommand {
    #sql: string;
    constructor(_cmd: string, options: Record<string, unknown> = {}) {
      const args = (options.args as string[] | undefined) ?? [];
      this.#sql = args[args.length - 1] ?? "";
      calls.push(this.#sql);
      invocations.push({ sql: this.#sql, options });
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
    invocations,
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
// BUG #1 (HIGH, FIXED 2026.08.01.1): TSV row corruption on embedded newline
// ---------------------------------------------------------------------------

Deno.test("BUG #1 FIXED: an embedded raw newline in body_xml no longer fabricates a second row — the ascii transport preserves it as ONE intact message", async () => {
  const conversations = asciiTable([
    ["1", "live:.cid.fake0001", "Ana Synthetic"],
  ]);
  const messages = await loadFixture("messages_newline_corruption.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("readConversation", { conversation: "Ana Synthetic" }, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const rows = res.payload.messages as Array<Record<string, unknown>>;
  assertEquals(
    rows.length,
    1,
    "0x1E framing never collides with an embedded newline — no spurious second row",
  );
  assertEquals(
    rows[0].body,
    "line one\nline two continued",
    "the full body_xml, embedded newline included, survives intact",
  );
});

// ---------------------------------------------------------------------------
// BUG #1 sibling (HIGH, FIXED 2026.08.01.1): TSV column-shift on embedded tab
// ---------------------------------------------------------------------------

Deno.test("BUG #1 sibling FIXED: an embedded raw tab in body_xml no longer shifts columns — chatname and dialogPartner stay correct and nothing is dropped", async () => {
  const conversations = asciiTable([
    ["1", "live:.cid.fake0004", "Fixture Four"],
  ]);
  const messages = await loadFixture("messages_tab_corruption.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("readConversation", { conversation: "Fixture Four" }, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const rows = res.payload.messages as Array<Record<string, unknown>>;
  assertEquals(rows.length, 1);
  assertEquals(
    rows[0].body,
    "alpha\tbeta",
    "0x1F framing never collides with an embedded tab — body_xml survives intact",
  );
  assertEquals(
    rows[0].chatname,
    "RealChat",
    "chatname is read from the correct (unshifted) column",
  );
  assertEquals(
    rows[0].dialogPartner,
    "live:.cid.fake0005",
    "the real trailing dialog_partner value is no longer dropped",
  );
});

// ---------------------------------------------------------------------------
// BUG #2 (HIGH, FIXED 2026.08.01.1): path traversal via unsanitized `folder`
// / `profile` in importToObsidian
// ---------------------------------------------------------------------------

Deno.test("BUG #2 FIXED: importToObsidian rejects a `folder` that escapes the vault directory via '../' — nothing is written outside it", async () => {
  const sandbox = await Deno.makeTempDir();
  const vault = `${sandbox}/vault`;
  await Deno.mkdir(vault, { recursive: true });
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fake0001",
      "Ana Synthetic",
      "1",
      "1",
      "1700000000",
      "1700000000",
    ],
  ]);
  const messages = await loadFixture("messages_export.tsv");
  try {
    const { ctx } = makeCtx();
    await assertRejects(
      () =>
        withSqliteStub(
          byTable({ conversations, messages }),
          () =>
            run(
              "importToObsidian",
              { vaultPath: vault, folder: "../escaped" },
              ctx,
            ),
        ),
      Error,
      "escapes",
      "resolveWithin throws before any file is written",
    );
    // The would-be escape target must never have been created.
    let escapedExists = true;
    try {
      await Deno.stat(`${sandbox}/escaped`);
    } catch {
      escapedExists = false;
    }
    assert(
      !escapedExists,
      "the traversal folder must NEVER write files outside the intended vault directory",
    );
  } finally {
    await Deno.remove(sandbox, { recursive: true });
  }
});

Deno.test("BUG #2 FIXED: importToObsidian also rejects a `profile` global argument that escapes the vault directory via '../'", async () => {
  // resolveWithin guards `resolve(vaultPath, folder, profile)` as a WHOLE —
  // a benign folder combined with a hostile profile must be rejected exactly
  // like a hostile folder, per the security review finding on the approved
  // plan (guarding folder alone would leave a profile-based escape open).
  const sandbox = await Deno.makeTempDir();
  const vault = `${sandbox}/vault`;
  await Deno.mkdir(vault, { recursive: true });
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fake0001",
      "Ana Synthetic",
      "1",
      "1",
      "1700000000",
      "1700000000",
    ],
  ]);
  const messages = await loadFixture("messages_export.tsv");
  try {
    // Two "../" levels: the joined target is resolve(vaultPath, "Skype",
    // profile) — "Skype" (the default folder, one level deep) must be popped
    // AND vaultPath itself, or the profile-escape only lands back inside the
    // vault (e.g. a single "../" here would merely cancel out "Skype").
    const { ctx } = makeCtx({
      basePath: "/fixtures/skype-data",
      profile: "../../escaped-via-profile",
    });
    await assertRejects(
      () =>
        withSqliteStub(
          byTable({ conversations, messages }),
          () => run("importToObsidian", { vaultPath: vault }, ctx),
        ),
      Error,
      "escapes",
      "a hostile profile is rejected exactly like a hostile folder",
    );
    let escapedExists = true;
    try {
      await Deno.stat(`${sandbox}/escaped-via-profile`);
    } catch {
      escapedExists = false;
    }
    assert(
      !escapedExists,
      "no file is ever written outside the intended vault directory via profile",
    );
  } finally {
    await Deno.remove(sandbox, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// BUG #3 (MEDIUM): resource-name collision -> overwrite
// ---------------------------------------------------------------------------

Deno.test("BUG #3 pin: readConversation's safeKey collides for two conversations whose first 50 sanitized characters are identical", async () => {
  const longNameA = "Fixture Group " + "X".repeat(60) + " Alpha";
  const longNameB = "Fixture Group " + "X".repeat(60) + " Beta";
  const namesA = asciiTable([["1", "live:.cid.fakeA", longNameA]]);
  const namesB = asciiTable([["2", "live:.cid.fakeB", longNameB]]);
  const messages = "";

  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations: namesA, messages }),
    () => run("readConversation", { conversation: longNameA }, ctx),
  );
  await withSqliteStub(
    byTable({ conversations: namesB, messages }),
    () => run("readConversation", { conversation: longNameB }, ctx),
  );
  const names = written.filter((w) => w.spec === "messages").map((w) => w.name);
  assertEquals(names.length, 2);
  assertEquals(
    names[0],
    names[1],
    "both distinct conversations collide on the identical conv_<safeKey> resource name — the second call clobbers the first's data in a real instance",
  );
});

Deno.test("BUG #3 pin: exportToObsidian's obsidianPath collides for two conversations sharing the same first-80-chars sanitized displayname", async () => {
  const longA = "Y".repeat(90) + " Alpha";
  const longB = "Y".repeat(90) + " Beta";
  const conversations = asciiTable([
    ["1", "live:.cid.fakeA", longA, "1", "2", "1700000000", "1700000000"],
    ["2", "live:.cid.fakeB", longB, "1", "2", "1700000000", "1700000000"],
  ]);
  const messages = await loadFixture("messages_export.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", {}, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const notes = res.payload.messages as Array<{ obsidianPath: string }>;
  assertEquals(notes.length, 2);
  assertEquals(
    notes[0].obsidianPath,
    notes[1].obsidianPath,
    "two conversations with different names collide on the identical 80-char-truncated obsidianPath",
  );
});

// ---------------------------------------------------------------------------
// BUG #4 (MEDIUM): exportToObsidian is one unbounded single-blob resource
// ---------------------------------------------------------------------------

Deno.test("BUG #4 pin: exportToObsidian accumulates EVERY conversation's full chat log into ONE array written as ONE resource — no chunking/pagination", async () => {
  const conversations = await loadFixture("conversations.tsv");
  const messages = await loadFixture("messages_export.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", {}, ctx),
  );
  const writes = written.filter((w) => w.spec === "messages");
  assertEquals(
    writes.length,
    1,
    "exactly one writeResource call carries every conversation's export, regardless of how many conversations exist",
  );
  const notes = writes[0].payload.messages as unknown[];
  assertEquals(
    notes.length,
    4,
    "all 4 conversations' notes live in that single array",
  );
});

// ---------------------------------------------------------------------------
// BUG #5 (MEDIUM): no subprocess timeout on queryDb's Deno.Command
// ---------------------------------------------------------------------------

Deno.test("BUG #5 pin: queryDb's Deno.Command is constructed with NO signal/timeout option — a wedged sqlite3 would hang forever", async () => {
  // We do NOT simulate an actual hang (that would make this test itself hang
  // or require a real timeout) — we inspect the constructor's captured
  // options and assert the absence of any abort/timeout mechanism.
  const conversations = await loadFixture("conversations.tsv");
  const { ctx } = makeCtx();
  await withSqliteStub(byTable({ conversations }), async (stub) => {
    await run("listConversations", {}, ctx);
    const opts = stub.invocations[0].options;
    assert(
      !("signal" in opts),
      "no AbortSignal is ever passed to Deno.Command — nothing can cancel a hung sqlite3 process",
    );
    assertEquals(opts.stdout, "piped");
    assertEquals(opts.stderr, "piped");
  });
});

// ---------------------------------------------------------------------------
// BUG #6 (MEDIUM): lone-surrogate slice truncation
// ---------------------------------------------------------------------------

Deno.test("BUG #6 pin: importToObsidian's 80-char filename slice can cut a surrogate pair in half — Deno.writeTextFile silently replaces the lone surrogate with U+FFFD rather than erroring", async () => {
  // 79 'A' characters + an astral emoji (2 UTF-16 code units) means
  // slice(0, 80) keeps the emoji's HIGH surrogate but drops its LOW
  // surrogate — the forbidden-filesystem-character replace() that runs
  // BEFORE the slice does not touch emoji, so the pair survives intact up to
  // the cut.
  const displayname = "A".repeat(79) + "\u{1F600}" + " tail";
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fakeSurrogate",
      displayname,
      "1",
      "1",
      "1700000000",
      "1700000000",
    ],
  ]);
  const messages = await loadFixture("messages_export.tsv");
  const vault = await Deno.makeTempDir();
  try {
    const { ctx, written } = makeCtx();
    await withSqliteStub(
      byTable({ conversations, messages }),
      () => run("importToObsidian", { vaultPath: vault }, ctx),
    );
    const res = written.find((w) => w.spec === "conversations")!;
    assertEquals(
      res.payload.count,
      1,
      "the write is NOT skipped — Deno.writeTextFile tolerates the lone surrogate",
    );
    const dir = `${vault}/Skype/synthetic-user`;
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries.length, 1);
    const written_name = entries[0];
    assert(
      written_name.includes("�"),
      "the on-disk filename contains the U+FFFD replacement character where the lone surrogate was — silent corruption, not an error",
    );
    assert(
      !written_name.includes("tail"),
      "the text after the truncation point never made it into the filename",
    );
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// BUG #7 (MEDIUM): YAML frontmatter injection via newline in display name
// ---------------------------------------------------------------------------

Deno.test("BUG #7 pin: a carriage return in displayname breaks out of the YAML 'title' string scalar in exportToObsidian's frontmatter", async () => {
  // exportToObsidian only escapes '\"' in the title field
  // (`displayname.replace(/\"/g, '\\\\\"')`) — it never escapes or rejects a
  // raw line-break, so an attacker-controlled displayname can inject
  // arbitrary additional YAML-shaped lines into the frontmatter block.
  //
  // NOTE: this bug is independent of queryDb's transport (TSV or ascii) —
  // exportToObsidian's frontmatter builder only ever escapes the quote
  // character, never a line-break, regardless of how the row reached it. A
  // raw CR ("\r") is not a record separator in either transport, so it
  // survives intact as a single coherent displayname value all the way
  // through to the frontmatter template literal.
  const hostileName = 'Evil"\rtags:\r  - injected-by-displayname';
  const conversations = asciiTable([
    [
      "1",
      "live:.cid.fakeEvil",
      hostileName,
      "1",
      "1",
      "1700000000",
      "1700000000",
    ],
  ]);
  const messages = await loadFixture("messages_export.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("exportToObsidian", {}, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const notes = res.payload.messages as Array<{ obsidianContent: string }>;
  const content = notes[0].obsidianContent;
  assert(
    content.includes('title: "Evil\\"\rtags:\r  - injected-by-displayname"'),
    "the raw carriage return and injected 'tags:' key survive verbatim inside the YAML frontmatter block",
  );
});

// ---------------------------------------------------------------------------
// BUG #8 (LOW): emoji numeric-entity mis-decode
// ---------------------------------------------------------------------------

Deno.test("BUG #8 pin: stripXml's &#N; decoder is CORRECT for BMP code points but silently mis-decodes an astral (>0xFFFF) code point via String.fromCharCode instead of String.fromCodePoint", async () => {
  const conversations = asciiTable([
    ["1", "live:.cid.fake0007", "Fixture Seven"],
  ]);
  const messages = await loadFixture("messages_entities.tsv");
  const { ctx, written } = makeCtx();
  await withSqliteStub(
    byTable({ conversations, messages }),
    () => run("readConversation", { conversation: "Fixture Seven" }, ctx),
  );
  const res = written.find((w) => w.spec === "messages")!;
  const rows = res.payload.messages as Array<{ body: string }>;
  const body = rows[0].body;
  assert(
    body.includes("☃"),
    "the BMP snowman entity (&#9731;) decodes correctly",
  );
  assert(
    !body.includes("\u{1F600}"),
    "the astral grinning-face emoji (&#128512;) does NOT decode to the real emoji",
  );
  assert(
    body.includes(String.fromCharCode(128512)),
    "instead it decodes to String.fromCharCode(128512) verbatim — an unrelated BMP character, not U+FFFD and not the intended emoji",
  );
});

// ---------------------------------------------------------------------------
// BUG #9 (MEDIUM, not currently exploitable): hand-rolled SQL escaping —
// covered NEGATIVE pinning that the '->'' escaping and argv-array
// (no `sh -c`) invocation shape both hold TODAY.
// ---------------------------------------------------------------------------

Deno.test("pin: readConversation's search term has every single-quote doubled ('') before being embedded in the SQL literal", async () => {
  const hostile = "O'Brien' OR '1'='1";
  const { ctx } = makeCtx();
  await withSqliteStub(byTable({ conversations: "" }), async (stub) => {
    try {
      await run("readConversation", { conversation: hostile }, ctx);
    } catch {
      // expected: not-found throw, we only care about the SQL text sent
    }
    const sql = stub.calls[0];
    assert(
      sql.includes("O''Brien'' OR ''1''=''1"),
      "every single quote in the hostile input is doubled — sqlite3's own string-literal escaping neutralizes the naive injection attempt",
    );
    assert(
      !sql.includes(hostile),
      "the RAW (un-doubled) hostile value never appears anywhere in the generated SQL — every quote in it was escaped",
    );
  });
});

Deno.test("covered negative: queryDb invokes sqlite3 via an ARGV ARRAY, never a shell string — no `sh -c` involved anywhere", async () => {
  // This is the structural guarantee that makes BUG #9's escaping merely
  // "fragile", not "exploitable": since args is a plain array passed to
  // Deno.Command (not a single shell-interpreted string), there is no shell
  // metacharacter injection surface at the process-invocation layer — only
  // the SQL STRING LITERAL escaping matters, and that escaping holds today.
  // A future refactor to `new Deno.Command("sh", { args: ["-c", ...] })`
  // would reintroduce a real shell-injection vector; this test must go red
  // the moment that happens.
  //
  // Updated 2026.08.01.1: the transport itself moved from "-separator \t"
  // (TSV) to "-ascii" (BUG #1 fix), so the argv shape is now
  // ["-ascii", dbPath, sql] — still a plain 3-element array, never a shell
  // string.
  const conversations = await loadFixture("conversations.tsv");
  const { ctx } = makeCtx();
  await withSqliteStub(byTable({ conversations }), async (stub) => {
    await run("listConversations", {}, ctx);
    assertEquals(stub.invocations.length, 1);
    const { options } = stub.invocations[0];
    const args = options.args as string[];
    assertEquals(args.length, 3, "['-ascii', dbPath, sql] — three elements");
    assertEquals(args[0], "-ascii");
    assert(
      !args.some((a) => a === "sh" || a === "-c" || a === "bash"),
      "no shell indirection appears anywhere in the argv array",
    );
  });
});

Deno.test("covered negative: a hostile sender value with a single quote AND a backslash still round-trips through the LIKE clause with only the quote doubled", async () => {
  const messages = "";
  const { ctx } = makeCtx();
  await withSqliteStub(byTable({ messages }), async (stub) => {
    await run("searchBySender", { sender: "back\\slash's" }, ctx);
    const sql = stub.calls[0];
    assert(
      sql.includes("back\\slash''s"),
      "the quote is doubled; the backslash is left completely untouched (sqlite3 string literals do not treat backslash as an escape character, so this is correct, not a gap)",
    );
  });
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — mechanical backstop over the committed corpus
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "generic API key shape", re: /\b(api|secret)[_-]?key\b/i },
  { name: "bearer/token shape", re: /\b(bearer|token)\s+[a-z0-9._-]{16,}/i },
  // Generic high-entropy blob: entirely 32+ alnum/base64url chars, no
  // separators — none of our authored fixture values (handles, names,
  // timestamps, message bodies) match this shape.
  { name: "high-entropy token-shaped value", re: /^[A-Za-z0-9+/_=-]{32,}$/ },
];

function collectFields(asciiText: string): string[] {
  // Fixtures are ascii-framed (0x1E record / 0x1F unit separator) since
  // 2026.08.01.1 — split on the real framing bytes, not tab/newline (which
  // may now legitimately appear INSIDE a field value, e.g. the corruption
  // fixtures' embedded newline/tab).
  return asciiText.split("\x1E").flatMap((record) => record.split("\x1F"));
}

const FIXTURE_FILES = [
  "conversations.tsv",
  "contacts.tsv",
  "messages_read.tsv",
  "messages_search.tsv",
  "messages_export.tsv",
  "messages_newline_corruption.tsv",
  "messages_tab_corruption.tsv",
  "messages_entities.tsv",
];

Deno.test("fixtures-secret-scan: no committed fixture contains a secret-shaped string", async () => {
  const violations: string[] = [];
  for (const file of FIXTURE_FILES) {
    const text = await loadFixture(file);
    for (const field of collectFields(text)) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (field && re.test(field)) {
          violations.push(`${file}: value "${field}" matched ${name}`);
        }
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected secret shape", () => {
  const poisoned = "apikey_" + "a".repeat(32);
  const violations = SECRET_PATTERNS.filter(({ re }) => re.test(poisoned));
  assert(
    violations.length > 0,
    "sanity check: scanner must flag an injected shape",
  );
});
