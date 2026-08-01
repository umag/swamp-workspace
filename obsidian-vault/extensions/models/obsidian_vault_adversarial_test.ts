// Adversarial characterization tests for @magistr/obsidian-vault, organized
// by the seven review-adversarial dimensions (credentials, logging, error
// handling, testing, idempotency, API contracts, resource management), plus
// the filesystem attack surface (path traversal, symlink escape, YAML/
// frontmatter injection, ReDoS).
//
// obsidian_vault.ts is BYTE-FROZEN. Every test in this file PINS current
// behavior — including seven KNOWN BUGS cataloged and tracked in the LOCAL
// `obsidian-vault-latent-bugs` issue-lifecycle model (never the swamp.club
// Lab — this is our own extension). A pinned test's comment always starts
// with `pin: KNOWN BUG (SEVERITY, obsidian-vault-latent-bugs #N)` so no
// reviewer or future edit mistakes a pin for something safe to "fix" here.
// This file also characterizes the defenses that DO hold (fs path
// confinement, symlink refusal, YAML-injection prevention, the maxBodyChars
// privacy default) as POSITIVE tests — not everything adversarial here is a
// bug.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  buildObsidianArgs,
  buildSearchMatcher,
  inferDate,
  mergeProperties,
  model,
  readProperties,
  resolveVaultPath,
  resolveVaultPathSafe,
} from "./obsidian_vault.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

function fixture(name: string): string {
  return Deno.readTextFileSync(`${FIXTURES}${name}`);
}

// ---------------------------------------------------------------------------
// Harness (same shape as obsidian_vault_test.ts and the methods suite)
// ---------------------------------------------------------------------------

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
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

const cfg = (over: Record<string, unknown> = {}) => ({
  vault: "testvault",
  vaultRoot: "/vault",
  backend: "auto",
  blockDotObsidian: true,
  ...over,
});

