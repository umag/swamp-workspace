// Methods suite: every model method's success and failure paths, with the
// claude CLI replaced by a scripted fake.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { ChatStore } from "./lib/store.ts";
import {
  fakeClaude,
  fakeContext,
  filler,
  shortLines,
  tempChat,
} from "./lib/testing.ts";
import { model } from "./optchat.ts";

const m = model.methods;

Deno.test("status: an empty chat", async () => {
  const dir = await tempChat();
  const { context, written } = fakeContext({ chatDir: dir });
  await m.status.execute({}, context);
  assertEquals(written[0].spec, "status");
  assertEquals(written[0].data.messages, 0);
  assertEquals(written[0].data.viewBytes, 0);
});

Deno.test("append: logs a note and builds its leaf without a call", async () => {
  const dir = await tempChat();
  const { context, written } = fakeContext({ chatDir: dir });
  await m.append.execute({ text: "cat is Bors" }, context);
  assertEquals(written[0].data.kind, "note");
  assertEquals(written[0].data.messageIds, [0]);
  const store = await ChatStore.open(dir);
  assertEquals(store.nodeText(0, 0), "note: cat is Bors");
});

Deno.test("append: rejects an empty text and an unknown kind", async () => {
  const { context } = fakeContext({ chatDir: await tempChat() });
  await assertRejects(() => m.append.execute({ text: "" }, context));
  await assertRejects(() =>
    m.append.execute({ text: "x", kind: "echo" }, context)
  );
});

Deno.test("compact: builds long leaves and their merge with the model", async () => {
  const dir = await tempChat();
  const fake = fakeClaude(() => filler(300, "s"));
  const { context, written } = fakeContext({ chatDir: dir }, fake.factory);
  await m.append.execute({ text: filler(600, "a") }, context);
  await m.append.execute({ text: filler(600, "b") }, context);
  await m.compact.execute({}, context);
  const run = written.find((w) => w.spec === "compaction")!.data;
  assertEquals(run.calls, 3); // two leaves, one merge
  assertEquals(run.failed, []);
  assertEquals(run.pending, 0);
  assert(fake.calls.every((c) => c.closed));
  assertEquals(fake.calls[0].opts.model, "haiku");
  assertEquals(fake.calls[0].opts.effort, "xhigh");
  assertEquals(fake.calls[0].opts.tools, []);
});

Deno.test("compact: maxCalls stops early and leaves the rest pending", async () => {
  const dir = await tempChat();
  const fake = fakeClaude(shortLines());
  const { context, written } = fakeContext(
    { chatDir: dir, concurrency: 1 },
    fake.factory,
  );
  for (let k = 0; k < 4; k++) {
    await m.append.execute({ text: filler(600) }, context);
  }
  await m.compact.execute({ maxCalls: 2 }, context);
  const run = written.find((w) => w.spec === "compaction")!.data;
  assertEquals(run.calls, 2);
  assert((run.pending as number) > 0);
});

Deno.test("compact: a failing model call is reported, not thrown", async () => {
  const dir = await tempChat();
  const fake = fakeClaude(() => {
    throw new Error("claude exited 1");
  });
  const { context, written } = fakeContext({ chatDir: dir }, fake.factory);
  await m.append.execute({ text: filler(600) }, context);
  await m.compact.execute({}, context);
  const run = written.find((w) => w.spec === "compaction")!.data;
  assertEquals(run.built, 0);
  assertEquals((run.failed as { node: string }[])[0].node, "0+1");
  assertEquals(run.pending, 1);
});

Deno.test("turn: summarizes first, logs the turn, compacts after", async () => {
  const dir = await tempChat();
  const fake = fakeClaude((prompt) => {
    if (prompt.includes("Compaction:")) return "line";
    return {
      events: [
        {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              name: "mcp__optchat__zoom",
              input: { id: 0, n: 1 },
            }],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "note: long" }],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "It is Bors." }] },
        },
      ],
      text: "It is Bors.",
    };
  });
  const { context, written } = fakeContext(
    { chatDir: dir, agentName: "Unii" },
    fake.factory,
  );
  await m.append.execute({ text: filler(600) }, context);
  await m.turn.execute({ message: "cat?" }, context);
  const turn = written.find((w) => w.spec === "turn")!.data;
  assertEquals(turn.reply, "It is Bors.");
  assertEquals(turn.messageIds, [1, 2, 3, 4]);
  assertEquals(turn.toolCalls, 1);
  assertEquals((turn.before as { calls: number }).calls, 1);
  assert(turn.after !== null);

  const turnCall = fake.calls.find((c) => c.opts.mcpConfig)!;
  assertEquals(turnCall.opts.model, "opus");
  assert(turnCall.opts.allowedTools!.includes("mcp__optchat__zoom"));
  // The view was rendered before the message was logged, and is all built.
  assertStringIncludes(turnCall.sent[0], "0+1|line\n</chat>");
  assert(!turnCall.sent[0].includes("not summarized yet"));
  assert(turnCall.sent[0].endsWith("\n\ncat?"));

  const store = await ChatStore.open(dir);
  assertEquals(
    store.messages.map((x) => x.kind),
    ["note", "user", "tool", "echo", "unii"],
  );
});

Deno.test("turn: a claude failure propagates, the user message stays logged", async () => {
  const dir = await tempChat();
  const fake = fakeClaude(() => {
    throw new Error("claude exited before replying");
  });
  const { context } = fakeContext({ chatDir: dir }, fake.factory);
  await assertRejects(
    () => m.turn.execute({ message: "hi", compactAfter: false }, context),
    Error,
    "claude exited",
  );
  const store = await ChatStore.open(dir);
  assertEquals(store.messages.map((x) => x.text), ["hi"]);
  // The lock was released.
  await (await ChatStore.open(dir, { lock: true })).close();
});

Deno.test("view: renders the chat in <chat> tags", async () => {
  const dir = await tempChat();
  const { context, written } = fakeContext({ chatDir: dir });
  await m.append.execute({ text: "a\nb" }, context);
  await m.view.execute({}, context);
  const v = written.find((w) => w.spec === "view")!.data;
  assertEquals(v.text, "<chat>\n0+1|note: a b\n</chat>");
  assertEquals(v.lines, 1);
});

Deno.test("zoom: a message whole, a line's halves, and bad targets", async () => {
  const dir = await tempChat();
  const { context, written } = fakeContext({ chatDir: dir });
  await m.append.execute({ text: "one" }, context);
  await m.append.execute({ text: "two" }, context);
  await m.zoom.execute({ id: 1, n: 1 }, context);
  assertEquals(written.at(-1)!.data.text, "note: two");
  await m.zoom.execute({ id: 0, n: 2 }, context);
  assertEquals(written.at(-1)!.data.text, "0+1|note: one\n1+1|note: two");
  await assertRejects(() => m.zoom.execute({ id: 0, n: 3 }, context));
  await assertRejects(() => m.zoom.execute({ id: 0, n: 4 }, context));
});

Deno.test("globals: chatDir is required and ~/ expands to HOME", async () => {
  const { context } = fakeContext({});
  await assertRejects(() => m.status.execute({}, context));
  const home = await tempChat();
  const prev = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    const { context: c2, written } = fakeContext({ chatDir: "~/chat" });
    await m.status.execute({}, c2);
    assertEquals(written[0].data.chatDir, `${home}/chat`);
  } finally {
    if (prev) Deno.env.set("HOME", prev);
  }
});
