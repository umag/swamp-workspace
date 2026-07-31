/**
 * Contract-fixture suite for @magistr/jabber (jabber_history.ts) -- pins the
 * on-disk Psi/Psi+ history FORMAT itself: `parsePipeDelimited`,
 * `parsePlainText`, `listHistoryFiles` (chatType/format detection), and
 * `decodeJid`, all of which are module-private in jabber_history.ts. Every
 * assertion here is reached through the method seam (`list`/`read`/`search`)
 * against the SYNTHETIC on-disk tree at `fixtures/good/history/` (real
 * `Deno.readDir`/`Deno.readTextFile`, never a stubbed filesystem) --
 * jabber_history.ts is BYTE-FROZEN by this change, so every assertion below
 * was captured by actually running the frozen source against these fixtures.
 *
 * See fixtures/PROVENANCE.md for the fixture tree and per-file mapping.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./jabber_history.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GOOD_HISTORY_DIR = new URL("../../fixtures/good", import.meta.url)
  .pathname;

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(historyDir: string) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: { historyDir },
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {}, warn: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

// deno-lint-ignore no-explicit-any
function conv(payload: Record<string, unknown>, jid: string): any {
  return (payload.conversations as Array<Record<string, unknown>>).find(
    (c) => c.jid === jid,
  );
}

// ---------------------------------------------------------------------------
// listHistoryFiles: totals across the whole good/ tree (.backup excluded)
// ---------------------------------------------------------------------------

Deno.test("list: default chatType=all -- totals across fixtures/good/history match the fixture tree exactly (.backup + poison excluded)", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "all" }, ctx);
  const summary = written[0].payload;
  assertEquals(summary.totalConversations, 6);
  assertEquals(summary.totalDMs, 2);
  assertEquals(summary.totalConferences, 4);
  assertEquals(summary.totalMessages, 7);
});

Deno.test("list: chatType=dm filters to exactly alice + carol", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "dm" }, ctx);
  const summary = written[0].payload;
  assertEquals(summary.totalConversations, 2);
  const jids = (summary.conversations as Array<{ jid: string }>).map((c) =>
    c.jid
  ).sort();
  assertEquals(jids, ["alice@example.com", "carol@example.com"]);
});

Deno.test("list: chatType=conference filters to exactly room1/room2(pipe)/room2(plain)/room3", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "conference" }, ctx);
  const summary = written[0].payload;
  assertEquals(summary.totalConversations, 4);
});

// ---------------------------------------------------------------------------
// decodeJid + pipe-format DM: alice
// ---------------------------------------------------------------------------

Deno.test("list: decodeJid -- 'alice_at_example.com.history' decodes to jid 'alice@example.com', chatType dm (no 'conference.' substring)", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "all" }, ctx);
  const alice = conv(written[0].payload, "alice@example.com");
  assertEquals(alice.chatType, "dm");
  assertEquals(alice.messageCount, 2);
});

Deno.test("read: pipe-delimited timestamp normalization -- a bare timestamp gets 'Z' appended, an already-'Z' timestamp is left alone", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "alice", limit: 0 }, ctx);
  const res = written.find((w) => w.name === "alice_at_example_com")!;
  const messages = res.payload.messages as Array<
    {
      timestamp: string;
      direction: string;
      sender?: string;
      body: string;
      flags?: string;
    }
  >;
  assertEquals(messages.length, 2);
  assertEquals(messages[0], {
    timestamp: "2024-01-01T10:00:00Z",
    direction: "to",
    sender: undefined,
    body: "Hello Alice, are you around?",
    flags: "0",
  });
  assertEquals(messages[1], {
    timestamp: "2024-01-01T10:05:00Z",
    direction: "from",
    sender: undefined,
    body: "Yes, I am here!",
    flags: "0",
  });
  assertEquals(res.payload.firstMessage, "2024-01-01T10:00:00Z");
  assertEquals(res.payload.lastMessage, "2024-01-01T10:05:00Z");
});

// ---------------------------------------------------------------------------
// chatType detection: pipe-format conference via the 'conference.' substring
// heuristic in the ACTUAL baseName (not a fixture-authoring quirk -- see
// PROVENANCE.md: MUC service domains conventionally ARE 'conference.<host>')
// ---------------------------------------------------------------------------

Deno.test("list: room1 (pipe, no plain-text twin) is detected as chatType=conference via the 'conference.' substring in its filename", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "all" }, ctx);
  const room1 = conv(written[0].payload, "room1@conference.example.com");
  assertEquals(room1.chatType, "conference");
  assertEquals(room1.messageCount, 1);
});

// ---------------------------------------------------------------------------
// plain-text format parsing: room3 (no pipe twin)
// ---------------------------------------------------------------------------

Deno.test("read: plain-text conference format -- sender/body captured, direction hardcoded 'from', instance name carries '_via_<account>'", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "room3", limit: 0 }, ctx);
  assertEquals(written.length, 1);
  const res = written[0];
  assertEquals(
    res.name,
    "room3_at_conference_example_com_via_myaccount_at_example_com",
  );
  assertEquals(res.payload.account, "myaccount@example.com");
  const messages = res.payload.messages as Array<
    {
      timestamp: string;
      direction: string;
      sender: string;
      body: string;
      flags?: string;
    }
  >;
  assertEquals(messages, [{
    timestamp: "2024-04-05T18:30:00Z",
    direction: "from",
    sender: "Nick4",
    body: "Room three has no pipe twin at all.",
    flags: undefined,
  }]);
});

// ---------------------------------------------------------------------------
// read() does NOT dedupe pipe-vs-plain-text duplicates for the same
// conference (unlike importToObsidian, which explicitly prefers plain-text)
// ---------------------------------------------------------------------------

Deno.test("read: 'room2' matches BOTH the pipe file and the plain-text file (same jid) -- read has no dedup logic, both are written as separate resources", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("read", { jid: "room2", limit: 0 }, ctx);
  assertEquals(written.length, 2);
  const pipeRes = written.find((w) =>
    w.name === "room2_at_conference_example_com"
  );
  const plainRes = written.find((w) =>
    w.name === "room2_at_conference_example_com_via_myaccount_at_example_com"
  );
  assertEquals(pipeRes !== undefined, true, "pipe copy must be written");
  assertEquals(plainRes !== undefined, true, "plain-text copy must be written");
  assertEquals(pipeRes!.payload.account, undefined);
  assertEquals(plainRes!.payload.account, "myaccount@example.com");
});

// ---------------------------------------------------------------------------
// .backup skip: never surfaces in list/read/search
// ---------------------------------------------------------------------------

Deno.test(".backup skip: 'dave_at_example.com.history.backup' never appears in list output (chatType=all)", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "all" }, ctx);
  const dave = conv(written[0].payload, "dave@example.com");
  assertEquals(dave, undefined);
});

Deno.test(".backup skip: search never finds text that only exists in the .backup file's body", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("search", {
    query: "skip guard is broken",
    chatType: "all",
    limit: 100,
  }, ctx);
  assertEquals(written[0].payload.totalMessages, 0);
});

// ---------------------------------------------------------------------------
// Empty file: 0 messages, undefined first/lastMessage
// ---------------------------------------------------------------------------

Deno.test("list: an empty .history file parses to messageCount 0 with firstMessage/lastMessage undefined", async () => {
  const { ctx, written } = makeCtx(GOOD_HISTORY_DIR);
  await run("list", { chatType: "all" }, ctx);
  const carol = conv(written[0].payload, "carol@example.com");
  assertEquals(carol.messageCount, 0);
  assertEquals(carol.firstMessage, undefined);
  assertEquals(carol.lastMessage, undefined);
});