async function withVault(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function withCliStub(
  outputs: Array<{ success: boolean; stdout?: string; stderr?: string }>,
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
      const out = outputs[Math.min(i, outputs.length - 1)];
      i++;
      return Promise.resolve({
        success: out.success,
        code: out.success ? 0 : 1,
        stdout: new TextEncoder().encode(out.stdout ?? ""),
        stderr: new TextEncoder().encode(out.stderr ?? ""),
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
// 1. Credentials
// ---------------------------------------------------------------------------
//
// obsidian-vault carries no API key / token / password concept — the closest
// analog to "credential material" is the local vaultRoot filesystem path
// itself. Characterized here: that path is NOT redacted from thrown error
// text (acceptable for a local CLI tool operating on the user's own
// filesystem — a path is not a secret the way an API key is — but worth
// pinning so a future reviewer does not assume redaction happens).

Deno.test("credentials: the full vaultRoot path is NOT redacted from an outside-vault error", () => {
  assertThrows(
    () =>
      resolveVaultPath(
        cfg({ vaultRoot: "/private/vault/name" }),
        "/etc/passwd",
      ),
    Error,
    "/private/vault/name",
  );
});

Deno.test("credentials: no vault/token-shaped string ever appears in a CLI argv element", () => {
  const argv = buildObsidianArgs(
    "read",
    { file: "note.md" },
    "my-personal-vault",
  );
  for (const arg of argv) {
    assert(
      !/token|password|secret|api[_-]?key/i.test(arg),
      `argv element unexpectedly looks credential-shaped: ${arg}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Logging
// ---------------------------------------------------------------------------
//
// The logger receives only paths, folder names, and counts — never note
// bodies or property values. Characterized via digest's maxBodyChars=0
// default (also a security-review finding: the hard privacy bar for a
// personal notes vault).

Deno.test("logging: digest retains no note body by default (maxBodyChars=0)", () => {
  const shape = model.methods.digest.arguments.parse({});
  assertEquals(shape.maxBodyChars, 0);
});

Deno.test("logging: digest emits no note body even when a logger call fires mid-scan", async () => {
  await withVault(async (root) => {
    const logged: unknown[] = [];
    for (let i = 0; i < 251; i++) {
      await Deno.writeTextFile(`${root}/note-${i}.md`, `private body ${i}`);
    }
    const a = fsContext(root, {});
    a.context.logger = {
      info: (...args: unknown[]) => logged.push(args),
      warning: () => {},
    };
    await run("digest", { maxFiles: 2000, maxBodyChars: 0 }, a.context);
    const serialized = JSON.stringify(logged);
    assert(
      !serialized.includes("private body"),
      "a logged message must never embed note body text",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Error handling
// ---------------------------------------------------------------------------

Deno.test("error handling: malformed (tab-indented) frontmatter throws on read, not a silent {}", () => {
  const malformed = fixture("malformed-frontmatter.md");
  assertThrows(
    () => readProperties(malformed),
    Error,
    "Tabs are not allowed",
  );
});

Deno.test("error handling: malformed (tab-indented) frontmatter also throws on write, via a different error path", () => {
  const malformed = fixture("malformed-frontmatter.md");
  // readProperties throws from YAML.parse (a parse-time error); mergeProperties
  // uses the more lenient YAML.parseDocument, which does NOT throw at parse
  // time — the throw instead comes later, from Document#toString() refusing
  // to stringify a document that carries parse errors. Different call sites,
  // same overall behavior: malformed frontmatter is never silently corrupted
  // into wrong-but-plausible output on either the read or the write path.
  assertThrows(
    () => mergeProperties(malformed, { status: "active" }),
    Error,
    "cannot be stringified",
  );
});

Deno.test("error handling: an unterminated frontmatter fence is swallowed silently (no error, wrong-shape result)", () => {
  const unterminated = fixture("unterminated-frontmatter.md");
  // Unlike the malformed-YAML case above, this does NOT throw — splitFrontmatter
  // falls through to hasFrontmatter:false because it never finds a closing
  // "---" line, so the entire file (including the orphaned opening fence)
  // becomes "body" and readProperties silently returns {}. Same overall SHAPE
  // of silent-wrong behavior as the CRLF pin below, from the opposite
  // (missing-closing, not missing-opening) direction — see fixtures/
  // PROVENANCE.md for why this is documented but not itself a numbered pin.
  assertEquals(readProperties(unterminated), {});
});

Deno.test("error handling (testing dimension): a CLI failure surfaces the underlying stderr in the thrown error", async () => {
  const ctx =
    fsContext("/unused", { vaultRoot: undefined, backend: "cli" }).context;
  await withCliStub(
    [{ success: false, stderr: "obsidian: permission denied" }],
    async () => {
      await assertRejects(
        () => run("daily", {}, ctx),
        Error,
        "permission denied",
      );
    },
  );
});

Deno.test("error handling (testing dimension): a CLI failure that mentions a missing desktop app gets the friendlier, actionable message", async () => {
  const ctx =
    fsContext("/unused", { vaultRoot: undefined, backend: "cli" }).context;
  await withCliStub(
    [{ success: false, stderr: "Error: unable to find obsidian process" }],
    async () => {
      await assertRejects(
        () => run("daily", {}, ctx),
        Error,
        "Start Obsidian",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Testing (the property suite's own flake-prevention discipline)
// ---------------------------------------------------------------------------
//
// See obsidian_vault_property_test.ts's header for the domain-restricted
// arbitraries that keep the property suite from flaking on exactly the two
// pinned-bug domains (CRLF frontmatter, YAML-escaping-needing keys/values).
// Nothing to pin here beyond that cross-reference — this section exists so
// the file's organization visibly maps to all seven review-adversarial
// dimensions, per the approved plan.

// ---------------------------------------------------------------------------
// 5. Idempotency
// ---------------------------------------------------------------------------

Deno.test(
  "pin: KNOWN BUG (LOW, obsidian-vault-latent-bugs #7) — a second delete of a recreated same-named note silently overwrites the earlier trashed copy",
  async () => {
    await withVault(async (root) => {
      await Deno.mkdir(`${root}/notes`);
      await Deno.writeTextFile(`${root}/notes/x.md`, "first version");
      const del1 = fsContext(root);
      await run("delete", { file: "notes/x.md" }, del1.context);
      assertEquals(
        await Deno.readTextFile(`${root}/.trash/notes/x.md`),
        "first version",
      );

      // Recreate the SAME path with different content, then delete again.
      await Deno.writeTextFile(`${root}/notes/x.md`, "second version");
      const del2 = fsContext(root);
      await run("delete", { file: "notes/x.md" }, del2.context);

      // The first version is gone — Deno.rename silently replaced it. Trash
      // is therefore NOT a reliable multi-version recovery mechanism; this is
      // the current, deferred behavior, not something this change fixes.
      assertEquals(
        await Deno.readTextFile(`${root}/.trash/notes/x.md`),
        "second version",
      );
    });
  },
);

Deno.test("idempotency: propertySet applied twice with the same value produces byte-identical output (positive — holds)", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/note.md`, "---\ntitle: T\n---\n\nbody\n");
    const a = fsContext(root);
    await run(
      "propertySet",
      { file: "note.md", name: "status", value: "active" },
      a.context,
    );
    const first = await Deno.readTextFile(`${root}/note.md`);
    const b = fsContext(root);
    await run(
      "propertySet",
      { file: "note.md", name: "status", value: "active" },
      b.context,
    );
    assertEquals(await Deno.readTextFile(`${root}/note.md`), first);
  });
});

// ---------------------------------------------------------------------------
// 6. API contracts
// ---------------------------------------------------------------------------

Deno.test(
  "pin: KNOWN BUG (LOW, obsidian-vault-latent-bugs #5) — digest ignores an explicit backend=cli and silently runs on the filesystem anyway",
  async () => {
    await withVault(async (root) => {
      await Deno.writeTextFile(`${root}/note.md`, "# Heading\n\nbody text");
      const a = fsContext(root, { backend: "cli" });
      // digest is NOT in CLI_ONLY_METHODS, so selectBackend(..., "digest")
      // does not throw for backend=cli — but the method discards that
      // return value entirely and always calls withVaultRoot + the fs walk.
      // No Obsidian CLI call is ever attempted, even though the caller
      // explicitly asked for the cli backend.
      await run("digest", { maxFiles: 2000, maxBodyChars: 0 }, a.context);
      assertEquals(a.captured[0].attrs.fileCount, 1);
    });
  },
);

Deno.test(
  "pin: KNOWN BUG (MED, obsidian-vault-latent-bugs #3) — a backslash path is treated as one literal segment, not a traversal attempt (POSIX-only guard)",
  () => {
    // On Windows, "\\" is a directory separator and this string would escape
    // the vault root; normalizeSegments splits only on "/", so on POSIX (and
    // in this model's own string-level view of the path) it is one odd but
    // in-bounds filename, not two ".." traversal segments.
    const p = resolveVaultPath(cfg(), "..\\..\\etc\\passwd");
    assertEquals(p.vaultRelativePath, "..\\..\\etc\\passwd");
  },
);

Deno.test(
  "pin: KNOWN BUG (LOW, obsidian-vault-latent-bugs #6) — inferDate accepts impossible calendar dates",
  () => {
    assertEquals(inferDate("2026-02-31-standup.md"), "2026-02-31");
    assertEquals(inferDate("2026-04-31-standup.md"), "2026-04-31");
  },
);

Deno.test("API contract: the CLI backend delegates path confinement entirely to Obsidian (documented trust boundary)", () => {
  // Only the fs backend calls resolveVaultPathSafe. buildObsidianArgs performs
  // NO confinement check of its own — a traversal string passes straight
  // through to the obsidian binary's own argument parsing. This is a
  // deliberate, documented trust boundary (the CLI backend needs Obsidian's
  // desktop app running anyway), not a bug to fix here.
  const argv = buildObsidianArgs(
    "read",
    { file: "../../etc/passwd" },
    "myvault",
  );
  assertEquals(argv, ["read", "vault=myvault", "file=../../etc/passwd"]);
});

Deno.test("API contract: argv is a real array, not a shell string — a hostile value cannot inject a second command", () => {
  const argv = buildObsidianArgs(
    "create",
    { content: "a; rm -rf / #`echo pwned`" },
    "myvault",
  );
  assertEquals(argv, [
    "create",
    "vault=myvault",
    "content=a; rm -rf / #`echo pwned`",
  ]);
  assert(
    argv.every((a) => typeof a === "string"),
    "every argv element must be a plain string — Deno.Command never invokes a shell",
  );
});

// ---------------------------------------------------------------------------
// 7. Resource management
// ---------------------------------------------------------------------------

Deno.test(
  "pin: KNOWN BUG (MED, obsidian-vault-latent-bugs #4) — signalHits are unbounded in memory; only the output field is sliced to 500",
  async () => {
    await withVault(async (root) => {
      const lines = Array.from(
        { length: 600 },
        (_, i) => `line ${i} contains the marker keyword`,
      ).join("\n");
      await Deno.writeTextFile(`${root}/big.md`, lines);
      const a = fsContext(root);
      await run(
        "digest",
        { signalKeywords: ["marker"], maxFiles: 2000, maxBodyChars: 0 },
        a.context,
      );
      const rollups = a.captured[0].attrs.signalRollups as {
        keyword: string;
        count: number;
      }[];
      const hits = a.captured[0].attrs.signalHits as unknown[];
      assertEquals(rollups[0].count, 600, "the TRUE total is not capped");
      assertEquals(hits.length, 500, "only the OUTPUT array is capped at 500");
    });
  },
);

Deno.test(
  "pin: KNOWN BUG (MED, obsidian-vault-latent-bugs #4) — digest and search read a whole file with no per-file byte bound",
  async () => {
    await withVault(async (root) => {
      const oneMegabyte = "x".repeat(1_000_000);
      await Deno.writeTextFile(`${root}/huge.md`, oneMegabyte);
      const a = fsContext(root);
      // No size guard exists — this completes rather than being rejected for
      // exceeding a per-file limit (there is no such limit to trip).
      await run("digest", { maxFiles: 2000, maxBodyChars: 0 }, a.context);
      const entry = (a.captured[0].attrs.files as Record<string, unknown>[])[0];
      assertEquals(entry.wordCount, 1);
    });
  },
);

// ---------------------------------------------------------------------------
// Filesystem attack surface — confinement, symlinks, injection, ReDoS
// ---------------------------------------------------------------------------

const FS_METHOD_ARGS: Record<
  string,
  (path: string) => Record<string, unknown>
> = {
  list: (p) => ({ folder: p }),
  read: (p) => ({ file: p }),
  fileInfo: (p) => ({ file: p }),
  create: (p) => ({ name: p, content: "x" }),
  append: (p) => ({ file: p, content: "x" }),
  prepend: (p) => ({ file: p, content: "x" }),
  delete: (p) => ({ file: p }),
  search: (p) => ({ query: "x", folder: p }),
  digest: (p) => ({ folder: p }),
  properties: (p) => ({ file: p }),
  propertySet: (p) => ({ file: p, name: "x", value: "y" }),
  setProperties: (p) => ({ file: p, properties: { x: "y" } }),
  propertyRemove: (p) => ({ file: p, name: "x" }),
};

Deno.test("fs attack surface: path confinement holds — every fs method rejects a traversal path", async () => {
  await withVault(async (root) => {
    for (const [name, argsFor] of Object.entries(FS_METHOD_ARGS)) {
      const a = fsContext(root);
      await assertRejects(
        () => run(name, argsFor("../../etc/passwd"), a.context),
        Error,
        undefined,
        `method ${name} must reject a traversal path`,
      );
    }
  });
});

Deno.test("fs attack surface: symlink refusal holds — every fs method refuses a symlinked path segment", async () => {
  await withVault(async (root) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${outside}/secret.md`, "private");
      await Deno.symlink(`${outside}/secret.md`, `${root}/escape.md`);
      for (const [name, argsFor] of Object.entries(FS_METHOD_ARGS)) {
        const a = fsContext(root);
        await assertRejects(
          () => run(name, argsFor("escape.md"), a.context),
          Error,
          "symlink",
          `method ${name} must refuse the symlinked path`,
        );
      }
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("fs attack surface: YAML/frontmatter injection is prevented — a value carrying a fake closing fence cannot open a second frontmatter block", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(
      `${root}/note.md`,
      "---\ntitle: Safe note\n---\n\nBody.\n",
    );
    const a = fsContext(root);
    await run(
      "propertySet",
      {
        file: "note.md",
        name: "hostile",
        value: "x\n---\ninjected: true",
      },
      a.context,
    );
    const next = await Deno.readTextFile(`${root}/note.md`);
    const props = readProperties(next);
    assertEquals(props.hostile, "x\n---\ninjected: true");
    assertEquals("injected" in props, false, "no sibling key was injected");
    // Exactly one frontmatter block: the fake "---\ninjected: true" line
    // landed inside a quoted/escaped scalar, not as literal document
    // structure, so there is still only one real closing fence.
    const fenceLines = next.split("\n").filter((l) => l === "---");
    assertEquals(fenceLines.length, 2, "still exactly one frontmatter block");
  });
});

Deno.test(
  "pin: KNOWN BUG (HIGH, obsidian-vault-latent-bugs #1) — a CRLF frontmatter note's properties are silently invisible to readProperties",
  () => {
    // Constructed inline (not solely from the committed fixture) so the pin
    // holds even if a future Git configuration ever normalizes line endings
    // on checkout.
    const crlf = "---\r\ntitle: CRLF sample note\r\nstatus: draft\r\n---\r\n" +
      "\r\n# CRLF sample body\r\n\r\nBody text after CRLF frontmatter.\r\n";
    assertEquals(
      readProperties(crlf),
      {},
      "silently wrong: not {} would mean the bug is fixed",
    );
  },
);

Deno.test(
  "pin: KNOWN BUG (HIGH, obsidian-vault-latent-bugs #1) — the CRLF fixture on disk still carries real \\r bytes (guards against silent Git normalization)",
  () => {
    const onDisk = fixture("crlf-frontmatter.md");
    assert(onDisk.includes("\r\n"), "fixture must retain literal CRLF bytes");
  },
);

Deno.test(
  "pin: KNOWN BUG (HIGH, obsidian-vault-latent-bugs #1) — setProperties on a CRLF note PREPENDS a second frontmatter block instead of merging into the existing one",
  async () => {
    await withVault(async (root) => {
      const crlf =
        "---\r\ntitle: CRLF sample note\r\nstatus: draft\r\n---\r\n" +
        "\r\n# CRLF sample body\r\n\r\nBody text after CRLF frontmatter.\r\n";
      await Deno.writeTextFile(`${root}/note.md`, crlf);
      const a = fsContext(root);
      await run(
        "setProperties",
        { file: "note.md", properties: { status: "active" } },
        a.context,
      );
      const next = await Deno.readTextFile(`${root}/note.md`);
      const fenceCount = (next.match(/^---$/gm) ?? []).length;
      assertEquals(fenceCount, 4, "TWO frontmatter-looking blocks now exist");
      const props = readProperties(next);
      // Only the NEW block is visible; the CRLF note's original title/status
      // are now silently buried inside what readProperties treats as body.
      assertEquals(props, { status: "active" });
      assert(
        next.includes("title: CRLF sample note"),
        "the original title text still exists in the file...",
      );
      assertEquals(
        props.title,
        undefined,
        "...but it is no longer reachable as a property — this is the corruption",
      );
    });
  },
);

Deno.test(
  "pin: KNOWN BUG (MED, obsidian-vault-latent-bugs #2) — an alternation-based catastrophic regex passes the nested-quantifier guard",
  () => {
    // The guard's regex only matches a single parenthesized group followed by
    // its own quantifier — it does not account for alternation-based
    // catastrophic backtracking. This only asserts that the pattern COMPILES
    // (passes the guard); it deliberately does not exercise the pattern
    // against a real line, which could hang the test runner.
    const matcher = buildSearchMatcher("(a|a)+", true, false);
    assertEquals(typeof matcher, "function");
    const matcher2 = buildSearchMatcher("(a|ab)*", true, false);
    assertEquals(typeof matcher2, "function");
  },
);

Deno.test("fs attack surface: the ORIGINAL nested-quantifier shape is still caught (the guard is not entirely useless)", () => {
  assertThrows(
    () => buildSearchMatcher("(a+)+$", true, false),
    Error,
    "quantifier",
  );
});

// resolveVaultPathSafe is exported and already covered extensively by
// obsidian_vault_test.ts; re-imported here only to keep this file's fs
// attack-surface section self-describing without re-deriving the symlink
// mechanics inline for every method above.
Deno.test("fs attack surface: resolveVaultPathSafe is the single choke point every fs method above routes through", async () => {
  await withVault(async (root) => {
    await Deno.writeTextFile(`${root}/real.md`, "x");
    const p = await resolveVaultPathSafe(cfg({ vaultRoot: root }), "real.md");
    assertEquals(p.vaultRelativePath, "real.md");
  });
});
