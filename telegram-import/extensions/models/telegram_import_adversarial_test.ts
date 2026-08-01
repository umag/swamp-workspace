/**
 * Adversarial suite for @magistr/telegram-import — pins eight latent bugs
 * (LB-2..LB-9) as CHARACTERIZATION tests: each asserts telegram_import.ts's
 * CURRENT, already-shipped behavior, not a spec to satisfy. Those files are
 * still byte-frozen for LB-2..LB-9 — none of those are fixed here.
 *
 * LB-1 (HIGH path-traversal via export photo/file/video path escaping
 * extractDir) has been PROMOTED from a characterization pin to a
 * fix-regression test: telegram_import.ts's `safeCopyMedia`/
 * `isPathContained` guard (2026.08.01.1) now REJECTS any source path that
 * escapes `extractDir`, so the section below asserts the FIXED behavior
 * (rejection, an `errors[]` entry, the note still created, no escaping
 * `copyInvocation`) plus regression pins that legit relative photo/file/video
 * sources still reach `Deno.copyFile` unchanged. LB-0 (the model-upgrade-chain
 * break) is also repaired in 2026.08.01.1 — quality.yaml's ratchet is
 * restamped from UNSCORABLE to the honest score. All ten bugs (LB-0..LB-9) are
 * tracked in the LOCAL `telegram-import-latent-bugs` issue-lifecycle model —
 * never filed to the swamp.club Lab.
 *
 * LB-2's escape target is asserted ONLY against captured
 * `Deno.copyFile`/`obsidian create` argv — Deno.copyFile is always stubbed in
 * these tests, so a path-traversal payload is never actually opened against
 * a real filesystem, and no obsidian vault write ever really happens.
 *
 * LB-6 is characterized without ever reproducing an actual hang or timeout.
 * LB-8 uses a moderately long string (thousands of characters), never a
 * genuinely oversized payload — this is a characterization test, not a
 * stress/memory test.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  DEFAULT_GLOBAL_ARGS,
  makeCtx,
  runImport,
  withStubs,
  writeRealResultJson,
} from "./telegram_import_test_helpers.ts";
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
// LB-2 (MEDIUM) — note-path traversal via msg.id / msg.date
// ---------------------------------------------------------------------------

Deno.test("LB-2: a crafted string msg.id containing '../' segments propagates unsanitized into the obsidian create path= argument", async () => {
  const real = await writeRealResultJson(maliciousFixture);
  try {
    const { ctx } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let calls: { path?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const escape = calls.find((c) =>
      c.path?.includes("../../../../tmp/evil-note")
    );
    assert(
      escape,
      "noteSlug's `${date}-${msg.id}` interpolation never sanitizes msg.id — " +
        "a traversal-shaped id reaches the obsidian create path= argument verbatim",
    );
    assertEquals(
      escape!.path,
      "Telegram/2021-01-02-101/../../../../tmp/evil-note",
    );
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-3 (MEDIUM) — YAML frontmatter injection
// ---------------------------------------------------------------------------

Deno.test("LB-3: an embedded quote + YAML mapping in forwarded_from breaks out of the frontmatter block, unescaped", async () => {
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
    // The raw payload — including the closing quote, newline, and injected
    // `admin: true` key — appears VERBATIM: telegram_import.ts builds
    // frontmatter with `forwarded_from: "${msg.forwarded_from}"`, a plain
    // template interpolation with no quote-escaping or newline-stripping.
    assert(
      call!.content!.includes(
        'forwarded_from: "Attacker"\ntags:\n  - injected\nadmin: true"',
      ),
      "the injected YAML payload must appear unescaped in the rendered frontmatter",
    );
  } finally {
    await real.cleanup();
  }
});

Deno.test("LB-3: the same unescaped interpolation applies to the channel name on EVERY note in the import", async () => {
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
        call.content!.includes('channel: "Fixture Channel"\nadmin: true'),
        'channel: "${channelName}" is interpolated unescaped on every single note',
      );
    }
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-4 (MEDIUM) — one malformed message aborts the WHOLE import
// ---------------------------------------------------------------------------

Deno.test("LB-4: a message with a non-string date throws INSIDE the loop and rejects the entire import — no result summary is ever written", async () => {
  const real = await writeRealResultJson(
    payload([
      { id: 1, type: "message", date: "2022-06-01T00:00:00", text: "fine" },
      { id: 2, type: "message", date: null, text: "malformed date" },
      {
        id: 3,
        type: "message",
        date: "2022-06-03T00:00:00",
        text: "never reached",
      },
    ]),
  );
  try {
    const { ctx, written } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await assertRejects(() => runImport(ctx));
    });
    assertEquals(
      written.find((w) => w.spec === "result"),
      undefined,
      "the final result summary is only written AFTER the loop completes — " +
        "an uncaught exception mid-loop means it is never written at all",
    );
    const posts = written.filter((w) => w.spec === "post");
    assertEquals(
      posts.length,
      1,
      "message 1 (processed before the throw) already has its post " +
        "resource written; message 3 is never reached at all",
    );
    assertEquals(posts[0].payload.id, 1);
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-5 (MEDIUM) — unvalidated top-level export shape
// ---------------------------------------------------------------------------

Deno.test("LB-5a: a missing top-level `messages` array throws a raw TypeError, not a validation error", async () => {
  const real = await writeRealResultJson({ name: "No Messages Channel" });
  try {
    const { ctx } = makeCtx();
    await withStubs({ resultJsonPath: real.resultPath }, async () => {
      await assertRejects(
        () => runImport(ctx),
        TypeError,
      );
    });
  } finally {
    await real.cleanup();
  }
});

Deno.test("LB-5b: a missing top-level `name` silently renders the literal string 'undefined' into every note's channel frontmatter", async () => {
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
    const { ctx, written } = makeCtx();
    let calls: { content?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    const result = written.find((w) => w.spec === "result")!;
    assertEquals(result.payload.channel, undefined);
    assert(calls[0].content!.includes('channel: "undefined"'));
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-6 (LOW) — no subprocess timeout; `find`'s exit code is never checked
// ---------------------------------------------------------------------------

Deno.test("LB-6: a FAILING find subprocess is indistinguishable from an empty match — success/code is never inspected", async () => {
  // No real hang or timeout is reproduced here — findFails only makes the
  // stub return { success: false, stdout: "" } immediately. The bug is that
  // telegram_import.ts reads ONLY findOut.stdout and never checks
  // findOut.success/.code, so this looks identical to "find ran fine but
  // matched nothing" (both throw the same "No result.json found" message).
  const { ctx } = makeCtx();
  await withStubs({ findFails: true }, async () => {
    await assertRejects(
      () => runImport(ctx),
      Error,
      "No result.json found in zip archive",
    );
  });
});

// ---------------------------------------------------------------------------
// LB-7 (LOW) — lone surrogate produced by text.substring(0, 500)
// ---------------------------------------------------------------------------

Deno.test("LB-7: text.substring(0, 500) can cut a surrogate pair in half, leaving a lone high surrogate", async () => {
  const emoji = "\u{1F600}"; // 😀 — a surrogate pair, 2 UTF-16 code units
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
    assertEquals(truncated.length, 500);
    const lastCode = truncated.charCodeAt(499);
    assert(
      lastCode >= 0xd800 && lastCode <= 0xdbff,
      "the 500th UTF-16 code unit must be a lone (unpaired) high surrogate, " +
        `got charCode 0x${lastCode.toString(16)}`,
    );
  } finally {
    await real.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LB-8 (LOW) — unbounded JSON.parse, no size guard
// ---------------------------------------------------------------------------

Deno.test("LB-8: a long text field parses and processes with no explicit size guard anywhere in the pipeline", async () => {
  // Deliberately moderate (thousands, not millions, of characters) — this
  // characterizes the ABSENCE of a size guard, it is not a stress test.
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
// LB-9 (LOW) — command-injection CLOSED via argv arrays + residual
// leading-dash zipPath ambiguity
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

Deno.test("LB-9b: a leading-dash zipPath is passed through verbatim — a real unzip would positionally misread it as a flag (residual, LOW, distinct from injection)", async () => {
  const { ctx } = makeCtx({ ...DEFAULT_GLOBAL_ARGS, zipPath: "-l" });
  await withStubs({ findFails: false, resultJsonPath: null }, async (stubs) => {
    await assertRejects(() => runImport(ctx));
    const unzip = stubs.commandInvocations.find((i) => i.cmd === "unzip");
    assert(unzip);
    assertEquals(
      unzip!.args[1],
      "-l",
      "zipPath is never validated to not start with '-' before being placed " +
        "as unzip's second argv element (after the -o flag)",
    );
  });
});
