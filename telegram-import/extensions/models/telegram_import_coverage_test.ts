/**
 * Coverage suite for @magistr/telegram-import.
 *
 * telegramTextToMarkdown, noteSlug, and the inline noteKey ternary are all
 * module-PRIVATE in telegram_import.ts (not exported) — like anime-cron's
 * wire parsers, they are only reachable through `model.methods.import.execute()`.
 * This suite sweeps their remaining branches not already exercised by the
 * contract-fixture golden run or the methods suite: every `text_entities`
 * type, non-string/non-array `text` shapes, mixed array item shapes, a
 * date with no "T" separator, and the fully-minimal message (no optional
 * fields at all). Also uses fixtures/edge/result.json for its committed
 * structural edge cases.
 *
 * telegram_import.ts is UNMODIFIED — every assertion characterizes
 * already-shipped behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_GLOBAL_ARGS,
  makeCtx,
  runImport,
  withStubs,
  writeRealResultJson,
} from "./telegram_import_test_helpers.ts";
import edgeFixture from "../../fixtures/edge/result.json" with { type: "json" };

function payload(messages: Record<string, unknown>[], name = "Fixture Chan") {
  return { name, type: "public_channel", id: 42, messages };
}

// ---------------------------------------------------------------------------
// fixtures/edge/result.json — committed structural edge cases
// ---------------------------------------------------------------------------

Deno.test("coverage: empty-string text produces an empty body (frontmatter only, no blank text line)", async () => {
  const real = await writeRealResultJson(edgeFixture);
  try {
    const { ctx, written } = makeCtx();
    let calls: { path?: string; content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const post200 = written.find((w) =>
      w.spec === "post" && w.payload.id === 200
    )!;
    assertEquals(post200.payload.text, "");
    const call = calls.find((c) => c.path?.includes("2021-02-01-200"));
    assert(call);
    assert(
      call!.content!.endsWith("---\n"),
      "an empty-text message with no media/forwarded contributes nothing " +
        "after the frontmatter block",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: mention/hashtag/email/phone/unknown-future entity types all fall through to their raw .text (the switch's shared default arm)", async () => {
  const real = await writeRealResultJson(edgeFixture);
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post201 = written.find((w) =>
      w.spec === "post" && w.payload.id === 201
    )!;
    assertEquals(
      post201.payload.text,
      "@fixture_user said #fixture to fixture@example.test or " +
        "+1-202-555-0101fallback text",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: a file ending in _thumb.jpg is skipped even via the committed edge fixture", async () => {
  const real = await writeRealResultJson(edgeFixture);
  try {
    const { ctx, written } = makeCtx();
    let copies: { src: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.filesCopied, 0);
    assertEquals(copies.length, 0);
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: media_type video_file with no file field never enters the copy branch, via the committed edge fixture", async () => {
  const real = await writeRealResultJson(edgeFixture);
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.totalMessages, 4);
    assertEquals(result.payload.filesCopied, 0);
    assertEquals(result.payload.errors, []);
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// telegramTextToMarkdown — remaining branches (ad-hoc payloads)
// ---------------------------------------------------------------------------

Deno.test("coverage: non-string, non-array text (a number) yields an empty string", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-01T00:00:00",
      text: 12345,
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.text, "");
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: null text yields an empty string", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-02T00:00:00",
      text: null,
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.text, "");
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: an empty text_entities array yields an empty string", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-03T00:00:00",
      text: [],
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.text, "");
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: a bare string entry mixed with entity objects concatenates with no separator", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-04T00:00:00",
      text: ["literal string entry", { type: "bold", text: "bold part" }],
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.text, "literal string entry**bold part**");
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: a non-object, non-string array item (e.g. a bare number) renders as empty", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-05T00:00:00",
      text: [42, { type: "plain", text: "kept" }],
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.text, "kept");
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: a 'pre' entity renders a fenced code block", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-06T00:00:00",
      text: [{ type: "pre", text: "const x = 1;\nconsole.log(x);" }],
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(
      post.payload.text,
      "```\nconst x = 1;\nconsole.log(x);\n```",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("coverage: 'link' returns the entity's .text (not its .href), distinct from 'text_link'", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-07T00:00:00",
      text: [{ type: "link", text: "https://example.test/raw-link" }],
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.text, "https://example.test/raw-link");
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// noteSlug — date without a "T" separator
// ---------------------------------------------------------------------------

Deno.test("coverage: noteSlug on a date with no 'T' separator uses the date string unchanged", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 7,
      type: "message",
      date: "2022-07-08",
      text: "no time component",
    }]),
  );
  try {
    const { ctx } = makeCtx();
    let calls: { path?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    assertEquals(calls[0].path, "Telegram/2022-07-08-7");
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fully-minimal message — no optional fields at all
// ---------------------------------------------------------------------------

Deno.test("coverage: a message with none of photo/file/forwarded_from/reply_to_message_id/media_type produces a plain note with no embeds", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-09T00:00:00",
      text: "just text, nothing else",
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    let calls: { content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.photo, undefined);
    assertEquals(post.payload.forwardedFrom, undefined);
    assertEquals(post.payload.replyTo, undefined);
    const content = calls[0].content!;
    assert(!content.includes("![["));
    assert(!content.includes("Forwarded from"));
    assert(!content.includes("reply_to:"));
    assert(!content.includes("forwarded_from:"));
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// backend selection branch matrix (swamp-workspace #57) -- import's note
// -destination resolution: vaultRoot (global argument) > the CLI vault-name
// lookup (getVaultPath) / obsidian create. Every branch either writes to the
// expected vault directory or drives the stubbed Deno.Command exactly once.
// ---------------------------------------------------------------------------

Deno.test("branch matrix: vaultRoot unset -- falls back to the CLI (getVaultPath + obsidian create), exactly as before this change", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-08-01T00:00:00",
      text: "cli branch",
    }]),
  );
  try {
    const { ctx, written } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let invocations: { cmd: string; args: string[] }[] = [];
    await withStubs(
      { resultJsonPath: real.resultPath, vaultPath: "/vault/fixture-vault" },
      async (stubs) => {
        await runImport(ctx);
        invocations = stubs.commandInvocations;
      },
    );
    assertEquals(
      invocations.filter((i) => i.cmd === "obsidian" && i.args[0] === "vault")
        .length,
      1,
      "getVaultPath must be called exactly once when vaultRoot is unset",
    );
    assertEquals(
      invocations.filter((i) => i.cmd === "obsidian" && i.args[0] === "create")
        .length,
      1,
      "obsidian create must be called exactly once when vaultRoot is unset",
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
  } finally {
    await real.cleanup();
  }
});

Deno.test("branch matrix: vaultRoot set -- the CLI is never invoked at all, note written directly to disk", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-08-02T00:00:00",
      text: "fs branch",
    }]),
  );
  const vaultRoot = await Deno.makeTempDir({
    prefix: "telegram-import-branch-matrix-",
  });
  try {
    const { ctx, written } = makeCtx({ ...DEFAULT_GLOBAL_ARGS, vaultRoot });
    let invocations: { cmd: string; args: string[] }[] = [];
    await withStubs(
      { resultJsonPath: real.resultPath, realMkdir: true },
      async (stubs) => {
        await runImport(ctx);
        invocations = stubs.commandInvocations;
      },
    );
    assertEquals(
      invocations.filter((i) => i.cmd === "obsidian").length,
      0,
      "no obsidian subcommand (vault OR create) may be invoked when vaultRoot is set",
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
    const stat = await Deno.stat(`${vaultRoot}/Telegram/2022-08-02-1.md`);
    assert(stat.isFile);
  } finally {
    await real.cleanup();
    await Deno.remove(vaultRoot, { recursive: true });
  }
});

Deno.test("branch matrix: vaultRoot + vault BOTH set -- vaultRoot wins, getVaultPath is never invoked", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-08-03T00:00:00",
      text: "precedence branch",
    }]),
  );
  const vaultRoot = await Deno.makeTempDir({
    prefix: "telegram-import-branch-matrix-precedence-",
  });
  try {
    const { ctx, written } = makeCtx({
      ...DEFAULT_GLOBAL_ARGS,
      vault: "some-other-vault",
      vaultRoot,
    });
    let invocations: { cmd: string; args: string[] }[] = [];
    await withStubs(
      { resultJsonPath: real.resultPath, realMkdir: true },
      async (stubs) => {
        await runImport(ctx);
        invocations = stubs.commandInvocations;
      },
    );
    assertEquals(invocations.filter((i) => i.cmd === "obsidian").length, 0);
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
  } finally {
    await real.cleanup();
    await Deno.remove(vaultRoot, { recursive: true });
  }
});
