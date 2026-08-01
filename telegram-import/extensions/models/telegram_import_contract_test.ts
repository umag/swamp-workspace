/**
 * Contract-fixture suite for @magistr/telegram-import.
 *
 * telegram_import.ts was BYTE-FROZEN by ext-quality-bf-telegram-import at
 * authorship time; 2026.08.01.1 (the LB-1 path-containment guard fix + LB-0
 * upgrade-chain repair) is the first production change since then, so
 * `model.version` below now tracks that release rather than a frozen
 * constant. This suite still pins two things:
 *
 *  (a) the STATIC contract: model type/version, the GlobalArgsSchema shape
 *      (required fields + defaults), and the exact method list; and
 *  (b) a GOLDEN pipeline run over fixtures/basic/result.json under
 *      `@std/testing`'s FakeTime, asserting the exact `result` summary and
 *      the exact rendered Markdown for one note (message id 2 — the
 *      simplest case: plain text, no photo/file/forwarded/reply). Message id
 *      2 has no photo/file, so it is unaffected by the LB-1 guard.
 *
 * Every subprocess (unzip/find/obsidian) and every filesystem mutation
 * (copyFile/mkdir/makeTempDir/remove) is stubbed via
 * telegram_import_test_helpers.ts. The only real disk I/O in this file is
 * writing fixtures/basic/result.json's content into a harness-owned scratch
 * file so the model's own (never-stubbed) `Deno.readTextFile` has something
 * real to read.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./telegram_import.ts";
import {
  DEFAULT_GLOBAL_ARGS,
  makeCtx,
  runImport,
  withStubs,
  writeRealResultJson,
} from "./telegram_import_test_helpers.ts";
import basicFixture from "../../fixtures/basic/result.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// (a) Static contract
// ---------------------------------------------------------------------------

Deno.test("contract: model type is unchanged; version tracks the 2026.08.01.1 LB-1/LB-0 fix release", () => {
  assertEquals(model.type, "@magistr/telegram/import");
  assertEquals(model.version, "2026.08.01.1");
});

Deno.test("contract: exposes exactly one method — import", () => {
  assertEquals(Object.keys(model.methods), ["import"]);
});

Deno.test("contract: GlobalArgsSchema requires zipPath + vault, defaults folder/attachmentsFolder", () => {
  const parsed = model.globalArguments.parse({
    zipPath: "/exports/x.zip",
    vault: "my-vault",
  }) as Record<string, unknown>;
  assertEquals(parsed.zipPath, "/exports/x.zip");
  assertEquals(parsed.vault, "my-vault");
  assertEquals(parsed.folder, "Telegram");
  assertEquals(parsed.attachmentsFolder, "attachments");
});

Deno.test("contract: GlobalArgsSchema rejects a missing zipPath/vault", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("contract: import method's arguments schema accepts an empty object", () => {
  const importMethod = model.methods.import;
  const parsed = importMethod.arguments.parse({});
  assertEquals(parsed, {});
});

// ---------------------------------------------------------------------------
// (b) Golden pipeline run — fixtures/basic/result.json
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2024-01-01T00:00:00.000Z");

Deno.test("golden: basic/result.json produces the exact summary + one exact note", async () => {
  const time = new FakeTime(FIXED_NOW);
  const real = await writeRealResultJson(basicFixture);
  try {
    const { ctx, written } = makeCtx(DEFAULT_GLOBAL_ARGS);
    await withStubs(
      { vaultPath: "/vault/fixture-vault", resultJsonPath: real.resultPath },
      async () => {
        await runImport(ctx);
      },
    );

    const result = written.find((w) =>
      w.spec === "result" && w.name === "main"
    );
    assert(result, "must write a `result` resource named 'main'");
    assertEquals(result!.payload.channel, "Fixture Broadcast");
    assertEquals(
      result!.payload.totalMessages,
      7,
      "8 entries in the fixture, 1 is a filtered-out service message",
    );
    assertEquals(result!.payload.notesCreated, 7);
    assertEquals(result!.payload.imagesCopied, 1, "only message 4 has a photo");
    assertEquals(
      result!.payload.filesCopied,
      2,
      "message 5 (pdf file) + message 6 (video, also counted as filesCopied)",
    );
    assertEquals(result!.payload.errors, []);
    assertEquals(result!.payload.timestamp, FIXED_NOW.toISOString());

    const posts = written.filter((w) => w.spec === "post");
    assertEquals(posts.length, 7);

    const post2 = posts.find((p) => p.payload.id === 2);
    assert(post2, "post for message id 2 must exist");
    assertEquals(post2!.payload.date, "2020-09-15T10:00:00");
    assertEquals(post2!.payload.text, "Hello from the fixture channel.");
    assertEquals(post2!.payload.photo, undefined);
    assertEquals(post2!.payload.forwardedFrom, undefined);
    assertEquals(post2!.payload.replyTo, undefined);
    assertEquals(post2!.payload.timestamp, FIXED_NOW.toISOString());
  } finally {
    time.restore();
    await real.cleanup();
  }
});

Deno.test("golden: message id 2's rendered note is byte-exact", async () => {
  const time = new FakeTime(FIXED_NOW);
  const real = await writeRealResultJson(basicFixture);
  try {
    const { ctx } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let createCalls: { path?: string; name?: string; content?: string }[] = [];
    await withStubs(
      { resultJsonPath: real.resultPath },
      async (stubs) => {
        await runImport(ctx);
        createCalls = stubs.obsidianCreateCalls;
      },
    );

    const call = createCalls.find((c) => c.path === "Telegram/2020-09-15-2");
    assert(call, "obsidian create for message id 2 must have been captured");
    const expected = [
      "---",
      'title: "Post 2"',
      "date: 2020-09-15T10:00:00",
      "source: telegram",
      'channel: "Fixture Broadcast"',
      "telegram_id: 2",
      "tags:",
      "  - telegram",
      "---",
      "",
    ].join("\n") + ["Hello from the fixture channel.", ""].join("\n");
    assertEquals(call!.content, expected);
  } finally {
    time.restore();
    await real.cleanup();
  }
});
