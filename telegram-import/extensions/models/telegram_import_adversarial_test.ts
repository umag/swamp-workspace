/**
 * Adversarial suite for @magistr/telegram-import — pins nine latent bugs
 * (LB-1..LB-9) as CHARACTERIZATION tests: each asserts telegram_import.ts's
 * CURRENT, already-shipped behavior, not a spec to satisfy. telegram_import.ts
 * is byte-frozen — none of these are fixed here. All ten (this file's nine
 * plus LB-0, the model-upgrade-chain break that drives the UNSCORABLE
 * ratchet in quality.yaml) are tracked in the LOCAL `telegram-import-latent-bugs`
 * issue-lifecycle model — never filed to the swamp.club Lab.
 *
 * LB-1/LB-2's escape targets are asserted ONLY against captured
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

function payload(messages: Record<string, unknown>[], name = "Fixture Chan") {
  return { name, type: "public_channel", id: 42, messages };
}

// ---------------------------------------------------------------------------
// LB-1 (HIGH) — path-traversal / arbitrary host-file read via export photo path
// ---------------------------------------------------------------------------

Deno.test("LB-1: msg.photo escaping extractDir is passed VERBATIM to Deno.copyFile — no path sanitization or containment check", async () => {
  const real = await writeRealResultJson(maliciousFixture);
  try {
    const { ctx } = makeCtx(DEFAULT_GLOBAL_ARGS);
    let copies: { src: string; dest: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      copies = stubs.copyInvocations;
    });
    const escape = copies.find((c) =>
      c.src.includes("../../../../etc/hostname")
    );
    assert(
      escape,
      "photo:'../../../../etc/hostname' must reach Deno.copyFile as-is — " +
        "telegram_import.ts never validates that srcFile stays inside extractDir",
    );
    assertEquals(escape!.src, `${real.dir}/../../../../etc/hostname`);
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
