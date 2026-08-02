/**
 * Adversarial suite for @magistr/telegram-import — LB-1 through LB-9 are ALL
 * now fix-regression tests: every one of the ten latent bugs tracked on the
 * LOCAL `telegram-import-latent-bugs` issue-lifecycle model (never filed to
 * the swamp.club Lab) has a real code fix in telegram_import.ts, and the
 * section below asserts the FIXED behavior, not the old bug. LB-0 (the
 * model-upgrade-chain break) was repaired in 2026.08.01.1 — quality.yaml's
 * ratchet is restamped from UNSCORABLE to the honest score.
 *
 * LB-1 (HIGH path-traversal via export photo/file/video path escaping
 * extractDir): telegram_import.ts's `safeCopyMedia`/`isPathContained` guard
 * (2026.08.01.1) REJECTS any source path that escapes `extractDir` (rejection,
 * an `errors[]` entry, the note still created, no escaping `copyInvocation`)
 * plus regression pins that legit relative photo/file/video sources still
 * reach `Deno.copyFile` unchanged.
 *
 * LB-2..LB-9 (2026.08.02.1): `assertSafeSlug` rejects a path-traversal-shaped
 * note slug before it ever reaches the obsidian `create path=` argument
 * (LB-2); `yamlDq` escapes `channel`/`forwarded_from`/`title` into a
 * single-line YAML double-quoted scalar (LB-3); the per-message loop body is
 * now wrapped in its own try/catch, so one malformed message is skipped and
 * recorded in `errors[]` instead of aborting the whole import (LB-4); the
 * top-level export shape is validated with zod before `data.name`/
 * `data.messages` are trusted (LB-5); `find` is bounded by a timeout and its
 * success/exit code is checked explicitly (LB-6); the 500-unit post-text
 * truncation now cuts by CODE POINT, never splitting a surrogate pair (LB-7);
 * an oversized `result.json` is rejected before `Deno.readTextFile`/
 * `JSON.parse` ever runs (LB-8); a leading-dash `zipPath` is normalized to a
 * `./`-relative form before reaching unzip's argv (LB-9).
 *
 * LB-2's escape target is asserted ONLY against captured
 * `Deno.copyFile`/`obsidian create` argv — Deno.copyFile is always stubbed in
 * these tests, so a path-traversal payload is never actually opened against
 * a real filesystem, and no obsidian vault write ever really happens.
 *
 * LB-6 is characterized without ever reproducing an actual hang or timeout.
 * LB-8's oversize-rejection test allocates a string just over the model's
 * internal size cap in memory — real, but still a single in-process
 * allocation, not an I/O stress test.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  DEFAULT_GLOBAL_ARGS,
  makeCtx,
  runImport,
  withStubs,
  writeRealResultJson,
} from "./telegram_import_test_helpers.ts";
import { resolveVaultPathSafe } from "./telegram_import.ts";
import maliciousFixture from "../../fixtures/malicious/result.json" with {
  type: "json",
};
import basicFixture from "../../fixtures/basic/result.json" with {
  type: "json",
};

function payload(messages: Record<string, unknown>[], name = "Fixture Chan") {
  return { name, type: "public_channel", id: 42, messages };
}

// ---------------------------------------------------------------------------
// LB-1 (HIGH, FIXED 2026.08.01.1) — path-traversal / arbitrary host-file read
// via export photo/file/video path, closed by isPathContained/safeCopyMedia
// ---------------------------------------------------------------------------

Deno.test("fix regression (telegram-import-latent-bugs LB-1, HIGH): msg.photo escaping extractDir is REJECTED — no escaping copyInvocation, an errors[] entry records it, and the note for that message is still created", async () => {
  const real = await writeRealResultJson(maliciousFixture);
  try {
    const { ctx, written } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let copies: { src: string; dest: string }[] = [];
    let creates: { path?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
      creates = stubs.obsidianCreateCalls;
    });
    const escape = copies.find((c) =>
      c.src.includes("../../../../etc/hostname")
    );
    assert(
      !escape,
      "photo:'../../../../etc/hostname' must NEVER reach Deno.copyFile — " +
        "isPathContained rejects it (post-normalization, before the copy) so safeCopyMedia never calls Deno.copyFile",
    );
    const result = written.find((w) => w.spec === "result")!;
    const errors = result.payload.errors as string[];
    assert(
      errors.some((e) =>
        e.includes("escapes extractDir") && e.includes("etc/hostname")
      ),
      "the rejection must be recorded in errors[], same shape as the pre-existing per-item copy-failure catch",
    );
    const note = creates.find((c) => c.path?.includes("2021-01-01-100"));
    assert(
      note,
      "the note for the LB-1 message (id 100) must still be created — the guard skips only the copy, not the whole message",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("fix regression (telegram-import-latent-bugs LB-1, HIGH): msg.file escaping extractDir is REJECTED at the FILE copy site too — the shared safeCopyMedia guard is not photo-only", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-05T00:00:00",
      text: "file-attachment escape probe",
      file: "../../../../etc/file-escape-pin.txt",
      mime_type: "text/plain",
    }]),
  );
  try {
    const { ctx, written } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let copies: { src: string; dest: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
    });
    assertEquals(
      copies.length,
      0,
      "the escaping file attachment must never reach Deno.copyFile — the FILE site shares safeCopyMedia with the photo site",
    );
    const result = written.find((w) => w.spec === "result")!;
    const errors = result.payload.errors as string[];
    assert(
      errors.some((e) =>
        e.includes("escapes extractDir") && e.includes("file-escape-pin.txt")
      ),
      "the rejection must be recorded in errors[]",
    );
    assertEquals(result.payload.filesCopied, 0);
  } finally {
    await real.cleanup();
  }
});

Deno.test("fix regression (telegram-import-latent-bugs LB-1, HIGH): msg.file escaping extractDir is REJECTED at the VIDEO copy site too — the shared safeCopyMedia guard is not photo-only", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-06T00:00:00",
      text: "video escape probe",
      file: "../../../../etc/video-escape-pin.mp4",
      media_type: "video_file",
    }]),
  );
  try {
    const { ctx, written } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let copies: { src: string; dest: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
    });
    assertEquals(
      copies.length,
      0,
      "the escaping video source must never reach Deno.copyFile — the VIDEO site shares safeCopyMedia with the photo site",
    );
    const result = written.find((w) => w.spec === "result")!;
    const errors = result.payload.errors as string[];
    assert(
      errors.some((e) =>
        e.includes("escapes extractDir") && e.includes("video-escape-pin.mp4")
      ),
      "the rejection must be recorded in errors[]",
    );
    assertEquals(result.payload.filesCopied, 0);
  } finally {
    await real.cleanup();
  }
});

Deno.test("fix regression (telegram-import-latent-bugs LB-1, HIGH): legit relative photo/file/video sources are unaffected by the containment guard — each still reaches Deno.copyFile byte-exact and unchanged", async () => {
  const real = await writeRealResultJson(basicFixture);
  try {
    const { ctx } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let copies: { src: string; dest: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
    });
    assertEquals(
      copies.length,
      3,
      "exactly the three legit media sources (msg id 4 photo, id 5 file, id 6 video) are copied — nothing else, nothing dropped by the guard",
    );
    assert(
      copies.some((c) => c.src === `${real.dir}/photos/photo_4@2x.jpg`),
      "the legit photo (msg id 4) must still reach Deno.copyFile, byte-exact source path",
    );
    assert(
      copies.some((c) => c.src === `${real.dir}/files/fixture_report.pdf`),
      "the legit file attachment (msg id 5) must still reach Deno.copyFile, byte-exact source path",
    );
    assert(
      copies.some((c) => c.src === `${real.dir}/video_files/fixture_clip.mp4`),
      "the legit video (msg id 6) must still reach Deno.copyFile, byte-exact source path",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("containment guard: an absolute-looking msg.photo (e.g. '/etc/...') stays incidentally contained — string-concatenated onto extractDir, not resolved as a real filesystem root — so it still reaches Deno.copyFile (pinned per review-security LOW finding)", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-01T00:00:00",
      text: "absolute-looking photo path",
      photo: "/etc/absolute-path-pin.jpg",
    }]),
  );
  try {
    const { ctx } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let copies: { src: string; dest: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
    });
    assertEquals(
      copies.length,
      1,
      "the absolute-looking path is still treated as contained: extractDir + '/' + msg.photo normalizes to a path INSIDE extractDir",
    );
    assertEquals(copies[0].src, `${real.dir}//etc/absolute-path-pin.jpg`);
  } finally {
    await real.cleanup();
  }
});

Deno.test("containment guard: a sibling directory that merely shares extractDir as a bare string prefix is REJECTED, not naively accepted (pins the trailing-separator fix from review-security's sibling-prefix false-accept finding)", async () => {
  // Allocate a real temp dir via the harness, then overwrite its result.json
  // with a payload whose photo path references "<basename>-evil" — a sibling
  // directory one level up whose name starts with extractDir's own basename.
  // A naive `candidate.startsWith(base)` (no trailing separator) would wrongly
  // accept this; isPathContained's `${normalizedBase}/` requirement rejects it.
  const real = await writeRealResultJson(payload([]));
  try {
    const siblingName = `${real.dir.split("/").pop()}-evil`;
    const maliciousPayload = payload([{
      id: 1,
      type: "message",
      date: "2022-07-04T00:00:00",
      text: "sibling-prefix false-accept probe",
      photo: `../${siblingName}/sibling.jpg`,
    }]);
    await Deno.writeTextFile(real.resultPath, JSON.stringify(maliciousPayload));

    const { ctx, written } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let copies: { src: string; dest: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
    });
    assertEquals(
      copies.length,
      0,
      "a sibling directory sharing extractDir as a bare string prefix (with no trailing separator) must be rejected — a naive startsWith(extractDir) without the trailing-separator requirement would wrongly accept it",
    );
    const result = written.find((w) => w.spec === "result")!;
    const errors = result.payload.errors as string[];
    assert(
      errors.some((e) => e.includes("escapes extractDir")),
      "the sibling-prefix escape must be recorded in errors[]",
    );
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-2 (MEDIUM, FIXED 2026.08.02.1) — note-path traversal via msg.id
// ---------------------------------------------------------------------------

Deno.test("fix regression (telegram-import-latent-bugs LB-2, MEDIUM): a crafted string msg.id containing '../' segments is REJECTED before it ever reaches the obsidian create path= argument", async () => {
  const real = await writeRealResultJson(maliciousFixture);
  try {
    const { ctx, written } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let calls: { path?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const escape = calls.find((c) =>
      c.path?.includes("../../../../tmp/evil-note")
    );
    assert(
      !escape,
      "assertSafeSlug must reject a slug containing a '/' segment before " +
        "any obsidian create call is ever made — the traversal must never " +
        "reach the create path= argument",
    );
    const result = written.find((w) => w.spec === "result")!;
    const errors = result.payload.errors as string[];
    assert(
      errors.some((e) =>
        e.includes("Unsafe note slug") &&
        e.includes("101/../../../../tmp/evil-note")
      ),
      "the rejection must be recorded in errors[], same shape as the pre-existing per-item create-failure catch",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("LB-2 non-vacuity: a normal numeric-id slug still reaches obsidian create path= unchanged -- assertSafeSlug does not reject legitimate slugs", async () => {
  const real = await writeRealResultJson(basicFixture);
  try {
    const { ctx } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let calls: { path?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    assert(
      calls.some((c) => c.path === "Telegram/2020-09-15-2"),
      "a normal numeric-id slug must still reach obsidian create path= exactly as before the LB-2 fix",
    );
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-3 (MEDIUM, FIXED 2026.08.02.1) — YAML frontmatter injection
// ---------------------------------------------------------------------------

Deno.test("fix regression (telegram-import-latent-bugs LB-3, MEDIUM): an embedded quote + YAML mapping in forwarded_from is escaped into a single-line double-quoted scalar -- it no longer breaks out of the frontmatter block", async () => {
  const real = await writeRealResultJson(maliciousFixture);
  try {
    const { ctx } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let calls: { path?: string; content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const call = calls.find((c) => c.path?.includes("2021-01-03-102"));
    assert(call, "the LB-3 fixture message must produce a note");
    assert(
      !call!.content!.includes(
        'forwarded_from: "Attacker"\ntags:\n  - injected\nadmin: true"',
      ),
      "the raw, unescaped breakout must no longer appear",
    );
    // yamlDq escapes the embedded quote and both newlines into a single YAML
    // line: the closing `"` and the `admin: true` key are now inert text
    // inside the forwarded_from scalar, not live YAML.
    assert(
      call!.content!.includes(
        'forwarded_from: "Attacker\\"\\ntags:\\n  - injected\\nadmin: true"',
      ),
      "the injected payload must appear escaped, on a single YAML line",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("fix regression (telegram-import-latent-bugs LB-3, MEDIUM): the same escaping applies to the channel name on EVERY note in the import", async () => {
  const real = await writeRealResultJson(maliciousFixture);
  try {
    const { ctx } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let calls: { content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    assert(calls.length > 0);
    for (const call of calls) {
      assert(
        !call.content!.includes('channel: "Fixture Channel"\nadmin: true'),
        "the raw, unescaped breakout must no longer appear",
      );
      assert(
        call.content!.includes(
          'channel: "Fixture Channel\\"\\nadmin: true\\ndescription: \\"pwned"',
        ),
        "channelName must be escaped into a single-line YAML scalar on every note",
      );
    }
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-4 (MEDIUM, FIXED 2026.08.02.1) — one malformed message no longer aborts
// the whole import
// ---------------------------------------------------------------------------

Deno.test("fix regression (telegram-import-latent-bugs LB-4, MEDIUM): a message with a non-string date is SKIPPED, recorded in errors[], and the import still resolves with the remaining messages processed", async () => {
  const real = await writeRealResultJson(
    payload([
      { id: 1, type: "message", date: "2022-06-01T00:00:00", text: "fine" },
      { id: 2, type: "message", date: null, text: "malformed date" },
      {
        id: 3,
        type: "message",
        date: "2022-06-03T00:00:00",
        text: "now reached",
      },
    ]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const result = written.find((w) => w.spec === "result");
    assert(
      result,
      "the result summary must be written even though message 2 failed -- " +
        "the per-message try/catch means the loop never throws uncaught",
    );
    assertEquals(
      result!.payload.totalMessages,
      3,
      "all 3 messages are still counted — one failure does not zero the import",
    );
    assertEquals(
      result!.payload.notesCreated,
      2,
      "messages 1 and 3 both get notes; message 2 is skipped",
    );
    const errors = result!.payload.errors as string[];
    assertEquals(errors.length, 1);
    assert(errors[0].startsWith("Skipped message (id 2):"));
    const posts = written.filter((w) => w.spec === "post");
    assertEquals(
      posts.length,
      2,
      "message 1 (processed before the throw) and message 3 (now reached, " +
        "since message 2's failure no longer aborts the loop) both have " +
        "their post resource written",
    );
    assertEquals(
      posts.map((p) => p.payload.id).sort((a, b) =>
        (a as number) - (b as number)
      ),
      [1, 3],
    );
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-5 (MEDIUM, FIXED 2026.08.02.1) — top-level export shape now validated
// ---------------------------------------------------------------------------

Deno.test("fix regression (telegram-import-latent-bugs LB-5a, MEDIUM): a missing top-level `messages` array now throws a CLEAR validation error, not a raw TypeError", async () => {
  const real = await writeRealResultJson({ name: "No Messages Channel" });
  try {
    const { ctx } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      const err = await assertRejects(() => runImport(ctx), Error);
      assert(
        !(err instanceof TypeError),
        "must be a clear validation Error, not the raw TypeError this bug used to throw",
      );
      assert(
        err.message.includes("Invalid Telegram export"),
        `expected a clear validation message, got: ${err.message}`,
      );
    });
  } finally {
    await real.cleanup();
  }
});

Deno.test("fix regression (telegram-import-latent-bugs LB-5b, MEDIUM): a missing top-level `name` now throws a CLEAR validation error instead of silently rendering the literal string 'undefined' into every note", async () => {
  // payload() above always sets a name — build the raw object directly here
  // so `name` is genuinely absent from the top-level shape.
  const real = await writeRealResultJson({
    type: "public_channel",
    id: 42,
    messages: [{
      id: 1,
      type: "message",
      date: "2022-06-05T00:00:00",
      text: "x",
    }],
  });
  try {
    const { ctx } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      const err = await assertRejects(() => runImport(ctx), Error);
      assert(
        err.message.includes("Invalid Telegram export"),
        `expected a clear validation message, got: ${err.message}`,
      );
    });
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-6 (LOW, FIXED 2026.08.02.1) — `find` is bounded by a timeout, and its
// exit code is now checked explicitly
// ---------------------------------------------------------------------------

Deno.test("fix regression (telegram-import-latent-bugs LB-6, LOW): a FAILING find subprocess now throws a DISTINCT 'find failed' message -- no longer indistinguishable from an empty match", async () => {
  // No real hang or timeout is reproduced here — findFails only makes the
  // stub return { success: false, code: 1, stdout: "" } immediately.
  // telegram_import.ts now checks findOut.success/.code explicitly BEFORE
  // reading stdout, so a failing find surfaces its own distinct message
  // instead of the generic "No result.json found" an empty-but-successful
  // find would produce.
  const { ctx } = makeCtx();
  await withStubs({ findFails: true }, async () => {
    await assertRejects(
      () => runImport(ctx),
      Error,
      "find failed (exit 1)",
    );
  });
});

Deno.test("LB-6 non-vacuity: an empty-but-SUCCESSFUL find still throws the original 'No result.json found' message -- the two failure modes stay distinct", async () => {
  const { ctx } = makeCtx();
  await withStubs({ findFails: false, resultJsonPath: null }, async () => {
    await assertRejects(
      () => runImport(ctx),
      Error,
      "No result.json found in zip archive",
    );
  });
});

// ---------------------------------------------------------------------------
// LB-7 (LOW, FIXED 2026.08.02.1) — truncation is now by CODE POINT, never
// splitting a surrogate pair
// ---------------------------------------------------------------------------

Deno.test("fix regression (telegram-import-latent-bugs LB-7, LOW): a 500-code-point truncation keeps a surrogate pair intact -- no lone high surrogate is ever produced", async () => {
  const emoji = "\u{1F600}"; // 😀 — a surrogate pair, 2 UTF-16 code units, 1 code point
  const text = "a".repeat(499) + emoji + "b".repeat(20);
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-06-06T00:00:00",
      text,
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const post = written.find((w) => w.spec === "post")!;
    const truncated = post.payload.text as string;
    assertEquals(
      Array.from(truncated).length,
      500,
      "truncation is now by CODE POINT, not raw UTF-16 code unit",
    );
    assert(
      truncated.endsWith(emoji),
      "the emoji at the truncation boundary must survive intact, as its own code point",
    );
    for (let i = 0; i < truncated.length; i++) {
      const code = truncated.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = truncated.charCodeAt(i + 1);
        assert(
          next >= 0xdc00 && next <= 0xdfff,
          `lone high surrogate found at index ${i} -- every high surrogate must be paired`,
        );
      }
    }
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-8 (LOW, FIXED 2026.08.02.1) — result.json is now size-guarded before
// Deno.readTextFile/JSON.parse ever runs
// ---------------------------------------------------------------------------

Deno.test("fix regression (telegram-import-latent-bugs LB-8, LOW): a result.json larger than the model's internal size cap is REJECTED before Deno.readTextFile/JSON.parse ever runs", async () => {
  // The model's internal MAX_RESULT_JSON_BYTES cap is 50 MB (not exported --
  // this suite deliberately allocates comfortably over it, 60 MB, rather
  // than depending on the exact constant).
  const oversized = "x".repeat(60_000_000);
  const real = await writeRealResultJson(null, { rawJson: oversized });
  try {
    const { ctx } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await assertRejects(
        () => runImport(ctx),
        Error,
        "too large to import",
      );
    });
  } finally {
    await real.cleanup();
  }
});

Deno.test("LB-8 non-vacuity: a long text field WELL UNDER the size cap still parses and processes normally -- the guard does not reject legitimate large exports", async () => {
  // Deliberately moderate (thousands, not millions, of characters, well
  // under MAX_RESULT_JSON_BYTES) — this pins that the LB-8 size guard does
  // NOT reject ordinary large-ish messages, only genuinely oversized files.
  const longText = "x".repeat(20_000);
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-06-07T00:00:00",
      text: longText,
    }]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await runImport(ctx);
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
    assertEquals(result.payload.errors, []);
    const post = written.find((w) => w.spec === "post")!;
    assertEquals(
      (post.payload.text as string).length,
      500,
      "still truncated at 500 for the post record",
    );
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-9 (LOW, 9b FIXED 2026.08.02.1) — command-injection CLOSED via argv
// arrays (9a), leading-dash zipPath now normalized (9b)
// ---------------------------------------------------------------------------

Deno.test("LB-9a: command-injection is CLOSED — a shell-metacharacter zipPath reaches unzip as ONE untouched argv element", async () => {
  const hostile = "; rm -rf / #$(evil)`backtick`";
  const { ctx } = makeCtx({ ...DEFAULT_GLOBAL_ARGS, zipPath: hostile });
  await withStubs({ findFails: false, resultJsonPath: null }, async (stubs) => {
    await assertRejects(() => runImport(ctx));
    const unzip = stubs.commandInvocations.find((i) => i.cmd === "unzip");
    assert(unzip, "unzip must have been invoked");
    assertEquals(
      unzip!.args,
      ["-o", hostile, "-d", "/fake-tmp/telegram-import-test"],
      "the hostile string is passed as a single argv array element — " +
        "there is no shell involved, so no metacharacter is ever interpreted",
    );
  });
});

Deno.test("fix regression (telegram-import-latent-bugs LB-9b, LOW): a leading-dash zipPath is normalized to './-l' before reaching unzip's argv, closing the positional-misread residual", async () => {
  const { ctx } = makeCtx({ ...DEFAULT_GLOBAL_ARGS, zipPath: "-l" });
  await withStubs({ findFails: false, resultJsonPath: null }, async (stubs) => {
    await assertRejects(() => runImport(ctx));
    const unzip = stubs.commandInvocations.find((i) => i.cmd === "unzip");
    assert(unzip);
    assertEquals(
      unzip!.args[1],
      "./-l",
      "a leading-dash zipPath must be normalized to './-l' before being " +
        "placed as unzip's second argv element (after the -o flag) -- a " +
        "real unzip would otherwise positionally misread it as a flag",
    );
  });
});

// ---------------------------------------------------------------------------
// path confinement (vaultRoot note-write destination, swamp-workspace #57) --
// resolveVaultPathSafe, copied verbatim from
// obsidian-vault/extensions/models/obsidian_vault.ts (PR #56). Unrelated to
// isPathContained/safeCopyMedia's extractDir confinement (LB-1) above: this
// section is about where the NOTE lands, not where media is copied FROM.
// ---------------------------------------------------------------------------

Deno.test("path confinement: a '../'-relative note path is rejected via resolveVaultPathSafe -- recorded in errors[], the run continues to the next message", async () => {
  // sandboxRoot/vault pattern: the mkdir for attachDiskPath is NOT confined
  // (scope is the note write only, per the approved plan), so a malicious
  // `folder` global argument can still make Deno.mkdir create an
  // "escaped/attachments" sibling directory for real. Nesting vaultRoot
  // inside its own sandboxRoot means removing sandboxRoot cleans up that
  // side effect too, instead of leaking it next to the OS temp root.
  const sandboxRoot = await Deno.makeTempDir({
    prefix: "telegram-import-confinement-sandbox-",
  });
  const vaultRoot = `${sandboxRoot}/vault`;
  await Deno.mkdir(vaultRoot, { recursive: true });
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-10T00:00:00",
      text: "traversal probe",
    }]),
  );
  try {
    // folder is a global argument, not per-message -- craft it to traverse.
    const { ctx, written } = makeCtx({
      ...DEFAULT_GLOBAL_ARGS,
      folder: "../escaped",
      vaultRoot,
    });
    await withStubs(
      { resultJsonPath: real.resultPath, realMkdir: true },
      async () => {
        await runImport(ctx);
      },
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 0);
    const errors = result.payload.errors as string[];
    assert(
      errors.some((e) => e.includes("Path escapes vault root")),
      "the traversal must be rejected and recorded in errors[], not silently escape",
    );
    await assertRejects(
      () => Deno.stat(`${sandboxRoot}/escaped/2022-07-10-1.md`),
      "no note may land outside the vault directory",
    );
  } finally {
    await real.cleanup();
    await Deno.remove(sandboxRoot, { recursive: true });
  }
});

Deno.test("path confinement: a symlinked 'folder' path segment is refused via realpath, not silently followed", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-11T00:00:00",
      text: "symlink probe",
    }]),
  );
  const vaultRoot = await Deno.makeTempDir({
    prefix: "telegram-import-symlink-vault-",
  });
  const outside = await Deno.makeTempDir({
    prefix: "telegram-import-symlink-outside-",
  });
  try {
    await Deno.symlink(outside, `${vaultRoot}/Telegram`);
    const { ctx, written } = makeCtx({ ...DEFAULT_GLOBAL_ARGS, vaultRoot });
    await withStubs(
      { resultJsonPath: real.resultPath, realMkdir: true },
      async () => {
        await runImport(ctx);
      },
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 0);
    const errors = result.payload.errors as string[];
    assert(errors.some((e) => e.includes("symlink")));
    await assertRejects(
      () => Deno.stat(`${outside}/2022-07-11-1.md`),
      "no note may be written through the symlinked folder",
    );
  } finally {
    await real.cleanup();
    await Deno.remove(outside, { recursive: true });
    await Deno.remove(vaultRoot, { recursive: true });
  }
});

Deno.test("path confinement: resolveVaultPathSafe's realRoot is the symlink-resolved root, not the raw configured vaultRoot string (macOS temp dirs resolve /var -> /private/var)", async () => {
  const vaultRoot = await Deno.makeTempDir({
    prefix: "telegram-import-realroot-",
  });
  try {
    const target = await resolveVaultPathSafe(
      { vaultRoot },
      "Telegram/note.md",
    );
    const expectedRealRoot = await Deno.realPath(vaultRoot);
    assertEquals(
      target.realRoot,
      expectedRealRoot,
      "containment must be computed against the REAL (symlink-resolved) root, not the raw vaultRoot prefix",
    );
    assertEquals(target.absolutePath, `${expectedRealRoot}/Telegram/note.md`);
  } finally {
    await Deno.remove(vaultRoot, { recursive: true });
  }
});

// covered-negative: import only ever writes into a caller-named folder --
// it never walks the vault, so there is no dot-dir/.trash EXCLUSION rule to
// have (unlike obsidian-vault's list/digest, which do walk and must skip
// hidden directories).
Deno.test("covered-negative: dot-dir/.trash exclusion is N/A -- import never walks the vault, it only writes into the caller-named folder", async () => {
  const real = await writeRealResultJson(
    payload([{
      id: 1,
      type: "message",
      date: "2022-07-12T00:00:00",
      text: "dot-dir probe",
    }]),
  );
  const vaultRoot = await Deno.makeTempDir({
    prefix: "telegram-import-dotdir-",
  });
  try {
    const { ctx, written } = makeCtx({
      ...DEFAULT_GLOBAL_ARGS,
      folder: ".trash",
      vaultRoot,
    });
    await withStubs(
      { resultJsonPath: real.resultPath, realMkdir: true },
      async () => {
        await runImport(ctx);
      },
    );
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.notesCreated, 1);
    const stat = await Deno.stat(`${vaultRoot}/.trash/2022-07-12-1.md`);
    assert(stat.isFile);
  } finally {
    await real.cleanup();
    await Deno.remove(vaultRoot, { recursive: true });
  }
});
