/**
 * CONTRACT-FIXTURE suite for @magistr/herdr.
 *
 * Pins the herdr CLI wire format the model parses, using envelopes captured
 * from a live herdr 0.8.0 server (socket protocol 19) and stored under
 * `fixtures/`. Nothing here spawns a process or touches a socket — the
 * question this suite answers is "if these tests break, did herdr's output
 * contract change?".
 *
 * The three shapes herdr actually emits are all pinned:
 *   1. `{"id":…,"result":{…}}`  — socket-backed subcommands
 *   2. no output at all         — send-text / send-keys / run
 *   3. raw text                 — pane read / agent read / status
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  boundText,
  buildInvocation,
  checkEnvelope,
  HerdrError,
  herdrJson,
  herdrOk,
  herdrText,
  parseEnvelope,
  parseStatusBlocks,
  yesNo,
} from "./lib/cli.ts";
import {
  model,
  runAgentManifests,
  runSnapshot,
  runStatus,
  toAgent,
} from "./herdr.ts";
import {
  fakeContext,
  fixtureResult,
  fixtureStdout,
  onlyWrite,
  scriptedRunner,
  sshConfig,
  statusFixture,
  tableRunner,
  testConfig,
} from "./lib/test_support.ts";

const CFG = testConfig();

// --- Shape 1: the success envelope ------------------------------------------

Deno.test("contract: workspace_list carries workspaces[].workspace_id/label", async () => {
  const { run } = tableRunner({
    "workspace list": await fixtureStdout("workspace_list"),
  });
  const listed = await herdrJson(run, CFG, ["workspace", "list"]);

  assertEquals(listed.type, "workspace_list");
  const workspaces = listed.workspaces as Record<string, unknown>[];
  assertEquals(workspaces[0].workspace_id, "w1");
  assertEquals(workspaces[0].label, "project");
  assertEquals(workspaces[0].active_tab_id, "w1:t5");
  assertEquals(workspaces[0].agent_status, "working");
});

Deno.test("contract: parseEnvelope unwraps result and rejects a missing one", () => {
  const ok = parseEnvelope(["pane", "get", "w1:p5"], {
    code: 0,
    stdout: '{"id":"cli:pane:get","result":{"type":"pane_info","pane":{}}}',
    stderr: "",
  });
  assertEquals(ok.type, "pane_info");

  const err = assertThrowsHerdr(() =>
    parseEnvelope(["pane", "get", "w1:p5"], {
      code: 0,
      stdout: "",
      stderr: "",
    })
  );
  assertEquals(err.code, "unparsable_response");
});

Deno.test("contract: the error envelope becomes a coded HerdrError", async () => {
  const stdout = await fixtureStdout("error_workspace_not_found");
  const err = assertThrowsHerdr(() =>
    parseEnvelope(["workspace", "close", "w9"], { code: 1, stdout, stderr: "" })
  );
  assertEquals(err.code, "workspace_not_found");
  assertEquals(err.message, "workspace w9 not found");
  assertEquals(err.exitCode, 1);
});

Deno.test("contract: a usage error on stderr with exit 2 surfaces the usage line", () => {
  const err = assertThrowsHerdr(() =>
    parseEnvelope(["workspace", "list", "--json"], {
      code: 2,
      stdout: "",
      stderr: "unknown option: --json\n",
    })
  );
  assert(err.message.includes("unknown option: --json"), err.message);
  assertEquals(err.exitCode, 2);
});

// --- Shape 2: silent success -------------------------------------------------

Deno.test("contract: send-text succeeds with no output at all", async () => {
  const { run, calls } = scriptedRunner(() => ({ code: 0, stdout: "" }));
  const result = await herdrOk(run, CFG, [
    "pane",
    "send-text",
    "w1:p5",
    "hello",
  ]);
  assertEquals(result, null);
  assertEquals(calls[0].args, ["pane", "send-text", "w1:p5", "hello"]);
  assertEquals(checkEnvelope(["x"], { code: 0, stdout: "", stderr: "" }), null);
});

// --- Shape 3: raw text -------------------------------------------------------

Deno.test("contract: pane read returns raw terminal text, not an envelope", async () => {
  const screen = "\n~/project\n❯ echo hi\nhi\n";
  const { run } = scriptedRunner(() => screen);
  const text = await herdrText(run, CFG, ["pane", "read", "w1:p5"]);
  assertEquals(text, screen);
});

Deno.test("contract: `herdr status` block format parses into the fields the model reads", async () => {
  const blocks = parseStatusBlocks(await statusFixture());
  assertEquals(Object.keys(blocks).sort(), ["client", "server", "update"]);
  assertEquals(blocks.client.version, "0.8.0");
  assertEquals(blocks.client.channel, "stable");
  assertEquals(blocks.client.protocol, "19");
  assertEquals(blocks.server.status, "running");
  assertEquals(blocks.server.socket, "/home/dev/.config/herdr/herdr.sock");
  assertEquals(yesNo(blocks.server.compatible), true);
  assertEquals(yesNo(blocks.update.restart_needed), false);
});

// --- Mapping contracts -------------------------------------------------------

Deno.test("contract: AgentInfo maps onto the agent resource", async () => {
  const listed = await fixtureResult("agent_list");
  const agents = listed.agents as Record<string, unknown>[];
  const mapped = toAgent(agents[0], "2026-08-07T00:00:00.000Z");

  assertEquals(mapped.paneId, "w1:p5");
  assertEquals(mapped.tabId, "w1:t5");
  assertEquals(mapped.workspaceId, "w1");
  assertEquals(mapped.agent, "claude");
  assertEquals(mapped.status, "working");
  // agent_session.kind === "id" is what carries the agent's own session UUID.
  assertEquals(mapped.sessionId, "11111111-2222-3333-4444-555555555555");
  assertEquals(mapped.sessionPath, "");
  // The stripped title wins: the raw one carries a spinner glyph.
  assertEquals(mapped.terminalTitle, "Build the release");
  assertEquals(model.resources.agent.schema.safeParse(mapped).success, true);
});

Deno.test("contract: an agent with no session ref maps to empty ids, not undefined", async () => {
  const listed = await fixtureResult("agent_list");
  const agents = listed.agents as Record<string, unknown>[];
  const mapped = toAgent(agents[1], "2026-08-07T00:00:00.000Z");
  assertEquals(mapped.sessionId, "");
  assertEquals(mapped.sessionPath, "");
  assertEquals(mapped.name, "docs-bot");
  assertEquals(model.resources.agent.schema.safeParse(mapped).success, true);
});

Deno.test("contract: api snapshot maps onto the fleet resource", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "api snapshot": await fixtureStdout("api_snapshot"),
  });

  await runSnapshot(
    run,
    { workspace: "", status: [], writeAgents: true },
    ctx,
  );

  const fleet = onlyWrite(written, "fleet").data;
  assertEquals(fleet.version, "0.8.0");
  assertEquals(fleet.protocol, 19);
  assertEquals(fleet.focusedPaneId, "w1:p5");
  assertEquals(fleet.workspaceCount, 2);
  assertEquals(fleet.tabCount, 3);
  assertEquals(fleet.paneCount, 4);
  assertEquals(fleet.agentCount, 3);
  assertEquals(fleet.busyCount, 1);
  assertEquals(fleet.idleCount, 1);
  assertEquals(fleet.blockedCount, 1);
  assertEquals(fleet.byStatus, { working: 1, idle: 1, blocked: 1 });

  // The worktree a workspace is checked out at is part of the contract.
  const workspaces = fleet.workspaces as Record<string, unknown>[];
  assertEquals(workspaces[1].worktreePath, "/home/dev/project-parser");

  // One agent resource per agent, with the colon folded out of the instance.
  const agentWrites = written.filter((w) => w.spec === "agent");
  assertEquals(agentWrites.map((w) => w.instance), [
    "agent-w1-p5",
    "agent-w1-p6",
    "agent-w2-p1",
  ]);
});

Deno.test("contract: status maps client/server blocks and the session inventory", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "status": await statusFixture(),
    "session list --json": await fixtureStdout("session_list"),
    "config check": "config: ok\n",
  });

  await runStatus(run, {}, ctx);

  const status = onlyWrite(written, "status").data;
  assertEquals(status.clientVersion, "0.8.0");
  assertEquals(status.clientProtocol, 19);
  assertEquals(status.serverRunning, true);
  assertEquals(status.serverProtocol, 19);
  assertEquals(status.compatible, true);
  assertEquals(status.restartNeeded, false);
  assertEquals(status.socket, "/home/dev/.config/herdr/herdr.sock");
  assertEquals(status.notes, []);
  assertEquals(status.sessions, [{
    name: "default",
    running: true,
    isDefault: true,
    socketPath: "/home/dev/.config/herdr/herdr.sock",
    sessionDir: "/home/dev/.config/herdr",
  }]);
});

Deno.test("contract: output_matched nests the capture under `read`", async () => {
  const matched = await fixtureResult("output_matched");
  assertEquals(matched.type, "output_matched");
  const read = matched.read as Record<string, unknown>;
  assertEquals(read.pane_id, "w1:p5");
  assertEquals(read.source, "recent_unwrapped");
  assertEquals(read.truncated, false);
  assert(String(read.text).includes("herdr-probe-ok"));
});

Deno.test("contract: worktree_list distinguishes open from merely existing", async () => {
  const listed = await fixtureResult("worktree_list");
  const worktrees = listed.worktrees as Record<string, unknown>[];
  assertEquals(worktrees[0].open_workspace_id, "w1");
  // null (not absent) is how herdr says "on disk but not open in a workspace".
  assertEquals(worktrees[1].open_workspace_id, null);
  assertEquals(worktrees[1].branch, "feature/parser");
});

Deno.test("contract: notification_show reports suppression rather than failing", async () => {
  const shown = await fixtureResult("notification_shown");
  const disabled = await fixtureResult("notification_disabled");
  assertEquals(shown.shown, true);
  assertEquals(disabled.shown, false);
  assertEquals(disabled.reason, "disabled");
});

Deno.test("contract: captured text is bounded without splitting a code point", () => {
  const text = "héllo wörld";
  const bounded = boundText(text, 3);
  assertEquals(bounded.truncated, true);
  assertEquals(bounded.bytes, new TextEncoder().encode(text).length);
  // "hé" is 3 bytes; a 3-byte cut must not leave a lone continuation byte.
  assertEquals(bounded.text, "hé");
});

Deno.test("contract: a timed-out invocation is a timeout, not a parse failure", async () => {
  const { run } = scriptedRunner(() => ({
    code: 124,
    stdout: "",
    stderr: "",
    timedOut: true,
  }));
  const err = await assertRejects(
    () => herdrJson(run, CFG, ["agent", "wait", "w1:p5"]),
    HerdrError,
  );
  assertEquals(err.code, "timeout");
});

Deno.test("contract: agent_manifest_status maps onto the manifests resource", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "server agent-manifests --json": await fixtureStdout(
      "agent_manifest_status",
    ),
  });

  await runAgentManifests(run, {}, ctx);

  const manifests = onlyWrite(written, "manifests").data;
  assertEquals(manifests.lastResult, "checked");
  assertEquals(manifests.lastCheckUnix, 1786139000);
  assertEquals(manifests.total, 3);
  assertEquals(manifests.remoteCount, 2);
  assertEquals(manifests.bundledCount, 1);
  // A manifest herdr refused to use carries a `warning` and falls back to the
  // bundled copy — that is the field worth surfacing, so it is pinned here.
  assertEquals(manifests.warningCount, 1);

  const rows = manifests.manifests as Record<string, unknown>[];
  assertEquals(rows[0].agent, "claude");
  assertEquals(rows[0].activeVersion, "2026.08.04.1");
  assertEquals(rows[0].sourceKind, "remote");
  assertEquals(rows[2].sourceKind, "bundled");
  assert(String(rows[2].warning).includes("older than bundled"));
});

// --- The ssh transport contract ---------------------------------------------

Deno.test("contract: a local invocation runs herdr directly with env in the child", () => {
  const invocation = buildInvocation(
    testConfig({ session: "work" }),
    ["pane", "read", "w1:p5"],
  );
  assertEquals(invocation.cmd, "herdr");
  assertEquals(invocation.args, ["pane", "read", "w1:p5"]);
  assertEquals(invocation.env, { HERDR_SESSION: "work" });
});

Deno.test("contract: a remote invocation folds env and argv into one quoted command", () => {
  const invocation = buildInvocation(
    sshConfig({ user: "dev", port: 2222 }, { session: "work" }),
    ["pane", "send-text", "w1:p5", "hello world"],
  );

  assertEquals(invocation.cmd, "ssh");
  assertEquals(invocation.args, [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-p",
    "2222",
    "dev@build.example",
    // The local child environment means nothing on another machine, so
    // HERDR_SESSION rides along inside the remote command instead.
    "env 'HERDR_SESSION=work' 'herdr' 'pane' 'send-text' 'w1:p5' 'hello world'",
  ]);
  // Nothing is set in the ssh process's own environment.
  assertEquals(invocation.env, undefined);
});

function assertThrowsHerdr(fn: () => unknown): HerdrError {
  try {
    fn();
  } catch (err) {
    assert(err instanceof HerdrError, `expected HerdrError, got ${err}`);
    return err;
  }
  throw new Error("expected a HerdrError to be thrown");
}
