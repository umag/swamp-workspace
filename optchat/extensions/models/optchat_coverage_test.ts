// Coverage suite: one test per guard the design depends on, so deleting the
// guard turns a test red. Most pin a "mistake to avoid" from the gist.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { compact } from "./lib/compactor.ts";
import { systemPrompt } from "./lib/prompts.ts";
import { ChatStore, clipText, splitText } from "./lib/store.ts";
import { fakeClaude, filler, shortLines, tempChat } from "./lib/testing.ts";
import { labelOf, PLACEHOLDER } from "./lib/tree.ts";

const small = { high: 400, low: 200, compactHigh: 300, compactLow: 150 };

function compactOpts(factory: ReturnType<typeof fakeClaude>["factory"]) {
  return {
    factory,
    model: "haiku",
    systemPrompt: systemPrompt("Unii"),
    concurrency: 8,
    timeoutMs: 1000,
  };
}

Deno.test("a node is built once and never again (mistake: rebuilding)", async () => {
  const s = await ChatStore.open(await tempChat(), { lock: true });
  await s.append("user", filler(600));
  await s.putNode([0, 0], "first");
  await s.putNode([0, 0], "second");
  assertEquals(s.nodeText(0, 0), "first");
  await s.close();
});

Deno.test("short messages and short pairs need no model call", async () => {
  const s = await ChatStore.open(await tempChat(), { lock: true });
  await s.append("user", "hi");
  await s.append("unii", "hello");
  assertEquals(s.nodeText(1, 0), "user: hi\nunii: hello");
  assertEquals(s.pending, 0);
  await s.close();
});

Deno.test("tool results are clipped head+tail; other long text is split", async () => {
  const s = await ChatStore.open(await tempChat(), { lock: true });
  const echo = await s.append("echo", "H" + filler(40_000) + "T");
  assertEquals(echo.length, 1);
  assert(echo[0].text.startsWith("H") && echo[0].text.endsWith("T"));
  assert(echo[0].text.includes("characters clipped"));
  const user = await s.append("user", filler(65_000));
  assertEquals(user.length, 3);
  assertEquals(user.map((m) => m.i), [1, 2, 3]);
  await s.close();
  assertEquals(splitText("abc", 2), ["ab", "c"]);
  assertEquals(clipText("abcdef", 4), "ab\n…[2 characters clipped]…\nef");
  assertEquals(clipText("abc", 4), "abc");
});

Deno.test("the view is saved and reloaded, not rebuilt (mistake 3)", async () => {
  const dir = await tempChat();
  const s = await ChatStore.open(dir, { lock: true, limits: small });
  for (let k = 0; k < 40; k++) await s.append("user", `m${k}`);
  const before = JSON.stringify(s.view);
  await s.close();
  const r = await ChatStore.open(dir, { limits: small });
  assertEquals(JSON.stringify(r.view), before);
});

Deno.test("a view trailing the log (crash) gets the missing lines appended", async () => {
  const dir = await tempChat();
  const s = await ChatStore.open(dir, { lock: true });
  await s.append("user", "a");
  const saved = await Deno.readTextFile(`${dir}/view.json`);
  await s.append("user", "b");
  await s.close();
  await Deno.writeTextFile(`${dir}/view.json`, saved);
  const r = await ChatStore.open(dir);
  assertEquals(r.view.chat, [[0, 0], [0, 1]]);
  assertEquals(r.view.T, 2);
});

Deno.test("merges wait for a batch: none until the view passes high (mistake 2)", async () => {
  const s = await ChatStore.open(await tempChat(), {
    lock: true,
    limits: small,
  });
  let lastLines = 0;
  let batches = 0;
  for (let k = 0; k < 200; k++) {
    const wasMerging = s.view.merging;
    await s.append("user", `message ${k}`);
    const lines = s.view.chat.length;
    if (lines <= lastLines) {
      batches++;
      // A batch reaches `low`, or stays marked to go on at the next message.
      assert(s.viewBytes() <= small.low || s.view.merging);
    } else if (!wasMerging) {
      assertEquals(lines, lastLines + 1, "between batches only appends");
    }
    lastLines = lines;
  }
  assert(batches > 0);
  await s.close();
});

Deno.test("a batch that can't reach low keeps merging at each message", async () => {
  const s = await ChatStore.open(await tempChat(), {
    lock: true,
    limits: small,
  });
  // Long messages: leaves stay unbuilt, so nothing can merge.
  for (let k = 0; k < 12; k++) await s.append("user", filler(600));
  assert(s.view.merging);
  assertEquals(s.view.chat.length, 12);
  await compact(s, compactOpts(fakeClaude(shortLines()).factory));
  await s.append("user", "next");
  assert(s.view.chat.length < 13, "merged once parents were built");
  await s.close();
});

Deno.test("compaction context stops at the first unbuilt line and at the node", async () => {
  const s = await ChatStore.open(await tempChat(), { lock: true });
  await s.append("user", "a");
  await s.append("user", filler(600));
  await s.append("user", "c");
  assertEquals(s.compactionContext([0, 1]), "<chat>\n0+1|user: a\n</chat>");
  // Message 2's context stops before unbuilt line 1+1.
  assertEquals(s.compactionContext([0, 2]), "<chat>\n0+1|user: a\n</chat>");
  assert(!s.compactionContext([0, 2]).includes(PLACEHOLDER));
  await s.close();
});

Deno.test("a leaf starts only once fewer than `window` lines before it are unbuilt", async () => {
  const s = await ChatStore.open(await tempChat(), { lock: true });
  for (let k = 0; k < 12; k++) await s.append("user", filler(600));
  const ready = s.readyJobs(8, new Set());
  assertEquals(
    ready.map(labelOf),
    [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${i}+1`),
  );
  await s.close();
});

Deno.test("compact runs at most `concurrency` calls at once", async () => {
  const s = await ChatStore.open(await tempChat(), { lock: true });
  for (let k = 0; k < 20; k++) await s.append("user", filler(600));
  let live = 0;
  let peak = 0;
  const fake = fakeClaude(async () => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 2));
    live--;
    return filler(300);
  });
  const r = await compact(s, { ...compactOpts(fake.factory), concurrency: 3 });
  assertEquals(peak, 3);
  assertEquals(r.pending, 0);
  assertEquals(r.failed, []);
  await s.close();
});

Deno.test("a turn's pre-compaction stops once every leaf is built", async () => {
  const s = await ChatStore.open(await tempChat(), { lock: true });
  for (let k = 0; k < 4; k++) await s.append("user", filler(600));
  const fake = fakeClaude(() => filler(300));
  await compact(s, { ...compactOpts(fake.factory), untilLeavesBuilt: true });
  assert(s.leavesBuilt);
  assert(s.pending > 0, "merges are left for later");
  await s.close();
});
