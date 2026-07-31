/**
 * Methods suite for @magistr/telegram-import — branch-by-branch coverage of
 * the single `import` method, driven through `model.methods.import.execute()`
 * against the shared stub seam (telegram_import_test_helpers.ts). Every
 * scenario here is an ad-hoc, minimal `result.json` payload written to a
 * harness-owned scratch file — not one of the three committed fixtures
 * (those back the contract-fixture golden run and the adversarial LB pins).
 *
 * telegram_import.ts is UNMODIFIED — every test characterizes already-shipped
 * behavior.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_GLOBAL_ARGS,
  makeCtx,
  runImport,
  withStubs,
  writeRealResultJson,
} from "./telegram_import_test_helpers.ts";

function payload(messages: Record<string, unknown>[], name = "Fixture Chan") {
  return { name, type: "public_channel", id: 42, messages };
}

// ---------------------------------------------------------------------------
// service-message filter
// ---------------------------------------------------------------------------

Deno.test("import: service-type messages are filtered out before processing", async () => {
  const real = await writeRealResultJson(
    payload([
      { id: 1, type: "service", date: "2022-01-01T00:00:00", action: "x" },
      { id: 2, type: "message", date: "2022-01-01T00:00:00", text: "hi" },
    ]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.totalMessages, 1);
    assertEquals(written.filter((w) => w.spec === "post").length, 1);
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// photo / file / _thumb / video branches
// ---------------------------------------------------------------------------

Deno.test("import: photo is copied and embedded as a wikilink; post.photo is the basename", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-02-01T00:00:00",
      text: "a photo",
      photo: "photos/pic_1@2x.jpg",
    }]),
  );
  try {
    const { ctx, written } = makeCtx({
      ...DEFAULT_GLOBAL_ARGS,
      folder: "Telegram",
      attachmentsFolder: "attachments",
    });
    let calls: { path?: string; content?: string }[] = [];
    let copies: { src: string; dest: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
      copies = stubs.copyInvocations;
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.imagesCopied, 1);
    assertEquals(result.payload.filesCopied, 0);
    assertEquals(copies.length, 1);
    assertEquals(copies[0].src, `${real.dir}/photos/pic_1@2x.jpg`);
    assertEquals(
      copies[0].dest,
      "/vault/fixture-vault/Telegram/attachments/pic_1@2x.jpg",
    );
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.photo, "pic_1@2x.jpg");
    const call = calls.find((c) => c.path?.includes("2022-02-01-1"));
    assert(call?.content?.includes("![[Telegram/attachments/pic_1@2x.jpg]]"));
  } finally {
    await real.cleanup();
  }
});

Deno.test("import: a non-thumb, non-video file attachment is copied and embedded, counted in filesCopied", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-02-02T00:00:00",
      text: "a doc",
      file: "files/report.pdf",
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    let calls: { path?: string; content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.filesCopied, 1);
    assertEquals(result.payload.imagesCopied, 0);
    const call = calls.find((c) => c.path?.includes("2022-02-02-1"));
    assert(call?.content?.includes("![[Telegram/attachments/report.pdf]]"));
  } finally {
    await real.cleanup();
  }
});

Deno.test("import: a file ending in _thumb.jpg is silently skipped — no copy, no embed, no error", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-02-03T00:00:00",
      text: "thumb only",
      file: "video_files/clip_thumb.jpg",
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    let copies: { src: string; dest: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.filesCopied, 0);
    assertEquals(result.payload.errors, []);
    assertEquals(
      copies.length,
      0,
      "a _thumb.jpg file must never reach Deno.copyFile",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("import: media_type video_file + file is copied and embedded, counted in filesCopied (shares the counter with plain files)", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-02-04T00:00:00",
      text: "a clip",
      file: "video_files/clip.mp4",
      media_type: "video_file",
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    let calls: { path?: string; content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(
      result.payload.filesCopied,
      1,
      "video copies increment the SAME filesCopied counter as plain file attachments",
    );
    const call = calls.find((c) => c.path?.includes("2022-02-04-1"));
    assert(call?.content?.includes("![[Telegram/attachments/clip.mp4]]"));
  } finally {
    await real.cleanup();
  }
});

Deno.test("import: media_type video_file with NO file field triggers no copy at all", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-02-05T00:00:00",
      text: "video with no file",
      media_type: "video_file",
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    let copies: { src: string; dest: string }[] = [];
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

// ---------------------------------------------------------------------------
// forwarded_from / reply_to_message_id frontmatter + body
// ---------------------------------------------------------------------------

Deno.test("import: forwarded_from adds BOTH a frontmatter line and a body blockquote", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-03-01T00:00:00",
      text: "reposted text",
      forwarded_from: "Origin Channel",
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    let calls: { path?: string; content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.forwardedFrom, "Origin Channel");
    const call = calls[0];
    assert(call.content?.includes('forwarded_from: "Origin Channel"'));
    assert(call.content?.includes("> Forwarded from **Origin Channel**"));
  } finally {
    await real.cleanup();
  }
});

Deno.test("import: reply_to_message_id adds a frontmatter line only (no body change)", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-03-02T00:00:00",
      text: "a reply",
      reply_to_message_id: 999,
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    let calls: { path?: string; content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(post.payload.replyTo, 999);
    const call = calls[0];
    assert(call.content?.includes("reply_to: 999"));
    assert(!call.content?.includes("Forwarded from"));
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// obsidian create argv shape
// ---------------------------------------------------------------------------

Deno.test("import: obsidian create is invoked with vault=/path=/content=/overwrite, in that order after the subcommand", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-04-01T00:00:00",
      text: "x",
    }]),
  );
  try {
    const { ctx } = makeCtx({ ...DEFAULT_GLOBAL_ARGS, vault: "my-vault" });
    let invocations: { cmd: string; args: string[] }[] = [];
    await withStubs(
      { resultJsonPath: real.resultPath, vaultPath: "/vault/my-vault" },
      async (stubs) => {
        await runImport(ctx);
        invocations = stubs.commandInvocations;
      },
    );
    const create = invocations.find((i) =>
      i.cmd === "obsidian" && i.args[0] === "create"
    );
    assert(create, "an obsidian create invocation must exist");
    assertEquals(create!.args[1], "vault=my-vault");
    assertEquals(create!.args[2], "path=Telegram/2022-04-01-1");
    assert(create!.args[3]!.startsWith("content=---"));
    assertEquals(create!.args[4], "overwrite");
  } finally {
    await real.cleanup();
  }
});

Deno.test("import: obsidian create ALWAYS uses the path= key, never name= — folder/slug are joined with a literal '/'", async () => {
  // notePath is built as `${folder}/${slug}` — the template literal always
  // inserts a literal "/" between folder and slug, for ANY folder value
  // (including an empty string), so `notePath.includes("/")` is always
  // true and the `name` branch of `noteKey` is unreachable in practice.
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-04-02T00:00:00",
      text: "x",
    }]),
  );
  try {
    const { ctx } = makeCtx({ ...DEFAULT_GLOBAL_ARGS, folder: "" });
    let calls: { path?: string; name?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].name, undefined);
    assertEquals(calls[0].path, "/2022-04-02-1");
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// errors[] accumulation (soft failures: copy/create) — contrasts with the
// hard-abort characterized in telegram_import_adversarial_test.ts (LB-4)
// ---------------------------------------------------------------------------

Deno.test("import: a failed photo copy is recorded in errors[] and processing continues to the next message", async () => {
  const real = await writeRealResultJson(
    payload([
      {
        id: 1,
        type: "message",
        date: "2022-05-01T00:00:00",
        text: "bad photo",
        photo: "photos/missing.jpg",
      },
      { id: 2, type: "message", date: "2022-05-02T00:00:00", text: "fine" },
    ]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs(
      {
        resultJsonPath: real.resultPath,
        copyFileFails: (inv) => inv.src.endsWith("missing.jpg"),
      },
      async () => {
        await runImport(ctx);
      },
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.imagesCopied, 0);
    assertEquals(
      result.payload.notesCreated,
      2,
      "both notes are still created",
    );
    const errors = result.payload.errors as string[];
    assertEquals(errors.length, 1);
    assert(errors[0].includes("missing.jpg"));
    assert(errors[0].startsWith("Failed to copy image"));
  } finally {
    await real.cleanup();
  }
});

Deno.test("import: a failed obsidian create is recorded in errors[] without stopping the run", async () => {
  const real = await writeRealResultJson(
    payload([
      {
        id: 1,
        type: "message",
        date: "2022-05-03T00:00:00",
        text: "will fail",
      },
      {
        id: 2,
        type: "message",
        date: "2022-05-04T00:00:00",
        text: "will pass",
      },
    ]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs(
      {
        resultJsonPath: real.resultPath,
        obsidianCreateFails: (call) => call.path === "Telegram/2022-05-03-1",
      },
      async () => {
        await runImport(ctx);
      },
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
    const errors = result.payload.errors as string[];
    assertEquals(errors.length, 1);
    assert(errors[0].startsWith("Failed to create note Telegram/2022-05-03-1"));
    // The post resource is STILL written even though note creation failed —
    // writeResource("post", ...) runs unconditionally after the create
    // try/catch, independent of whether the note itself was created.
    assertEquals(written.filter((w) => w.spec === "post").length, 2);
  } finally {
    await real.cleanup();
  }
});

Deno.test("import: errors[] accumulates independent failures across photo, file, and create in the same run", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-05-05T00:00:00",
      text: "triple failure",
      photo: "photos/bad.jpg",
      file: "files/bad.pdf",
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs(
      {
        resultJsonPath: real.resultPath,
        copyFileFails: () => true,
        obsidianCreateFails: true,
      },
      async () => {
        await runImport(ctx);
      },
    );
    const result = written.find((w) => w.spec === "result")!;
    const errors = result.payload.errors as string[];
    assertEquals(
      errors.length,
      3,
      "photo + file + create each contribute one error",
    );
    assertEquals(result.payload.notesCreated, 0);
    assertEquals(result.payload.imagesCopied, 0);
    assertEquals(result.payload.filesCopied, 0);
  } finally {
    await real.cleanup();
  }
});
